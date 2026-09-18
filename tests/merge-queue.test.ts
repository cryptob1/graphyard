import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ejectionReason, nextQueueSequence, predictQueue, queueOrder, queueRef, type QueueEntry } from '../src/merge-queue.js';
import { evaluate, type Evidence, type Observation, type Work } from '../src/model.js';

const ciAppIds = [15368];
const commit = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const now = new Date('2026-09-17T12:00:00.000Z');

function observation(work: Work, overrides: Partial<Observation> = {}): Observation {
  return {
    candidate: { ...work.candidate! }, checks: [{ name: 'test', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'reviewer', sha: work.candidate!.sha, state: 'APPROVED' }],
    merged: false, mergeSha: null, mergeable: true, protected: true, prState: 'open', draft: false,
    baseTip: work.candidate!.baseSha, files: ['src/engine.ts'], at: now.toISOString(), ...overrides,
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
