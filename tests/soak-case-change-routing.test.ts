import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Principal } from '../src/model.js';
import { applyGoalCommand, recordGoal, type Goal } from '../src/model/goal.js';
import { requestedCaseChanges, type CaseChangeRequest } from '../src/model/goal-plan.js';
import { caseChangesSettled, clearCaseChanges, type CaseChangeJudgement } from '../src/daemon/case-change-routing.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import type { InvariantCheck } from '../src/model/invariants.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';

// GY-1805: the loop reads the requested case changes every cycle and launches an approver run per change. Over a simulated day on the real loop
// (runCycle, so the system invariants of docs/master-agent.md#system-invariants are judged after every cycle) a change judged at once, one the
// approver does not answer for a while, and one whose verdict the control plane cannot record for a while each end judged exactly once: runs and
// posts stay bounded, none is in flight at the end, and a delivered goal's change is routed like any other.
// Proof: unit:case-change-soak.
const minute = 60_000, hour = 60 * minute;
const master: Principal = { id: 'soak-master', role: 'coordinator', sessionKind: 'ai' };
const author: Principal = { id: 'soak-author', role: 'admin', sessionKind: 'ai' };
const approver: Principal = { id: 'soak-approver', role: 'admin', sessionKind: 'ai' };
const worker: Principal = { id: 'soak-worker', role: 'admin', sessionKind: 'ai' };
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard', repository: 'owner/case-change-soak', baseBranch: 'main',
  githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-soak', autoMerge: true, mergeMethod: 'merge', workers: [] });

// Time-bomb allowance (GY-1694): the 2026-10-14 simulated clock is installed by mock.timers before requestedGoal is called, so the new Date() it stamps sits on that clock.
function requestedGoal(key: string, stage: Goal['stage']): Goal {
  const at = new Date().toISOString();
  let goal = recordGoal({ statement: 'Customers can sign up', users: ['Customers'], constraints: [], deployTarget: 'uat then production' }, key, { actor: master, at });
  const outcomes = [{ id: 'signup', title: 'A customer can sign up', criteria: ['The signup page answers'], case: { id: `${key.toLowerCase()}-case`, title: 'The signup outcome is reachable', description: 'A customer reads the page.', tags: ['api'], target: 'uat', required: true,
    steps: [{ kind: 'http', name: 'read the page', method: 'GET', path: '/api/board', status: 200, expect: [{ path: 'groups.backlog', type: 'array' }] }] } }];
  goal = applyGoalCommand(goal, 'draft', { outcomes, pr: 1, branch: 'graphyard/goal', head: 'a'.repeat(40) }, { actor: author, at });
  goal = applyGoalCommand(goal, 'approve', { reason: 'Right' }, { actor: approver, at });
  goal = applyGoalCommand(goal, 'merged', { pr: 1, mergeSha: 'b'.repeat(40) }, { actor: master, at });
  goal = applyGoalCommand(goal, 'case-change', { work: 'GY-1', cases: [`${key.toLowerCase()}-case`], reason: 'The case saves its id in a form the runner does not read' }, { actor: worker, at });
  return { ...goal, stage };
}

test('unit:case-change-soak — over a simulated day the loop routes requested, unanswered and unrecorded case changes to an approver with bounded runs and posts, no lingering run, and every system invariant holding', { timeout: 120_000 }, async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-14T00:00:00.000Z') });
  try {
    clearCaseChanges();
    const start = Date.now();
    const goals = new Map<string, Goal>([['GOAL-1', requestedGoal('GOAL-1', 'delivering')], ['GOAL-2', requestedGoal('GOAL-2', 'delivered')], ['GOAL-3', requestedGoal('GOAL-3', 'planned')]]);
    const runs = new Map<string, number>(), posts = new Map<string, number>(); let running = 0, maxRunning = 0, now = start;
    const silentUntil = start + 3 * hour, refusedUntil = start + 6 * hour; // GOAL-2's approver answers nothing until +3h; GOAL-3's verdict cannot be recorded until +6h
    const runner = (key: string): Runner => ({ name: 'stub', start<T>(_prompt: string, options: RunOptions<T>) {
      runs.set(key, (runs.get(key) ?? 0) + 1); running++; maxRunning = Math.max(maxRunning, running);
      return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async (): Promise<RunResult<T>> => {
        try {
          if (key === 'GOAL-2' && now < silentUntil) throw new Error('the approver never called the tool');
          const parsed = options.validate({ goal: key, verdict: 'approve', reason: 'The case is corrected, not weakened' });
          return { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] };
        } catch (error) { return { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
        finally { running--; }
      } };
    } });
    const acceptance = { goals: async () => [], settings: diagnosticianSettings({}), cwd: process.cwd(), runner: async (_role: string, attempt: string, goal: { key: string }) => ({ runner: runner(goal.key), runtime: 'stub', model: attempt }) } as unknown as DaemonEffects['acceptance'];
    const loop: DaemonEffects = {
      agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: new Date().toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, requestSmoke: () => {}, persist: async () => {},
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {},
      acceptance,
      caseChanges: async () => requestedCaseChanges([...goals.values()]),
      judgeCaseChange: async (change: CaseChangeRequest, judgement: CaseChangeJudgement) => {
        if (change.goal === 'GOAL-3' && now < refusedUntil) throw new Error('control plane unavailable');
        posts.set(change.goal, (posts.get(change.goal) ?? 0) + 1);
        goals.set(change.goal, applyGoalCommand(goals.get(change.goal)!, judgement.verdict === 'approve' ? 'case-change-approve' : 'case-change-refuse', { change: change.id, reason: judgement.reason }, { actor: approver, at: new Date().toISOString(), implementers: [worker.id] }));
      },
    };
    const state = emptyDaemonState(config), violations: string[] = [], faults: string[] = [];
    let cycles = 0;
    for (; now < start + 12 * hour; now += 2 * minute, cycles++) {
      mock.timers.setTime(now);
      const result = await runCycle(config, state, loop, () => Date.now());
      await caseChangesSettled();
      faults.push(...result.actions.filter(action => action.state === 'failed' && !/case change/.test(action.detail) && !/^Deployment SHA is unverified/.test(action.detail)).map(action => action.detail));
      for (const check of state.invariants.report as InvariantCheck[]) if (!check.holds) violations.push(`${new Date(now).toISOString()} ${check.line}`);
    }
    assert.ok(cycles >= 300, 'the loop ran half a simulated day');
    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
    assert.deepEqual(faults, [], 'no other action failed');
    assert.deepEqual([...goals.values()].map(goal => [goal.key, goal.caseChanges.map(change => change.state)]), [['GOAL-1', ['approved']], ['GOAL-2', ['approved']], ['GOAL-3', ['approved']]], 'every change, a delivered goal\'s included, ends judged');
    assert.equal(runs.get('GOAL-1'), 1, 'an answered change is put to one run');
    assert.ok(runs.get('GOAL-2')! >= 2 && runs.get('GOAL-2')! <= 2 * Math.ceil(3 * hour / (2 * minute)) + 2, `an unanswered change is asked again, within a bound: ${runs.get('GOAL-2')}`);
    assert.equal(runs.get('GOAL-3'), 1, 'a verdict the control plane could not record is posted again without another run');
    assert.deepEqual([...posts.keys()].sort(), ['GOAL-1', 'GOAL-2', 'GOAL-3'], 'every change was posted');
    for (const [goal, count] of posts) assert.equal(count, 1, `${goal}'s verdict is posted once`);
    assert.equal(running, 0, 'no approver run is left in flight');
    assert.ok(maxRunning <= goals.size, `runs in flight stay bounded by the changes owed: ${maxRunning}`);
  } finally { mock.timers.reset(); clearCaseChanges(); }
});
