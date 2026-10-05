import { test } from 'node:test';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchOrder, dispatchSort, dispatchStarvationMs, stageWaitMs } from '../src/coordination.js';
import { hotBeside, hotFileSet, hotspots } from '../src/daemon/hotspots.js';
import { dispatchKey } from '../src/daemon/reconcile.js';
import { dispatchSchedule, masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { Work } from '../src/model.js';

// GY-882: hot-spot-aware scheduling. Dispatch stays optimistic — planned-file overlap never holds
// an item — but within one operator priority an item that touches no file two or more live
// attempts are already changing is offered before one that does, and every ready item still
// dispatches in the same cycle. Heat comes from in-flight items only, over their declared
// plannedFiles, and the dispatch record names the contention so master status can show it.
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const later = iso(600_000), earlier = iso(-600_000);
const hotFile = 'src/daemon/cycle-sessions.ts';

function work(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:x'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'ready', revision: 1, policyRevision: 1, createdAt: iso(-3_600_000), updatedAt: iso(0), stageEnteredAt: iso(0),
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides,
  } as Work;
}
const claimed = (key: string, plannedFiles: string[], overrides: Partial<Work> = {}) => work(key, { stage: 'build', plannedFiles, epoch: 1, lease: { owner: `${key}-worker`, epoch: 1, expiresAt: later }, ...overrides });
const submitted = (key: string, plannedFiles: string[], sha = 'a'.repeat(40), overrides: Partial<Work> = {}) => work(key, { stage: 'review', plannedFiles, epoch: 1, submission: { epoch: 1, pr: 7 },
  candidate: { sha, baseSha: 'b'.repeat(40), pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' }, ...overrides });

test('unit:dispatch-prefers-non-overlapping — hotspots name the files two or more live attempts plan; ready peers, expired leases, done work and rework peers heat nothing', () => {
  const one = claimed('GY-hotA', [hotFile]);
  const two = claimed('GY-hotB', ['src/daemon/']);
  const docWide = submitted('GY-docA', ['docs/']);
  const docNarrow = submitted('GY-docB', ['docs/protocol/leases.md']);
  const ready = work('GY-ready', { plannedFiles: [hotFile] });
  const readyPeer = work('GY-readyPeer', { plannedFiles: [hotFile] });
  const expired = claimed('GY-expired', [hotFile], { lease: { owner: 'gone', epoch: 1, expiresAt: earlier } });
  const delivered = work('GY-done', { stage: 'done', plannedFiles: [hotFile], submission: { epoch: 1, pr: 1 } });
  const rework = submitted('GY-rework', [hotFile], 'c'.repeat(40), { reworkRequested: true });
  const all = [one, two, docWide, docNarrow, ready, readyPeer, expired, delivered, rework];
  assert.deepEqual(hotspots(all, clock), [
    { file: 'docs/protocol/leases.md', claimedBy: ['GY-docA', 'GY-docB'] },
    { file: hotFile, claimedBy: ['GY-hotA', 'GY-hotB'] },
  ], 'a live attempt plus an open candidate is heat; a directory claim meets a file claim and the narrower scope is named');
  assert.deepEqual(hotspots([one], clock), [], 'one claimant alone heats nothing');
  assert.deepEqual(hotspots([ready, readyPeer], clock), [], 'two ready peers are not in flight; they do not heat each other');
  assert.deepEqual(hotspots([one, rework], clock), [], 'a submission sent back for rework is a peer waiting for a worker, not a claimant');
  assert.deepEqual(hotspots([one, expired, delivered], clock), [], 'an expired lease and done work are not claimants');
  assert.deepEqual([...hotFileSet(all, clock)].sort(), ['docs/protocol/leases.md', hotFile], 'hotFileSet is the set of hot files dispatchOrder reads');
  assert.deepEqual(hotBeside(ready, hotspots(all, clock)), { file: hotFile, beside: ['GY-hotA', 'GY-hotB'] }, 'hotBeside names the first hot file the item touches and its claimants');
  assert.equal(hotBeside(work('GY-cold', { plannedFiles: ['web/'] }), hotspots(all, clock)), null, 'an item touching no hot file records no contention');
});

test('unit:dispatch-prefers-non-overlapping — dispatchOrder offers items touching no hot file first within one priority; priority dominates; an empty hot set reproduces the old order', () => {
  const heat = hotFileSet([claimed('GY-hotA', [hotFile]), claimed('GY-hotB', [hotFile])], clock);
  const coldOld = work('GY-coldOld', { plannedFiles: ['docs/coordination.md'], createdAt: iso(-7_200_000) });
  const coldNew = work('GY-coldNew', { plannedFiles: ['docs/one.md', 'docs/two.md'], createdAt: iso(-120_000) });
  const hotOld = work('GY-hotOld', { plannedFiles: [hotFile], createdAt: iso(-3_600_000) });
  const hotNew = work('GY-hotNew', { plannedFiles: [hotFile], createdAt: iso(-60_000) });
  const withoutHeat = [coldNew, hotOld, hotNew, coldOld].sort(dispatchOrder).map(item => item.key);
  assert.deepEqual(withoutHeat, ['GY-coldOld', 'GY-hotOld', 'GY-hotNew', 'GY-coldNew'], 'the empty hot set is the previous order: fewest files, then age');
  const withHeat = [coldNew, hotOld, hotNew, coldOld].sort((a, b) => dispatchOrder(a, b, heat)).map(item => item.key);
  assert.deepEqual(withHeat, ['GY-coldOld', 'GY-coldNew', 'GY-hotOld', 'GY-hotNew'], 'cold before hot within one priority; breadth then age within each group');
  const directory = work('GY-dir', { plannedFiles: ['src/daemon/'], createdAt: iso(-7_200_000) });
  assert.ok(dispatchOrder(coldOld, directory, heat) < 0, 'a directory scope that contains the hot file touches it, by scope overlap and not exact equality');
  const urgentHot = work('GY-urgentHot', { priority: 0, plannedFiles: [hotFile], createdAt: iso(-60_000) });
  assert.ok(dispatchOrder(urgentHot, coldOld, heat) < 0, 'priority dominates: a hot P0 is still offered before a cold P2');
  const rework = submitted('GY-rework', [hotFile], 'd'.repeat(40), { reworkRequested: true });
  assert.ok(dispatchOrder(coldOld, rework, heat) < 0, 'a rework peer heats nothing but is still ordered after a cold item by others\' heat');
  for (const [a, b] of [[coldOld, hotOld], [hotOld, directory], [rework, coldNew]] as [Work, Work][])
    assert.equal(dispatchOrder(a, b, heat), -dispatchOrder(b, a, heat), `the comparator stays consistent for ${a.key} and ${b.key}`);
});

function daemonConfig(credentialFile: string, workers: WorkerProfile[]): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers });
}
const launchProfile = (name: string, credentialFile: string): WorkerProfile => ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'codex', credentialFile, agentArgs: [], approvals: 'auto', environment: {} });
async function daemon(profiles: string[]) {
  const directory = await temporaryDirectory('hotspot-scheduling');
  const token = join(directory, 'coordinator.token'); await writeFile(token, coordinatorToken, { mode: 0o600 });
  const credential = join(directory, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
  const master = daemonConfig(token, profiles.map(name => launchProfile(name, credential)));
  const log: string[] = [];
  let snapshotWork: Work[] = [], offsetMs = 0;
  const effects: DaemonEffects = {
    agents: () => [], credentials: async items => Object.fromEntries(items.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: snapshotWork, now: iso(offsetMs) }),
    closeSession: () => {}, dispatch: async (item, profile) => { log.push(`${item.key}→${profile.name}`); },
    requestProof: () => {}, observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
  };
  return { master, effects, log, state: emptyDaemonState(master), set: (items: Work[], atMs = 0) => { snapshotWork = items; offsetMs = atMs; }, cleanup: () => Promise.resolve() };
}

test('unit:dispatch-prefers-non-overlapping — the durable loop offers the cold item first and still dispatches every ready item in one cycle; when only hot items are ready they all dispatch too', async () => {
  const loop = await daemon(['one', 'two', 'three']);
  try {
    const heat = [claimed('GY-hotA', [hotFile]), claimed('GY-hotB', [hotFile])];
    const cold = work('GY-cold', { plannedFiles: ['docs/coordination.md'], createdAt: iso(-60_000) });
    const warm = work('GY-warm', { plannedFiles: [hotFile], createdAt: iso(-7_200_000) });
    loop.set([...heat, cold, warm]);
    await runCycle(loop.master, loop.state, loop.effects, () => clock);
    assert.deepEqual(loop.log, ['GY-cold→one', 'GY-warm→two'], 'the cold item is offered first though the hot one has waited far longer; both dispatch in one cycle — nothing idled');

    const onlyHotA = work('GY-onlyA', { plannedFiles: [hotFile], createdAt: iso(-60_000) });
    const onlyHotB = work('GY-onlyB', { plannedFiles: [hotFile, 'docs/extra.md'], createdAt: iso(-7_200_000) });
    loop.set([...heat, onlyHotA, onlyHotB]);
    await runCycle(loop.master, loop.state, loop.effects, () => clock);
    assert.deepEqual(loop.log.slice(2), ['GY-onlyA→one', 'GY-onlyB→two'], 'every ready item touches the hot file, so breadth decides — and they all still dispatch in one cycle');
  } finally { await loop.cleanup(); }
});

test('unit:hotspot-overlap-recorded — the dispatch record names the hot file and the live attempts it starts beside; a cold dispatch names no contention', async () => {
  const loop = await daemon(['one', 'two']);
  try {
    const heat = [claimed('GY-hotA', [hotFile]), claimed('GY-hotB', [hotFile])];
    const cold = work('GY-cold', { plannedFiles: ['docs/coordination.md'], createdAt: iso(-60_000) });
    const warm = work('GY-warm', { plannedFiles: [hotFile], createdAt: iso(-7_200_000) });
    loop.set([...heat, cold, warm]);
    await runCycle(loop.master, loop.state, loop.effects, () => clock);
    const warmRecord = loop.state.actions[dispatchKey(warm)];
    assert.equal(warmRecord?.state, 'done');
    assert.ok(warmRecord.detail.includes(`starts on ${hotFile}`), 'the record names the contended file');
    assert.ok(warmRecord.detail.includes('GY-hotA') && warmRecord.detail.includes('GY-hotB'), 'the record names every live attempt already changing it');
    assert.match(warmRecord.detail, /GY-882 hot spot/);
    const coldRecord = loop.state.actions[dispatchKey(cold)];
    assert.equal(coldRecord?.state, 'done');
    assert.ok(!coldRecord.detail.includes('hot spot'), 'a cold dispatch records no contention');
  } finally { await loop.cleanup(); }
});

test('unit:dispatch-ages-starving-items — a same-priority item waiting past the starvation bound is offered first, whatever its scope or heat', () => {
  const now = Date.parse('2026-10-01T04:00:00Z');
  const item = (key: string, plannedFiles: string[], enteredMinutesAgo: number, priority = 0) => ({ key, priority, plannedFiles, createdAt: new Date(now - enteredMinutesAgo * 60_000).toISOString(), stageEnteredAt: new Date(now - enteredMinutesAgo * 60_000).toISOString() } as unknown as Work);
  const broadStarving = item('GY-1023', ['src/', 'tests/', 'docs/'], 200);
  const smallFresh = item('GY-2001', ['src/one.ts'], 5);
  const hot = new Set(['docs/master-agent.md']);
  // Without a clock the old order holds: the smaller, cold item first.
  assert.deepEqual([broadStarving, smallFresh].sort((a, b) => dispatchOrder(a, b, hot)).map(w => w.key), ['GY-2001', 'GY-1023']);
  // With the clock, the item past the bound goes first even though it is broader and hot.
  assert.deepEqual([smallFresh, broadStarving].sort((a, b) => dispatchOrder(a, b, hot, now)).map(w => w.key), ['GY-1023', 'GY-2001']);
  // Among starving items the usual order decides (the narrower GY-0900 first); priority still outranks starvation.
  const olderStarving = item('GY-0900', ['src/two.ts'], 300);
  const urgentFresh = item('GY-3000', ['src/three.ts'], 1, -1);
  assert.deepEqual([broadStarving, olderStarving, urgentFresh, smallFresh].sort((a, b) => dispatchOrder(a, b, hot, now)).map(w => w.key), ['GY-3000', 'GY-0900', 'GY-1023', 'GY-2001']);
  assert.equal(dispatchStarvationMs, 60 * 60_000);
  // dispatchSort reads each wait once and gives the comparator's order.
  const all = [broadStarving, olderStarving, urgentFresh, smallFresh];
  assert.deepEqual(dispatchSort(all, hot, now).map(w => w.key), [...all].sort((a, b) => dispatchOrder(a, b, hot, now)).map(w => w.key));
  assert.deepEqual(all.map(w => w.key), ['GY-1023', 'GY-0900', 'GY-3000', 'GY-2001'], 'dispatchSort leaves its input in place');
});

test('unit:dispatch-ages-malformed-rows — an item whose stage time is unreadable falls back to its creation time, and one with neither readable still ages instead of never starving (GY-1040)', () => {
  const now = Date.parse('2026-10-01T04:00:00Z'), longAgo = new Date(now - 3 * dispatchStarvationMs).toISOString();
  const row = (key: string, stageEnteredAt: string | undefined, createdAt: string) => ({ key, priority: 0, plannedFiles: ['src/'], stageEnteredAt, createdAt } as unknown as Work);
  assert.equal(stageWaitMs(row('GY-a', 'not a time', longAgo), now), 3 * dispatchStarvationMs, 'an unreadable stage time falls back to createdAt');
  assert.equal(stageWaitMs(row('GY-b', undefined, longAgo), now), 3 * dispatchStarvationMs);
  assert.equal(stageWaitMs(row('GY-c', 'garbage', 'garbage'), now), Infinity, 'neither readable: the wait is unbounded, never NaN');
  const fresh = { ...row('GY-fresh', new Date(now).toISOString(), new Date(now).toISOString()), plannedFiles: ['src/one.ts'] } as Work;
  const malformed = row('GY-bad', 'garbage', 'garbage');
  assert.deepEqual(dispatchSort([fresh, malformed], new Set(), now).map(w => w.key), ['GY-bad', 'GY-fresh'], 'the malformed row is aged ahead of a fresh, narrower item');
  assert.equal(dispatchOrder(malformed, malformed, new Set(), now), 0, 'the comparator stays defined (never NaN) on a malformed row');
});

test('unit:dispatch-schedule-follows-loop-order — master status reports the order the loop offers, with the hot set and the clock (GY-1040)', () => {
  const live = claimed('GY-liveA', [hotFile]), other = claimed('GY-liveB', [hotFile]);
  const hotSmall = work('GY-hotSmall', { plannedFiles: [hotFile] });
  const coldBroad = work('GY-coldBroad', { plannedFiles: ['web/', 'scripts/'] });
  const starvingBroad = work('GY-starving', { plannedFiles: ['web/', 'scripts/', 'docs/'], stageEnteredAt: iso(-2 * dispatchStarvationMs) });
  const all = [live, other, hotSmall, coldBroad, starvingBroad];
  const loopOrder = dispatchSort([hotSmall, coldBroad, starvingBroad], hotFileSet(all, clock), clock).map(w => w.key);
  assert.deepEqual(loopOrder, ['GY-starving', 'GY-coldBroad', 'GY-hotSmall'], 'starving first, then cold before hot, whatever the scope');
  assert.deepEqual(dispatchSchedule(all, clock).order.map(entry => entry.key), loopOrder);
});
