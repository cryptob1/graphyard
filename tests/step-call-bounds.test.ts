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
  assert.equal(decisionBudgetMs, sb.stepBudgetMs, 'the decisions step shares it');
  assert.equal(decisionCallBoundMs, 10_000, 'and the 10 s per-call bound');
  assert.equal(decisionCallCarried, sb.stepCallCarried, 'and the carried reading');
});

test('unit:step-calls-applied-once — a retried call joins the one in flight under the same key, a changed argument makes its own call, and an answer within the bound is applied as before', async () => {
  const sb = await helper();
  const kept = {}, slow = hanging<{ profile: string }>();
  const fx = sb.boundedCalls(effects([], { promptSession: slow.call as DaemonEffects['promptSession'] }), kept, () => clock, () => 10_000, { step: 'resume', calls: ['promptSession'] });
  const agent = { name: 'graphyard-claude-a', pane_id: 'pane-1' } as HerdrAgent;
  await assert.rejects(fx.promptSession!(agent, 'resume GY-1 (first wording)') as Promise<void>, sb.stepCallCarried);
  await assert.rejects(fx.promptSession!(agent, 'resume GY-1 (re-worded a cycle later)') as Promise<void>, sb.stepCallCarried);
  assert.equal(slow.calls.length, 1, 'the retry joined the prompt still in flight: free text is no part of the key');
  await assert.rejects(fx.promptSession!({ ...agent, pane_id: 'pane-2' } as HerdrAgent, 'resume GY-1') as Promise<void>, sb.stepCallCarried);
  assert.equal(slow.calls.length, 2, 'another pane is another call');
  slow.answer({ profile: 'x' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await fx.promptSession!(agent, 'resume GY-1');
  assert.equal(slow.calls.length, 3, 'once the call settled, the next is a fresh call');
  // An answer within the bound is the effect's own answer, untouched.
  const base = effects([], { decide: async (_work, action) => ({ id: `decided-${action}` }) });
  const quick = sb.boundedCalls(base, {}, () => clock, () => 10_000, { step: 'dispatch', calls: ['decide'] });
  assert.deepEqual(await quick.decide!(item('GY-1'), 'rework', 'why'), { id: 'decided-rework' });
  assert.equal(sb.unboundedEffects(quick), base, 'the effects beneath a bound are reachable for a launch that holds no cycle');
  const ended = sb.boundedCalls(effects([], { closeSession: slow.call as DaemonEffects['closeSession'] }), {}, () => clock, () => null, { step: 'triage', calls: ['closeSession'] });
  const pass = ended.closeSession('pane-3') as Promise<void>;
  assert.equal(slow.calls.length, 4);
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
  assert.equal(state.actions[key!].attempts, 2, 'each carried attempt is recorded');
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
    blockers: { file: 'cycle-blockers.ts', calls: ['approver', 'closeSession'] },
    dispatch: { file: 'cycle-dispatch.ts', calls: ['decide', 'approver'] },
    'review-cap': { file: 'cycle-review-cap.ts', calls: ['withdrawReview', 'wakeObservation'] },
    scope: { file: 'cycle-scope.ts', calls: ['decideScope', 'widenScope'] },
    sessions: { file: 'cycle-sessions.ts', calls: ['closeSession', 'endSession', 'relaunch', 'answerSession', 'promptSession', 'launchedSessions'] },
    resume: { file: 'cycle-resume.ts', calls: ['promptSession', 'closeSession'] },
    reclaim: { file: 'cycle-reclaim.ts', calls: ['panes', 'closeSession'] },
    triage: { file: 'cycle-triage.ts', calls: ['recordTriage'] },
  };
  for (const [step, { file, calls }] of Object.entries(steps)) {
    const source = readFileSync(`${root}src/daemon/${file}`, 'utf8');
    assert.match(source, new RegExp(`withinStepBudget\\(cycle, '${step}', \\[${calls.map(call => `'${call}'`).join(', ')}\\]`), `${file} runs the ${step} step under the shared bound with its calls`);
  }
  const decisions = readFileSync(`${root}src/daemon/cycle-decisions.ts`, 'utf8');
  assert.match(decisions, /boundedDecisions\(boundedCalls\(await decisionReads\(.*\), cycle\.heldDecisions, now, \(\) => budgetLeft\(\), \{ step: 'approvers', calls: approverCalls \}\)/, 'the approvers step\'s calls are bounded within the decisions step');
  assert.match(decisions, /const approverCalls: readonly \(keyof DaemonEffects\)\[\] = \['approver', 'endRegistrySession', 'resume', 'withdraw', 'closeSession'\]/);
  // Triage: the record is bounded while the step runs; a run settling after it holds no cycle and passes through.
  const recorded = hanging();
  const cfg = config(), state = emptyDaemonState(cfg);
  const seen: (number | null)[] = [];
  const stepCycle = { config: cfg, state, now: () => clock, effects: effects([], { recordTriage: recorded.call as DaemonEffects['recordTriage'] } as Partial<DaemonEffects>), isolate: async (_kind: unknown, _item: unknown, _name: unknown, body: () => Promise<unknown>) => body() } as unknown as Parameters<Helper['withinStepBudget']>[0];
  let later!: DaemonEffects;
  await sb.withinStepBudget(stepCycle, 'triage', ['recordTriage'], async bounded => {
    later = bounded.effects;
    const started = performance.now();
    await assert.rejects(bounded.effects.recordTriage!(quiet('GY-8'), { judgement: { kind: 'close', reason: 'covered' } } as never) as Promise<unknown>, /the triage step's 30 ms per-call bound passed before GY-8's recordTriage call answered/);
    seen.push(Math.round(performance.now() - started));
  });
  assert.ok(seen[0]! < 2_000, 'within the step the record is bounded');
  const after = later.recordTriage!(quiet('GY-8'), { judgement: { kind: 'close', reason: 'covered' } } as never) as Promise<unknown>;
  assert.equal(recorded.calls.length, 2, 'after the step ended the record is sent again, unbounded (no call in flight is joined since the bound no longer keys it)');
  recorded.answer(undefined);
  await after;
});
