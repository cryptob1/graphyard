import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import type { Store } from '../src/store.js';
import { evaluate, type Evidence, type Observation, type Principal, type Work } from '../src/model.js';
import { openProducerRequest, producerGroupDecisions, producerGroupOf, reconcileAutoDispatch } from '../src/model/dispatch.js';
import { actionAccount, nextAction } from '../src/model/next-action.js';

/**
 * GY-188: proofs that can never pass before merge held items for days.
 *
 * - `unit:planner-matches-reconciler` — the next-action planner names a proof dispatch only for a
 *   group the reconciler has opened a producer request for. A group one of whose proofs already
 *   failed names rework (escalate for a manual proof) and a group with nothing open names a wait,
 *   never a dispatch the executor would refuse with "no open producer request" forever.
 * - `unit:postmerge-proof-refused-premerge` — create and requirements refuse a pre-merge proof
 *   that can only pass after merge or deployment, naming the delivery obligation to use instead.
 *
 * Pure: the work items are built by hand and graded by the real gate evaluator, and the commands
 * are refused while their input is parsed, before the engine touches its store.
 */

const CI_APP = 15368;
const now = new Date('2026-09-24T12:00:00.000Z');
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

type Outcome = 'pass' | 'fail' | 'none';
function evidence(proof: string, result: 'pass' | 'fail', index: number): Evidence {
  return { id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, proof, sha: head, baseSha: base, policyRevision: 1, producer: 'ci-runner', trusted: true,
    result, executed: 3, skipped: 0, at: at(10 - index / 100) } as Evidence;
}
function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    clockOffset: { min: 0, max: 0 },
    candidate: { sha: head, baseSha: base, pr: 188, branch: 'graphyard/gy-188-1', author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: CI_APP }, { name: 'typecheck', result: 'success', appId: CI_APP }],
    reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/planner.ts'], scopeFiles: [], at: at(1),
    prState: 'open', draft: false, baseTip: base, baseTipContained: true, ...overrides,
  };
}
/** A submitted, observed item whose proofs stand as `outcomes` say, graded by the real evaluator. */
function item(outcomes: Record<string, Outcome>, options: { producerProofs?: string[]; observation?: Partial<Observation>; approved?: boolean } = {}): Work {
  const proofs = Object.keys(outcomes);
  const work = {
    id: '11111111-2222-4333-8444-555555555555', key: 'GY-900', title: 'Planner fixture', description: '', type: 'bug', priority: 2, dependencies: [],
    criteria: proofs.map((proof, index) => ({ id: `AC-${index + 1}`, text: `Criterion ${index + 1}`, proofs: [proof] })),
    policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/'], producerProofs: options.producerProofs ?? [],
    stage: 'build', revision: 5, policyRevision: 1, createdAt: at(120), updatedAt: at(5), stageEnteredAt: at(60), ready: true,
    epoch: 1, lease: null, workspaces: [{ host: 'machine-a', path: '/tmp/gy-900', branch: 'graphyard/gy-188-1', epoch: 1, owner: 'agent-a' }],
    implementers: ['agent-a'], lastAssignment: { owner: 'agent-a', epoch: 1 },
    candidate: { sha: head, baseSha: base, pr: 188, branch: 'graphyard/gy-188-1', author: 'implementer' }, submission: { epoch: 1, pr: 188 },
    evidence: proofs.flatMap((proof, index) => outcomes[proof] === 'none' ? [] : [evidence(proof, outcomes[proof] as 'pass' | 'fail', index)]),
    observation: observation({ ...(options.approved ? { reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED' }] } : {}), ...options.observation }),
    gates: [], violations: [], blocker: null, queue: null, queueSequence: 0, queueHistory: [],
  } as unknown as Work;
  return grade(work);
}
function grade(work: Work): Work {
  const result = evaluate(work, [work], now, [CI_APP]);
  return { ...work, stage: result.stage, gates: result.gates, violations: result.violations, queue: result.queue, queueSequence: result.queueSequence, queueEjection: result.queueEjection, queueHistory: result.queueHistory };
}
/** The item as the control plane holds it after a reading: the reconciler has run over it. */
function reconciled(work: Work): Work {
  const copy = structuredClone(work);
  reconcileAutoDispatch(copy, [copy], now);
  return copy;
}
const proofDispatch = (work: Work) => {
  const action = nextAction(work, [work], now);
  return action?.kind === 'dispatch' && action.inputs.kind === 'dispatch' && action.inputs.target === 'proof' ? action : null;
};

test('unit:planner-matches-reconciler — a group one of whose proofs failed while another is unproven yields no proof dispatch: rework for a mechanical group, escalate for a manual one', () => {
  // A mechanical group: unit:a failed on the head and unit:b has not run.
  const mechanical = reconciled(item({ 'unit:a': 'fail', 'unit:b': 'none' }));
  assert.equal(openProducerRequest(mechanical, 'unit'), null, 'the reconciler opens no unit request once a unit proof failed');
  assert.deepEqual(producerGroupDecisions(mechanical, [mechanical], now).map(entry => [entry.group, entry.state]), [['unit', 'failed']]);
  assert.equal(proofDispatch(mechanical), null, 'no dispatch/proof action is named for the failed group');
  assert.equal(nextAction(mechanical, [mechanical], now)?.kind, 'request-rework', 'the head returns to its worker');

  // The GY-72 shape: a manual group whose first proof failed and whose second is unproven, on an
  // approved head whose unit proof passed, so the acceptance gate is the one refusing.
  const manual = reconciled(item({ 'unit:a': 'pass', 'manual:live-x': 'fail', 'manual:live-y': 'none' }, { producerProofs: ['manual:live-x', 'manual:live-y'], approved: true }));
  assert.equal(manual.gates.find(gate => !gate.passed)?.name, 'acceptance');
  assert.equal(openProducerRequest(manual, 'manual'), null, 'the reconciler opens no manual request once a manual proof failed');
  assert.equal(proofDispatch(manual), null, 'no dispatch/proof action is named for the failed group');
  const escalation = nextAction(manual, [manual], now);
  assert.equal(escalation?.kind, 'escalate');
  assert.match(escalation!.reason, /manual:live-x/, 'the escalation names the failed proof');
});

test('unit:planner-matches-reconciler — a group with something left to prove and no open request names a wait, and the dispatch once the reconciler opens it carries that request', () => {
  const unread = item({ 'unit:a': 'none', 'integration:b': 'none' });
  assert.equal(unread.autoDispatch, undefined, 'no reading has run the reconciler yet');
  const account = actionAccount(unread, [unread], now);
  assert.equal(account.action, null, 'no dispatch is named without an open request');
  assert.equal(account.defect, null);
  assert.equal(account.wait?.kind, 'session');
  assert.equal(account.wait?.on, 'graphyard');
  assert.match(account.wait!.detail, /no unit producer request is open yet/);

  const read = reconciled(unread);
  const action = proofDispatch(read);
  assert.ok(action, 'the open request is dispatched');
  assert.equal(action!.inputs.kind === 'dispatch' && action!.inputs.target === 'proof' && action!.inputs.requestId, openProducerRequest(read, 'unit')!.id);

  // A head no request may stand for (a draft) never names a dispatch either.
  const draft = reconciled(item({ 'unit:a': 'none' }, { observation: { draft: true } }));
  assert.equal(proofDispatch(draft), null);
});

test('unit:planner-matches-reconciler — a retained request answers to its whole group: a sibling proof that fails later resolves it, so no producer is launched on a head the planner escalates', () => {
  // A mechanical failure already refuses the build gate and cancels every request; a manual one
  // does not, so the manual group is where a retained request could outlive its group's failure.
  // manual:live-y already passed, so the manual request asks only for manual:live-x.
  const options = { producerProofs: ['manual:live-x', 'manual:live-y'], approved: true };
  const held = reconciled(item({ 'unit:a': 'pass', 'manual:live-x': 'none', 'manual:live-y': 'pass' }, options));
  const request = openProducerRequest(held, 'manual')!;
  assert.deepEqual(request.proofs, ['manual:live-x']);
  // A later trusted run fails manual:live-y on the same head: the group is failed as a whole.
  const failedAgain = grade({ ...held, evidence: [...held.evidence, { ...evidence('manual:live-y', 'fail', 9), at: at(0) }] });
  assert.deepEqual(producerGroupDecisions(failedAgain, [failedAgain], now).filter(entry => entry.group === 'manual').map(entry => entry.state), ['failed']);
  const transitions = reconcileAutoDispatch(failedAgain, [failedAgain], now);
  assert.deepEqual(transitions.map(entry => [entry.event, entry.request.id]), [['dispatch.satisfied', request.id]], 'the retained manual:live-x request is resolved, not kept');
  assert.match(transitions[0].request.resolution!, /trusted evidence failed for manual:live-y \(ci-runner\); the next head is requested afresh/);
  assert.equal(openProducerRequest(failedAgain, 'manual'), null);
  assert.equal(proofDispatch(failedAgain), null);
  assert.equal(nextAction(failedAgain, [failedAgain], now)?.kind, 'escalate');
});

/** A deterministic generator, so a failing case reproduces from its seed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('unit:planner-matches-reconciler — property: every dispatch/proof action has an open, bound request for its group that the reconciler keeps, asking for the proofs it names', () => {
  const pool = ['unit:a', 'unit:b', 'integration:c', 'integration:d', 'manual:e', 'manual:f'];
  const outcomes: Outcome[] = ['pass', 'fail', 'none'];
  const next = random(188);
  const pick = <T>(values: T[]) => values[Math.floor(next() * values.length)];
  let dispatched = 0, held = 0;
  for (let run = 0; run < 600; run++) {
    const chosen = pool.filter(() => next() < 0.5);
    const proofs = chosen.length ? chosen : [pick(pool)];
    const producerProofs = proofs.filter(proof => proof.startsWith('manual:') && next() < 0.7);
    const variant = pick(['open', 'open', 'open', 'draft', 'closed', 'unobserved-head']);
    const work = item(Object.fromEntries(proofs.map(proof => [proof, pick(outcomes)])), {
      producerProofs, approved: next() < 0.5,
      observation: variant === 'draft' ? { draft: true } : variant === 'closed' ? { prState: 'closed' } : variant === 'unobserved-head' ? { candidate: { sha: 'c'.repeat(40), baseSha: base, pr: 188, branch: 'graphyard/gy-188-1', author: 'implementer' } } : {},
    });
    // Unread, read once, or read and then left holding requests for an older head.
    const state = pick(['unread', 'read', 'stale']);
    let subject = state === 'unread' ? work : reconciled(work);
    if (state === 'stale') subject = { ...subject, candidate: { ...subject.candidate!, sha: 'd'.repeat(40) } };
    const action = proofDispatch(subject);
    const failed = producerGroupDecisions(subject, [subject], now).some(entry => entry.state === 'failed');
    if (failed) assert.equal(action, null, `run ${run}: a failed proof group never yields a proof dispatch`);
    if (!action) { held++; continue; }
    dispatched++;
    assert.ok(action.inputs.kind === 'dispatch' && action.inputs.target === 'proof');
    const { group, requestId, proofs: named } = action.inputs as Extract<typeof action.inputs, { target: 'proof' }>;
    const request = openProducerRequest(subject, group);
    assert.ok(request, `run ${run} (${state}, ${variant}): a dispatch/proof action for ${group} has an open request for its group`);
    assert.equal(requestId, request!.id, `run ${run}: the action carries that request`);
    assert.ok(named.length > 0 && named.every(proof => producerGroupOf(proof) === group && request!.proofs!.includes(proof)), `run ${run}: it asks only for proofs the request asks for`);
    // The reconciler, reading the same item again, keeps the request rather than resolving it.
    const again = structuredClone(subject);
    const transitions = reconcileAutoDispatch(again, [again], now);
    assert.ok(!transitions.some(entry => entry.request.id === request!.id), `run ${run}: the reconciler keeps the request the planner dispatches`);
  }
  assert.ok(dispatched > 20 && held > 20, `both answers are exercised (${dispatched} dispatched, ${held} not)`);
});

// ---- AC-2 --------------------------------------------------------------------------------------

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const engine = new Engine({} as Store, [CI_APP], 120, 'owner/project');
const refusal = async (command: 'create' | 'requirements', input: unknown) => {
  try { await engine.execute(operator, command, command === 'create' ? null : '11111111-2222-4333-8444-555555555555', input, `gy-188-${command}`); }
  catch (error) { return error instanceof Error ? error.message : String(error); }
  assert.fail(`${command} accepted a pre-merge post-merge proof`);
};
const requirements = (criteria: unknown) => ({ expectedPolicyRevision: 1, reason: 'Tighten the proof', criteria, dependencies: [], plannedFiles: ['src/'], exclusiveResources: [] });

test('unit:postmerge-proof-refused-premerge — create and requirements refuse a pre-merge *-postmerge proof and name the delivery or deploy-smoke obligation to use instead', async () => {
  const postmerge = [{ id: 'AC-1', text: 'The speed target is met on trunk', proofs: ['manual:speed-target-met-postmerge'] }];
  for (const message of [await refusal('create', { title: 'Speed', plannedFiles: ['src/'], criteria: postmerge }), await refusal('requirements', requirements(postmerge))]) {
    assert.match(message, /AC-1: manual:speed-target-met-postmerge is a post-merge proof/);
    assert.match(message, /can never pass before the merge it gates/);
    assert.match(message, /Require it as a delivery obligation instead: policy\.deploySmoke for e2e:deploy-smoke/);
    assert.match(message, /follow-up work item that depends on this one/);
  }
  // A post-deploy name, and a criterion that declares itself post-merge, are refused alike.
  assert.match(await refusal('create', { title: 'Live', plannedFiles: ['src/'], criteria: [{ id: 'AC-2', text: 'Live', proofs: ['integration:checkout/post-deploy'] }] }), /integration:checkout\/post-deploy is a post-merge proof/);
  assert.match(await refusal('requirements', requirements([{ id: 'AC-3', text: 'Post-merge: the dashboard shows the release', proofs: ['manual:dashboard-release'] }])),
    /AC-3 is a post-merge criterion, so manual:dashboard-release can only pass after merge.*policy\.deploySmoke/);

  // An ordinary criterion that merely mentions merging is not one: it reaches the store, which this
  // engine does not have, rather than being refused at parse.
  const ordinary = [{ id: 'AC-1', text: 'A post-merge proof is never a pre-merge gate', proofs: ['unit:postmerge-proof-refused-premerge'] }];
  const reached = await engine.execute(operator, 'create', null, { title: 'Ordinary', plannedFiles: ['src/'], criteria: ordinary }, 'gy-188-ordinary').then(() => 'accepted', (error: Error) => error.message);
  assert.doesNotMatch(reached, /post-merge proof|post-merge criterion/);
});
