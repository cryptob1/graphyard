import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { daemonStateSchema, daemonSummary, emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { acknowledgeCommand, classifyMainCommits, mainWatchAttention, mainWatchFreezeFromEnv, mainWatchHistoryLimit, mainWatchKey, mainWatchReads, mainWatchStateSchema, type MainWatchCommit, type MainWatchPolicy, type MainWatchReads } from '../src/daemon/main-watch.js';
import { promotionCycle, promotionFrozenReason, type PromotionReads } from '../src/daemon/deployment.js';
import { masterConfigSchema } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1519: the main watch reads main's first-parent history from the coordinator checkout, labels
// every commit by what explains it, reports the rest once each, and freezes promotion when asked.

const start = Date.parse('2030-02-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const item = (fields: Record<string, unknown>) => ({
  description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item'] }],
  policy: { checks: ['test'], review: true }, plannedFiles: [], revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start),
  stageEnteredAt: iso(start), ready: true, epoch: 1, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [], ...fields,
}) as unknown as Work;
const commit = (seed: string, subject: string, author = 'Someone Else', at = iso(start - 60_000)): MainWatchCommit => ({ sha: sha(seed), parents: [sha(`${seed}p`)], subject, author, at });

/** A loop's effects around the watch: nothing dispatches, decides or reverts; the watch's reads are the test's. */
function effectsFor(world: { work: Work[]; now: () => number; mainWatch: MainWatchReads | null; promotion?: PromotionReads | null }) {
  const decided: string[] = [];
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: world.work, now: iso(world.now()) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(world.now()), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async (work: Work, action: string) => { decided.push(`${work.key}:${action}`); throw new Error('the watch decides nothing'); },
    decisions: async () => ({ decisions: [] }),
    persist: async () => {},
    mainWatch: world.mainWatch,
    ...(world.promotion ? { promotion: world.promotion } : {}),
  } as unknown as DaemonEffects;
  return { effects, decided };
}
const reads = (history: MainWatchCommit[], policy: Partial<MainWatchPolicy> = {}, freeze = false): MainWatchReads => ({
  freeze,
  history: async () => ({ tip: history[0]?.sha ?? null, since: sha('promoted'), commits: history }),
  policy: async () => ({ acknowledged: policy.acknowledged ?? [], directMergeWindows: policy.directMergeWindows ?? [] }),
});

test('unit:main-watch-classify — every first-parent commit is labelled ledger, github-delivery, revert, candidate-revert, direct-merge or unknown, in that precedence; a commit equal to an item\'s delivery.mergeSha is github-delivery and one nothing explains is unknown', () => {
  const history = [commit('f1', 'ledger merge'), commit('f2', 'merged by github'), commit('f3', 'revert of a broken merge'), commit('f4', 'candidate revert'),
    commit('f5', 'operator pushed inside the window', 'Operator', '2030-01-15T12:00:00.000Z'), commit('f6', 'a stranger pushed', 'Stranger'), commit('f7', 'outside the window', 'Operator', '2030-01-20T12:00:00.000Z')];
  const labelled = classifyMainCommits(history, {
    ledger: { 'GY-10': { mergeSha: sha('f1').toUpperCase() }, 'GY-11': { mergeSha: null } },
    deliveries: [{ key: 'GY-12', mergeSha: sha('f2') }, { key: 'GY-13', mergeSha: sha('f1') }],
    mainGuardReverts: [{ key: 'GY-14', revertSha: sha('f3') }, { key: 'GY-15', revertSha: null }],
    candidateReverts: [{ sha: sha('f4'), id: 'rc-7' }],
    directMergeWindows: [{ since: '2030-01-15T00:00:00.000Z', until: '2030-01-16T00:00:00.000Z' }],
  });
  assert.deepEqual(labelled.map(entry => [entry.label, entry.by]), [
    ['ledger', 'GY-10'], ['github-delivery', 'GY-12'], ['revert', 'GY-14'], ['candidate-revert', 'rc-7'], ['direct-merge', 'direct-merge window since 2030-01-15T00:00:00.000Z'], ['unknown', null], ['unknown', null]]);
  assert.equal(labelled[0].sha, sha('f1'));
  assert.deepEqual(classifyMainCommits([], { ledger: {}, deliveries: [], mainGuardReverts: [], candidateReverts: [], directMergeWindows: [] }), []);
});

test('unit:main-watch-step — the step runs after deployment verification, stores state.mainWatch (checkedAt, tip, unknown, frozen) in the daemon state schema from what the snapshot and the reads explain, and skips a loop without reads', async () => {
  const work = [item({ id: 'w1', key: 'GY-1', stage: 'done', delivery: { mergedAt: iso(start), mergeSha: sha('d1'), authorizationRevision: 1, children: [{ key: 'GY-1a', mergeSha: sha('d1a'), mergedAt: iso(start) }] } }),
    item({ id: 'w2', key: 'GY-2', stage: 'done', mainGuardReverts: [{ mergeSha: sha('broken'), pr: 1, failing: ['test'], revert: null, state: 'merged', at: iso(start), settledAt: iso(start), revertSha: sha('r1'), reason: null }] }),
    item({ id: 'w3', key: 'GY-3', stage: 'done', mergeLedger: { key: 'GY-3', state: 'pushed', head: sha('h3'), baseTip: sha('b'), mergeSha: sha('l3'), risk: 'low', intentAt: iso(start), pushedAt: iso(start), observedTip: null, refusal: null, events: 2 } })];
  const history = [commit('u1', 'Add a hidden toggle', 'A. Stranger'), commit('l3', 'GY-3 merge'), commit('d1a', 'GY-1a merge'), commit('r1', 'Revert "GY-2"'), commit('d1', 'GY-1 merge'), commit('w1', 'inside the window', 'Operator', '2030-01-15T12:00:00.000Z')];
  let now = start;
  const state = emptyDaemonState(config);
  const { effects } = effectsFor({ work, now: () => now, mainWatch: reads(history, { directMergeWindows: [{ since: '2030-01-15T00:00:00.000Z', until: '2030-01-16T00:00:00.000Z' }] }) });
  const { metrics } = await runCycle(config, state, effects, () => now);
  assert.ok(state.mainWatch, 'the watch recorded its state');
  assert.deepEqual(state.mainWatch, { checkedAt: iso(now), tip: sha('u1'), unknown: [{ sha: sha('u1'), subject: 'Add a hidden toggle', author: 'A. Stranger', at: iso(start - 60_000) }], frozen: null });
  assert.deepEqual(daemonStateSchema.parse(JSON.parse(JSON.stringify(state))).mainWatch, state.mainWatch, 'the state round-trips through the daemon state schema');
  assert.deepEqual(mainWatchStateSchema.parse(state.mainWatch), state.mainWatch);
  assert.throws(() => mainWatchStateSchema.parse({ ...state.mainWatch, extra: true }));
  const steps = (metrics.timings?.steps ?? []).map(step => step.step);
  assert.ok(steps.indexOf('main watch') > steps.indexOf('deployment verification'), `the main watch runs after deployment verification: ${steps.join(', ')}`);
  // Nothing to read from: no reads, no state.
  const bare = emptyDaemonState(config);
  await runCycle(config, bare, effectsFor({ work, now: () => now, mainWatch: null }).effects, () => now);
  assert.equal(bare.mainWatch, null);
  now += 20_000;
  // Acknowledged commits drop out of the unknown list on the next read.
  const acknowledged = effectsFor({ work, now: () => now, mainWatch: reads(history, { acknowledged: [{ sha: sha('u1'), reason: 'mine', by: 'human', at: iso(now) }], directMergeWindows: [{ since: '2030-01-15T00:00:00.000Z', until: '2030-01-16T00:00:00.000Z' }] }) });
  await runCycle(config, state, acknowledged.effects, () => now);
  assert.deepEqual(state.mainWatch?.unknown, []);
});

test('unit:main-watch-no-github-requests — the history is read from the coordinator checkout with git alone, since the last rc-production record else the newest 200 commits; no fetch, no gh, no GitHub request', async () => {
  const root = await temporaryDirectory('main-watch');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Watcher', GIT_AUTHOR_EMAIL: 'w@example.test', GIT_COMMITTER_NAME: 'Watcher', GIT_COMMITTER_EMAIL: 'w@example.test', GIT_AUTHOR_DATE: '2030-02-01T00:00:00Z', GIT_COMMITTER_DATE: '2030-02-01T00:00:00Z' } }).trim();
  git('init', '-q', '-b', 'main');
  const shas: string[] = [];
  for (let n = 1; n <= 4; n++) { git('commit', '-q', '--allow-empty', '-m', `Commit ${n}`); shas.push(git('rev-parse', 'HEAD')); }
  // The checkout's remote-tracking tip, as the promotion ledger's fetch leaves it.
  git('update-ref', 'refs/remotes/origin/main', shas[3]);
  const commands: string[][] = [];
  const run = (command: string, args: string[]) => { commands.push([command, ...args]); if (command !== 'git') throw new Error(`${command} is not git`); return execFileSync(command, args, { encoding: 'utf8' }); };
  const watch = mainWatchReads(config, root, run, { policy: async () => ({ acknowledged: [], directMergeWindows: [] }), freeze: false });
  // No promotion record yet: the newest commits, bounded.
  const whole = await watch.history();
  assert.equal(whole.tip, shas[3]); assert.equal(whole.since, null);
  assert.deepEqual(whole.commits.map(entry => entry.subject), ['Commit 4', 'Commit 3', 'Commit 2', 'Commit 1']);
  assert.deepEqual({ ...whole.commits[0], at: Date.parse(whole.commits[0].at) }, { sha: shas[3], parents: [shas[2]], subject: 'Commit 4', author: 'Watcher', at: Date.parse('2030-02-01T00:00:00Z') });
  // A promotion record bounds the read to what landed after it.
  git('tag', '-a', 'rc-production/2030.02.01-1', '-m', JSON.stringify({ sha: shas[1], at: '2030-02-01T00:00:00Z' }), shas[1]);
  const since = await watch.history();
  assert.equal(since.since, shas[1]);
  assert.deepEqual(since.commits.map(entry => entry.sha), [shas[3], shas[2]]);
  assert.ok(commands.every(([command]) => command === 'git'), 'only git runs');
  assert.ok(commands.every(args => !args.includes('fetch') && !args.includes('gh') && !args.some(arg => /api\.github\.com|^gh$/.test(arg))), `no fetch and no gh: ${JSON.stringify(commands)}`);
  assert.ok(commands.some(args => args.includes(`--max-count=${mainWatchHistoryLimit}`)), 'the read is bounded');
  // The step itself makes no request either: through a cycle, every command the reads run is git.
  const state = emptyDaemonState(config);
  const before = commands.length;
  await runCycle(config, state, effectsFor({ work: [], now: () => start, mainWatch: watch }).effects, () => start);
  assert.ok(commands.slice(before).length > 0 && commands.slice(before).every(([command]) => command === 'git'));
  assert.equal(state.mainWatch?.tip, shas[3]);
  assert.equal(state.mainWatch?.unknown.length, 2, 'nothing explains the commits after the promotion record');
  assert.equal(mainWatchFreezeFromEnv({}), false);
  assert.equal(mainWatchFreezeFromEnv({ GRAPHYARD_MAIN_WATCH_FREEZE: 'true' }), true);
});

test('unit:main-watch-report-only — without the freeze each unknown commit raises one main-watch attention item naming its sha, subject and author, once per sha across cycles; nothing is reverted, reworked or decided, and promotion is not frozen', async () => {
  const history = [commit('s1', 'Tweak the login copy', 'Jo Stranger'), commit('s2', 'Bump a pin', 'Jo Stranger')];
  let now = start;
  const state = emptyDaemonState(config);
  const world = effectsFor({ work: [], now: () => now, mainWatch: reads(history) });
  const first = await runCycle(config, state, world.effects, () => now);
  const raised = first.actions.filter(action => action.detail.startsWith('Main watch:'));
  assert.equal(raised.length, 2);
  assert.deepEqual(Object.keys(state.actions).filter(key => key.startsWith('main-watch:')).sort(), [mainWatchKey(sha('s1')), mainWatchKey(sha('s2'))].sort());
  const line = state.actions[mainWatchKey(sha('s1'))]!;
  assert.equal(line.kind, 'escalation'); assert.equal(line.state, 'done');
  assert.match(line.detail, new RegExp(`commit ${sha('s1')} on main \\("Tweak the login copy" by Jo Stranger at `));
  assert.match(line.detail, /Reported only: nothing is reverted or reworked/);
  assert.ok(line.detail.includes(acknowledgeCommand(sha('s1'))));
  for (let n = 0; n < 3; n++) { now += 20_000; const again = await runCycle(config, state, world.effects, () => now); assert.equal(again.actions.filter(action => action.detail.startsWith('Main watch:')).length, 0, 'raised once per sha'); }
  assert.equal(state.actions[mainWatchKey(sha('s1'))]!.attempts, 1);
  assert.deepEqual(world.decided, [], 'no rework, revert or decision was requested');
  assert.ok(Object.keys(state.actions).every(key => key.startsWith('main-watch:') || !/revert|rework/.test(key)));
  assert.equal(state.mainWatch?.frozen, null);
  // Promotion with no freeze asked for runs as before: the freeze inputs are left out.
  const dispatched: string[] = [];
  const promotion: PromotionReads = { ledger: async () => ({ mainSha: sha('s1'), promotedSha: sha('old'), promotedAt: iso(start - 3_600_000), behind: 2, candidates: [] }), runs: async () => [], dispatch: async () => { dispatched.push(sha('s1')); } };
  const open = emptyDaemonState(config);
  await runCycle(config, open, effectsFor({ work: [], now: () => now, mainWatch: reads(history), promotion }).effects, () => now);
  assert.deepEqual(dispatched, [sha('s1')], 'report-only never holds a promotion');
});

test('unit:main-watch-freeze — with freeze: true promotionCycle takes the frozen commit and dispatches nothing, naming it and the acknowledge command, and a tip the watch has not classified waits; through the loop the freeze stands until the admin\'s acknowledgement is read, then the next promotion goes out', async () => {
  const frozen = { sha: sha('x1'), since: iso(start) };
  const ledger = { mainSha: sha('x1'), promotedSha: sha('old'), promotedAt: iso(start - 3_600_000), behind: 1, candidates: [] };
  let dispatches = 0;
  const promotion: PromotionReads = { ledger: async () => ledger, runs: async () => [], dispatch: async () => { dispatches += 1; } };
  const held = await promotionCycle(null, promotion, { now: start, everyMinutes: 10, intervalMs: 20_000, frozen, watchedTip: sha('x1') });
  assert.equal(held.dispatched, false); assert.equal(held.failure, null); assert.equal(dispatches, 0);
  assert.equal(held.state.reason, promotionFrozenReason(frozen));
  assert.ok(held.state.reason!.includes(sha('x1')) && held.state.reason!.includes(acknowledgeCommand(sha('x1'))), held.state.reason!);
  const unwatched = await promotionCycle(null, promotion, { now: start, everyMinutes: 10, intervalMs: 20_000, frozen: null, watchedTip: sha('older') });
  assert.equal(unwatched.dispatched, false); assert.match(unwatched.state.reason!, /has not classified the base branch tip/); assert.equal(dispatches, 0);
  const lifted = await promotionCycle(null, promotion, { now: start, everyMinutes: 10, intervalMs: 20_000, frozen: null, watchedTip: sha('x1') });
  assert.equal(lifted.dispatched, true); assert.equal(dispatches, 1);

  // Through the loop: the watch freezes on the newest unknown commit, promotion holds, the acknowledgement lifts it.
  dispatches = 0;
  let now = start, acknowledged: MainWatchPolicy['acknowledged'] = [];
  const history = [commit('x1', 'Force-pushed fix', 'Nobody Known')];
  const watch: MainWatchReads = { freeze: true, history: async () => ({ tip: sha('x1'), since: sha('old'), commits: history }), policy: async () => ({ acknowledged, directMergeWindows: [] }) };
  const state = emptyDaemonState(config);
  const world = effectsFor({ work: [], now: () => now, mainWatch: watch, promotion });
  await runCycle(config, state, world.effects, () => now);
  assert.equal(dispatches, 0, 'the first cycle promotes nothing: the watch had not classified the tip');
  assert.deepEqual(state.mainWatch?.frozen, { sha: sha('x1'), since: iso(now) });
  assert.match(state.actions[mainWatchKey(sha('x1'))]!.detail, /Promotion is frozen until an admin acknowledges it/);
  const since = state.mainWatch!.frozen!.since;
  for (let n = 0; n < 3; n++) { now += 20_000; await runCycle(config, state, world.effects, () => now); }
  assert.equal(dispatches, 0, 'frozen, nothing is dispatched');
  assert.equal(state.promotion?.reason, promotionFrozenReason({ sha: sha('x1'), since }));
  assert.equal(state.mainWatch?.frozen?.since, since, 'the freeze keeps the time it began');
  acknowledged = [{ sha: sha('x1'), reason: 'I pushed it', by: 'human-operator', at: iso(now) }];
  now += 20_000; await runCycle(config, state, world.effects, () => now);
  assert.equal(state.mainWatch?.frozen, null, 'acknowledged: the freeze lifts');
  now += 20_000; await runCycle(config, state, world.effects, () => now);
  assert.equal(dispatches, 1, 'and the next promotion goes out');
  assert.deepEqual(world.decided, []);
});

test('unit:main-watch-status — master status shows mainWatch (unknown count, newest unknown sha, frozen) inside the daemon section through daemonSummary, one attention item per unknown commit names the acknowledge command, and docs/recovery.md\'s Main watch paragraph is at most 60 words naming it', () => {
  const state: DaemonState = emptyDaemonState(config);
  assert.deepEqual(daemonSummary(state, start, 20_000).mainWatch, { checkedAt: null, tip: null, unknown: 0, newestUnknown: null, frozen: null });
  state.mainWatch = { checkedAt: iso(start), tip: sha('n1'), unknown: [{ sha: sha('n1'), subject: 'Newest', author: 'A', at: iso(start) }, { sha: sha('n2'), subject: 'Older', author: 'B', at: iso(start - 1) }], frozen: { sha: sha('n1'), since: iso(start) } };
  assert.deepEqual(daemonSummary(state, start, 20_000).mainWatch, { checkedAt: iso(start), tip: sha('n1'), unknown: 2, newestUnknown: sha('n1'), frozen: { sha: sha('n1'), since: iso(start) } });
  const attention = mainWatchAttention(state.mainWatch, 'main');
  assert.equal(attention.length, 2);
  assert.ok(attention.every(entry => entry.subject === 'main-watch' && entry.role === 'master' && !entry.human));
  assert.match(attention[0].text, new RegExp(`commit ${sha('n1')} on main \\("Newest" by A at `)); assert.match(attention[0].text, /Promotion is frozen/);
  assert.match(attention[1].text, /Reported only/);
  assert.ok(attention[0].next.includes(acknowledgeCommand(sha('n1'))));
  assert.deepEqual(mainWatchAttention(null, 'main'), []);
  const docs = readFileSync(fileURLToPath(new URL('../docs/recovery.md', import.meta.url)), 'utf8');
  const paragraph = docs.split(/^## Main watch\s*$/m)[1]?.split(/\n## /)[0]?.trim();
  assert.ok(paragraph, 'docs/recovery.md has a Main watch section');
  assert.ok(paragraph.split(/\s+/).length <= 60, `at most 60 words: ${paragraph.split(/\s+/).length}`);
  assert.ok(paragraph.includes('graphyard master main-watch acknowledge SHA --reason TEXT'));
});

// ——— The acknowledgement route: admin-only, recorded once per Idempotency-Key, readable by the loop. ———
const repository = 'owner/project';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const principals = [operator, coordinator, worker];
const credentials = principals.map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const agent = { id: 'master-operator-agent', token: `master-operator-agent-${'m'.repeat(32)}` };
let pg: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1520;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('main-watch-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('main_watch_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/main_watch_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const created = await request(token(operator), 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: ['decision:merge'], scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'The master agent' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });

async function request(credential: string, path: string, body?: unknown, key = randomUUID()) {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}

test('integration:main-watch-acknowledge-admin-only — only an admin credential records policy.main-watch.acknowledged; coordinator, worker and operator-agent identities are refused and nothing is written; a retried key replays, a second acknowledgement of the same sha records nothing new, and the loop reads the list', async () => {
  const target = sha('acknowledged');
  for (const credential of [token(coordinator), token(worker), agent.token]) {
    const refused = await request(credential, 'main-watch/acknowledge', { sha: target, reason: 'agents may not acknowledge' });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
  }
  assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM events WHERE kind='policy.main-watch.acknowledged'")).rows[0].n, 0);
  assert.equal((await request(token(operator), 'main-watch/acknowledge', { sha: 'not-a-sha', reason: 'bad' })).status, 400);
  assert.equal((await request(token(operator), 'main-watch/acknowledge', { sha: target })).status, 400, 'a reason is required');
  const key = randomUUID();
  const recorded = await request(token(operator), 'main-watch/acknowledge', { sha: target.toUpperCase(), reason: 'I pushed the hotfix myself' }, key);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.sha, target); assert.equal(recorded.body.by, operator.id); assert.equal(recorded.body.already, false);
  const replayed = await request(token(operator), 'main-watch/acknowledge', { sha: target.toUpperCase(), reason: 'I pushed the hotfix myself' }, key);
  assert.deepEqual(replayed.body, recorded.body, 'the same key replays the first result');
  assert.equal((await request(token(operator), 'main-watch/acknowledge', { sha: target, reason: 'other words' }, key)).status, 409, 'a key reused with other input is refused');
  const again = await request(token(operator), 'main-watch/acknowledge', { sha: target, reason: 'once more' });
  assert.equal(again.status, 200); assert.equal(again.body.already, true); assert.equal(again.body.reason, 'I pushed the hotfix myself');
  const rows = (await store.pool.query("SELECT actor, work_id, payload FROM events WHERE kind='policy.main-watch.acknowledged' ORDER BY seq")).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].actor, operator.id); assert.equal(rows[0].work_id, null); assert.equal(rows[0].payload.sha, target);
  // The loop's read, with its coordinator credential; the worker may not read it.
  const read = await request(token(coordinator), 'main-watch');
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.acknowledged.map((entry: any) => [entry.sha, entry.by, entry.reason]), [[target, operator.id, 'I pushed the hotfix myself']]);
  assert.deepEqual(read.body.directMergeWindows, []);
  assert.equal((await request(token(worker), 'main-watch')).status, 403);
  assert.equal((await request(token(operator), 'main-watch')).status, 200);
});
