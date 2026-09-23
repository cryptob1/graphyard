import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { broadScopeRefusals, describeChain, dispatchHold, dispatchHoldBoundMs, dispatchOverlap, effectiveConcurrency, exclusionPaths } from '../src/coordination.js';
import { assertDispatchable, broadScopeFlag, buildMasterStatus, dispatchSchedule, dispatchWork, guardBroadScope, masterConfigSchema, runAutonomyCommand, setupMaster, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { approveScopeRequest } from '../src/cli/master-status.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { Work } from '../src/model.js';

// GY-112: items claim directories, so every item conflicts with every other and ten workers
// deliver like one. Exclusion is decided by the files a candidate actually changed once it has
// one (AC-1); a root-level directory scope is refused where planned files are set, or recorded as
// an explicit exception (AC-2); master status reports the fleet's effective concurrency beside its
// idle workers (AC-3); and a hold outlives its bound as a dispatch over the overlap with the chain
// named, never as an indefinite wait (AC-4). Each test is named for the proof it produces.
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const hour = 3_600_000;

function work(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:x'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'ready', revision: 1, policyRevision: 1, createdAt: iso(-4 * hour), updatedAt: iso(0), stageEnteredAt: iso(-4 * hour),
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides,
  } as Work;
}
/** Claimed `sinceMs` ago with a live lease; no candidate yet, so its declared scope is what it excludes on. */
const claimed = (key: string, plannedFiles: string[], sinceMs = hour, overrides: Partial<Work> = {}) => work(key, { stage: 'build', plannedFiles, epoch: 1, lease: { owner: `${key}-worker`, epoch: 1, expiresAt: iso(10 * hour) },
  lastAssignment: { owner: `${key}-worker`, epoch: 1, claimedAt: iso(-sinceMs) }, ...overrides });
/** Submitted `sinceMs` ago with an observed candidate: `files` is what the candidate actually changed. */
const submitted = (key: string, plannedFiles: string[], files: string[], sinceMs = hour, overrides: Partial<Work> = {}) => work(key, { stage: 'review', plannedFiles, epoch: 1, submission: { epoch: 1, pr: 7 },
  lastAssignment: { owner: `${key}-worker`, epoch: 1, claimedAt: iso(-sinceMs) },
  candidate: candidateOf(key), observation: { candidate: candidateOf(key), files, at: iso(-60_000), merged: false, checks: [], reviews: [] } as any, ...overrides });
const candidateOf = (key: string) => ({ sha: key.toLowerCase().padEnd(40, 'f').replace(/[^0-9a-f]/g, 'e'), baseSha: 'b'.repeat(40), pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' });
/** Submitted, then sent back for rework: dispatchable again, a peer of the ready items rather than ahead of anything. */
const rework = (key: string, plannedFiles: string[], files: string[], sinceMs = hour, overrides: Partial<Work> = {}) => submitted(key, plannedFiles, files, sinceMs, { reworkRequested: true, stageEnteredAt: iso(-sinceMs), ...overrides });

function daemonConfig(credentialFile: string, workers: WorkerProfile[]): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers });
}
const launchProfile = (name: string, credentialFile: string): WorkerProfile => ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'codex', credentialFile, agentArgs: [], approvals: 'auto', environment: {} });
async function daemon(profiles: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-dispatch-overlap-'));
  const token = join(directory, 'coordinator.token'); await writeFile(token, coordinatorToken, { mode: 0o600 });
  const credential = join(directory, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
  const master = daemonConfig(token, profiles.map(name => launchProfile(name, credential)));
  const log: string[] = [];
  let snapshotWork: Work[] = [], offsetMs = 0;
  const effects: DaemonEffects = {
    agents: () => [], credentials: async items => Object.fromEntries(items.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: snapshotWork, now: iso(offsetMs) }),
    closeSession: () => {}, dispatch: async (item, profile) => { log.push(`${item.key}→${profile.name}`); },
    requestProof: () => {}, merge: async () => ({}), observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
  };
  return { master, effects, log, state: emptyDaemonState(master), set: (items: Work[], atMs = 0) => { snapshotWork = items; offsetMs = atMs; }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('integration:overlap-uses-changed-files — once an item has a candidate it excludes others on the files that candidate changed, not on the directory it declared; two items changing the same file are still held', async () => {
  // Four items declared the whole tests/ directory. Their candidates each changed one file under it.
  const landed = submitted('GY-a', ['tests/'], ['tests/a.test.ts']);
  const disjoint = rework('GY-b', ['tests/'], ['tests/b.test.ts']);
  const sameFile = rework('GY-c', ['tests/'], ['tests/a.test.ts']);
  const narrow = work('GY-d', { plannedFiles: ['tests/d.test.ts'] });
  const directory = work('GY-e', { plannedFiles: ['tests/'] });
  const all = [landed, disjoint, sameFile, narrow, directory];
  assert.deepEqual(exclusionPaths(landed), ['tests/a.test.ts'], 'a candidate is judged by its observed diff');
  assert.deepEqual(exclusionPaths(directory), ['tests/'], 'before a candidate the declared scope stands in');
  // Overlapping directory scopes, disjoint changed files: nothing is ahead of GY-b, so GY-a and GY-b run together.
  assert.deepEqual(dispatchOverlap(disjoint, all, clock), []);
  assert.doesNotThrow(() => assertDispatchable(disjoint, all, iso(0)));
  // The same file changed on both sides is a real conflict and still holds.
  assert.deepEqual(dispatchOverlap(sameFile, all, clock).map(entry => [entry.key, entry.state, entry.paths, entry.theirs]), [['GY-a', 'submitted', ['tests/a.test.ts'], ['tests/a.test.ts']]]);
  assert.throws(() => assertDispatchable(sameFile, all, iso(0)), /held by planned-file overlap with GY-a \(submitted, review\) on tests\/a\.test\.ts/);
  // A ready item that named its file is not held by a candidate that changed a different file under the same root; one that claimed the root still is.
  assert.deepEqual(dispatchOverlap(narrow, all, clock), []);
  assert.deepEqual(dispatchOverlap(directory, all, clock).map(entry => [entry.key, entry.paths]), [['GY-a', ['tests/']]], 'the reworked GY-b and GY-c are peers waiting for a worker, not items ahead');

  // The durable loop dispatches both unheld items in one cycle with workers to spare, and holds the two real overlaps.
  const loop = await daemon(['one', 'two', 'three', 'four']);
  try {
    loop.set(all);
    await runCycle(loop.master, loop.state, loop.effects, () => clock);
    assert.deepEqual(loop.log, ['GY-d→one', 'GY-b→two'], 'the file-scoped item is offered first, then the rework whose candidate touched nothing in flight; GY-c and GY-e are held');
    const plan = dispatchSchedule(all, clock);
    assert.deepEqual(plan.held.map(entry => [entry.key, entry.ahead.map(item => item.key)]), [['GY-c', ['GY-a']], ['GY-e', ['GY-a']]]);
    assert.deepEqual(plan.order.map(entry => [entry.key, entry.held]), [['GY-d', false], ['GY-b', false], ['GY-c', true], ['GY-e', true]]);
    // Once GY-a merges, GY-c is judged against nothing and dispatches too.
    loop.log.length = 0;
    loop.set([{ ...landed, stage: 'done' } as Work, disjoint, sameFile, narrow, directory]);
    await runCycle(loop.master, loop.state, loop.effects, () => clock + 30_000);
    assert.deepEqual(loop.log, ['GY-c→one', 'GY-e→two']);
  } finally { await loop.cleanup(); }
});

test('unit:broad-scope-refused — a tests/ claim is refused where planned files are set, naming the narrower paths, and a tests/one-file.test.ts claim is not; --allow-broad-scope records the exception in the audited reason', async () => {
  const criteria = [{ id: 'AC-1', text: 'A test in tests/one-file.test.ts asserts the claim is refused', proofs: ['unit:x'] }];
  const [refusal] = broadScopeRefusals(['tests/', 'src/scope.ts'], criteria.map(criterion => criterion.text));
  assert.equal(refusal.scope, 'tests/'); assert.deepEqual(refusal.narrower, ['tests/one-file.test.ts']);
  assert.match(refusal.reason, /root-level directory scope.*name tests\/one-file\.test\.ts instead/);
  assert.deepEqual(broadScopeRefusals(['tests/one-file.test.ts', 'src/cli/', 'docs/protocol/']), [], 'files and directories below the root are not broad');
  assert.match(broadScopeRefusals(['docs/'])[0].reason, /name the files under docs\/ this item changes instead/, 'with nothing narrower named, the refusal still says what to name');

  const reason = 'Operator goal: cover the refusal';
  assert.throws(() => guardBroadScope({ plannedFiles: ['tests/'], criteria }, reason, { allow: false, command: 'master create' }), /master create refused a high-conflict scope: tests\/ is a root-level directory scope.*tests\/one-file\.test\.ts instead.*--allow-broad-scope/);
  assert.equal(guardBroadScope({ plannedFiles: ['tests/one-file.test.ts'], criteria }, reason, { allow: false, command: 'master create' }), reason);
  assert.equal(guardBroadScope({ plannedFiles: ['tests/'], criteria }, reason, { allow: true, command: 'master create' }), `Broad scope exception (tests/) recorded with ${broadScopeFlag}: ${reason}`);
  assert.equal(guardBroadScope({ plannedFiles: ['tests/', 'src/a.ts'] }, reason, { allow: false, command: 'master requirements', existing: ['tests/'] }), reason, 'a revision is judged on the scopes it introduces');

  // The commands that set planned files enforce it: `master create`, `master requirements` and `master scope`.
  const root = await mkdtemp(join(tmpdir(), 'graphyard-broad-scope-')); const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-broad-scope-credentials-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const operatorFile = join(credentialDirectory, 'operator.token'); await writeFile(operatorFile, 'operator-agent-token-'.padEnd(40, 'o'), { mode: 0o600 });
    const config = masterConfigSchema.parse({ ...daemonConfig(join(credentialDirectory, 'coordinator.token'), []), operatorAgent: { id: 'graphyard-master-project-operator', credentialFile: operatorFile } });
    const sent: { path: string; body: any }[] = [];
    const fetcher: typeof fetch = async (input, init) => { sent.push({ path: String(input).replace(config.url, ''), body: JSON.parse(String(init?.body)) }); return new Response(JSON.stringify({ key: 'GY-1', revision: 2 })); };
    const item = work('GY-1', { plannedFiles: ['src/scope.ts'], criteria, title: 'Broad scope item' });
    const deps = { coordinator: async () => ({ work: [item], now: iso(0) }), readSecret: async () => '', agents: () => [], daemonLock: async () => null, fetcher };
    const intent = join(root, 'intent.json');
    await writeFile(intent, JSON.stringify({ title: 'Claims a root directory', plannedFiles: ['tests/'], criteria, policy: { checks: ['test'], review: true } }));
    await assert.rejects(runAutonomyCommand(root, config, 'create', [intent, reason], deps), /master create refused a high-conflict scope: tests\/ .*tests\/one-file\.test\.ts instead/);
    assert.equal(sent.length, 0, 'a refused create reaches no server');
    await runAutonomyCommand(root, config, 'create', [intent, broadScopeFlag, reason], deps);
    assert.equal(sent[0].path, '/api/work'); assert.equal(sent[0].body.reason, `Broad scope exception (tests/) recorded with ${broadScopeFlag}: ${reason}`);
    await writeFile(intent, JSON.stringify({ title: 'Names its file', plannedFiles: ['tests/one-file.test.ts'], criteria, policy: { checks: ['test'], review: true } }));
    await runAutonomyCommand(root, config, 'create', [intent, reason], deps);
    assert.equal(sent[1].body.reason, reason, 'a file claim passes untouched');
    const revision = join(root, 'revision.json');
    await writeFile(revision, JSON.stringify({ plannedFiles: ['src/scope.ts', 'tests/'] }));
    await assert.rejects(runAutonomyCommand(root, config, 'requirements', ['GY-1', revision, reason], deps), /master requirements refused a high-conflict scope: tests\//);
    await runAutonomyCommand(root, config, 'requirements', ['GY-1', revision, broadScopeFlag, reason], deps);
    assert.match(sent[2].body.reason, /^Broad scope exception \(tests\/\)/); assert.deepEqual(sent[2].body.plannedFiles, ['src/scope.ts', 'tests/']);
    // A worker's scope request for a root directory is refused the same way when the master approves it.
    const requesting = { ...item, lease: { owner: 'worker', epoch: 1, expiresAt: iso(hour) }, scopeRequest: { epoch: 1, paths: ['tests/'], reason: 'needs the tree', requestedBy: 'worker', requestedAt: iso(0), at: iso(0) } } as Work;
    const scopeDeps = { coordinator: async () => ({ work: [requesting], now: iso(0) }), fetcher, operatorToken: async () => 'operator-agent-token-'.padEnd(40, 'o') };
    await assert.rejects(approveScopeRequest(root, config, ['GY-1'], scopeDeps), /master scope refused a high-conflict scope: tests\//);
    await approveScopeRequest(root, config, ['GY-1', broadScopeFlag], scopeDeps);
    assert.match(sent[3].body.reason, /^Broad scope exception \(tests\/\) recorded with --allow-broad-scope: Approve worker's scope request/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('unit:effective-concurrency-reported — master status reports how many items the overlap graph lets run at once beside the idle worker profiles: a fully overlapping graph reports one', () => {
  const credential = '/credentials/worker.token';
  const profiles = Array.from({ length: 11 }, (_, index) => launchProfile(`worker-${index + 1}`, credential));
  // Fourteen items that each claimed a root directory: every pair overlaps.
  const items = [claimed('GY-1', ['src/']), submitted('GY-2', ['tests/'], ['tests/two.test.ts', 'src/master.ts']), ...Array.from({ length: 12 }, (_, index) => work(`GY-${index + 3}`, { plannedFiles: [['src/', 'tests/', 'docs/'][index % 3], 'src/master.ts'] }))];
  const graph = effectiveConcurrency(items, clock);
  assert.equal(graph.effective, 1); assert.equal(graph.nodes, 14); assert.equal(graph.edges, 91); assert.equal(graph.exact, true);
  const status = buildMasterStatus({ work: items, now: iso(0) }, profiles, [], {}, {}, { pending: [], completed: [] });
  assert.equal(status.effectiveConcurrency.effective, 1); assert.equal(status.effectiveConcurrency.idleWorkers, 11); assert.equal(status.effectiveConcurrency.workers, 11);
  assert.equal(status.effectiveConcurrency.inFlight, 2); assert.equal(status.effectiveConcurrency.dispatchable, 12); assert.equal(status.effectiveConcurrency.held, 12);
  assert.equal(status.counts.effectiveConcurrency, 1); assert.equal(status.counts.idleWorkers, 11); assert.equal(status.counts.held, 12);
  assert.match(status.effectiveConcurrency.statement, /^1 item could be in flight at once over 14 open items \(91 overlaps\); 11 of 11 launch profiles idle; 12 held, 0 past the 2h hold bound$/);
  // The same fourteen items with their files named: the graph falls apart and the fleet can use its workers.
  const named = items.map((item, index) => index < 2 ? item : { ...item, plannedFiles: [`web/pages/page-${index}.tsx`] } as Work);
  const open = effectiveConcurrency(named, clock);
  assert.equal(open.effective, 13, 'only GY-1 (src/) and GY-2 (its candidate changed src/master.ts) still exclude each other');
  assert.equal(open.edges, 1); assert.ok(!(open.items.includes('GY-1') && open.items.includes('GY-2')) && open.items.length === 13);
  const busy = buildMasterStatus({ work: named, now: iso(0) }, profiles, [{ name: 'agent-worker-1', agent_status: 'working' }], {}, {}, { pending: [], completed: [] });
  assert.equal(busy.effectiveConcurrency.idleWorkers, 10, 'a profile whose session Herdr reports is not idle');
  assert.equal(busy.effectiveConcurrency.effective, 13);
  // A candidate is a node on its changed files: two directory claims whose candidates changed different files are compatible.
  const candidates = [submitted('GY-x', ['tests/'], ['tests/x.test.ts']), rework('GY-y', ['tests/'], ['tests/y.test.ts']), work('GY-z', { plannedFiles: ['tests/'] })];
  assert.deepEqual(effectiveConcurrency(candidates, clock), { effective: 2, items: ['GY-x', 'GY-y'], nodes: 3, edges: 2, exact: true });
  assert.deepEqual(effectiveConcurrency([], clock), { effective: 0, items: [], nodes: 0, edges: 0, exact: true });
});

test('integration:hold-is-bounded — a hold three deep names its chain, is honoured until the bound, and past it the item dispatches over the overlap with the overlap recorded', async () => {
  // GY-x waits behind GY-b's candidate, which sits third in the merge queue behind GY-c and GY-d: three deep.
  const queued = (key: string, files: string[], sequence: number) => submitted(key, ['src/cli/'], files, 100 * 60_000, { stage: 'merge', queue: { sequence, enqueuedAt: iso(-100 * 60_000) } as any });
  const d = queued('GY-d', ['src/cli/d.ts'], 1), c = queued('GY-c', ['src/cli/c.ts'], 2), b = queued('GY-b', ['src/cli/b.ts'], 3);
  const x = work('GY-x', { plannedFiles: ['src/cli/b.ts'], stageEnteredAt: iso(-90 * 60_000) });
  const all = [d, c, b, x];
  const hold = dispatchHold(x, all, clock)!;
  assert.deepEqual(hold.ahead.map(entry => entry.key), ['GY-b']);
  assert.deepEqual(hold.chain, [{ key: 'GY-b', stage: 'merge', state: 'submitted', position: 3, behind: ['GY-d', 'GY-c'] }, { key: 'GY-d', stage: 'merge', state: 'submitted', position: 1, behind: [] }, { key: 'GY-c', stage: 'merge', state: 'submitted', position: 2, behind: ['GY-d'] }]);
  assert.equal(describeChain(hold.chain), 'GY-b (submitted, merge, merge queue position 3, itself behind GY-d, GY-c) → GY-d (submitted, merge, merge queue position 1) → GY-c (submitted, merge, merge queue position 2, itself behind GY-d)');
  assert.equal(hold.since, iso(-90 * 60_000), 'the hold began when GY-x became dispatchable, the items ahead having been in flight longer');
  assert.equal(hold.ageMs, 90 * 60_000); assert.equal(hold.boundMs, dispatchHoldBoundMs); assert.equal(dispatchHoldBoundMs, 2 * hour); assert.equal(hold.overdue, false);
  const claimedAhead = dispatchHold(x, [claimed('GY-w', ['src/cli/b.ts'], 3 * hour), x], clock)!;
  assert.deepEqual(claimedAhead.chain, [{ key: 'GY-w', stage: 'build', state: 'claimed', position: null, behind: [] }], 'a claimed item waits on nobody but its worker');
  assert.equal(claimedAhead.since, iso(-90 * 60_000));
  // The item ahead moving stage does not restart the hold: GY-v was claimed 3h ago and entered acceptance ten minutes ago,
  // so a hold behind it is counted from its claim, and GY-u, dispatchable for 2.5h, is past the bound.
  const moved = submitted('GY-v', ['src/cli/'], ['src/cli/v.ts'], 3 * hour, { stage: 'acceptance', stageEnteredAt: iso(-10 * 60_000) });
  const u = work('GY-u', { plannedFiles: ['src/cli/v.ts'], stageEnteredAt: iso(-150 * 60_000) });
  const behindMoved = dispatchHold(u, [moved, u], clock)!;
  assert.equal(behindMoved.since, iso(-150 * 60_000), 'the stage the item ahead entered ten minutes ago does not reset the hold');
  assert.equal(behindMoved.overdue, true);
  assert.doesNotThrow(() => assertDispatchable(u, [moved, u], iso(0)));
  assert.equal(dispatchHold(u, [{ ...moved, lastAssignment: undefined } as Work, u], clock)!.since, iso(-10 * 60_000), 'with no claim on record the stage entry stands in');

  // Under the bound the hold stands, naming the chain; a shorter configured bound lifts it.
  assert.throws(() => assertDispatchable(x, all, iso(0)), /held by planned-file overlap with GY-b \(submitted, merge\) on src\/cli\/b\.ts.*Held since 2030-01-01T10:30:00\.000Z \(1\.5h of the 2h bound\); the chain it waits behind: GY-b \(submitted, merge, merge queue position 3, itself behind GY-d, GY-c\) → GY-d \(submitted, merge, merge queue position 1\) → GY-c \(submitted, merge, merge queue position 2, itself behind GY-d\).*--allow-overlap/);
  assert.doesNotThrow(() => assertDispatchable(x, all, iso(0), { holdBoundMs: hour }));
  const before = dispatchSchedule(all, clock);
  assert.deepEqual(before.held.map(entry => entry.key), ['GY-x']); assert.deepEqual(before.overdue, []);
  assert.match(before.held[0].reason, /1\.5h of the 2h bound.*chain it waits behind: GY-b \(submitted, merge, merge queue position 3, itself behind GY-d, GY-c\) → GY-d/);
  assert.equal(before.boundMs, 2 * hour);
  const loop = await daemon(['one', 'two']);
  try {
    loop.set(all);
    await runCycle(loop.master, loop.state, loop.effects, () => clock);
    assert.deepEqual(loop.log, [], 'nothing dispatches over a hold under its bound');

    // Forty minutes later the hold is 2h10m old: past the bound, GY-x is offered over the overlap.
    const later = clock + 40 * 60_000;
    const overdue = dispatchHold(x, all, later)!;
    assert.equal(overdue.overdue, true); assert.equal(overdue.ageMs, 130 * 60_000);
    assert.doesNotThrow(() => assertDispatchable(x, all, iso(40 * 60_000)));
    assert.throws(() => assertDispatchable(x, all, iso(40 * 60_000), { holdBoundMs: 3 * hour }), /held by planned-file overlap/, 'a longer bound still holds');
    const after = dispatchSchedule(all, later);
    assert.deepEqual(after.overdue.map(entry => entry.key), ['GY-x']); assert.deepEqual(after.held, []);
    assert.deepEqual(after.order.map(entry => [entry.key, entry.held, entry.overdue]), [['GY-x', false, true]]);
    assert.match(after.overdue[0].reason, /^Held by planned-file overlap with GY-b \(submitted, merge\) on src\/cli\/b\.ts since 2030-01-01T10:30:00\.000Z \(2\.2h\), past the 2h bound; the chain it waits behind: GY-b .*→ GY-c \(submitted, merge, merge queue position 2, itself behind GY-d\); dispatched over the overlap/);
    // Status raises the overdue hold with its chain while nothing has taken the item, and records the overlap on the row.
    const status = buildMasterStatus({ work: all, now: iso(40 * 60_000) }, [], [], {}, {}, { pending: [], completed: [] });
    const row = status.work.find(entry => entry.key === 'GY-x')!;
    assert.equal(row.overlap.held, false); assert.equal(row.overlap.hold?.overdue, true); assert.deepEqual(row.overlap.ahead.map(entry => entry.key), ['GY-b']);
    assert.match(row.attention!, /^GY-x has been held 2\.2h behind GY-b \(submitted, merge, merge queue position 3, itself behind GY-d, GY-c\) → GY-d \(submitted, merge, merge queue position 1\) → GY-c \(submitted, merge, merge queue position 2, itself behind GY-d\), past the 2h bound; it is offered over the overlap/);
    assert.equal(row.attentionOwner?.role, 'master'); assert.match(row.attentionOwner!.next, /graphyard master dispatch GY-x PROFILE/);
    assert.ok(status.attentionItems.some(entry => entry.subject === 'GY-x' && /past the 2h bound/.test(entry.text)));
    assert.equal(status.counts.holdsOverdue, 1); assert.equal(status.effectiveConcurrency.overdue, 1);
    // The loop dispatches it on the next cycle, and the launcher records the overlap it went over.
    loop.set(all, 40 * 60_000);
    await runCycle(loop.master, loop.state, loop.effects, () => later);
    assert.deepEqual(loop.log, ['GY-x→one'], 'the overdue item is dispatched over the overlap on the loop\'s own');
    const root = await mkdtemp(join(tmpdir(), 'graphyard-hold-bound-')); const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-hold-bound-credentials-'));
    try {
      execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
      const credential = join(credentialDirectory, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
      await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
      const profile: WorkerProfile = { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} };
      const herdr = (_command: string, args: string[]) => startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'p1', tab_id: 't1' }, tab: { tab_id: 't1' } } : {} });
      const prepare = async () => ({ epoch: 1, path: join(root, 'assigned'), base: 'c'.repeat(40) });
      await assert.rejects(dispatchWork(root, x, profile, [], herdr, all, prepare, async () => {}, 1, iso(0)), /held by planned-file overlap/);
      const result = await dispatchWork(root, x, profile, [], herdr, all, prepare, async () => {}, 1, iso(40 * 60_000));
      assert.equal(result.overlap?.allowed, true); assert.equal(result.overlap?.hold.overdue, true); assert.deepEqual(result.overlap?.ahead.map(entry => entry.key), ['GY-b']);
      assert.match(result.overlap?.note ?? '', /^Dispatched over a planned-file overlap with GY-b \(submitted, merge\) on src\/cli\/b\.ts after a hold of 2\.2h, past the 2h bound, behind GY-b \(submitted, merge, merge queue position 3, itself behind GY-d, GY-c\) → GY-d .*→ GY-c \(submitted, merge, merge queue position 2, itself behind GY-d\); expect a sync → review → proof round/);
      const forced = await dispatchWork(root, x, profile, [], herdr, all, prepare, async () => {}, 1, iso(0), { allowOverlap: true });
      assert.match(forced.overlap?.note ?? '', /by operator override; expect a sync/);
    } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
  } finally { await loop.cleanup(); }
});
