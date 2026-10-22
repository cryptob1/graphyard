import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { launchAppearanceMs } from '../src/daemon/effects.js';
import { idleLeaseMs } from '../src/daemon/cycle-resume.js';
import type { Observation, Work } from '../src/model.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { DaemonAction } from '../src/daemon/state.js';

/**
 * GY-1774: every loop step that calls a session or the control plane is bounded under one shared helper (GY-1766).
 * A call that does not answer within the bound returns the step, stays owed with its carried attempt recorded, and is
 * retried next cycle; the retry joins the call still in flight, so its effect is applied once; a call that answers in
 * time is applied exactly as before.
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

/** An item in review whose reviewer requested changes on its candidate (the rework step requests a rework); `quiet` is a bare build-stage item. */
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
    stage: 'review', revision: 5, policyRevision: 1, createdAt: iso(-3_600_000), updatedAt: iso(0),
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
    closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    persist: async () => {},
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
  assert.equal(sb.stepCallBoundMs, 10_000, 'and the 10 s per-call bound');
  assert.equal(sb.stepCallCarried('the decisions step\'s 10000 ms per-decision bound passed before x answered; the decision stays owed and is retried next cycle'), true, 'and the carried reading');
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
  // An answer within the bound is the effect's own answer, untouched.
  const base = effects([], { rework: async (work, reason) => ({ reworked: `${work.key}: ${reason}` }) });
  const quick = sb.boundedCalls(base, {}, () => clock, () => 10_000, { step: 'dispatch', calls: ['rework'] });
  assert.deepEqual(await quick.rework!(item('GY-1'), 'why'), { reworked: 'GY-1: why' });
  assert.equal(sb.unboundedEffects(quick), base, 'the effects beneath a bound are reachable for a launch that holds no cycle');
  const ended = sb.boundedCalls(effects([], { closeSession: slow.call as DaemonEffects['closeSession'] }), {}, () => clock, () => null, { step: 'master', calls: ['closeSession'] });
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
  await cycle(state, fx, clock + launchAppearanceMs + 2_000);
  assert.equal(slow.calls.length, 1, 'the next cycle joined the close still in flight');
  const never = hanging();
  const unread = effects([], { panes: never.call as DaemonEffects['panes'] } as Partial<DaemonEffects>);
  await cycle(emptyDaemonState(config()), unread, clock);
  assert.equal(never.calls.length, 1, 'an inventory read that does not answer returns the step; the sweep waits for the next read');
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
  await cycle(state, fx, clock + idleLeaseMs + 120_000, cfg);
  assert.equal(slow.calls.length, 1, `the next cycle re-sent the prompt (${key}) and joined the one in flight`);
});

test('unit:step-calls-bounded — rework: a rework write that does not answer returns the step, is recorded carried with no failed action, and the next cycle joins it rather than sending another', async () => {
  const sb = await helper();
  const slow = hanging(), work = item('GY-6');
  const fx = effects([work], { rework: slow.call as DaemonEffects['rework'] });
  const state = emptyDaemonState(config());
  await cycle(state, fx);
  assert.equal(slow.calls.length, 1, 'the rework was sent');
  const carried = carriedRows(state, sb).find(([key]) => key === `carried:judgement:${work.id}`)?.[1];
  assert.match(carried?.detail ?? '', /the rework step's 30 ms per-call bound passed before GY-6's rework call answered/, JSON.stringify(state.actions));
  assert.ok(!Object.keys(state.actions).some(key => key.startsWith(`rework:${work.id}:`)), 'a carried write records no failed rework');
  await cycle(state, fx, clock + 60_000);
  assert.equal(slow.calls.length, 1, 'the next cycle joined the rework in flight');
  slow.answer({});
});

test('unit:step-calls-bounded — every named step runs under the shared bound with the calls the item names', async () => {
  const sb = await helper();
  const steps: Record<string, { file: string; calls: string[] }> = {
    dispatch: { file: 'cycle-dispatch.ts', calls: ['agents', 'roleHealth', 'reportCapacity', 'planeHealth'] },
    sessions: { file: 'cycle-sessions.ts', calls: ['closeSession', 'endSession', 'relaunch', 'answerSession', 'promptSession', 'launchedSessions', 'sessionOutput', 'herdr', 'recordSession', 'reportCapacity', 'holdAccount', 'selectedAccount', 'preserveWork'] },
    resume: { file: 'cycle-resume.ts', calls: ['promptSession', 'closeSession', 'recordSession', 'preserveWork', 'reportCapacity'] },
    reclaim: { file: 'cycle-reclaim.ts', calls: ['panes', 'closeSession', 'reclaimLease', 'removeWorktree', 'preserveWork', 'reportCapacity'] },
    master: { file: 'cycle-master.ts', calls: ['promptSession', 'herdr', 'sessionOutput', 'endRegistrySession', 'holdAccount', 'closeSession'] },
    rework: { file: 'rework.ts', calls: ['rework', 'recordMechanicalPlan'] },
  };
  for (const [step, { file, calls }] of Object.entries(steps)) {
    const source = readFileSync(`${root}src/daemon/${file}`, 'utf8');
    assert.match(source, new RegExp(`withinStepBudget\\(cycle, '${step}', \\[${calls.map(call => `'${call}'`).join(', ')}\\]`), `${file} runs the ${step} step under the shared bound with its calls`);
  }
  // The preservation an ended attempt makes (sessions, resume, reclaim) carries like any other call: no failed preserve, no fault.
  assert.match(readFileSync(`${root}src/daemon/preserve.ts`, 'utf8'), /if \(stepCallCarried\(error\)\) \{ await recordCarried\(/);
});

// --- the review's findings on b396b7b3, each pinned (GY-1774 rework) -----------------------------------------------

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
  await sb.withinStepBudget(stepCycle(state), 'master', ['promptSession'], async () => {});
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

test('unit:step-calls-bounded — an effect object named in the bound (the merge writer) is bounded method by method; a finished handle record waits for the running one of an item whose revision moved', async () => {
  const { boundedCalls, stepCallCarried } = await helper();
  const kept = {}, slow = new Promise<string>(() => {}), now = () => clock;
  let merges = 0;
  const effects = { stepCallBoundMs: 30, mergeWriter: { merger: () => { merges += 1; return slow; } }, recordSession: async () => undefined } as unknown as DaemonEffects;
  const bounded = boundedCalls(effects, kept, now, () => 1000, { step: 'master', calls: ['mergeWriter', 'recordSession'] });
  // The merge-mode read: a slow answer is carried, never held; the retry joins it.
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
});
