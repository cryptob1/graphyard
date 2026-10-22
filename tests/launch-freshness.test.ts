import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import type { DispatchRequest } from '../src/model/dispatch.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { assertReviewCandidate } from '../src/reviewer.js';
import { emptyDispatchCursor, launchWaitLimit, tickWaits, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-710. On 2026-09-26 review requests waited hours for a reviewer: every launch was refused with
 * "GitHub observation is missing or older than two minutes", and with ~250 open items observed a
 * few a minute, an item was read inside that bound only by chance. A launch now binds the request's
 * exact head and base, not the observation's age, and a waiting launch is recorded.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minute = 60_000;
const head = 'a'.repeat(40), moved = 'c'.repeat(40), base = 'b'.repeat(40);

function observation(sha: string, at: string, extra: Partial<Observation> = {}): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { sha, baseSha: base, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' }, checks: [], reviews: [],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: base, baseTipContained: true, ...extra } as Observation;
}
function reviewRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return { id: 'b8693b4c-0000-4000-8000-000000000001', kind: 'review', sha: head, baseSha: base, policyRevision: 1, pr: 42, provider: 'github', requestedAt: iso(-20 * minute), reason: 'independent approval', state: 'requested', ...overrides };
}
function item(observedAt: string, overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-42', key: 'GY-42', title: 'Launch on the head', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, 
    stage: 'review', revision: 5, policyRevision: 1, createdAt: iso(-4 * 60 * minute), updatedAt: iso(0), stageEnteredAt: iso(-30 * minute), ready: true, epoch: 1, lease: null, workspaces: [],
    submission: { epoch: 1, pr: 42 }, candidate: { sha: head, baseSha: base, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: observation(head, observedAt), blocker: null, violations: [],
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }],
    autoDispatch: { review: reviewRequest(), producers: [], history: [] }, ...overrides,
  } as Work;
}
function masterConfig(credentialFile: string, overrides: Record<string, unknown> = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [],
    reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: join(credentialFile, '..', 'reviewer.json'), boundAt: iso(-60 * minute) },
    reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' }], producers: [], ...overrides });
}
/** Dispatch effects whose review launch runs the launcher's own binding check, as `launchReview` does before anything starts. */
function dispatchEffects(items: () => Work[], launched: string[]): DispatchEffects {
  return {
    snapshot: async () => ({ work: items(), now: new Date(clock).toISOString() }),
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: [] }),
    launchReview: async (work, request, _profile, _agents, observedAt) => { const binding = assertReviewCandidate(work, observedAt, request); launched.push(binding.sha); },
    launchProducer: async () => {}, persist: async () => {},
  };
}
async function withToken<T>(run: (token: string) => Promise<T>) {
  const directory = await temporaryDirectory('launch-freshness');
  const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 }); return await run(token);
}

test('unit:launch-binds-head-not-age — a 20-minute-old observation of the requested head launches the review; a moved head does not', async () => {
  await withToken(async token => {
    const config = masterConfig(token);
    // The observation is twenty minutes old and of the exact head and base the request binds.
    const current = item(iso(-20 * minute));
    const launched: string[] = [];
    const tick = await runDispatchTick(config, emptyDispatchCursor(config), dispatchEffects(() => [current], launched), () => clock);
    assert.deepEqual(tick.refused, [], 'no freshness refusal for a review launch');
    assert.deepEqual(tick.launched.map(launch => [launch.kind, launch.sha]), [['review', head]]);
    assert.deepEqual(launched, [head]);

    // The item's latest observation is of a head the request does not bind: the request is superseded.
    const movedItem = item(iso(-20 * minute), { candidate: { sha: moved, baseSha: base, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' }, observation: observation(moved, iso(-20 * minute)) });
    const movedLaunches: string[] = [];
    const refused = await runDispatchTick(config, emptyDispatchCursor(config), dispatchEffects(() => [movedItem], movedLaunches), () => clock);
    assert.deepEqual(movedLaunches, [], 'no reviewer is launched for a head that moved');
    assert.equal(refused.launched.length, 0);
    assert.match(refused.refused[0].reason, /superseded/);
    assert.doesNotMatch(refused.refused[0].reason, /two minutes/);
    // A base that moved supersedes it the same way.
    assert.throws(() => assertReviewCandidate(item(iso(-20 * minute)), iso(0), reviewRequest({ baseSha: 'd'.repeat(40) })), /superseded/);
    // The observation must still be of the candidate itself.
    assert.throws(() => assertReviewCandidate(item(iso(-20 * minute), { observation: observation(moved, iso(-20 * minute)) }), iso(0), reviewRequest()), /does not match the current candidate/);

    // GitHub merges (GY-1235): no merge is held on the observation's age either; the gates bind
    // the head, as tests/github-delivery.test.ts asserts for a ten-minute-old observation.
  });
});

test('unit:launch-wait-reported — the dispatch tick records each waiting launch on its cursor, keeping the longest-waiting reviews past its bound', async () => {
  await withToken(async token => {
    // No reviewer profile: the review request waits, and the tick records why.
    const config = masterConfig(token, { reviewers: [] });
    const waiting = item(iso(-20 * minute), { autoDispatch: { review: reviewRequest({ requestedAt: iso(-20 * minute) }), producers: [], history: [] } } as Partial<Work>);
    const fresh = item(iso(-minute), { id: 'work-43', key: 'GY-43', autoDispatch: { review: reviewRequest({ id: 'b8693b4c-0000-4000-8000-000000000002', requestedAt: iso(-5 * minute) }), producers: [], history: [] } } as Partial<Work>);
    const cursor = emptyDispatchCursor(config);
    const tick = await runDispatchTick(config, cursor, dispatchEffects(() => [waiting, fresh], []), () => clock);
    assert.equal(tick.waiting.length, 2);
    assert.deepEqual(cursor.lastTick!.waits.map(wait => wait.requestId).sort(), [reviewRequest().id, 'b8693b4c-0000-4000-8000-000000000002']);

    // Past the cursor's bound the most recent waits drop, never the longest: reviews first, oldest first.
    const many = Array.from({ length: launchWaitLimit + 5 }, (_, n) => ({ kind: 'review' as const, work: `GY-${n}`, requestId: `request-${n}`, sha: head, reason: 'waiting', requestedAt: iso(-n * minute) }));
    const kept = tickWaits([{ kind: 'producer', work: 'GY-900', requestId: 'producer-1', sha: head, reason: 'waiting', requestedAt: iso(-999 * minute) }, ...many]);
    assert.equal(kept.length, launchWaitLimit);
    assert.equal(kept[0].requestId, `request-${launchWaitLimit + 4}`, 'the longest-waiting review is kept first');
    assert.ok(!kept.some(wait => wait.requestId === 'request-0' || wait.requestId === 'producer-1'), 'the newest waits drop past the bound');
  });
});
