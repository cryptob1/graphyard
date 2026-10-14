import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Evidence, Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { GhPausedError, ghPausedUntil, notePossibleGhRateLimit, resetGhPause } from '../src/gh-pause.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1807: while gh reads are paused, the run.awaitReviewers bot-reviewer check cannot be made at
// all — the same as a read that fails — so a launch whose only gate is that check goes ahead on the
// next dispatch tick, and its launch record names the pause as why the wait was skipped. A launch
// refused for any other reason still waits or is refused as today.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1');
const at = '2026-09-25T10:00:00.000Z', clock = Date.parse(at);
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
/** The fixed five-minute pause `notePossibleGhRateLimit` arms when no reset is readable. */
const fallbackMs = 5 * 60_000;
/** The pause line a skipped wait records, exactly as `GhPausedError` words it. */
const pausedReason = (pausedUntil: number) => `awaited-reviewer wait skipped: gh reads are paused until ${new Date(pausedUntil).toISOString()}: the login's API rate limit was exceeded`;
/** The fixed run stub the pause arming reads: no reset is readable, so the fallback stands. */
const noReset = () => { throw new Error('no reset is read'); };

function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  const observation: Observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false,
    baseTip: B, baseTree: sha40('7b'), baseTipContained: true } as Observation;
  return { id: 'work-64', key: 'GY-64', title: 'Paused launch', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Unit', proofs: ['unit:a'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [{ host: 'h', path: '/w/gy-64', branch: 'graphyard/gy-64-1', epoch: 1, owner: 'implementer' }],
    candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}
/** A head whose unit proof passed, so the control plane has raised a review request that waits on the bot reviewers. */
function reviewRequested(): Work {
  const proven: Evidence = { id: 'ev-a', proof: 'unit:a', sha: H, baseSha: B, policyRevision: 1, producer: 'independent-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at } as Evidence;
  const item = work({ evidence: [proven] }); reconcileAutoDispatch(item, [item], new Date(clock));
  assert.equal(item.autoDispatch?.review?.state, 'requested', 'the fixture raises a review request');
  return item;
}
function masterConfig(credentialFile: string, overrides: Record<string, unknown> = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: join(credentialFile, '..', 'reviewer.json'), boundAt: at }, reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' }], producers: [], ...overrides });
}
function effects(item: Work, log: string[], overrides: Partial<DispatchEffects> = {}): DispatchEffects {
  const reviews: any[] = [];
  return {
    snapshot: async () => ({ work: [item], now: at }),
    agents: () => [],
    credentials: async () => ({}),
    reconcileReviews: async () => ({ reviews }),
    reconcileProducers: async () => ({ producers: [] }),
    launchReview: async (work, request) => { log.push(`review:${work.key}:${request.sha.slice(0, 4)}`); reviews.push({ requestId: request.id, state: 'pending', requestedAt: at }); },
    launchProducer: async () => { throw new Error('no producer is requested in this fixture'); },
    // The bot has not reviewed this head, so every launch below would wait but for the case under test.
    headReviewers: async () => [],
    botActivity: async () => [],
    persist: async () => {},
    ...overrides,
  };
}
/** Arms the pause at `from`, as a rate-limit refusal does when the login's reset cannot be read. */
const armPause = (from: number) => notePossibleGhRateLimit(new Error('gh: API rate limit exceeded'), noReset, from);

async function withToken<T>(body: (config: MasterConfig) => Promise<T>) {
  const directory = await temporaryDirectory('gh-pause-launch');
  try {
    const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    return await body(masterConfig(token));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('unit:gh-pause-skips-bot-reviewer-wait — while gh reads are paused a launch that waits only on the bot-reviewer check goes ahead on the next tick and its record names the pause, exactly as a failed read launches', async () => {
  await withToken(async config => {
    resetGhPause();
    try {
      const item = reviewRequested(), log: string[] = [], requested = Date.parse(item.autoDispatch!.review!.requestedAt);
      // Without the pause the launch waits for the bot's review of the head, inside the 8-minute window.
      const waiting = await runDispatchTick(config, emptyDispatchCursor(config), effects(item, log), () => requested + 60_000);
      assert.deepEqual(waiting.launched, []);
      assert.match(waiting.waiting[0]!.reason, /waits up to 8 min .* for chatgpt-codex-connector\[bot\]'s review of the head/);
      // The pause arms. On the next tick the check cannot be made at all: the launch goes ahead, and
      // the record names the pause as why the bot wait was skipped.
      await armPause(requested + 120_000);
      const pausedTick = await runDispatchTick(config, emptyDispatchCursor(config), effects(item, log, {
        headReviewers: async () => { throw new GhPausedError(requested + 900_000); },
        botActivity: async () => { throw new GhPausedError(requested + 900_000); },
      }), () => requested + 121_000);
      assert.equal(log.length, 1, 'the launch goes ahead while the pause stands');
      assert.deepEqual(pausedTick.waiting, []);
      assert.equal(pausedTick.launched[0]!.reason, pausedReason(ghPausedUntil(requested + 121_000)));
      // An answer a read gathered before the pause does not hold the launch either: the pause is the
      // operative fact, not the read's answer.
      const stale = reviewRequested(), staleLog: string[] = [], staleRequested = Date.parse(stale.autoDispatch!.review!.requestedAt);
      await armPause(staleRequested + 120_000);
      const staleTick = await runDispatchTick(config, emptyDispatchCursor(config), effects(stale, staleLog, { headReviewers: async () => [] }), () => staleRequested + 121_000);
      assert.equal(staleLog.length, 1, 'a pre-pause answer does not hold the launch');
      assert.equal(staleTick.launched[0]!.reason, pausedReason(ghPausedUntil(staleRequested + 121_000)));
      // The contrast that fixes the wording: a failed read (no pause) launches too, but names nothing,
      // because nothing the dispatcher skipped needs naming.
      resetGhPause();
      const failed = reviewRequested(), failedLog: string[] = [], failedRequested = Date.parse(failed.autoDispatch!.review!.requestedAt);
      const failedTick = await runDispatchTick(config, emptyDispatchCursor(config), effects(failed, failedLog, { headReviewers: async () => { throw new Error('gh: HTTP 502'); } }), () => failedRequested + 121_000);
      assert.equal(failedLog.length, 1, 'a failed read launches exactly as the paused one does');
      assert.equal(failedTick.launched[0]!.reason, undefined);
      // A pause standing past the wait's own end names nothing: the wait ran out, the pause skipped nothing.
      const expired = reviewRequested(), expiredLog: string[] = [], expiredRequested = Date.parse(expired.autoDispatch!.review!.requestedAt);
      await armPause(expiredRequested + 480_001);
      const expiredTick = await runDispatchTick(config, emptyDispatchCursor(config), effects(expired, expiredLog), () => expiredRequested + 481_000);
      assert.equal(expiredLog.length, 1, 'the launch goes ahead once the wait has run out');
      assert.equal(expiredTick.launched[0]!.reason, undefined);
    } finally { resetGhPause(); }
  });
});

test('unit:gh-pause-skips-bot-reviewer-wait — a launch refused for any other reason still waits or is refused as today while the pause stands', async () => {
  await withToken(async config => {
    resetGhPause();
    try {
      const item = reviewRequested(), requested = Date.parse(item.autoDispatch!.review!.requestedAt);
      await armPause(requested + 120_000);
      // A launcher refusal the pause did not cause is counted against the request, as today.
      const refusedLog: string[] = [];
      const refusedCursor = emptyDispatchCursor(config);
      const refused = await runDispatchTick(config, refusedCursor, effects(item, refusedLog, { launchReview: async () => { throw new Error('the reviewer runtime could not be started'); } }), () => requested + 121_000);
      assert.equal(refusedLog.length, 0);
      assert.equal(refused.refused.length, 1);
      assert.equal(refused.refused[0]!.attempts, 1);
      assert.match(refused.refused[0]!.reason, /the reviewer runtime could not be started/);
      assert.ok(refusedCursor.failures[item.autoDispatch!.review!.id]);
      // A launch the launcher itself defers for the pause is still a wait that counts no failure, as today.
      const deferredLog: string[] = [];
      const deferredCursor = emptyDispatchCursor(config);
      const deferred = await runDispatchTick(config, deferredCursor, effects(item, deferredLog, { launchReview: async () => { throw new GhPausedError(requested + 900_000); } }), () => requested + 121_000);
      assert.equal(deferredLog.length, 0);
      assert.deepEqual(deferred.refused, []);
      assert.match(deferred.waiting[0]!.reason, /gh reads are paused/);
      assert.deepEqual(deferredCursor.failures, {});
      // No reviewer profile is still a wait naming its remedy, as today.
      const bare = masterConfig(join(config.credentialFile, '..'), { reviewers: [] });
      const bareTick = await runDispatchTick(bare, emptyDispatchCursor(bare), effects(item, [], { headReviewers: async () => { throw new GhPausedError(requested + 900_000); } }), () => requested + 121_000);
      assert.match(bareTick.waiting[0]!.reason, /no reviewer profile is configured/);
    } finally { resetGhPause(); }
  });
});
