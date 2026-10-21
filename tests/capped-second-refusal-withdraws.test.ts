import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Observation, Work } from '../src/model.js';
import type { MasterConfig } from '../src/master.js';
import { emptyDaemonState, pruneDaemonState, retainedActions, storeAction, type DaemonAction, type DaemonEffects } from '../src/master-daemon.js';
import { cappedReview, cappedReworkBinding, cappedRevisionMark } from '../src/daemon/decisions.js';
import { emptyHeldDecisions } from '../src/daemon/decision-reads.js';
import { answeredRereviewKey, cappedEscalationKey, cappedFilingKey, cappedRefusalRequest, cappedRereviewKey, refusedAnswerStanding, reviewCapStep } from '../src/daemon/cycle-review-cap.js';
// The one function only this change adds is read off the namespace, so on the base the proof fails as test cases rather than failing to load (GY-1174 exercise).
import * as reviewCapModule from '../src/daemon/cycle-review-cap.js';
const stalledReviewCapAttention = reviewCapModule.stalledReviewCapAttention;
import { agentOwner, workAttentionOwner } from '../src/master/attention.js';
import type { Cycle } from '../src/daemon/cycle.js';

// GY-1810, observed on GY-1802 (medium lane) and twice on GY-1773, 2026-10-14: head 2beea67af645 was
// past the review-round cap. The loop requested capped rework fd7bc432; the approver refused it as
// non-blocking, so the review-cap step withdrew the change request and the reviewer re-reviewed at
// 17:39Z. The re-review requested changes again; the loop requested a second capped rework e5b81f93
// with the same binding, and the approver refused it too at 17:42Z. Nothing then acted for 40+
// minutes: the step withdraws a second time only on a refused master answer, and a low or medium
// lane applies a hand rework at once, so that answer can never exist there. Master status showed
// "the loop relaunches the review on its own" while no review request existed.

const H = '2beea67af645'.padEnd(40, '0'), B = 'b1'.padEnd(40, 'f');
const reviewer = 'graphyard-reviewer[bot]';
const config = { url: 'https://graphyard.example', repository: 'owner/project',
  reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.pem', boundAt: '2026-09-24T00:00:00Z' } } as unknown as MasterConfig;
const firstReason = 'The finding is real but not blocking: the hotspot budget is a follow-up, not a defect of this head. File it as its own item and let the reviewer list it as a FOLLOW-UP.';
const secondReason = 'Still not blocking after the re-review: the same follow-up covers it, and nothing here breaks a criterion.';
const firstBody = 'BLOCKING: former hotspot files exceed their size budgets.';
const rereviewBody = 'BLOCKING: the soak test still leaks its temporary directory.';
const thirdBody = 'BLOCKING: the soak test still leaks it.';

function capped(body: string, reviewId = 4242, submittedAt = '2026-10-14T17:30:00Z', lane: Work['lane'] = 'medium'): Work {
  const candidate = { sha: H, baseSha: B, pr: 1205, branch: 'graphyard/gy-1802-2', author: 'implementer' };
  const observation = { candidate, checks: [], reviews: [{ reviewer, sha: H, state: 'CHANGES_REQUESTED', id: reviewId, submittedAt, body }], merged: false, mergeSha: null,
    mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at: '2026-10-14T17:31:00Z', prState: 'open', draft: false, baseTip: B, baseTree: B, baseTipContained: true } as unknown as Observation;
  return { id: 'work-1802', key: 'GY-1802', title: 'Soak leak', description: '', type: 'bug', priority: 1, dependencies: [], 
    criteria: [{ id: 'AC-1', text: 'The widget counts every frob.', proofs: ['unit:frob-count'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'review', revision: 40, policyRevision: 1, createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-14T17:31:00Z', stageEnteredAt: '2026-10-14T17:31:00Z', ready: true, epoch: 5,
    lease: null, workspaces: [], candidate, submission: { epoch: 5, pr: 1205 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null,
    gates: [{ name: 'review', passed: false, reasons: ['Outstanding change requests must be resolved through a new review'] }], violations: [],
    lane, systemDriven: true, autoDispatch: { review: null, producers: [], history: [] },
    pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 3, interventions: { blocked: 0, requirements: 0 } } } as unknown as Work;
}

/** The master's follow-up, filed after the first refusal and naming the item. */
const followUp = { id: 'work-1804', key: 'GY-1804', title: 'Former hotspot files exceed their size budgets after GY-1802', description: 'Named by the refusal of GY-1802\'s capped rework.', stage: 'backlog', createdAt: '2026-10-14T17:44:00Z' } as unknown as Work;

/** The capped rework the loop requested for the head under policy revision 1: one per round, same binding both times. */
const cappedRework = (id: string, state: 'requested' | 'refused', requestedAt: string, refusedAt?: string) => ({
  id, action: 'rework', state, requestedAt, approvedBy: null,
  input: { binding: cappedReworkBinding(H, reviewer), previousWorkerStopped: true },
  reason: `[Decided from the GitHub observation taken at 2026-10-14T17:31:00Z of candidate ${H}; if the item has moved since, this request no longer describes it.] ${cappedRevisionMark(1)} GY-1802 is in review round 4, past its cap of 3. Past the review-round cap only an independent approver sends the head back: approve for one more round fixing exactly that finding, or refuse it as non-blocking: the loop then requests it no more, withdraws the change request and has the reviewer re-review the head, listing the findings as FOLLOW-UP.`,
  refusal: state === 'refused' ? { approver: 'graphyard-approver-graphyard', reason: refusedAt === '2026-10-14T17:42:00.000Z' ? secondReason : firstReason, at: refusedAt } : null,
});
const D1 = cappedRework('fd7bc432-1c2d-4e5f-8a9b-0c1d2e3f4a5b', 'refused', '2026-10-14T17:32:00.000Z', '2026-10-14T17:37:00.000Z');
const D2 = cappedRework('e5b81f93-6f7a-4b8c-9d0e-1f2a3b4c5d6e', 'refused', '2026-10-14T17:41:00.000Z', '2026-10-14T17:42:00.000Z');

function harness(item: Work, others: Work[] = [followUp]) {
  const state = emptyDaemonState(config), performed: DaemonAction[] = [];
  const world = { item, history: [cappedRework(D1.id, 'requested', D1.requestedAt)] as any[], withdrawn: [] as { reviewId: number; message: string }[], wakes: [] as string[] };
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
    await reviewCapStep({ config, state, effects, performed, now: () => tick, open: [world.item], snapshot: { work: [world.item, ...others], now: new Date(tick).toISOString() },
      heldDecisions: emptyHeldDecisions(), isolate: async (_kind: string, _item: unknown, _name: string, body: () => Promise<unknown>) => body() } as unknown as Cycle);
  };
  return { state, performed, world, cycle };
}

test('unit:capped-second-refusal-withdraws — GY-1810 AC-1: an approver refusing the loop\u2019s second capped rework on a head whose change request was already withdrawn once has the review-cap step withdraw the change request once more and re-review the head with both refusals, with no master answer, on a medium lane; a third change request escalates naming the head, both refusals and the answering command', async () => {
  const judged = cappedReview(capped(firstBody), config)!;
  assert.equal(judged.kind, 'escalate');
  // Round 1: the approver refuses the first capped rework; the step withdraws the change request and re-reviews the head.
  const run = harness(capped(firstBody));
  run.world.history = [D1];
  await run.cycle();
  assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242], 'the first refusal withdraws the change request');
  assert.equal(run.state.actions[cappedRereviewKey(run.world.item, H)]?.state, 'done');
  assert.equal(run.state.actions[answeredRereviewKey(run.world.item, H)], undefined, 'no second withdrawal is recorded yet');
  // The re-review requested changes again. The loop's second capped rework, same binding, stands requested: the round is its approver's.
  run.world.item = capped(rereviewBody, 5468008197, '2026-10-14T17:39:00Z');
  run.world.history = [D1, cappedRework(D2.id, 'requested', D2.requestedAt, D2.refusal?.at)];
  await run.cycle();
  assert.equal(run.world.withdrawn.length, 1, 'nothing is withdrawn while the second rework stands before its approver');
  assert.match(run.state.actions[cappedEscalationKey(run.world.item, H)]!.detail, /not withdrawn a second time/);
  // The approver refuses the second capped rework as non-blocking too: the change request is withdrawn once more, with no master answer.
  run.world.history = [D1, D2];
  assert.equal(refusedAnswerStanding([D1, D2], D1 as any, H, '2026-10-14T17:39:00Z').answer?.id, D2.id, 'the second refusal, on the same binding, answers the re-review\u2019s change request');
  await run.cycle();
  assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242, 5468008197]);
  const message = run.world.withdrawn[1].message;
  for (const part of [D1.id, firstReason, D2.id, secondReason, 'GY-1804', `Re-review head ${H} and approve it, listing these findings as FOLLOW-UP threads`, 'Only a finding that breaks a criterion neither refusal judged is BLOCKING'])
    assert.ok(message.includes(part), `${part} in ${message}`);
  assert.match(message, /A change request on this head again is escalated, not withdrawn a third time\.$/);
  const filing = run.state.actions[cappedFilingKey(run.world.item, { sha: H, reviewId: 5468008197 })]!;
  assert.match(filing.detail, /refused the capped rework asked again on this binding \(decision e5b81f93-6f7a-4b8c-9d0e-1f2a3b4c5d6e\)/);
  assert.match(filing.detail, /withdrawn once more/);
  const answered = run.state.actions[answeredRereviewKey(run.world.item, H)]!;
  assert.equal(answered.state, 'done');
  assert.ok(answered.detail.includes(D1.id) && answered.detail.includes(D2.id) && answered.detail.includes('GY-1804'), answered.detail);
  assert.equal(run.performed.filter(entry => entry.kind === 'review' && entry.detail.startsWith('Requested a fresh review')).length, 2, 'the first re-review and this one, nothing more');
  // The launched reviewer reads exactly the request the withdrawal posted.
  assert.equal(cappedRefusalRequest(run.world.item, H, config, run.world.history, [run.world.item, followUp]), message);
  await run.cycle();
  await run.cycle();
  assert.equal(run.world.withdrawn.length, 2, 'withdrawn once per refusal, never more');

  // A third change request on the head escalates once, naming the head, both refusals and the command that answers it.
  run.world.item = capped(thirdBody, 5468009999, '2026-10-14T17:50:00Z');
  await run.cycle();
  await run.cycle();
  assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242, 5468008197], 'not withdrawn a third time');
  const escalation = run.state.actions[cappedEscalationKey(run.world.item, H)]!;
  assert.equal(escalation.state, 'done');
  assert.match(escalation.detail, /not withdrawn a third time/);
  assert.ok(escalation.detail.includes(H.slice(0, 12)), escalation.detail);
  assert.ok(escalation.detail.includes(`--precedent ${D1.id},${D2.id}`), escalation.detail);
  assert.ok(escalation.detail.includes(`graphyard master decide GY-1802 rework --precedent ${D1.id},${D2.id} REASON`), escalation.detail);
  assert.equal(run.performed.filter(entry => entry.kind === 'escalation' && entry.detail.includes('not withdrawn a third time')).length, 1, 'the third round escalated once, not on every cycle');

  // Master status shows that escalation as the item's attention row, in place of the relaunch row the review gate raised.
  const attention = workAttentionOwner(run.world.item, 'gate', Date.parse('2026-10-14T18:20:00Z'));
  assert.match(attention.next, /the loop relaunches the review on its own/, 'the row master status would show is the one that lies');
  const status = stalledReviewCapAttention(
    { work: [{ key: run.world.item.key, stage: run.world.item.stage, attention: 'Outstanding change requests must be resolved through a new review', attentionOwner: attention, refusal: { gate: 'review', reason: 'Outstanding change requests must be resolved through a new review' } }],
      attentionItems: [{ subject: run.world.item.key, text: 'Outstanding change requests must be resolved through a new review', ...attention }] },
    [run.world.item], { actions: { [cappedEscalationKey(run.world.item, H)]: escalation } }, 3, Date.parse('2026-10-14T18:20:00Z'));
  assert.match(status.work[0]!.attention!, new RegExp(`review-cap step is stalled on ${H.slice(0, 12)}`));
  assert.ok(status.work[0]!.attention!.includes(escalation.detail), status.work[0]!.attention);
  assert.equal(status.work[0]!.attentionOwner!.next, escalation.detail);
  assert.equal(status.attentionItems[0]!.role, 'master');
  assert.ok(status.attentionItems[0]!.text.includes(`--precedent ${D1.id},${D2.id}`));
});

test('unit:capped-second-refusal-withdraws — the second withdrawal and the third-round escalation survive a pruned cursor on a low lane: the refusal the record dates after the change request keeps the guard, and a second item\u2019s refusal on another head, high lane, answers nothing', async () => {
  const run = harness(capped(firstBody, 4242, '2026-10-14T17:30:00Z', 'low'));
  run.world.history = [D1];
  await run.cycle();
  run.world.item = capped(rereviewBody, 5468008197, '2026-10-14T17:39:00Z');
  run.world.history = [D1, D2];
  await run.cycle();
  assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242, 5468008197]);
  // A busy fleet retires every withdrawal and re-review row before the third change request lands.
  for (let index = 0; index <= retainedActions; index++)
    storeAction(run.state, `dispatch:other-${index}:1`, { kind: 'dispatch', work: `GY-${index}`, principal: null, epoch: 1, state: 'done', detail: 'launched', attempts: 1, cycle: run.state.cycle, at: new Date(Date.parse('2026-10-14T18:00:00Z') + index).toISOString() });
  pruneDaemonState(run.state);
  assert.equal(run.state.actions[answeredRereviewKey(run.world.item, H)], undefined, 'the re-review row is pruned');
  assert.equal(run.state.actions[cappedRereviewKey(run.world.item, H)], undefined);
  run.world.item = capped(thirdBody, 5468009999, '2026-10-14T18:10:00Z');
  await run.cycle();
  await run.cycle();
  assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242, 5468008197], 'withdrawn twice only');
  const escalation = run.state.actions[cappedEscalationKey(run.world.item, H)]!;
  assert.match(escalation.detail, /not withdrawn a third time/);
  assert.ok(escalation.detail.includes(`--precedent ${D1.id},${D2.id}`), escalation.detail);

  // A refused capped rework bound to another head answers nothing: the strand is read per head.
  const other = { ...D2, id: 'aa0b1c2d-0000-4000-8000-00000000abc1', input: { binding: cappedReworkBinding('c'.repeat(40), reviewer), previousWorkerStopped: true } };
  const two = harness(capped(rereviewBody, 5468008197, '2026-10-14T17:39:00Z', 'high'));
  two.world.history = [D1, other];
  await two.cycle();
  await two.cycle();
  assert.equal(two.world.withdrawn.length, 0, 'another head\u2019s refusal withdraws nothing here');
  assert.match(two.state.actions[cappedEscalationKey(two.world.item, H)]!.detail, /not withdrawn a second time/);
});

test('unit:no-phantom-review-relaunch-row — GY-1810 AC-2: master status shows a stalled review-cap step naming the head, never the relaunch row, while the item has no open review request, no queued request-review action and no pending withdrawal; each of those answers keeps the loop\u2019s row', () => {
  const item = capped(rereviewBody, 5468008197, '2026-10-14T17:39:00Z');
  const at = Date.parse('2026-10-14T18:20:00Z');
  const row = (work: Work) => {
    const owner = workAttentionOwner(work, 'gate', at);
    return { key: work.key, stage: work.stage, attention: 'Outstanding change requests must be resolved through a new review', attentionOwner: owner, refusal: { gate: 'review', reason: 'Outstanding change requests must be resolved through a new review' } };
  };
  const statusOf = (work: Work, cursor: Parameters<typeof stalledReviewCapAttention>[2] = {}) => stalledReviewCapAttention({ work: [row(work)], attentionItems: [{ subject: work.key, text: 'Outstanding change requests must be resolved through a new review', ...ownerOf(work) }] }, [work], cursor, 3, at);
  const ownerOf = (work: Work) => workAttentionOwner(work, 'gate', at);
  assert.match(ownerOf(item).next, /the loop relaunches the review on its own/, 'the stranded item\u2019s row claims the loop relaunches the review');

  // The strand: no escalation row and no watch — the stalled step is named with the bare hold.
  const bare = statusOf(item);
  assert.match(bare.work[0]!.attention!, new RegExp(`review-cap step is stalled on ${H.slice(0, 12)}`));
  assert.match(bare.work[0]!.attention!, /no review request open, none queued and no withdrawal owed/);
  assert.equal(bare.work[0]!.attentionOwner!.role, 'master');
  assert.match(bare.attentionItems[0]!.text!, /review-cap step is stalled/);
  assert.equal(bare.attentionItems.length, 1, 'one row per item, replaced in place');
  // A withdrawal still failing or carried for an earlier candidate sha is not pending for this head.
  const earlier = statusOf(item, { actions: { [`review-cap:${item.id}:${'e'.repeat(40)}:77`]: { state: 'failed', detail: 'carried', attempts: 1 } } });
  assert.match(earlier.work[0]!.attention!, /review-cap step is stalled/, 'a pending withdrawal for an earlier sha does not keep the loop row');
  const pending = statusOf(item, { actions: { [`review-cap:${item.id}:${H}:77`]: { state: 'failed', detail: 'carried', attempts: 1 } } });
  assert.equal(pending.work[0]!.attention, row(item).attention, 'a pending withdrawal for this head keeps the loop row');
  // The item's other attention entries (supervised session, remedy, capacity) keep their own text and next action.
  const others = [{ subject: item.key, text: 'Its supervised session is not answering', ...agentOwner('master', 'graphyard master sessions GY-1802') }, { subject: item.key, text: 'Capacity is spent', ...agentOwner('control plane', 'Wait for a free slot') }];
  const many = stalledReviewCapAttention({ work: [row(item)], attentionItems: [others[0]!, { subject: item.key, text: 'Outstanding change requests must be resolved through a new review', ...ownerOf(item) }, others[1]!] }, [item], {}, 3, at);
  assert.deepEqual(many.attentionItems.filter(entry => !/review-cap step is stalled/.test(entry.text)).map(entry => [entry.text, entry.next]), [['Its supervised session is not answering', 'graphyard master sessions GY-1802'], ['Capacity is spent', 'Wait for a free slot']]);
  assert.equal(many.attentionItems.filter(entry => /review-cap step is stalled/.test(entry.text)).length, 1, 'only the review-gate entry is replaced');

  // The step's escalation stands: the row carries it, naming the head, the refusals and the answering command.
  const detail = `${item.key} is in review round 4, past its cap of 3, and ${reviewer} names a blocking finding on ${H.slice(0, 12)}: not withdrawn a third time. Read the refusals with graphyard master decisions GY-1802, then request the rework with graphyard master decide GY-1802 rework --precedent id1,id2 REASON`;
  const escalated = statusOf(item, { actions: { [`escalation:review-cap:${item.id}:${H}`]: { state: 'done', detail } } });
  assert.ok(escalated.work[0]!.attention!.includes(detail));
  assert.match(escalated.work[0]!.attention!, new RegExp(`stalled on ${H.slice(0, 12)}`));
  assert.ok(escalated.attentionItems[0]!.next!.includes('graphyard master decide GY-1802 rework --precedent'));

  // No escalation yet, but the round's rework decision stands before its approver: the row names that wait.
  const watched = statusOf(item, { approvals: { 'decision:rework:watch': { work: item.key, action: 'rework', decision: 'd1-id', settledAt: null, agentName: 'graphyard-approver-graphyard' } } });
  assert.match(watched.work[0]!.attention!, /rework decision d1-id stands before its independent approver \(graphyard-approver-graphyard\)/);
  assert.equal(watched.work[0]!.attentionOwner!.next, 'graphyard master decisions GY-1802');

  // An open review request for the head answers the state: the loop's row stands.
  const requested = { ...item, reviewRequest: { sha: H, baseSha: B, policyRevision: 1, createdAt: '2026-10-14T18:00:00Z', commentId: 99 } } as Work;
  assert.equal(statusOf(requested).work[0]!.attention, row(item).attention, 'an open review request keeps the loop\u2019s row');

  // A queued request-review action answers it too: no change request on the head, a review is genuinely what is next.
  const clear = capped(firstBody);
  clear.observation!.reviews = [];
  assert.match(ownerOf(clear).next, /the loop relaunches the review on its own/);
  assert.equal(statusOf(clear).work[0]!.attention, row(item).attention, 'a queued request-review keeps the loop\u2019s row');

  // A withdrawal still owed or retried answers it: the loop is on its way to the re-review.
  const withdrawing = statusOf(item, { actions: { [`review-cap:${item.id}:${H}:5468008197`]: { state: 'failed', detail: 'withdrawing it failed once' } } });
  assert.equal(withdrawing.work[0]!.attention, row(item).attention, 'a pending withdrawal keeps the loop\u2019s row');

  // A withdrawal that failed its last permitted attempt is escalated, not retried: the stalled step is named.
  const exhausted = statusOf(item, { actions: { [`review-cap:${item.id}:${H}:5468008197`]: { state: 'failed', detail: 'withdrawing it failed 5 times', attempts: 5 } } });
  assert.match(exhausted.work[0]!.attention!, /review-cap step is stalled/, 'an exhausted withdrawal is not pending');
  const retrying = statusOf(item, { actions: { [`review-cap:${item.id}:${H}:5468008197`]: { state: 'failed', detail: 'withdrawing it failed 4 times', attempts: 4 } } });
  assert.equal(retrying.work[0]!.attention, row(item).attention, 'a retryable failure keeps the loop\u2019s row');

  // A binding agent-review changes-requested verdict (no GitHub review) holds the head the same way.
  const agentHeld = capped(rereviewBody, 5468008197, '2026-10-14T17:39:00Z');
  agentHeld.observation!.reviews = [];
  agentHeld.policy = { ...agentHeld.policy, reviewProvider: 'agent' };
  agentHeld.reviewRequest = { sha: H, baseSha: B, policyRevision: agentHeld.policyRevision, createdAt: '2026-10-14T18:00:00Z', commentId: 99 } as Work['reviewRequest'];
  agentHeld.observation!.agentReview = { provider: 'agent', sha: H, approved: false, reason: 'changes', requestId: 99, verdict: 'changes-requested' };
  assert.match(statusOf(agentHeld).work[0]!.attention!, /review-cap step is stalled/, 'a binding agent verdict holds the head');
});
