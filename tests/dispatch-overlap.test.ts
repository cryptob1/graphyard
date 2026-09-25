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
  candidate: candidateOf(key), observation: { candidate: candidateOf(key), files, at: iso(-60_000), merged: false, prState: 'open', checks: [], reviews: [] } as any, ...overrides });
const candidateOf = (key: string) => ({ sha: key.toLowerCase().padEnd(40, 'f').replace(/[^0-9a-f]/g, 'e'), baseSha: 'b'.repeat(40), pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' });
/** The same item with its pull request not observed open: the observation carries no pull-request state. */
const notOpen = (item: Work) => ({ ...item, observation: { ...item.observation!, prState: undefined } }) as Work;
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

test('integration:overlap-uses-changed-files — once an item has a candidate it excludes others on the files that candidate changed, not on the directory it declared; an item whose own pull request is open is never held', async () => {
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
  // GY-c's pull request is open: holding its rework round prevents no conflict (both changes exist; the merge queue integrates whichever lands second), so it is never held.
  assert.deepEqual(dispatchOverlap(sameFile, all, clock), []);
  assert.doesNotThrow(() => assertDispatchable(sameFile, all, iso(0)));
  // A ready item that named its file is not held by a candidate that changed a different file under the same root; one that claimed the root still is.
  assert.deepEqual(dispatchOverlap(narrow, all, clock), []);
  // GY-a's pull request is open too, so it holds nothing (GY-194): even the fresh directory claim GY-e is not held behind it.
  assert.deepEqual(dispatchOverlap(directory, all, clock), [], 'the reworked GY-b and GY-c are peers waiting for a worker, and GY-a\'s open pull request is ordered by the merge queue');

  // The durable loop dispatches all four in one cycle, smallest scope first.
  const loop = await daemon(['one', 'two', 'three', 'four']);
  try {
    loop.set(all);
    await runCycle(loop.master, loop.state, loop.effects, () => clock);
    assert.deepEqual(loop.log, ['GY-d→one', 'GY-b→two', 'GY-c→three', 'GY-e→four'], 'the file-scoped item is offered first, then the directory claims; nothing is held behind an open pull request');
    assert.deepEqual(dispatchSchedule(all, clock).held, []);
  } finally { await loop.cleanup(); }

  // GY-a's pull request was closed and it is claimed again for rework: it is being built without an open
  // pull request, and it excludes on the file its candidate changed, not on the tests/ it declared.
  const reclaimed = { ...landed, observation: { ...landed.observation!, prState: 'closed' }, lease: { owner: 'GY-a-worker', epoch: 2, expiresAt: iso(hour) }, lastAssignment: { owner: 'GY-a-worker', epoch: 2, claimedAt: iso(-5 * 60_000) } } as Work;
  const again = [reclaimed, narrow, directory];
  assert.deepEqual(dispatchOverlap(narrow, again, clock), [], 'a named file under the same root is no conflict with the file the candidate changed');
  assert.deepEqual(dispatchOverlap(directory, again, clock).map(entry => [entry.key, entry.state, entry.paths, entry.theirs]), [['GY-a', 'claimed', ['tests/'], ['tests/a.test.ts']]]);
  assert.deepEqual(dispatchSchedule(again, clock).held.map(entry => [entry.key, entry.ahead.map(item => item.key)]), [['GY-e', ['GY-a']]]);
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

test('unit:effective-concurrency-reported — master status reports how many items the overlap graph lets run at once beside the idle worker profiles: a fully overlapping graph of fresh items reports one, plus any open pull request', () => {
  const credential = '/credentials/worker.token';
  const profiles = Array.from({ length: 11 }, (_, index) => launchProfile(`worker-${index + 1}`, credential));
  // Fourteen items that each claimed a root directory: every pair of fresh items overlaps. GY-2's pull
  // request is open, so nothing holds it and it excludes nobody: the graph admits it beside one other.
  const items = [claimed('GY-1', ['src/', 'src/master.ts'], 10 * 60_000), submitted('GY-2', ['tests/'], ['tests/two.test.ts', 'src/master.ts']), ...Array.from({ length: 12 }, (_, index) => work(`GY-${index + 3}`, { plannedFiles: [['src/', 'tests/', 'docs/'][index % 3], 'src/master.ts'] }))];
  const graph = effectiveConcurrency(items, clock);
  assert.equal(graph.effective, 2); assert.equal(graph.nodes, 14); assert.equal(graph.edges, 78); assert.equal(graph.exact, true);
  const status = buildMasterStatus({ work: items, now: iso(0) }, profiles, [], {}, {}, { pending: [], completed: [] });
  assert.equal(status.effectiveConcurrency.effective, 2); assert.equal(status.effectiveConcurrency.idleWorkers, 11); assert.equal(status.effectiveConcurrency.workers, 11);
  assert.equal(status.effectiveConcurrency.inFlight, 2); assert.equal(status.effectiveConcurrency.dispatchable, 12); assert.equal(status.effectiveConcurrency.held, 12);
  assert.equal(status.counts.effectiveConcurrency, 2); assert.equal(status.counts.idleWorkers, 11); assert.equal(status.counts.held, 12);
  assert.match(status.effectiveConcurrency.statement, /^2 items could be in flight at once over 14 open items \(78 overlaps\); 11 of 11 launch profiles idle; 12 held, 0 past the 0\.5h hold bound$/);
  // The same fourteen items with their files named: the graph falls apart and the fleet can use its workers.
  const named = items.map((item, index) => index < 2 ? item : { ...item, plannedFiles: [`web/pages/page-${index}.tsx`] } as Work);
  const open = effectiveConcurrency(named, clock);
  // GY-1 (src/) and GY-2 no longer exclude each other: GY-2's pull request is open, so it is never held.
  assert.equal(open.effective, 14); assert.equal(open.edges, 0);
  const busy = buildMasterStatus({ work: named, now: iso(0) }, profiles, [{ name: 'agent-worker-1', agent_status: 'working' }], {}, {}, { pending: [], completed: [] });
  assert.equal(busy.effectiveConcurrency.idleWorkers, 10, 'a profile whose session Herdr reports is not idle');
  assert.equal(busy.effectiveConcurrency.effective, 14);
  // A candidate is a node on its changed files: two directory claims whose candidates changed different files are compatible.
  const candidates = [submitted('GY-x', ['tests/'], ['tests/x.test.ts']), rework('GY-y', ['tests/'], ['tests/y.test.ts']), work('GY-z', { plannedFiles: ['tests/'] })];
  // GY-z's declared tests/ holds neither open candidate either, so all three may be in flight at once;
  // naming a file one of them changed does not make the pair exclusive: the open candidate is never held.
  assert.deepEqual(effectiveConcurrency(candidates, clock), { effective: 3, items: ['GY-x', 'GY-y', 'GY-z'], nodes: 3, edges: 0, exact: true });
  candidates[2] = work('GY-z', { plannedFiles: ['tests/', 'tests/x.test.ts'] });
  const exclusive = effectiveConcurrency(candidates, clock);
  assert.equal(exclusive.effective, 3); assert.equal(exclusive.edges, 0);
  assert.deepEqual(effectiveConcurrency([], clock), { effective: 0, items: [], nodes: 0, edges: 0, exact: true });
});

test('integration:hold-is-bounded — a hold three deep names its chain, is honoured until the bound, and past it the item dispatches over the overlap with the overlap recorded', async () => {
  // GY-x waits behind GY-b's candidate, which sits third in the merge queue behind GY-c and GY-d: three deep.
  // Their pull requests are not observed open (the last observation carries no pull-request state), so
  // they still hold: an item whose pull request is observed open holds nothing (GY-194).
  const queued = (key: string, files: string[], sequence: number) => notOpen(submitted(key, ['src/cli/'], files, 100 * 60_000, { stage: 'merge', queue: { sequence, enqueuedAt: iso(-100 * 60_000) } as any }));
  const d = queued('GY-d', ['src/cli/d.ts'], 1), c = queued('GY-c', ['src/cli/c.ts'], 2), b = queued('GY-b', ['src/cli/b.ts'], 3);
  const x = work('GY-x', { plannedFiles: ['src/cli/b.ts'], stageEnteredAt: iso(-20 * 60_000) });
  const all = [d, c, b, x];
  const hold = dispatchHold(x, all, clock)!;
  assert.deepEqual(hold.ahead.map(entry => entry.key), ['GY-b']);
  assert.deepEqual(hold.chain, [{ key: 'GY-b', stage: 'merge', state: 'submitted', position: 3, behind: ['GY-d', 'GY-c'] }, { key: 'GY-d', stage: 'merge', state: 'submitted', position: 1, behind: [] }, { key: 'GY-c', stage: 'merge', state: 'submitted', position: 2, behind: ['GY-d'] }]);
  assert.equal(describeChain(hold.chain), 'GY-b (submitted, merge, merge queue position 3, itself behind GY-d, GY-c) → GY-d (submitted, merge, merge queue position 1) → GY-c (submitted, merge, merge queue position 2, itself behind GY-d)');
  assert.equal(hold.since, iso(-20 * 60_000), 'the hold began when GY-x became dispatchable, the items ahead having been in flight longer');
  assert.equal(hold.ageMs, 20 * 60_000); assert.equal(hold.boundMs, dispatchHoldBoundMs); assert.equal(dispatchHoldBoundMs, 30 * 60_000); assert.equal(hold.overdue, false);
  const claimedAhead = dispatchHold(x, [claimed('GY-w', ['src/cli/b.ts'], 3 * hour), x], clock)!;
  assert.deepEqual(claimedAhead.chain, [{ key: 'GY-w', stage: 'build', state: 'claimed', position: null, behind: [] }], 'a claimed item waits on nobody but its worker');
  assert.equal(claimedAhead.since, iso(-20 * 60_000));
  // The item ahead moving stage does not restart the hold: GY-v was claimed 3h ago and entered acceptance ten minutes ago,
  // so a hold behind it is counted from its claim, and GY-u, dispatchable for 45 minutes, is past the bound.
  const moved = notOpen(submitted('GY-v', ['src/cli/'], ['src/cli/v.ts'], 3 * hour, { stage: 'acceptance', stageEnteredAt: iso(-10 * 60_000) }));
  const u = work('GY-u', { plannedFiles: ['src/cli/v.ts'], stageEnteredAt: iso(-45 * 60_000) });
  const behindMoved = dispatchHold(u, [moved, u], clock)!;
  assert.equal(behindMoved.since, iso(-45 * 60_000), 'the stage the item ahead entered ten minutes ago does not reset the hold');
  assert.equal(behindMoved.overdue, true);
  assert.doesNotThrow(() => assertDispatchable(u, [moved, u], iso(0)));
  assert.equal(dispatchHold(u, [{ ...moved, lastAssignment: undefined } as Work, u], clock)!.since, iso(-10 * 60_000), 'with no claim on record the stage entry stands in');

  // Under the bound the hold stands, naming the chain; a shorter configured bound lifts it.
  assert.throws(() => assertDispatchable(x, all, iso(0)), /held by planned-file overlap with GY-b \(submitted, merge\) on src\/cli\/b\.ts.*Held since 2030-01-01T11:40:00\.000Z \(0\.3h of the 0\.5h bound\); the chain it waits behind: GY-b \(submitted, merge, merge queue position 3, itself behind GY-d, GY-c\) → GY-d \(submitted, merge, merge queue position 1\) → GY-c \(submitted, merge, merge queue position 2, itself behind GY-d\).*--allow-overlap/);
  assert.doesNotThrow(() => assertDispatchable(x, all, iso(0), { holdBoundMs: 10 * 60_000 }));
  const before = dispatchSchedule(all, clock);
  assert.deepEqual(before.held.map(entry => entry.key), ['GY-x']); assert.deepEqual(before.overdue, []);
  assert.match(before.held[0].reason, /0\.3h of the 0\.5h bound.*chain it waits behind: GY-b \(submitted, merge, merge queue position 3, itself behind GY-d, GY-c\) → GY-d/);
  assert.equal(before.boundMs, 30 * 60_000);
  const loop = await daemon(['one', 'two']);
  try {
    loop.set(all);
    await runCycle(loop.master, loop.state, loop.effects, () => clock);
    assert.deepEqual(loop.log, [], 'nothing dispatches over a hold under its bound');

    // Fifteen minutes later the hold is 35 minutes old: past the bound, GY-x is offered over the overlap.
    const later = clock + 15 * 60_000;
    const overdue = dispatchHold(x, all, later)!;
    assert.equal(overdue.overdue, true); assert.equal(overdue.ageMs, 35 * 60_000);
    assert.doesNotThrow(() => assertDispatchable(x, all, iso(15 * 60_000)));
    assert.throws(() => assertDispatchable(x, all, iso(15 * 60_000), { holdBoundMs: 3 * hour }), /held by planned-file overlap/, 'a longer bound still holds');
    const after = dispatchSchedule(all, later);
    assert.deepEqual(after.overdue.map(entry => entry.key), ['GY-x']); assert.deepEqual(after.held, []);
    assert.deepEqual(after.order.map(entry => [entry.key, entry.held, entry.overdue]), [['GY-x', false, true]]);
    assert.match(after.overdue[0].reason, /^Held by planned-file overlap with GY-b \(submitted, merge\) on src\/cli\/b\.ts since 2030-01-01T11:40:00\.000Z \(0\.6h\), past the 0\.5h bound; the chain it waits behind: GY-b .*→ GY-c \(submitted, merge, merge queue position 2, itself behind GY-d\); dispatched over the overlap/);
    // Status raises the overdue hold with its chain while nothing has taken the item, and records the overlap on the row.
    const status = buildMasterStatus({ work: all, now: iso(15 * 60_000) }, [], [], {}, {}, { pending: [], completed: [] });
    const row = status.work.find(entry => entry.key === 'GY-x')!;
    assert.equal(row.overlap.held, false); assert.equal(row.overlap.hold?.overdue, true); assert.deepEqual(row.overlap.ahead.map(entry => entry.key), ['GY-b']);
    assert.match(row.attention!, /^GY-x has been held 0\.6h behind GY-b \(submitted, merge, merge queue position 3, itself behind GY-d, GY-c\) → GY-d \(submitted, merge, merge queue position 1\) → GY-c \(submitted, merge, merge queue position 2, itself behind GY-d\), past the 0\.5h bound; it is offered over the overlap/);
    assert.equal(row.attentionOwner?.role, 'master'); assert.match(row.attentionOwner!.next, /graphyard master dispatch GY-x PROFILE/);
    assert.ok(status.attentionItems.some(entry => entry.subject === 'GY-x' && /past the 0\.5h bound/.test(entry.text)));
    assert.equal(status.counts.holdsOverdue, 1); assert.equal(status.effectiveConcurrency.overdue, 1);
    // The loop dispatches it on the next cycle, and the launcher records the overlap it went over.
    loop.set(all, 15 * 60_000);
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
      const result = await dispatchWork(root, x, profile, [], herdr, all, prepare, async () => {}, 1, iso(15 * 60_000));
      assert.equal(result.overlap?.allowed, true); assert.equal(result.overlap?.hold.overdue, true); assert.deepEqual(result.overlap?.ahead.map(entry => entry.key), ['GY-b']);
      assert.match(result.overlap?.note ?? '', /^Dispatched over a planned-file overlap with GY-b \(submitted, merge\) on src\/cli\/b\.ts after a hold of 0\.6h, past the 0\.5h bound, behind GY-b \(submitted, merge, merge queue position 3, itself behind GY-d, GY-c\) → GY-d .*→ GY-c \(submitted, merge, merge queue position 2, itself behind GY-d\); expect a sync → review → proof round/);
      const forced = await dispatchWork(root, x, profile, [], herdr, all, prepare, async () => {}, 1, iso(0), { allowOverlap: true });
      assert.match(forced.overlap?.note ?? '', /by operator override; expect a sync/);
    } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
  } finally { await loop.cleanup(); }
});

// GY-194: on 2026-09-25 ten ready items were held and five workers idle, every hold behind items whose
// pull requests were already open on the same large files. Once an item's pull request is open its
// change exists and the merge queue orders the two; only work still being built without one holds.
test('unit:no-hold-behind-open-pr — a fresh item is not held behind an overlapping item whose pull request is open, whatever its stage, and is held behind an overlapping claimed item with no pull request', () => {
  const hotspot = 'src/master-daemon.ts';
  const fresh = work('GY-192', { plannedFiles: [hotspot, 'tests/master-daemon.test.ts'], stageEnteredAt: iso(-10 * 60_000) });
  const inReview = submitted('GY-166', [hotspot], [hotspot], hour, { stage: 'review' });
  assert.deepEqual(dispatchOverlap(fresh, [inReview, fresh], clock), [], 'an overlapping item in review with an open pull request holds nothing');
  assert.equal(dispatchHold(fresh, [inReview, fresh], clock), null);
  assert.doesNotThrow(() => assertDispatchable(fresh, [inReview, fresh], iso(0)));
  // Whatever the stage the open pull request stands in — and even when its rework round is claimed again.
  for (const stage of ['test', 'acceptance', 'merge'] as const) assert.deepEqual(dispatchOverlap(fresh, [submitted('GY-182', [hotspot], [hotspot], hour, { stage }), fresh], clock), [], stage);
  const reclaimed = submitted('GY-185', [hotspot], [hotspot], hour, { stage: 'build', reworkRequested: true, lease: { owner: 'GY-185-worker', epoch: 2, expiresAt: iso(hour) } });
  assert.deepEqual(dispatchOverlap(fresh, [reclaimed, fresh], clock), [], 'a claimed rework round whose pull request is open holds nothing');
  // An overlapping item still being built, with no pull request, holds it.
  const building = claimed('GY-184', [hotspot], 5 * 60_000);
  assert.deepEqual(dispatchOverlap(fresh, [inReview, building, fresh], clock).map(entry => [entry.key, entry.state, entry.paths]), [['GY-184', 'claimed', [hotspot]]]);
  assert.throws(() => assertDispatchable(fresh, [inReview, building, fresh], iso(0)), /held by planned-file overlap with GY-184 \(claimed, build\) on src\/master-daemon\.ts/);
  assert.deepEqual(dispatchSchedule([inReview, building, fresh], clock).held.map(entry => [entry.key, entry.ahead.map(item => item.key)]), [['GY-192', ['GY-184']]]);
  // A pull request that was closed is no longer open, but until someone claims the item again nobody
  // is building it and its candidate cannot enter the merge queue: it holds nothing. Reclaimed, it is
  // being built without an open pull request and holds again on the files its candidate changed.
  const closed = { ...inReview, observation: { ...inReview.observation!, prState: 'closed' } } as Work;
  assert.deepEqual(dispatchOverlap(fresh, [closed, fresh], clock), [], 'a closed, unclaimed candidate is not being built');
  assert.equal(dispatchHold(fresh, [closed, fresh], clock), null);
  const closedReclaimed = { ...closed, lease: { owner: 'GY-166-worker', epoch: 2, expiresAt: iso(hour) }, lastAssignment: { owner: 'GY-166-worker', epoch: 2, claimedAt: iso(-5 * 60_000) } } as Work;
  assert.deepEqual(dispatchOverlap(fresh, [closedReclaimed, fresh], clock).map(entry => [entry.key, entry.state, entry.paths]), [['GY-166', 'claimed', [hotspot]]]);
  assert.equal(effectiveConcurrency([closed, fresh], clock).effective, 2, 'nor does it count against capacity');
  assert.equal(effectiveConcurrency([closedReclaimed, fresh], clock).effective, 1);
});

test('unit:hold-bound-30m — a dispatch hold lasts at most 30 minutes; past it the hold is overdue and the item is offered a worker over the overlap', async () => {
  assert.equal(dispatchHoldBoundMs, 30 * 60_000);
  const building = claimed('GY-184', ['src/master.ts'], 2 * hour);
  const fresh = work('GY-190', { plannedFiles: ['src/master.ts'], stageEnteredAt: iso(-29 * 60_000) });
  const all = [building, fresh];
  const under = dispatchHold(fresh, all, clock)!;
  assert.equal(under.ageMs, 29 * 60_000); assert.equal(under.boundMs, 30 * 60_000); assert.equal(under.overdue, false);
  assert.throws(() => assertDispatchable(fresh, all, iso(0)), /held by planned-file overlap with GY-184.*of the 0\.5h bound/);
  const later = clock + 2 * 60_000;
  const past = dispatchHold(fresh, all, later)!;
  assert.equal(past.ageMs, 31 * 60_000); assert.equal(past.overdue, true);
  assert.doesNotThrow(() => assertDispatchable(fresh, all, iso(2 * 60_000)));
  assert.deepEqual(dispatchSchedule(all, later).overdue.map(entry => entry.key), ['GY-190']);
  const loop = await daemon(['one']);
  try {
    loop.set(all);
    await runCycle(loop.master, loop.state, loop.effects, () => clock);
    assert.deepEqual(loop.log, [], 'under the bound the hold stands');
    loop.set(all, 2 * 60_000);
    await runCycle(loop.master, loop.state, loop.effects, () => later);
    assert.deepEqual(loop.log, ['GY-190→one'], 'a hold older than 30 minutes is overdue and the item is offered a worker');
  } finally { await loop.cleanup(); }
});

test('unit:concurrency-counts-open-prs — two items exclude each other only while one is being built without a pull request: three items in review on the same file and one fresh item have an effective concurrency of 4', () => {
  const file = 'src/master.ts';
  const reviews = ['GY-166', 'GY-182', 'GY-187'].map(key => submitted(key, [file], [file], hour, { stage: 'review' }));
  // Dispatchable five minutes ago, well inside the 30-minute bound: were an open pull request ahead to hold it, status would count it held.
  const fresh = work('GY-191', { plannedFiles: [file], stageEnteredAt: iso(-5 * 60_000) });
  const items = [...reviews, fresh];
  assert.deepEqual(effectiveConcurrency(items, clock), { effective: 4, items: ['GY-166', 'GY-182', 'GY-187', 'GY-191'], nodes: 4, edges: 0, exact: true });
  const status = buildMasterStatus({ work: items, now: iso(0) }, [], [], {}, {}, { pending: [], completed: [] });
  assert.equal(status.effectiveConcurrency.effective, 4); assert.equal(status.counts.effectiveConcurrency, 4);
  assert.equal(status.effectiveConcurrency.dispatchable, 1); assert.equal(status.effectiveConcurrency.held, 0, 'the fresh item is not held behind the three open pull requests');
  assert.equal(status.counts.held, 0); assert.equal(status.effectiveConcurrency.overdue, 0, 'nor is it counted as an overdue hold');
  const row = status.work.find(entry => entry.key === 'GY-191')!;
  assert.equal(row.overlap.held, false); assert.deepEqual(row.overlap.ahead, []); assert.equal(row.overlap.hold, null);
  assert.match(status.effectiveConcurrency.statement, /^4 items could be in flight at once over 4 open items \(0 overlaps\); .*; 0 held, 0 past the 0\.5h hold bound$/);
  // Built without a pull request, the same three exclude each other and the fresh item: one at a time.
  const building = ['GY-184', 'GY-189', 'GY-190'].map(key => claimed(key, [file], 5 * 60_000));
  const serial = effectiveConcurrency([...building, fresh], clock);
  assert.equal(serial.effective, 1); assert.equal(serial.edges, 6);
  assert.equal(buildMasterStatus({ work: [...building, fresh], now: iso(0) }, [], [], {}, {}, { pending: [], completed: [] }).effectiveConcurrency.effective, 1);
  // Held past the 30-minute bound, the fresh items dispatch over the overlap, so they exclude nobody:
  // three same-file items held 31 minutes behind one being built report the full count, as the daemon launches them all.
  const heldFor = (minutes: number) => [claimed('GY-184', [file], 2 * hour), ...['GY-190', 'GY-191', 'GY-192'].map(key => work(key, { plannedFiles: [file], stageEnteredAt: iso(-minutes * 60_000) }))];
  const within = effectiveConcurrency(heldFor(29), clock);
  assert.equal(within.effective, 1); assert.equal(within.edges, 6);
  assert.deepEqual(effectiveConcurrency(heldFor(31), clock), { effective: 4, items: ['GY-184', 'GY-190', 'GY-191', 'GY-192'], nodes: 4, edges: 0, exact: true });
  const overdue = buildMasterStatus({ work: heldFor(31), now: iso(0) }, [], [], {}, {}, { pending: [], completed: [] });
  assert.equal(overdue.effectiveConcurrency.effective, 4); assert.equal(overdue.effectiveConcurrency.overdue, 3);
  assert.deepEqual(dispatchSchedule(heldFor(31), clock).overdue.map(entry => entry.key).sort(), ['GY-190', 'GY-191', 'GY-192']);
});
