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
import { acceptanceDraftSchema, draftFiles, maxDraftRounds, protectedCaseRefusals, type Goal } from '../src/model/goal.js';
import { registryRoles, roleSchema } from '../src/model/registry.js';
import { checkContract, movedBindings, parseCase, parseContract } from '../src/e2e/case.js';
import { goalCommands } from '../src/cli/goal.js';
import { acceptanceEffects, acceptanceStep, clearDrafts, draftsSettled, acceptanceTool, acceptanceJudgementTool, UnopenableDraft, type AcceptanceEffects } from '../src/daemon/acceptance.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';
import type { CliContext } from '../src/cli/context.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { acceptanceJudgementParameters, acceptanceParameters, graphyardTools as piTools, schemaErrors } from '../integrations/pi/index.js';
// Time-bomb allowance (GY-1694): the 2026-10-07 daemon clock lies behind every approval the server stamps, so the day-after-approval verdict needs the explicit Date.now() + 25h; new Date() otherwise stamps observations and commands.

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
  engine = new Engine(store, 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials, null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { clearDrafts(); if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

const call = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
  // A retried record after a lost response answers the first goal, never a second; the same key with other input is refused.
  const key = randomUUID();
  const first = await call(master, 'POST', 'goals', goalInput('Recorded once however often it is retried'), key);
  const retried = await call(master, 'POST', 'goals', goalInput('Recorded once however often it is retried'), key);
  assert.equal(first.status, 200, first.text); assert.deepEqual(retried.body, first.body);
  assert.equal((await call(master, 'POST', 'goals', goalInput('Other input under the same key'), key)).status, 409);
  assert.equal((await call(master, 'POST', 'goals', goalInput('No key'), '')).status, 400);
  // The history is the ledger: one event per change, carrying who made it.
  const shown = await cli(master, ['show', recorded.key]);
  assert.equal(shown.goal.id, recorded.id);
  assert.deepEqual(shown.history.map((entry: any) => [entry.kind, entry.actor, entry.stage]), [['goal.recorded', master.id, 'acceptance-drafting']]);
  // `master status` reads the open goals in summary: stage, statement and who acts next.
  const listed = await cli(master, ['list']);
  const summary = listed.find((entry: any) => entry.key === recorded.key);
  assert.equal(summary.stage, 'acceptance-drafting');
  assert.match(summary.next.who, /acceptance role/);
  assert.equal(listed.length, 3);
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

/** The acceptance pull requests the PR-era draft step opens: each one's state and head. */
function fakePulls() {
  const pulls = new Map<number, { state: 'open' | 'closed'; merged: boolean; head: string; branch: string; mergeable: boolean | null; ciPassed: boolean; mergeSha: string | null }>();
  return { pulls };
}

test('unit:acceptance-role-drafts-and-approval — the loop launches the acceptance role on an open goal, opens its draft as one pull request, and a worker cannot approve it', async () => {
  clearDrafts();
  assert.ok((registryRoles as readonly string[]).includes('acceptance'));
  assert.equal(roleSchema.parse({ name: 'acceptance', accounts: [], concurrency: 1 }).name, 'acceptance');
  // On Pi, each role's one tool is its result, and a draft in the format the loop validates passes its schema.
  assert.deepEqual(piTools('acceptance').map(tool => tool.name), [acceptanceTool]);
  assert.deepEqual(piTools('acceptance-judge').map(tool => tool.name), [acceptanceJudgementTool]);
  assert.deepEqual(schemaErrors(acceptanceParameters, draftOf('GOAL-9', 'pi-outcome')), []);
  assert.deepEqual(schemaErrors(acceptanceJudgementParameters, { goal: 'GOAL-9', verdict: 'refuse', reason: 'The case checks the wrong page' }), []);
  const goal: Goal = await ok(master, 'POST', 'goals', goalInput('Operators can sign up a repository in one step'));
  const prompts: string[] = [], tools: string[] = [], opened: { goal: string; draft: unknown }[] = [], closes: number[] = [], lands: string[] = [];
  let respond: (prompt: string) => unknown = () => draftOf(goal.key, 'goal-signup');
  let verdict: { verdict: 'approve' | 'refuse'; reason: string } = { verdict: 'refuse', reason: 'The case checks the board, not the sign-up the customer asked for' };
  const fake = fakePulls();
  const focus = new Set([goal.id]);
  let failOpen = 1, failPost = 1, reads = 0;
  const fx: AcceptanceEffects = {
    settings: diagnosticianSettings({}), cwd: root,
    goals: async () => (await ok(master, 'GET', 'goals?open=1')).goals.filter((entry: Goal) => focus.has(entry.id)),
    runner: async (role, attempt, target) => ({ runner: stubRunner(prompt => role === 'judge' ? { goal: target.key, ...verdict } : respond(prompt), prompts, tools), runtime: 'stub', model: attempt }),
    open: async (target, draft) => {
      if (failOpen-- > 0) throw new Error('gh pr create: HTTP 502');
      opened.push({ goal: target.key, draft });
      const pr = 700 + opened.length, branch = `graphyard/${target.key.toLowerCase()}-acceptance-${target.revision}`, head = String(opened.length).repeat(40);
      fake.pulls.set(pr, { state: 'open', merged: false, head, branch, mergeable: true, ciPassed: false, mergeSha: null });
      return { pr, branch, head };
    },
    // The draft is posted by the identity that runs the role, its author; the verdict by the approver identity.
    draft: async (target, input) => { if (failPost-- > 0) throw new Error('Graphyard refused goals (502)'); return ok(author, 'POST', `goals/${target.key}/draft`, input); },
    judge: (target, judgement) => ok(approver, 'POST', `goals/${target.key}/${judgement.verdict}`, { reason: judgement.reason }),
    pullRequest: async pr => { reads++; const pull = fake.pulls.get(pr)!; return { state: pull.merged ? 'merged' : pull.state, mergeSha: pull.mergeSha, head: pull.head }; },
    // The control plane's land route, run here against the fake GitHub.
    land: target => { lands.push(`${target.acceptance!.pr}@${target.approval!.head}`); return ok(master, 'POST', `goals/${target.key}/land`, {}); },
    close: async pr => { closes.push(pr); fake.pulls.get(pr)!.state = 'closed'; },
    closed: (target, pr, reason) => ok(master, 'POST', `goals/${target.key}/closed`, { pr, reason }),
  };
  const state = emptyDaemonState(config);
  let clock = Date.parse('2026-10-07T00:00:00Z');
  const cycle = async (advance = 6 * 60_000) => {
    clock += advance;
    await acceptanceStep({ config, state, effects: { acceptance: fx, persist: async () => {} }, now: () => clock, clock, performed: [], isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() } as unknown as Cycle);
    await draftsSettled();
  };
  const read = async (key = goal.key) => (await ok(master, 'GET', `goals/${key}`)).goal as Goal;

  // Drafting: the role runs headless on the goal once; a failed open and a failed post are retried with that same draft, never another run.
  await cycle();
  assert.equal(prompts.length, 1);
  assert.deepEqual(tools, [`${acceptanceTool} acceptance`]);
  assert.match(prompts[0], /Operators can sign up a repository in one step/);
  assert.match(prompts[0], /"sign-in"/, 'the role is told the outcomes the repository already declares');
  await cycle(); assert.equal(opened.length, 0, 'the open failed');
  await cycle(60_000); assert.equal(opened.length, 0, 'a failed open waits its interval');
  await cycle(10 * 60_000); assert.equal(opened.length, 1, 'the same draft is opened again'); assert.equal((await read()).stage, 'acceptance-drafting', 'its post failed');
  await cycle(10 * 60_000);
  assert.equal(opened.length, 1, 'the post reuses the pull request it opened');
  assert.equal(prompts.length, 1, 'no failure ran the role again');
  let current = await read();
  assert.equal(current.stage, 'awaiting-approval');
  assert.equal(current.acceptance?.author, author.id);
  assert.equal(current.acceptance?.pr, 701); assert.equal(current.acceptance?.head, '1'.repeat(40));
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

  // A worker never judges a draft.
  assert.equal((await call(worker, 'POST', `goals/${goal.key}/approve`, { reason: 'ship it' })).status, 403);
  // The loop launches the approver's judgement, which refuses; its pull request is closed and the role drafts again answering the refusal.
  await cycle();
  assert.deepEqual(tools.at(-1), `${acceptanceJudgementTool} acceptance-judge`);
  assert.match(prompts.at(-1)!, /You did not write it/);
  await cycle();
  current = await read();
  assert.equal(current.stage, 'acceptance-drafting'); assert.equal(current.refusal?.by, approver.id); assert.equal(current.refusal?.pr, 701);
  respond = () => draftOf(goal.key, 'repository-signup');
  verdict = { verdict: 'approve', reason: 'Each outcome is what an operator would ask for, and each case checks it' };
  await cycle();
  assert.deepEqual(closes, [701], 'the refused pull request is closed before the next draft');
  assert.match(prompts.at(-1)!, /not the sign-up the customer asked for/);
  await cycle();
  current = await read();
  assert.equal(current.stage, 'awaiting-approval'); assert.equal(current.acceptance?.pr, 702); assert.equal(current.drafts, 2);
  await cycle(); await cycle();
  current = await read();
  assert.equal(current.stage, 'accepted'); assert.equal(current.approval?.by, approver.id); assert.equal(current.approval?.head, '2'.repeat(40));

  // GY-2010: Graphyard no longer lands an acceptance pull request; the merge writer lands acceptance changes
  // (tests/ssh-origin-delivery.test.ts), so an approved pull request is refused at the land route, naming why.
  const refusedLanding = await call(master, 'POST', `goals/${goal.key}/land`, {});
  assert.equal(refusedLanding.status, 422); assert.match(refusedLanding.text, /no longer lands pull requests/);
  assert.equal((await read()).stage, 'accepted');

  // An approved pull request closed unmerged is not left accepted: the goal goes back to drafting with the reason, and the loop stops after its draft rounds.
  const third: Goal = await ok(master, 'POST', 'goals', goalInput('A third goal'));
  for (let round = 1; round <= maxDraftRounds; round++) {
    await ok(author, 'POST', `goals/${third.key}/draft`, { outcomes: draftOf(third.key, `third-${round}`).outcomes, pr: 950 + round, branch: `graphyard/third-${round}`, head: 'f'.repeat(40) });
    await ok(approver, 'POST', `goals/${third.key}/approve`, { reason: 'Right' });
    const closed: Goal = await ok(master, 'POST', `goals/${third.key}/closed`, { pr: 950 + round, reason: 'closed without merging' });
    assert.equal(closed.stage, 'acceptance-drafting'); assert.equal(closed.refusal?.reason, 'closed without merging'); assert.equal(closed.approval, null);
  }
  const held = (await ok(master, 'GET', 'goals?open=1&view=summary')).goals.find((entry: any) => entry.key === third.key);
  assert.match(held.next.who, new RegExp(`${maxDraftRounds} acceptance drafts were refused or closed`));

  // A registry role at its concurrency defers the goal: no fallback run starts, so the operator's limit holds; it is launched again after the poll interval.
  const fifth: Goal = await ok(master, 'POST', 'goals', goalInput('A fifth goal drafted while the role is full'));
  focus.clear(); focus.add(fifth.id);
  respond = () => draftOf(fifth.key, 'fifth-outcome');
  const runner = fx.runner, attempts: string[] = [], ran = () => prompts.length;
  let full = true;
  fx.runner = async (role, attempt, target) => { attempts.push(attempt); if (full) throw Object.assign(new Error('every acceptance account is in use'), { roleAtCapacity: 'acceptance' }); return runner(role, attempt, target); };
  const before = ran();
  await cycle(); await cycle(60_000);
  assert.equal(ran(), before, 'no run started'); assert.deepEqual(attempts, ['primary'], 'no fallback was tried');
  assert.equal(state.actions[`acceptance:${fifth.id}`].state, 'waiting'); assert.match(state.actions[`acceptance:${fifth.id}`].detail, /registry capacity.*starts no fallback/);
  await cycle(60_000); assert.deepEqual(attempts, ['primary'], 'deferred for the poll interval');
  full = false;
  await cycle(5 * 60_000); assert.equal(ran(), before + 1);
  // A draft the base can never take (its case already exists) is dropped and drafted again within the hourly retry, never reopened forever.
  const open = fx.open;
  let unopenable = 1;
  fx.open = async (target, draft) => { if (unopenable-- > 0) throw new UnopenableDraft('e2e/cases/fifth-outcome.json already exists on main; the draft must name a new case'); return open(target, draft); };
  await cycle();
  assert.equal(state.actions[`acceptance:${fifth.id}`].state, 'failed'); assert.match(state.actions[`acceptance:${fifth.id}`].detail, /can never be opened.*dropped and drafted again in an hour/);
  await cycle(); assert.equal(ran(), before + 1, 'the dropped draft is not reopened, and the role waits its hour');
  await cycle(60 * 60_000); assert.equal(ran(), before + 2);
  await cycle(); assert.equal((await read(fifth.key)).stage, 'awaiting-approval');
  // A refused draft whose pull request could not be closed holds the next draft until the close succeeds.
  verdict = { verdict: 'refuse', reason: 'The case checks the wrong page' };
  await cycle(); await cycle();
  const refusedPr = (await read(fifth.key)).refusal!.pr!;
  const close = fx.close;
  let closeFails = 1;
  fx.close = async (pr, comment) => { if (closeFails-- > 0) throw new Error('gh pr close: HTTP 502'); return close(pr, comment); };
  await cycle();
  assert.match(state.actions[`acceptance:${fifth.id}`].detail, new RegExp(`Could not close ${fifth.key}'s refused acceptance pull request #${refusedPr}.*the next draft waits for it`));
  await cycle(); assert.equal(ran(), before + 3, 'no draft while the refused pull request is open');
  await cycle(10 * 60_000);
  assert.ok(closes.includes(refusedPr)); assert.equal(ran(), before + 4, 'drafted once the refused pull request closed');

  // The acceptance role has its own enablement: the diagnostician switched off holds no goal.
  const off = masterConfigSchema.parse({ ...config, run: { diagnostician: { enabled: false } } });
  assert.equal(acceptanceEffects(off, root, {} as never).settings.enabled, true);
  assert.match(await readFile(join(root, 'src/daemon/effects-production.ts'), 'utf8'), /get acceptance\(\) \{ const config = current\(\); return config\.operatorAgent \? acceptanceEffects\(/);
});

/** A claimed item with its workspace, and the observation of a candidate changing `files` on its branch. */
async function claimed(plannedFiles: string[]) {
  let work: Work = await engine.execute(operator, 'create', null, { title: `implements ${randomUUID().slice(0, 6)}`, criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:behaves'] }] }, randomUUID());
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

test('unit:required-cases-protected — after the acceptance change merges, a candidate that modifies or deletes a required case or binding is refused at complete, and only an approved case change lets it through', async () => {
  // GY-2010: an acceptance change is the merge writer's: the land route records it merged only once
  // the base's first-parent history holds a merge of exactly the approved head. Its git, as read here.
  const merges = new Map<string, string>([['c'.repeat(40), 'a'.repeat(40)], ['f'.repeat(40), 'e'.repeat(40)]]);
  engine.gitRunner = (async (args: string[]) => {
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') { const merged = merges.get(args.at(-1)!.replace(/\^2$/, '')); return merged ? { status: 0, stdout: `${merged}\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'unknown revision' }; }
    if (args[0] === 'rev-list') return { status: 0, stdout: [...merges.keys()].join('\n'), stderr: '' };
    throw new Error(`unexpected git ${args.join(' ')}`);
  }) as never;
  engine.baseBranch = 'main';
  // A goal whose acceptance change merged: drafted by its author, approved by another identity.
  const recorded: Goal = await ok(master, 'POST', 'goals', goalInput('Operators can sign up a repository from the setup page'));
  await ok(author, 'POST', `goals/${recorded.key}/draft`, { outcomes: draftOf(recorded.key, 'setup-signup').outcomes, pr: null, branch: 'graphyard/setup-signup', head: 'a'.repeat(40) });
  await ok(approver, 'POST', `goals/${recorded.key}/approve`, { reason: 'The case checks the outcome the customer asked for' });
  // Merged is never a client's say-so: there is no route that records it, only the land route reading the base.
  assert.equal((await call(master, 'POST', `goals/${recorded.key}/merged`, { pr: 811 })).status, 404);
  assert.equal((await ok(master, 'GET', `goals/${recorded.key}`)).goal.stage, 'accepted');
  const landed = await ok(master, 'POST', `goals/${recorded.key}/land`, { mergeSha: 'c'.repeat(40) });
  assert.equal(landed.landing.state, 'merged');
  const goal: Goal = landed.goal;
  assert.deepEqual(goal.protected, { cases: ['setup-signup'], outcomes: ['setup-signup'] });
  // A merge of a head no approver judged protects nothing: the land route refuses it and records nothing.
  const bypassed: Goal = await ok(master, 'POST', 'goals', goalInput('Operators can audit a repository from the setup page'));
  await ok(author, 'POST', `goals/${bypassed.key}/draft`, { outcomes: draftOf(bypassed.key, 'setup-audit').outcomes, pr: null, branch: 'graphyard/setup-audit', head: 'b'.repeat(40) });
  await ok(approver, 'POST', `goals/${bypassed.key}/approve`, { reason: 'Right' });
  const unapproved = await call(master, 'POST', `goals/${bypassed.key}/land`, { mergeSha: 'f'.repeat(40) });
  assert.equal(unapproved.status, 422); assert.match(unapproved.text, /is not a merge of the approved head bbbbbbbbbbbb/);
  assert.deepEqual((await ok(master, 'GET', `goals/${bypassed.key}`)).goal.protected, { cases: [], outcomes: [] });
  const casePath = 'e2e/cases/setup-signup.json';
  const { work, pr, observe } = await claimed([casePath, 'e2e/contract.json', 'e2e/cases/new-case.json', 'src/feature.ts']);
  const submit = (files: ReturnType<typeof changed>[]) => engine.execute(worker, 'submit', work.id, { epoch: 1, pr }, randomUUID(), { observation: observe(files as never) }).then(() => null, (error: Error) => error.message);

  // Inside its planned files or not, a protected case is not the implementation's to change.
  const modified = await submit([changed('src/feature.ts'), changed(casePath)]);
  assert.match(String(modified), new RegExp(`Protected case: ${casePath} modifies required case setup-signup \\(outcome setup-signup of ${goal.key}\\)`));
  assert.match(String(await submit([changed(casePath, 'removed')])), /Protected case: .* deletes required case setup-signup/);
  assert.match(String(await submit([changed('e2e/contract.json')])), new RegExp(`Protected case: e2e/contract.json modifies the contract binding setup-signup of ${goal.key}`));
  // Renaming the contract away deletes every binding it holds.
  const renamed = { ...changed('e2e/release-contract.json'), status: 'renamed', previousPath: 'e2e/contract.json' };
  assert.match(protectedCaseRefusals(work, observe([renamed] as never), [goal]).join('; '), new RegExp(`e2e/contract.json deletes the contract binding setup-signup of ${goal.key}`));
  // A new case, and a case no goal protects, are the implementation's own.
  assert.deepEqual(protectedCaseRefusals(work, observe([changed('e2e/cases/new-case.json', 'added'), changed('e2e/cases/board.json')] as never), [goal]), []);

  // The decision path: a requested case change, judged by an approver.
  assert.equal((await call(worker, 'POST', `goals/${goal.key}/case-change`, { work: work.key, cases: ['board'], reason: 'not protected here' })).status, 422);
  // A change for an item that does not exist yet is refused: whoever approved it could later implement that item.
  const future = await call(author, 'POST', `goals/${goal.key}/case-change`, { work: 'GY-999999', cases: ['setup-signup'], reason: 'for an item not yet created' });
  assert.equal(future.status, 404); assert.match(future.text, /GY-999999 is no work item/);
  // A retried request after a lost response records one case change, not two.
  const changeKey = randomUUID(), changeInput = { work: work.key, cases: ['setup-signup'], reason: 'The sign-up form moved to /setup; the customer outcome is unchanged' };
  const requested: Goal = (await call(author, 'POST', `goals/${goal.key}/case-change`, changeInput, changeKey)).body;
  assert.deepEqual((await call(author, 'POST', `goals/${goal.key}/case-change`, changeInput, changeKey)).body, requested);
  assert.equal(requested.caseChanges.length, 1);
  const change = requested.caseChanges.at(-1)!;
  assert.equal(change.state, 'requested');
  assert.equal((await call(worker, 'POST', `goals/${goal.key}/case-change-approve`, { change: change.id, reason: 'I built it' })).status, 403);
  const approved: Goal = await ok(approver, 'POST', `goals/${goal.key}/case-change-approve`, { change: change.id, reason: 'The outcome is the same; only the path moved' });
  assert.equal(approved.caseChanges.at(-1)?.state, 'approved'); assert.equal(approved.caseChanges.at(-1)?.judgedBy, approver.id);
  assert.equal((await call(approver, 'POST', `goals/${goal.key}/case-change-approve`, { change: change.id, reason: 'again' })).status, 409);
  // A grant for one case is no grant over the contract while the goal protects a binding nobody judged.
  const wider: Goal = { ...approved, protected: { cases: ['setup-signup', 'setup-audit'], outcomes: ['setup-signup', 'setup-audit'] } };
  assert.match(protectedCaseRefusals(work, observe([changed('e2e/contract.json')] as never), [wider]).join('; '), /no approved case change covers setup-audit/);
  assert.deepEqual(protectedCaseRefusals(work, observe([changed(casePath)] as never), [wider]), [], 'the granted case itself passes');
  // A grant is void once its approver has implemented the item — assigned it, holding its lease, or its last assignee.
  for (const held of [{ implementers: [approver.id] }, { lease: { owner: approver.id } }, { lastAssignment: { owner: approver.id } }])
    assert.match(protectedCaseRefusals({ ...work, ...held } as Work, observe([changed(casePath)] as never), [approved]).join('; '), /modifies required case setup-signup/);
  // With the approved change, the same candidate is accepted.
  assert.deepEqual(protectedCaseRefusals(work, observe([changed(casePath), changed('e2e/contract.json')] as never), [approved]), []);
  assert.equal(await submit([changed('src/feature.ts'), changed(casePath)]), null);
  // A head pushed after complete is judged again on its observation: changing a protected case holds a violation, which no merge passes, until a later head drops it.
  const later = await claimed(['src/other.ts']);
  let pushed: Work = await engine.execute(worker, 'submit', later.work.id, { epoch: 1, pr: later.pr }, randomUUID(), { observation: later.observe([changed('src/other.ts')] as never) });
  pushed = await engine.observe(pushed.id, pushed.revision, later.observe([changed('src/other.ts'), changed(casePath)] as never));
  assert.match(pushed.violations.join('; '), new RegExp(`Protected case: ${casePath} modifies required case setup-signup`));
  pushed = await engine.observe(pushed.id, pushed.revision, later.observe([changed('src/other.ts')] as never));
  assert.deepEqual(pushed.violations, [], 'a later head that leaves the case alone clears it');
  // Delivered only through its approved plan (GY-1418, tests/goal-planner.test.ts): a goal still being planned is not delivered by naming an item.
  assert.equal((await call(master, 'POST', `goals/${goal.key}/deliver`, { reason: 'Said so' })).status, 400);
  const early = await call(master, 'POST', `goals/${goal.key}/deliver`, { items: [work.key], reason: 'Every implementation item delivered' });
  assert.equal(early.status, 409); assert.match(early.text, new RegExp(`${goal.key} is planning; only a goal being delivered is recorded delivered`));
});

// GY-2602: the operator's answered goals-and-priorities request retires the protected outcomes it names.
async function amendedGoal(name: string) {
  const merges = new Map<string, string>([['9'.repeat(40), '8'.repeat(40)]]);
  engine.gitRunner = (async (args: string[]) => {
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') { const merged = merges.get(args.at(-1)!.replace(/\^2$/, '')); return merged ? { status: 0, stdout: `${merged}\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'unknown revision' }; }
    if (args[0] === 'rev-list') return { status: 0, stdout: [...merges.keys()].join('\n'), stderr: '' };
    throw new Error(`unexpected git ${args.join(' ')}`);
  }) as never;
  engine.baseBranch = 'main';
  const recorded: Goal = await ok(master, 'POST', 'goals', goalInput(`Operators can ${name} a release candidate`));
  const outcomes = [...draftOf(recorded.key, name).outcomes, ...draftOf(recorded.key, `${name}-audit`).outcomes];
  await ok(author, 'POST', `goals/${recorded.key}/draft`, { outcomes, pr: null, branch: `graphyard/${name}`, head: '8'.repeat(40) });
  await ok(approver, 'POST', `goals/${recorded.key}/approve`, { reason: 'Both cases check what the customer asked for' });
  const goal: Goal = (await ok(master, 'POST', `goals/${recorded.key}/land`, { mergeSha: '9'.repeat(40) })).goal;
  assert.deepEqual(goal.protected, { cases: [name, `${name}-audit`], outcomes: [name, `${name}-audit`] });
  return goal;
}
/** An item parked on a goals-and-priorities request asking NEEDED, and the request. */
async function parkedOn(needed: string) {
  const { work, observe } = await claimed(['e2e/', 'src/']);
  await ok(worker, 'POST', `work/${work.key}/park`, { epoch: work.epoch, kind: 'goals-and-priorities', needed, reason: 'Deleting the cases is a goal change',
    ask: 'Choose whether to retire the outcome.', recommendation: 'Go ahead as asked', why: 'The release candidate pipeline is being removed.' });
  const parked = (await store.list()).find(item => item.id === work.id)!;
  return { work: parked, observe, request: parked.humanRequest! };
}

test('integration:goal-amend-applies-approved-retirement — `graphyard goal amend GOAL-N --apply-decision ID` removes exactly the outcomes and cases the operator\'s approved decision names, records the decision on the goal\'s history, and refuses an unknown or unapproved decision', async () => {
  const goal = await amendedGoal('rc-promotion');
  const { work, request } = await parkedOn(`A decision to amend ${goal.key}: retire its protected outcome rc-promotion (case rc-promotion); do not retire rc-promotion-audit`);
  // Unanswered, it is no decision yet.
  const open = await call(master, 'POST', `goals/${goal.key}/amend`, { decision: request.id });
  assert.equal(open.status, 422); assert.match(open.text, /not an approved goals-and-priorities decision \(unanswered\)/);
  await ok(operator, 'POST', `work/${work.key}/answer`, { request: request.id, choice: 'agree' });
  // An unknown id, and an id whose answer declined, are refused.
  assert.equal((await call(master, 'POST', `goals/${goal.key}/amend`, { decision: randomUUID() })).status, 404);
  const declined = await parkedOn(`Retire ${goal.key}'s outcome rc-promotion-audit`);
  await ok(operator, 'POST', `work/${declined.work.key}/answer`, { request: declined.request.id, choice: 'decline' });
  const refused = await call(master, 'POST', `goals/${goal.key}/amend`, { decision: declined.request.id });
  assert.equal(refused.status, 422); assert.match(refused.text, /answered: Decline/);
  assert.equal((await call(worker, 'POST', `goals/${goal.key}/amend`, { decision: request.id })).status, 403, 'a worker does not amend a goal');
  // A request that both retires and keeps an outcome is no decision about it.
  const ambiguous = await parkedOn(`Amend ${goal.key}: retire rc-promotion-audit, or keep rc-promotion-audit and drop the item`);
  await ok(operator, 'POST', `work/${ambiguous.work.key}/answer`, { request: ambiguous.request.id, choice: 'agree' });
  const both = await call(master, 'POST', `goals/${goal.key}/amend`, { decision: ambiguous.request.id });
  assert.equal(both.status, 422); assert.match(both.text, /both retires and keeps rc-promotion-audit/);

  const amended: Goal = await cli(master, ['amend', goal.key, '--apply-decision', request.id]);
  assert.deepEqual(amended.protected, { cases: ['rc-promotion-audit'], outcomes: ['rc-promotion-audit'] }, 'the request retires rc-promotion; its negated retire keeps rc-promotion-audit');
  assert.equal(amended.amendments?.length, 1);
  assert.deepEqual({ ...amended.amendments![0], at: null, approvedAt: null }, { decision: request.id, work: work.key, outcomes: ['rc-promotion'], cases: ['rc-promotion'], approvedBy: operator.id, approvedAt: null, by: master.id, at: null });
  const shown = await ok(master, 'GET', `goals/${goal.key}`);
  assert.deepEqual(shown.goal.protected, amended.protected);
  assert.deepEqual(shown.history.at(-1).change, { decision: request.id }); assert.equal(shown.history.at(-1).kind, 'goal.amend');
  const again = await call(master, 'POST', `goals/${goal.key}/amend`, { decision: request.id });
  assert.equal(again.status, 409); assert.match(again.text, /already applied/);
});

test('unit:protected-case-refusals-honor-amendment — once the approved retirement is applied, deleting the retired cases and their contract bindings passes, while a case or binding still protected refuses as before', async () => {
  const goal = await amendedGoal('rc-retire');
  const { work, request, observe } = await parkedOn(`Amend ${goal.key}: retire outcome rc-retire and its case rc-retire; keep rc-retire-audit`);
  const contract = (ids: string[]) => JSON.stringify({ outcomes: ids.map(id => ({ id, title: id, criteria: [], cases: [id] })) });
  const base = contract(['rc-retire', 'rc-retire-audit']);
  assert.deepEqual(movedBindings(base, contract(['rc-retire-audit'])), ['rc-retire']);
  assert.deepEqual(movedBindings(base, null), ['rc-retire', 'rc-retire-audit'], 'a deleted contract moves every binding');
  assert.deepEqual(movedBindings(null, base), [], 'a new contract moves none');
  const read = (files: ReturnType<typeof changed>[], moved?: string[]) => ({ ...observe(files as never), ...(moved ? { contractMoved: moved } : {}) });
  const deletion = [changed('e2e/cases/rc-retire.json', 'removed'), changed('e2e/contract.json')];
  assert.match(protectedCaseRefusals(work, read(deletion, ['rc-retire']), [goal]).join('; '), /deletes required case rc-retire .*e2e\/contract.json modifies the contract binding rc-retire of/);
  await ok(operator, 'POST', `work/${work.key}/answer`, { request: request.id, choice: 'agree' });
  const amended: Goal = await ok(master, 'POST', `goals/${goal.key}/amend`, { decision: request.id });
  assert.deepEqual(protectedCaseRefusals(work, read(deletion, ['rc-retire']), [amended]), []);
  // The binding still protected refuses for this item too: moved, deleted with the contract, or unreadable.
  assert.match(protectedCaseRefusals(work, read([changed('e2e/cases/rc-retire-audit.json', 'removed')]), [amended]).join('; '), /Protected case: e2e\/cases\/rc-retire-audit.json deletes required case rc-retire-audit/);
  assert.match(protectedCaseRefusals(work, read([changed('e2e/contract.json')], ['rc-retire', 'rc-retire-audit']), [amended]).join('; '), /modifies the contract binding rc-retire-audit of/);
  assert.match(protectedCaseRefusals(work, read([changed('e2e/contract.json', 'removed')], movedBindings(base, null)!), [amended]).join('; '), /deletes the contract binding rc-retire-audit of/);
  assert.match(protectedCaseRefusals(work, read([changed('e2e/contract.json')]), [amended]).join('; '), /modifies the contract binding rc-retire-audit of/, 'without the contract\'s contents, any edit refuses');
  const other = await claimed(['e2e/']);
  assert.deepEqual(protectedCaseRefusals(other.work, { ...other.observe([changed('e2e/contract.json')] as never), contractMoved: ['rc-retire'] }, [amended]), [], 'a retired binding is free for any item');
});
