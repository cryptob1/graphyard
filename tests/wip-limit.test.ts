import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inFlight } from '../src/coordination.js';
import { actionableSubjects } from '../src/daemon/metrics.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { buildMasterStatus, masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2097: at most 4 items in flight. Lead time is items in flight over merge rate — at twenty in
// flight and two merges an hour every item waits hours, and main moves under queued changes. The
// dispatcher therefore starts new implementation work only while fewer than `maxInFlight` items are
// being built or waiting to merge; an item titled "Hotfix: …" is exempt; one merge frees the next
// ready item. One constant: no settings, no throughput measurement, no new status field.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const hour = 3_600_000;
// Loaded per test so that, on a base without the cap, the proof fails as a test case rather than at import.
const cap = () => import('../src/model/dispatch.js') as Promise<{ isHotfix: (work: { title: string }) => boolean; maxInFlight: number; wipHoldWording: { held: string } }>;

function work(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `id-${key}`, key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:x'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'ready', revision: 1, policyRevision: 1, createdAt: iso(-4 * hour), updatedAt: iso(0), stageEnteredAt: iso(-4 * hour),
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides,
  } as Work;
}
/** Claimed with a live lease: being built. */
const building = (key: string, overrides: Partial<Work> = {}) => work(key, { stage: 'build', epoch: 1, lease: { owner: `${key}-worker`, epoch: 1, expiresAt: iso(10 * hour) }, lastAssignment: { owner: `${key}-worker`, epoch: 1, claimedAt: iso(-hour) }, ...overrides });
/** Submitted with a standing candidate: waiting to merge. */
const submitted = (key: string, overrides: Partial<Work> = {}) => {
  const candidate = { sha: key.toLowerCase().padEnd(40, 'f').replace(/[^0-9a-f]/g, 'e'), baseSha: 'b'.repeat(40), pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  return work(key, { stage: 'review', epoch: 1, submission: { epoch: 1, pr: 7 }, candidate, lastAssignment: { owner: `${key}-worker`, epoch: 1, claimedAt: iso(-hour) },
    observation: { candidate, files: ['src/x.ts'], at: iso(-60_000), merged: false, prState: undefined, checks: [], reviews: [] } as any, ...overrides });
};

function daemonConfig(credentialFile: string, workers: WorkerProfile[]): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers });
}
const launchProfile = (name: string, credentialFile: string): WorkerProfile => ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'codex', credentialFile, agentArgs: [], approvals: 'auto', environment: {} });
async function daemon(profiles: string[]) {
  const directory = await temporaryDirectory('wip-limit');
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
/** Four in flight — two being built, two waiting to merge — plus a ready item and a ready hotfix. */
const queue = () => {
  const inFlightItems = [building('GY-181'), building('GY-182'), submitted('GY-183'), submitted('GY-184')];
  // The ready item is the older of the two, so the dispatcher's own order offers it first: what the
  // cap holds is the item the order would have started first.
  const ready = work('GY-201', { createdAt: iso(-4 * hour), stageEnteredAt: iso(-4 * hour) });
  const hotfix = work('GY-202', { title: 'Hotfix: roll the deploy back', createdAt: iso(-3 * hour), stageEnteredAt: iso(-3 * hour) });
  return { inFlightItems, ready, hotfix, all: [...inFlightItems, ready, hotfix] };
};

test('unit:wip-limit — with 4 items implementing or waiting to merge the dispatcher starts no ready item but does start a Hotfix; once one merges, the next ready item starts', async () => {
  const { isHotfix, maxInFlight, wipHoldWording } = await cap();
  assert.equal(maxInFlight, 4, 'the cap is the one constant, 4');
  assert.ok(isHotfix({ title: 'Hotfix: roll the deploy back' }) && !isHotfix({ title: 'hotfix: lower-case is not exempt' }) && !isHotfix({ title: 'Hotfixes: not a hotfix' }) && !isHotfix({ title: 'Feature: anything' }), 'only the exact "Hotfix: …" title is exempt');

  const { inFlightItems, ready, hotfix, all } = queue();
  for (const item of inFlightItems) assert.ok(inFlight(item, clock), `${item.key} counts as in flight`);
  assert.equal(inFlightItems.filter(item => inFlight(item, clock)).length, maxInFlight, 'four items are being built or waiting to merge');
  assert.ok(!inFlight(ready, clock) && !inFlight(hotfix, clock), 'a ready item is not yet in flight');

  const loop = await daemon(['one']);
  try {
    loop.set(all);
    await runCycle(loop.master, loop.state, loop.effects, () => clock);
    assert.deepEqual(loop.log, ['GY-202→one'], 'the hotfix starts; the ready item does not');
    // The held wait is recorded as the cap's capacity, on no subject, the way a saturated fleet's is.
    const held = loop.state.actions[`wip:${ready.id}`];
    assert.ok(held, 'the cap leaves a record of what it held');
    assert.equal(held.kind, 'capacity');
    assert.equal(held.detail, `GY-201 ${wipHoldWording.held}`);
    assert.equal(held.work, null, 'the record acts on no subject, so the item keeps its wait');

    // Once one merges, the next ready item starts: the delivered item no longer counts.
    loop.set([building('GY-181'), building('GY-182'), submitted('GY-183'), work('GY-184', { ...submitted('GY-184'), stage: 'done' }) as Work, ready, hotfix]);
    await runCycle(loop.master, loop.state, loop.effects, () => clock);
    assert.deepEqual(loop.log, ['GY-202→one', 'GY-201→one'], 'the freed slot starts the next ready item');
    assert.ok(!loop.state.actions[`wip:${ready.id}`] || loop.state.actions[`wip:${ready.id}`]!.detail === `GY-201 ${wipHoldWording.held}`, 'the cap record names one unchanged cause, never a moving one');
  } finally { await loop.cleanup(); }
});

test('unit:wip-limit — the measure counts a cap-held item under capacity, not as its own dispatch wait, and master status names the cap', async () => {
  const { wipHoldWording } = await cap();
  const { ready, hotfix, all } = queue();
  const config = daemonConfig('/outside/coordinator.token', []);
  // The dispatch step's own decision (saturation.wipHeld) retitles the wait, the way fleetHeld does (GY-1890).
  const subjects = actionableSubjects(config, all, clock, { wipHeld: true });
  const held = subjects.find(entry => entry.work === ready.key && entry.kind === 'capacity')!;
  assert.ok(held, 'the held item is still a measured subject');
  assert.equal(held.kind, 'capacity');
  assert.equal(held.detail, `GY-201 ${wipHoldWording.held}`);
  assert.ok(!subjects.some(entry => entry.work === ready.key && entry.kind === 'dispatch'), 'the cap hold is not counted as a dispatch wait');
  // A hotfix starts whatever the count, so its wait stays the loop's dispatch subject.
  const exempt = subjects.find(entry => entry.work === hotfix.key && entry.kind === 'dispatch')!;
  assert.equal(exempt.kind, 'dispatch');
  assert.match(exempt.detail, /is claimable and waiting for a worker/);

  const profiles = ['one'].map(name => launchProfile(name, '/credentials/worker.token'));
  const status = buildMasterStatus({ work: all, now: iso(0) }, profiles, [], {}, {}, { pending: [], completed: [] });
  assert.equal(status.effectiveConcurrency.inFlight, 4);
  assert.match(status.effectiveConcurrency.statement, /the dispatcher starts new work while fewer than 4 items are in flight — 4 in flight is the cap, so ready work waits until one merges \(Hotfix items excepted\)$/);
});

