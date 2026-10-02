import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStallAttention } from '../src/cli/master-status.js';
import type { GitHubMergeQueueState } from '../src/merge-queue.js';
import type { Observation, Work } from '../src/model.js';
import { actOnRepeatedRefusal, repeatedMergeRefusalMs, staleObservationReason } from '../src/daemon/cycle-delivery.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { MasterConfig } from '../src/master.js';

// GY-344: GY-245 sat "merge waiting" for over ten minutes on an UNSTABLE head that GitHub would
// merge, with no refusal recorded, and nothing in master status said so. A merge pending more than
// five minutes on a head GitHub reports mergeable is now named, with its pull request, merge state
// and the request's age.

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const now = Date.parse('2026-09-25T19:30:00.000Z');

function work(minutes: number, overrides: Partial<GitHubMergeQueueState> = {}, item: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 198, branch: 'graphyard/gy-245-1', author: 'worker' };
  const githubQueue: GitHubMergeQueueState = { pullRequestId: 'PR_kw', head, queue: false, mergeStateStatus: 'UNSTABLE', mode: 'auto-merge', entryState: null, position: null, groupHead: null,
    at: new Date(now).toISOString(), refused: null, requestedAt: new Date(now - minutes * 60_000).toISOString(), ...overrides };
  return { id: 'work-245', key: 'GY-245', title: 'Pending merge', stage: 'merge', candidate,
    observation: { at: new Date(now).toISOString(), candidate, merged: false, githubQueue } as unknown as Observation, ...item } as Work;
}
const attention = (items: Work[]) => mergeStallAttention({ work: items, now: new Date(now).toISOString() });

test('unit:merge-stall-surfaced — a merge pending six minutes on an UNSTABLE head is a merge-stalled attention item naming the pull request, its merge state and the request\'s age; four minutes is not', () => {
  const [item, ...rest] = attention([work(6)]);
  assert.equal(rest.length, 0);
  assert.equal(item.subject, 'GY-245');
  assert.match(item.text, /^merge-stalled: GY-245 pull request #198 at aaaaaaaaaaaa has been requested for merge for 6 minutes/);
  assert.match(item.text, /mergeStateStatus UNSTABLE/);
  assert.match(item.text, /no refusal is recorded/);
  assert.equal((item as any).role, 'master');
  assert.deepEqual(attention([work(4)]), [], 'four minutes is within the bound');

  for (const mergeStateStatus of ['CLEAN', 'HAS_HOOKS']) assert.equal(attention([work(6, { mergeStateStatus })]).length, 1, mergeStateStatus);
  // Not mergeable, refused, queued, another head, no current request, or merged: not a stall.
  // BLOCKED under auto-merge is named with GitHub's blocking reason instead (GY-430, merge-queue.ts blockedMergeStall).
  for (const mergeStateStatus of ['BEHIND', 'DIRTY', 'UNKNOWN', null]) assert.deepEqual(attention([work(60, { mergeStateStatus })]), [], String(mergeStateStatus));
  assert.deepEqual(attention([work(60, { mergeStateStatus: 'BLOCKED', mode: 'none' })]), []);
  assert.deepEqual(attention([work(60, { refused: { reason: 'GitHub refused to enqueue GY-245: no', head, mode: 'none', at: new Date(now).toISOString() } })]), []);
  assert.deepEqual(attention([work(60, { queue: true })]), []);
  assert.deepEqual(attention([work(60, { head: 'c'.repeat(40) })]), []);
  assert.deepEqual(attention([work(60, { requestedAt: null })]), []);
  assert.deepEqual(attention([work(60, {}, { stage: 'done' })]), []);
});

// GY-1099: on 2026-10-02 seven candidates whose every other gate passed were marked for rework and
// ejected because their GitHub observation had gone stale. A refusal standing only on observation
// freshness keeps the queue position and asks for a prioritized observation instead.
test('unit:stale-observation-refusal-keeps-position — a repeated refusal whose only failure is a stale observation is observed, never marked for rework or ejected; any other refusal still takes the GY-831 path', async () => {
  const clock = Date.parse('2026-10-02T04:20:00.000Z');
  const since = new Date(clock - repeatedMergeRefusalMs - 60_000).toISOString();
  const reason = 'GY-806 merge refused: does not have a current all-gates-passing merge authorization';
  const gates = (merge: string[], others: Partial<Record<string, string[]>> = {}) => ['build', 'review', 'test', 'acceptance', 'merge'].map(name => {
    const reasons = name === 'merge' ? merge : others[name] ?? [];
    return { name, passed: !reasons.length, reasons };
  });
  const candidate = { sha: head, baseSha: base, pr: 379, branch: 'graphyard/gy-806-1', author: 'worker' };
  const item = (gateList: ReturnType<typeof gates>, observedAgoMs = 150_000, extra: Partial<Work> = {}) => ({ id: 'work-806', key: 'GY-806', stage: 'merge', candidate, policyRevision: 1, violations: [],
    queue: { sequence: 4 }, gates: gateList, observation: { at: new Date(clock - observedAgoMs).toISOString(), candidate, merged: false }, ...extra }) as unknown as Work;
  const harness = () => {
    const state = emptyDaemonState({ url: 'https://graphyard.example', repository: 'owner/project', autoMerge: true } as MasterConfig);
    const calls = { refused: [] as string[], observed: [] as string[] };
    const effects = { persist: async () => {}, refuseMerge: async (work: Work, text: string) => { calls.refused.push(text); return work; }, observeCandidate: async (work: Work) => { calls.observed.push(work.key); } };
    let now = clock;
    const cycle = { state, effects, performed: [] as Cycle['performed'], now: () => now } as unknown as Cycle;
    return { state, calls, cycle, advance: (ms: number) => { now += ms; } };
  };
  const mergeKey = 'merge:work-806:aaaa';

  // Stale only: observed ahead of the backlog, never reported as a refusal, the queue position kept.
  // With no observation at all the merge gate also carries the unverified-protection reason gates.ts
  // adds, since only an observation verifies protection: the same missing observation, still observed.
  const unverified = 'Required Graphyard check and merge-queue branch protection have not been verified';
  for (const work of [item(gates([staleObservationReason])), item(gates([staleObservationReason]), 0, { observation: null } as Partial<Work>),
    item(gates([staleObservationReason, unverified]), 0, { observation: null } as Partial<Work>)]) {
    const { state, calls, cycle, advance } = harness();
    await actOnRepeatedRefusal(cycle, work, mergeKey, reason, since);
    assert.deepEqual(calls, { refused: [], observed: ['GY-806'] });
    assert.deepEqual(work.queue, { sequence: 4 }, 'the candidate keeps its queue position');
    const action = state.actions[`${mergeKey}:repeated:observe`];
    assert.deepEqual([action.kind, action.state, action.work, action.since], ['refresh', 'done', 'GY-806', since]);
    assert.match(action.detail, /requests an observation of candidate aaaaaaaaaaaa ahead of the backlog and keeps its queue position; it is neither marked for rework nor ejected/);
    assert.equal(Object.keys(state.actions).some(key => key.endsWith(':repeated:rework')), false, 'no rework marker');
    // Requested once per observation window while the same refusal stands, then again.
    await actOnRepeatedRefusal(cycle, work, mergeKey, reason, since);
    assert.equal(calls.observed.length, 1);
    advance(120_000);
    await actOnRepeatedRefusal(cycle, work, mergeKey, reason, since);
    assert.deepEqual(calls, { refused: [], observed: ['GY-806', 'GY-806'] });
  }

  // A failed request is recorded and asked again in the next observation window, not every cycle;
  // nothing is ejected meanwhile.
  {
    const { state, calls, cycle, advance } = harness();
    let attempts = 0;
    (cycle.effects as { observeCandidate: unknown }).observeCandidate = async () => { attempts++; throw new Error('control plane unavailable'); };
    const work = item(gates([staleObservationReason]));
    await actOnRepeatedRefusal(cycle, work, mergeKey, reason, since);
    assert.equal(state.actions[`${mergeKey}:repeated:observe`].state, 'failed');
    assert.match(state.actions[`${mergeKey}:repeated:observe`].detail, /asked again in the next observation window while the refusal stands: control plane unavailable/);
    advance(60_000);
    await actOnRepeatedRefusal(cycle, work, mergeKey, reason, since);
    assert.deepEqual([attempts, state.actions[`${mergeKey}:repeated:observe`].attempts, cycle.performed.length], [1, 1, 1], 'a failed request is not repeated inside its window');
    advance(60_000);
    await actOnRepeatedRefusal(cycle, work, mergeKey, reason, since);
    assert.deepEqual([attempts, state.actions[`${mergeKey}:repeated:observe`].attempts], [2, 2], 'it is asked again once the window passes');
    assert.deepEqual(calls.refused, []);
  }
  // A loop without the effect records that once per window too.
  {
    const { state, cycle, advance } = harness();
    delete (cycle.effects as { observeCandidate?: unknown }).observeCandidate;
    const work = item(gates([staleObservationReason]));
    for (let minute = 0; minute < 3; minute++) { await actOnRepeatedRefusal(cycle, work, mergeKey, reason, since); advance(60_000); }
    assert.deepEqual([state.actions[`${mergeKey}:repeated:observe`].state, state.actions[`${mergeKey}:repeated:observe`].attempts, cycle.performed.length], ['failed', 2, 2]);
  }

  // Every other repeated refusal follows GY-831 unchanged: marked for rework, never observed instead.
  const others = [
    item(gates([staleObservationReason, 'Pull request is not mergeable against the current base'])),
    item(gates([staleObservationReason], { review: ['Independent approval of the current commit is required'] })),
    item(gates([]), 150_000),
    item(gates([staleObservationReason]), 150_000, { violations: [{ kind: 'unauthorized-merge' }] } as unknown as Partial<Work>),
    // An observation that reported protection unverified is a reason of its own, not a missing observation.
    item(gates([staleObservationReason, unverified])),
  ];
  for (const work of others) {
    const { state, calls, cycle } = harness();
    await actOnRepeatedRefusal(cycle, work, mergeKey, reason, since);
    assert.deepEqual(calls, { refused: [reason], observed: [] });
    assert.equal(state.actions[`${mergeKey}:repeated:observe`], undefined);
    assert.match(state.actions[`${mergeKey}:repeated:rework`].detail, /marks candidate aaaaaaaaaaaa for a rework decision the approver judges/);
  }

  // Inside ten minutes nothing is acted on at all.
  {
    const { state, calls, cycle } = harness();
    await actOnRepeatedRefusal(cycle, item(gates([staleObservationReason])), mergeKey, reason, new Date(clock - 60_000).toISOString());
    assert.deepEqual([calls, Object.keys(state.actions)], [{ refused: [], observed: [] }, []]);
  }
});
