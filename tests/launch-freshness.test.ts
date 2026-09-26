import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import type { DispatchRequest } from '../src/model/dispatch.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { assertMergeCandidate } from '../src/master/merge.js';
import { assertReviewCandidate } from '../src/reviewer.js';
import { dispatchFailureAttention, dispatchSummary, emptyDispatchCursor, launchWaitAttention, launchWaits, reviewLaunchWaitAttentionMs, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { emptyDaemonState, observationWakeRetryMs, runCycle, type DaemonEffects } from '../src/master-daemon.js';

/**
 * GY-710. On 2026-09-26 review requests waited hours for a reviewer: every launch was refused with
 * "GitHub observation is missing or older than two minutes", and with ~250 open items observed a
 * few a minute, an item was read inside that bound only by chance. A launch now binds the request's
 * exact head and base, not the observation's age; a step that genuinely needs a fresh observation
 * wakes the item's observation job and retries once it lands; and a waiting launch is reported.
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
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, plannedFiles: ['src/loop.ts'],
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
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-launch-freshness-'));
  try { const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 }); return await run(token); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('unit:launch-binds-head-not-age — a 20-minute-old observation of the requested head launches the review; a moved head does not; merges keep the two-minute bound', async () => {
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

    // The merge keeps its two-minute bound: the same age refuses a merge that a fresh observation allows.
    const mergeReady = (observedAt: string) => item(observedAt, { stage: 'merge', mergeAuthorization: { sha: head, baseSha: base, policyRevision: 1, at: iso(-minute) },
      gates: ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: true, reasons: [] })) } as Partial<Work>);
    assert.equal(assertMergeCandidate(mergeReady(iso(-30_000)), iso(0)).sha, head);
    assert.throws(() => assertMergeCandidate(mergeReady(iso(-20 * minute)), iso(0)), /current all-gates-passing merge authorization/);
  });
});

/** A submitted item whose last observation carries a changes-requested verdict on its head: it needs rework. */
function verdictItem(observedAt: string): Work {
  return item(observedAt, { observation: observation(head, observedAt, { checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'independent-reviewer', sha: head, state: 'CHANGES_REQUESTED' }] } as Partial<Observation>), autoDispatch: undefined } as Partial<Work>);
}
function daemonEffects(snapshot: () => Awaited<ReturnType<DaemonEffects['snapshot']>>, log: string[]): DaemonEffects {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => snapshot(),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: snapshot().now, reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    wakeObservation: async work => { log.push(`wake:${work.key}`); },
    decide: async (work, action) => { log.push(`decide:${work.key}:${action}`); return { id: '5d8a8b9e-0000-4000-8000-000000000001' }; },
    decisions: async () => ({ decisions: [] }),
    approver: async () => ({ agentName: 'graphyard-approver-gy-42', pane: 'pane-1' }),
    persist: async () => {},
  };
}

test('unit:stale-refusal-wakes-observation — a rework refused for a stale observation wakes the item\'s observation job at once, and the next attempt follows that observation', async () => {
  const config = masterConfig('/outside/coordinator.token');
  const state = emptyDaemonState(config);
  const log: string[] = [];
  // The observation is three minutes old: rework needs a fresh one.
  let current = verdictItem(iso(-3 * minute));
  let now = clock;
  const effects = daemonEffects(() => ({ work: [current], now: new Date(now).toISOString(), jobs: [] }), log);

  const first = await runCycle(config, state, effects, () => now);
  assert.deepEqual(log, ['wake:GY-42'], 'the refusal wakes the observation job immediately, and decides nothing');
  assert.match(first.actions.find(action => action.work === 'GY-42' && action.kind === 'decision')!.detail, /rework waits for a fresh GitHub observation/);
  assert.match(first.actions.find(action => action.kind === 'refresh')!.detail, /Woke the observation job of GY-42/);

  // The next cycle, before the woken observation lands: no second wake, and still no attempt.
  now = clock + 30_000;
  await runCycle(config, state, effects, () => now);
  assert.deepEqual(log, ['wake:GY-42'], 'one wake stands until its observation lands; the rework is not retried on a timer');

  // The woken observation lands: the very next cycle requests the rework.
  const landed = clock + 40_000;
  current = verdictItem(new Date(landed).toISOString());
  now = clock + 45_000;
  await runCycle(config, state, effects, () => now);
  assert.deepEqual(log, ['wake:GY-42', 'decide:GY-42:rework'], 'the second attempt follows the observation');

  // A wake that brought no observation within its bound is sent again.
  const again: string[] = [];
  const againState = emptyDaemonState(config);
  let againNow = clock;
  const stale = verdictItem(iso(-3 * minute));
  const againEffects = daemonEffects(() => ({ work: [stale], now: new Date(againNow).toISOString(), jobs: [] }), again);
  await runCycle(config, againState, againEffects, () => againNow);
  againNow = clock + observationWakeRetryMs;
  await runCycle(config, againState, againEffects, () => againNow);
  assert.deepEqual(again, ['wake:GY-42', 'wake:GY-42']);
});

test('unit:launch-wait-reported — master status reports each waiting launch with how long it has waited and why, and a review waiting over 15 minutes raises attention', async () => {
  await withToken(async token => {
    // No reviewer profile: the review request waits, and the tick records why.
    const config = masterConfig(token, { reviewers: [] });
    const waiting = item(iso(-20 * minute), { autoDispatch: { review: reviewRequest({ requestedAt: iso(-20 * minute) }), producers: [], history: [] } } as Partial<Work>);
    const fresh = item(iso(-minute), { id: 'work-43', key: 'GY-43', autoDispatch: { review: reviewRequest({ id: 'b8693b4c-0000-4000-8000-000000000002', requestedAt: iso(-5 * minute) }), producers: [], history: [] } } as Partial<Work>);
    const cursor = emptyDispatchCursor(config);
    const tick = await runDispatchTick(config, cursor, dispatchEffects(() => [waiting, fresh], []), () => clock);
    assert.equal(tick.waiting.length, 2);
    assert.deepEqual(cursor.lastTick!.waits.map(wait => wait.requestId).sort(), [reviewRequest().id, 'b8693b4c-0000-4000-8000-000000000002']);

    const rows = launchWaits([waiting, fresh], cursor, clock);
    assert.deepEqual(rows.map(row => [row.work, row.kind, row.waitedMs]), [['GY-42', 'review', 20 * minute], ['GY-43', 'review', 5 * minute]]);
    assert.ok(rows.every(row => /no reviewer profile/.test(row.reason)), 'each wait says why');
    assert.equal(rows[0].requestedAt, iso(-20 * minute));

    const attention = launchWaitAttention(rows);
    assert.equal(attention.length, 1, 'only the review waiting past fifteen minutes is attention');
    assert.equal(attention[0].subject, 'GY-42');
    assert.match(attention[0].text, /has waited 20 min/);
    assert.match(attention[0].text, /no reviewer profile/);
    assert.ok(20 * minute > reviewLaunchWaitAttentionMs && 5 * minute < reviewLaunchWaitAttentionMs);

    // What `master status` reports: the dispatcher summary carries the waits, and its attention raises the long one.
    const summary = dispatchSummary(cursor, clock, 10_000, [], [waiting, fresh]);
    assert.deepEqual(summary.waiting, rows);
    assert.deepEqual(dispatchFailureAttention(summary), attention);

    // A refusal still standing is reported as the wait's reason too, with its next attempt.
    const refused = emptyDispatchCursor(config);
    refused.failures[reviewRequest().id] = { kind: 'review', work: 'GY-42', sha: head, attempts: 4, reason: 'a reviewer launch failed', at: iso(-minute), nextAt: iso(minute) };
    const [row] = launchWaits([waiting], refused, clock);
    assert.match(row.reason, /launch refused 4 time\(s\): a reviewer launch failed; next attempt at/);
    // A request the item no longer holds waits for nothing.
    assert.deepEqual(launchWaits([item(iso(0), { autoDispatch: { review: null, producers: [], history: [] } } as Partial<Work>)], cursor, clock), []);
  });
});
