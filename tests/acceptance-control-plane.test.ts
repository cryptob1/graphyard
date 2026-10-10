import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Observation, Principal } from '../src/model.js';
import { acceptanceChangeRisk, acceptanceDraftSchema, applyGoalCommand, protectedCaseRefusals, recordGoal, type Goal } from '../src/model/goal.js';
import { acceptanceEffects, acceptanceStep, clearDrafts, draftsSettled, mergeAcceptanceChange, type AcceptanceEffects, type AcceptanceWriterPorts } from '../src/daemon/acceptance.js';
import { clearPlans, planPayloadSchema, plannerStep, plansSettled, type PlannerEffects } from '../src/daemon/planner.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { recordLanding } from '../src/server/routes/goals.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import { defaultChildRun } from '../src/child-runner.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1535 AC-1 and AC-2. Under the control-plane merger the acceptance role commits a goal's
 * outcomes, cases and contract bindings as one change for the merge writer — no pull request — the
 * change is sensitive, so only the approver identity's verdict on its exact head lets the writer land
 * it, and once merged the goal plans and its cases are protected as in github mode, which is
 * unchanged. The planner never plans a goal whose acceptance has not merged.
 */
const repository = 'owner/project';
const admin: Principal = { id: 'cp-admin', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'cp-master', role: 'coordinator', sessionKind: 'ai' };
const author: Principal = { id: 'cp-operator-agent', role: 'admin', sessionKind: 'ai' };
const approver: Principal = { id: 'cp-approver', role: 'admin', sessionKind: 'ai' };
const credentials = [admin, coordinator, author, approver].map(principal => ({ ...principal, token: `cp-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let fixture: string, origin: string, checkout: string, baseTip: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const freePort = () => new Promise<number>((done, fail) => {
  const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); });
});

before(async () => {
  fixture = await realpath(await temporaryDirectory('acceptance-cp'));
  origin = join(fixture, 'origin.git'); checkout = join(fixture, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  await writeFile(join(checkout, 'README.md'), '# A brand-new project\n');
  git(checkout, 'add', '-A'); git(checkout, 'commit', '-q', '-m', 'base'); git(checkout, 'push', '-q', 'origin', 'main');
  baseTip = git(checkout, 'rev-parse', 'refs/remotes/origin/main');
  const port = await freePort();
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('acceptance-cp-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('acceptance_cp_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/acceptance_cp_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  http = server(engine, credentials, null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { clearDrafts(); clearPlans(); if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); if (fixture) await rm(fixture, { recursive: true, force: true }); });

async function call(principal: Principal, path: string, body?: unknown, key: string = randomUUID()) {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, text, body: (() => { try { return JSON.parse(text); } catch { return text; } })() as any };
}
async function ok(principal: Principal, path: string, body?: unknown, key?: string) {
  const answer = await call(principal, path, body, key);
  if (answer.status !== 200) throw new Error(`${path} refused (${answer.status}): ${answer.text}`);
  return answer.body;
}
const setMerger = (merger: 'github' | 'control-plane') => ok(admin, 'merger', { merger, reason: `GY-1535 test: ${merger}` });
const readGoal = async (key: string) => (await ok(coordinator, `goals/${key}`)).goal as Goal;

function stubRuntime(respond: () => unknown, runs: string[]): Runner {
  return { name: 'stub', start<T>(_prompt: string, options: RunOptions<T>) {
    runs.push(String(options.env?.GRAPHYARD_PI_ROLE ?? options.tool));
    let result: RunResult<T>;
    try { const payload = options.validate(respond()); result = { ok: true, tool: options.tool, payload, payloads: [payload] }; }
    catch (error) { result = { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
    return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
  } };
}
const greetingCase = (id: string) => ({ id, title: `${id} answers`, tags: ['api'], target: 'uat', required: true, steps: [{ kind: 'http', name: 'read the greeting', method: 'GET', path: '/', status: 200 }] });
const draftFor = (goal: Goal, outcome: string) => ({ goal: goal.key, outcomes: [{ id: outcome, title: `A customer is greeted (${outcome})`, criteria: ['The greeting names the customer'], case: greetingCase(outcome) }] });

/** The acceptance role as the loop wires it, its runtimes stubbed and the judgement posted as the approver identity. */
function harness(merger: () => Promise<'github' | 'control-plane'>, outcome: string) {
  const runs: string[] = [], spied = { open: 0, land: 0, commit: 0, landed: 0, pushes: 0 };
  let clock = Date.parse('2026-10-08T00:00:00Z');
  const config = masterConfigSchema.parse({ version: 1, url, credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard', repository, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', workers: [], run: { worktreeRoot: join(fixture, 'managed'), mergeWriter: { deployKeyFile: join(fixture, 'deploy-key'), retrials: 2 } } });
  const run: typeof defaultChildRun = (command, args, options) => { if (command === 'git' && args.includes('push')) spied.pushes++; return defaultChildRun(command, args, options); };
  const writer = mergeWriterReads(config, checkout, run, { base: join(fixture, 'managed'), record: async () => { throw new Error('a goal records no work-item merge step'); }, merger });
  const real = acceptanceEffects(config, checkout, { run, fetcher: fetch, asCoordinator: path => ok(coordinator, path),
    asOperatorAgent: (_method, path, body, key) => ok(author, path, body, key), merger, writer });
  const effects: AcceptanceEffects = {
    ...real,
    settings: diagnosticianSettings({}),
    goals: async () => (await ok(coordinator, 'goals?open=1')).goals,
    runner: async (role, attempt, goal) => ({ runtime: 'stub', model: attempt, runner: stubRuntime(() => role === 'judge'
      ? { goal: goal.key, verdict: 'approve', reason: 'The outcome is what the customer asked for and its case checks what they see' } : draftFor(goal, outcome), runs) }),
    judge: (goal, judgement) => ok(approver, `goals/${goal.key}/${judgement.verdict}`, { reason: judgement.reason }, `acceptance:${goal.id}:${goal.revision}:judged`),
    // GitHub is a double: the control-plane path must never reach it.
    open: async (goal, _draft) => { spied.open++; return { pr: 7, branch: `graphyard/${goal.key.toLowerCase()}-acceptance-${goal.revision}`, head: 'b'.repeat(40) }; },
    pullRequest: async () => ({ state: 'open', mergeSha: null, head: 'b'.repeat(40) }),
    land: async goal => { spied.land++; const landing = { state: 'merged' as const, detail: `#${goal.acceptance!.pr} merged`, mergeSha: 'c'.repeat(40) }; return { goal: await recordLanding(store, goal, landing, author), landing }; },
    close: async () => {},
    ...(real.commit ? { commit: (goal, draft) => { spied.commit++; return real.commit!(goal, draft); }, landed: (goal, mergeSha) => { spied.landed++; return real.landed!(goal, mergeSha); } } : {}),
  };
  const state = emptyDaemonState(config);
  const tick = async (advanceMs = 6 * 60_000) => {
    clock += advanceMs;
    await acceptanceStep({ config, state, now: () => clock, clock, snapshot: { work: [] }, performed: [], effects: { acceptance: effects, persist: async () => {} },
      isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() } as unknown as Cycle);
    await draftsSettled();
  };
  return { effects, runs, spied, tick, state };
}

test('unit:acceptance-control-plane-change — in control-plane mode the acceptance role commits outcomes, cases and contract bindings as one change the merge writer lands (no pull request), only on the approver identity\'s verdict on its exact head, and the merged goal plans with its cases protected', { timeout: 120_000 }, async () => {
  clearDrafts();
  await setMerger('control-plane');
  const goal = await ok(author, 'goals', { statement: 'Customers are greeted by name', users: ['Customers'], constraints: [], deployTarget: 'uat then production' }) as Goal;
  const world = harness(async () => (await ok(coordinator, 'status')).mergeWriter.merger, 'greeting');

  // Drafted, then committed in the coordinator checkout for the merge writer: nothing pushed, no pull request.
  for (let i = 0; i < 3 && (await readGoal(goal.key)).stage === 'acceptance-drafting'; i++) await world.tick();
  const drafted = await readGoal(goal.key);
  assert.equal(drafted.stage, 'awaiting-approval', JSON.stringify(world.state.actions));
  assert.equal(drafted.acceptance!.pr, null, 'no pull request');
  assert.equal(world.spied.open, 0, 'GitHub was never asked to open one');
  assert.equal(world.spied.commit, 1);
  const { branch, head } = drafted.acceptance!;
  assert.equal(git(checkout, 'rev-parse', `refs/heads/${branch}`), head, 'the change is a commit on its own branch of the coordinator checkout');
  assert.deepEqual(git(checkout, 'diff', '--name-only', baseTip, head).split('\n').sort(), ['e2e/cases/greeting.json', 'e2e/contract.json'], 'one change: the case and the contract bindings');
  assert.equal(git(origin, 'branch', '--list', branch), '', 'the change\'s branch is never pushed');
  assert.equal(git(origin, 'rev-parse', 'main'), baseTip, 'nothing lands before the approval');
  assert.match(world.state.actions[`acceptance:${goal.id}`]!.detail, /for the merge writer, with no pull request/);

  // The change is sensitive: the land route refuses it before approval and refuses any commit that is not a merge of the approved head.
  assert.equal(acceptanceChangeRisk(['e2e/cases/greeting.json', 'e2e/contract.json']).risk, 'sensitive');
  assert.match(acceptanceChangeRisk(['e2e/cases/greeting.json']).reasons.join(), /e2e\/cases\/greeting\.json: customer acceptance/);
  assert.equal((await call(author, `goals/${goal.key}/land`, { mergeSha: baseTip })).status, 409, 'nothing is landed while it awaits the approver');
  await world.tick();
  await world.tick();
  const approved = await readGoal(goal.key);
  assert.equal(approved.stage, 'accepted');
  assert.equal(approved.approval!.by, approver.id); assert.notEqual(approved.approval!.by, approved.acceptance!.author);
  assert.equal(approved.approval!.head, head, 'the verdict binds the exact head');
  const forged = await call(author, `goals/${goal.key}/land`, { mergeSha: baseTip });
  assert.equal(forged.status, 422, forged.text); assert.match(forged.text, /is not a merge of the approved head/);
  assert.equal((await call(author, `goals/${goal.key}/land`, {})).status, 422, 'a merge-writer change is landed only by naming the merge the writer pushed');
  // GY-1657: the route refreshes origin/main before judging; a refresh that fails (or throws) is a named refusal, never a verdict on the stale ref.
  const real = engine.gitRunner!;
  for (const failing of [async () => ({ status: 128, stdout: '', stderr: 'fatal: unable to access origin' }), async () => { throw new Error('spawn git ENOENT'); }] as const) {
    engine.gitRunner = args => args[0] === 'fetch' ? failing() : real(args);
    const stale = await call(author, `goals/${goal.key}/land`, { mergeSha: baseTip });
    assert.equal(stale.status, 503, stale.text); assert.match(stale.text, /is not judged: the control plane could not refresh origin\/main .*(unable to access origin|spawn git ENOENT)/);
  }
  engine.gitRunner = real;
  assert.equal(world.spied.pushes, 0);

  // The merge writer lands it: one leased push onto main, recorded merged by the control plane, and the goal plans.
  await world.tick();
  const merged = await readGoal(goal.key);
  assert.equal(merged.stage, 'planning', JSON.stringify(world.state.actions[`acceptance:${goal.id}`]));
  assert.equal(world.spied.pushes, 1, 'one push'); assert.equal(world.spied.landed, 1); assert.equal(world.spied.land, 0, 'the GitHub land path was never taken');
  const tip = git(origin, 'rev-parse', 'main');
  assert.equal(merged.merged!.pr, null); assert.equal(merged.merged!.mergeSha, tip);
  assert.equal(git(origin, 'rev-parse', `${tip}^1`), baseTip); assert.equal(git(origin, 'rev-parse', `${tip}^2`), head, 'main\'s new first parent merges exactly the approved head');
  assert.equal(JSON.parse(git(origin, 'show', `${tip}:e2e/contract.json`)).outcomes[0].cases[0], 'greeting');
  assert.equal(JSON.parse(git(origin, 'show', `${tip}:e2e/cases/greeting.json`)).required, true);
  assert.deepEqual(merged.protected, { cases: ['greeting'], outcomes: ['greeting'] });
  assert.match(world.state.actions[`acceptance:${goal.id}`]!.detail, /a sensitive change .* approved by cp-approver, not its author cp-operator-agent/);
  // Protected exactly as a merged acceptance pull request: an implementation that edits the case is refused.
  const observation = { files: ['e2e/cases/greeting.json'], scopeFiles: [{ path: 'e2e/cases/greeting.json', status: 'modified', baseSha: 'd'.repeat(40), sha: 'e'.repeat(40) }] } as unknown as Observation;
  assert.match(protectedCaseRefusals({ key: 'GY-77' }, observation, [merged]).join(), /modifies required case greeting \(outcome greeting of GOAL-/);
  // A retry after the record (or a lost answer) never pushes twice.
  await world.tick();
  assert.equal(world.spied.pushes, 1);
  const again = await call(author, `goals/${goal.key}/land`, {});
  assert.equal(again.body.landing.state, 'merged');

  // The writer's own gate: a self-approved head, a head other than the approved one, or a merge carrying more than the cases and contract never pushes.
  const pushed: string[] = [];
  const ports = (files: string[], merged: string | null = null): AcceptanceWriterPorts => ({ baseBranch: 'main', retrials: 1, fetch: async () => baseTip, merge: async () => ({ mergeSha: 'f'.repeat(40), files }),
    push: async sha => { pushed.push(sha); return 'pushed'; }, merged: async () => merged });
  const accepted = { ...approved, stage: 'accepted' as const };
  assert.equal((await mergeAcceptanceChange(ports(['e2e/cases/greeting.json']), { ...accepted, approval: { ...accepted.approval!, by: accepted.acceptance!.author } })).state, 'unapproved');
  assert.equal((await mergeAcceptanceChange(ports(['e2e/cases/greeting.json']), { ...accepted, approval: { ...accepted.approval!, head: 'f'.repeat(40) } })).state, 'moved');
  const stray = await mergeAcceptanceChange(ports(['e2e/cases/greeting.json', 'src/app.ts']), accepted);
  assert.equal(stray.state, 'unapproved'); assert.match(stray.detail, /src\/app\.ts, which are not its cases or contract/);
  assert.deepEqual(pushed, [], 'none of them pushed');
  assert.equal((await mergeAcceptanceChange({ ...ports([]), merge: async () => ({ conflict: ['e2e/contract.json'] }) }, accepted)).state, 'conflicting');
  assert.deepEqual(await mergeAcceptanceChange({ ...ports([]), push: async () => 'rejected' }, accepted).then(landing => landing.state), 'waiting');
  await setMerger('github');
});

test('unit:acceptance-github-unchanged — under the github merger the acceptance draft is still one pull request landed through GitHub; the merge-writer steps are never used and the land route refuses a named merge commit', { timeout: 120_000 }, async () => {
  clearDrafts();
  const current = (await ok(coordinator, 'status')).mergeWriter.merger;
  if (current !== 'github') await setMerger('github');
  const goal = await ok(author, 'goals', { statement: 'Customers can sign up', users: ['Customers'], constraints: [], deployTarget: 'uat then production' }) as Goal;
  const world = harness(async () => 'github', 'sign-up');
  for (let i = 0; i < 3 && (await readGoal(goal.key)).stage === 'acceptance-drafting'; i++) await world.tick();
  const drafted = await readGoal(goal.key);
  assert.equal(drafted.stage, 'awaiting-approval');
  assert.equal(drafted.acceptance!.pr, 7, 'the draft is the pull request GitHub opened');
  assert.equal(world.spied.open, 1); assert.equal(world.spied.commit, 0, 'nothing is committed for the merge writer');
  await world.tick(); await world.tick();
  assert.equal((await readGoal(goal.key)).stage, 'accepted');
  const named = await call(author, `goals/${goal.key}/land`, { mergeSha: 'c'.repeat(40) });
  assert.equal(named.status, 422); assert.match(named.text, /GitHub reports its merge/);
  await world.tick();
  const merged = await readGoal(goal.key);
  assert.equal(merged.stage, 'planning');
  assert.equal(merged.merged!.pr, 7); assert.equal(world.spied.land, 1); assert.equal(world.spied.landed, 0); assert.equal(world.spied.pushes, 0, 'the merge writer never pushed');
  assert.deepEqual(merged.protected.cases, ['sign-up']);
});

test('unit:planner-waits-for-acceptance — the planner never plans a goal whose acceptance change has not merged, every planned item names the outcomes it serves, and a goal with zero outcomes is refused at drafting', async () => {
  clearPlans();
  const at = '2026-10-08T00:00:00.000Z';
  const head = '1'.repeat(40);
  const recorded = recordGoal({ statement: 'Players can play the game', users: ['Players'], constraints: [], deployTarget: 'GitHub Pages' }, 'GOAL-9', { actor: author, at });
  const outcomes = [{ id: 'play', title: 'A player plays', criteria: ['The game starts'], case: greetingCase('play') }];
  // Zero outcomes is refused at drafting, by the role's schema and by the goal model the route applies.
  assert.throws(() => acceptanceDraftSchema.parse({ outcomes: [] }));
  assert.throws(() => applyGoalCommand(recorded, 'draft', { outcomes: [], pr: null, branch: 'graphyard/goal-9-acceptance-1', head }, { actor: author, at }));
  const drafted = applyGoalCommand(recorded, 'draft', { outcomes, pr: null, branch: 'graphyard/goal-9-acceptance-1', head }, { actor: author, at });
  const accepted = applyGoalCommand(drafted, 'approve', { reason: 'what players asked for' }, { actor: approver, at });
  assert.throws(() => applyGoalCommand(accepted, 'merged', { pr: null, mergeSha: null }, { actor: author, at }), /merge commit the merge writer pushed/);
  const merged = applyGoalCommand(accepted, 'merged', { pr: null, mergeSha: '2'.repeat(40) }, { actor: author, at });
  assert.equal(merged.stage, 'planning');

  const runs: string[] = [];
  let goals: Goal[] = [recorded, drafted, accepted];
  const item = { ref: 'play', title: 'Start the game', description: 'The page starts the game', outcomes: ['play'], cases: ['play'],
    criteria: [{ id: 'AC-1', text: 'The game starts', proofs: ['unit:game-starts'] }], plannedFiles: ['src/game.ts'], dependsOn: [] };
  const planner: PlannerEffects = {
    settings: diagnosticianSettings({}), cwd: fixture, goals: async () => goals,
    runner: async (_role, attempt) => ({ runtime: 'stub', model: attempt, runner: stubRuntime(() => ({ goal: 'GOAL-9', note: 'A static page.', items: [item] }), runs) }),
    plan: async goal => goal, invalid: async goal => goal, judge: async goal => goal, release: async goal => goal, deliver: async goal => goal,
  };
  const config = masterConfigSchema.parse({ version: 1, url, credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard', repository, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const state = emptyDaemonState(config);
  const tick = async () => { await plannerStep({ config, state, now: () => 0, clock: 0, snapshot: { work: [] }, performed: [], effects: { planner, persist: async () => {} },
    isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() } as unknown as Cycle); await plansSettled(); };
  await tick(); await tick();
  assert.deepEqual(runs, [], 'no plan for a goal drafting, awaiting approval or approved but unmerged');
  goals = [merged];
  await tick();
  assert.deepEqual(runs, ['planner'], 'planned once its acceptance change merged');
  // Every planned item names the outcome ids it serves: an item serving none is no plan.
  assert.throws(() => planPayloadSchema.parse({ goal: 'GOAL-9', note: 'A static page.', items: [{ ...item, outcomes: [] }] }));
  const { outcomes: _dropped, ...unnamed } = item;
  assert.throws(() => planPayloadSchema.parse({ goal: 'GOAL-9', note: 'A static page.', items: [unnamed] }));
});
