import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Observation, Work } from '../src/model.js';
import type { MasterConfig } from '../src/master.js';
import { emptyDaemonState, type DaemonAction, type DaemonEffects } from '../src/master-daemon.js';
import { cappedReview, cappedReworkBinding, cappedRevisionMark } from '../src/daemon/decisions.js';
import { emptyHeldDecisions } from '../src/daemon/decision-reads.js';
import { answeredRereviewKey, cappedEscalationKey, cappedRereviewKey, refusedAnswerStanding, reviewCapStep, stalledReviewCapAttention } from '../src/daemon/cycle-review-cap.js';
import { workAttentionOwner } from '../src/master/attention.js';
import type { Cycle } from '../src/daemon/cycle.js';

// GY-1813, the follow-up the approver named in refused capped rework decision cd9562b0 (the
// graphyard-reviewer[bot] AC-1 finding on 5a745ea0bacb, from GY-1810): on a head whose change request
// was already withdrawn twice, the round's third capped rework cites the refused reworks it must
// answer — the first and the second refusal — and is itself refused after the third change request it
// was asked for. `refusedAnswerStanding` then judged neither refusal the change request follows: the
// second refusal was dropped because the newer refused request cites it, while the newer one was
// excluded for being requested after the review. The escalation row cited only the first refusal, so
// master status told the master to answer one refusal where two stood.

const H = '3c5d6e7f8a9b'.padEnd(40, '0'), B = 'd1'.padEnd(40, 'f');
const reviewer = 'graphyard-reviewer[bot]';
const config = { url: 'https://graphyard.example', repository: 'owner/project',
  reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.pem', boundAt: '2026-09-24T00:00:00Z' } } as unknown as MasterConfig;
const firstReason = 'Not blocking: the budget overrun is a follow-up item, not a defect of this head.';
const secondReason = 'Still not blocking after the re-review: the same follow-up covers the finding.';
const thirdReason = 'Still not blocking: the finding was judged twice already and nothing new breaks a criterion.';
const firstBody = 'BLOCKING: the refreshed manifest exceeds its size budget.';
const rereviewBody = 'BLOCKING: the soak run still leaks its temporary directory.';
const thirdBody = 'BLOCKING: the soak run still leaks it.';

function capped(body: string, reviewId = 4242, submittedAt = '2026-10-14T17:30:00Z', lane: Work['lane'] = 'medium'): Work {
  const candidate = { sha: H, baseSha: B, pr: 1209, branch: 'graphyard/gy-1813-1', author: 'implementer' };
  const observation = { candidate, checks: [], reviews: [{ reviewer, sha: H, state: 'CHANGES_REQUESTED', id: reviewId, submittedAt, body }], merged: false, mergeSha: null,
    mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at: '2026-10-14T17:31:00Z', prState: 'open', draft: false, baseTip: B, baseTree: B, baseTipContained: true } as unknown as Observation;
  return { id: 'work-1813', key: 'GY-1813', title: 'Soak leak', description: '', type: 'bug', priority: 1, dependencies: [], 
    criteria: [{ id: 'AC-1', text: 'The widget counts every frob.', proofs: ['unit:frob-count'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'review', revision: 41, policyRevision: 1, createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-14T17:31:00Z', stageEnteredAt: '2026-10-14T17:31:00Z', ready: true, epoch: 5,
    lease: null, workspaces: [], candidate, submission: { epoch: 5, pr: 1209 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null,
    gates: [{ name: 'review', passed: false, reasons: ['Outstanding change requests must be resolved through a new review'] }], violations: [],
    lane, systemDriven: true, autoDispatch: { review: null, producers: [], history: [] },
    pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 3, interventions: { blocked: 0, requirements: 0 } } } as unknown as Work;
}

/** A capped rework on the head's binding; `cites` are the refused rework decisions its grounds answer, as the loop writes them. */
const cappedRework = (id: string, state: 'requested' | 'refused', requestedAt: string, refusedAt: string | undefined, refusalReason: string, cites: string[] = []) => ({
  id, action: 'rework', state, requestedAt, approvedBy: null,
  input: { binding: cappedReworkBinding(H, reviewer), previousWorkerStopped: true },
  reason: `[Decided from the GitHub observation taken at 2026-10-14T17:31:00Z of candidate ${H}; if the item has moved since, this request no longer describes it.] ${cappedRevisionMark(1)} GY-1813 is in review round 4, past its cap of 3. Past the review-round cap only an independent approver sends the head back: approve for one more round fixing exactly that finding, or refuse it as non-blocking: the loop then requests it no more, withdraws the change request and has the reviewer re-review the head, listing the findings as FOLLOW-UP.`
    + (cites.length ? ` This rests on different grounds from refused rework decision${cites.length === 1 ? '' : 's'} ${cites.join(', ')}, which ${cites.length === 1 ? 'was' : 'were'} judged on earlier grounds.` : ''),
  refusal: state === 'refused' ? { approver: 'graphyard-approver-graphyard', reason: refusalReason, at: refusedAt } : null,
});
/** The master's hand answer to the first escalation: no grounds binding, citing the first refusal by id. */
const handAnswer = (id: string, requestedAt: string, refusedAt: string, precedent: string[]) => ({
  id, action: 'rework', state: 'refused', requestedAt, approvedBy: null, precedent,
  input: {}, reason: `Re-review head ${H} for one more round fixing exactly the soak leak. This rests on different grounds from refused rework decision ${precedent[0]}, which was judged on earlier grounds.`,
  refusal: { approver: 'graphyard-approver-graphyard', reason: secondReason, at: refusedAt },
});
const D1 = cappedRework('11111111-1c2d-4e5f-8a9b-0c1d2e3f4a5b', 'refused', '2026-10-14T17:32:00.000Z', '2026-10-14T17:37:00.000Z', firstReason);
const D2 = cappedRework('22222222-6f7a-4b8c-9d0e-1f2a3b4c5d6e', 'refused', '2026-10-14T17:41:00.000Z', '2026-10-14T17:42:00.000Z', secondReason, [D1.id]);

function harness(item: Work) {
  const state = emptyDaemonState(config), performed: DaemonAction[] = [];
  const world = { item, history: [D1] as any[], withdrawn: [] as { reviewId: number; message: string }[], wakes: [] as string[] };
  let tick = Date.parse('2026-10-14T17:45:00Z');
  const effects = {
    persist: async () => {}, decide: async () => ({ id: 'unused' }), approver: async () => ({ agentName: 'unused', pane: null }),
    decisions: async () => ({ decisions: world.history }),
    withdrawReview: async (_work: Work, reviewId: number, message: string) => { world.withdrawn.push({ reviewId, message }); },
    wakeObservation: async (work: Work) => { world.wakes.push(work.key); },
  } as unknown as DaemonEffects;
  const cycle = async () => {
    state.cycle++;
    tick += 60_000;
    await reviewCapStep({ config, state, effects, performed, now: () => tick, open: [world.item], snapshot: { work: [world.item], now: new Date(tick).toISOString() },
      heldDecisions: emptyHeldDecisions(), isolate: async (_kind: string, _item: unknown, _name: string, body: () => Promise<unknown>) => body() } as unknown as Cycle);
  };
  return { state, performed, world, cycle };
}

/** Walks one head to the second withdrawal: the first refusal withdraws, the re-review's change request is escalated and `answer`'s refusal withdraws it. */
async function toSecondWithdrawal(run: ReturnType<typeof harness>, answer: Record<string, unknown>) {
  run.world.item = capped(firstBody);
  run.world.history = [D1];
  await run.cycle();
  assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242], 'the first refusal withdraws the change request');
  assert.equal(run.state.actions[cappedRereviewKey(run.world.item, H)]?.state, 'done');
  run.world.item = capped(rereviewBody, 5468008197, '2026-10-14T17:39:00Z');
  run.world.history = [D1, { ...answer, state: 'requested', refusal: null }];
  await run.cycle();
  assert.equal(run.world.withdrawn.length, 1, 'nothing is withdrawn while the second rework stands before its approver');
  run.world.history = [D1, answer];
  await run.cycle();
  assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242, 5468008197], 'the second refusal withdraws the re-review once more');
  assert.equal(run.state.actions[answeredRereviewKey(run.world.item, H)]?.state, 'done');
}

test('unit:third-change-request-cites-both-refusals — GY-1813 AC-1: a third change request that follows the second withdrawal escalates naming the head, the first and second refusals and the answering command, when the newer refused capped rework that cites the second refusal was requested after that review', async () => {
  const run = harness(capped(firstBody));
  await toSecondWithdrawal(run, D2 as unknown as Record<string, unknown>);
  // The third change request lands, and the round's third capped rework — requested after it, citing
  // the refusals it must answer — is refused too, after the review it was asked for.
  run.world.item = capped(thirdBody, 5468009999, '2026-10-14T17:50:00Z');
  assert.equal(cappedReview(run.world.item, config)!.kind, 'escalate');
  const newer = cappedRework('33333333-9d0e-4f2a-8b3c-5d6e7f8a9b0c', 'refused', '2026-10-14T17:55:00.000Z', '2026-10-14T17:58:00.000Z', thirdReason, [D1.id, D2.id]);
  run.world.history = [D1, D2, newer];
  const standing = refusedAnswerStanding(run.world.history, D1, H, '2026-10-14T17:50:00Z');
  assert.equal(standing.answer, null, 'the newer refusal is requested after the review, so it answers it no more than the second one does');
  assert.deepEqual(standing.judged.map(entry => entry.id), [D2.id], 'the second refusal stands: the newer one citing it hides nothing, being requested after the review');
  await run.cycle();
  await run.cycle();
  assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242, 5468008197], 'not withdrawn a third time');
  const escalation = run.state.actions[cappedEscalationKey(run.world.item, H)]!;
  assert.equal(escalation.state, 'done');
  assert.match(escalation.detail, /not withdrawn a third time/);
  assert.ok(escalation.detail.includes(`--precedent ${D1.id},${D2.id}`), escalation.detail);
  assert.ok(escalation.detail.includes(`graphyard master decide GY-1813 rework --precedent ${D1.id},${D2.id} REASON`), escalation.detail);
  assert.equal(escalation.detail.includes(newer.id), false, `the refusal requested after the review is not cited: ${escalation.detail}`);
  assert.equal(run.performed.filter(entry => entry.kind === 'escalation' && entry.detail.includes('not withdrawn a third time')).length, 1, 'the third round escalated once, not on every cycle');

  // Master status shows that escalation as the item's attention row: the head, both refusals, the command.
  const attention = workAttentionOwner(run.world.item, 'gate', Date.parse('2026-10-14T18:20:00Z'));
  assert.match(attention.next, /the loop relaunches the review on its own/, 'the row master status would show is the one that lies');
  const status = stalledReviewCapAttentionOf(run.world.item, escalation, attention);
  assert.match(status.work[0]!.attention!, new RegExp(`review-cap step is stalled on ${H.slice(0, 12)}`));
  assert.ok(status.work[0]!.attention!.includes(escalation.detail), status.work[0]!.attention);
  assert.ok(status.work[0]!.attention!.includes(`--precedent ${D1.id},${D2.id}`), status.work[0]!.attention);
  assert.equal(status.work[0]!.attention!.includes(newer.id), false, 'the post-review refusal is not cited in the row either');
  assert.equal(status.work[0]!.attentionOwner!.next, escalation.detail);
  assert.equal(status.attentionItems[0]!.role, 'master');
  assert.ok(status.attentionItems[0]!.text!.includes(`graphyard master decide GY-1813 rework --precedent ${D1.id},${D2.id} REASON`));
});

test('unit:third-change-request-cites-both-refusals — the second refusal a newer refused capped rework cites stands the same when the loop withdrew the second time on a refused master answer', async () => {
  const answer = handAnswer('44444444-6f7a-4b8c-9d0e-1f2a3b4c5d6e', '2026-10-14T17:40:00.000Z', '2026-10-14T17:43:00.000Z', [D1.id]);
  const run = harness(capped(firstBody));
  await toSecondWithdrawal(run, answer as unknown as Record<string, unknown>);
  assert.match(run.world.withdrawn[1].message, new RegExp(`decision ${D1.id}[\\s\\S]*decision ${answer.id}`), 'the second withdrawal names both refusals');
  // The third change request, then a newer refused capped rework requested after it that cites the second refusal.
  run.world.item = capped(thirdBody, 5468009999, '2026-10-14T17:50:00Z');
  const newer = cappedRework('33333333-9d0e-4f2a-8b3c-5d6e7f8a9b0c', 'refused', '2026-10-14T17:55:00.000Z', '2026-10-14T17:58:00.000Z', thirdReason, [answer.id]);
  run.world.history = [D1, answer, newer];
  const standing = refusedAnswerStanding(run.world.history, D1, H, '2026-10-14T17:50:00Z');
  assert.deepEqual(standing.judged.map(entry => entry.id), [answer.id], 'the second refusal is judged: the newer one citing it was requested after the review');
  assert.equal(standing.judged.some(entry => entry.id === newer.id), false, 'the newer refusal is judged neither');
  await run.cycle();
  await run.cycle();
  assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242, 5468008197], 'not withdrawn a third time');
  const escalation = run.state.actions[cappedEscalationKey(run.world.item, H)]!;
  assert.match(escalation.detail, /not withdrawn a third time/);
  assert.ok(escalation.detail.includes(`--precedent ${D1.id},${answer.id}`), escalation.detail);
  assert.ok(escalation.detail.includes(`graphyard master decide GY-1813 rework --precedent ${D1.id},${answer.id} REASON`), escalation.detail);
  assert.equal(escalation.detail.includes(newer.id), false, `the refusal requested after the review is not cited: ${escalation.detail}`);
  const attention = workAttentionOwner(run.world.item, 'gate', Date.parse('2026-10-14T18:20:00Z'));
  const status = stalledReviewCapAttentionOf(run.world.item, escalation, attention);
  assert.match(status.work[0]!.attention!, new RegExp(`review-cap step is stalled on ${H.slice(0, 12)}`));
  assert.ok(status.attentionItems[0]!.text!.includes(`--precedent ${D1.id},${answer.id}`));
  assert.equal(status.work[0]!.attention!.includes(newer.id), false, 'the post-review refusal is not cited in the row either');
});

/** The review-gate row master status shows for the item, with the escalation in the loop's cursor. */
function stalledReviewCapAttentionOf(item: Work, escalation: { state: string; detail: string }, attention: ReturnType<typeof workAttentionOwner>) {
  return stalledReviewCapAttention(
    { work: [{ key: item.key, stage: item.stage, attention: 'Outstanding change requests must be resolved through a new review', attentionOwner: attention, refusal: { gate: 'review', reason: 'Outstanding change requests must be resolved through a new review' } }],
      attentionItems: [{ subject: item.key, text: 'Outstanding change requests must be resolved through a new review', ...attention }] },
    [item], { actions: { [cappedEscalationKey(item, H)]: escalation } }, 3, Date.parse('2026-10-14T18:20:00Z'));
}
