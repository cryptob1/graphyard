import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileFleetSessions, runtimeSessionGone, settledRecordSessions, type FleetClient } from '../src/fleet.js';
import { NoHealthyAccountError, masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { emptyRegistry, type AgentRegistry, type FleetRoleName, type FleetSession } from '../src/model/registry.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';

/**
 * GY-205: the follow-ups the independent review of GY-190 left. A reviewer's or producer's registry
 * session ends with the ledger record that keeps its id, as an approver's ends with its Herdr session;
 * and a reviewer or producer launch the registry refuses because its role is at its concurrency limit
 * waits for a slot, uncounted, as an approver launch does. (The approver launch's own inventory is
 * covered in registry-drives-launch.test.ts.)
 */

const HOST = 'machine-a';
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minute = 60_000;
const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

function registryOf(sessions: FleetSession[]) {
  const registry: AgentRegistry = { ...emptyRegistry(), sessions };
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async () => { throw new Error('not used'); },
    end: async (id, reason) => { const session = registry.sessions.find(entry => entry.id === id); if (session && !session.endedAt) Object.assign(session, { endedAt: iso(0), endReason: reason }); },
  };
  return { registry, client };
}
const session = (role: FleetRoleName, work: string): FleetSession => ({ id: randomUUID(), role, account: 'claude-b', runtime: 'claude', model: 'opus', host: HOST, work, principal: null,
  selectedAt: iso(-30 * minute), selectedBy: 'coordinator', reason: 'recorded', skipped: [], endedAt: null, endReason: null });

async function config(): Promise<MasterConfig> {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-slot-followups-')); directories.push(directory);
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: HOST, masterAgentName: 'graphyard-master-project',
    reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: join(directory, 'reviewer.json'), boundAt: iso(0) }, reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' }],
    producers: [{ name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: join(directory, 'producer-a.token') }], workers: [] });
}

test('unit:reviewer-producer-sessions-end-with-record — a reviewer or producer registry session ends once its ledger record settles, and is kept while the record is pending; Herdr alone never judges one gone', async () => {
  const review = session('reviewer', 'GY-1'), pendingReview = session('reviewer', 'GY-2'), proof = session('producer', 'GY-3'), unrecorded = session('producer', 'GY-4');
  const { registry, client } = registryOf([review, pendingReview, proof, unrecorded]);
  // Nothing in Herdr: a reviewer's or producer's Herdr name is not one the registry session determines, so no inventory ends it.
  for (const entry of registry.sessions) assert.equal(runtimeSessionGone(entry, { agents: [], available: true }, HOST, clock), null);

  const settled = new Map([
    ...settledRecordSessions('reviewer', [{ session: review.id, state: 'completed', key: 'GY-1', agentName: 'review-claude-1' }, { session: pendingReview.id, state: 'pending', key: 'GY-2', agentName: 'review-claude-1' }]),
    ...settledRecordSessions('producer', [{ session: proof.id, state: 'expired', key: 'GY-3', agentName: 'produce-a' }, { state: 'failed', key: 'GY-4', agentName: 'produce-a' }]),
  ]);
  assert.deepEqual([...settled.keys()], [review.id, proof.id], 'only a settled record that kept its registry session names one');
  const ended = await reconcileFleetSessions({ credentialFile: '/unused', hostId: HOST }, { agents: [], available: true }, settled, { registry: client, now: () => clock });
  assert.deepEqual(ended.map(entry => [entry.role, entry.work, entry.reason]), [
    ['reviewer', 'GY-1', 'its reviewer session review-claude-1 for GY-1 is completed'],
    ['producer', 'GY-3', 'its producer session produce-a for GY-3 is expired'],
  ]);
  assert.deepEqual(registry.sessions.filter(entry => !entry.endedAt).map(entry => entry.work), ['GY-2', 'GY-4'], 'a pending record keeps its slot, and a session no record names is left to its lease');
});

function observation(candidate: { sha: string; baseSha: string; pr: number; branch: string }): Observation {
  return { candidate: { ...candidate, author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: iso(0), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: '7'.repeat(40), baseTipContained: true };
}
/** A submitted head with a standing review request and a unit producer request. */
function requested(): Work {
  const candidate = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  const make = (evidence: Work['evidence']) => ({ id: 'work-64', key: 'GY-64', title: 'Slots', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Unit', proofs: ['unit:slots'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1,
    createdAt: iso(0), updatedAt: iso(0), stageEnteredAt: iso(0), ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false,
    scenarioRequirements: [], evidence, observation: observation(candidate), blocker: null, violations: [],
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }] }) as unknown as Work;
  const item = make([]); reconcileAutoDispatch(item, [item], new Date(clock));
  // The review request is the one a proven twin of the head raises (GY-115).
  const twin = make([{ id: 'twin', proof: 'unit:slots', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1, producer: 'independent-runner', trusted: true, result: 'pass', executed: 1, skipped: 0, at: iso(0) }]);
  reconcileAutoDispatch(twin, [twin], new Date(clock));
  item.autoDispatch!.review = twin.autoDispatch!.review;
  return item;
}

test('unit:role-capacity-slot-wait — a reviewer or producer launch the registry refuses for its role\'s concurrency limit waits for a slot: not counted as a refusal, no backoff and no quota hold, and it launches on the next tick once a slot frees', async () => {
  const cfg = await config(), item = requested();
  const full = (role: string) => Object.assign(new NoHealthyAccountError(`No healthy agent account for ${role} profile p: role ${role} is at its concurrency limit (1 of 1 live)`, []), { roleAtCapacity: `role ${role} is at its concurrency limit (1 of 1 live)` });
  let slots = false;
  const launched: string[] = [];
  const effects: DispatchEffects = {
    snapshot: async () => ({ work: [item], now: iso(0) }),
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews: [] }),
    reconcileProducers: async () => ({ producers: [] }),
    launchReview: async () => { if (!slots) throw full('reviewer'); launched.push('review'); },
    launchProducer: async () => { if (!slots) throw full('producer'); launched.push('producer'); },
    persist: async () => {},
  };
  const cursor = emptyDispatchCursor(cfg);
  const first = await runDispatchTick(cfg, cursor, effects, () => clock);
  assert.deepEqual(first.refused, [], 'a full role is a wait, not a refusal');
  assert.deepEqual(first.waiting.map(entry => [entry.kind, entry.reason]).sort(), [
    ['producer', 'waits for a producer slot, launched on the first tick one frees: role producer is at its concurrency limit (1 of 1 live)'],
    ['review', 'waits for a reviewer slot, launched on the first tick one frees: role reviewer is at its concurrency limit (1 of 1 live)'],
  ]);
  assert.deepEqual(cursor.failures, {}, 'nothing is counted against the requests');
  assert.deepEqual(cursor.capacity, {}, 'no quota hold pauses the role');

  // A slot frees: the very next tick launches both, with no backoff to wait out.
  slots = true;
  const next = await runDispatchTick(cfg, cursor, effects, () => clock + 1000);
  assert.deepEqual(launched.sort(), ['producer', 'review']);
  assert.deepEqual(next.launched.map(entry => entry.kind).sort(), ['producer', 'review']);

  // Any other refusal still backs off as before.
  const other = await runDispatchTick(cfg, emptyDispatchCursor(cfg), { ...effects, launchReview: async () => { throw new Error('the reviewer credential is unreadable'); } }, () => clock);
  assert.equal(other.refused.filter(entry => entry.kind === 'review').length, 1);
});
