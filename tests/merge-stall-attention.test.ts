import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStallAttention } from '../src/cli/master-status.js';
import type { GitHubMergeQueueState } from '../src/merge-queue.js';
import type { Observation, Work } from '../src/model.js';
import { actOnRepeatedRefusal, mergeStep, repeatedMergeRefusalMs, staleObservationReason } from '../src/daemon/cycle-delivery.js';
import { mergeObservationWait } from '../src/daemon/decisions.js';
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

// GY-1202: the follow-ups of GY-1099's review. The stale wait never asked the guarded merge, so it
// acts only on a wait standing on freshness alone; the server's own freshness refusal of a candidate
// whose gates passed when read is stale-only too; and the wait's `since` is persisted and survives
// observations that land already stale.
test('unit:stale-wait-escalation-bounded — a stale wait with another failing reason only waits; a server freshness refusal of an all-passing candidate is observed; the wait since is persisted and carried across stale observations', async () => {
  const clock = Date.parse('2026-10-04T16:00:00.000Z');
  const candidate = { sha: head, baseSha: base, pr: 578, branch: 'graphyard/gy-806-1', author: 'worker' };
  const gates = (merge: string[]) => ['build', 'review', 'test', 'acceptance', 'merge'].map(name => {
    const reasons = name === 'merge' ? merge : [];
    return { name, passed: !reasons.length, reasons };
  });
  const item = (merge: string[], observedAt = clock - 150_000) => ({ id: 'work-806', key: 'GY-806', stage: 'merge', candidate, policyRevision: 1, violations: [], queue: { sequence: 4 },
    submission: {}, gates: gates(merge), observation: { at: new Date(observedAt).toISOString(), candidate, merged: false } }) as unknown as Work;
  const run = async (work: Work, actions: Record<string, unknown> = {}, merge?: () => Promise<unknown>) => {
    const state = emptyDaemonState({ url: 'https://graphyard.example', repository: 'owner/project', autoMerge: true } as MasterConfig);
    Object.assign(state.actions, actions);
    const calls = { refused: [] as string[], observed: [] as string[], merged: 0, persisted: [] as (string | undefined)[] };
    const effects = {
      persist: async (saved: typeof state) => { calls.persisted.push(saved.actions[`wait:merge:${work.id}`]?.since); },
      refuseMerge: async (_: Work, text: string) => { calls.refused.push(text); },
      observeCandidate: async (observed: Work) => { calls.observed.push(observed.key); },
      snapshot: async () => ({ work: [work] }),
      merge: merge ?? (async () => { calls.merged++; return { pending: true }; }),
    };
    await mergeStep({ config: { autoMerge: true }, state, effects, now: () => clock, clock, snapshot: { jobs: [], work: [work] }, performed: [], open: [work],
      isolate: async (_kind: unknown, _item: unknown, _name: unknown, body: () => Promise<unknown>) => body() } as unknown as Cycle);
    return { state, calls };
  };
  const mergeKey = `merge:work-806:${head}:${base}:1`;
  const longAgo = new Date(clock - repeatedMergeRefusalMs - 60_000).toISOString();
  const waiting = (work: Work, since?: string) => ({ [`wait:merge:${work.id}`]: { kind: 'merge', work: 'GY-806', principal: null, state: 'done', detail: mergeObservationWait(work)!, attempts: 1, epoch: null, cycle: 1, at: longAgo, ...(since ? { since } : {}) } });

  // Stale plus a mergeability reason: the merge was never asked, so it only waits — no rework, no report.
  {
    const work = item([staleObservationReason, 'Pull request is not mergeable against the current base']);
    const { state, calls } = await run(work, waiting(work, longAgo));
    assert.deepEqual([calls.refused, calls.observed, calls.merged], [[], [], 0]);
    assert.equal(Object.keys(state.actions).some(key => key.includes(':repeated:')), false);
  }
  // Stale only: observed ahead of the backlog after ten minutes, as GY-1099 does.
  {
    const work = item([staleObservationReason]);
    const { calls } = await run(work, waiting(work, longAgo));
    assert.deepEqual([calls.refused, calls.observed], [[], ['GY-806']]);
  }
  // A wait record without `since` is re-recorded once with it, through persist.
  {
    const work = item([staleObservationReason]);
    const { state, calls } = await run(work, waiting(work));
    assert.equal(state.actions[`wait:merge:${work.id}`].since, longAgo);
    assert.ok(calls.persisted.includes(longAgo), 'the backfilled since is persisted');
  }
  // An observation that landed already stale changes the detail but not the wait: since is carried.
  {
    const earlier = item([staleObservationReason], clock - 400_000), work = item([staleObservationReason]);
    const { state, calls } = await run(work, waiting(earlier, longAgo));
    assert.equal(state.actions[`wait:merge:${work.id}`].since, longAgo);
    assert.equal(state.actions[`wait:merge:${work.id}`].detail, mergeObservationWait(work));
    assert.deepEqual(calls.observed, ['GY-806']);
  }
  // ...but not once the guarded merge has been asked since the wait began.
  {
    const earlier = item([staleObservationReason], clock - 400_000), work = item([staleObservationReason]);
    const asked = { [mergeKey]: { kind: 'merge', work: 'GY-806', principal: null, state: 'waiting', detail: 'pending', attempts: 1, epoch: null, cycle: 2, at: new Date(clock - 60_000).toISOString() } };
    const { state, calls } = await run(work, { ...waiting(earlier, longAgo), ...asked });
    assert.equal(state.actions[`wait:merge:${work.id}`].since, new Date(clock).toISOString());
    assert.deepEqual(calls.observed, []);
  }
  // A wait that ended without a merge attempt (fresh observation, another gate failing) is cleared, so a
  // later stale wait of the same head does not inherit its since.
  {
    const work = item(['Pull request is not mergeable against the current base'], clock - 30_000);
    const { state, calls } = await run(work, waiting(item([staleObservationReason]), longAgo));
    assert.equal(state.actions[`wait:merge:${work.id}`], undefined);
    assert.ok(calls.persisted.length, 'the cleared wait is persisted');
  }
  // The server refuses a candidate whose gates all passed when read, for freshness alone: observed, not reworked.
  {
    const work = item([], clock - 30_000);
    const refusal = 'GY-806 merge refused: Merge authorization is no longer current';
    const previous = { [mergeKey]: { kind: 'merge', work: 'GY-806', principal: null, state: 'failed', detail: `Guarded merge refused for GY-806: ${refusal}`, attempts: 3, epoch: null, cycle: 2, at: longAgo, since: longAgo } };
    const { state, calls } = await run(work, previous, async () => { throw new Error(refusal); });
    assert.deepEqual([calls.refused, calls.observed], [[], ['GY-806']]);
    assert.equal(state.actions[`${mergeKey}:repeated:rework`], undefined);
  }
});
