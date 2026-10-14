import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { decisionBudgetMs, decisionCallBoundMs, decisionCallCarried } from '../src/daemon/decision-budget.js';
import { launchAppearanceMs } from '../src/daemon/effects.js';
import { idleLeaseMs } from '../src/daemon/cycle-resume.js';
import { overlongMarker } from '../src/daemon/reblocked-attempts.js';
import type { Observation, Work } from '../src/model.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { DaemonAction } from '../src/daemon/state.js';
import type { BlockerProbeResult } from '../src/daemon/blocker-probes.js';

/**
 * GY-1774: every loop step that calls an approver, a decision or a session is bounded like the decisions step (GY-1766).
 * A call that does not answer within the bound returns the step, stays owed with its carried attempt recorded, and is
 * retried next cycle; the retry joins the call still in flight, so its effect is applied once; a call that answers in
 * time is applied exactly as before. The decisions step keeps its GY-1766 behaviour through the shared helper.
 */

/** The helper under test, loaded inside each case so a tree without it fails the case rather than the file (the verify exercise reverts the sources). */
const helper = () => import('../src/daemon/step-budget.js');
type Helper = Awaited<ReturnType<typeof helper>>;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const clock = Date.parse('2026-10-14T03:53:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const sha = 'c'.repeat(40), base = 'b'.repeat(40);
const profile = (): WorkerProfile => ({ name: 'claude-a', principal: 'graphyard-claude-a', agentName: 'graphyard-claude-a', mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', agentArgs: [], environment: {}, approvals: 'auto' }) as WorkerProfile;
const config = (overrides: Record<string, unknown> = {}): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { intervalSeconds: 60 }, ...overrides });

/** An item in review whose reviewer requested changes on its candidate (the decisions step requests a rework); `quiet` is a bare build-stage item. */
function item(key: string, overrides: Partial<Work> = {}): Work {
  const candidate = { sha, baseSha: base, pr: 42, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  const observation = {
    clockOffset: { min: 0, max: 0 }, candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'independent-reviewer', sha, state: 'CHANGES_REQUESTED' }],
    protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: iso(-20_000),
  } as Observation;
  return {
    id: `00000000-0000-4000-8000-${key.replace(/\D/g, '').padStart(12, '0')}`, key, title: key, description: '', type: 'bug', priority: 2,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/loop.ts'], stage: 'review', revision: 5, policyRevision: 1, createdAt: iso(-3_600_000), updatedAt: iso(0),
    stageEnteredAt: iso(-1_800_000), ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 42 },
    candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, violations: [], sessions: [],
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }],
    ...overrides,
  } as unknown as Work;
}
/** A build-stage item nothing decides on. */
const quiet = (key: string, overrides: Partial<Work> = {}) => item(key, { stage: 'build', submission: null, candidate: null, observation: null, gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }], ...overrides } as Partial<Work>);

function effects(work: Work[], overrides: Partial<DaemonEffects>, agents: HerdrAgent[] = []): DaemonEffects {
  return {
    agents: () => agents, herdr: () => ({ agents, available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work, now: iso(0), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    decide: async () => ({ id: 'decision-1' }), decisions: async () => ({ decisions: [] }),
    approver: async () => ({ agentName: 'graphyard-approver', pane: 'pane-1' }), persist: async () => {},
    stepCallBoundMs: 30,
    ...overrides,
  } as DaemonEffects;
}
/** A call that never answers, counting how often it was made. */
function hanging<T = unknown>() {
  let answer!: (value: T) => void;
  const calls: unknown[][] = [];
  const promise = new Promise<T>(resolve => { answer = resolve; });
  return { calls, answer, call: ((...args: unknown[]) => { calls.push(args); return promise; }) as unknown as (...args: any[]) => any };
}
/** The step must return on its own bound: a run that outlives this race fails the test here, as it does against sources with no bound. */
const returns = <T>(run: Promise<T>, boundMs = 5_000): Promise<T> => Promise.race([run, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error(`the cycle did not return within ${boundMs} ms`)), boundMs); timer.unref?.(); })]);
const carriedRows = (state: DaemonState, { carriedRow }: Helper) => Object.entries(state.actions).filter(([, row]) => carriedRow(row));
/** The fault instances a carried call could have raised: the fixture's own standing faults (an unverified deployment, an offline worker session, a stalled gate) are not the step's. */
const faults = (state: DaemonState) => state.faults.instances.filter(instance => !['deployment', 'session-liveness', 'stalled-gate'].includes(instance.faultClass)).map(instance => `${instance.faultClass}: ${instance.text ?? ''}`);
/** Run one cycle at `at` and assert it returned within the test's bound, not the call's. */
async function cycle(state: DaemonState, fx: DaemonEffects, at = clock, cfg = config()) {
  const started = performance.now();
  const result = await returns(runCycle(cfg, state, fx, () => at));
  assert.ok(performance.now() - started < 5_000, 'the cycle returned instead of waiting on the call');
  return result;
}

// --- the helper itself --------------------------------------------------------------------------------------------

test('unit:step-calls-bounded — a bounded call past the per-call bound rejects as carried, naming the step, within the bound; one past the budget left is capped by it', async () => {
  const sb = await helper();
  const kept = {}, slow = hanging();
  const fx = sb.boundedCalls(effects([], { closeSession: slow.call as DaemonEffects['closeSession'] }), kept, () => clock, () => 10_000, { step: 'sessions', calls: ['closeSession'] });
  const started = performance.now();
  await assert.rejects(fx.closeSession('pane-9') as Promise<void>, error => sb.stepCallCarried(error) && /the sessions step's 30 ms per-call bound passed before pane pane-9's closeSession call answered; the call stays owed and is retried next cycle/.test((error as Error).message));
  assert.ok(performance.now() - started < 2_000, 'the call returned on its bound');
  const capped = sb.boundedCalls(effects([], { closeSession: slow.call as DaemonEffects['closeSession'], stepCallBoundMs: 10_000 } as Partial<DaemonEffects>), {}, () => clock, () => 20, { step: 'reclaim', calls: ['closeSession'] });
  await assert.rejects(capped.closeSession('pane-9') as Promise<void>, /the reclaim step's budget passed before pane pane-9's closeSession call answered \(10000 ms per call, 20 ms left\); the call stays owed/);
  assert.equal(sb.stepBudgetMs(60_000), 30_000, 'the step budget is the decisions step\'s two-fifths share, never under the actionable cadence');
  assert.equal(decisionBudgetMs(60_000), sb.stepBudgetMs(60_000), 'the decisions step shares it');
  assert.equal(decisionCallBoundMs, 10_000, 'and the 10 s per-call bound');
  assert.equal(decisionCallCarried('the decisions step\'s 10000 ms per-decision bound passed before x answered; the decision stays owed and is retried next cycle'), true, 'and the carried reading');
});

test('unit:step-calls-applied-once — a retried call joins the one in flight under the same key, a changed argument makes its own call, and an answer within the bound is applied as before', async () => {
  const sb = await helper();
  const kept = {}, slow = hanging<{ profile: string }>();
  const fx = sb.boundedCalls(effects([], { promptSession: slow.call as DaemonEffects['promptSession'] }), kept, () => clock, () => 10_000, { step: 'resume', calls: ['promptSession'] });
  const agent = { name: 'graphyard-claude-a', pane_id: 'pane-1' } as HerdrAgent;
  // The same instruction a cycle later: only what the clock moved (the reminder's timestamp and minutes) is worded anew.
  const resume = (minutes: number) => `resume GY-1 (no activity since ${iso(-minutes * 60_000)}, ${minutes} minutes)`;
  await assert.rejects(fx.promptSession!(agent, resume(12)) as Promise<void>, sb.stepCallCarried);
  await assert.rejects(fx.promptSession!(agent, resume(13)) as Promise<void>, sb.stepCallCarried);
  assert.equal(slow.calls.length, 1, 'the retry joined the prompt still in flight: the wording the clock moves is no part of the key');
  await assert.rejects(fx.promptSession!({ ...agent, pane_id: 'pane-2' } as HerdrAgent, resume(12)) as Promise<void>, sb.stepCallCarried);
  assert.equal(slow.calls.length, 2, 'another pane is another call');
  slow.answer({ profile: 'x' });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(await fx.promptSession!(agent, resume(14)), { profile: 'x' }, 'the retry of a carried call that settled meanwhile consumes its kept answer');
  assert.equal(slow.calls.length, 2, 'and sends nothing: the effect is applied once');
  await fx.promptSession!(agent, resume(15));
  assert.equal(slow.calls.length, 3, 'once the answer is consumed, the next call is fresh');
  await fx.promptSession!(agent, 'resume GY-1: its blocker was cleared');
  assert.equal(slow.calls.length, 4, 'another instruction to the same pane is another call');
  // A fresh send is never made on a spent budget: the work stays owed to the next cycle, which makes it on a fresh budget.
  const spent = hanging();
  const none = sb.boundedCalls(effects([], { closeSession: spent.call as DaemonEffects['closeSession'] }), {}, () => clock, () => 0, { step: 'sessions', calls: ['closeSession'] });
  await assert.rejects(none.closeSession('pane-4') as Promise<void>, error => sb.stepCallCarried(error) && /the sessions step's budget passed before pane pane-4's closeSession call was made \(30 ms per call, 0 ms left\); the call stays owed and is retried next cycle/.test((error as Error).message) && !sb.carriedCallSent(error));
  assert.equal(spent.calls.length, 0, 'nothing ran behind the step');
  // An unsent call is no attempt: a first call refused by a spent budget records a carried row counting none.
  const unsent = { actions: {} as Record<string, DaemonAction>, cycle: 1 } as unknown as DaemonState;
  await sb.recordCarried({ state: unsent, now: () => clock, performed: [], effects: effects([], {}) } as unknown as Parameters<Helper['recordCarried']>[0], 'k', { kind: 'session', work: 'GY-1' }, new sb.StepCallCarriedError('spent', false), 'x');
  assert.equal(unsent.actions.k.attempts, 0, 'a call never sent counts no attempt');
  // A call still in flight is joined even on a spent budget, with no new send.
  const inFlight = sb.boundedCalls(effects([], { closeSession: spent.call as DaemonEffects['closeSession'] }), kept, () => clock, () => 10_000, { step: 'sessions', calls: ['closeSession'] });
  await assert.rejects(inFlight.closeSession('pane-5') as Promise<void>, error => sb.carriedCallSent(error));
  const joining = sb.boundedCalls(effects([], { closeSession: spent.call as DaemonEffects['closeSession'] }), kept, () => clock, () => 0, { step: 'sessions', calls: ['closeSession'] });
  await assert.rejects(joining.closeSession('pane-5') as Promise<void>, error => sb.stepCallCarried(error) && !sb.carriedCallSent(error) && /joining the call still in flight/.test((error as Error).message));
  assert.equal(spent.calls.length, 1, 'the retry joined the close in flight');
  // A scope decision is keyed by the ask it decides: a withdrawn and re-asked request never joins the earlier ask's call.
  const asks = hanging<Work>();
  const asking = sb.boundedCalls(effects([], { decideScope: asks.call as DaemonEffects['decideScope'] }), {}, () => clock, () => 10_000, { step: 'scope', calls: ['decideScope'] });
  const ask = (at: string) => quiet('GY-2', { scopeRequest: { epoch: 1, paths: ['src/other.ts'], reason: 'AC-1 needs it', requestedBy: 'graphyard-claude-a', at, decision: null } } as Partial<Work>);
  await assert.rejects(asking.decideScope!(ask(iso(-30_000)), [], true) as Promise<Work>, sb.stepCallCarried);
  await assert.rejects(asking.decideScope!(ask(iso(-30_000)), [], true) as Promise<Work>, sb.stepCallCarried);
  assert.equal(asks.calls.length, 1, 'the same ask joins its call');
  await assert.rejects(asking.decideScope!(ask(iso(-5_000)), [], true) as Promise<Work>, sb.stepCallCarried);
  assert.equal(asks.calls.length, 2, 'a re-asked request, same item binding, is its own call');
  // An answer within the bound is the effect's own answer, untouched.
  const base = effects([], { decide: async (_work, action) => ({ id: `decided-${action}` }) });
  const quick = sb.boundedCalls(base, {}, () => clock, () => 10_000, { step: 'dispatch', calls: ['decide'] });
  assert.deepEqual(await quick.decide!(item('GY-1'), 'rework', 'why'), { id: 'decided-rework' });
  assert.equal(sb.unboundedEffects(quick), base, 'the effects beneath a bound are reachable for a launch that holds no cycle');
  const ended = sb.boundedCalls(effects([], { closeSession: slow.call as DaemonEffects['closeSession'] }), {}, () => clock, () => null, { step: 'triage', calls: ['closeSession'] });
  const pass = ended.closeSession('pane-3') as Promise<void>;
  assert.equal(slow.calls.length, 5);
  assert.ok(pass instanceof Promise, 'after the step ended, the call passes through unbounded');
});

// --- the steps, through the cycle --------------------------------------------------------------------------------

test('unit:step-calls-bounded — sessions: a close of a finished worker session that does not answer returns the step, is recorded carried and is retried next cycle, joining the close in flight', async () => {
  const sb = await helper();
  const slow = hanging(), agents = [{ name: 'graphyard-claude-a', pane_id: 'pane-1', agent_status: 'idle', agent: 'claude' } as HerdrAgent];
  const fx = effects([], { closeSession: slow.call as DaemonEffects['closeSession'] }, agents), cfg = config({ workers: [profile()] });
  const state = emptyDaemonState(cfg);
  await cycle(state, fx, clock, cfg);
  assert.equal(slow.calls.length, 1, 'the close was sent');
  const [key, row] = carriedRows(state, sb).find(([key]) => key === 'close:claude-a:pane-1') ?? [];
  assert.ok(row, `the close is recorded carried on its own row: ${JSON.stringify(Object.keys(state.actions))}`);
  assert.match(row!.detail, /the sessions step's 30 ms per-call bound passed before pane pane-1's closeSession call answered; the call stays owed and is retried next cycle/);
  assert.equal(row!.state, 'waiting', 'a carried call is no outcome: its row waits, and is asked again');
  assert.deepEqual(faults(state), [], 'a carried call is no fault');
  await cycle(state, fx, clock + 60_000, cfg);
  assert.equal(slow.calls.length, 1, `the next cycle retried the close (${key}) and joined the one still in flight`);
  assert.equal(state.actions[key!].attempts, 1, 'a join is no new attempt: the row counts the sends made');
  assert.match(state.actions[key!].detail, /joining the call still in flight/);
  slow.answer(undefined);
  await new Promise(resolve => setTimeout(resolve, 5));
  await cycle(state, fx, clock + 120_000, cfg);
  assert.equal(state.actions[key!].state, 'done', 'once the pane close answered, the close is done');
  assert.match(state.actions[key!].detail, /Closed finished session graphyard-claude-a/);
});

test('unit:step-calls-bounded — reclaim: a leftover pane close that does not answer returns the step and is retried next cycle, joining it; the pane inventory read is bounded too', async () => {
  const sb = await helper();
  const slow = hanging();
  const panes = async () => ({ available: true, panes: [{ pane_id: 'pane-7', cwd: '/repo/.graphyard/worktrees/GY-9-1', agent: null }] });
  const fx = effects([], { closeSession: slow.call as DaemonEffects['closeSession'], panes } as Partial<DaemonEffects>);
  const state = emptyDaemonState(config());
  await cycle(state, fx, clock);
  assert.equal(state.actions['sweep:pane:pane-7']?.state, 'waiting', 'the first sighting only waits');
  assert.equal(slow.calls.length, 0);
  await cycle(state, fx, clock + launchAppearanceMs + 1_000);
  assert.equal(slow.calls.length, 1, 'past its bound the pane is closed');
  const carried = carriedRows(state, sb);
  assert.ok(carried.some(([key, row]) => key === 'carried:close:pane-7' && /the reclaim step's 30 ms per-call bound passed before pane pane-7's closeSession call answered/.test(row.detail)), JSON.stringify(carried));
  assert.deepEqual(faults(state), []);
  await cycle(state, fx, clock + launchAppearanceMs + 2_000);
  assert.equal(slow.calls.length, 1, 'the next cycle joined the close still in flight');
  const never = hanging();
  const unread = effects([], { panes: never.call as DaemonEffects['panes'] } as Partial<DaemonEffects>);
  await cycle(emptyDaemonState(config()), unread, clock);
  assert.equal(never.calls.length, 1, 'an inventory read that does not answer returns the step; the sweep waits for the next read');
});

test('unit:step-calls-bounded — scope: a scope decision that does not answer returns the step, is recorded carried and is retried next cycle, joining it', async () => {
  const sb = await helper();
  const slow = hanging<Work>();
  const request = { epoch: 1, paths: ['src/other.ts'], reason: 'AC-1 needs it', requestedBy: 'graphyard-claude-a', at: iso(-30_000), decision: null };
  const work = quiet('GY-2', { lease: { epoch: 1, owner: 'graphyard-claude-a', expiresAt: iso(3_600_000) }, scopeRequest: request } as Partial<Work>);
  const fx = effects([work], { decideScope: slow.call as DaemonEffects['decideScope'] });
  const state = emptyDaemonState(config());
  await cycle(state, fx, clock);
  assert.equal(slow.calls.length, 1, 'the decision was asked');
  const [key, row] = carriedRows(state, sb).find(([, row]) => row.kind === 'scope') ?? [];
  assert.ok(row, `the scope decision is recorded carried: ${JSON.stringify(state.actions)}`);
  assert.match(row!.detail, /the scope step's 30 ms per-call bound passed before GY-2's decideScope call answered; the call stays owed and is retried next cycle/);
  assert.deepEqual(faults(state), []);
  await cycle(state, fx, clock + 60_000);
  assert.equal(slow.calls.length, 1, `the next cycle asked again (${key}) and joined the call in flight`);
});

test('unit:step-calls-bounded — approvers: an approver launch that does not answer returns the decisions step, leaves the decision owed with no fault, and the next cycle joins the launch in flight', async () => {
  const sb = await helper();
  const slow = hanging<{ agentName: string; pane: string }>(), work = item('GY-3');
  const fx = effects([work], { approver: slow.call as DaemonEffects['approver'] });
  const state = emptyDaemonState(config());
  const result = await cycle(state, fx, clock);
  assert.equal(slow.calls.length, 1, 'the approver was launched');
  const recorded = result.actions.filter(action => action.kind === 'decision' && action.work === 'GY-3');
  assert.ok(recorded.some(action => action.state === 'done' && /the approvers step's 30 ms per-call bound passed before GY-3's approver call answered; the call stays owed and is retried next cycle/.test(action.detail)), JSON.stringify(recorded));
  assert.ok(!recorded.some(action => action.state === 'failed'), 'a carried launch is not a failure');
  assert.deepEqual(faults(state), []);
  await cycle(state, fx, clock + 60_000);
  assert.equal(slow.calls.length, 1, 'the next cycle joined the launch still in flight');
  slow.answer({ agentName: 'graphyard-approver', pane: 'pane-1' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await cycle(state, fx, clock + 120_000);
  assert.ok(Object.values(state.approvals).some(watch => watch.agentName === 'graphyard-approver'), 'the launch that answered is applied once, on the watch');
});

test('unit:step-calls-bounded — blockers: launching the approver of a needs-decision blocker is bounded; carried, it is retried next cycle and joins the launch in flight', async () => {
  const sb = await helper();
  const decision = '5b1e7c3a-9d2f-4e61-8a0b-2c4d6e8f0a1b', slow = hanging<{ agentName: string; pane: string }>();
  const work = quiet('GY-4', { blocker: `Waiting on decision ${decision}, already requested; its approver was never launched`, blockerProbe: null } as Partial<Work>);
  const fx = effects([work], { approver: slow.call as DaemonEffects['approver'], decisions: async () => ({ decisions: [{ id: decision, action: 'requirements', state: 'requested', input: {}, approvedBy: null }] }),
    recordBlockerProbe: async () => work } as Partial<DaemonEffects>);
  const state = emptyDaemonState(config());
  await cycle(state, fx, clock);
  assert.equal(slow.calls.length, 1, 'the approver was launched');
  const row = state.actions[`blocker:approver:${work.id}:${decision}`];
  assert.ok(sb.carriedRow(row), `the launch is recorded carried: ${JSON.stringify(row)}`);
  assert.match(row.detail, /the blockers step's 30 ms per-call bound passed before GY-4's approver call answered/);
  assert.deepEqual(faults(state), []);
  await cycle(state, fx, clock + 60_000);
  assert.equal(slow.calls.length, 1, 'the next cycle joined the launch in flight');
});

test('unit:step-calls-bounded — resume: an idle re-prompt that does not answer returns the step, is recorded carried and is re-sent next cycle, joining it', async () => {
  const sb = await helper();
  const slow = hanging(), agents = [{ name: 'graphyard-claude-a', pane_id: 'pane-1', agent_status: 'idle', agent: 'claude' } as HerdrAgent];
  const handle = { id: 'graphyard-claude-a:1', kind: 'implementation', principal: 'graphyard-claude-a', epoch: 1, runtime: 'claude', host: 'machine-a', pane: 'pane-1', agentName: 'graphyard-claude-a', state: 'running', subject: 'GY-5', startedAt: iso(-600_000), updatedAt: iso(-600_000), workspace: null, tab: null, role: null, head: null, attach: null, transcript: null, endedAt: null, outcome: null };
  const work = quiet('GY-5', { lease: { epoch: 1, owner: 'graphyard-claude-a', expiresAt: iso(7_200_000) }, sessions: [handle], workspaces: [{ host: 'machine-a', path: '/repo/.graphyard/worktrees/GY-5-1', branch: 'graphyard/gy-5-1', epoch: 1, owner: 'graphyard-claude-a' }] } as unknown as Partial<Work>);
  const fx = effects([work], { promptSession: slow.call as DaemonEffects['promptSession'] }, agents), cfg = config({ workers: [profile()] });
  const state = emptyDaemonState(cfg);
  await cycle(state, fx, clock, cfg);
  assert.equal(state.actions[`idle:${work.id}:1`]?.state, 'waiting', 'the idle attempt is marked first');
  await cycle(state, fx, clock + idleLeaseMs + 60_000, cfg);
  assert.equal(slow.calls.length, 1, 'past the idle bound it is re-prompted');
  const [key, row] = carriedRows(state, sb).find(([key]) => key.startsWith(`resume:idle:${work.id}:1:`)) ?? [];
  assert.ok(row, `the re-prompt is recorded carried: ${JSON.stringify(Object.keys(state.actions))}`);
  assert.match(row!.detail, /the resume step's 30 ms per-call bound passed before graphyard-claude-a's promptSession call answered/);
  assert.deepEqual(faults(state), []);
  await cycle(state, fx, clock + idleLeaseMs + 120_000, cfg);
  assert.equal(slow.calls.length, 1, `the next cycle re-sent the prompt (${key}) and joined the one in flight`);
});

test('unit:step-calls-bounded — review-cap: withdrawing a capped change request is bounded; carried, it is retried next cycle and joins the withdrawal in flight', async () => {
  const sb = await helper();
  const slow = hanging();
  const reviewer = { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.pem', boundAt: iso(-86_400_000) };
  const work = item('GY-6', { pipeline: { reworkRounds: 3, attempts: [], submittedAt: iso(-3_600_000), interventions: { blocked: 0, requirements: 0 }, resubmittedAt: null } } as unknown as Partial<Work>);
  work.observation = { ...work.observation!, reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha, state: 'CHANGES_REQUESTED', id: 77, body: 'Nit: rename the variable', submittedAt: iso(-60_000) }] } as Observation;
  const fx = effects([work], { withdrawReview: slow.call as DaemonEffects['withdrawReview'] } as Partial<DaemonEffects>), cfg = config({ reviewer });
  const state = emptyDaemonState(cfg);
  await cycle(state, fx, clock, cfg);
  assert.equal(slow.calls.length, 1, 'the withdrawal was sent');
  const [key, row] = carriedRows(state, sb).find(([, row]) => row.kind === 'review') ?? [];
  assert.ok(row, `the withdrawal is recorded carried: ${JSON.stringify(Object.keys(state.actions))}`);
  assert.match(row!.detail, /the review-cap step's 30 ms per-call bound passed before GY-6's withdrawReview call answered/);
  assert.deepEqual(faults(state), []);
  await cycle(state, fx, clock + 60_000, cfg);
  assert.equal(slow.calls.length, 1, `the next cycle retried the withdrawal (${key}) and joined the one in flight`);
});

test('unit:step-calls-bounded — dispatch: the cap decision of an item held at its attempt cap is bounded; carried, it is requested again next cycle and joins the request in flight', async () => {
  const sb = await helper();
  const slow = hanging<{ id: string }>();
  const end = (epoch: number, hoursAgo: number) => ({ role: 'worker', cause: 'interrupted', epoch, profile: 'claude-a', account: null, runtime: 'claude', reason: `${overlongMarker} on epoch ${epoch}: ran 9h0m, past the 8h0m maximum for its role`, resetsAt: null, partialWork: { state: 'kept', detail: 'kept' }, at: iso(-hoursAgo * 3_600_000), owner: 'graphyard-claude-a', recordedBy: 'graphyard-master-project' });
  const work = quiet('GY-7', { capacity: { exhaustions: [end(1, 30), end(2, 20), end(3, 10)], escalations: [] } } as unknown as Partial<Work>);
  const fx = effects([work], { decide: slow.call as DaemonEffects['decide'] }), cfg = config({ workers: [profile()] });
  const state = emptyDaemonState(cfg);
  await cycle(state, fx, clock, cfg);
  assert.equal(slow.calls.length, 1, `the cap decision was requested: ${JSON.stringify(Object.keys(state.actions))}`);
  const row = state.actions[`retry:cap-request:${work.id}`];
  assert.ok(sb.carriedRow(row), `the request is recorded carried: ${JSON.stringify(row)}`);
  assert.match(row.detail, /the dispatch step's 30 ms per-call bound passed before GY-7's decide call answered/);
  assert.deepEqual(faults(state), []);
  await cycle(state, fx, clock + 60_000, cfg);
  assert.equal(slow.calls.length, 1, 'the next cycle requested it again and joined the request in flight');
});

test('unit:step-calls-bounded — every named step runs under the shared bound with the calls the item names, and the triage record passes through once the step has ended', async () => {
  const sb = await helper();
  const steps: Record<string, { file: string; calls: string[] }> = {
    blockers: { file: 'cycle-blockers.ts', calls: ['approver', 'closeSession', 'deferWindow', 'probeBlocker', 'decisions', 'approverLaunches', 'recordBlockerProbe', 'recordSession'] },
    dispatch: { file: 'cycle-dispatch.ts', calls: ['decide', 'approver', 'agents', 'roleHealth', 'escalationSessions', 'reportCapacity', 'planeHealth', 'hostMemory', 'blockDispatch', 'decisions', 'recordDecomposition', 'recordResearch'] },
    'review-cap': { file: 'cycle-review-cap.ts', calls: ['withdrawReview', 'wakeObservation', 'decisions'] },
    scope: { file: 'cycle-scope.ts', calls: ['decideScope', 'widenScope', 'reviewFindings', 'basePaths', 'baseText', 'baseMentions', 'baseSuccessions', 'repositoryFiles', 'decisions', 'mergeWriter'] },
    sessions: { file: 'cycle-sessions.ts', calls: ['closeSession', 'endSession', 'relaunch', 'answerSession', 'promptSession', 'launchedSessions', 'sessionOutput', 'herdr', 'escalationSessions', 'recordSession', 'stopSupervisor', 'reportCapacity', 'holdAccount', 'selectedAccount', 'preserveWork', 'endEscalation', 'markEscalation', 'relaunchEscalation', 'containment'] },
    resume: { file: 'cycle-resume.ts', calls: ['promptSession', 'closeSession', 'stopSupervisor', 'recordSession', 'preserveWork', 'reportCapacity', 'containment', 'controlPlaneClock', 'settleContainment'] },
    reclaim: { file: 'cycle-reclaim.ts', calls: ['panes', 'closeSession', 'reclaim', 'herdr', 'reclaimResources', 'containment', 'controlPlaneClock', 'settleContainment', 'preserveWork', 'reportCapacity'] },
    triage: { file: 'cycle-triage.ts', calls: ['recordTriage', 'withdrawTriage'] },
    master: { file: 'cycle-master.ts', calls: ['promptSession', 'herdr', 'sessionOutput', 'endRegistrySession', 'holdAccount', 'closeSession'] },
  };
  for (const [step, { file, calls }] of Object.entries(steps)) {
    const source = readFileSync(`${root}src/daemon/${file}`, 'utf8');
    assert.match(source, new RegExp(`withinStepBudget\\(cycle, '${step}', \\[${calls.map(call => `'${call}'`).join(', ')}\\]`), `${file} runs the ${step} step under the shared bound with its calls`);
  }
  const decisions = readFileSync(`${root}src/daemon/cycle-decisions.ts`, 'utf8');
  assert.match(decisions, /boundedDecisions\(boundedCalls\(await decisionReads\(.*\), cycle\.heldDecisions, now, \(\) => budgetLeft\(\), \{ step: 'approvers', calls: approverCalls \}\)/, 'the approvers step\'s calls are bounded within the decisions step');
  assert.match(decisions, /const approverCalls: readonly \(keyof DaemonEffects\)\[\] = \['approver', 'endRegistrySession', 'resume', 'withdraw', 'closeSession', 'herdr', 'approverLaunches', 'approverLaunch', 'sessionOutput', 'recordSession', 'holdAccount', 'reportCapacity', 'reconcileSessions'\]/);
  // The successor re-plan of the scope step runs under the same bound with its own calls; the approvers' isolation is carried-aware like every bounded step's.
  assert.match(readFileSync(`${root}src/daemon/cycle-scope.ts`, 'utf8'), /withinStepBudget\(cycle, 'scope', \['baseSuccessions', 'replan', 'mergeWriter'\], bounded => successorStepWithin\(bounded, settled\)\)/);
  assert.match(readFileSync(`${root}src/daemon/cycle-approvers.ts`, 'utf8'), /isolate = carriedIsolate\(carried, 'approvers'\)/);
  // The preservation an ended attempt makes (sessions, resume, reclaim) carries like any other call: no failed preserve, no fault.
  assert.match(readFileSync(`${root}src/daemon/preserve.ts`, 'utf8'), /if \(stepCallCarried\(error\)\) \{ await recordCarried\(/);
  // Triage: the record is bounded while the step runs; once the step has returned its budget is gone, so the step's own effects pass through, and cycle-triage.ts bounds a late record by the per-call bound alone (below).
  const recorded = hanging();
  const cfg = config(), state = emptyDaemonState(cfg);
  const seen: (number | null)[] = [];
  const stepCycle = { config: cfg, state, now: () => clock, effects: effects([], { recordTriage: recorded.call as DaemonEffects['recordTriage'] } as Partial<DaemonEffects>), isolate: async (_kind: unknown, _item: unknown, _name: unknown, body: () => Promise<unknown>) => body() } as unknown as Parameters<Helper['withinStepBudget']>[0];
  await sb.withinStepBudget(stepCycle, 'triage', ['recordTriage'], async bounded => {
    const started = performance.now();
    await assert.rejects(bounded.effects.recordTriage!(quiet('GY-8'), { judgement: { kind: 'close', reason: 'covered' } } as never) as Promise<unknown>, /the triage step's 30 ms per-call bound passed before GY-8's recordTriage call answered/);
    seen.push(Math.round(performance.now() - started));
  });
  assert.ok(seen[0]! < 2_000, 'within the step the record is bounded');
  const triage = readFileSync(`${root}src/daemon/cycle-triage.ts`, 'utf8');
  assert.match(triage, /boundedCalls\(unboundedEffects\(effects\), state, now, \(\) => stepCallBoundMs, \{ step: 'triage', calls: \['recordTriage'\] \}\)/, 'a record a run makes after the step is bounded by the per-call bound alone');
  assert.match(triage, /carried: stepCallCarried/, 'and a carried one stays owed to triage, which records it again next cycle');
  recorded.answer(undefined);
});

// --- the review's findings on b396b7b3, each pinned (GY-1774 rework) -----------------------------------------------

test('unit:step-calls-bounded — scope: a finding-grounded widening carried past the bound is retried next cycle; the retry consumes the widening\'s answer once it has settled, so the ask is never left undecided', async () => {
  const sb = await helper();
  const { scopeKey } = await import('../src/daemon/reconcile.js');
  const slow = hanging<Work>();
  const asked = iso(-300_000), paths = ['src/other.ts'];
  const request = { epoch: 1, paths, reason: 'the reviewer asked for it', requestedBy: 'graphyard-claude-a', at: asked,
    decision: { state: 'refused', reason: 'outside what the criteria imply', at: iso(-200_000), decidedBy: 'graphyard', treeRead: true, waitedMs: 100_000, paths, requestedBy: 'graphyard-claude-a', requestedAt: asked, epoch: 1 } };
  const work = quiet('GY-9', { lease: { epoch: 1, owner: 'graphyard-claude-a', expiresAt: iso(3_600_000) }, scopeRequest: request } as Partial<Work>);
  const fx = effects([work], { widenScope: slow.call as DaemonEffects['widenScope'], reviewFindings: async () => [{ ground: 'review thread 1', text: 'src/other.ts must handle the empty case too' }],
    basePaths: async (wanted: readonly string[]) => new Set(wanted), repositoryFiles: async () => new Set(['src/loop.ts', 'src/other.ts']) } as Partial<DaemonEffects>);
  const state = emptyDaemonState(config());
  await cycle(state, fx, clock);
  const key = `${scopeKey(work, request as never)}:finding:${work.policyRevision}`;
  assert.equal(slow.calls.length, 1, `the widening was sent: ${JSON.stringify(Object.keys(state.actions))}`);
  assert.ok(sb.carriedRow(state.actions[key]), `the widening is recorded carried: ${JSON.stringify(state.actions[key])}`);
  assert.match(state.actions[key]!.detail, /the scope step's 30 ms per-call bound passed before GY-9's widenScope call answered/);
  await cycle(state, fx, clock + 60_000);
  assert.equal(slow.calls.length, 1, 'the next cycle retried the widening and joined the one in flight');
  assert.ok(sb.carriedRow(state.actions[key]), 'still carried');
  slow.answer({ ...work, policyRevision: 2, plannedFiles: ['src/loop.ts', 'src/other.ts'], scopeRequest: null, scopeDecision: { state: 'approved', reason: 'widened', at: iso(100_000), decidedBy: 'graphyard', paths, requestedBy: 'graphyard-claude-a', requestedAt: asked, epoch: 1, waitedMs: 400_000 } } as unknown as Work);
  await new Promise(resolve => setTimeout(resolve, 5));
  await cycle(state, fx, clock + 120_000);
  assert.equal(slow.calls.length, 1, 'the answer was consumed, not sent again');
  assert.equal(state.actions[key]?.state, 'done', `the widening settled: ${JSON.stringify(state.actions[key])}`);
  assert.match(state.actions[key]!.detail, /^Widened GY-9 with 1 file \(src\/other\.ts\) on the review finding that names it/);
  assert.deepEqual(faults(state), []);
});

test('unit:step-calls-bounded — review-cap: a withdrawal in flight across cycles is one send, never counted toward the filing cap; a carried observation wake after the withdrawal is retried until it answers', async () => {
  const sb = await helper();
  const { cappedReworkBinding, cappedRevisionMark } = await import('../src/daemon/decisions.js');
  const { cappedEscalationKey, cappedFilingKey, maxCappedFilingAttempts, reviewCapStep } = await import('../src/daemon/cycle-review-cap.js');
  const { emptyHeldDecisions } = await import('../src/daemon/decision-reads.js');
  const reviewer = 'graphyard-reviewer[bot]', H = 'f1ea5b764ac7'.padEnd(40, '0');
  const cfg = config({ reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.pem', boundAt: iso(-86_400_000) } });
  const capped = (body: string) => {
    const work = item('GY-10', { candidate: { sha: H, baseSha: base, pr: 1047, branch: 'graphyard/gy-10-5', author: 'implementer' }, epoch: 5, pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 4, interventions: { blocked: 0, requirements: 0 } } } as unknown as Partial<Work>);
    work.observation = { ...work.observation!, candidate: work.candidate, reviews: [{ reviewer, sha: H, state: 'CHANGES_REQUESTED', id: 4242, submittedAt: iso(-900_000), body }] } as Observation;
    return work;
  };
  const decision = (state: 'requested' | 'refused') => ({ id: '334c52c6-467e-4fe4-b81f-2c761e07a066', action: 'rework', state, input: { binding: cappedReworkBinding(H, reviewer), previousWorkerStopped: true },
    reason: `[Decided from the GitHub observation taken at ${iso(-800_000)} of candidate ${H}; if the item has moved since, this request no longer describes it.] ${cappedRevisionMark(1)} GY-10 is in review round 5, past its cap of 3.`,
    approvedBy: null, refusal: state === 'refused' ? { approver: 'graphyard-approver-project', reason: 'The finding is real but not blocking.', at: iso(-600_000) } : null });
  const run = (work: Work, overrides: Partial<DaemonEffects>) => {
    const state = emptyDaemonState(cfg), performed: unknown[] = [];
    const fx = effects([work], { decisions: async () => ({ decisions: [decision('refused')] }), stepCallBoundMs: 30, ...overrides } as Partial<DaemonEffects>);
    let tick = clock;
    const step = async () => { state.cycle++; tick += 60_000; await returns(reviewCapStep({ config: cfg, state, effects: fx, performed, now: () => tick, open: [work], snapshot: { work: [work], now: iso(tick - clock) }, heldDecisions: emptyHeldDecisions(), isolate: async (_kind: unknown, _item: unknown, _name: unknown, body: () => Promise<unknown>) => body() } as never)); };
    return { state, step, work };
  };
  // A nits-only change request: the withdrawal hangs across more cycles than the cap allows failures — one send, joined each cycle, no escalation.
  const withdrawal = hanging();
  const nits = run(capped('The helper could be named more clearly.'), { withdrawReview: withdrawal.call as DaemonEffects['withdrawReview'] });
  const key = cappedFilingKey(nits.state as never, { sha: H, reviewId: 4242 }), work = capped('nits');
  for (let n = 0; n < maxCappedFilingAttempts + 1; n++) await nits.step();
  const row = nits.state.actions[cappedFilingKey(work, { sha: H, reviewId: 4242 })];
  assert.equal(withdrawal.calls.length, 1, `one withdrawal was sent across ${maxCappedFilingAttempts + 1} cycles: ${key}`);
  assert.ok(sb.carriedRow(row), `the withdrawal is carried: ${JSON.stringify(row)}`);
  assert.equal(row!.attempts, 1, 'the row counts the one send');
  assert.equal(nits.state.actions[cappedEscalationKey(work, H)], undefined, 'a withdrawal still in flight is never escalated as failed');
  withdrawal.answer(undefined);
  await new Promise(resolve => setTimeout(resolve, 5));
  await nits.step();
  assert.equal(nits.state.actions[cappedFilingKey(work, { sha: H, reviewId: 4242 })]?.state, 'done', 'once the withdrawal answered, the retry consumed it');
  assert.equal(withdrawal.calls.length, 1);
  // A refused capped rework: the withdrawal answers, the observation wake hangs — the wake is carried on its own row and retried, joining the one in flight, until it answers.
  const wake = hanging();
  const refused = run(capped('BLOCKING: former hotspot files exceed their size budgets.'), { withdrawReview: async () => {}, wakeObservation: wake.call as DaemonEffects['wakeObservation'] });
  await refused.step();
  const filing = refused.state.actions[cappedFilingKey(work, { sha: H, reviewId: 4242 })], wakeKey = `${cappedFilingKey(work, { sha: H, reviewId: 4242 })}:wake`;
  assert.equal(filing?.state, 'done', `the withdrawal is done: ${JSON.stringify(filing)}`);
  assert.match(filing!.detail, /its observation wake was carried to the next cycle, which retries it so the owed request-rework is cancelled/);
  assert.ok(sb.carriedRow(refused.state.actions[wakeKey]), `the wake is carried on its own row: ${JSON.stringify(refused.state.actions[wakeKey])}`);
  assert.equal(wake.calls.length, 1);
  await refused.step();
  assert.equal(wake.calls.length, 1, 'the next cycle retried the wake and joined the one in flight');
  assert.ok(sb.carriedRow(refused.state.actions[wakeKey]));
  // The withdrawal that owes the wake dismissed the change request: the next snapshot reads no capped review on the head, and the owed wake is still retried, found by its row alone.
  refused.work.observation = { ...refused.work.observation!, reviews: [] } as Observation;
  await refused.step();
  assert.equal(wake.calls.length, 1, 'with the change request gone from the snapshot the wake is still retried, joining the one in flight');
  assert.ok(sb.carriedRow(refused.state.actions[wakeKey]), `still carried once the capped review reads null: ${JSON.stringify(refused.state.actions[wakeKey])}`);
  wake.answer(undefined);
  await new Promise(resolve => setTimeout(resolve, 5));
  await refused.step();
  assert.equal(refused.state.actions[wakeKey]?.state, 'done', `the wake answered: ${JSON.stringify(refused.state.actions[wakeKey])}`);
  assert.match(refused.state.actions[wakeKey]!.detail, /its observation woken so the owed request-rework is cancelled/);
  assert.equal(wake.calls.length, 1, 'woken once');
});

test('unit:step-calls-applied-once — triage: a judgement whose record is carried stays owed and is recorded again next cycle, joining the write, never judged again; a refused record is a failure as before', async t => {
  const sb = await helper();
  const { clearTriageRuns, owedTriageRecords, triageSettled, triageStep } = await import('../src/triage.js');
  const { researchSettings } = await import('../src/research.js');
  t.after(clearTriageRuns);
  const filed = quiet('GY-11', { title: 'Recurring action:dispatch faults: 4 in 24 hours', type: 'bug', stage: 'backlog', ready: false, plannedFiles: [], origin: { faultClass: { class: 'action', threshold: 3, windowHours: 24, count: 4, detectedAt: iso(-7_200_000), instances: [{ id: 'a|b|0', kind: 'action', subject: 'action:dispatch', at: iso(-7_200_000) }] } } } as unknown as Partial<Work>);
  const fix = quiet('GY-12', { title: 'Stop the dispatch fault', stage: 'done', delivery: { mergedAt: iso(-3_600_000), mergeSha: 'a'.repeat(40), authorizationRevision: 1 }, origin: { faultClass: { class: 'action', threshold: 3, windowHours: 24, count: 1, detectedAt: iso(-86_400_000), instances: [] } } } as unknown as Partial<Work>);
  const carried = () => new sb.StepCallCarriedError("the triage step's 30 ms per-call bound passed before GY-11's recordTriage call answered; the call stays owed and is retried next cycle", true);
  const records: unknown[] = []; let answer: 'carried' | 'ok' | 'refused' = 'carried';
  const runner = { name: 'pi', start: () => { throw new Error('no run is started while a record is owed'); } } as never;
  const step = () => triageStep({ work: [filed, fix], clock, settings: researchSettings({ research: {} }), config: { repository: 'owner/project' }, cwd: process.cwd(), runner, carried: sb.stepCallCarried,
    record: async (work, body) => { records.push(body.judgement); if (answer === 'carried') throw carried(); if (answer === 'refused') throw new Error('409 already judged'); } });
  // Covered by a delivery: the closure is recorded without a run; its write is carried.
  assert.deepEqual(step().map(action => action.state), ['done'], 'the closure is proposed');
  await triageSettled();
  assert.equal(records.length, 1);
  assert.ok(owedTriageRecords().has(filed.id), 'the carried record stays owed');
  // Next cycle: recorded again (joining the write), not judged again — and no retry hold, which a failure would set.
  assert.deepEqual(step().map(action => action.state), ['recorded']);
  await triageSettled();
  assert.equal(records.length, 2);
  assert.ok(owedTriageRecords().has(filed.id));
  answer = 'ok';
  assert.deepEqual(step().map(action => action.state), ['recorded']);
  await triageSettled();
  assert.ok(!owedTriageRecords().has(filed.id), 'once the write answered, nothing is owed');
  // A refused write: the failure holds the item for the retry interval as before, and nothing is owed.
  answer = 'refused';
  assert.deepEqual(step().map(action => action.state), ['done']);
  await triageSettled();
  assert.ok(!owedTriageRecords().has(filed.id));
  assert.deepEqual(step(), [], 'held by the failure until the retry interval');
});

test('unit:step-calls-bounded — triage: the record a settled run makes after the step is bounded by the per-call bound; carried, the next cycle records it again in the step, carried on the item\'s row, joining the write, and the one after consumes its answer', async t => {
  const sb = await helper();
  const { clearTriageRuns, triageSettled } = await import('../src/triage.js');
  t.after(clearTriageRuns);
  const filed = quiet('GY-13', { title: 'Recurring action:dispatch faults: 4 in 24 hours', type: 'bug', stage: 'backlog', ready: false, plannedFiles: [] } as unknown as Partial<Work>);
  const slow = hanging();
  // The run settles only once the test says so: after the step that started it has returned.
  let settle!: (result: unknown) => void;
  const runner = { name: 'pi', start: (_prompt: string, options: { validate: (payload: unknown) => unknown }) => ({ id: 'run-1', events: [], onEvent: () => () => {}, cancel: () => {}, result: () => new Promise(resolve => { settle = () => resolve({ ok: true, tool: 'triage', payload: options.validate({ outcome: 'release', priority: 2, reason: 'real work' }), payloads: [] }); }) }) };
  const cfg = config({ run: { intervalSeconds: 60, research: {} } });
  const fx = effects([filed], { recordTriage: slow.call as DaemonEffects['recordTriage'], research: { cwd: process.cwd(), runner } } as unknown as Partial<DaemonEffects>);
  const state = emptyDaemonState(cfg), key = `triage:${filed.id}:record`;
  await cycle(state, fx, clock, cfg);
  assert.equal(state.actions[`triage:${filed.id}:started`]?.state, 'done', `the run started: ${JSON.stringify(Object.keys(state.actions))}`);
  settle(undefined);
  await triageSettled();
  assert.equal(slow.calls.length, 1, 'the settled run recorded its judgement after the step, under the per-call bound');
  assert.ok(!(key in state.actions), 'no cycle ran, so no row yet');
  await cycle(state, fx, clock + 60_000, cfg);
  assert.equal(slow.calls.length, 1, 'the next cycle recorded it again in the step and joined the write in flight');
  assert.ok(sb.carriedRow(state.actions[key]), `carried on the item's row: ${JSON.stringify(state.actions[key])}`);
  assert.match(state.actions[key]!.detail, /the triage step's 30 ms per-call bound passed before GY-13's recordTriage call answered/);
  assert.match(state.actions[`triage:${filed.id}:recorded`]?.detail ?? '', /Recording again the triage judgement of machine-filed GY-13 \(release\)/);
  assert.deepEqual(faults(state), []);
  slow.answer(undefined);
  await new Promise(resolve => setTimeout(resolve, 5));
  await cycle(state, fx, clock + 120_000, cfg);
  assert.equal(slow.calls.length, 1, 'the answer was consumed, never sent again');
  assert.equal(state.actions[key]?.state, 'done', JSON.stringify(state.actions[key]));
  assert.match(state.actions[key]!.detail, /Recorded the triage judgement of GY-13 \(release\) whose write was carried from an earlier cycle/);
});

// --- the review's findings on 20c8b1e7, each pinned (GY-1774 rework, round 3) -----------------------------------------

/** A call that never answers on its own, each made separately, so a settled one is not the next one's answer. */
function hangingEach<T = unknown>() {
  const calls: { args: unknown[]; answer: (value: T) => void }[] = [];
  return { calls, call: ((...args: unknown[]) => new Promise<T>(answer => { calls.push({ args, answer }); })) as unknown as (...args: any[]) => any };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('unit:step-calls-applied-once — a carried call\'s answer is kept until its owed retry consumes it, whatever the run interval: it outlives two 900 s intervals and is dropped only once three cycles have begun since it settled, so a retry never sends a call whose answer is kept', async () => {
  const sb = await helper();
  assert.equal(sb.settledKeepCycles, 3, 'an answer is kept by cycles, never by a clock an interval could outrun');
  const kept = { cycle: 10 }, slow = hangingEach<{ profile: string }>();
  let tick = clock;
  const fx = sb.boundedCalls(effects([], { promptSession: slow.call as DaemonEffects['promptSession'] }), kept, () => tick, () => 10_000, { step: 'resume', calls: ['promptSession'] });
  const agent = { name: 'graphyard-claude-a', pane_id: 'pane-1' } as HerdrAgent;
  await assert.rejects(fx.promptSession!(agent, 'resume GY-1') as Promise<void>, sb.stepCallCarried);
  slow.calls[0].answer({ profile: 'x' });
  await settle();
  // Two run intervals of 900 s pass on the loop's clock before the retry comes on the next cycle: well past the ten minutes an earlier revision kept it.
  tick += 2 * 900_000; kept.cycle = 11;
  assert.deepEqual(await fx.promptSession!(agent, 'resume GY-1'), { profile: 'x' }, 'the retry on the next cycle consumes the kept answer, however long the interval');
  assert.equal(slow.calls.length, 1, 'and sends nothing: the effect is applied once');
  // Kept while fewer than settledKeepCycles cycles have begun since it settled.
  await assert.rejects(fx.promptSession!(agent, 'resume GY-1') as Promise<void>, sb.stepCallCarried);
  assert.equal(slow.calls.length, 2, 'once consumed, the next call is fresh');
  slow.calls[1].answer({ profile: 'y' });
  await settle();
  kept.cycle = 13;
  assert.deepEqual(await fx.promptSession!(agent, 'resume GY-1'), { profile: 'y' }, 'two cycles on, the answer is still kept and consumed');
  assert.equal(slow.calls.length, 2);
  // The call's own key is swept with the rest: a retry within the keep consumes its answer; one past it (the action it served moot, never retried in time) is a fresh send and never takes the stale answer for its effect.
  await assert.rejects(fx.promptSession!(agent, 'resume GY-1') as Promise<void>, sb.stepCallCarried);
  slow.calls[2].answer({ profile: 'z' });
  await settle();
  kept.cycle = 15;
  assert.deepEqual(await fx.promptSession!(agent, 'resume GY-1'), { profile: 'z' }, 'two cycles on, the retry consumes its own answer, never sending again');
  assert.equal(slow.calls.length, 3);
  await assert.rejects(fx.promptSession!(agent, 'resume GY-1') as Promise<void>, sb.stepCallCarried);
  slow.calls[3].answer({ profile: 'stale' });
  await settle();
  kept.cycle = 18;
  await assert.rejects(fx.promptSession!(agent, 'resume GY-1') as Promise<void>, sb.stepCallCarried);
  assert.equal(slow.calls.length, 5, 'three cycles on, the kept answer is dropped and the call under its key is a fresh send');
  slow.calls[4].answer({ profile: 'fresh' });
  await settle();
  kept.cycle = 19;
  assert.deepEqual(await fx.promptSession!(agent, 'resume GY-1'), { profile: 'fresh' }, 'and its retry consumes the fresh answer, never the stale one');
  // An answer of another key nobody retries is dropped once it is three cycles old.
  const other = { name: 'graphyard-claude-b', pane_id: 'pane-2' } as HerdrAgent;
  await assert.rejects(fx.promptSession!(other, 'resume GY-2') as Promise<void>, sb.stepCallCarried);
  slow.calls[5].answer({ profile: 'w' });
  await settle();
  kept.cycle = 23;
  await assert.rejects(fx.promptSession!(agent, 'resume GY-1') as Promise<void>, sb.stepCallCarried);
  await assert.rejects(fx.promptSession!(other, 'resume GY-2') as Promise<void>, sb.stepCallCarried);
  assert.equal(slow.calls.length, 8, 'with no retry inside the keep the answer is dropped and the call is a fresh send');
});

test('unit:step-calls-applied-once — an answer owed to a carried row that stands is kept for its retry however many cycles begin before it: a retry deferred by earlier calls or a spent budget consumes it and never starts the effect again; the row retired releases the answer to the cycle keep, after which a call under its key is a fresh send', async () => {
  const sb = await helper();
  const state = { actions: {} as Record<string, DaemonAction>, cycle: 10 } as unknown as DaemonState;
  const carried = () => ({ state, now: () => clock, performed: [], effects: effects([], {}) }) as unknown as Parameters<Helper['recordCarried']>[0];
  const slow = hangingEach<{ profile: string }>();
  const fx = sb.boundedCalls(effects([], { promptSession: slow.call as DaemonEffects['promptSession'] }), state, () => clock, () => 10_000, { step: 'resume', calls: ['promptSession'] });
  const agent = { name: 'graphyard-claude-a', pane_id: 'pane-1' } as HerdrAgent, other = { name: 'graphyard-claude-b', pane_id: 'pane-2' } as HerdrAgent, row = 'carried:session:item-1';
  const rejection = (call: Promise<unknown>) => call.then(() => assert.fail('the call was carried, never answered'), (error: unknown) => error);
  // The re-prompt is carried and recorded on the item's row, which owes its answer to the retry.
  const first = await rejection(fx.promptSession!(agent, 'resume GY-1') as Promise<unknown>);
  assert.ok(sb.stepCallCarried(first));
  await sb.recordCarried(carried(), row, { kind: 'session', work: 'GY-1' }, first, 'Re-prompting GY-1');
  assert.ok(sb.carriedRow(state.actions[row]), JSON.stringify(state.actions[row]));
  slow.calls[0].answer({ profile: 'owed' });
  await settle();
  // The retry is deferred for five cycles: two in which the handling's earlier call is carried again on the same row, three more in which the step's budget is spent before the handling is reached.
  state.cycle = 12;
  const spent = sb.boundedCalls(effects([], { promptSession: slow.call as DaemonEffects['promptSession'] }), state, () => clock, () => 0, { step: 'resume', calls: ['promptSession'] });
  const deferred = await rejection(spent.promptSession!(other, 'close GY-1 first') as Promise<unknown>);
  assert.ok(sb.stepCallCarried(deferred) && !sb.carriedCallSent(deferred), 'the earlier call is carried unsent on the spent budget');
  await sb.recordCarried(carried(), row, { kind: 'session', work: 'GY-1' }, deferred, 'Closing GY-1 first');
  state.cycle = 15;
  assert.deepEqual(await fx.promptSession!(agent, 'resume GY-1'), { profile: 'owed' }, 'five cycles on, past the keep an unowed answer gets, the retry consumes the answer the row still owes');
  assert.equal(slow.calls.length, 1, 'and sends nothing: the effect is applied once');
  // A retry that reaches the call on a spent budget consumes the owed answer too: the effect is done, nothing waits for a fresh budget.
  const second = await rejection(fx.promptSession!(agent, 'resume GY-1') as Promise<unknown>);
  await sb.recordCarried(carried(), row, { kind: 'session', work: 'GY-1' }, second, 'Re-prompting GY-1');
  slow.calls[1].answer({ profile: 'spent' });
  await settle();
  state.cycle = 20;
  assert.deepEqual(await spent.promptSession!(agent, 'resume GY-1'), { profile: 'spent' }, 'consumed on the spent budget, five cycles on');
  assert.equal(slow.calls.length, 2);
  // The row retired (its handling ran through) owes the answer no more: it is kept by the cycle keep alone, and a call under its key after the keep is a fresh send.
  const third = await rejection(fx.promptSession!(agent, 'resume GY-1') as Promise<unknown>);
  await sb.recordCarried(carried(), row, { kind: 'session', work: 'GY-1' }, third, 'Re-prompting GY-1');
  slow.calls[2].answer({ profile: 'released' });
  await settle();
  await sb.retireCarried(carried(), row, state.actions[row]!, 'Handling GY-1 ran through another way');
  assert.equal(state.actions[row]?.state, 'done');
  state.cycle = 23;
  await assert.rejects(fx.promptSession!(agent, 'resume GY-1') as Promise<void>, sb.stepCallCarried);
  assert.equal(slow.calls.length, 4, 'three cycles on, the released answer is dropped and the call is a fresh send');
  // The row carried again by the retry of a sibling isolation (the blockers step runs three per item) owes the flight anew, so its retire between them never costs the answer.
  await sb.recordCarried(carried(), row, { kind: 'session', work: 'GY-1' }, await rejection(fx.promptSession!(agent, 'resume GY-1') as Promise<unknown>), 'Re-prompting GY-1');
  await sb.retireCarried(carried(), row, state.actions[row]!, 'A sibling isolation ran through');
  await sb.recordCarried(carried(), row, { kind: 'session', work: 'GY-1' }, await rejection(fx.promptSession!(agent, 'resume GY-1') as Promise<unknown>), 'Re-prompting GY-1');
  assert.equal(slow.calls.length, 4, 'the retry joined the call still in flight');
  slow.calls[3].answer({ profile: 'again' });
  await settle();
  state.cycle = 30;
  assert.deepEqual(await fx.promptSession!(agent, 'resume GY-1'), { profile: 'again' }, 'owed again, the answer is kept for the retry however many cycles begin');
  assert.equal(slow.calls.length, 4);
  // The wall keep never drops an owed answer: a row deferred for days behind earlier calls or spent budgets still has its retry consume the answer, so the effect is never sent a second time. Retired, the answer falls to the wall keep like any unowed one.
  assert.equal(sb.settledKeepMs, 24 * 3_600_000, 'the wall keep bounds an answer no row owes');
  const real = Date.now;
  try {
    const fifth = await rejection(fx.promptSession!(agent, 'resume GY-1') as Promise<unknown>);
    await sb.recordCarried(carried(), row, { kind: 'session', work: 'GY-1' }, fifth, 'Re-prompting GY-1');
    slow.calls[4].answer({ profile: 'days' });
    await settle();
    // The wall runs on under the offset, so a bound still passes; only its date is days ahead.
    let ahead = sb.settledKeepMs + 60_000;
    Date.now = () => real() + ahead;
    state.cycle = 31;
    const held = await rejection(spent.promptSession!(other, 'close GY-1 first') as Promise<unknown>);
    await sb.recordCarried(carried(), row, { kind: 'session', work: 'GY-1' }, held, 'Closing GY-1 first');
    assert.equal(slow.calls.length, 5, 'a day on, the spent budget sends nothing and the owed answer stands');
    ahead += 2 * sb.settledKeepMs;
    state.cycle = 40;
    assert.deepEqual(await fx.promptSession!(agent, 'resume GY-1'), { profile: 'days' }, 'three days on, the retry consumes the answer the row still owes');
    assert.equal(slow.calls.length, 5, 'and sends nothing: the effect is applied once');
    const sixth = await rejection(fx.promptSession!(agent, 'resume GY-1') as Promise<unknown>);
    await sb.recordCarried(carried(), row, { kind: 'session', work: 'GY-1' }, sixth, 'Re-prompting GY-1');
    slow.calls[5].answer({ profile: 'unowed' });
    await settle();
    await sb.retireCarried(carried(), row, state.actions[row]!, 'Handling GY-1 ran through another way');
    ahead += sb.settledKeepMs;
    state.cycle = 41;
    await assert.rejects(fx.promptSession!(agent, 'resume GY-1') as Promise<void>, sb.stepCallCarried);
    assert.equal(slow.calls.length, 7, 'released, the answer a day old is dropped by the wall keep and the call is a fresh send');
  } finally { Date.now = real; }
});

test('unit:step-calls-bounded — a step budget is spent on the wall as well as the loop clock, so a fixed clock never lets a step outlast it', async () => {
  const sb = await helper();
  const budget = sb.stepBudget(() => 1000, 1000);
  assert.ok(budget.left()! > 0);
  const real = Date.now;
  try { Date.now = () => real() + sb.stepBudgetMs(1000) + 1; assert.equal(budget.left(), 0, 'the wall spent the budget under a fixed clock'); } finally { Date.now = real; }
  budget.end();
  assert.equal(budget.left(), null);
});

test('unit:step-calls-bounded — blockers: an environmental probe and its record are bounded; carried, the item\'s handling is recorded carried with no fault, the next cycle joins the probe still running and consumes its answer, and the record is joined until it answers', async () => {
  const sb = await helper();
  const probing = hanging<BlockerProbeResult>(), recording = hanging<Work>();
  const work = quiet('GY-11', { blocker: 'graphyard complete failed: HTTP 502 Bad Gateway from the control plane', blockerProbe: null } as Partial<Work>);
  const fx = effects([work], { probeBlocker: probing.call as DaemonEffects['probeBlocker'], recordBlockerProbe: recording.call as DaemonEffects['recordBlockerProbe'] } as Partial<DaemonEffects>);
  const state = emptyDaemonState(config()), key = `carried:blocker:${work.id}`;
  await cycle(state, fx, clock);
  assert.equal(probing.calls.length, 1, 'the probe was started');
  assert.ok(sb.carriedRow(state.actions[key]), `the item's handling is recorded carried: ${JSON.stringify(Object.keys(state.actions))}`);
  assert.match(state.actions[key].detail, /the blockers step's 30 ms per-call bound passed before GY-11's probeBlocker call answered; the call stays owed and is retried next cycle/);
  assert.deepEqual(faults(state), [], 'a carried probe is no fault');
  assert.equal(recording.calls.length, 0, 'nothing is recorded before the probe answers');
  await cycle(state, fx, clock + 60_000);
  assert.equal(probing.calls.length, 1, 'the next cycle joined the probe still running');
  assert.ok(sb.carriedRow(state.actions[key]), 'still carried');
  probing.answer({ probe: 'the server reports healthy', passed: false, detail: 'the server answered 500 on /healthz' });
  await settle();
  await cycle(state, fx, clock + 120_000);
  assert.equal(probing.calls.length, 1, 'the retry consumed the probe\'s answer, never probing again');
  assert.equal(state.actions[key]?.state, 'done', `the carried handling ran through: ${JSON.stringify(state.actions[key])}`);
  assert.equal(recording.calls.length, 1, 'the answer was recorded on the item');
  const row = state.actions[`blocker:${work.id}`];
  assert.ok(sb.carriedRow(row), `the record is carried on the item's blocker row: ${JSON.stringify(row)}`);
  assert.match(row.detail, /the blockers step's 30 ms per-call bound passed before GY-11's recordBlockerProbe call answered/);
  assert.deepEqual(faults(state), []);
  await cycle(state, fx, clock + 180_000);
  assert.equal(recording.calls.length, 1, 'the next cycle recorded the probe again and joined the write in flight');
  recording.answer(work);
  await settle();
  await cycle(state, fx, clock + 240_000);
  assert.equal(recording.calls.length, 1, 'the write\'s answer was consumed: recorded once');
  assert.equal(state.actions[`blocker:${work.id}`]?.state, 'done', `the blocker row settles once the record answered: ${JSON.stringify(state.actions[`blocker:${work.id}`])}`);
  assert.match(state.actions[`blocker:${work.id}`]!.detail, /the loop re-checks it every cycle: the server reports healthy fails/);
});

test('unit:step-calls-bounded — reclaim: the worktree reclaim is bounded; carried, it is recorded on the step\'s row with no fault, the next cycle reclaims again and joins it, and its answer, once consumed, is applied and retires the row', async () => {
  const sb = await helper();
  const slow = hanging<unknown>();
  const fx = effects([], { reclaim: slow.call as DaemonEffects['reclaim'] } as Partial<DaemonEffects>);
  const state = emptyDaemonState(config()), key = 'carried:reclaim:reclaim';
  await cycle(state, fx, clock);
  assert.equal(slow.calls.length, 1, 'the reclaim was started');
  assert.ok(sb.carriedRow(state.actions[key]), `the reclaim is recorded carried on the step's row: ${JSON.stringify(Object.keys(state.actions))}`);
  assert.match(state.actions[key].detail, /the reclaim step's 30 ms per-call bound passed before the reclaim call answered; the call stays owed and is retried next cycle/);
  assert.deepEqual(faults(state), [], 'a carried reclaim is no fault');
  assert.ok(!state.reclaim, 'nothing is applied before it answers');
  await cycle(state, fx, clock + 60_000);
  assert.equal(slow.calls.length, 1, 'the next cycle reclaimed again and joined the one in flight');
  slow.answer({ root: '/repo', at: iso(60_000), applied: true, scanned: 2, idleMs: 0, removed: [], kept: [], freeBefore: null, freeAfter: 10e9, freedBytes: 0, errors: [] });
  await settle();
  await cycle(state, fx, clock + 120_000);
  assert.equal(slow.calls.length, 1, 'the answer was consumed, not reclaimed again');
  assert.equal((state.reclaim as unknown as { at?: string } | undefined)?.at, iso(60_000), `the consumed report is applied: ${JSON.stringify(state.reclaim)}`);
  assert.equal(state.actions[key]?.state, 'done', `the row is retired once the call answered: ${JSON.stringify(state.actions[key])}`);
});

test('unit:step-calls-bounded — sessions and dispatch: the listings the steps read at their own level are bounded; carried, each is recorded on the step\'s row with no fault and answered with what the step had, the next cycle reads again and joins it, and the answer retires the row', async () => {
  const sb = await helper();
  const listing = hanging<never[]>(), roles = hanging<Record<string, never>>();
  const fx = effects([], { launchedSessions: listing.call as DaemonEffects['launchedSessions'], roleHealth: roles.call as DaemonEffects['roleHealth'], sessionOutput: () => null, reportCapacity: async work => work } as Partial<DaemonEffects>);
  const state = emptyDaemonState(config());
  await cycle(state, fx, clock);
  for (const [key, call] of [['carried:sessions:launchedSessions', listing], ['carried:dispatch:roleHealth', roles]] as const) {
    assert.equal(call.calls.length, 1, `${key} was read once`);
    assert.ok(sb.carriedRow(state.actions[key]), `the read is recorded carried on its step's row: ${JSON.stringify(Object.keys(state.actions))}`);
  }
  assert.match(state.actions['carried:sessions:launchedSessions'].detail, /the sessions step's 30 ms per-call bound passed before the launchedSessions call answered/);
  assert.match(state.actions['carried:dispatch:roleHealth'].detail, /the dispatch step's 30 ms per-call bound passed before the roleHealth call answered/);
  assert.deepEqual(faults(state), [], 'a carried read is no fault');
  await cycle(state, fx, clock + 60_000);
  assert.equal(listing.calls.length, 1, 'the next cycle read the listing again and joined the read in flight');
  assert.equal(roles.calls.length, 1, 'the next cycle read the role health again and joined the read in flight');
  listing.answer([]); roles.answer({});
  await settle();
  await cycle(state, fx, clock + 120_000);
  assert.equal(state.actions['carried:sessions:launchedSessions']?.state, 'done', 'the listing answered: its row is retired');
  assert.equal(state.actions['carried:dispatch:roleHealth']?.state, 'done', 'the role health answered: its row is retired');
});

test('unit:step-calls-applied-once — resume: the handle a re-prompt records is a best-effort write; carried, it is owed and retried at the next step start that bounds it, joining the write, and the re-prompt it followed is never sent again', async () => {
  const sb = await helper();
  const prompts = hanging(), handles = hanging(), agents = [{ name: 'graphyard-claude-a', pane_id: 'pane-1', agent_status: 'idle', agent: 'claude' } as HerdrAgent];
  const handle = { id: 'graphyard-claude-a:1', kind: 'implementation', principal: 'graphyard-claude-a', epoch: 1, runtime: 'claude', host: 'machine-a', pane: 'pane-1', agentName: 'graphyard-claude-a', state: 'running', subject: 'GY-12', startedAt: iso(-600_000) };
  const work = quiet('GY-12', { lease: { epoch: 1, owner: 'graphyard-claude-a', expiresAt: iso(7_200_000) }, sessions: [handle], workspaces: [{ host: 'machine-a', path: '/repo/.graphyard/worktrees/GY-12-1', branch: 'graphyard/gy-12-1', epoch: 1, owner: 'graphyard-claude-a' }] } as unknown as Partial<Work>);
  const fx = effects([work], { promptSession: async (...args: unknown[]) => { prompts.calls.push(args); }, recordSession: handles.call as DaemonEffects['recordSession'] }, agents), cfg = config({ workers: [profile()] });
  const state = emptyDaemonState(cfg), key = `owed:handle:${work.id}:graphyard-claude-a:1`;
  await cycle(state, fx, clock, cfg);
  await cycle(state, fx, clock + idleLeaseMs + 60_000, cfg);
  assert.equal(prompts.calls.length, 1, 'past the idle bound the worker is re-prompted');
  assert.equal(handles.calls.length, 1, 'and its handle recorded');
  assert.ok(sb.carriedRow(state.actions[key]), `the handle record is owed on its own row: ${JSON.stringify(Object.keys(state.actions))}`);
  // The blockers step starts after the sessions step in the same cycle and retries the owed write first, joining the call still in flight.
  assert.match(state.actions[key].detail, /step's 30 ms per-call bound passed before GY-12's recordSession call answered/);
  assert.deepEqual(faults(state), []);
  await cycle(state, fx, clock + idleLeaseMs + 120_000, cfg);
  assert.equal(prompts.calls.length, 1, 'the re-prompt the record followed is never sent again');
  assert.equal(handles.calls.length, 1, 'the owed record was retried at the step start and joined the write in flight');
  assert.ok(sb.carriedRow(state.actions[key]));
  handles.answer(undefined);
  await settle();
  await cycle(state, fx, clock + idleLeaseMs + 180_000, cfg);
  assert.equal(handles.calls.length, 1, 'the write\'s answer was consumed: recorded once');
  assert.equal(state.actions[key]?.state, 'done', `the owed row is retired: ${JSON.stringify(state.actions[key])}`);
  assert.equal(prompts.calls.length, 1);
});

test('unit:step-calls-applied-once — the step-level helpers: a carried read answers with its fallback and its row is retired by the answer; an owed write is retried only by a step that bounds its call; a write owed by a loop since restarted is retired unsent, its landing unknown', async () => {
  const sb = await helper();
  const cfg = config(), performed: DaemonAction[] = [];
  const health = hanging<string | null>(), handles = hanging();
  const fx = effects([], { planeHealth: health.call as DaemonEffects['planeHealth'], recordSession: handles.call as DaemonEffects['recordSession'] } as Partial<DaemonEffects>);
  const stepCycle = (state: DaemonState, effectsOf = fx) => ({ config: cfg, state, now: () => clock, effects: effectsOf, performed, isolate: async (_kind: unknown, _item: unknown, _name: unknown, body: () => Promise<unknown>) => body() }) as unknown as Cycle;
  const state = emptyDaemonState(cfg);
  const held = await sb.withinStepBudget(stepCycle(state), 'dispatch', ['planeHealth'], bounded => sb.carriedCall(bounded, 'dispatch', 'dispatch', 'planeHealth', () => bounded.effects.planeHealth!(), error => `held: ${(error as Error).message}`));
  assert.match(held ?? '', /^held: the dispatch step's 30 ms per-call bound passed before the planeHealth call answered/);
  assert.ok(sb.carriedRow(state.actions['carried:dispatch:planeHealth']), 'the read is recorded carried on the step\'s row');
  health.answer(null);
  await settle();
  const read = await sb.withinStepBudget(stepCycle(state), 'dispatch', ['planeHealth'], bounded => sb.carriedCall(bounded, 'dispatch', 'dispatch', 'planeHealth', () => bounded.effects.planeHealth!(), () => 'fallback'));
  assert.equal(read, null, 'the retry consumed the kept answer');
  assert.equal(health.calls.length, 1);
  assert.equal(state.actions['carried:dispatch:planeHealth'].state, 'done', 'the answer retired the row');
  const write = (fxOf: DaemonEffects) => fxOf.recordSession!(quiet('GY-13'), { id: 'h', kind: 'implementation', state: 'running' } as never);
  await sb.withinStepBudget(stepCycle(state), 'resume', ['recordSession'], bounded => sb.owedWrite(bounded, 'handle:GY-13:1', { kind: 'session', work: 'GY-13' }, 'Recording GY-13\'s handle', 'recordSession', write));
  assert.ok(sb.carriedRow(state.actions['owed:handle:GY-13:1']), 'the write is owed on its row');
  assert.equal(handles.calls.length, 1);
  await sb.withinStepBudget(stepCycle(state), 'blockers', ['approver'], async () => {});
  assert.equal(handles.calls.length, 1, 'a step that does not bound the call leaves it owed');
  assert.ok(sb.carriedRow(state.actions['owed:handle:GY-13:1']));
  await sb.withinStepBudget(stepCycle(state), 'sessions', ['recordSession'], async () => {});
  assert.equal(handles.calls.length, 1, 'the next start of a step that bounds the call retried it, joining the write in flight');
  assert.ok(sb.carriedRow(state.actions['owed:handle:GY-13:1']), 'still owed');
  handles.answer(undefined);
  await settle();
  await sb.withinStepBudget(stepCycle(state), 'resume', ['recordSession'], async () => {});
  assert.equal(handles.calls.length, 1, 'the answer was consumed: written once');
  assert.equal(state.actions['owed:handle:GY-13:1'].state, 'done', 'the owed row is retired');
  // A loop since restarted holds the row but no write: whether the write landed is unknown, so it is retired, never re-sent.
  const restarted = emptyDaemonState(cfg), fresh = hanging();
  restarted.actions['owed:handle:GY-14:1'] = { kind: 'session', work: 'GY-14', principal: null, epoch: null, state: 'waiting', attempts: 1, cycle: 0, at: iso(0),
    detail: `Recording GY-14's handle was carried to the next cycle: the resume step's 30 ms per-call bound passed before GY-14's recordSession call answered; the call stays owed and is retried next cycle` };
  await sb.withinStepBudget(stepCycle(restarted, effects([], { recordSession: fresh.call as DaemonEffects['recordSession'] } as Partial<DaemonEffects>)), 'resume', ['recordSession'], async () => {});
  assert.equal(fresh.calls.length, 0, 'nothing is re-sent');
  assert.equal(restarted.actions['owed:handle:GY-14:1'].state, 'done');
  assert.match(restarted.actions['owed:handle:GY-14:1'].detail, /^Recording GY-14's handle was in flight when the loop last stopped: whether it landed is unknown, and a best-effort record is not sent again/);
});

// --- the review's findings on b859a10f, each pinned (GY-1774 rework) -----------------------------------------------

test('unit:step-calls-bounded — dispatch: a split or research record carried past its bound holds its item, is recorded carried with no failed action, and the next cycle\'s record joins the call and retires the row', async () => {
  const { guardCarried, settleCarriedWrites } = await import('../src/daemon/carried-writes.js');
  const sb = await helper();
  const slow = hanging(), work = quiet('GY-9');
  const cfg = config(), state = emptyDaemonState(cfg);
  const make = () => ({ config: cfg, state, now: () => clock, performed: [], effects: effects([work], { recordResearch: slow.call as DaemonEffects['recordResearch'] }), isolate: async (_k: unknown, _i: unknown, _n: unknown, body: () => Promise<unknown>) => body() }) as unknown as Parameters<Helper['withinStepBudget']>[0];
  const pass = () => sb.withinStepBudget(make(), 'dispatch', ['recordResearch'], async bounded => {
    const guarded = guardCarried(bounded.effects.recordResearch!);
    await guarded.write(work, { event: 'started' } as never).catch(() => {});
    await settleCarriedWrites(bounded, 'research', [work], guarded.carried);
    return guarded.carried;
  });
  assert.ok((await pass()).has(work.id), 'the carried record is remembered by item, to hold it');
  assert.ok(sb.carriedRow(state.actions[`carried:dispatch:research:${work.id}`]), 'recorded carried on the item\'s row');
  assert.deepEqual(faults(state), []);
  assert.ok((await pass()).has(work.id));
  assert.equal(slow.calls.length, 1, 'the retry joined the record in flight');
  slow.answer(undefined);
  await settle();
  assert.equal((await pass()).size, 0, 'the answer is consumed by the retry');
  assert.equal(slow.calls.length, 1, 'never sent twice');
  assert.equal(state.actions[`carried:dispatch:research:${work.id}`]?.state, 'done', 'the row is retired');
  const dispatch = readFileSync(`${root}src/daemon/cycle-dispatch.ts`, 'utf8');
  assert.match(dispatch, /record: guarded\.write/);
});

test('unit:step-calls-bounded — master: a Herdr reading that does not answer returns the step, is carried with no fault and read again next cycle, joining it', async () => {
  const sb = await helper();
  const reading = hanging<{ agents: HerdrAgent[]; available: boolean }>();
  const { masterSessionStep } = await import('../src/daemon/cycle-master.js');
  const cfg = config(), state = emptyDaemonState(cfg);
  const fx = effects([], { herdr: reading.call as DaemonEffects['herdr'], masterSession: { launch: async () => { throw new Error('a launch is not reached while Herdr is unobserved'); } } } as unknown as Partial<DaemonEffects>);
  const step = (at: number) => returns(masterSessionStep({ config: cfg, state, effects: fx, now: () => at, clock: at, snapshot: { work: [], now: iso(0), jobs: [] }, performed: [], agents: [], launcher: { busy: () => false, keys: () => [] },
    isolate: async (_k: unknown, _i: unknown, _n: unknown, body: () => Promise<unknown>) => body() } as unknown as Parameters<typeof masterSessionStep>[0]));
  await step(clock);
  assert.ok(sb.carriedRow(state.actions['carried:master:herdr']), `carried on the step's row: ${JSON.stringify(Object.keys(state.actions))}`);
  assert.deepEqual(faults(state), []);
  await step(clock + 60_000);
  assert.equal(reading.calls.length, 1, 'joined, one reading');
  const source = readFileSync(`${root}src/daemon/cycle-master.ts`, 'utf8');
  assert.doesNotMatch(source, /await Promise\.resolve\(effects\.herdr/, 'no unbounded Herdr read remains in the step');
});

test('unit:step-calls-applied-once — a prompt is keyed by its intent: a wake for other subjects, or the resume instruction to a pane whose decline continuation is still carried, is another call and is sent, never the carried one\'s answer; a heartbeat\'s quiet minutes or a reminder\'s countdown do not make it another', async () => {
  const sb = await helper();
  const { masterWakeText } = await import('../src/master/master-session.js');
  const { resumePromptText, idlePromptText } = await import('../src/daemon/cycle-resume.js');
  const { continueAfterDecline } = await import('../src/master/runtime-prompt.js');
  const agent = { name: 'graphyard-master', pane_id: 'p1' } as HerdrAgent;
  const key = (text: string) => sb.callKey('promptSession', [agent, text]);
  assert.notEqual(key(masterWakeText('cli', ['GY-1'], false, 0)), key(masterWakeText('cli', ['GY-2'], false, 0)));
  assert.equal(key(masterWakeText('cli', [], true, 12)), key(masterWakeText('cli', [], true, 13)));
  const work = { key: 'GY-1', candidate: null };
  const continuation = continueAfterDecline('GY-1', { text: 'rm -rf build/*', answer: 'No' }, '/wt'), resume = resumePromptText('cli', work, 1, 'its blocker was cleared');
  assert.notEqual(key(continuation), key(resume), 'the continuation after a declined prompt and the resume instruction to the same pane are two calls');
  assert.notEqual(key(resume), key(idlePromptText('cli', work, 1, iso(-600_000), clock)));
  assert.equal(key(idlePromptText('cli', work, 1, iso(-600_000), clock)), key(idlePromptText('cli', work, 1, iso(-600_000), clock + 120_000)), 'the minutes a reminder counts down do not make it another');
  assert.equal(sb.promptIntent('since 2026-10-14T03:53:00.000Z for 12 minutes, 1 more minute'), 'since T for N minutes, N minutes');
  // Under the bound: the continuation carried past it and the resume instruction that follows to the same pane are two sends, and each retry joins its own.
  const slow = hangingEach<void>();
  const fx = sb.boundedCalls(effects([], { promptSession: slow.call as DaemonEffects['promptSession'] }), { cycle: 1 }, () => clock, () => 10_000, { step: 'sessions', calls: ['promptSession'] });
  await assert.rejects(fx.promptSession!(agent, continuation) as Promise<void>, sb.stepCallCarried);
  await assert.rejects(fx.promptSession!(agent, resume) as Promise<void>, sb.stepCallCarried);
  await assert.rejects(fx.promptSession!(agent, continuation) as Promise<void>, sb.stepCallCarried);
  assert.equal(slow.calls.length, 2, 'the resume instruction is sent; the retried continuation joins its own call');
  assert.deepEqual(slow.calls.map(call => call.args[1]), [continuation, resume]);
});

test('unit:step-calls-bounded — an effect object named in the bound (the merge writer, the acceptance role) is bounded method by method; a finished handle record waits for the running one of an item whose revision moved; a phase\'s nested effects wait at its gate', async () => {
  const { boundedCalls, boundedPhase, stepCallCarried } = await helper();
  const kept = {}, slow = new Promise<string>(() => {}), now = () => clock;
  let merges = 0;
  const effects = { stepCallBoundMs: 30, mergeWriter: { merger: () => { merges += 1; return slow; } }, recordSession: async () => undefined } as unknown as DaemonEffects;
  const bounded = boundedCalls(effects, kept, now, () => 1000, { step: 'scope', calls: ['mergeWriter', 'recordSession'] });
  // The merge-mode read of the scope step: a slow answer is carried, never held; the retry joins it.
  await assert.rejects(() => bounded.mergeWriter!.merger(), (error: unknown) => stepCallCarried(error));
  await assert.rejects(() => bounded.mergeWriter!.merger(), (error: unknown) => stepCallCarried(error));
  assert.equal(merges, 1);
  // A handle record's key names the item, not its revision.
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const recording = { stepCallBoundMs: 20, recordSession: async (_work: unknown, handle: { state: string }) => { order.push(`start:${handle.state}`); if (handle.state === 'running') await gate; order.push(`end:${handle.state}`); } } as unknown as DaemonEffects;
  const records = boundedCalls(recording, {}, now, () => 1000, { step: 'resume', calls: ['recordSession'] });
  const running = { id: 'w1', key: 'GY-1', epoch: 1, policyRevision: 1 }, advanced = { ...running, policyRevision: 2 };
  await assert.rejects(() => records.recordSession!(running as never, { id: 'h', state: 'running' } as never), (error: unknown) => stepCallCarried(error));
  await assert.rejects(() => records.recordSession!(advanced as never, { id: 'h', state: 'finished' } as never), (error: unknown) => stepCallCarried(error));
  assert.deepEqual(order, ['start:running']);
  release(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(order, ['start:running', 'end:running', 'start:finished', 'end:finished']);
  // A phase's acceptance goals() answered after its step returned starts no call behind it.
  let goals = 0;
  const phaseCycle = { state: { actions: {}, cycle: 1 }, now, performed: [], effects: { persist: async () => undefined, acceptance: { goals: async () => { goals += 1; } } } } as unknown as Cycle;
  let later!: () => Promise<void>, resumeFirst!: () => void;
  const first = new Promise<void>(resolve => { resumeFirst = resolve; });
  let left: number | null = 1000;
  await boundedPhase(phaseCycle, 'triage', 'acceptance', () => left, async phase => { await first; later = async () => { await phase.effects.acceptance!.goals!(); }; await later(); });
  left = null;
  resumeFirst(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(goals, 0);
});

test('unit:step-calls-bounded — a merge-mode read carried past its bound is recorded as a waiting attempt and keeps the known mode; a carried acceptance write is carried, never noted as a failure', async () => {
  const { boundedCalls, stepCallCarried, carriedRow } = await helper();
  const { controlPlaneMerger } = await import('../src/daemon/cycle-scope.js');
  const { acceptanceStep } = await import('../src/daemon/acceptance.js');
  const now = () => clock;
  let mode: Promise<string> = Promise.resolve('github');
  const raw = { stepCallBoundMs: 30, persist: async () => undefined, mergeWriter: { merger: () => mode } } as unknown as DaemonEffects;
  const state = { actions: {}, cycle: 1 } as unknown as DaemonState;
  const make = (effects: DaemonEffects) => ({ state, now, performed: [], effects: boundedCalls(effects, {}, now, () => 1000, { step: 'scope', calls: ['mergeWriter'] }) }) as unknown as Cycle;
  assert.equal(await controlPlaneMerger(make(raw)), false, 'a read that answers sets the known mode');
  mode = new Promise<string>(() => {});
  assert.equal(await controlPlaneMerger(make(raw)), false, 'a carried read keeps the known mode');
  const row = (state.actions as Record<string, DaemonAction>)['carried:scope:mergeWriter'];
  assert.ok(carriedRow(row), 'the carried read is recorded as a waiting attempt');
  // An acceptance write that is carried rethrows to the carried isolation, so the goal is recorded waiting and no failure note is written.
  const goal = { id: 'g1', key: 'GY-G1', stage: 'awaiting-approval', revision: 1 };
  const closing = { stepCallBoundMs: 30, persist: async () => undefined, acceptance: { settings: { enabled: true }, goals: async () => [{ ...goal, stage: 'acceptance-drafting', refusal: { pr: 9, reason: 'no', by: 'x' } }], close: () => new Promise<void>(() => {}) } } as unknown as DaemonEffects;
  const acceptanceState = { actions: {}, cycle: 1 } as unknown as DaemonState;
  const performed: DaemonAction[] = [];
  const cycle = { state: acceptanceState, now, clock, performed, config: {}, isolate: async (_kind: string, _item: unknown, _name: string, body: () => Promise<unknown>) => body(), effects: boundedCalls(closing, {}, now, () => 1000, { step: 'triage', calls: ['acceptance'] }) } as unknown as Cycle;
  await acceptanceStep(cycle);
  const rows = Object.values(acceptanceState.actions as Record<string, DaemonAction>);
  assert.equal(rows.filter(entry => entry.state === 'failed').length, 0, 'no failure is noted for a carried close');
  assert.ok(rows.some(entry => carriedRow(entry)), 'the carried close is recorded waiting');
  assert.ok(stepCallCarried('x') === false);
});

test('unit:step-calls-bounded — triage: the merge-writer ports under the acceptance role wait at the phase gate and under the bound: a merged read answered after the step returned starts no fetch, merge or push behind it, and the next cycle joins the phase, under whose budget the landing runs through', async () => {
  const { boundedCalls, boundedPhase, stepCallCarried, carriedRow } = await helper();
  const now = () => clock, order: string[] = [];
  let answerMerged!: (value: string | null) => void;
  const merged = new Promise<string | null>(resolve => { answerMerged = resolve; });
  const writer = { baseBranch: 'main', retrials: 2, merged: () => { order.push('merged'); return merged; }, fetch: async () => { order.push('fetch'); return 'tip'; }, merge: async () => { order.push('merge'); return 'sha'; }, push: async () => { order.push('push'); } };
  const state = { actions: {}, cycle: 1 } as unknown as DaemonState;
  const phaseCycle = { state, now, performed: [], effects: { persist: async () => undefined, acceptance: { settings: { enabled: true }, writer } } } as unknown as Cycle;
  const land = async (phase: Cycle) => { const ports = (phase.effects.acceptance as unknown as { writer: typeof writer }).writer; if (await ports.merged()) return; await ports.fetch(); await ports.merge(); await ports.push(); };
  let left: number | null = 30;
  await boundedPhase(phaseCycle, 'triage', 'acceptance', () => left, land);
  assert.ok(carriedRow((state.actions as Record<string, DaemonAction>)['carried:triage:acceptance']), 'the phase is carried past the bound');
  // The step has returned; the read answers now: the landing's ports wait at the gate, so nothing runs behind the step.
  left = null; answerMerged(null); await settle();
  assert.deepEqual(order, ['merged'], 'no fetch, merge or push starts behind the returned step');
  // The next cycle joins the phase: its gate opens and the landing runs through under that cycle's budget.
  (state as unknown as { cycle: number }).cycle = 2; left = 1000;
  await boundedPhase(phaseCycle, 'triage', 'acceptance', () => left, land);
  assert.deepEqual(order, ['merged', 'fetch', 'merge', 'push']);
  assert.equal((state.actions as Record<string, DaemonAction>)['carried:triage:acceptance']?.state, 'done', 'the carried phase ran through on its retry');
  // Named in a step's bound, the nested ports are bounded by their path like the role's own calls.
  const hanging = { stepCallBoundMs: 30, acceptance: { writer: { merged: () => new Promise<string | null>(() => {}) } } } as unknown as DaemonEffects;
  const bounded = boundedCalls(hanging, {}, now, () => 1000, { step: 'triage', calls: ['acceptance'] });
  await assert.rejects(() => bounded.acceptance!.writer!.merged('h'), (error: unknown) => stepCallCarried(error) && /acceptance\.writer\.merged call/.test(String(error)));
});
