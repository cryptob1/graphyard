import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { loadMasterConfig, masterConfigSchema, setupMaster, type MasterConfig } from '../src/master.js';
import { bindReviewer, launchReview, readReviewLedger, saveReviewerProfile, updateReviewLedger, answeringRecord, type ReviewRecord } from '../src/reviewer.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { openReviewConflict, reconcileReviewConflict } from '../src/model/review-conflict.js';
import { cycleFaults, emptyDaemonState, mergeBaseDismissalInMotion, mergeBaseDismissalWaitBoundMs } from '../src/master-daemon.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1140: Recurring review-convergence faults: 3 in 24 hours (threshold 3).
//
// The test is named for the proof it produces: manual:fault-class-review-convergence.
//
// The 3 instances listed on the item:
// 1. 2026-10-03T03:33:32.509Z review-conflict on GY-1092:
//    PR #567, head 36f9cc21edfe, request 6e5e1e3eb515cbec47414e0c7d8ce263.
//    Session review-claude-1-6e5e1e3e posted APPROVED (review 5398736543 at 03:11:48Z), settling the
//    local ledger completed. The control plane's observation advanced its timestamp (observedAt > settledAt),
//    but had not yet ingested the review into observation.reviews. The base withdrawnSinceSettled treated
//    the unobserved verdict as withdrawn, returning null from answeringRecord. A second session
//    (review-opencode-1) was launched for the same request, posting APPROVED (review 5398795791 at 03:31:25Z),
//    triggering a review-conflict.
// 2. 2026-10-03T04:12:38.439Z review-conflict on GY-1052:
//    PR #583, head 1cc41dae969d, request 1573b8fb1705505007c89afb1bd1c16f.
//    Session review-claude-1-1573b8fb posted APPROVED (review 5398896996 at 03:57:56Z). During the
//    ingest lag window, base withdrawnSinceSettled returned true. A second session (review-opencode-1)
//    was launched and posted APPROVED (review 5398937027 at 04:10:53Z), triggering review-conflict.
// 3. 2026-10-03T06:49:32.739Z merge-base-dismissed on GY-1136:
//    PR #612, head 59acbe7f21db. GitHub dismissed approval #5399393530 at 06:47:04Z for a merge-base change.
//    At 06:49:32Z (2.4 minutes later), cycleFaults counted merge-base-dismissed as a review-convergence fault,
//    even though the dismissal was in motion while the queue was actively republishing the tip onto the base.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const reviewer = 'graphyard-reviewer[bot]';

const instances = [
  {
    id: 'review-conflict|GY-1092|2026-10-03T03:33:32.509Z',
    kind: 'review-conflict',
    key: 'GY-1092',
    pr: 567,
    sha: '36f9cc21edfe3dbcffc04816b5417245b0c756d4',
    baseSha: '0252450cf0df35a69c33d7835da0888c3d326a03',
    policyRevision: 3,
    requestId: '6e5e1e3eb515cbec47414e0c7d8ce263',
    firstSession: 'review-claude-1-6e5e1e3e',
    secondSession: 'review-opencode-1',
    verdicts: [
      [5398736543, 'APPROVED', '2026-10-03T03:11:48Z'],
      [5398795791, 'APPROVED', '2026-10-03T03:31:25Z'],
    ] as const,
    windowObservedAt: '2026-10-03T03:20:00.000Z',
    faultAt: '2026-10-03T03:33:32.509Z',
  },
  {
    id: 'review-conflict|GY-1052|2026-10-03T04:12:38.439Z',
    kind: 'review-conflict',
    key: 'GY-1052',
    pr: 583,
    sha: '1cc41dae969d2d9396fcecb74a6aa7cbaaeae8fe',
    baseSha: '7f98c8c221141dfd1645e695d7f1d46b7ff2f65a',
    policyRevision: 1,
    requestId: '1573b8fb1705505007c89afb1bd1c16f',
    firstSession: 'review-claude-1-1573b8fb',
    secondSession: 'review-opencode-1',
    verdicts: [
      [5398896996, 'APPROVED', '2026-10-03T03:57:56Z'],
      [5398937027, 'APPROVED', '2026-10-03T04:10:53Z'],
    ] as const,
    windowObservedAt: '2026-10-03T04:05:00.000Z',
    faultAt: '2026-10-03T04:12:38.439Z',
  },
  {
    id: 'merge-base-dismissed|GY-1136|2026-10-03T06:49:32.739Z',
    kind: 'merge-base-dismissed',
    key: 'GY-1136',
    pr: 612,
    sha: '59acbe7f21db59dbad37dd087796d4ce924c7f0f',
    boundBase: '1bff1d4c42a78f244199c23577d244ebff7754d9',
    baseTip: '362a6ef3c150b07b369c719e7cfbfbe059f13958',
    reviewId: 5399393530,
    dismissedAt: '2026-10-03T06:47:04Z',
    faultAt: '2026-10-03T06:49:32.739Z',
  },
] as const;

function masterConfig(): MasterConfig {
  return masterConfigSchema.parse({
    version: 1,
    url: 'https://graphyard.example',
    credentialFile: '/outside/coordinator.token',
    cliPath: launcher,
    repository: 'owner/project',
    baseBranch: 'main',
    githubAppId: 1234,
    hostId: 'vishrog',
    masterAgentName: 'graphyard-master',
    autoMerge: true,
    mergeMethod: 'merge',
    workers: [],
  });
}

function itemForConflict(instance: typeof instances[0] | typeof instances[1], observedAt: string, reviews: Observation['reviews'] = []): Work {
  const candidate = { sha: instance.sha, baseSha: instance.baseSha, pr: instance.pr, branch: `graphyard/${instance.key.toLowerCase()}-1`, author: 'implementer' };
  const observation: Observation = {
    candidate,
    checks: [],
    reviews,
    merged: false,
    mergeSha: null,
    mergeable: true,
    protected: true,
    files: ['src/a.ts'],
    scopeFiles: [],
    at: observedAt,
    prState: 'open',
    draft: false,
    baseTip: instance.baseSha,
    baseTree: '7b'.padEnd(40, '0'),
    baseTipContained: true,
  };
  const work = {
    id: `work-${instance.key}`,
    key: instance.key,
    title: instance.key,
    description: '',
    type: 'bug',
    priority: 0,
    dependencies: [],
    plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Review', proofs: ['manual:fault-class-review-convergence'] }],
    policy: { checks: [], review: true, reviewProvider: 'github' },
    stage: 'review',
    revision: 1,
    policyRevision: instance.policyRevision,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stageEnteredAt: new Date().toISOString(),
    ready: true,
    epoch: 1,
    lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'implementer' }],
    candidate,
    submission: { epoch: 1, pr: instance.pr },
    reworkRequested: false,
    scenarioRequirements: [],
    observation,
    blocker: null,
    violations: [],
    evidence: [],
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval required'] }],
  } as unknown as Work;
  reconcileAutoDispatch(work, [work], new Date(observedAt));
  work.autoDispatch!.review = { ...work.autoDispatch!.review!, id: instance.requestId };
  return work;
}

async function reviewerMaster() {
  const root = await temporaryDirectory('gy1140'), credentials = await temporaryDirectory('gy1140-cred');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinator = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wE' }, coordinator as typeof fetch);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentials, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude', concurrency: 2 });
  const tabs: string[] = [];
  const run = (_command: string, args: string[]) => {
    if (args[0] === 'tab' && args[1] === 'create') {
      const pane = `pane-${tabs.length + 1}`;
      tabs.push(pane);
      return JSON.stringify({ result: { root_pane: { pane_id: pane, tab_id: `tab-${tabs.length}` } } });
    }
    return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
  const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
  return { root, run, mint, tabs, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

function firstSessionRecord(instance: typeof instances[0] | typeof instances[1]): ReviewRecord {
  const [id, state, submittedAt] = instance.verdicts[0];
  return {
    id: randomUUID(),
    key: instance.key,
    pr: instance.pr,
    sha: instance.sha,
    baseSha: instance.baseSha,
    policyRevision: instance.policyRevision,
    profile: 'claude-reviewer',
    agentName: instance.firstSession,
    pane: null,
    sessionDirectory: '/nonexistent/session',
    requestedAt: new Date(Date.parse(submittedAt) - 300_000).toISOString(),
    tokenExpiresAt: new Date(Date.parse(submittedAt) + 3_600_000).toISOString(),
    requestId: instance.requestId,
    attempt: 1,
    state: 'completed',
    acknowledgedAt: submittedAt,
    closedAt: submittedAt,
    verdict: { state, reviewer, reviewId: id, submittedAt },
  };
}

/** The base implementation of withdrawnSinceSettled that caused GY-1092 and GY-1052. */
function baseWithdrawnSinceSettled(record: ReviewRecord, observation: Work['observation'] | undefined) {
  const listed = observation?.reviews.find(review => review.id === record.verdict!.reviewId);
  if (listed) return !['APPROVED', 'CHANGES_REQUESTED'].includes(listed.state);
  const settledAt = Date.parse(record.closedAt ?? record.verdict!.submittedAt), observedAt = Date.parse(observation?.at ?? '');
  return Number.isFinite(settledAt) && Number.isFinite(observedAt) && observedAt > settledAt;
}

test('manual:fault-class-review-convergence — GY-1140 lists 3 instances across GY-1092, GY-1052, and GY-1136', () => {
  assert.equal(instances.length, 3);
  assert.deepEqual(instances.map(i => i.key), ['GY-1092', 'GY-1052', 'GY-1136']);
});

// ---- GY-1092 & GY-1052: review-conflict during ingest window ---------------------------------------

for (const instance of [instances[0], instances[1]]) {
  test(`manual:fault-class-review-convergence — ${instance.id}: candidate refuses second reviewer during ingest lag, avoiding review-conflict`, async () => {
    // 1. Replay the review-conflict as observed when both verdicts were posted
    const conflictWork = itemForConflict(instance, instance.faultAt);
    conflictWork.observation = {
      ...conflictWork.observation!,
      reviews: instance.verdicts.map(([id, state, submittedAt]) => ({ id, reviewer, sha: instance.sha, state, submittedAt })),
    };
    reconcileReviewConflict(conflictWork, new Date(instance.faultAt));
    const conflict = openReviewConflict(conflictWork);
    assert.ok(conflict, 'two verdicts on the request conflict');
    assert.deepEqual(conflict!.verdicts.map(v => v.id), instance.verdicts.map(([id]) => id));
    assert.equal(conflict!.requestId, instance.requestId);

    // 2. Base reproduction: during the ingest window (observedAt > settledAt, but review not yet in observation.reviews),
    // baseWithdrawnSinceSettled returns true, treating the answer as withdrawn.
    const firstRecord = firstSessionRecord(instance);
    const windowWork = itemForConflict(instance, instance.windowObservedAt, []);
    assert.ok(Date.parse(instance.windowObservedAt) > Date.parse(firstRecord.closedAt!), 'observation was taken after session settled');
    assert.equal(baseWithdrawnSinceSettled(firstRecord, windowWork.observation), true, 'base treats unobserved verdict as withdrawn');

    // 3. Candidate verification: candidate correctly recognises the answer has not been withdrawn.
    const answered = answeringRecord([firstRecord], instance.requestId, instance.sha, windowWork.observation);
    assert.ok(answered, 'candidate finds the completed answering record during ingest lag');
    assert.equal(answered!.agentName, instance.firstSession);

    // 4. In launchReview, candidate refuses second session with ReviewSessionPending.
    const master = await reviewerMaster();
    try {
      await updateReviewLedger(master.root, ledger => { ledger.reviews = [firstRecord]; });
      await assert.rejects(
        launchReview(master.root, windowWork, 'claude-reviewer', [], instance.windowObservedAt, {
          run: master.run,
          mint: master.mint,
          requestId: instance.requestId,
        }),
        /already answered/
      );
      assert.deepEqual(master.tabs, [], 'no second session is launched beside the answered request');
    } finally {
      await master.cleanup();
    }
  });
}

test('manual:fault-class-review-convergence — a verdict actually observed dismissed by GitHub is still recognized as withdrawn', () => {
  const instance = instances[0];
  const firstRecord = firstSessionRecord(instance);

  // Case A: review listed in observation.reviews with state DISMISSED
  const dismissedListed = itemForConflict(instance, instance.windowObservedAt, [
    { id: instance.verdicts[0][0], reviewer, sha: instance.sha, state: 'DISMISSED', submittedAt: instance.verdicts[0][2] },
  ]);
  assert.equal(answeringRecord([firstRecord], instance.requestId, instance.sha, dismissedListed.observation), null);

  // Case B: review unlisted in observation.reviews (superseded by another review), but present in dismissedReviewIds
  const dismissedInIds = itemForConflict(instance, instance.windowObservedAt, []);
  dismissedInIds.observation!.dismissedReviewIds = [instance.verdicts[0][0]];
  assert.equal(answeringRecord([firstRecord], instance.requestId, instance.sha, dismissedInIds.observation), null);
});

// ---- GY-1136: merge-base-dismissed counted while in motion -----------------------------------------

test(`manual:fault-class-review-convergence — ${instances[2].id}: dismissal within wait bound is in motion, not counted as review-convergence fault`, () => {
  const instance = instances[2];
  const candidate = {
    sha: instance.sha,
    baseSha: instance.boundBase,
    pr: instance.pr,
    branch: `graphyard/${instance.key.toLowerCase()}-1`,
    author: 'implementer',
  };
  const observation: Observation = {
    candidate,
    checks: [],
    reviews: [
      {
        id: instance.reviewId,
        reviewer,
        sha: instance.sha,
        state: 'DISMISSED',
        submittedAt: '2026-10-03T06:40:00Z',
        dismissal: {
          mergeBase: true,
          verdict: 'approved',
          at: instance.dismissedAt,
          commit: null,
        },
      } as any,
    ],
    merged: false,
    mergeSha: null,
    mergeable: true,
    protected: true,
    files: ['src/a.ts'],
    scopeFiles: [],
    at: instance.faultAt,
    baseTip: instance.baseTip,
    baseTipAncestor: false,
    baseTipContained: false,
    prState: 'open',
    draft: false,
  };
  const work = {
    id: `work-${instance.key}`,
    key: instance.key,
    title: instance.key,
    description: '',
    type: 'bug',
    priority: 1,
    dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Fault class', proofs: ['manual:fault-class-review-convergence'] }],
    policy: { checks: [], review: true },
    plannedFiles: ['src/'],
    stage: 'merge',
    revision: 1,
    policyRevision: 1,
    createdAt: instance.dismissedAt,
    updatedAt: instance.faultAt,
    stageEnteredAt: instance.dismissedAt,
    ready: true,
    epoch: 1,
    lease: null,
    workspaces: [],
    candidate,
    submission: { epoch: 1, pr: instance.pr },
    reworkRequested: false,
    scenarioRequirements: [],
    evidence: [],
    observation,
    blocker: null,
    gates: [],
    violations: [],
  } as unknown as Work;

  const faultTime = Date.parse(instance.faultAt);
  const dismissalTime = Date.parse(instance.dismissedAt);
  const elapsedMs = faultTime - dismissalTime;
  assert.ok(elapsedMs < mergeBaseDismissalWaitBoundMs, `fault occurred ${elapsedMs / 1000}s after dismissal, within bound`);

  // Candidate: mergeBaseDismissalInMotion is true
  assert.equal(mergeBaseDismissalInMotion(work, faultTime), true, 'candidate identifies dismissal is in motion');

  // Candidate cycleFaults: does NOT emit merge-base-dismissed fault at faultTime
  const config = masterConfig();
  const candidateFaults = cycleFaults(emptyDaemonState(config), [work], faultTime, { config })
    .filter(f => f.subject === instance.key && f.kind === 'merge-base-dismissed');
  assert.deepEqual(candidateFaults, [], 'candidate does not emit merge-base-dismissed while in motion');

  // Not weakened: if the dismissal stands past mergeBaseDismissalWaitBoundMs without being republished or restored,
  // it counts as a review-convergence fault.
  const overdueTime = dismissalTime + mergeBaseDismissalWaitBoundMs + 60_000;
  assert.equal(mergeBaseDismissalInMotion(work, overdueTime), false, 'dismissal past bound is no longer in motion');
  const overdueFaults = cycleFaults(emptyDaemonState(config), [work], overdueTime, { config })
    .filter(f => f.subject === instance.key && f.kind === 'merge-base-dismissed');
  assert.equal(overdueFaults.length, 1, 'dismissal standing past bound counts as a review-convergence fault');
  assert.equal(overdueFaults[0].faultClass, 'review-convergence');
});
