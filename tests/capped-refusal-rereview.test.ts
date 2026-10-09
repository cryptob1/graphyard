import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Observation, Work } from '../src/model.js';
import type { MasterConfig } from '../src/master.js';
import { emptyDaemonState, pruneDaemonState, retainedActions, storeAction, type DaemonAction, type DaemonEffects } from '../src/master-daemon.js';
import { cappedReview, cappedReworkBinding, cappedRevisionMark, neededDecision } from '../src/daemon/decisions.js';
import { emptyHeldDecisions } from '../src/daemon/decision-reads.js';
import { cappedEscalation, cappedEscalationKey, cappedFilingKey, cappedRefusalRequest, cappedRereviewKey, refusalFollowUps, refusedCappedRework, reviewCapStep, unmatchedCappedRefusal } from '../src/daemon/cycle-review-cap.js';
import * as reviewCap from '../src/daemon/cycle-review-cap.js';
import { handActions, handDecision } from '../src/cli/hand-actions.js';
import { loopRework } from '../src/cli/hand-rework.js';
import { autonomySubcommands } from '../src/master/autonomy.js';
import { decisionKey } from '../src/daemon/reconcile.js';
import { actionId, reconcileActions } from '../src/model/actions.js';
import { standingRefusal } from '../src/model/approval.js';
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
  const world = { item, history: [decision('requested')] as (ReturnType<typeof decision> | ReturnType<typeof unmarked>)[], withdrawn: [] as { reviewId: number; message: string }[], wakes: [] as string[] };
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
  assert.equal(refusedCappedRework(run.world.history, judged, run.world.item)?.id, decision('refused').id);
  assert.equal(refusedCappedRework(run.world.history, { ...judged, sha: 'c'.repeat(40) }, run.world.item), null, 'a refusal binds its own head only');
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
  assert.equal(refusedCappedRework(revised.world.history, judged, revised.world.item), null, 'a refusal binds the policy revision it was judged under');
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


// GY-1579, observed on GY-1573 at 2026-10-09T08:19:16Z: the approver refused capped rework f84ee922,
// requested at 08:18:36Z by the release running before GY-1575 merged, so its reason carried no
// revision mark. The step matched refusals on the mark alone and returned silently: no withdrawal,
// the owed request-rework kept executors fenced, and the head sat owed 34 minutes.

/** The capped request as a release before GY-1575 wrote it: the binding, and a reason with no revision mark. */
const markless = (state: 'requested' | 'refused') => ({ ...decision(state), id: 'f84ee922-0d1c-4c51-9a2e-3b8e7a6f5d40',
  reason: `[Decided from the GitHub observation taken at 2026-10-09T08:18:00Z of candidate ${H}; if the item has moved since, this request no longer describes it.] GY-1573 is in review round 8, past its cap of 3. Past the review-round cap only an independent approver sends the head back: approve for one more round fixing exactly that finding, or refuse it as non-blocking: the loop then requests it no more and escalates the refusal for the master to answer.` });

test('unit:capped-refusal-recognized-without-mark — a refused capped rework whose reason carries no revision mark is read from its binding; a marked one still binds its own revision', () => {
  const judged = cappedReview(capped('BLOCKING: former hotspot files exceed their size budgets.'), config)!;
  const item = capped('BLOCKING: former hotspot files exceed their size budgets.');
  assert.equal(refusedCappedRework([markless('refused')], judged, item)?.id, markless('refused').id, 'the binding names the head and reviewer it judged');
  assert.equal(refusedCappedRework([markless('requested')], judged, item), null, 'a request still awaiting its approver is no refusal');
  assert.equal(refusedCappedRework([markless('refused')], { ...judged, sha: 'c'.repeat(40) }, item), null, 'a refusal binds its own head only');
  assert.equal(refusedCappedRework([markless('refused')], { ...judged, reviewer: 'a-person' }, item), null, 'and its own reviewer');
  assert.equal(refusedCappedRework([decision('refused', 1)], judged, { ...item, policyRevision: 2 }), null, 'a marked refusal binds the revision it was judged under');
  assert.equal(unmatchedCappedRefusal([markless('refused')], judged), null, 'a refusal the step reads is not unmatched');
});

test('integration:capped-refusal-remedy-runs-markless — GY-1573 f84ee922: the review-cap step withdraws the change request, wakes the observation and records the re-review for a refusal with no revision mark', async () => {
  const run = harness(capped('BLOCKING: former hotspot files exceed their size budgets.'));
  run.world.history = [markless('requested')];
  await run.cycle();
  assert.equal(run.world.withdrawn.length, 0, 'the round is the approver\'s while the request stands');
  run.world.history = [markless('refused')];
  await run.cycle();
  assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242], 'the change request is withdrawn as the reviewer App');
  assert.match(run.world.withdrawn[0].message, /refused the rework it asked for as non-blocking \(decision f84ee922-0d1c-4c51-9a2e-3b8e7a6f5d40\)/);
  assert.deepEqual(run.world.wakes, ['GY-1573'], 'the observation is woken to retire the owed request-rework');
  assert.match(run.state.actions[cappedFilingKey(run.world.item, { sha: H, reviewId: 4242 })]!.detail, /its observation woken so the owed request-rework is cancelled/);
  assert.equal(run.state.actions[cappedRereviewKey(run.world.item, H)]?.state, 'done', 'the re-review request is recorded');
  assert.equal(run.state.actions[cappedEscalationKey(run.world.item, H)], undefined, 'nothing is escalated');
  assert.equal(cappedRefusalRequest(run.world.item, H, config, [markless('refused')], [run.world.item, followUp, unrelated]), run.world.withdrawn[0].message, 'the launched reviewer reads the same request');
  await run.cycle();
  assert.equal(run.world.withdrawn.length, 1, 'withdrawn once');

  // On a revised item whose record cannot date the undated, markless refusal against the revision, its binding still answers the round.
  const revised = harness({ ...capped('BLOCKING: former hotspot files exceed their size budgets.'), policyRevision: 3, formalReviewResetRequired: true, formalReviewBaseline: undefined, reviewRequest: null } as Work);
  revised.world.history = [markless('refused')];
  await revised.cycle();
  assert.deepEqual(revised.world.withdrawn.map(entry => entry.reviewId), [4242], 'withdrawn under revision 3 as under revision 1');
  assert.deepEqual(revised.world.wakes, ['GY-1573']);
  assert.equal(revised.state.actions[cappedRereviewKey(revised.world.item, H)]?.state, 'done');
  assert.equal(revised.state.actions[cappedEscalationKey(revised.world.item, H)], undefined);
});

test('unit:capped-refusal-unmatched-escalates — a refused capped rework on the head that binds it under none of its readings escalates naming the decision, never returns silently', async () => {
  // The record names the head as capped, but for another reviewer slug and with no revision mark.
  const stray = { ...markless('refused'), id: 'b8d7b97b-2ecf-4f2f-bfc7-5160fec9cbdf', input: { binding: cappedReworkBinding(H, 'graphyard-reviewer'), previousWorkerStopped: true } };
  const run = harness(capped('BLOCKING: former hotspot files exceed their size budgets.'));
  const judged = cappedReview(run.world.item, config)!;
  assert.equal(refusedCappedRework([stray], judged, run.world.item), null);
  assert.equal(unmatchedCappedRefusal([stray], judged)?.id, stray.id);
  run.world.history = [stray];
  await run.cycle();
  await run.cycle();
  assert.equal(run.world.withdrawn.length, 0, 'nothing is withdrawn on a refusal the step cannot bind');
  const escalation = run.state.actions[cappedEscalationKey(run.world.item, H)]!;
  assert.equal(escalation.state, 'done');
  assert.match(escalation.detail, /refused capped rework decision b8d7b97b-2ecf-4f2f-bfc7-5160fec9cbdf on f1ea5b764ac7, but its record binds graphyard-reviewer\[bot\]'s change request under none of its readings/);
  assert.match(escalation.detail, /the master answers it/);
  assert.equal(run.performed.filter(entry => entry.kind === 'escalation').length, 1, 'escalated once, not on every cycle');

  // A binding-null hand rework whose situation names the head and the cap is read the same way.
  const hand = { ...markless('refused'), id: 'ef1f554b-1111-4c51-9a2e-3b8e7a6f5d40', input: { previousWorkerStopped: true }, situation: { sha: H, baseSha: B } };
  assert.equal(unmatchedCappedRefusal([hand], judged)?.id, hand.id);
  // So is one whose binding is in another format: its situation names the head and its reason the cap.
  const other = { ...markless('refused'), id: '5d0c7a1e-2222-4c51-9a2e-3b8e7a6f5d40', input: { previousWorkerStopped: true, binding: `${H}:verdict:${reviewer}` }, situation: { sha: H, baseSha: B } };
  assert.equal(refusedCappedRework([other], judged, run.world.item), null);
  assert.equal(unmatchedCappedRefusal([other], judged)?.id, other.id, 'a binding in another format leaves the head and cap to the other readings');
  assert.equal(unmatchedCappedRefusal([{ ...other, situation: { sha: 'c'.repeat(40), baseSha: B }, reason: 'GY-1573 is past its cap of 3.' }], judged), null, 'and is not read for another head');
  assert.equal(unmatchedCappedRefusal([{ ...other, reason: 'The verdict stands on the head.' }], judged), null, 'nor without naming the cap');
  const formatted = harness(capped('BLOCKING: former hotspot files exceed their size budgets.'));
  formatted.world.history = [other];
  await formatted.cycle();
  await formatted.cycle();
  assert.equal(formatted.world.withdrawn.length, 0);
  assert.match(formatted.state.actions[cappedEscalationKey(formatted.world.item, H)]!.detail, new RegExp(`refused capped rework decision ${other.id} on f1ea5b764ac7.*binding ${H}:verdict:`));
  assert.equal(formatted.performed.filter(entry => entry.kind === 'escalation').length, 1, 'escalated by id, once');
  // Neither is a refusal marked under another revision (it judged a change request that no longer stands), nor one for another head.
  assert.equal(unmatchedCappedRefusal([decision('refused', 1)], judged), null);
  assert.equal(unmatchedCappedRefusal([{ ...stray, input: { binding: cappedReworkBinding('c'.repeat(40), reviewer), previousWorkerStopped: true } }], judged), null);
  assert.equal(unmatchedCappedRefusal([{ ...hand, situation: { sha: 'c'.repeat(40), baseSha: B }, reason: 'GY-1573 is past its cap of 3.' }], judged), null);
  // A marked refusal under an earlier revision still waits for the new revision's approver, silently, as GY-1575 decided.
  const revised = harness(capped('BLOCKING: AC-1 is not met under the revised criteria.', 4250));
  revised.world.item.policyRevision = 2;
  revised.world.history = [decision('refused', 1)];
  await revised.cycle();
  assert.equal(revised.performed.length, 0);
});

// GY-1580, observed on GY-1573 rounds 9-10, 2026-10-09: the approver refused capped rework 7df4183e as
// non-blocking, the loop withdrew the change request and had the head re-reviewed, and the re-review
// (review 5468008197, 09:04:31Z) requested changes again with a new BLOCKING: finding. The escalation sent
// the master to "have the change request answered as FOLLOW-UP", which no command it may run does; its
// answering rework ea13b053, citing 7df4183e, was refused as non-blocking and the finding routed to GY-1574.
const firstRefusal = { ...decision('refused'), id: '7df4183e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', requestedAt: '2026-10-09T06:35:00.000Z' };
const answerReason = 'The re-review\'s finding is real but not blocking either: it belongs with GY-1574 AC-8, which already tracks the hotspot budgets.';
const answer = (state: 'requested' | 'refused', requestedAt = '2026-10-09T09:10:00.000Z') => ({ id: 'ea13b053-6f7a-4b8c-9d0e-1f2a3b4c5d6e', action: 'rework', state, input: { previousWorkerStopped: true }, precedent: [firstRefusal.id], requestedAt,
  situation: { sha: H, baseSha: B }, reason: `Answering the review-cap escalation after refused capped rework ${firstRefusal.id}: the re-review names a new BLOCKING: finding beyond it.`,
  approvedBy: null, refusal: state === 'refused' ? { approver: 'graphyard-approver-graphyard', reason: answerReason, at: '2026-10-09T09:20:00.000Z' } : null });
const firstBody = 'BLOCKING: former hotspot files exceed their size budgets.';
const rereviewBody = 'BLOCKING: the soak test still leaks its temporary directory.';

/** The second re-review's cursor key, read off the module so a tree without it fails as a test case, not at load. */
const answeredRereviewKey = (work: Pick<Work, 'id'>, sha: string): string => (reviewCap as { answeredRereviewKey?: (work: Pick<Work, 'id'>, sha: string) => string }).answeredRereviewKey?.(work, sha) ?? `${cappedRereviewKey(work, sha)}:answered`;

/** Rounds 9-10 up to the escalation the re-review raised: refusal, first withdrawal, re-review requesting changes again. */
async function replayToEscalation() {
  const run = harness(capped(firstBody));
  run.world.history = [firstRefusal] as any;
  await run.cycle();
  assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242], 'the first refusal withdraws the change request');
  run.world.item = capped(rereviewBody, 5468008197, '2026-10-09T09:04:31Z');
  await run.cycle();
  const escalation = run.state.actions[cappedEscalationKey(run.world.item, H)]!;
  assert.match(escalation.detail, /its re-review requested changes again, so it is not withdrawn a second time/);
  assert.equal(run.world.withdrawn.length, 1);
  return run;
}

test('unit:master-refusal-answers-capped-escalation — GY-1573 rounds 9-10: an approver refusing the master\'s answer to a refused capped head\'s escalation has the change request withdrawn once more and the head re-reviewed with both refusals and GY-1574; a third change request escalates', async () => {
  for (const prune of [false, true]) {
    const run = await replayToEscalation();
    // The master's answer stands requested: the round is its approver's, and nothing is withdrawn.
    run.world.history = [firstRefusal, answer('requested')] as any;
    await run.cycle();
    assert.equal(run.world.withdrawn.length, 1);
    // The approver refuses the answer as non-blocking: the change request is withdrawn a second time, once.
    run.world.history = [firstRefusal, answer('refused')] as any;
    await run.cycle();
    await run.cycle();
    assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242, 5468008197]);
    const message = run.world.withdrawn[1].message;
    for (const part of [firstRefusal.id, refusalReason, answer('refused').id, answerReason, 'GY-1574', `Re-review head ${H} and approve it, listing these findings as FOLLOW-UP threads`, 'Only a finding that breaks a criterion neither refusal judged is BLOCKING'])
      assert.ok(message.includes(part), `${part} in ${message}`);
    assert.doesNotMatch(message, /GY-1500/);
    // One re-review request, recorded once, carrying both refusals and the follow-up.
    const rereview = run.state.actions[answeredRereviewKey(run.world.item, H)]!;
    assert.equal(rereview.state, 'done');
    assert.ok(rereview.detail.includes(firstRefusal.id) && rereview.detail.includes(answer('refused').id) && rereview.detail.includes('GY-1574'), rereview.detail);
    assert.equal(run.performed.filter(entry => entry.kind === 'review' && entry.detail.startsWith('Requested a fresh review')).length, 2, 'the first re-review and this one, nothing more');
    assert.match(run.state.actions[cappedFilingKey(run.world.item, { sha: H, reviewId: 5468008197 })]!.detail, /refused the master's answer \(decision ea13b053-6f7a-4b8c-9d0e-1f2a3b4c5d6e\).*withdrawn once more/);
    // The launched reviewer reads the same request.
    assert.equal(cappedRefusalRequest(run.world.item, H, config, run.world.history as any, [run.world.item, followUp, unrelated]), message);
    if (prune) {
      // A busy fleet retires every withdrawal and re-review row before the third change request lands.
      for (let index = 0; index <= retainedActions; index++)
        storeAction(run.state, `dispatch:other-${index}:1`, { kind: 'dispatch', work: `GY-${index}`, principal: null, epoch: 1, state: 'done', detail: 'launched', attempts: 1, cycle: run.state.cycle, at: new Date(Date.parse('2026-10-09T09:30:00Z') + index).toISOString() });
      pruneDaemonState(run.state);
      assert.equal(run.state.actions[answeredRereviewKey(run.world.item, H)], undefined, 'the re-review row is pruned');
      assert.equal(run.state.actions[cappedRereviewKey(run.world.item, H)], undefined);
    }
    // A third change request on the head escalates and is not withdrawn again.
    run.world.item = capped('BLOCKING: the soak test still leaks it.', 5468009999, '2026-10-09T09:40:00Z');
    await run.cycle();
    await run.cycle();
    assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242, 5468008197], `withdrawn twice only (pruned: ${prune})`);
    const escalation = run.state.actions[cappedEscalationKey(run.world.item, H)]!;
    assert.match(escalation.detail, /so it is not withdrawn a third time/);
    assert.ok(escalation.detail.includes(`--precedent ${firstRefusal.id},${answer('refused').id}`), escalation.detail);
  }

  // An answer that cites no refusal, binds the loop's grounds, judged another head, or was requested before the change request answers nothing.
  for (const other of [{ ...answer('refused'), precedent: [], reason: 'A rework.' }, { ...answer('refused'), input: { binding: 'x', previousWorkerStopped: true } },
    { ...answer('refused'), situation: { sha: 'c'.repeat(40), baseSha: B } }, answer('refused', '2026-10-09T09:00:00.000Z')]) {
    const run = await replayToEscalation();
    run.world.history = [firstRefusal, other] as any;
    await run.cycle();
    assert.equal(run.world.withdrawn.length, 1, JSON.stringify(other));
  }

  // GY-1580 review: an answer the master requested before the first re-review posted binds no change request. The first
  // re-review's prompt carries only the first refusal, and the master's later answer, refused, has the re-review's change request withdrawn.
  const early = { ...answer('refused', '2026-10-09T08:50:00.000Z'), id: 'e0a1b2c3-0000-4000-8000-000000000001', refusal: { approver: 'graphyard-approver-graphyard', reason: answerReason, at: '2026-10-09T09:05:00.000Z' } };
  const beforeRereview = capped(firstBody);
  assert.ok(!cappedRefusalRequest(beforeRereview, H, config, [firstRefusal, early] as any, [beforeRereview, followUp, unrelated])!.includes(early.id), 'the first re-review carries no answer');
  const run = await replayToEscalation();
  run.world.history = [firstRefusal, early, answer('refused')] as any;
  await run.cycle();
  await run.cycle();
  assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242, 5468008197], 'the later answer is the one bound to the re-review');
  assert.ok(run.world.withdrawn[1].message.includes(answer('refused').id) && !run.world.withdrawn[1].message.includes(early.id), run.world.withdrawn[1].message);

  // GY-1580 review round 2: an answer requested at 08:50 and refused at 09:00, both before the 09:04 re-review posted, bound no withdrawal.
  // Until the master answers that re-review the step escalates (it cannot tell the early answer from one a withdrawal followed); the
  // answer requested at 09:10 and refused at 09:20 in reply to the 09:04 change request then withdraws it, once, and a later change
  // request, nits-only or blocking, escalates citing every refusal still uncited and is never withdrawn a third time, pruned rows or not.
  for (const prune of [false, true]) for (const third of [rereviewBody, 'The helper could be named more clearly.']) {
    const preSubmit = { ...early, refusal: { ...early.refusal, at: '2026-10-09T09:00:00.000Z' } };
    const run = await replayToEscalation();
    run.world.history = [firstRefusal, preSubmit] as any;
    await run.cycle();
    assert.equal(run.world.withdrawn.length, 1, 'the early answer alone withdraws nothing');
    assert.match(run.state.actions[cappedEscalationKey(run.world.item, H)]!.detail, /not withdrawn a third time/);
    run.world.history = [firstRefusal, preSubmit, answer('refused')] as any;
    await run.cycle();
    await run.cycle();
    assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242, 5468008197], 'the answer requested after the change request withdraws it');
    assert.ok(run.world.withdrawn[1].message.includes(answer('refused').id) && !run.world.withdrawn[1].message.includes(preSubmit.id), run.world.withdrawn[1].message);
    if (prune) {
      for (let index = 0; index <= retainedActions; index++)
        storeAction(run.state, `dispatch:other-${index}:1`, { kind: 'dispatch', work: `GY-${index}`, principal: null, epoch: 1, state: 'done', detail: 'launched', attempts: 1, cycle: run.state.cycle, at: new Date(Date.parse('2026-10-09T09:30:00Z') + index).toISOString() });
      pruneDaemonState(run.state);
      assert.equal(run.state.actions[answeredRereviewKey(run.world.item, H)], undefined, 'the re-review row is pruned');
    }
    run.world.item = capped(third, 5468009999, '2026-10-09T09:40:00Z');
    assert.equal(cappedReview(run.world.item, config)!.kind, third === rereviewBody ? 'escalate' : 'follow-up');
    await run.cycle();
    await run.cycle();
    assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [4242, 5468008197], `withdrawn twice only (pruned: ${prune}, ${third})`);
    const escalation = run.state.actions[cappedEscalationKey(run.world.item, H)]!.detail;
    assert.match(escalation, /not withdrawn a (third|second) time/);
    const precedent = /--precedent (\S+)/.exec(escalation)?.[1]?.split(',') ?? [];
    for (const id of [preSubmit.id, answer('refused').id]) assert.ok(precedent.includes(id), `${id} cited in ${escalation}`);
  }
});

/** Every `graphyard master …` command a text names, as words. */
const masterCommands = (text: string) => [...text.matchAll(/graphyard master ([a-z-]+) (GY-\d+)((?: (?:--[a-z]+ \S+|[a-z]+))*)/g)].map(match => ({ sub: match[1]!, key: match[2]!, rest: match[3]!.trim().split(' ').filter(Boolean) }));

test('unit:capped-escalation-names-runnable-commands — the escalation of a refused capped head names only commands master status\'s actor may run on the system-driven item', async () => {
  const item = { ...capped(rereviewBody, 5468008197, '2026-10-09T09:04:31Z'), systemDriven: true } as Work;
  const judged = cappedReview(item, config)!;
  const refusals = [{ id: firstRefusal.id, approver: 'a', reason: refusalReason }, { id: answer('refused').id, approver: 'a', reason: answerReason }];
  for (const named of [refusals.slice(0, 1), refusals]) {
    const text = cappedEscalation(item, judged, judged.reason, named);
    const commands = masterCommands(text);
    assert.ok(commands.some(command => command.sub === 'decide'), text);
    assert.doesNotMatch(text, /master (review|dispatch|merge)\b/, 'no hand action the loop owns');
    for (const command of commands) {
      assert.equal(command.key, 'GY-1573');
      assert.ok((autonomySubcommands as readonly string[]).includes(command.sub), `${command.sub} is a master subcommand`);
      assert.ok(!(handActions as readonly string[]).includes(command.sub));
      if (command.sub !== 'decide') continue;
      const [action, ...flags] = command.rest, precedent = flags[flags.indexOf('--precedent') + 1];
      assert.equal(precedent, named.map(refusal => refusal.id).join(','), 'it cites every refusal');
      const loop = { now: Date.parse('2026-10-09T09:06:00Z'), requestsDecisions: true, precedent, capEscalated: true };
      assert.equal(loopRework(item, action!, { previousWorkerStopped: true }, config, loop), null, text);
      assert.equal(handDecision(item, action, { previousWorkerStopped: true }), null);
      // Without the precedent the CLI refuses it: the check is the one the CLI applies.
      assert.match(loopRework(item, action!, { previousWorkerStopped: true }, config, { ...loop, precedent: undefined }) ?? '', /system-driven/);
    }
  }
});

// GY-1577, observed on GY-1573 (PR #1047, review round 8 of cap 3), 2026-10-09: the approver refused head d6a938c5's capped
// rework (decision f84ee922) at ~08:20Z under policy revision 5, but the loop had requested it before GY-1575's revision mark
// existed. On GY-1575's code nothing matched that unmarked refusal, the loop did not request the decision again, and the
// review-cap step returned silently with the change request standing past the cap and no actor named.

const D = 'd6a938c5a5c7400dc21fc355a0d9464bc026a042', round8Review = 5467569670;
/** GY-1573 at round 8: policy revision 5, whose requirement-review baseline holds the four reviews from before it. */
function round8(reviewId = round8Review, submittedAt = '2026-10-09T08:18:09Z'): Work {
  const item = capped('BLOCKING: former hotspot files exceed their size budgets.', reviewId, submittedAt);
  item.candidate = { ...item.candidate!, sha: D };
  item.observation!.candidate = item.candidate;
  item.observation!.reviews = item.observation!.reviews.map(review => ({ ...review, sha: D }));
  item.observation!.at = '2026-10-09T08:18:30Z';
  item.pipeline!.reworkRounds = 7;
  item.policyRevision = 5;
  item.formalReviewResetRequired = true;
  item.formalReviewBaseline = { pr: 1047, policyRevision: 5, reviewIds: [5466227134, 5466238478, 5466300915, 5466311316] };
  return item;
}
/** The loop's capped rework for head d6a938c5, requested before the revision mark existed, and its refusal. */
const unmarked = (refusedAt = '2026-10-09T08:20:30Z', requestedAt = '2026-10-09T08:18:40Z', id = 'f84ee922-9b67-4a8e-aa96-a2ca189a9ccb') => ({ id, action: 'rework', state: 'refused' as 'refused' | 'requested', requestedAt,
  input: { binding: cappedReworkBinding(D, reviewer), previousWorkerStopped: true },
  reason: `[Decided from the GitHub observation taken at 2026-10-09T08:18:30Z of candidate ${D}; if the item has moved since, this request no longer describes it.] GY-1573 is in review round 8, past its cap of 3, and graphyard-reviewer[bot] names a blocking finding on d6a938c5a5c7.`,
  approvedBy: null, refusal: { approver: 'graphyard-approver-graphyard', reason: refusalReason, at: refusedAt } as { approver: string; reason: string; at?: string } | null });
/** The loop has already asked for the capped rework under the item's current policy revision: its approval watch stands. */
const asked = (run: ReturnType<typeof harness>) => { run.state.approvals[decisionKey(run.world.item, { action: 'rework', binding: cappedReworkBinding(D, reviewer) })] = { work: 'GY-1573', action: 'rework', decision: 'f84ee922-9b67-4a8e-aa96-a2ca189a9ccb', requestedAt: '2026-10-09T08:18:40Z', settledAt: '2026-10-09T08:20:30Z' } as any; };

test('unit:unmarked-capped-refusal-rereviews — GY-1573 round 8: an unmarked refusal of head d6a938c5\'s capped rework, made under the policy revision still in force, withdraws the change request and records one fresh re-review; one made before the revision last changed binds nothing', async () => {
  const run = harness(round8());
  run.world.history = [unmarked()];
  asked(run);
  const judged = cappedReview(run.world.item, config)!;
  assert.deepEqual([judged.kind, judged.round, judged.sha], ['escalate', 8, D]);
  assert.equal(refusedCappedRework(run.world.history, judged, run.world.item)?.id, 'f84ee922-9b67-4a8e-aa96-a2ca189a9ccb', 'the unmarked refusal counts as judged under revision 5');
  await run.cycle();
  await run.cycle();
  assert.deepEqual(run.world.withdrawn.map(entry => entry.reviewId), [round8Review], 'withdrawn once, as for a marked refusal');
  assert.match(run.world.withdrawn[0].message, /\(decision f84ee922-9b67-4a8e-aa96-a2ca189a9ccb\)/);
  assert.equal(run.state.actions[cappedRereviewKey(run.world.item, D)]?.state, 'done');
  assert.equal(run.performed.filter(entry => entry.kind === 'review' && /^Requested a fresh review of GY-1573 on d6a938c5a5c7: /.test(entry.detail)).length, 1, 'one fresh re-review');
  assert.equal(run.state.actions[cappedEscalationKey(run.world.item, D)], undefined, 'nothing escalated');
  // The launched reviewer is handed the same request.
  assert.equal(cappedRefusalRequest(run.world.item, D, config, run.world.history, [run.world.item]), run.world.withdrawn[0].message);

  // A refusal with no refusal time is placed by its request: requested after the change request, it was refused after the revision too.
  assert.ok(refusedCappedRework([{ ...unmarked(), refusal: { approver: 'graphyard-approver-graphyard', reason: refusalReason } as { approver: string; reason: string; at?: string } }], judged, run.world.item));

  // An unmarked refusal made before policy revision 5 judged an earlier change request: it binds none submitted under revision 5.
  const before = unmarked('2026-10-09T07:40:00Z', '2026-10-09T07:30:00Z');
  assert.equal(refusedCappedRework([before], judged, run.world.item), null, 'refused before this revision\'s change request');
  const stale = harness(round8());
  stale.world.history = [before];
  await stale.cycle();
  assert.deepEqual(stale.world.withdrawn, [], 'the earlier judgement withdraws nothing');
  assert.equal(stale.performed.length, 0, 'the loop has yet to ask under revision 5, so the round waits for that request');
  // GY-1579 AC-1: where the item's record cannot date the refusal against the revision — a change request the baseline already
  // holds, a baseline of another revision, none on a revised item, no time at all — its binding is the record's answer, and it binds.
  assert.ok(refusedCappedRework([unmarked()], { ...judged, reviewId: 5466311316 }, run.world.item));
  assert.ok(refusedCappedRework([unmarked()], judged, { ...run.world.item, formalReviewBaseline: { pr: 1047, policyRevision: 4, reviewIds: [] } }));
  assert.ok(refusedCappedRework([unmarked()], judged, { ...run.world.item, formalReviewBaseline: undefined, reviewRequest: null }));
  assert.ok(refusedCappedRework([{ ...unmarked(), requestedAt: undefined as unknown as string, refusal: { approver: 'graphyard-approver-graphyard', reason: refusalReason } as { approver: string; reason: string; at?: string } }], judged, run.world.item), 'an undated refusal binds by its binding');
  assert.equal(refusedCappedRework([before], judged, { ...run.world.item, formalReviewBaseline: undefined, reviewRequest: null })?.id, before.id, 'with nothing to date it by, even an older refusal binds');
  // An agent review request posted under the current revision dates it as the baseline does.
  const agentRequest = { commentId: 1, sha: D, baseSha: B, policyRevision: 5, body: '', createdAt: '2026-10-09T08:10:00Z' };
  assert.ok(refusedCappedRework([unmarked()], judged, { ...run.world.item, formalReviewBaseline: undefined, reviewRequest: agentRequest }));
  assert.equal(refusedCappedRework([before], judged, { ...run.world.item, formalReviewBaseline: undefined, reviewRequest: agentRequest }), null);
  // A marked refusal is still matched by its mark alone.
  assert.equal(refusedCappedRework([{ ...before, reason: `${cappedRevisionMark(4)} ${before.reason}` }], judged, run.world.item), null, 'marked under revision 4');
  assert.ok(refusedCappedRework([{ ...before, reason: `${cappedRevisionMark(5)} ${before.reason}` }], judged, run.world.item), 'marked under revision 5');
});

test('unit:capped-refusal-never-silent — a refused capped rework the review-cap step cannot act on escalates, naming the decision and the next command, and never returns silently', async () => {
  // The loop already asked under revision 5, yet the only refusal predates the revision: nothing would request again.
  const run = harness(round8());
  run.world.history = [unmarked('2026-10-09T07:40:00Z', '2026-10-09T07:30:00Z')];
  asked(run);
  await run.cycle();
  await run.cycle();
  assert.deepEqual(run.world.withdrawn, []);
  const escalation = run.state.actions[cappedEscalationKey(run.world.item, D)]!;
  assert.equal(escalation.state, 'done');
  assert.match(escalation.detail, /refused its capped rework \(decision f84ee922-9b67-4a8e-aa96-a2ca189a9ccb\), but that refusal does not bind this change request under policy revision 5/);
  assert.match(escalation.detail, /a new request cites f84ee922-9b67-4a8e-aa96-a2ca189a9ccb \(--precedent f84ee922-9b67-4a8e-aa96-a2ca189a9ccb\)/);
  assert.match(escalation.detail, /graphyard master decide GY-1573 rework REASON .*then graphyard master approver GY-1573 DECISION/);
  assert.equal(run.performed.filter(entry => entry.kind === 'escalation').length, 1, 'escalated once, not on every cycle');

  // So is a refusal marked under an earlier revision.
  const marked = harness(round8());
  marked.world.history = [{ ...unmarked(), reason: `${cappedRevisionMark(4)} ${unmarked().reason}` }];
  asked(marked);
  await marked.cycle();
  assert.match(marked.state.actions[cappedEscalationKey(marked.world.item, D)]!.detail, /decision f84ee922-9b67-4a8e-aa96-a2ca189a9ccb/);

  // A capped rework under revision 5 standing before its approver names the actor: the step waits for it.
  const pending = harness(round8());
  pending.world.history = [{ ...unmarked('2026-10-09T07:40:00Z', '2026-10-09T07:30:00Z') }, { ...unmarked(), id: 'a1b2c3d4-0000-4000-8000-000000000001', state: 'requested', refusal: null, reason: `${cappedRevisionMark(5)} ${unmarked().reason}` }];
  asked(pending);
  await pending.cycle();
  assert.equal(pending.performed.length, 0, 'the approver judging the request is the actor');

  // A capped rework under revision 5 that no approver can act on any more — superseded, failed — names no actor: the step escalates.
  for (const settled of ['superseded', 'failed']) {
    const gone = harness(round8());
    gone.world.history = [{ ...unmarked('2026-10-09T07:40:00Z', '2026-10-09T07:30:00Z') }, { ...unmarked(), id: 'a1b2c3d4-0000-4000-8000-000000000002', state: settled as 'requested', refusal: null, reason: `${cappedRevisionMark(5)} ${unmarked().reason}` }];
    asked(gone);
    await gone.cycle();
    await gone.cycle();
    assert.deepEqual(gone.world.withdrawn, [], `a ${settled} request withdraws nothing`);
    const raised = gone.state.actions[cappedEscalationKey(gone.world.item, D)];
    assert.equal(raised?.state, 'done', `a ${settled} capped rework under revision 5 leaves no actor, so the step escalates`);
    assert.match(raised!.detail, /decision f84ee922-9b67-4a8e-aa96-a2ca189a9ccb.*graphyard master decide GY-1573 rework REASON/);
    assert.equal(gone.performed.filter(entry => entry.kind === 'escalation').length, 1, `escalated once across cycles beside a ${settled} request`);
  }

  // Bounded across revisions: the same stranded head under a later revision, once the loop asked under it, is escalated once more, naming that revision.
  const moved = harness(round8());
  moved.world.history = [unmarked('2026-10-09T07:40:00Z', '2026-10-09T07:30:00Z')];
  asked(moved);
  await moved.cycle();
  moved.world.item.policyRevision = 6;
  moved.world.item.formalReviewBaseline = { ...moved.world.item.formalReviewBaseline!, policyRevision: 6 };
  await moved.cycle();
  assert.equal(moved.performed.filter(entry => entry.kind === 'escalation').length, 1, 'under revision 6 the loop has yet to ask, so the round waits for that request');
  asked(moved);
  await moved.cycle();
  await moved.cycle();
  const escalated = moved.performed.filter(entry => entry.kind === 'escalation');
  assert.equal(escalated.length, 2, 'one escalation per revision, not one per cycle');
  assert.match(escalated[1].detail, /does not bind this change request under policy revision 6/);

  // A newer refusal that cites an older one leaves only the newer uncited: the escalation cites it, which answers the chain on the
  // server (standingRefusal), never the oldest alone. Two uncited refusals are both cited.
  const older = unmarked('2026-10-09T07:20:00Z', '2026-10-09T07:10:00Z', '0a0a0a0a-0000-4000-8000-000000000001');
  const newer = { ...unmarked('2026-10-09T07:40:00Z', '2026-10-09T07:30:00Z'), reason: `${unmarked().reason} Answers refusal ${older.id}.` };
  const chain = harness(round8());
  chain.world.history = [older, newer];
  asked(chain);
  await chain.cycle();
  const chained = chain.state.actions[cappedEscalationKey(chain.world.item, D)]!.detail;
  assert.match(chained, /refused its capped rework \(decision f84ee922-9b67-4a8e-aa96-a2ca189a9ccb\)/);
  assert.match(chained, /a new request cites f84ee922-9b67-4a8e-aa96-a2ca189a9ccb \(--precedent f84ee922-9b67-4a8e-aa96-a2ca189a9ccb\)/, 'the newest uncited refusal, not the oldest');
  assert.equal(standingRefusal([older, newer] as unknown as Parameters<typeof standingRefusal>[0], 'rework', older.input, `New grounds; cites ${newer.id}.`, (a, b) => JSON.stringify(a) === JSON.stringify(b), ['f84ee922-9b67-4a8e-aa96-a2ca189a9ccb']), null, 'citing the escalation\'s precedent answers the whole chain');
  const forked = harness(round8());
  forked.world.history = [older, unmarked('2026-10-09T07:40:00Z', '2026-10-09T07:30:00Z')];
  asked(forked);
  await forked.cycle();
  assert.match(forked.state.actions[cappedEscalationKey(forked.world.item, D)]!.detail, /a new request cites 0a0a0a0a-0000-4000-8000-000000000001, f84ee922-9b67-4a8e-aa96-a2ca189a9ccb \(--precedent 0a0a0a0a-0000-4000-8000-000000000001,f84ee922-9b67-4a8e-aa96-a2ca189a9ccb\)/);

  // The refused verdict is the head's: an unmarked refusal recorded while the head sat on an earlier base still binds it, as a marked one does.
  const rebased = { ...unmarked(), situation: { sha: D, baseSha: 'e'.repeat(40) } } as ReturnType<typeof unmarked>;
  assert.ok(refusedCappedRework([rebased], cappedReview(round8(), config)!, round8()), 'main moving under the head does not unbind the refusal');
});
