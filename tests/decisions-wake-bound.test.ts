import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Observation, Work } from '../src/model.js';

/**
 * GY-1865: the decisions step's observation wakes — the rework waker's `observe` and the waiting
 * refusal's `wakeObservation` — hit the control plane's `resync` write, whose answer waits on a
 * reconciliation tick and runs into its 30s timeout; on release bcf016f77cc9 the step stacked those
 * POSTs one after another and held cycles 17737–17739 for 109.4s in all, past the 60s cycle bound.
 * The step now sees both calls through its shared bound (step-budget.ts): each waits at most the
 * per-call bound or the budget it has left, a wake past the bound is carried to the next cycle —
 * which joins the wake still in flight, so the effect starts once — and a spent budget wakes
 * nothing new, so the step returns within its budget however slow the control plane answers.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2026-10-16T04:43:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const sha = 'c'.repeat(40), base = 'b'.repeat(40);
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { intervalSeconds: 60 } });

/** An item whose reviewer requested changes on a head its GitHub observation no longer describes, so the rework the step owes waits for a fresh observation and the step wakes it. */
function item(key: string): Work {
  const candidate = { sha, baseSha: base, pr: 42, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'independent-reviewer', sha, state: 'CHANGES_REQUESTED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: iso(-180_000),
  } as Observation;
  return {
    id: `00000000-0000-4000-8000-${key.replace(/\D/g, '').padStart(12, '0')}`, key, title: key, description: '', type: 'bug', priority: 2,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/loop.ts'], stage: 'review', revision: 5, policyRevision: 1, createdAt: iso(-3_600_000), updatedAt: iso(0),
    stageEnteredAt: iso(-1_800_000), ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 42 },
    candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, violations: [],
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }],
  } as unknown as Work;
}

function effects(work: Work | Work[], overrides: Partial<DaemonEffects>): DaemonEffects {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: Array.isArray(work) ? work : [work], now: iso(0), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async () => ({ id: 'unused' }), decisions: async () => ({ decisions: [] }),
    approver: async () => ({ agentName: 'graphyard-approver', pane: 'pane-1' }), persist: async () => {},
    stepCallBoundMs: 30,
    ...overrides,
  } as DaemonEffects;
}
const records = (result: { actions: { kind: string; work: string | null; state: string; detail: string }[] }, item: string) => result.actions.filter(action => action.kind === 'decision' && action.work === item);
/** The faults a carried wake could have raised: the fixture's own standing ones (an unobserved deployment) are not the step's. */
const carriedFaults = (state: DaemonState) => state.faults.instances.filter(instance => instance.faultClass === 'decision' || /bound passed|budget passed/.test(instance.text ?? ''));
const wakeRow = (state: DaemonState, work: Work) => state.actions[`wake:observation:${work.id}`];
/** The step must return on its own bound: a run that outlives this race fails the test here — and fails against the base's sources too, where the wake holds the step for the resync timeout. */
const returns = <T>(run: Promise<T>, boundMs = 5_000): Promise<T> => Promise.race([run, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error(`the decisions step did not return within ${boundMs} ms`)), boundMs); timer.unref?.(); })]);
/** A call that never answers, counting how often it was made. */
function hanging<T = unknown>() {
  let answer!: (value: T) => void;
  const calls: unknown[][] = [];
  const promise = new Promise<T>(resolve => { answer = resolve; });
  return { calls, answer, call: ((...args: unknown[]) => { calls.push(args); return promise; }) as unknown as (...args: any[]) => any };
}

test('unit:slow-loop-step-bounded — an observation wake whose resync never answers returns the step on the bound, leaves the rework waiting, and the next cycle joins the wake in flight', async () => {
  const work = item('GY-1865'), slow = hanging<Work | null>();
  const fx = effects(work, { observe: slow.call as DaemonEffects['observe'] } as Partial<DaemonEffects>);
  const state = emptyDaemonState(config());
  const started = performance.now();
  const result = await returns(runCycle(config(), state, fx, () => clock));
  assert.ok(performance.now() - started < 5_000, 'the step returned instead of waiting on the resync timeout');
  assert.deepEqual(slow.calls.length, 1, 'the waker woke the observation once, under the per-call bound');
  assert.ok(records(result, 'GY-1865').some(action => action.state === 'done' && /rework waits for a fresh GitHub observation/.test(action.detail)), 'the rework still waits for the reading it asked for');
  assert.deepEqual(Object.values(state.approvals), [], 'no watch exists until a decision stands');
  // The next cycle rejoins the wake still in flight instead of starting a second resync for the same item.
  await returns(runCycle(config(), state, fx, () => clock + 60_000));
  assert.equal(slow.calls.length, 1, 'the retry joined the wake in flight; the effect started once');
  slow.answer(null);
});

test('unit:slow-loop-step-bounded — a wakeObservation resync past the bound is recorded carried on its row, is no fault, and the very next cycle retries it — joining the wake still in flight, never held for the re-wake interval — whose answer a later cycle consumes', async () => {
  const work = item('GY-1868'), slow = hanging();
  const fx = effects(work, { observe: async () => null, wakeObservation: slow.call as DaemonEffects['wakeObservation'] } as Partial<DaemonEffects>);
  const state = emptyDaemonState(config());
  const started = performance.now();
  await returns(runCycle(config(), state, fx, () => clock));
  assert.ok(performance.now() - started < 5_000, 'the step returned instead of waiting on the resync timeout');
  const row = wakeRow(state, work);
  assert.ok(row, 'the wake recorded its row');
  assert.equal(row.state, 'waiting', 'a carried wake is an outcome still in flight, not a failure');
  assert.match(row.detail, /Waking GY-1868's observation job was carried to the next cycle: the decisions step's 30 ms per-call bound passed before GY-1868's observation wake answered; the wake stays owed and is retried next cycle/, `the row records the carried wake: ${row.detail}`);
  assert.deepEqual(carriedFaults(state), [], 'a carried wake is no fault');
  // The carried wake is retried on the very next cycle, inside the re-wake interval a finished wake would hold: the retry joins the call still in flight, so the effect starts once and counts no second send.
  await returns(runCycle(config(), state, fx, () => clock + 60_000));
  const retried = wakeRow(state, work);
  assert.equal(retried.state, 'waiting', 'the retry found the wake still unanswered and carried it again');
  assert.equal(retried.cycle, row.cycle + 1, `the retry ran on the very next cycle, not after the 5-minute re-wake interval (row at ${retried.at}, cycle ${retried.cycle})`);
  assert.equal(retried.attempts, row.attempts, 'a retry that joined the call still in flight counts no second send');
  assert.match(retried.detail, /joining the call still in flight/, `the retry joined the wake in flight: ${retried.detail}`);
  assert.equal(slow.calls.length, 1, 'the retry joined the wake in flight; the effect started once');
  // The wake answers; the next cycle's retry consumes its kept answer and retires the row: the rework's wake is done, still no second resync.
  slow.answer(undefined);
  await returns(runCycle(config(), state, fx, () => clock + 120_000));
  const consumed = wakeRow(state, work);
  assert.equal(consumed.state, 'done', `the retry consumed the kept answer: ${consumed?.detail}`);
  assert.match(consumed.detail, /Woke the observation job of GY-1868/, `the consumed wake retired the carried row: ${consumed.detail}`);
  assert.equal(slow.calls.length, 1, 'the answer was consumed, never sent twice');
});

test('unit:slow-loop-step-bounded — a wake the spent budget never sent is recorded carried with no attempt, and the very next cycle makes its first send', async () => {
  const slowItem = item('GY-1872'), quickItem = item('GY-1873'), slow = hanging();
  const calls: Work[] = [];
  // Each waker reading costs 22s of the moving clock: the second item reaches its wake with the step's 30s budget spent, so its wake is carried before it was ever sent.
  let simulated = clock;
  const fx = effects([slowItem, quickItem], {
    observe: (() => { simulated += 22_000; return Promise.resolve(null); }) as unknown as DaemonEffects['observe'],
    wakeObservation: (async (work: Work) => { calls.push(work); if (work.id === slowItem.id) return slow.call(work); }) as unknown as DaemonEffects['wakeObservation'],
  } as Partial<DaemonEffects>);
  const state = emptyDaemonState(config());
  await returns(runCycle(config(), state, fx, () => simulated));
  const unsent = wakeRow(state, quickItem);
  assert.ok(unsent && unsent.state === 'waiting', 'the second item recorded its carried wake');
  assert.equal(unsent.attempts, 0, 'a wake the spent budget never sent counts no attempt');
  assert.deepEqual(calls.map(work => work.id), [slowItem.id], 'the spent budget woke nothing new');
  // The very next cycle makes the first send the spent budget owed, instead of holding the row for the re-wake interval.
  await returns(runCycle(config(), state, fx, () => simulated));
  assert.deepEqual(calls.map(work => work.id), [slowItem.id, quickItem.id], 'the next cycle sent the wake the spent budget never made');
  slow.answer(undefined);
});

test('unit:slow-loop-step-bounded — with several items whose resync never answers, each wake is capped by the budget the step has left, a spent budget wakes nothing new, and the step returns within the cycle bound', async () => {
  const work = [item('GY-1869'), item('GY-1870'), item('GY-1871')];
  let simulated = clock;
  // Every wake holds the step for 22s of the moving clock: past the 10s bound, and past what the 30s budget has left for the second item.
  const slow = hanging<Work | null>();
  const fx = effects(work, { observe: ((...args: unknown[]) => { simulated += 22_000; return slow.call(...args); }) as unknown as DaemonEffects['observe'], stepCallBoundMs: 10_000 } as Partial<DaemonEffects>);
  const state = emptyDaemonState(config());
  const started = performance.now();
  const result = await returns(runCycle(config(), state, fx, () => simulated));
  assert.ok(performance.now() - started < 5_000, 'the step returned instead of stacking one resync timeout after another');
  assert.equal(slow.calls.length, 2, 'the first two items were woken one at a time; the third waited for the next cycle once the budget was spent');
  assert.deepEqual(state.decisionsDeferred, ['GY-1871'], 'the item the spent budget left is put off for the next cycle, not waited on');
  assert.ok(!records(result, 'GY-1871').length, 'no third wake started past the budget');
  assert.deepEqual(carriedFaults(state), [], 'carried wakes are no fault');
  assert.deepEqual(Object.values(state.approvals), [], 'no watch exists until a decision stands');
});
