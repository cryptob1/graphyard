import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { concurrentOverlap, exclusionPaths } from '../src/coordination.js';
import { dispatchHold } from '../src/model/concerns.js';
import { assertDispatchable, buildMasterStatus, dispatchSchedule, dispatchWork, masterConfigSchema, setupMaster, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Optimistic dispatch: file overlap never holds an item. Holding on overlap (GY-112, then
// bounded, then relaxed for open pull requests in GY-194) still left most of the fleet idle behind
// items changing the same large files; the merge writer's trial and a sync round integrate whichever
// of two overlapping items lands second anyway. Only exclusive resources hold a dispatch.
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const hour = 3_600_000;

function work(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:x'] }],
    policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: iso(-4 * hour), updatedAt: iso(0), stageEnteredAt: iso(-4 * hour),
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides,
  } as Work;
}
/** Claimed `sinceMs` ago with a live lease; no candidate yet, so it excludes on nothing. */
const claimed = (key: string, sinceMs = hour, overrides: Partial<Work> = {}) => work(key, { stage: 'build', epoch: 1, lease: { owner: `${key}-worker`, epoch: 1, expiresAt: iso(10 * hour) },
  lastAssignment: { owner: `${key}-worker`, epoch: 1, claimedAt: iso(-sinceMs) }, ...overrides });
/** Submitted `sinceMs` ago with an observed candidate: `files` is what the candidate actually changed. */
const submitted = (key: string, files: string[], sinceMs = hour, overrides: Partial<Work> = {}) => work(key, { stage: 'review', epoch: 1, submission: { epoch: 1, pr: 7 },
  lastAssignment: { owner: `${key}-worker`, epoch: 1, claimedAt: iso(-sinceMs) },
  candidate: candidateOf(key), observation: { candidate: candidateOf(key), files, at: iso(-60_000), merged: false, prState: 'open', checks: [], reviews: [] } as any, ...overrides });
const candidateOf = (key: string) => ({ sha: key.toLowerCase().padEnd(40, 'f').replace(/[^0-9a-f]/g, 'e'), baseSha: 'b'.repeat(40), pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' });
/** The same item with its pull request not observed open: the observation carries no pull-request state. */
const notOpen = (item: Work) => ({ ...item, observation: { ...item.observation!, prState: undefined } }) as Work;
/** Submitted, then sent back for rework: dispatchable again, a peer of the ready items rather than ahead of anything. */
const rework = (key: string, files: string[], sinceMs = hour, overrides: Partial<Work> = {}) => submitted(key, files, sinceMs, { reworkRequested: true, stageEnteredAt: iso(-sinceMs), ...overrides });

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
 observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, persist: async () => {},
  };
  return { master, effects, log, state: emptyDaemonState(master), set: (items: Work[], atMs = 0) => { snapshotWork = items; offsetMs = atMs; }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('unit:optimistic-dispatch — two items overlapping on the same files both dispatch, beside items in flight on those files; the overlap is recorded, never held on', async () => {
  const file = 'src/master-daemon.ts';
  const building = claimed('GY-184', 5 * 60_000);
  const building2 = claimed('GY-185', 5 * 60_000);
  const inReview = notOpen(submitted('GY-166', [file]));
  // Sent back for rework, its candidate changed the same file as the one in review.
  const first = rework('GY-190', [file], 10 * 60_000);
  const second = work('GY-191', { createdAt: iso(-2 * hour), stageEnteredAt: iso(-30 * 60_000) });
  const all = [building, building2, inReview, first, second];
  for (const item of [first, second]) assert.doesNotThrow(() => assertDispatchable(item, all, iso(0)), `${item.key} is dispatchable whatever it overlaps`);
  assert.equal(dispatchHold(first, all, new Date(clock)), null, 'the concern layer holds nothing for overlap either');
  const schedule = dispatchSchedule(all, clock);
  assert.deepEqual(schedule.order.map(entry => entry.key), ['GY-190', 'GY-191'], 'both are offered');
  assert.deepEqual(Object.keys(schedule), ['order'], 'the schedule carries no holds');
  // The overlap is reported, for the record: the in-flight items whose candidates touch the same files.
  assert.deepEqual(concurrentOverlap(first, all, clock).map(entry => [entry.key, entry.state, entry.paths]), [['GY-166', 'submitted', [file]]]);
  assert.deepEqual(concurrentOverlap(first, [first, second], clock), [], 'two dispatchable peers are not in flight');
  assert.deepEqual(exclusionPaths(inReview), [file], 'a candidate is reported on its observed diff');

  // The durable loop dispatches both in one cycle. The snapshot omits one claimed item (GY-185) so
  // the in-flight count stays under the cap (GY-2097): the two ready items are the 3rd and 4th in
  // flight, and the cap holds nothing here.
  const loop = await daemon(['one', 'two', 'three']);
  try {
    loop.set([building, inReview, first, second]);
    await runCycle(loop.master, loop.state, loop.effects, () => clock);
    assert.deepEqual(loop.log, ['GY-190→one', 'GY-191→two'], 'overlapping items are dispatched together, never held');
  } finally { await loop.cleanup(); }

  // Master status records what each item runs beside and counts every open item as runnable at once.
  const profiles = ['one', 'two', 'three'].map(name => launchProfile(name, '/credentials/worker.token'));
  const status = buildMasterStatus({ work: all, now: iso(0) }, profiles, [], {}, { pending: [], completed: [] });
  const row = status.work.find(entry => entry.key === 'GY-190')!;
  assert.deepEqual(row.overlap.concurrent.map(entry => entry.key), ['GY-166']);
  assert.equal(row.attention, null, 'an overlap raises no attention');
  assert.equal(status.effectiveConcurrency.effective, 5); assert.equal(status.effectiveConcurrency.inFlight, 3); assert.equal(status.effectiveConcurrency.dispatchable, 2);
  assert.equal(status.counts.effectiveConcurrency, 5);
  assert.match(status.effectiveConcurrency.statement, /^5 items could be in flight at once \(3 in flight, 2 dispatchable; file overlap holds nothing\); 3 of 3 launch profiles idle; the dispatcher starts new work while fewer than 4 items are in flight$/);
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
    const result = await dispatchWork(root, first, profile, [], herdr, all, prepare, async () => {}, 1, iso(0), { readDecisions: async () => [] });
    assert.deepEqual(result.overlap?.concurrent.map(entry => entry.key), ['GY-166']);
    assert.match(result.overlap?.note ?? '', /^Dispatched beside GY-166 \(submitted, review\) on src\/master-daemon\.ts; .*whichever lands second is re-integrated/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});

test('unit:exclusive-resources-hold — an exclusive resource still holds dispatch where file overlap does not', async () => {
  const holder = claimed('GY-200', 5 * 60_000, { exclusiveResources: ['staging-db'] });
  const wants = work('GY-201', { exclusiveResources: ['staging-db'] });
  const overlapping = work('GY-202');
  const all = [holder, wants, overlapping];
  assert.throws(() => assertDispatchable(wants, all, iso(0)), /Dispatch blocked by exclusive resources: staging-db held by GY-200/);
  assert.equal(dispatchHold(wants, all, new Date(clock)), 'exclusive resources are held by GY-200 (staging-db)');
  assert.doesNotThrow(() => assertDispatchable(overlapping, all, iso(0)));
  const loop = await daemon(['one', 'two']);
  try {
    loop.set(all);
    await runCycle(loop.master, loop.state, loop.effects, () => clock);
    assert.deepEqual(loop.log, ['GY-202→one'], 'the resource holds GY-201, nothing else');
  } finally { await loop.cleanup(); }
});
