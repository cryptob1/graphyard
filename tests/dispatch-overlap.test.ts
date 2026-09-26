import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { broadScopeRefusals, concurrentOverlap, exclusionPaths } from '../src/coordination.js';
import { dispatchHold } from '../src/model/concerns.js';
import { assertDispatchable, broadScopeFlag, buildMasterStatus, dispatchSchedule, dispatchWork, guardBroadScope, masterConfigSchema, runAutonomyCommand, setupMaster, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { approveScopeRequest } from '../src/cli/master-status.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Optimistic dispatch: planned-file overlap never holds an item. Holding on overlap (GY-112, then
// bounded, then relaxed for open pull requests in GY-194) still left most of the fleet idle behind
// items changing the same large files; the merge queue and a sync round integrate whichever of two
// overlapping items lands second anyway. Only exclusive resources hold a dispatch. `plannedFiles`
// remains the submission-time change-scope contract, and a root-level directory scope is still
// refused where planned files are set, or recorded as an explicit exception.
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
  const directory = await temporaryDirectory('dispatch-overlap');
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
  const root = await temporaryDirectory('broad-scope'); const credentialDirectory = await temporaryDirectory('broad-scope-credentials');
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

test('unit:optimistic-dispatch — two items overlapping on the same files both dispatch, beside a claimed item on those files; the overlap is recorded, never held on', async () => {
  const file = 'src/master-daemon.ts';
  const building = claimed('GY-184', [file, 'tests/master-daemon.test.ts'], 5 * 60_000);
  const building2 = claimed('GY-185', ['src/'], 5 * 60_000);
  const inReview = notOpen(submitted('GY-166', [file], [file]));
  const first = work('GY-190', { plannedFiles: [file], createdAt: iso(-3 * hour), stageEnteredAt: iso(-10 * 60_000) });
  const second = work('GY-191', { plannedFiles: [file, 'docs/coordination.md'], createdAt: iso(-2 * hour) });
  const all = [building, building2, inReview, first, second];
  for (const item of [first, second]) assert.doesNotThrow(() => assertDispatchable(item, all, iso(0)), `${item.key} is dispatchable whatever it overlaps`);
  assert.equal(dispatchHold(first, all, new Date(clock)), null, 'the concern layer holds nothing for overlap either');
  const schedule = dispatchSchedule(all, clock);
  assert.deepEqual(schedule.order.map(entry => entry.key), ['GY-190', 'GY-191'], 'both are offered, smallest scope first');
  assert.deepEqual(Object.keys(schedule).sort(), ['highConflict', 'order'], 'the schedule carries no holds');
  // The overlap is reported, for the record: the in-flight items touching the same files.
  assert.deepEqual(concurrentOverlap(first, all, clock).map(entry => [entry.key, entry.state, entry.paths]), [['GY-184', 'claimed', [file]], ['GY-185', 'claimed', [file]], ['GY-166', 'submitted', [file]]]);
  assert.deepEqual(concurrentOverlap(first, [first, second], clock), [], 'two ready peers are not in flight');
  assert.deepEqual(exclusionPaths(inReview), [file], 'a candidate is reported on its observed diff');

  // The durable loop dispatches both in one cycle.
  const loop = await daemon(['one', 'two', 'three']);
  try {
    loop.set(all);
    await runCycle(loop.master, loop.state, loop.effects, () => clock);
    assert.deepEqual(loop.log, ['GY-190→one', 'GY-191→two'], 'overlapping items are dispatched together, never held');
  } finally { await loop.cleanup(); }

  // Master status records what each item runs beside and counts every open item as runnable at once.
  const profiles = ['one', 'two', 'three'].map(name => launchProfile(name, '/credentials/worker.token'));
  const status = buildMasterStatus({ work: all, now: iso(0) }, profiles, [], {}, {}, { pending: [], completed: [] });
  const row = status.work.find(entry => entry.key === 'GY-190')!;
  assert.deepEqual(row.overlap.concurrent.map(entry => entry.key), ['GY-184', 'GY-185', 'GY-166']);
  assert.equal(row.attention, null, 'an overlap raises no attention');
  assert.equal(status.effectiveConcurrency.effective, 5); assert.equal(status.effectiveConcurrency.inFlight, 3); assert.equal(status.effectiveConcurrency.dispatchable, 2);
  assert.equal(status.counts.effectiveConcurrency, 5);
  assert.match(status.effectiveConcurrency.statement, /^5 items could be in flight at once \(3 in flight, 2 dispatchable; planned-file overlap holds nothing\); 3 of 3 launch profiles idle$/);
  assert.ok(!('held' in status.counts) && !('holdsOverdue' in status.counts));

  // The launcher dispatches over the overlap without any override, and records it.
  const root = await temporaryDirectory('optimistic'); const credentialDirectory = await temporaryDirectory('optimistic-credentials');
  try {
    execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    const credential = join(credentialDirectory, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
    await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
    const profile: WorkerProfile = { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} };
    const herdr = (_command: string, args: string[]) => startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'p1', tab_id: 't1' }, tab: { tab_id: 't1' } } : {} });
    const prepare = async () => ({ epoch: 1, path: join(root, 'assigned'), base: 'c'.repeat(40) });
    const result = await dispatchWork(root, first, profile, [], herdr, all, prepare, async () => {}, 1, iso(0));
    assert.deepEqual(result.overlap?.concurrent.map(entry => entry.key), ['GY-184', 'GY-185', 'GY-166']);
    assert.match(result.overlap?.note ?? '', /^Dispatched beside GY-184 \(claimed, build\) on src\/master-daemon\.ts; .*whichever lands second is re-integrated/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('unit:exclusive-resources-hold — an exclusive resource still holds dispatch where planned-file overlap does not', async () => {
  const holder = claimed('GY-200', ['web/pages/a.tsx'], 5 * 60_000, { exclusiveResources: ['staging-db'] });
  const wants = work('GY-201', { plannedFiles: ['docs/coordination.md'], exclusiveResources: ['staging-db'] });
  const overlapping = work('GY-202', { plannedFiles: ['web/pages/a.tsx'] });
  const all = [holder, wants, overlapping];
  assert.throws(() => assertDispatchable(wants, all, iso(0)), /Dispatch blocked by exclusive resources: staging-db held by GY-200/);
  assert.equal(dispatchHold(wants, all, new Date(clock)), 'exclusive resources are held by GY-200 (staging-db)');
  assert.doesNotThrow(() => assertDispatchable(overlapping, all, iso(0)));
  const loop = await daemon(['one', 'two']);
  try {
    loop.set(all);
    await runCycle(loop.master, loop.state, loop.effects, () => clock);
    assert.deepEqual(loop.log, ['GY-202→one'], 'the resource holds GY-201; the file overlap holds nothing');
  } finally { await loop.cleanup(); }
});
