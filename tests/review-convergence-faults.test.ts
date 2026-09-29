import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Observation, Work } from '../src/model.js';
import { dismissedReviewIds } from '../src/github.js';
import { openReviewConflict, reconcileReviewConflict } from '../src/model/review-conflict.js';
import { trackFaults, type FaultRecord } from '../src/model/fault-classes.js';
import { mergeBaseDismissal, mergeBaseDismissalAttention } from '../src/merge-base-ancestry.js';
import { reviewConflictAttention, type ReviewConflict } from '../src/model/review-conflict.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { buildMasterStatus, masterConfigSchema } from '../src/master.js';
import { queueRef } from '../src/merge-queue.js';
import { figureless, wording } from '../src/model/fault-wording.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// GY-486: three review-convergence faults in 24 hours, each counted where no second review event
// happened. The test is named for the proof it produces: manual:fault-class-review-convergence.
//
// - review-conflict on GY-100 (PR #116, head e9a5521c608c): the reviewer App's approval was
//   dismissed by GitHub and the merge broker re-posted it through the same App. GitHub reports one
//   review per identity, so the observation showed only the re-post; the dismissed original stayed
//   standing in the verdict record and the re-post was read as a second verdict for the request.
// - merge-base-dismissed on GY-288, twice: one dismissal (review #5324672415 of 1f1bc8b91d78)
//   stood while the base branch advanced from 0e2108cf789d to ab8fdf6cf47e. The attention line
//   names the base tip, and the fault record kept the letters of a commit hash as wording, so the
//   same standing fault was opened as a new instance.

const sha40 = (prefix: string) => prefix.padEnd(40, '0');
const reviewer = 'graphyard-reviewer[bot]';
const at = (minute: number) => new Date(Date.parse('2026-09-23T21:50:00.000Z') + minute * 60_000);

function gy100(): Work {
  const candidate = { sha: sha40('e9a5521c608c'), baseSha: sha40('b6a984ffc36a'), pr: 116, branch: 'graphyard/gy-100-1', author: 'implementer' };
  const observation: Observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], at: at(0).toISOString(),
    prState: 'open', draft: false, baseTip: candidate.baseSha, baseTipContained: true };
  return { id: 'work-100', key: 'GY-100', title: 'Queue carry', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Carry', proofs: ['unit:x'] }], policy: { checks: [], review: true, reviewProvider: 'github' }, stage: 'merge', revision: 9, policyRevision: 2,
    createdAt: at(0).toISOString(), updatedAt: at(0).toISOString(), stageEnteredAt: at(0).toISOString(), ready: true, epoch: 1, lease: null, workspaces: [], candidate,
    submission: { epoch: 1, pr: 116 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, gates: [], violations: [],
    autoDispatch: { review: { id: '4177d8bcaee33119be12a468eb5d813c', kind: 'review', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 2, requestedAt: at(0).toISOString() }, history: [], producers: [] } } as unknown as Work;
}
/** What github.ts observes from a pull request's full review list: each identity's latest review, and every dismissed one. */
function observe(work: Work, list: { id: number; state: string; submitted_at: string }[], minute: number, base = false) {
  const latest = new Map<string, (typeof list)[number]>();
  for (const review of list) latest.set(reviewer, review);
  work.observation = { ...work.observation!, at: at(minute).toISOString(),
    reviews: [...latest.values()].map(review => ({ id: review.id, reviewer, sha: work.candidate!.sha, state: review.state, submittedAt: review.submitted_at })),
    // The base read only each identity's latest review: it recorded no list of dismissed ones.
    ...(base ? {} : { dismissedReviewIds: dismissedReviewIds(list) }) };
  return reconcileReviewConflict(work, at(minute));
}

test('manual:fault-class-review-convergence — GY-100: an approval GitHub dismissed and the reviewer App re-posted is one verdict, not a conflict', () => {
  const original = { id: 5297208889, state: 'APPROVED', submitted_at: '2026-09-23T21:51:24Z' };
  const repost = { id: 5297255395, state: 'APPROVED', submitted_at: '2026-09-23T21:55:54Z' };
  // The reviewer session's approval is observed.
  for (const run of ['base', 'candidate'] as const) {
    const item = gy100();
    assert.deepEqual(observe(item, [original], 2), []);
    // GitHub dismisses it for a merge-base change and the merge broker re-posts it before the next
    // observation: the list now holds the dismissed original and the re-post, and each identity's
    // latest review is the re-post alone.
    const list = [{ ...original, state: 'DISMISSED' }, repost];
    if (run === 'base') {
      // The original's dismissal is never seen, and the re-post is recorded as a second standing
      // verdict for the request. Before GY-733 that pair was raised as a conflict; the two agree,
      // so since GY-733 it is not one (see the GY-733 tests below).
      observe(item, list, 6, true);
      assert.deepEqual(item.reviewVerdicts!.verdicts.map(verdict => [verdict.id, !!verdict.dismissed]), [[original.id, false], [repost.id, false]], 'the base misses the dismissal');
      continue;
    }
    assert.deepEqual(observe(item, list, 6), [], 'no conflict against the candidate');
    assert.equal(openReviewConflict(item), null);
    assert.deepEqual(item.reviewVerdicts!.verdicts.map(verdict => [verdict.id, !!verdict.dismissed]), [[original.id, true], [repost.id, false]]);
    // The re-posted approval reaches the gates as the one standing verdict.
    assert.deepEqual(item.observation!.reviews.map(review => [review.id, review.state]), [[repost.id, 'APPROVED']]);
  }
});

test('manual:fault-class-review-convergence — GY-100: a second verdict for the request that no dismissal withdrew still conflicts', () => {
  const item = gy100();
  observe(item, [{ id: 11, state: 'APPROVED', submitted_at: '2026-09-23T21:51:24Z' }], 2);
  const transitions = observe(item, [{ id: 11, state: 'APPROVED', submitted_at: '2026-09-23T21:51:24Z' }, { id: 12, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-23T21:52:00Z' }], 3);
  assert.deepEqual(transitions.map(entry => entry.event), ['review.conflicted']);
  assert.deepEqual(openReviewConflict(item)!.verdicts.map(verdict => verdict.id), [11, 12]);
  assert.deepEqual(item.observation!.reviews, [], 'neither verdict reaches the gates');
});

function gy288(baseTip: string): Work {
  const head = '1f1bc8b91d78'.padEnd(40, 'a'), boundBase = 'b6a984ffc36a'.padEnd(40, 'a');
  const candidate = { sha: head, baseSha: boundBase, pr: 288, branch: 'graphyard/gy-288-1', author: 'implementer' };
  return { key: 'GY-288', candidate, observation: { candidate, checks: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], at: '2026-09-26T05:05:00.000Z',
    baseTip, baseTipAncestor: false, baseTipContained: false,
    reviews: [{ id: 5324672415, reviewer, sha: head, state: 'DISMISSED', submittedAt: '2026-09-26T04:40:00Z', dismissal: { mergeBase: true, verdict: 'approved', at: '2026-09-26T05:03:19Z', commit: null } }] } } as unknown as Work;
}

test('manual:fault-class-review-convergence — GY-288: one standing merge-base dismissal is one fault while the base branch advances under it', () => {
  const line = (tip: string) => {
    const work = gy288(tip.padEnd(40, 'a'));
    return { kind: 'merge-base-dismissed' as const, faultClass: 'review-convergence' as const, subject: 'GY-288', text: mergeBaseDismissalAttention('GY-288', mergeBaseDismissal(work)!) };
  };
  const first = line('0e2108cf789d'), second = line('ab8fdf6cf47e');
  // The two lines the loop read differ only in the base branch tip they name.
  assert.match(first.text, /base branch tip 0e2108cf789d/);
  assert.match(second.text, /base branch tip ab8fdf6cf47e/);
  assert.notEqual(first.text, second.text);
  // trackFaults keys a standing fault by its kind, subject and normalised wording. The base
  // normaliser (figureless) kept a hash's letters, so the advance changed the key; the candidate's
  // drops the hash.
  for (const [run, normalise] of [['base', figureless], ['candidate', wording]] as const) {
    if (run === 'base') assert.notEqual(normalise(first.text), normalise(second.text), 'the base keys the advance as another fault');
    else assert.equal(normalise(first.text), normalise(second.text), 'the candidate keys it as the same fault');
  }
  // A lone standing line of its kind keeps its instance when reworded under either normaliser
  // (GY-368), so the key only decides the count once a second fault of the kind stands on the
  // subject — here a dismissal for a changed verdict beside the merge-base one.
  const beside = (entry: typeof first) => ({ ...entry, text: entry.text.replace('for a merge-base change', 'for a changed verdict') });
  const record: FaultRecord = { instances: [], open: {}, failing: {} };
  assert.equal(trackFaults(record, [first, beside(first)], '2026-09-26T05:05:55.157Z').length, 2);
  assert.equal(trackFaults(record, [second, beside(second)], '2026-09-26T05:11:49.761Z').length, 0, 'the advance opens no second instance');
  assert.equal(record.instances.length, 2);
  assert.deepEqual(record.instances.map(entry => entry.lastSeenAt), ['2026-09-26T05:11:49.761Z', '2026-09-26T05:11:49.761Z']);
  assert.match(record.instances[0].text, /ab8fdf6cf47e/, 'the standing instance carries the latest wording');
  // A dismissal that ended and happens again is a new instance, as before.
  trackFaults(record, [], '2026-09-26T05:20:00.000Z');
  assert.equal(trackFaults(record, [second], '2026-09-26T05:30:00.000Z').length, 1);
  // Only moving figures are dropped: a different fault on the subject is still its own instance.
  assert.equal(trackFaults(record, [second, beside(second)], '2026-09-26T05:31:00.000Z').length, 1);
});

test('fault wording drops hex-shaped tokens with a digit, commit hashes or not, and keeps words', () => {
  assert.equal(wording('base branch tip 0e2108cf789d advanced'), wording('base branch tip ab8fdf6cf47e advanced'));
  assert.equal(wording(`head ${sha40('1f1bc8b91d78')} dismissed`), 'head # dismissed');
  // Any 7–40-character hex-shaped token with a digit is dropped, as documented — not only a hash.
  assert.equal(wording('lease beef1234 lapsed'), 'lease # lapsed');
  // A word with no digit, or one too short to be a hash, keeps its letters.
  assert.equal(wording('facade deadbeef stood'), 'facade deadbeef stood');
  assert.equal(wording('run abc123 failed'), 'run abc # failed');
});

// GY-733: three review-convergence faults in 24 hours (GY-100, GY-487, GY-430) after GY-486 shipped.
// The shared cause: the control plane treated a review that had settled as one that had not. It
// kept reporting a conflict left on a delivered item, relaunched a reviewer whose posted verdict
// it had simply not read yet and then withheld both agreeing approvals as a conflict, and counted
// a merge-base dismissal it had already answered. Each test below replays the recorded instance;
// against the base each fails with the fault it recorded, against the candidate the fault does not recur.

const gy100Record = (): ReviewConflict => ({ state: 'conflicted', key: 'GY-100', pr: 116, sha: sha40('e9a5521c608c'), baseSha: sha40('b6a984ffc36a'), policyRevision: 2,
  reviewer, requestId: '4177d8bcaee33119be12a468eb5d813c', at: '2026-09-23T23:40:12.443Z', reason: 'two verdicts',
  verdicts: [{ id: 5297208889, reviewer, state: 'APPROVED', submittedAt: '2026-09-23T21:51:24Z', observedAt: '2026-09-23T21:52:00.000Z', requestId: '4177d8bcaee33119be12a468eb5d813c' },
    { id: 5297255395, reviewer, state: 'APPROVED', submittedAt: '2026-09-23T21:55:54Z', observedAt: '2026-09-23T21:56:00.000Z', requestId: '4177d8bcaee33119be12a468eb5d813c' }] });

test('manual:fault-class-review-convergence — GY-733/GY-100: a conflict record left standing on a delivered item is no fault, and a standing conflict of agreeing verdicts resolves', () => {
  // GY-100 was delivered with the conflict raised on 2026-09-23 still `conflicted` on its record,
  // and master status reported it — and the loop counted it — three days later.
  const delivered = { ...gy100(), stage: 'done', reviewConflict: gy100Record() } as Work;
  assert.deepEqual(reviewConflictAttention([delivered], []), [], 'the base reported "Review of GY-100 head e9a5521c608c (PR #116) is conflicted"');
  assert.deepEqual(reconcileReviewConflict(delivered, at(60)).map(entry => entry.event), ['review.conflict-superseded']);
  assert.equal(openReviewConflict(delivered), null);
  assert.match(delivered.reviewConflict!.resolution!, /the item is done/);
  // The same record on an open item: both verdicts are approvals of the head, so nothing is
  // overturned; the conflict resolves on the next evaluation and the approval reaches the gates.
  const open = { ...gy100(), reviewConflict: gy100Record(), reviewVerdicts: { sha: gy100Record().sha, baseSha: gy100Record().baseSha, policyRevision: 2, verdicts: gy100Record().verdicts } } as Work;
  open.observation = { ...open.observation!, reviews: [{ id: 5297255395, reviewer, sha: open.candidate!.sha, state: 'APPROVED', submittedAt: '2026-09-23T21:55:54Z' }] };
  assert.deepEqual(reconcileReviewConflict(open, at(60)).map(entry => entry.event), ['review.conflict-resolved'], 'the base kept the conflict open until a third review');
  assert.match(open.reviewConflict!.resolution!, /the standing verdicts agree/);
  assert.deepEqual(open.observation!.reviews.map(review => review.id), [5297255395], 'the approval is not withheld');
});

const H430 = sha40('46800e6ad90f'), B430 = sha40('41972215de37'), R430 = 'd3cf5655bf9f834bf29c154482709257';
function gy430(observedAt: string, reviews: Observation['reviews'] = [], reviewIds?: number[]): Work {
  const candidate = { sha: H430, baseSha: B430, pr: 229, branch: 'graphyard/gy-430-1', author: 'implementer' };
  return { id: 'work-430', key: 'GY-430', title: 'Review twice', description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'x', proofs: ['unit:x'] }], policy: { checks: [], review: true, reviewProvider: 'github' }, stage: 'review', revision: 30, policyRevision: 2,
    createdAt: observedAt, updatedAt: observedAt, stageEnteredAt: observedAt, ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 229 },
    reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], gates: [{ name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }],
    observation: { candidate, checks: [], reviews, ...(reviewIds ? { reviewIds } : {}), merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], at: observedAt,
      prState: 'open', draft: false, baseTip: B430, baseTipContained: true },
    autoDispatch: { review: { id: R430, kind: 'review', state: 'requested', provider: 'github', pr: 229, sha: H430, baseSha: B430, policyRevision: 2, requestedAt: '2026-09-26T16:44:56.026Z', reason: 'independent approval required' }, history: [], producers: [] } } as unknown as Work;
}
const first430 = { id: 5326659833, reviewer, sha: H430, state: 'APPROVED', submittedAt: '2026-09-26T17:02:48Z' };
const second430 = { id: 5326702985, reviewer, sha: H430, state: 'APPROVED', submittedAt: '2026-09-26T17:15:52Z' };

test('manual:fault-class-review-convergence — GY-733/GY-430: two approvals answering one request are one answer, not a conflict', () => {
  const item = gy430('2026-09-26T17:09:18.974Z', [first430]);
  assert.deepEqual(reconcileReviewConflict(item, new Date('2026-09-26T17:09:18.974Z')), []);
  // GitHub now reports the second session's approval as the identity's latest.
  item.observation = { ...item.observation!, at: '2026-09-26T17:16:41.853Z', reviews: [second430] };
  assert.deepEqual(reconcileReviewConflict(item, new Date('2026-09-26T17:16:41.853Z')), [], 'the base raised review.conflicted and withheld both approvals');
  assert.equal(openReviewConflict(item), null);
  assert.deepEqual(item.observation.reviews.map(review => review.id), [second430.id], 'the approval reaches the gates');
  // A disagreement on the same request is still the conflict GY-124 withholds.
  const disagreed = gy430('2026-09-26T17:09:18.974Z', [first430]);
  reconcileReviewConflict(disagreed, new Date('2026-09-26T17:09:18.974Z'));
  disagreed.observation = { ...disagreed.observation!, reviews: [{ ...second430, state: 'CHANGES_REQUESTED' }] };
  assert.deepEqual(reconcileReviewConflict(disagreed, new Date('2026-09-26T17:16:41.853Z')).map(entry => entry.event), ['review.conflicted']);
});

test('manual:fault-class-review-convergence — GY-733/GY-430: a reviewer whose posted verdict the observation has not read is not relaunched on a timer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-gy733-'));
  try {
    const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: '/bin/true', repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
      reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: join(directory, 'reviewer.json'), boundAt: '2026-09-26T00:00:00.000Z' },
      reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-3', kind: 'claude' }, { name: 'opencode-reviewer', agentName: 'review-opencode-1', kind: 'opencode' }], producers: [], run: { awaitReviewersMinutes: 0, reviewerProfile: 'claude-reviewer' } });
    // review-claude-3 posted its approval at 17:02:48 and the ledger settled the session on it; GitHub
    // reads were timing out, so the item's observation was still the one from before the approval.
    const records = [{ requestId: R430, state: 'completed', requestedAt: '2026-09-26T17:01:03.997Z', closedAt: '2026-09-26T17:03:10.000Z', profile: 'claude-reviewer', agentName: 'review-claude-3', attempt: 1,
      verdict: { state: 'APPROVED', reviewer, reviewId: first430.id, submittedAt: first430.submittedAt } }];
    let item = gy430('2026-09-26T16:44:56.026Z');
    const launched: string[] = [];
    const effects: DispatchEffects = {
      snapshot: async () => ({ work: [item], now: new Date(clockMs).toISOString() }), agents: () => [],
      credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
      reconcileReviews: async () => ({ reviews: records as never }), reconcileProducers: async () => ({ producers: [] }),
      launchReview: async (_item, _request, profile) => { launched.push(profile.name); }, launchProducer: async () => {}, persist: async () => {},
    } as DispatchEffects;
    // 17:08:18, when the base relaunched the request on review-opencode-1: more than five minutes after the session settled.
    let clockMs = Date.parse('2026-09-26T17:08:18.966Z');
    const cursor = emptyDispatchCursor(config);
    const tick = await runDispatchTick(config, cursor, effects, () => clockMs);
    assert.deepEqual(launched, [], 'the base launched a second reviewer here, whose approval then conflicted with the first');
    assert.match(tick.waiting.find(entry => entry.kind === 'review')!.reason, /posted APPROVED \(review 5326659833\); no further attempt is launched until the observation of 46800e6ad90f reads it/);
    // Still unread an hour later: still no second session.
    clockMs += 3_600_000;
    await runDispatchTick(config, cursor, effects, () => clockMs);
    assert.deepEqual(launched, []);
    // Once the observation has read the approval and the request still stands (the gate refused it), the next attempt launches.
    item = gy430('2026-09-26T18:10:00.000Z', [first430], [first430.id]);
    await runDispatchTick(config, cursor, effects, () => clockMs);
    assert.equal(launched.length, 1, 'a verdict the control plane has read and still does not accept is attempted again');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const H487 = sha40('28d127adb443'), B487 = sha40('8c55d327b18a'), TIP487 = sha40('d399c8aa2ef8'), NEW487 = sha40('cea7af146274');
function gy487(speculation: { tip: string; base: string; restored?: boolean }): Work {
  const candidate = { sha: H487, baseSha: B487, pr: 297, branch: 'graphyard/gy-487-1', author: 'implementer' };
  const dismissal = { reason: 'The merge-base changed after approval.', mergeBase: true, verdict: 'approved', commit: null, at: '2026-09-26T14:07:20Z', by: 'cryptob1' };
  return { id: 'work-487', key: 'GY-487', title: 'Pools', description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'x', proofs: ['unit:x'] }], policy: { checks: [], review: true, reviewProvider: 'github' }, stage: 'merge', revision: 40, policyRevision: 1,
    createdAt: '2026-09-26T08:50:28Z', updatedAt: '2026-09-26T14:07:57.850Z', stageEnteredAt: '2026-09-26T14:07:57.850Z', ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 297 },
    reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], gates: [{ name: 'ready', passed: true, reasons: [] }], queueSequence: 1,
    queue: { sequence: 1, enqueuedAt: '2026-09-26T13:50:00Z', policyRevision: 1, speculation: { ref: queueRef('GY-487'), tip: speculation.tip, base: speculation.base, baseTree: sha40('7e1'), predecessors: [], policyRevision: 1, publishedAt: '2026-09-26T14:07:41.128Z', reviewedHead: sha40('ad2203503bb8'),
      ...(speculation.restored ? { restoredApproval: { reviewer, reviewId: 5326115509, sha: H487, dismissal, at: '2026-09-26T14:07:33.100Z' } } : {}) } },
    observation: { candidate, checks: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/pools.ts'], scopeFiles: [], at: '2026-09-26T14:07:57.000Z', prState: 'open', draft: false,
      baseTip: TIP487, baseTree: sha40('7e1'), baseTipContained: true, baseTipAncestor: false,
      reviews: [{ id: 5326115509, reviewer, sha: H487, state: 'DISMISSED', submittedAt: '2026-09-26T13:58:02Z', dismissal } as Observation['reviews'][number]] } } as unknown as Work;
}

test('manual:fault-class-review-convergence — GY-733/GY-487: a merge-base dismissal the control plane already answered is not a fault', () => {
  const now = '2026-09-26T14:07:57.850Z';
  const line = (item: Work) => buildMasterStatus({ work: [item], now }, [], []).attentionItems.find(entry => entry.subject === 'GY-487' && /merge-base change/.test(entry.text));
  // 14:07:33 the control plane restored the approval on the unchanged head; 14:07:41 it republished the tip onto d399c8aa2ef8.
  assert.equal(line(gy487({ tip: H487, base: B487, restored: true })), undefined, `restored: the base reported "GitHub dismissed graphyard-reviewer[bot]'s approval of 28d127adb443"`);
  assert.equal(line(gy487({ tip: NEW487, base: TIP487 })), undefined, 'republished: the base reported the same line at 14:07:57');
  // A dismissal nothing has answered yet is still reported.
  assert.ok(line(gy487({ tip: H487, base: B487 })), 'an unanswered dismissal stays attention');
});
