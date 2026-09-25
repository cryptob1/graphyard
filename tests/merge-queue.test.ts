import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ejectionReason, nextQueueSequence, predictQueue, queueOrder, queuePlacement, queueRef, type QueueEntry } from '../src/merge-queue.js';
import { decideCarry } from '../src/model/carry.js';
import { evaluate, type Evidence, type Observation, type Work } from '../src/model.js';
import { buildMasterStatus, unauthorizedMergeViolation } from '../src/master.js';

const ciAppIds = [15368];
const commit = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const now = new Date('2026-09-17T12:00:00.000Z');

function observation(work: Work, overrides: Partial<Observation> = {}): Observation {
  return {
    candidate: { ...work.candidate! }, checks: [{ name: 'test', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'reviewer', sha: work.candidate!.sha, state: 'APPROVED' }],
    merged: false, mergeSha: null, mergeable: true, protected: true, prState: 'open', draft: false,
    baseTip: work.candidate!.baseSha, files: ['src/engine.ts'], scopeFiles: [], at: now.toISOString(), ...overrides,
  };
}
function evidence(work: Work, overrides: Partial<Evidence> = {}): Evidence {
  return { id: `e-${work.key}`, proof: 'integration:queue', sha: work.candidate!.sha, baseSha: work.candidate!.baseSha,
    policyRevision: work.policyRevision, producer: 'ci-runner', trusted: true, result: 'pass', executed: 4, skipped: 0,
    at: now.toISOString(), ...overrides };
}
function work(key: string, overrides: Partial<Work> = {}): Work {
  const item = {
    id: key.toLowerCase(), key, title: key, description: '', type: 'feature', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['integration:queue'] }], policy: { checks: ['test'], review: true },
    plannedFiles: [], stage: 'merge', revision: 4, policyRevision: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    stageEnteredAt: now.toISOString(), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'machine', path: `/tmp/${key}`, branch: `graphyard/${key}`, epoch: 1, owner: 'agent' }],
    candidate: { sha: commit(`${key}head`), baseSha: commit('main'), pr: 1, branch: `graphyard/${key}`, author: 'agent' },
    submission: { epoch: 1, pr: 1 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, gates: [], violations: [], ...overrides,
  } as unknown as Work;
  item.observation ??= observation(item);
  item.evidence = item.evidence.length ? item.evidence : [evidence(item)];
  return item;
}
function enqueue(item: Work, sequence: number, speculation: QueueEntry['speculation'] = null, minutesWaiting = sequence) {
  item.queue = { sequence, enqueuedAt: new Date(now.getTime() - minutesWaiting * 60_000).toISOString(), policyRevision: item.policyRevision, speculation };
  item.queueSequence = sequence;
  return item;
}
/** An entry after Graphyard published its speculative tip: what every landing now requires. */
function published(item: Work, predecessors: string[] = []) {
  item.queue!.speculation = { ref: queueRef(item.key), tip: item.candidate!.sha, base: item.candidate!.baseSha,
    baseTree: commit('maintree'), predecessors, policyRevision: item.policyRevision, publishedAt: now.toISOString() };
  return item;
}
/** A candidate already sitting on the tip of the entry ahead of it, as Graphyard would rebase it. */
function behind(item: Work, predecessor: Work, predecessors: string[] = [predecessor.key]) {
  const tip = commit(`${item.key}tip`), base = predecessor.candidate!.sha;
  item.candidate = { ...item.candidate!, sha: tip, baseSha: base };
  item.queue!.speculation = { ref: queueRef(item.key), tip, base, baseTree: commit(`${predecessor.key}tree`), predecessors, policyRevision: item.policyRevision, publishedAt: now.toISOString() };
  item.observation = observation(item, { baseTip: commit('main') });
  item.evidence = [evidence(item)];
  return item;
}

test('queue order is the enqueue sequence, and delivered or ejected entries hold no position', () => {
  const first = enqueue(work('GY-1'), 7), second = enqueue(work('GY-2'), 3), third = enqueue(work('GY-3'), 9);
  const delivered = enqueue(work('GY-4', { stage: 'done' }), 1);
  const ejected = work('GY-5');
  assert.deepEqual(queueOrder([first, second, third, delivered, ejected]).map(item => item.key), ['GY-2', 'GY-1', 'GY-3']);
  assert.deepEqual(queueOrder([third, delivered, second, ejected, first]).map(item => item.key), ['GY-2', 'GY-1', 'GY-3'], 'order is independent of storage order');
});

test('a re-entering candidate takes a fresh sequence at the back and never reclaims its old position', () => {
  const ahead = enqueue(work('GY-1'), 4), requeued = work('GY-2');
  requeued.queueSequence = 2;
  assert.equal(nextQueueSequence([ahead, requeued]), 5);
  enqueue(requeued, nextQueueSequence([ahead, requeued]));
  assert.deepEqual(queueOrder([requeued, ahead]).map(item => item.key), ['GY-1', 'GY-2']);
});

test('entries predict against the tip ahead of them, so every position validates in parallel', () => {
  const head = published(enqueue(work('GY-1'), 1));
  const second = behind(enqueue(work('GY-2'), 2), head);
  const third = behind(enqueue(work('GY-3'), 3), second, ['GY-1', 'GY-2']);
  const [a, b, c] = predictQueue([head, second, third], now.getTime());
  assert.equal(a.predictedBase, commit('main'));
  assert.equal(b.predictedBase, head.candidate!.sha);
  assert.equal(c.predictedBase, second.candidate!.sha);
  assert.deepEqual([a.current, b.current, c.current], [true, true, true]);
  assert.deepEqual(c.predecessors, ['GY-1', 'GY-2']);
  assert.equal(a.waitMs, 60_000);
  assert.deepEqual(a.reasons, []);
  assert.match(b.reasons[0], /position 2 of 3: GY-1 is ahead/);
  assert.equal(b.publishable, false);
});

test('an entry whose predecessor has not published waits instead of predicting a base', () => {
  const head = enqueue(work('GY-1'), 1);
  head.candidate = { ...head.candidate!, baseSha: commit('stale') };
  const second = enqueue(work('GY-2'), 2);
  const [a, b] = predictQueue([head, second], now.getTime());
  assert.equal(a.current, false); assert.equal(a.publishable, true, 'the head is the only entry that may publish now');
  assert.equal(b.predictedBase, null); assert.equal(b.publishable, false);
  assert.match(b.reasons.at(-1)!, /Waiting for GY-1 to publish its speculative tip/);
});

test('a candidate Graphyard has not published a tip for cannot land, however current its base looks', () => {
  const head = enqueue(work('GY-1'), 1);
  const unpublished = predictQueue([head], now.getTime())[0];
  assert.equal(unpublished.current, false, 'only a published tip provably contains the base it was validated on');
  assert.equal(unpublished.publishable, true, 'so Graphyard publishes one rather than asking the worker for anything');
  assert.match(unpublished.reasons[0], /has not been published and validated/);
  assert.equal(predictQueue([published(head)], now.getTime())[0].current, true);
});

test('a base advance that leaves the validated tree untouched keeps the binding; any other advance refuses it', () => {
  const head = enqueue(work('GY-1'), 1);
  const tip = commit('GY-1tip'), validatedBase = commit('predecessor');
  head.candidate = { ...head.candidate!, sha: tip, baseSha: validatedBase };
  head.queue!.speculation = { ref: queueRef('GY-1'), tip, base: validatedBase, baseTree: commit('tree'), predecessors: ['GY-0'], policyRevision: 1, publishedAt: now.toISOString() };
  head.observation = observation(head, { baseTip: commit('merged'), baseTree: commit('tree') });
  assert.equal(predictQueue([head], now.getTime())[0].current, true, 'an earlier queue merge does not invalidate the tip behind it');
  head.observation = observation(head, { baseTip: commit('outside'), baseTree: commit('othertree') });
  const stale = predictQueue([head], now.getTime())[0];
  assert.equal(stale.current, false);
  assert.equal(stale.publishable, true);
  assert.match(stale.reasons[0], /has not been published and validated/);
});

test('removing an entry re-predicts the entries behind it without that entry', () => {
  const head = published(enqueue(work('GY-1'), 1));
  const second = behind(enqueue(work('GY-2'), 2), head);
  const third = behind(enqueue(work('GY-3'), 3), second, ['GY-1', 'GY-2']);
  const remaining = predictQueue([head, third], now.getTime());
  assert.deepEqual(remaining.map(entry => entry.key), ['GY-1', 'GY-3']);
  assert.equal(remaining[1].predictedBase, head.candidate!.sha, 'GY-3 now predicts against the entry that is actually ahead of it');
  assert.equal(remaining[1].current, false, 'the binding made behind GY-2 cannot be reused');
});

test('pending validation keeps an entry queued; an observed failure names the reason that ejects it', () => {
  const pending = enqueue(work('GY-1'), 1);
  pending.observation = observation(pending, { checks: [{ name: 'test', result: 'in_progress', appId: 15368 }], reviews: [] });
  assert.equal(ejectionReason(pending, ciAppIds), null);
  const failedCheck = enqueue(work('GY-2'), 2);
  failedCheck.observation = observation(failedCheck, { checks: [{ name: 'test', result: 'failure', appId: 15368 }] });
  assert.match(ejectionReason(failedCheck, ciAppIds)!, /Required CI check test did not pass on speculative tip/);
  const changes = enqueue(work('GY-3'), 3);
  changes.observation = observation(changes, { reviews: [{ reviewer: 'reviewer', sha: changes.candidate!.sha, state: 'CHANGES_REQUESTED' }] });
  assert.match(ejectionReason(changes, ciAppIds)!, /Review requested changes on speculative tip/);
  const failedProof = enqueue(work('GY-4'), 4);
  failedProof.evidence = [evidence(failedProof, { result: 'fail' })];
  assert.match(ejectionReason(failedProof, ciAppIds)!, /Proof integration:queue failed on speculative tip/);
  const revised = enqueue(work('GY-5'), 5);
  revised.policyRevision = 2;
  assert.match(ejectionReason(revised, ciAppIds)!, /Policy revision changed from 1 to 2/);
  const reworked = enqueue(work('GY-6', { reworkRequested: true }), 6);
  assert.match(ejectionReason(reworked, ciAppIds)!, /returned to the worker/);
});

test('a successful CI retry keeps an entry queued although the observation retains the failed run', () => {
  const retried = enqueue(work('GY-1'), 1);
  retried.observation = observation(retried, { checks: [{ name: 'test', result: 'failure', appId: 15368, id: 101 }, { name: 'test', result: 'success', appId: 15368, id: 102 }] });
  assert.equal(ejectionReason(retried, ciAppIds), null, 'the newest run decides, exactly as the test gate does');
  const regressed = enqueue(work('GY-2'), 2);
  regressed.observation = observation(regressed, { checks: [{ name: 'test', result: 'success', appId: 15368, id: 201 }, { name: 'test', result: 'failure', appId: 15368, id: 202 }] });
  assert.match(ejectionReason(regressed, ciAppIds)!, /Required CI check test did not pass on speculative tip/);
  const unordered = enqueue(work('GY-3'), 3);
  unordered.observation = observation(unordered, { checks: [{ name: 'test', result: 'success', appId: 15368, id: 302 }, { name: 'test', result: 'failure', appId: 15368, id: 301 }] });
  assert.equal(ejectionReason(unordered, ciAppIds), null, 'immutable run identity, not response order, selects the newest run');
});

test('an unrelated CI app cannot eject an entry and a stale observation is not a failure', () => {
  const foreign = enqueue(work('GY-1'), 1);
  foreign.observation = observation(foreign, { checks: [{ name: 'test', result: 'failure', appId: 4242 }] });
  assert.equal(ejectionReason(foreign, ciAppIds), null);
  const stale = enqueue(work('GY-2'), 2);
  stale.observation = observation(stale, { candidate: { ...stale.candidate!, sha: commit('old') }, checks: [{ name: 'test', result: 'failure', appId: 15368 }] });
  assert.equal(ejectionReason(stale, ciAppIds), null);
});

test('evaluation enqueues a proven candidate, ejects a failed one, and refuses its requeue on the same commit', () => {
  const item = work('GY-1');
  const entered = evaluate(item, [item], now, ciAppIds);
  assert.equal(entered.queue?.sequence, 1);
  assert.deepEqual(entered.queueHistory!.map(entry => entry.event), ['enqueued']);
  assert.match(entered.gates.find(gate => gate.name === 'merge')!.reasons[0], /has not been published and validated/);
  Object.assign(item, entered);
  item.observation = observation(item, { checks: [{ name: 'test', result: 'failure', appId: 15368 }] });
  const ejected = evaluate(item, [item], now, ciAppIds);
  assert.equal(ejected.queue, null);
  assert.match(ejected.queueEjection!.reason, /Required CI check test did not pass/);
  assert.deepEqual(ejected.queueHistory!.map(entry => entry.event), ['enqueued', 'ejected']);
  Object.assign(item, ejected);
  item.observation = observation(item);
  const requeued = evaluate(item, [item], now, ciAppIds);
  assert.equal(requeued.queue, null, 'the same commit that failed cannot re-enter the queue');
  assert.match(requeued.gates.find(gate => gate.name === 'merge')!.reasons[0], /Ejected from the merge queue/);
  Object.assign(item, requeued);
  item.candidate = { ...item.candidate!, sha: commit('fixed') };
  item.observation = observation(item); item.evidence = [evidence(item)];
  const reentered = evaluate(item, [item], now, ciAppIds);
  assert.equal(reentered.queue?.sequence, 2, 'a new candidate re-enters at the back with a new sequence');
});

test('a queued entry behind the head has no merge authorization, and the queue ref is Graphyard-owned', () => {
  const head = published(enqueue(work('GY-1'), 1));
  const second = behind(enqueue(work('GY-2'), 2), head);
  const all = [head, second];
  assert.deepEqual(evaluate(head, all, now, ciAppIds).gates.find(gate => gate.name === 'merge')!.reasons, []);
  const waiting = evaluate(second, all, now, ciAppIds).gates.find(gate => gate.name === 'merge')!;
  assert.equal(waiting.passed, false);
  assert.match(waiting.reasons[0], /position 2 of 2: GY-1 is ahead/);
  assert.equal(queueRef('GY-41'), 'refs/graphyard/queue/gy-41');
  assert.equal(queueRef('GY-41').startsWith('refs/heads/') || queueRef('GY-41').startsWith('refs/tags/'), false);
});

test('unit:queue-tree-equivalent-base — a predicted base that changes to a tree-identical commit keeps the published tip and binding; a different tree republishes', () => {
  const head = enqueue(work('GY-1'), 1);
  const tip = commit('GY-1tip'), validatedBase = commit('predecessor');
  head.candidate = { ...head.candidate!, sha: tip, baseSha: validatedBase };
  head.queue!.speculation = { ref: queueRef('GY-1'), tip, base: validatedBase, baseTree: commit('tree'), predecessors: ['GY-0'], policyRevision: 1, publishedAt: now.toISOString() };
  head.observation = observation(head, { baseTip: validatedBase, baseTree: commit('tree') });
  head.evidence = [evidence(head)];
  const exact = predictQueue([head], now.getTime())[0];
  assert.deepEqual([exact.current, exact.binding, exact.publishable], [true, 'exact', false]);
  assert.deepEqual(exact.base, { sha: validatedBase, tree: commit('tree') });
  // GY-0 merged with merge_method=merge: main is a new commit whose tree is exactly GY-0's validated tip tree.
  head.observation = observation(head, { baseTip: commit('merged'), baseTree: commit('tree') });
  const kept = predictQueue([head], now.getTime())[0];
  assert.deepEqual([kept.current, kept.binding, kept.publishable, kept.tip, kept.predictedBase], [true, 'tree-equivalent', false, tip, commit('merged')]);
  assert.deepEqual(kept.base, { sha: commit('merged'), tree: commit('tree') }, 'the chain now rests on the advanced commit');
  const gates = evaluate(head, [head], now, ciAppIds);
  assert.deepEqual(gates.gates.find(gate => gate.name === 'merge')!.reasons, [], 'nothing is republished and no binding is refused');
  assert.equal(head.candidate!.baseSha, validatedBase, 'the candidate stays bound to the sha it was validated on');
  // Any other advance changes the tree: the tip is stale and Graphyard publishes a new one.
  head.observation = observation(head, { baseTip: commit('outside'), baseTree: commit('othertree') });
  const stale = predictQueue([head], now.getTime())[0];
  assert.deepEqual([stale.current, stale.binding, stale.publishable], [false, null, true]);
  assert.match(stale.reasons[0], /has not been published and validated/);
  // Tree equivalence never substitutes for publication: an unpublished head on a tree-identical base still publishes.
  head.queue!.speculation = null; head.observation = observation(head, { baseTip: commit('merged'), baseTree: commit('tree') });
  assert.equal(predictQueue([head], now.getTime())[0].publishable, true);
});

/** GY-196: an entry that fell back out of validation — here, its tip needs approval afresh — while it keeps its sequence. */
function fellBack(item: Work) {
  item.stage = 'review';
  item.observation = observation(item, { reviews: [] });
  item.gates = [{ name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }];
  return item;
}

test('unit:unvalidated-predecessor-skipped — an entry sent back to review is no predecessor: the entry behind it is predicted on the base branch and its approval and proofs carry without it', () => {
  const main = commit('main'), old = commit('old'), headB = commit('GYBhead'), tipB = commit('GYBtip'), rebuilt = commit('GYBrebuilt');
  const a = published(enqueue(work('GY-A'), 1));
  const b = enqueue(work('GY-B', { candidate: { sha: headB, baseSha: old, pr: 2, branch: 'graphyard/GY-B', author: 'agent' } }), 2);
  b.evidence = [evidence(b, { scopeFiles: ['src/engine.ts'] })];
  const reviewed = b.evidence[0];
  // B's tip was built behind A while A was validated: a merge of B's reviewed head and A's tip.
  b.candidate = { ...b.candidate!, sha: tipB, baseSha: a.candidate!.sha };
  b.queue!.speculation = { ref: queueRef('GY-B'), tip: tipB, base: a.candidate!.sha, baseTree: commit('GYAtree'), predecessors: ['GY-A'], policyRevision: 1, publishedAt: now.toISOString(), reviewedHead: headB,
    merge: { from: headB, parents: [headB, a.candidate!.sha], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['src/a.ts'] } };
  b.observation = observation(b, { baseTip: main, reviews: [{ reviewer: 'reviewer', sha: headB, state: 'APPROVED' }] });
  const [aheadOfB, behindA] = predictQueue([a, b], now.getTime());
  assert.deepEqual([behindA.position, behindA.predecessors, behindA.predictedBase, behindA.current], [1, ['GY-A'], a.candidate!.sha, true], 'while A is validated, B is predicted on its tip');
  assert.equal(aheadOfB.position, 0);

  // A goes back to review: its tip needs a fresh approval. It keeps its sequence, but it is no predecessor.
  fellBack(a);
  assert.deepEqual(queueOrder([a, b]).map(item => item.key), ['GY-A', 'GY-B'], 'A keeps its entry and sequence');
  const [skippedA, head] = predictQueue([a, b], now.getTime());
  assert.equal(skippedA.position, 0, 'A itself is still predicted, on the base branch');
  assert.deepEqual([head.position, head.predecessors, head.skipped, head.predictedBase], [0, [], ['GY-A'], main], "B's predicted base excludes A: it is the base branch");
  assert.deepEqual(head.base, { sha: main, tree: null });
  assert.deepEqual([head.current, head.publishable], [false, true], "B's tip behind A is stale and is rebuilt on the base branch alone");
  assert.equal(head.reasons.some(reason => reason.includes('GY-A')), false, 'nothing in B\'s merge gate names A');

  // Graphyard rebuilds B's tip from its own reviewed head onto main, and decides the carry from
  // the prediction: no predecessor, so the base branch — validated by definition — and the files
  // A's tip changed relative to it, which B's review and proof never read.
  const merge = { from: headB, parents: [headB, main], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['src/a.ts'] };
  const carry = decideCarry({ from: { sha: headB, baseSha: b.candidate!.baseSha }, to: { sha: rebuilt, baseSha: main }, policyRevision: 1, at: now.toISOString(), merge,
    predecessor: { key: head.predecessors.at(-1) ?? null, validated: true }, reviewedFiles: ['src/engine.ts'],
    approval: { provider: 'github', reviewer: 'reviewer', sha: headB }, proofs: [{ proof: 'integration:queue', evidence: reviewed }], app: 'control-plane' });
  assert.equal(carry.predecessor, 'base branch');
  assert.equal(carry.approval.carried, true, carry.approval.reason);
  assert.deepEqual(carry.evidence.map(entry => [entry.proof, entry.carried, entry.evidenceId]), [['integration:queue', true, reviewed.id]]);
  assert.doesNotMatch(carry.approval.reason, /GY-A|not fully validated/);
  // What the incident refused, for contrast: the same tip decided behind the unvalidated entry.
  const refused = decideCarry({ from: { sha: headB, baseSha: b.candidate!.baseSha }, to: { sha: rebuilt, baseSha: main }, policyRevision: 1, at: now.toISOString(), merge,
    predecessor: { key: 'GY-A', validated: false }, reviewedFiles: ['src/engine.ts'], approval: { provider: 'github', reviewer: 'reviewer', sha: headB }, proofs: [{ proof: 'integration:queue', evidence: reviewed }], app: 'control-plane' });
  assert.match(refused.approval.reason, /predecessor GY-A is not fully validated/);

  // Bound, the rebuilt tip is the queue's head: review and acceptance pass on the carried bindings,
  // and the merge gate waits on nothing A does.
  b.candidate = { ...b.candidate!, sha: rebuilt, baseSha: main };
  b.queue!.speculation = { ref: queueRef('GY-B'), tip: rebuilt, base: main, baseTree: commit('maintree'), predecessors: head.predecessors, policyRevision: 1, publishedAt: now.toISOString(), reviewedHead: headB, merge, carry };
  b.observation = observation(b, { baseTip: main, baseTree: commit('maintree'), reviews: [{ reviewer: 'reviewer', sha: headB, state: 'APPROVED' }] });
  const bound = predictQueue([a, b], now.getTime())[1];
  assert.deepEqual([bound.position, bound.current, bound.tip, bound.predecessors], [0, true, rebuilt, []]);
  const gates = evaluate(b, [a, b], now, ciAppIds);
  for (const name of ['review', 'acceptance']) assert.equal(gates.gates.find(gate => gate.name === name)!.passed, true, `${name}: ${gates.gates.find(gate => gate.name === name)!.reasons.join('; ')}`);
  assert.deepEqual(gates.gates.find(gate => gate.name === 'merge')!.reasons, [], 'B lands first; A is not ahead of it');
  assert.equal(gates.stage, 'merge');

  // Once A is validated again it is a predecessor again, in its sequence.
  a.stage = 'merge'; a.observation = observation(a); a.gates = [];
  assert.deepEqual(predictQueue([a, b], now.getTime())[1].predecessors, ['GY-A']);
});

test('unit:no-ejection-on-unvalidated-conflict — an entry that conflicts with an unvalidated predecessor\'s tip but not with the base branch stays queued and is re-predicted without it', () => {
  const main = commit('main');
  const a = published(enqueue(work('GY-A'), 1));
  const b = enqueue(work('GY-B', { candidate: { sha: commit('GYBhead'), baseSha: commit('old'), pr: 2, branch: 'graphyard/GY-B', author: 'agent' } }), 2);
  b.observation = observation(b, { baseTip: main }); b.evidence = [evidence(b)];
  // B's change conflicts with A's tip and merges cleanly onto the base branch.
  const merges: string[] = [];
  const speculativeMerge = (head: string, base: string) => { merges.push(base); return base === a.candidate!.sha ? null : commit(`${head.slice(0, 4)}merged`); };
  // What the queue does for B on each pass (see advanceQueue): publish onto the placement's predicted
  // base, or eject on a conflict.
  const advance = () => {
    const placement = queuePlacement(b, [a, b], now.getTime())!;
    if (placement.current || !placement.publishable) return { placement, ejected: null };
    const tip = speculativeMerge(b.candidate!.sha, placement.predictedBase!);
    return { placement, ejected: tip ? null : `Speculative merge of ${placement.predictedBase!.slice(0, 12)} into ${b.candidate!.branch} conflicts and cannot be resolved by Graphyard` };
  };
  // A validated A really is where B lands, so the conflict is B's to resolve.
  const validatedA = advance();
  assert.equal(validatedA.placement.predictedBase, a.candidate!.sha);
  assert.match(validatedA.ejected!, /conflicts and cannot be resolved/);

  // A falls back to review before B's merge is attempted: B is re-predicted on the base branch alone,
  // the conflicting merge with A's tip is never made, and B stays in the queue.
  fellBack(a); merges.length = 0;
  const skipped = advance();
  assert.deepEqual([skipped.placement.predictedBase, skipped.placement.predecessors, skipped.placement.skipped, skipped.placement.position], [main, [], ['GY-A'], 0]);
  assert.equal(skipped.ejected, null);
  assert.deepEqual(merges, [main], 'the only merge made is onto the base branch');
  assert.equal(ejectionReason(b, ciAppIds, [a, b]), null);
  const evaluated = evaluate(b, [a, b], now, ciAppIds);
  assert.equal(evaluated.queue?.sequence, 2, 'B keeps its entry');
  assert.equal(evaluated.queueEjection ?? null, null);
  assert.deepEqual(evaluated.queueHistory ?? [], [], 'nothing was ejected');
  assert.equal(evaluated.gates.find(gate => gate.name === 'merge')!.reasons.some(reason => reason.includes('GY-A')), false);
});

test('an entry passed over shares its chain position with the entry behind it, and a merged entry\'s waiters are the entries behind it by sequence', () => {
  const a = fellBack(published(enqueue(work('GY-A'), 1)));
  const m = published(enqueue(work('GY-M', { candidate: { sha: commit('GYMhead'), baseSha: commit('main'), pr: 2, branch: 'graphyard/GY-M', author: 'agent' } }), 2));
  m.observation = observation(m, { merged: true, mergeSha: commit('mergedM'), prState: 'closed' });
  m.violations = [unauthorizedMergeViolation];
  const c = enqueue(work('GY-C', { candidate: { sha: commit('GYChead'), baseSha: commit('main'), pr: 3, branch: 'graphyard/GY-C', author: 'agent' } }), 3);
  const placements = predictQueue([a, m, c], now.getTime());
  assert.deepEqual(placements.map(entry => [entry.key, entry.position, entry.sequence]), [['GY-A', 0, 1], ['GY-M', 0, 2], ['GY-C', 1, 3]], 'A is passed over, so M heads the chain beside it');
  const row = buildMasterStatus({ work: [a, m, c], now: now.toISOString() }, [], []).work.find(entry => entry.key === 'GY-M')!;
  assert.deepEqual(row.merged?.queue, { sequence: 2, position: 1, size: 2, unpublishable: true, behind: ['GY-C'] }, 'neither M itself nor the passed-over A waits behind M');
  assert.match(row.attention!, /GY-C wait behind it/);
});
