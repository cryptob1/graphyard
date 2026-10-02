import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import type { ActionRow } from '../src/model/actions.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { openReviewConflict, reconcileReviewConflict } from '../src/model/review-conflict.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { bindReviewer, launchReview, readReviewLedger, saveReviewerProfile, updateReviewLedger, type ReviewRecord } from '../src/reviewer.js';
import { emptyDispatchCursor, runDispatchTick, verdictIngestGraceMs, type DispatchEffects } from '../src/auto-dispatch.js';
import { controlPlaneHandlers } from '../src/executor.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1083: eleven review-convergence faults in 24 hours, every one a review-conflict: the reviewer
// App posted two verdicts on one head for one review request. Each had the same cause. The first
// reviewer session posted its verdict, and the loop's reconciliation, reading GitHub directly,
// settled its ledger record `completed` with that verdict. The control plane closes the request
// only once its own observation reads the verdict, minutes later, and in that window a launcher —
// the executor's request-review row (GY-957, GY-811, GY-566, GY-453, GY-887, GY-980, GY-1078) or
// the loop's tick past its ingest grace (GY-806, GY-980) — still read the request as open, found no
// pending session, and launched a second one whose verdict conflicted with the first.
// The test is named for the proof it produces: manual:fault-class-review-convergence.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const reviewer = 'graphyard-reviewer[bot]';
const base = '55193b8c5915665695b2205451be306005418a6d';

/** The instances the item lists: the request, the head, and the two verdicts it collected. */
const instances = [
  { key: 'GY-957', pr: 508, sha: 'ae44f1d80984fb253687f9021d735e40cbcdcc41', policyRevision: 3, requestId: '62f0b3310b67cff0dcd3dddcb35c9426', verdicts: [[5380473623, 'APPROVED', '2026-10-01T14:10:11Z'], [5380535751, 'APPROVED', '2026-10-01T14:14:11Z']] },
  { key: 'GY-811', pr: 423, sha: '538ae93e4f6b69609b7991bc146e76cc1bf8c071', policyRevision: 3, requestId: '4b0856dad35128b4e7aa09b6bafa2e52', verdicts: [[5380663864, 'APPROVED', '2026-10-01T14:23:48Z'], [5380725036, 'APPROVED', '2026-10-01T14:28:34Z']] },
  { key: 'GY-566', pr: 319, sha: '7d59553d91f2639af98adcbc6e6f2813b367d03b', policyRevision: 6, requestId: 'cc67630602459244674f7f88c4300917', verdicts: [[5380663355, 'APPROVED', '2026-10-01T14:23:46Z'], [5380736673, 'APPROVED', '2026-10-01T14:29:30Z']] },
  { key: 'GY-453', pr: 259, sha: '0ed81aca26cddf69c939b3f0a2c958fea1405b40', policyRevision: 6, requestId: 'b2071dfa35e621fbe396ca86b6e9a2bb', verdicts: [[5380818493, 'CHANGES_REQUESTED', '2026-10-01T14:35:51Z'], [5380850347, 'APPROVED', '2026-10-01T14:38:24Z']] },
  { key: 'GY-887', pr: 532, sha: 'c30d44e2d417a6eadfe6512e004f4c441a65170a', policyRevision: 7, requestId: '09ce782846bb782293cd1b8719192a11', verdicts: [[5381040190, 'APPROVED', '2026-10-01T14:51:48Z'], [5381099359, 'APPROVED', '2026-10-01T14:56:09Z']] },
  { key: 'GY-980', pr: 517, sha: '352acbf55baab8e93ded041f102da36e81d09a27', policyRevision: 1, requestId: '66a44a548a387b2157a54efb3c30a8c3', verdicts: [[5381105423, 'APPROVED', '2026-10-01T14:56:32Z'], [5381160175, 'APPROVED', '2026-10-01T15:00:08Z']] },
  { key: 'GY-980', pr: 517, sha: '352acbf55baab8e93ded041f102da36e81d09a27', policyRevision: 1, requestId: 'd66322f7c72fb4e77a246ecae89b91b3', verdicts: [[5381256084, 'APPROVED', '2026-10-01T15:07:29Z'], [5381303222, 'APPROVED', '2026-10-01T15:11:02Z']] },
  { key: 'GY-980', pr: 517, sha: '352acbf55baab8e93ded041f102da36e81d09a27', policyRevision: 1, requestId: 'd6359c2b62d0e99b8b0f24b9af9f3606', verdicts: [[5381431311, 'CHANGES_REQUESTED', '2026-10-01T15:19:53Z'], [5381484516, 'CHANGES_REQUESTED', '2026-10-01T15:23:18Z']] },
  { key: 'GY-806', pr: 379, sha: '5e256d8e35a0e24212ce53048e239b0dc84ec824', policyRevision: 8, requestId: 'b55399e22b4a27d9b76356f00075cfcd', verdicts: [[5381761578, 'APPROVED', '2026-10-01T15:42:28Z'], [5381846857, 'APPROVED', '2026-10-01T15:49:03Z']] },
  { key: 'GY-980', pr: 517, sha: '10a3fc80dadceeae658f9efed0561791bfa23ea8', policyRevision: 1, requestId: '82dedacfd50b725aa37099ecd0eef31a', verdicts: [[5381855589, 'APPROVED', '2026-10-01T15:49:40Z'], [5381964180, 'APPROVED', '2026-10-01T15:57:09Z']] },
  { key: 'GY-1078', pr: 542, sha: '47cfe365bc8896c33e60e445b7f8ea93cff4e35a', policyRevision: 2, requestId: '7a299609280f5b2de5aba83268c85885', verdicts: [[5382558290, 'CHANGES_REQUESTED', '2026-10-01T16:46:59Z'], [5382590067, 'CHANGES_REQUESTED', '2026-10-01T16:49:43Z']] },
] as const;
type Instance = typeof instances[number];

/** The item as the launchers' snapshot read it: submitted, proven, and its review request still open. */
function item(instance: Instance, observedAt = new Date(Date.now() - verdictIngestGraceMs - 120_000).toISOString()): Work {
  // Read before the loop settled the first session: the window the instances fell in.
  const candidate = { sha: instance.sha, baseSha: base, pr: instance.pr, branch: `graphyard/${instance.key.toLowerCase()}-1`, author: 'implementer' };
  const observation: Observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at: observedAt,
    prState: 'open', draft: false, baseTip: base, baseTree: '7b'.padEnd(40, '0'), baseTipContained: true };
  const work = { id: `work-${instance.key}`, key: instance.key, title: 'Instance', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Review', proofs: ['unit:x'] }], policy: { checks: [], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: instance.policyRevision,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: instance.pr }, reworkRequested: false,
    scenarioRequirements: [], observation, blocker: null, violations: [],
    evidence: [{ id: 'evidence-1', proof: 'unit:x', sha: instance.sha, baseSha: base, policyRevision: instance.policyRevision, producer: 'ci-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at: new Date().toISOString() }],
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }] } as unknown as Work;
  reconcileAutoDispatch(work, [work], new Date());
  // The request the instance's two verdicts answered.
  work.autoDispatch!.review = { ...work.autoDispatch!.review!, id: instance.requestId };
  return work;
}

async function reviewerMaster() {
  const root = await temporaryDirectory('gy1083'), credentials = await temporaryDirectory('gy1083-cred');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinator = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wE' }, coordinator as typeof fetch);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentials, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude', concurrency: 2 });
  const tabs: string[] = [];
  const run = (_command: string, args: string[]) => {
    if (args[0] === 'tab' && args[1] === 'create') { const pane = `pane-${tabs.length + 1}`; tabs.push(pane); return JSON.stringify({ result: { root_pane: { pane_id: pane, tab_id: `tab-${tabs.length}` } } }); }
    return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
  const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
  return { root, run, mint, tabs, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

/** The first session, settled by the loop the moment GitHub listed its verdict, `closedMsAgo` before the launch. */
function answered(instance: Instance, closedMsAgo: number): ReviewRecord {
  const [id, state, submittedAt] = instance.verdicts[0];
  const closedAt = new Date(Date.now() - closedMsAgo).toISOString();
  return { id: randomUUID(), key: instance.key, pr: instance.pr, sha: instance.sha, baseSha: base, policyRevision: instance.policyRevision, profile: 'claude-reviewer',
    agentName: `review-claude-1-${instance.requestId.slice(0, 8)}`, pane: null, sessionDirectory: '/nonexistent/session', requestedAt: new Date(Date.now() - closedMsAgo - 300_000).toISOString(),
    tokenExpiresAt: new Date(Date.now() + 3_000_000).toISOString(), requestId: instance.requestId, attempt: 1, state: 'completed', acknowledgedAt: closedAt, closedAt,
    verdict: { state, reviewer, reviewId: id, submittedAt } };
}

/** The conflict the instance raised, replayed from its two verdicts as the observation read them. */
function conflictFrom(work: Work, verdicts: readonly (readonly [number, string, string])[]) {
  // Observed one at a time, as the control plane read them.
  for (const [index] of verdicts.entries()) {
    work.observation = { ...work.observation!, reviews: verdicts.slice(0, index + 1).map(([id, state, submittedAt]) => ({ id, reviewer, sha: work.candidate!.sha, state, submittedAt })) };
    reconcileReviewConflict(work, new Date());
  }
  return openReviewConflict(work);
}

for (const [index, instance] of instances.entries()) {
  test(`manual:fault-class-review-convergence — GY-1083 instance ${index + 1}, ${instance.key} request ${instance.requestId.slice(0, 8)}: a request a settled session already answered launches no second reviewer`, async () => {
    // What the instance was: the two verdicts on one request conflict, and neither reaches the gates.
    const replay = item(instance);
    const conflict = conflictFrom(replay, instance.verdicts);
    assert.ok(conflict, 'two verdicts on the request conflict');
    assert.deepEqual(conflict!.verdicts.map(verdict => verdict.id), instance.verdicts.map(([id]) => id));
    assert.equal(conflict!.requestId, instance.requestId);
    // One verdict on the request is no conflict: it reaches the gates as the request's answer.
    const single = item(instance);
    assert.equal(conflictFrom(single, instance.verdicts.slice(0, 1)), null);
    assert.equal(single.observation!.reviews.length, 1);

    const master = await reviewerMaster();
    try {
      const config = await loadMasterConfig(master.root);
      const work = item(instance);
      const request = work.autoDispatch!.review!;
      assert.equal(request.state, 'requested', 'the launchers read the request as still open');
      const first = answered(instance, verdictIngestGraceMs + 60_000);
      await updateReviewLedger(master.root, ledger => { ledger.reviews = [first]; });

      // The executor's request-review row, as in GY-957, GY-811, GY-566, GY-453, GY-887, GY-980 and GY-1078.
      const handlers = controlPlaneHandlers(() => config, {
        snapshot: async () => ({ work: [work], now: new Date().toISOString() }), mutate: async () => ({}), agents: () => [],
        workerCredentials: async () => ({}), producerCredentials: async () => ({}), dispatchWorker: async () => ({}), launchProducer: async () => ({}), merge: async () => ({}), observeDeployment: async () => ({}) as any,
        launchReview: (target, dispatch, herdr, observedAt) => launchReview(master.root, target, 'claude-reviewer', herdr, observedAt, { run: master.run, mint: master.mint, requestId: dispatch.id }),
      });
      const action = { id: 'action-1', work: work.id, key: work.key, gate: 'review', kind: 'request-review', inputs: { kind: 'request-review', provider: 'github', requestId: request.id, pr: instance.pr, sha: instance.sha, baseSha: base, policyRevision: instance.policyRevision } } as unknown as ActionRow;
      const settled = await handlers['request-review']!(action, { id: 'exec-1', host: 'h' });
      assert.match(String(settled), new RegExp(`already answered by reviewer session ${first.agentName} with ${instance.verdicts[0][1]} \\(review ${instance.verdicts[0][0]}\\)`));

      // The loop's tick past its ingest grace, as in GY-806 and GY-980.
      const tick = await runDispatchTick(config, emptyDispatchCursor(config), {
        snapshot: async () => ({ work: [work], now: new Date().toISOString() }), agents: () => [],
        credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
        reconcileReviews: async () => ({ reviews: (await readReviewLedger(master.root)).reviews }), reconcileProducers: async () => ({ producers: [] }),
        launchReview: (target, dispatch, profile, herdr, observedAt) => launchReview(master.root, target, profile.name, herdr, observedAt, { run: master.run, mint: master.mint, requestId: dispatch.id }),
        launchProducer: async () => { throw new Error('no producer is under test'); }, persist: async () => {},
      } satisfies DispatchEffects);
      assert.deepEqual(tick.launched, [], 'the loop launched no second session');
      assert.deepEqual(tick.refused, [], 'an answered request is waited on, not counted as a refused launch');
      assert.ok(tick.waiting.some(wait => wait.requestId === instance.requestId && /already answered with/.test(wait.reason)), JSON.stringify(tick.waiting));

      // And `master review`, the hand launcher, for the same request.
      await assert.rejects(launchReview(master.root, work, 'claude-reviewer', [], new Date().toISOString(), { run: master.run, mint: master.mint, requestId: request.id }), /one request yields one verdict/);

      assert.deepEqual(master.tabs, [], 'no second reviewer session was started');
      const ledger = await readReviewLedger(master.root);
      assert.deepEqual(ledger.reviews.map(record => record.id), [first.id], 'the request keeps its one session');
    } finally { await master.cleanup(); }
  });
}

test('manual:fault-class-review-convergence — GY-1083: a request whose answer was withdrawn, and a fresh request on the same head, are still launched', async () => {
  const instance = instances[0];
  const master = await reviewerMaster();
  try {
    const work = item(instance);
    // A dismissed approval is no answer: reconciliation records it failed, and the request is relaunched.
    const dismissed: ReviewRecord = { ...answered(instance, 60_000), state: 'failed', verdict: { ...answered(instance, 60_000).verdict!, state: 'DISMISSED' } };
    await updateReviewLedger(master.root, ledger => { ledger.reviews = [dismissed]; });
    await launchReview(master.root, work, 'claude-reviewer', [], new Date().toISOString(), { run: master.run, mint: master.mint, requestId: instance.requestId });
    assert.equal(master.tabs.length, 1, 'the withdrawn answer is reviewed again');
    // The fresh request a conflict opens on the same head is a different request: it is launched.
    await updateReviewLedger(master.root, ledger => { ledger.reviews = [answered(instance, 60_000)]; });
    const fresh = 'f'.repeat(32);
    work.autoDispatch!.review = { ...work.autoDispatch!.review!, id: fresh };
    await launchReview(master.root, work, 'claude-reviewer', [], new Date().toISOString(), { run: master.run, mint: master.mint, requestId: fresh });
    assert.equal(master.tabs.length, 2, 'the fresh request is launched');
    // A verdict the control plane observed withdrawn after the loop settled it answers nothing either:
    // GitHub listed it dismissed, or no longer listed it, so the request is reviewed again.
    const withdrawn = item(instance, new Date().toISOString());
    for (const reviews of [[{ id: instance.verdicts[0][0], reviewer, sha: instance.sha, state: 'DISMISSED', submittedAt: instance.verdicts[0][2] }], []]) {
      await updateReviewLedger(master.root, ledger => { ledger.reviews = [answered(instance, 60_000)]; });
      withdrawn.observation = { ...withdrawn.observation!, reviews };
      await launchReview(master.root, withdrawn, 'claude-reviewer', [], new Date().toISOString(), { run: master.run, mint: master.mint, requestId: instance.requestId });
    }
    assert.equal(master.tabs.length, 4, 'each withdrawn answer is reviewed again');
  } finally { await master.cleanup(); }
});
