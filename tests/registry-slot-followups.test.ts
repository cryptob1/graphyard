import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NoHealthyAccountError, masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-205: a follow-up the independent review of GY-190 left. A reviewer or producer launch the
 * registry refuses because its role is at its concurrency limit waits for a slot, uncounted, as an
 * approver launch does.
 */

const HOST = 'machine-a';
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

async function config(): Promise<MasterConfig> {
  const directory = await temporaryDirectory('slot-followups'); directories.push(directory);
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: HOST, masterAgentName: 'graphyard-master-project',
    reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: join(directory, 'reviewer.json'), boundAt: iso(0) }, reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' }],
    producers: [{ name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: join(directory, 'producer-a.token') }], workers: [] });
}

function observation(candidate: { sha: string; baseSha: string; pr: number; branch: string }): Observation {
  return { candidate: { ...candidate, author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: iso(0), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: '7'.repeat(40), baseTipContained: true };
}
/** A submitted head with a standing review request and a unit producer request. */
function requested(): Work {
  const candidate = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  const make = (evidence: Work['evidence']) => ({ id: 'work-64', key: 'GY-64', title: 'Slots', description: '', type: 'feature', priority: 0, dependencies: [], 
    criteria: [{ id: 'AC-1', text: 'Unit', proofs: ['unit:slots'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1,
    createdAt: iso(0), updatedAt: iso(0), stageEnteredAt: iso(0), ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false,
    scenarioRequirements: [], evidence, observation: observation(candidate), blocker: null, violations: [],
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }] }) as unknown as Work;
  // Review is not held for proofs since GY-1235, so reconciling raises the review request at once.
  const item = make([]); reconcileAutoDispatch(item, [item], new Date(clock));
  // Dispatch opens no producer request any more; a standing one (built by hand) is still launched.
  item.autoDispatch!.producers.push({ id: 'producer-unit', kind: 'producer', group: 'unit', proofs: ['unit:slots'], sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1, pr: 64, requestedAt: iso(0), reason: 'unproven', state: 'requested' });
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
