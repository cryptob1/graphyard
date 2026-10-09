import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Observation, Work } from '../src/model.js';
import type { MasterConfig } from '../src/master.js';
import { emptyDaemonState, pruneDaemonState, retainedActions, storeAction, type DaemonAction, type DaemonEffects } from '../src/master-daemon.js';
import { cappedReview, cappedReworkBinding, cappedRevisionMark, neededDecision, refusedCappedRework } from '../src/daemon/decisions.js';
import { emptyHeldDecisions } from '../src/daemon/decision-reads.js';
import { cappedEscalationKey, cappedFilingKey, cappedRefusalRequest, cappedRereviewKey, refusalFollowUps, reviewCapStep } from '../src/daemon/cycle-review-cap.js';
import { actionId, reconcileActions } from '../src/model/actions.js';
import type { NextAction } from '../src/model/next-action.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readCappedRefusal, reviewPrompt } from '../src/reviewer.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1575, observed on GY-1573 (PR #1047, review round 5 of cap 3), 2026-10-09: the reviewer App
// requested changes naming a BLOCKING: finding, the loop requested the capped rework decision, and
// the independent approver refused it as non-blocking, naming a follow-up the master filed. Nothing
// then withdrew the change request or re-reviewed the head, and the owed request-rework stood with
// no actor. These replay that round through the real review-cap step.

const H = 'f1ea5b764ac7'.padEnd(40, '0'), B = 'b1'.padEnd(40, 'f');
const reviewer = 'graphyard-reviewer[bot]';
const config = { url: 'https://graphyard.example', repository: 'owner/project',
  reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.pem', boundAt: '2026-09-24T00:00:00Z' } } as unknown as MasterConfig;
const refusedAt = '2026-10-09T06:40:00.000Z';
const refusalReason = 'The finding is real but not blocking: the hotspot budget is a follow-up, not a defect of this head. File it as its own item and let the reviewer list it as a FOLLOW-UP.';

function capped(body: string, reviewId = 4242, submittedAt = '2026-10-09T06:30:00Z'): Work {
  const candidate = { sha: H, baseSha: B, pr: 1047, branch: 'graphyard/gy-1573-5', author: 'implementer' };
  const observation = { candidate, checks: [], reviews: [{ reviewer, sha: H, state: 'CHANGES_REQUESTED', id: reviewId, submittedAt, body }], merged: false, mergeSha: null,
    mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at: '2026-10-09T06:31:00Z', prState: 'open', draft: false, baseTip: B, baseTree: B, baseTipContained: true } as unknown as Observation;
  return { id: 'work-1573', key: 'GY-1573', title: 'Hotspot budgets', description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'The widget counts every frob.', proofs: ['unit:frob-count'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'review', revision: 40, policyRevision: 1, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-09T06:31:00Z', stageEnteredAt: '2026-10-09T06:31:00Z', ready: true, epoch: 5,
    lease: null, workspaces: [], candidate, submission: { epoch: 5, pr: 1047 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, gates: [], violations: [],
    pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 4, interventions: { blocked: 0, requirements: 0 } } } as unknown as Work;
}
/** The master's follow-up, filed after the refusal and naming the item. */
const followUp = { id: 'work-1574', key: 'GY-1574', title: 'Former hotspot files exceed their size budgets after GY-1573', description: 'Named by the refusal of GY-1573\'s capped rework.', stage: 'backlog', createdAt: '2026-10-09T06:42:00Z' } as unknown as Work;
const unrelated = { id: 'work-1500', key: 'GY-1500', title: 'Something else', description: 'Mentions GY-15730 only', stage: 'backlog', createdAt: '2026-10-09T06:43:00Z' } as unknown as Work;

/** The capped rework the loop requested for the head under policy revision `revision`, then the approver's refusal of it. */
const decision = (state: 'requested' | 'refused', revision = 1) => ({ id: '334c52c6-467e-4fe4-b81f-2c761e07a066', action: 'rework', state, input: { binding: cappedReworkBinding(H, reviewer), previousWorkerStopped: true },
  reason: `[Decided from the GitHub observation taken at 2026-10-09T06:31:00Z of candidate ${H}; if the item has moved since, this request no longer describes it.] ${cappedRevisionMark(revision)} GY-1573 is in review round 5, past its cap of 3.`,
  approvedBy: null, refusal: state === 'refused' ? { approver: 'graphyard-approver-graphyard', reason: refusalReason, at: refusedAt } : null });

function harness(item: Work, others: Work[] = [followUp, unrelated]) {
  const state = emptyDaemonState(config), performed: DaemonAction[] = [];
  const world = { item, history: [decision('requested')] as ReturnType<typeof decision>[], withdrawn: [] as { reviewId: number; message: string }[], wakes: [] as string[] };
  let tick = Date.parse('2026-10-09T06:45:00Z');
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

test('unit:capped-refusal-withdraws-and-rereviews — GY-1573 round 5: an approver refusing the capped rework withdraws the change request as the reviewer App, cancels the owed request-rework and re-reviews the head once; a re-review requesting changes again escalates, never withdrawn twice', async () => {
  const run = harness(capped('BLOCKING: former hotspot files exceed their size budgets.\n\nThe helper could be named more clearly.'));
  // The change request: past the cap, it names a BLOCKING: finding, so its rework is the approver's to judge.
  const judged = cappedReview(run.world.item, config)!;
  assert.equal(judged.kind, 'escalate');
  const owed = neededDecision(run.world.item, config)!;
  assert.deepEqual([owed.action, owed.binding], ['rework', cappedReworkBinding(H, reviewer)], 'the loop requests the capped rework decision for the approver');

  // The rework decision stands requested: the round is the approver's, and the step takes nothing.
  await run.cycle();
  assert.equal(run.world.withdrawn.length, 0);
  assert.equal(run.performed.length, 0);

  // The approver refuses it as non-blocking.
  run.world.history = [decision('refused')];
  assert.equal(refusedCappedRework(run.world.history, judged, 1)?.id, decision('refused').id);
  assert.equal(refusedCappedRework(run.world.history, { ...judged, sha: 'c'.repeat(40) }, 1), null, 'a refusal binds its own head only');
  assert.ok(owed.reason.startsWith(cappedRevisionMark(1)), 'the request names the policy revision its refusal binds');
  await run.cycle();
  // The withdrawal, as the reviewer App, of exactly that change request.
  assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242]);
  const filing = run.state.actions[cappedFilingKey(run.world.item, { sha: H, reviewId: 4242 })]!;
  assert.equal(filing.state, 'done');
  assert.match(filing.detail, /independent approver graphyard-approver-graphyard refused the capped rework \(decision 334c52c6-467e-4fe4-b81f-2c761e07a066\) as non-blocking, so graphyard-reviewer\[bot\]'s change request 4242 on f1ea5b764ac7 is withdrawn/);
  // The cancelled rework: the observation is woken at once, and the fresh reading retires the owed request-rework row.
  assert.deepEqual(run.world.wakes, ['GY-1573']);
  assert.match(filing.detail, /its observation woken so the owed request-rework is cancelled/);
  const dismissed = structuredClone(run.world.item);
  dismissed.observation!.reviews = dismissed.observation!.reviews.map(review => ({ ...review, state: 'DISMISSED' }));
  assert.equal(neededDecision(dismissed, config), null, 'with the change request withdrawn the item owes no rework');
  const rework: NextAction = { kind: 'request-rework', binding: `${H}:review`, reason: 'Outstanding change requests must be resolved through a new review', gate: 'review', refusal: 'Outstanding change requests must be resolved through a new review', inputs: { kind: 'request-rework', pr: 1047, sha: H, detail: 'changes requested' } } as unknown as NextAction;
  const review: NextAction = { kind: 'request-review', binding: `${H}:review-request`, reason: 'Independent approval of the current commit is required', gate: 'review', refusal: 'Independent approval of the current commit is required', inputs: { kind: 'request-review', provider: 'agent', requestId: null, pr: 1047, sha: H, baseSha: B, policyRevision: 1 } } as unknown as NextAction;
  reconcileActions(dismissed, [dismissed], new Date('2026-10-09T06:47:00Z'), { next: rework });
  const transitions = reconcileActions(dismissed, [dismissed], new Date('2026-10-09T06:48:00Z'), { next: review });
  assert.deepEqual(transitions.filter(entry => entry.event === 'cancelled').map(entry => entry.action.id), [actionId('request-rework', dismissed.id, rework.binding)], 'the fresh reading cancels the owed request-rework');
  // The single re-review, recorded once for the head.
  const rereview = run.state.actions[cappedRereviewKey(run.world.item, H)]!;
  assert.equal(rereview.state, 'done');
  assert.match(rereview.detail, /^Requested a fresh review of GY-1573 on f1ea5b764ac7: /);

  // Further cycles on the same reading withdraw nothing again.
  await run.cycle();
  await run.cycle();
  assert.equal(run.world.withdrawn.length, 1);
  assert.equal(run.world.wakes.length, 1);
  assert.equal(run.performed.filter(entry => entry.kind === 'review').length, 2, 'one withdrawal and one re-review request');

  // The re-review requests changes again on the same head, BLOCKING: or not: escalated, never withdrawn a second time.
  for (const body of ['BLOCKING: former hotspot files still exceed their size budgets.', 'The helper could still be named more clearly.']) {
    const again = harness(capped('BLOCKING: former hotspot files exceed their size budgets.'));
    again.world.history = [decision('refused')];
    await again.cycle();
    assert.deepEqual(again.world.withdrawn.map(entry => entry.reviewId), [4242]);
    again.world.item = capped(body, 4243);
    await again.cycle();
    await again.cycle();
    assert.deepEqual(again.world.withdrawn.map(entry => entry.reviewId), [4242], `withdrawn once only: ${body}`);
    const escalation = again.state.actions[cappedEscalationKey(again.world.item, H)]!;
    assert.equal(escalation.state, 'done');
    assert.match(escalation.detail, /requested changes again, so it is not withdrawn a second time/);
    assert.equal(again.performed.filter(entry => entry.kind === 'escalation').length, 1, 'escalated once, not on every cycle');
  }

  // The once-per-head guard outlives the cursor: with the withdrawal and re-review rows pruned, a re-review requesting changes again is still escalated.
  for (const body of ['BLOCKING: former hotspot files still exceed their size budgets.', 'The helper could still be named more clearly.']) {
    const pruned = harness(capped('BLOCKING: former hotspot files exceed their size budgets.'));
    pruned.world.history = [decision('refused')];
    await pruned.cycle();
    assert.deepEqual(pruned.world.withdrawn.map(entry => entry.reviewId), [4242]);
    // A busy fleet: more newer resolved actions than the cursor keeps retire the withdrawal and re-review rows.
    for (let index = 0; index <= retainedActions; index++)
      storeAction(pruned.state, `dispatch:other-${index}:1`, { kind: 'dispatch', work: `GY-${index}`, principal: null, epoch: 1, state: 'done', detail: 'launched', attempts: 1, cycle: pruned.state.cycle, at: new Date(Date.parse('2026-10-09T07:00:00Z') + index).toISOString() });
    pruneDaemonState(pruned.state);
    assert.equal(pruned.state.actions[cappedRereviewKey(pruned.world.item, H)], undefined, 'the re-review row is pruned');
    assert.equal(pruned.state.actions[cappedFilingKey(pruned.world.item, { sha: H, reviewId: 4242 })], undefined, 'the withdrawal row is pruned');
    // The re-review, submitted after the refusal, requests changes again on the same head.
    pruned.world.item = capped(body, 4243, '2026-10-09T07:10:00Z');
    await pruned.cycle();
    await pruned.cycle();
    assert.deepEqual(pruned.world.withdrawn.map(entry => entry.reviewId), [4242], `withdrawn once only: ${body}`);
    const escalation = pruned.state.actions[cappedEscalationKey(pruned.world.item, H)]!;
    assert.equal(escalation.state, 'done');
    assert.match(escalation.detail, /its re-review requested changes again, so it is not withdrawn a second time/);
    assert.match(escalation.detail, /the master answers it/, 'the refusal is escalated for the master to answer');
  }

  // A refused rework of a verdict Graphyard did not obtain through its reviewer App cannot be withdrawn: it escalates.
  const foreign = harness(capped('BLOCKING: AC-1 is not met.'));
  foreign.world.item.observation!.reviews[0].reviewer = 'a-person';
  foreign.world.history = [{ ...decision('refused'), input: { binding: cappedReworkBinding(H, 'a-person'), previousWorkerStopped: true } }];
  await foreign.cycle();
  assert.equal(foreign.world.withdrawn.length, 0);
  assert.match(foreign.state.actions[cappedEscalationKey(foreign.world.item, H)]!.detail, /refused its capped rework as non-blocking \(decision 334c52c6-467e-4fe4-b81f-2c761e07a066\), but Graphyard cannot withdraw a verdict/);

  // A requirements or review-policy revision leaves the head unchanged but makes the earlier refusal inapplicable:
  // the new revision's change request is its own approver's to judge, never withdrawn on the old judgement.
  const revised = harness(capped('BLOCKING: AC-1 is not met under the revised criteria.', 4250));
  revised.world.item.policyRevision = 2;
  revised.world.history = [decision('refused', 1)];
  assert.equal(refusedCappedRework(revised.world.history, judged, 2), null, 'a refusal binds the policy revision it was judged under');
  assert.equal(cappedRefusalRequest(revised.world.item, H, config, revised.world.history, [followUp]), null, 'nor does it reach the revised head\'s reviewer');
  await revised.cycle();
  await revised.cycle();
  assert.equal(revised.world.withdrawn.length, 0);
  assert.equal(revised.performed.length, 0, 'the round waits for the new revision\'s approver');
  const renewed = neededDecision(revised.world.item, config)!;
  assert.ok(renewed.reason.startsWith(cappedRevisionMark(2)), renewed.reason);
  // Its own refusal, under revision 2, is the one that withdraws it.
  revised.world.history = [decision('refused', 1), { ...decision('refused', 2), id: '6d0c2a47-55a9-4e0e-9c2f-0f1d1a2b3c4d' }];
  await revised.cycle();
  assert.deepEqual(revised.world.withdrawn.map(entry => entry.reviewId), [4250]);
  assert.match(revised.world.withdrawn[0].message, /decision 6d0c2a47-55a9-4e0e-9c2f-0f1d1a2b3c4d/);
});

test('unit:capped-refusal-rereview-context — the re-review request carries the refusal\'s reasoning and the follow-up item the master filed, so the reviewer lists the findings as FOLLOW-UP threads', async () => {
  const run = harness(capped('BLOCKING: former hotspot files exceed their size budgets.'));
  run.world.history = [decision('refused')];
  await run.cycle();
  const [withdrawal] = run.world.withdrawn;
  // The request the reviewer reads on the pull request: the approver, the decision, its whole reasoning, the follow-up, and the FOLLOW-UP instruction.
  assert.ok(withdrawal.message.includes(`independent approver graphyard-approver-graphyard refused the rework it asked for as non-blocking (decision 334c52c6-467e-4fe4-b81f-2c761e07a066): ${refusalReason}`), withdrawal.message);
  assert.ok(withdrawal.message.includes(`Re-review head ${H} and list these findings as FOLLOW-UP threads, not as a change request; the follow-up item filed for them: GY-1574.`), withdrawal.message);
  assert.match(withdrawal.message, /A change request on this head again is escalated, not withdrawn a second time\.$/);
  assert.doesNotMatch(withdrawal.message, /GY-1500/, 'an item that does not name GY-1573 is no follow-up of it');
  // The loop's record of the re-review request carries the same context.
  const rereview = run.state.actions[cappedRereviewKey(run.world.item, H)]!.detail;
  assert.ok(rereview.includes(refusalReason) && rereview.includes('GY-1574') && rereview.includes('FOLLOW-UP threads'), rereview);

  // The follow-ups: named in the reasoning, filed from the item's review, or filed since the refusal naming the item; never one delivered or filed before it.
  const item = { key: 'GY-1573' };
  const named = { ...unrelated, key: 'GY-1600', createdAt: '2026-10-01T00:00:00Z' } as Work;
  const origin = { ...unrelated, key: 'GY-1601', createdAt: '2026-10-01T00:00:00Z', origin: { reviewFollowUps: { parent: 'GY-1573', findings: [] } } } as unknown as Work;
  const earlier = { ...followUp, key: 'GY-1602', createdAt: '2026-10-09T06:00:00Z' } as Work;
  const delivered = { ...followUp, key: 'GY-1603', stage: 'done' } as Work;
  assert.deepEqual(refusalFollowUps(item, { reason: `${refusalReason} See GY-1600.`, at: refusedAt }, [named, origin, earlier, delivered, followUp, unrelated]), ['GY-1600', 'GY-1601', 'GY-1574']);
  assert.deepEqual(refusalFollowUps(item, { reason: refusalReason }, [followUp]), [], 'with no refusal time, only a named or review-filed item is a follow-up');
  // Every follow-up is named, however many the master filed: the reviewer cannot list one the request left out.
  const many = Array.from({ length: 7 }, (_, index) => ({ ...followUp, id: `work-17${index}`, key: `GY-17${index}0` }) as Work);
  assert.deepEqual(refusalFollowUps(item, { reason: refusalReason, at: refusedAt }, many), many.map(other => other.key));
  const crowded = harness(capped('BLOCKING: former hotspot files exceed their size budgets.'), many);
  crowded.world.history = [decision('refused')];
  await crowded.cycle();
  assert.ok(crowded.world.withdrawn[0].message.includes(`the follow-up items filed for them: ${many.map(other => other.key).join(', ')}.`), crowded.world.withdrawn[0].message);

  // A refusal with no follow-up filed still carries its reasoning, and names none.
  const bare = harness(capped('BLOCKING: former hotspot files exceed their size budgets.'), []);
  bare.world.history = [decision('refused')];
  await bare.cycle();
  assert.ok(bare.world.withdrawn[0].message.includes(refusalReason));
  assert.ok(bare.world.withdrawn[0].message.includes('list these findings as FOLLOW-UP threads, not as a change request. '), bare.world.withdrawn[0].message);

  // The handoff: the reviewer the re-review launches is told the same request in its prompt, read from the decision history.
  const long = `${'The finding is real but not blocking. '.repeat(52)}Decided.`.slice(0, 2000);
  const longRun = harness(capped('BLOCKING: former hotspot files exceed their size budgets.'));
  longRun.world.history = [{ ...decision('refused'), refusal: { approver: 'graphyard-approver-graphyard', reason: long, at: refusedAt } }];
  await longRun.cycle();
  assert.ok(longRun.world.withdrawn[0].message.includes(long), 'a refusal at the approval\'s 2,000-character bound is posted whole');
  const request = cappedRefusalRequest(run.world.item, H, config, [decision('refused')], [run.world.item, followUp, unrelated])!;
  assert.equal(request, withdrawal.message, 'the launch builds exactly the request the withdrawal posted');
  assert.equal(cappedRefusalRequest(run.world.item, H, config, [decision('requested')], [followUp]), null, 'no refusal, no re-review context');
  assert.equal(cappedRefusalRequest(run.world.item, 'c'.repeat(40), config, [decision('refused')], [followUp]), null, 'a refusal binds its own head only');

  const directory = await temporaryDirectory('gy-1575');
  {
    const credentialFile = join(directory, 'master.token');
    await writeFile(credentialFile, 'c'.repeat(40), { mode: 0o600 });
    const reads: string[] = [];
    const fetcher = (async (url: string) => {
      reads.push(new URL(url).pathname);
      const body = url.endsWith('/decisions') ? { decisions: [decision('refused')] } : [run.world.item, followUp, unrelated];
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const context = await readCappedRefusal({ ...config, credentialFile }, fetcher)(run.world.item, H);
    assert.deepEqual(context, { request: withdrawal.message });
    assert.deepEqual(reads, ['/api/work/work-1573/decisions', '/api/work']);
    // A head with no refusal reads the history alone, and gives no context.
    reads.length = 0;
    assert.equal(await readCappedRefusal({ ...config, credentialFile }, fetcher)(run.world.item, 'c'.repeat(40)), null);
    assert.deepEqual(reads, ['/api/work/work-1573/decisions']);
    // A failed read is told to the reviewer, never read as "no refusal".
    const failed = await readCappedRefusal({ ...config, credentialFile }, (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch)(run.world.item, H);
    assert.ok(failed && 'failure' in failed && /answered 503/.test(failed.failure), JSON.stringify(failed));
    const binding = { key: 'GY-1573', pr: 1047, sha: H, baseSha: B, policyRevision: 1 };
    const prompt = reviewPrompt(config, binding, undefined, undefined, run.world.item.criteria, undefined, undefined, null, { round: 5, cap: 3, capped: true }, null, null, null, null, context);
    assert.ok(prompt.includes(withdrawal.message), 'the launched reviewer reads the whole request');
    assert.match(prompt, /List each finding that refusal judged non-blocking as a FOLLOW-UP thread, naming the follow-up item filed for it/);
    assert.ok(prompt.includes('GY-1574') && prompt.includes(refusalReason));
    assert.match(reviewPrompt(config, binding, undefined, undefined, run.world.item.criteria, undefined, undefined, null, { round: 5, cap: 3, capped: true }, null, null, null, null, failed), /could not read whether an independent approver refused this head's capped rework \(GET \/api\/work\/work-1573\/decisions answered 503\)/);
    assert.doesNotMatch(reviewPrompt(config, binding, undefined, undefined, run.world.item.criteria, undefined, undefined, null, { round: 5, cap: 3, capped: true }), /independent approver refused/, 'an ordinary review carries no refusal');
  }
});

