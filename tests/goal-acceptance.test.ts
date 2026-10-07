import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { acceptanceDraftSchema, applyGoalCommand, draftFiles, protectedCaseRefusals, type Goal } from '../src/model/goal.js';
import { registryRoles, roleSchema } from '../src/model/registry.js';
import { checkContract, parseCase, parseContract } from '../src/e2e/case.js';
import { goalCommands } from '../src/cli/goal.js';
import { acceptanceStep, clearDrafts, draftsSettled, acceptanceTool, type AcceptanceEffects } from '../src/daemon/acceptance.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';
import type { CliContext } from '../src/cli/context.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { acceptanceParameters, graphyardTools as piTools, schemaErrors } from '../integrations/pi/index.js';

// GY-1417: a goal becomes approved customer outcomes and required E2E cases before any code is
// written, by an acceptance role whose author never approves its own draft, and once merged those
// cases are protected from the implementation that has to pass them.
const root = fileURLToPath(new URL('..', import.meta.url));
const repository = 'owner/goals';
const operator: Principal = { id: 'goal-operator', role: 'admin', sessionKind: 'human' };
const master: Principal = { id: 'goal-master', role: 'coordinator', sessionKind: 'ai' };
const author: Principal = { id: 'acceptance-author', role: 'admin', sessionKind: 'ai' };
const approver: Principal = { id: 'goal-approver', role: 'admin', sessionKind: 'ai' };
const worker: Principal = { id: 'goal-worker', role: 'worker', sessionKind: 'ai' };
const reader: Principal = { id: 'goal-reader', role: 'reader', sessionKind: 'ai' };
const credentials = [operator, master, author, approver, worker, reader].map(principal => ({ ...principal, token: `goal-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const freePort = () => new Promise<number>((done, fail) => {
  const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); });
});
before(async () => {
  const port = await freePort();
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('goals'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('goal_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/goal_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials, null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { clearDrafts(); if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

const call = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as any };
};
const ok = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const answer = await call(principal, method, path, body);
  assert.equal(answer.status, 200, answer.text);
  return answer.body;
};
/** The `goal` command as the launcher runs it, talking to this server as `principal`. */
async function cli(principal: Principal, words: string[]) {
  const printed: unknown[] = [];
  const [id, ...args] = words;
  const context = { command: 'goal', id, args, rest: words, print: (value: unknown) => printed.push(value),
    api: async (path: string, data?: unknown) => { const answer = await call(principal, data === undefined ? 'GET' : 'POST', path, data); if (answer.status !== 200) throw new Error(answer.text); return answer.body; } } as unknown as CliContext;
  await goalCommands[0].run(context, undefined);
  return printed[0] as any;
}
const goalInput = (statement: string) => ({ statement, users: ['Operators running Graphyard for one repository'], constraints: ['No new third-party service'], deployTarget: 'uat then production' });
const signupCase = (id: string, required = true) => ({ id, title: `The ${id} outcome is reachable`, description: 'An operator reads the board.', tags: ['api'], target: 'uat', required,
  steps: [{ kind: 'http', name: 'read the board', method: 'GET', path: '/api/board', status: 200, expect: [{ path: 'groups.backlog', type: 'array' }] }] });
const draftOf = (goal: string, outcome: string, required = true) => ({ goal, outcomes: [{ id: outcome, title: `An operator sees ${outcome}`, criteria: [`The ${outcome} page answers`], case: signupCase(outcome, required) }] });

test('unit:goal-intake — `graphyard goal FILE` records a goal with history, and the open goals are listed with their stage', async () => {
  const directory = await temporaryDirectory('goal-file');
  const file = join(directory, 'goal.json');
  await writeFile(file, JSON.stringify(goalInput('Operators see what their goal needs before code is written')));
  const recorded: Goal = await cli(master, [file]);
  assert.match(recorded.key, /^GOAL-\d+$/);
  assert.equal(recorded.stage, 'acceptance-drafting');
  assert.equal(recorded.recordedBy, master.id);
  assert.deepEqual(recorded.users, ['Operators running Graphyard for one repository']);
  assert.equal(recorded.deployTarget, 'uat then production');
  // The operator records goals too; a reader or a worker does not, and a goal names its users.
  assert.equal((await call(operator, 'POST', 'goals', goalInput('A second goal'))).status, 200);
  assert.equal((await call(reader, 'POST', 'goals', goalInput('Not mine to set'))).status, 403);
  assert.equal((await call(worker, 'POST', 'goals', goalInput('Not mine to set'))).status, 403);
  assert.equal((await call(master, 'POST', 'goals', { statement: 'No users', users: [], deployTarget: 'uat' })).status, 400);
  // The history is the ledger: one event per change, carrying who made it.
  const shown = await cli(master, ['show', recorded.key]);
  assert.equal(shown.goal.id, recorded.id);
  assert.deepEqual(shown.history.map((entry: any) => [entry.kind, entry.actor, entry.stage]), [['goal.recorded', master.id, 'acceptance-drafting']]);
  // `master status` reads the open goals in summary: stage, statement and who acts next.
  const listed = await cli(master, ['list']);
  const summary = listed.find((entry: any) => entry.key === recorded.key);
  assert.equal(summary.stage, 'acceptance-drafting');
  assert.match(summary.next.who, /acceptance role/);
  assert.equal(listed.length, 2);
  const masterStatus = await readFile(join(root, 'src/cli/master-status.ts'), 'utf8');
  assert.match(masterStatus, /goals: await sections\.optional\('goals', 'GET \/api\/goals', async \(\) => \(await masterApi\('goals\?open=1&view=summary'\)\)\.goals/);
});

/** A runner answering with `respond`'s payload through the options' own validation, recording each prompt. */
function stubRunner(respond: (prompt: string) => unknown, prompts: string[], tools: string[]): Runner {
  return {
    name: 'stub',
    start<T>(prompt: string, options: RunOptions<T>) {
      prompts.push(prompt); tools.push(`${options.tool} ${options.env?.GRAPHYARD_PI_ROLE}`);
      const payload = respond(prompt);
      let result: RunResult<T>;
      try { const parsed = options.validate(payload); result = { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] }; }
      catch (error) { result = { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
      return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
    },
  };
}
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard', repository, baseBranch: 'main',
  githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-goals', autoMerge: true, mergeMethod: 'merge', workers: [] });

test('unit:acceptance-role-drafts-and-approval — the loop launches the acceptance role on an open goal, opens its draft as one pull request, and only an approver who did not author it approves', async () => {
  assert.ok((registryRoles as readonly string[]).includes('acceptance'));
  assert.equal(roleSchema.parse({ name: 'acceptance', accounts: [], concurrency: 1 }).name, 'acceptance');
  // On Pi, the role's one tool is its result, and a draft in the format the loop validates passes its schema.
  assert.deepEqual(piTools('acceptance').map(tool => tool.name), [acceptanceTool]);
  assert.deepEqual(schemaErrors(acceptanceParameters, draftOf('GOAL-9', 'pi-outcome')), []);
  const goal: Goal = await ok(master, 'POST', 'goals', goalInput('Operators can sign up a repository in one step'));
  const prompts: string[] = [], tools: string[] = [], opened: { goal: string; draft: unknown }[] = [];
  let respond: (prompt: string) => unknown = () => draftOf(goal.key, 'goal-signup');
  let prState: 'open' | 'merged' = 'open';
  const fx: AcceptanceEffects = {
    settings: diagnosticianSettings({}), cwd: root,
    goals: async () => (await ok(master, 'GET', 'goals?open=1')).goals.filter((entry: Goal) => entry.id === goal.id),
    runner: async attempt => ({ runner: stubRunner(prompt => respond(prompt), prompts, tools), runtime: 'stub', model: attempt }),
    open: async (target, draft) => { opened.push({ goal: target.key, draft }); return { pr: 700 + opened.length, branch: `graphyard/${target.key.toLowerCase()}-acceptance-${target.revision}` }; },
    // The draft is posted by the identity that runs the role: its author.
    draft: (target, input) => ok(author, 'POST', `goals/${target.key}/draft`, input),
    pullRequest: async () => ({ state: prState, mergeSha: prState === 'merged' ? 'c'.repeat(40) : null }),
    merged: (target, pr, mergeSha) => ok(master, 'POST', `goals/${target.key}/merged`, { pr, mergeSha }),
  };
  const state = emptyDaemonState(config);
  const cycle = () => ({ config, state, effects: { acceptance: fx, persist: async () => {} }, now: () => Date.now(), clock: Date.now(), performed: [], isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() }) as unknown as Cycle;
  const read = async () => (await ok(master, 'GET', `goals/${goal.key}`)).goal as Goal;

  // Drafting: the role runs headless on the goal, and the next cycle opens its draft.
  await acceptanceStep(cycle()); await draftsSettled();
  assert.equal(prompts.length, 1);
  assert.deepEqual(tools, [`${acceptanceTool} acceptance`]);
  assert.match(prompts[0], /Operators can sign up a repository in one step/);
  assert.match(prompts[0], /"sign-in"/, 'the role is told the outcomes the repository already declares');
  await acceptanceStep(cycle());
  let current = await read();
  assert.equal(current.stage, 'awaiting-approval');
  assert.equal(current.acceptance?.author, author.id);
  assert.equal(current.acceptance?.pr, 701);
  assert.deepEqual(current.acceptance?.outcomes.map(outcome => [outcome.id, outcome.case.id, outcome.case.required, outcome.case.target]), [['goal-signup', 'goal-signup', true, 'uat']]);
  // The pull request carries one case per outcome and the contract binding, which validate as the release check reads them.
  const files = draftFiles(acceptanceDraftSchema.parse(opened[0].draft), parseContract(await readFile(join(root, 'e2e/contract.json'), 'utf8')));
  assert.deepEqual(files.map(entry => entry.path), ['e2e/cases/goal-signup.json', 'e2e/contract.json']);
  const contract = parseContract(files[1].content);
  assert.deepEqual(contract.outcomes.at(-1), { id: 'goal-signup', title: 'An operator sees goal-signup', criteria: ['The goal-signup page answers'], cases: ['goal-signup'] });
  const added = { file: files[0].path, definition: parseCase(files[0].path, files[0].content) };
  assert.equal(checkContract({ outcomes: [contract.outcomes.at(-1)!] }, { cases: [added], invalid: [] }).passed, true);
  // A draft whose case is optional, or not on uat, is no acceptance draft.
  assert.throws(() => acceptanceDraftSchema.parse({ outcomes: draftOf(goal.key, 'loose', false).outcomes }), /must be required/);

  // The author never judges its own draft; another identity refuses it, and the role drafts again answering the refusal.
  const self = await call(author, 'POST', `goals/${goal.key}/approve`, { reason: 'Looks right to me' });
  assert.equal(self.status, 403); assert.match(self.text, /Self-approval refused/);
  assert.equal((await call(worker, 'POST', `goals/${goal.key}/approve`, { reason: 'ship it' })).status, 403);
  current = await ok(approver, 'POST', `goals/${goal.key}/refuse`, { reason: 'The case checks the board, not the sign-up the customer asked for' });
  assert.equal(current.stage, 'acceptance-drafting');
  respond = () => draftOf(goal.key, 'repository-signup');
  await acceptanceStep(cycle()); await draftsSettled(); await acceptanceStep(cycle());
  assert.match(prompts.at(-1)!, /not the sign-up the customer asked for/);
  current = await read();
  assert.equal(current.stage, 'awaiting-approval'); assert.equal(current.acceptance?.pr, 702);
  current = await ok(approver, 'POST', `goals/${goal.key}/approve`, { reason: 'Each outcome is what an operator would ask for, and each case checks it' });
  assert.equal(current.stage, 'planned'); assert.equal(current.approval?.by, approver.id);

  // The approved pull request is recorded merged once GitHub merged it, and its cases are protected from then on.
  await acceptanceStep(cycle());
  assert.equal((await read()).stage, 'planned');
  prState = 'merged';
  await acceptanceStep(cycle());
  const delivering = await read();
  assert.equal(delivering.stage, 'delivering');
  assert.deepEqual(delivering.protected, { cases: ['repository-signup'], outcomes: ['repository-signup'] });
  const kinds = (await ok(master, 'GET', `goals/${goal.key}`)).history.map((entry: any) => `${entry.kind}:${entry.actor}`);
  assert.deepEqual(kinds, ['goal.recorded:goal-master', 'goal.draft:acceptance-author', 'goal.refuse:goal-approver', 'goal.draft:acceptance-author', 'goal.approve:goal-approver', 'goal.merged:goal-master']);
  // A later goal cannot claim the cases this one protects.
  const other: Goal = await ok(master, 'POST', 'goals', goalInput('Another goal'));
  const taken = await call(author, 'POST', `goals/${other.key}/draft`, { ...draftOf(other.key, 'repository-signup'), goal: undefined, pr: 900, branch: 'graphyard/other' });
  assert.equal(taken.status, 422); assert.match(taken.text, new RegExp(`belongs to ${goal.key}`));
});

/** A claimed item with its workspace, and the observation of a candidate changing `files` on its branch. */
async function claimed(plannedFiles: string[]) {
  let work: Work = await engine.execute(operator, 'create', null, { title: `implements ${randomUUID().slice(0, 6)}`, plannedFiles, criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:behaves'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  const branch = `graphyard/${work.key.toLowerCase()}-1`;
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'goal-host', path: `/tmp/goal/${work.id}`, branch }, randomUUID());
  const pr = 9000 + Number(work.key.split('-')[1]);
  const observe = (scopeFiles: NonNullable<Observation['scopeFiles']>): Observation => ({ candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr, branch, author: worker.id },
    checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: scopeFiles.map(file => file.path), scopeFiles, at: new Date().toISOString() } as Observation);
  return { work, pr, observe };
}
const changed = (path: string, status: 'modified' | 'removed' | 'added' = 'modified') => ({ path, status, sha: status === 'removed' ? null : 'c'.repeat(40), additions: 1, deletions: 1, binary: false, baseSha: status === 'added' ? null : 'd'.repeat(40) });

test('unit:required-cases-protected — after the acceptance PR merges, a candidate that modifies or deletes a required case or binding is refused at complete, and only an independently approved case change lets it through', async () => {
  // A goal whose acceptance pull request merged: drafted by its author, approved by another identity.
  const recorded: Goal = await ok(master, 'POST', 'goals', goalInput('Operators can sign up a repository from the setup page'));
  await ok(author, 'POST', `goals/${recorded.key}/draft`, { outcomes: draftOf(recorded.key, 'setup-signup').outcomes, pr: 811, branch: 'graphyard/setup-signup' });
  await ok(approver, 'POST', `goals/${recorded.key}/approve`, { reason: 'The case checks the outcome the customer asked for' });
  const goal: Goal = await ok(master, 'POST', `goals/${recorded.key}/merged`, { pr: 811 });
  assert.deepEqual(goal.protected, { cases: ['setup-signup'], outcomes: ['setup-signup'] });
  const casePath = 'e2e/cases/setup-signup.json';
  const { work, pr, observe } = await claimed([casePath, 'e2e/contract.json', 'e2e/cases/new-case.json', 'src/feature.ts']);
  const submit = (files: ReturnType<typeof changed>[]) => engine.execute(worker, 'submit', work.id, { epoch: 1, pr }, randomUUID(), { observation: observe(files as never) }).then(() => null, (error: Error) => error.message);

  // Inside its planned files or not, a protected case is not the implementation's to change.
  const modified = await submit([changed('src/feature.ts'), changed(casePath)]);
  assert.match(String(modified), new RegExp(`Protected case: ${casePath} modifies required case setup-signup \\(outcome setup-signup of ${goal.key}\\)`));
  assert.match(String(await submit([changed(casePath, 'removed')])), /Protected case: .* deletes required case setup-signup/);
  assert.match(String(await submit([changed('e2e/contract.json')])), new RegExp(`Protected case: e2e/contract.json modifies the contract binding setup-signup of ${goal.key}`));
  // A new case, and a case no goal protects, are the implementation's own.
  assert.deepEqual(protectedCaseRefusals(work, observe([changed('e2e/cases/new-case.json', 'added'), changed('e2e/cases/board.json')] as never), [goal]), []);

  // The decision path: a case change, judged by neither its requester nor an implementer of the item.
  assert.equal((await call(worker, 'POST', `goals/${goal.key}/case-change`, { work: work.key, cases: ['board'], reason: 'not protected here' })).status, 422);
  const requested: Goal = await ok(author, 'POST', `goals/${goal.key}/case-change`, { work: work.key, cases: ['setup-signup'], reason: 'The sign-up form moved to /setup; the customer outcome is unchanged' });
  const change = requested.caseChanges.at(-1)!;
  assert.equal(change.state, 'requested');
  const own = await call(author, 'POST', `goals/${goal.key}/case-change-approve`, { change: change.id, reason: 'mine' });
  assert.equal(own.status, 403); assert.match(own.text, /requested case change/);
  assert.equal((await call(worker, 'POST', `goals/${goal.key}/case-change-approve`, { change: change.id, reason: 'I built it' })).status, 403);
  // Whoever implemented the item is refused whatever their role: the grounds are the item's implementers.
  assert.throws(() => applyGoalCommand(requested, 'case-change-approve', { change: change.id, reason: 'I built it' }, { actor: approver, at: new Date().toISOString(), implementers: [approver.id] }), new RegExp(`implemented ${work.key}`));
  const approved: Goal = await ok(approver, 'POST', `goals/${goal.key}/case-change-approve`, { change: change.id, reason: 'The outcome is the same; only the path moved' });
  assert.equal(approved.caseChanges.at(-1)?.state, 'approved'); assert.equal(approved.caseChanges.at(-1)?.judgedBy, approver.id);
  assert.equal((await call(approver, 'POST', `goals/${goal.key}/case-change-approve`, { change: change.id, reason: 'again' })).status, 409);
  // With the approved change, the same candidate is accepted.
  assert.deepEqual(protectedCaseRefusals(work, observe([changed(casePath), changed('e2e/contract.json')] as never), [approved]), []);
  assert.equal(await submit([changed('src/feature.ts'), changed(casePath)]), null);
  // Recorded delivered, the goal leaves the open list, and its cases stay protected.
  const delivered: Goal = await ok(master, 'POST', `goals/${goal.key}/deliver`, { reason: 'Every implementation item delivered' });
  assert.equal(delivered.stage, 'delivered');
  assert.ok(!(await ok(master, 'GET', 'goals?open=1')).goals.some((entry: Goal) => entry.id === goal.id));
  assert.equal(protectedCaseRefusals({ key: 'GY-999' }, observe([changed(casePath)] as never), [delivered]).length, 1);
});
