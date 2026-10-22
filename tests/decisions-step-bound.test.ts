import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { approvalWatchSchema, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { RefusedResponse } from '../src/model/refusal.js';
import type { Observation, Work } from '../src/model.js';

/** GY-1766: the decisions step never holds the loop cycle for one owed decision's approver call. */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2026-10-07T03:53:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const sha = 'c'.repeat(40), base = 'b'.repeat(40);
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { intervalSeconds: 60 } });

/** An item whose reviewer requested changes on its candidate, so the loop requests a rework; `quiet` has nothing to decide. */
function item(key: string, quiet = false): Work {
  const candidate = { sha, baseSha: base, pr: 42, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'independent-reviewer', sha, state: 'CHANGES_REQUESTED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: iso(-20_000),
  } as Observation;
  return {
    id: `00000000-0000-4000-8000-${key.replace(/\D/g, '').padStart(12, '0')}`, key, title: key, description: '', type: 'bug', priority: 2,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true },
    stage: quiet ? 'build' : 'review', revision: 5, policyRevision: 1, createdAt: iso(-3_600_000), updatedAt: iso(0),
    stageEnteredAt: iso(-1_800_000), ready: true, epoch: 1, lease: null, workspaces: [], submission: quiet ? null : { epoch: 1, pr: 42 },
    candidate: quiet ? null : candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: quiet ? null : observation, blocker: null, violations: [],
    gates: [{ name: 'build', passed: !quiet, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }],
  } as unknown as Work;
}

/** A new head on an owed item: the rework the loop owes is bound to the head, so the decision it must request changes with it. */
function rehead(work: Work, head: string) {
  const candidate = { ...work.candidate!, sha: head };
  work.candidate = candidate;
  work.observation = { ...work.observation!, candidate, reviews: [{ reviewer: 'independent-reviewer', sha: head, state: 'CHANGES_REQUESTED' }] } as Observation;
}

function effects(work: Work | Work[], overrides: Partial<DaemonEffects>): DaemonEffects {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: Array.isArray(work) ? work : [work], now: iso(0), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    decide: async () => ({ id: 'unused' }), decisions: async () => ({ decisions: [] }),
    approver: async () => ({ agentName: 'graphyard-approver', pane: 'pane-1' }), persist: async () => {},
    ...overrides,
  };
}
const decisionFaults = (state: ReturnType<typeof emptyDaemonState>) => state.faults.instances.filter(instance => instance.faultClass === 'decision');
const records = (result: { actions: { kind: string; work: string | null; state: string; detail: string }[] }, item: string) => result.actions.filter(action => action.kind === 'decision' && action.work === item);
/** The step must return on its own bound: a run that outlives this race fails the test here — and fails against the base's sources too, where no bound exists to return the step (GY-1174). */
const returns = <T>(run: Promise<T>, boundMs = 5_000): Promise<T> => Promise.race([run, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error(`the decisions step did not return within ${boundMs} ms`)), boundMs); timer.unref?.(); })]);

test('unit:decisions-step-bounded-per-decision — a decide call that does not answer returns the step, leaves the decision owed and is no fault', async () => {
  const work = item('GY-1766'), sent: string[] = [];
  const state = emptyDaemonState(config());
  const started = performance.now();
  const result = await returns(runCycle(config(), state, effects(work, { decide: async (_target, action) => { sent.push(action); return new Promise(() => {}); }, decisionCallBoundMs: 30 } as Partial<DaemonEffects>), () => clock));
  assert.ok(performance.now() - started < 5_000, 'the step returned instead of waiting on the call');
  assert.deepEqual(sent, ['rework']);
  const recorded = records(result, 'GY-1766');
  assert.ok(recorded.some(action => action.state === 'done' && /30 ms per-decision bound passed/.test(action.detail) && /stays owed and is retried next cycle/.test(action.detail)), JSON.stringify(recorded));
  assert.ok(!recorded.some(action => action.state === 'failed'), 'a carried decision is not a failure');
  assert.deepEqual(decisionFaults(state), []);
  assert.deepEqual(Object.values(state.approvals), [], 'no watch exists until a decision stands');
});

test('unit:decisions-step-applies-once — a retry joins the call still in flight, and an answer within the bound is applied as before', async () => {
  const work = item('GY-1766'), sent: string[] = [];
  let answer!: (value: { id: string }) => void;
  const slow = new Promise<{ id: string }>(resolve => { answer = resolve; });
  const fx = effects(work, { decide: async (_target, action) => { sent.push(action); return slow; }, decisionCallBoundMs: 20 } as Partial<DaemonEffects>);
  const state = emptyDaemonState(config());
  await returns(runCycle(config(), state, fx, () => clock));
  await returns(runCycle(config(), state, fx, () => clock + 60_000));
  assert.deepEqual(sent, ['rework'], 'the retry did not send a second request while the first was unanswered');
  answer({ id: 'decision-1' });
  await slow;

  const quick = emptyDaemonState(config()), asked: string[] = [];
  await returns(runCycle(config(), quick, effects(work, { decide: async (_target, action) => { asked.push(action); return { id: 'decision-2' }; }, decisionCallBoundMs: 5_000 } as Partial<DaemonEffects>), () => clock));
  assert.deepEqual(asked, ['rework']);
  assert.deepEqual(Object.values(quick.approvals).map(watch => watch.decision), ['decision-2'], 'an answer inside the bound opens its watch exactly as before');
});

test('unit:decisions-step-applies-once — a timeout followed by a changed decision requests its own call, and the old call\'s late answer lands nowhere', async () => {
  const work = item('GY-1766'), sent: string[] = [];
  let answer!: (value: { id: string }) => void;
  const stale = new Promise<{ id: string }>(resolve => { answer = resolve; });
  const slow = effects(work, { decide: async (_target, action) => { sent.push(action); return stale; }, decisionCallBoundMs: 20 } as Partial<DaemonEffects>);
  const state = emptyDaemonState(config());
  await returns(runCycle(config(), state, slow, () => clock));
  assert.deepEqual(sent, ['rework'], 'the first head\'s rework was requested');
  // The head moved while the call was unanswered: the owed rework is now bound to the new head.
  const moved = 'd'.repeat(40);
  rehead(work, moved);
  const fresh = effects(work, { decide: async (_target, action) => { sent.push(action); return { id: 'decision-2' }; }, decisionCallBoundMs: 20 } as Partial<DaemonEffects>);
  await returns(runCycle(config(), state, fresh, () => clock + 60_000));
  assert.deepEqual(sent, ['rework', 'rework'], 'the changed decision requested its own call instead of joining the old one');
  assert.deepEqual(Object.values(state.approvals).map(watch => watch.decision), ['decision-2'], 'the new decision\'s watch holds its own decision id, never the old call\'s');
  answer({ id: 'decision-1' });
  await stale;
  assert.deepEqual(Object.values(state.approvals).map(watch => watch.decision), ['decision-2'], 'the old call\'s late answer installed nothing');
});

test('unit:decisions-step-bounded-per-decision — with several items whose calls never answer, each call is capped by the step budget left as well as its bound, and the step returns within the cycle bound', async () => {
  const work = [item('GY-1766'), item('GY-1767'), item('GY-1768')], sent: string[] = [];
  let simulated = clock;
  // Every call is unanswered and holds the step for 22 s of the moving clock: past the 10 s bound, past what the 30 s budget has left for the second call.
  const fx = effects(work, { decide: async (_target, action) => { sent.push(action); simulated += 22_000; return new Promise(() => {}); }, decisionCallBoundMs: 10_000 } as Partial<DaemonEffects>);
  const state = emptyDaemonState(config());
  const started = performance.now();
  const result = await returns(runCycle(config(), state, fx, () => simulated));
  assert.ok(performance.now() - started < 5_000, 'the step returned instead of waiting on the calls');
  assert.deepEqual(sent, ['rework', 'rework'], 'the first two items were put to an approver one at a time; the third waited for the next cycle once the budget was spent');
  const first = records(result, 'GY-1766'), second = records(result, 'GY-1767');
  assert.ok(first.some(action => /10[ ,]?000 ms per-decision bound passed/.test(action.detail)), `the first call ran to its per-decision bound: ${JSON.stringify(first)}`);
  assert.ok(second.some(action => /budget passed before GY-1767's decision call answered \(10[ ,]?000 ms per decision, 8000 ms left\)/.test(action.detail)), `the second call was capped by the budget it had left: ${JSON.stringify(second)}`);
  assert.ok([...first, ...second].every(action => /stays owed and is retried next cycle/.test(action.detail)), 'both decisions stay owed and are retried next cycle');
  assert.deepEqual(state.decisionsDeferred, ['GY-1768'], 'the item the spent budget left is put off for the next cycle, not waited on');
  assert.ok(!records(result, 'GY-1768').length, 'no third call started past the budget');
  assert.deepEqual(decisionFaults(state), [], 'carried calls are no fault');
  assert.deepEqual(Object.values(state.approvals), [], 'no watch exists until a decision stands');
});
