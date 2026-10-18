import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Work } from '../src/model.js';
import { dispatchAttemptCeiling, dispatchCursorPath, dispatchCursorSchema, dispatchFailureLimit, emptyDispatchCursor, runDispatchTick, unknownParent, writeDispatchCursor, type DispatchEffects } from '../src/auto-dispatch.js';
import { owedPostMergeReviews, postMergeRequestId, postMergeRefusalProbeMs } from '../src/model/post-merge-review.js';
import { launchReview, readReviewLedger, saveReviewerProfile } from '../src/reviewer.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Every instant this file holds is derived from the run's own clock (GY-1694): a base reading taken
// at load and offsets from it. No calendar literal is constructed, so no wall-clock reading here is
// judged against a fixed date.

// GY-2075, over simulated days: the hourly probe of a post-merge request the launch-attempt limit
// stranded is the loop's new per-item repeating behaviour — every stranded request earns one real
// launch attempt per standstill hour for as long as its refusal's cause stands, each attempt
// preparing a review checkout and a session directory and discarding them again. The day below runs
// three stranded requests through the real `runDispatchTick` and the real `launchReview` (the
// served control plane's 400 read as a refused registration) at the loop's own one-minute cadence,
// then hourly past the attempt clamp, and asserts the repetition stays bounded: at most one attempt
// per request per hour and never one per tick, no session directory, checkout or ledger reservation
// left behind by any of them, the cursor still persisting once attempts reach the schema's 1000,
// and one launch per request once the cause is gone with no probe ever after.

const H = 'a'.repeat(40), B = 'b'.repeat(40), M = 'c'.repeat(40);
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const launcher = new URL('../bin/graphyard.mjs', import.meta.url).pathname;
const base = new Date();
let instantMs = base.getTime();
const at = (offsetMs = 0) => new Date(instantMs + offsetMs).toISOString();
const minute = 60_000, hour = 60 * minute;
/** The loop's own cadence: one dispatch tick per minute, as production runs it. */
const intervalMs = 60_000;
const keys = ['GY-9101', 'GY-9102', 'GY-9103'];
const requestIdOf = (key: string) => postMergeRequestId(key, M);

/** A delivered control-plane merge with no pull request anywhere: the post-merge request reads pr 0. */
function deliveredPrLess(key: string): Work {
  const candidate = { sha: H, baseSha: B, branch: `graphyard/${key.toLowerCase()}-1`, author: 'graphyard-opencode-1' };
  return { id: randomUUID(), key, title: `Item ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true }, plannedFiles: ['src/feature.ts'],
    stage: 'done', revision: 9, policyRevision: 1, createdAt: at(), updatedAt: at(), stageEnteredAt: at(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: candidate.author }], candidate, submission: { epoch: 1 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: [candidate.author], postMergeReview: 'owed', systemDriven: true,
    delivery: { mergedAt: at(), mergeSha: M, authorizationRevision: 8 },
    mergeLedger: { key, state: 'reconciled', head: H, baseTip: B, mergeSha: M, risk: 'normal', intentAt: at(), pushedAt: at(), observedTip: M, refusal: null, events: 3 },
    observation: { source: 'control-plane', at: at(), candidate, checks: [], reviews: [], merged: true, mergeSha: M, mergedAt: at(), mergeable: true, protected: false,
      files: ['src/feature.ts'], scopeFiles: [{ path: 'src/feature.ts', status: 'modified', sha: sha('f'), additions: 2, deletions: 1, binary: false }], baseTip: B, baseTipContained: true },
  } as unknown as Work;
}

const repository = 'owner/project';
/** The volume read the launch would make on durable storage; the test's directories stand in for the paths. */
const durable = async (path: string) => ({ probed: path, volatile: null, freeBytes: 200e9 });

test('unit:soak-post-merge-refusal-probe — three stranded post-merge requests probed hourly for simulated days: one attempt per request per standstill hour and never one per tick, no session directory, checkout or ledger reservation left behind by any refused attempt, the cursor still persisting past the attempt clamp, and one launch per request once the cause is gone with none probed afterwards', { timeout: 900_000 }, async () => {
  // The loop's own root: one reviewer profile and the bound reviewer identity, the managed worktree
  // root and credential directory pointed at this run's directories, and the dispatch cursor
  // persisted by the production writer so the schema judges every tick's cursor.
  const root = await temporaryDirectory('soak-probe-master');
  const credentialDirectory = await temporaryDirectory('soak-probe-credentials');
  const worktrees = await temporaryDirectory('soak-probe-worktrees');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${repository}.git`], { cwd: root });
  const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'graphyard-master', role: 'coordinator' }, repository, baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url: 'https://graphyard.example', token: `${'x'.repeat(32)}`, cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-graphyard' }, coordinatorStatus as typeof fetch);
  await saveReviewerProfile(root, { name: 'reviewer-claude', agentName: 'review-claude-1', kind: 'claude', concurrency: 4 });
  const file = join(root, '.graphyard/master.json');
  const storedConfig = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;
  storedConfig.reviewer = { appId: 4242, installationId: 99, slug: 'graphyard-reviewer', credentialFile: join(credentialDirectory, 'reviewer.json'), boundAt: at() };
  storedConfig.run = { ...(storedConfig.run ?? {}), worktreeRoot: worktrees };
  await writeFile(file, JSON.stringify(storedConfig, null, 2));
  const config = await loadMasterConfig(root);
  const cursor = emptyDispatchCursor(config);

  // The served control plane's refusal, standing until the recovery: the registration call every
  // real launch ends in is refused with the words the stranded requests were refused with.
  const registrations: { key: string; at: number; postMerge: boolean; head: string; baseTip: string }[] = [];
  let cause = true;
  const herdr = (_command: string, args: string[]) => startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' }, tab: { tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  const items = keys.map(deliveredPrLess);
  const realLaunch = (work: Work, id: string) => launchReview(root, work, 'reviewer-claude', [], at(), {
    run: herdr, requestId: id, filesystem: durable,
    postMerge: { mergeSha: work.delivery!.mergeSha, ...(work.mergeLedger!.baseTip !== unknownParent ? { baseTip: work.mergeLedger!.baseTip } : {}) },
    registerLaunch: async (item, launch) => {
      registrations.push({ key: item.key, at: instantMs, postMerge: launch.postMerge, head: launch.head, baseTip: launch.baseTip });
      if (cause) throw new Error(`The control plane refused the reviewer launch of ${item.key} (400): Invalid input`);
      return { launch: randomUUID() };
    },
  });
  const effects: DispatchEffects = {
    snapshot: async () => ({ work: items, now: at() }),
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews: [] }),
    reconcileProducers: async () => ({ producers: [] }),
    launchReview: async () => {}, launchProducer: async () => {},
    launchPostMergeReview: (work, request) => realLaunch(work, request.id),
    persist: async persisted => { await writeDispatchCursor(config, persisted); },
  };
  const tick = async (stepMs = intervalMs) => { const result = await runDispatchTick(config, cursor, effects, () => instantMs); instantMs += stepMs; return result; };
  const attemptsOf = (key: string) => registrations.filter(entry => entry.key === key);
  // What a refused launch must never leave behind, however many of them a day earns.
  const assertNothingAccumulates = async () => {
    assert.deepEqual((await readReviewLedger(root)).reviews, [], 'a refused launch leaves no ledger reservation behind');
    assert.deepEqual(await readdir(join(credentialDirectory, 'sessions')).catch(() => [] as string[]), [], 'a refused launch leaves no session directory behind');
    assert.deepEqual(await readdir(worktrees).catch(() => [] as string[]), [], 'a refused launch leaves no checkout behind');
  };
  assert.deepEqual(owedPostMergeReviews(items).map(item => item.key).sort(), keys, 'the three delivered items each owe their post-merge review');

  // Day one and two at the loop's own cadence, the refusal's cause standing: twelve widening
  // attempts and then one probe per standstill hour per request, never one per tick.
  const cadenceEnd = instantMs + 48 * hour;
  let sinceCheck = 0;
  while (instantMs < cadenceEnd) {
    await tick();
    if (++sinceCheck >= 120) { sinceCheck = 0; await assertNothingAccumulates(); }
  }
  for (const key of keys) {
    const attempts = attemptsOf(key);
    assert.ok(attempts.length >= dispatchFailureLimit + 44 && attempts.length <= dispatchFailureLimit + 50,
      `${key} earned its twelve widening attempts and one probe a standstill hour, not one a tick (${attempts.length})`);
    for (let index = dispatchFailureLimit; index < attempts.length; index++)
      assert.ok(attempts[index].at - attempts[index - 1].at >= postMergeRefusalProbeMs - minute,
        `${key}'s probes stay an hour apart (gap ${Math.round((attempts[index].at - attempts[index - 1].at) / minute)} min before attempt ${index + 1})`);
  }
  // At most one attempt per request per standstill hour, plus the bounded widening backoff each
  // request spends once: the day's attempt budget, never a launch per tick.
  const hours = Math.round((cadenceEnd - base.getTime()) / hour);
  assert.ok(registrations.length <= hours * keys.length + keys.length * dispatchFailureLimit,
    `${registrations.length} attempts over ${hours}h: at most one per request per hour plus the backoff, not one per tick`);

  // Then hourly, past the clamp: every request's count reaches the schema's 1000 and stays there,
  // the probe going on all the while, and the production cursor writer persists every tick of it.
  while (keys.some(key => (cursor.failures[requestIdOf(key)]?.attempts ?? 0) < dispatchAttemptCeiling)) await tick(hour);
  for (const key of keys) assert.equal(cursor.failures[requestIdOf(key)]!.attempts, dispatchAttemptCeiling, `${key}'s refusals count to the clamp and no further`);
  const clamped = attemptsOf(keys[0]).length;
  for (let guard = 0; guard < 6; guard++) await tick(hour);
  for (const key of keys) {
    assert.equal(cursor.failures[requestIdOf(key)]!.attempts, dispatchAttemptCeiling, `${key}'s count holds at the clamp while the probe goes on`);
    assert.ok(attemptsOf(key).length >= clamped + 6, `${key} is still probed hourly at the clamp, not stranded silently`);
  }
  const persisted = dispatchCursorSchema.parse(JSON.parse(await readFile(dispatchCursorPath(config), 'utf8')));
  assert.deepEqual(keys.map(key => persisted.failures[requestIdOf(key)]!.attempts), [dispatchAttemptCeiling, dispatchAttemptCeiling, dispatchAttemptCeiling], 'the cursor on disk carries the clamped counts the production writer accepted');
  await assertNothingAccumulates();

  // The cause is gone: the next hourly probe launches each request exactly once through the real
  // path — session recorded, nothing refused — and no probe ever comes again.
  const stranded = Object.fromEntries(keys.map(key => [key, attemptsOf(key).length]));
  cause = false;
  await tick(hour);
  const ledger = await readReviewLedger(root);
  for (const [index, key] of keys.entries()) {
    const attempts = attemptsOf(key);
    assert.equal(attempts.length, stranded[key] + 1, `${key} launched exactly once on the first probe past the cause`);
    assert.equal(cursor.failures[requestIdOf(key)], undefined, `${key}'s refusal record is cleared by its launch`);
    const records = ledger.reviews.filter(record => record.requestId === requestIdOf(key));
    assert.equal(records.length, 1, `${key} holds one session for its request`);
    assert.deepEqual([records[0].state, records[0].mode, records[0].postMerge, records[0].pr > 0, records[0].sha], ['pending', 'control-plane', true, true, M], `${key}'s session is the post-merge review of the merge commit, on the ledger with a positive pr`);
    assert.deepEqual(attempts.at(-1), { key, at: attempts.at(-1)!.at, postMerge: true, head: M, baseTip: B }, `${key}'s launch is registered as the post-merge review of the merge commit against its parent`);
  }
  // The recovery's launches also leave the sessions' shared verification-slot directory under the
  // managed root; a session checkout is a managed `graphyard-<kind>-…` directory, and that is what is counted.
  const directories = (path: string, managed = false) => readdir(path, { withFileTypes: true }).catch(() => [] as { name: string; isDirectory(): boolean }[])
    .then(entries => entries.filter(entry => entry.isDirectory() && (!managed || /^graphyard-(proof|review|approval|trial)-/.test(entry.name))).length);
  assert.equal(await directories(join(credentialDirectory, 'sessions')), keys.length, 'each recovery holds its own session directory');
  assert.equal(await directories(worktrees, true), keys.length, 'each recovery holds its own checkout');
  for (let guard = 0; guard < 48; guard++) await tick(hour);
  for (const key of keys) assert.equal(attemptsOf(key).length, stranded[key] + 1, `${key} is never probed again once its request launched`);
  assert.deepEqual((await readReviewLedger(root)).reviews.filter(record => record.state === 'pending').map(record => record.key).sort(), keys, 'the recovered sessions still hold the requests');
});
