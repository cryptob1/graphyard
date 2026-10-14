import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Principal } from '../src/model.js';
import { applyGoalCommand, recordGoal, type Goal } from '../src/model/goal.js';
import { caseChangeGoalsPath, requestedCaseChanges, type CaseChangeRequest } from '../src/model/goal-plan.js';
import { RefusedResponse } from '../src/model/refusal.js';
import type { AcceptanceEffects } from '../src/daemon/acceptance.js';
import { caseChangeStep, caseChangesSettled, clearCaseChanges, type CaseChangeJudgement } from '../src/daemon/case-change-routing.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';
// Time-bomb allowance (GY-1694): the 2026-10-14 daemon clock is handed to caseChangeStep as its now; the goals are stamped with new Date() by recordGoal and applyGoalCommand, which the step never compares with it.

// GY-1805: a requested goal case change is put to an independent approver by the loop and its verdict applied, instead of waiting for a hand command.
const master: Principal = { id: 'cc-master', role: 'coordinator', sessionKind: 'ai' };
const author: Principal = { id: 'cc-author', role: 'admin', sessionKind: 'ai' };
const approver: Principal = { id: 'cc-approver', role: 'admin', sessionKind: 'ai' };
const worker: Principal = { id: 'cc-worker', role: 'admin', sessionKind: 'ai' };
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard', repository: 'owner/case-change', baseBranch: 'main',
  githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-cc', autoMerge: true, mergeMethod: 'merge', workers: [] });

function protectedGoal(key: string): Goal {
  const at = new Date().toISOString();
  let goal = recordGoal({ statement: 'Customers can sign up', users: ['Customers'], constraints: [], deployTarget: 'uat then production' }, key, { actor: master, at });
  const id = 'signup', outcomes = [{ id, title: 'A customer can sign up', criteria: ['The signup page answers'], case: { id: 'signup-case', title: 'The signup outcome is reachable', description: 'A customer reads the page.', tags: ['api'], target: 'uat', required: true,
    steps: [{ kind: 'http', name: 'read the page', method: 'GET', path: '/api/board', status: 200, expect: [{ path: 'groups.backlog', type: 'array' }] }] } }];
  goal = applyGoalCommand(goal, 'draft', { outcomes, pr: 1, branch: 'graphyard/goal', head: 'a'.repeat(40) }, { actor: author, at });
  goal = applyGoalCommand(goal, 'approve', { reason: 'Right' }, { actor: approver, at });
  return applyGoalCommand(goal, 'merged', { pr: 1, mergeSha: 'b'.repeat(40) }, { actor: master, at });
}
const request = (goal: Goal) => applyGoalCommand(goal, 'case-change', { work: 'GY-1', cases: ['signup-case'], reason: 'The case saves its id as {"id":"id1"} but the runner reads variable -> path' }, { actor: worker, at: new Date().toISOString() });

function stubRunner(respond: () => unknown, prompts: string[], tools: string[], gate?: Promise<void>): Runner {
  return {
    name: 'stub',
    start<T>(prompt: string, options: RunOptions<T>) {
      prompts.push(prompt); tools.push(`${options.tool} ${options.env?.GRAPHYARD_PI_ROLE}`);
      return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async (): Promise<RunResult<T>> => {
        await gate;
        try { const parsed = options.validate(respond()); return { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] }; }
        catch (error) { return { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
      } };
    },
  };
}

/** The loop's case-change step over a mutable goal, with the approver's runs and posts recorded. */
function harness(respond: (goal: string) => unknown, post?: (change: CaseChangeRequest, judgement: CaseChangeJudgement) => Promise<unknown>, gate?: Promise<void>, stage?: Goal['stage']) {
  const prompts: string[] = [], tools: string[] = [], posted: { change: CaseChangeRequest; judgement: CaseChangeJudgement }[] = [];
  let goal = request(protectedGoal('GOAL-9'));
  if (stage) goal = { ...goal, stage };
  const acceptance = { settings: diagnosticianSettings({}), cwd: process.cwd(), runner: async (_role: string, attempt: string) => ({ runner: stubRunner(() => respond(goal.key), prompts, tools, gate), runtime: 'stub', model: attempt }) } as unknown as AcceptanceEffects;
  const state = emptyDaemonState(config), performed: unknown[] = [];
  let clock = Date.parse('2026-10-14T00:00:00Z');
  const effects = { acceptance, persist: async () => {}, caseChanges: async () => requestedCaseChanges([goal]),
    judgeCaseChange: async (change: CaseChangeRequest, judgement: CaseChangeJudgement) => {
      if (post) await post(change, judgement);
      posted.push({ change, judgement });
      goal = applyGoalCommand(goal, judgement.verdict === 'approve' ? 'case-change-approve' : 'case-change-refuse', { change: change.id, reason: judgement.reason }, { actor: approver, at: new Date().toISOString(), implementers: [worker.id] });
    } };
  const step = async (advance = 20_000) => {
    clock += advance;
    await caseChangeStep({ config, state, effects, now: () => clock, clock, snapshot: { work: [] }, performed, isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() } as unknown as Cycle);
  };
  return { step, prompts, tools, posted, state, get goal() { return goal; }, settle: caseChangesSettled };
}

test('unit:case-change-routed-to-approver — a requested case change is put to an approver run within one cycle and its verdict is applied as case-change-approve or case-change-refuse with the reason recorded', async () => {
  for (const verdict of ['approve', 'refuse'] as const) {
    clearCaseChanges();
    const h = harness(key => ({ goal: key, verdict, reason: `Judged ${verdict}: the case saves its ids as the runner reads them` }));
    const change = h.goal.caseChanges[0];
    assert.equal(change.state, 'requested');
    await h.step(); // the cycle that finds it launches the approver
    assert.equal(h.prompts.length, 1, 'one approver run per requested change');
    assert.equal(h.tools[0], 'graphyard_acceptance_judgement acceptance-judge', 'the approver role judges it, never the operator agent');
    assert.match(h.prompts[0], new RegExp(change.id));
    assert.match(h.prompts[0], /did not request it and you did not implement GY-1/);
    assert.match(h.state.actions[`case-change:${change.id}`].detail, /Launched an independent approver for GOAL-9's case change/);
    await h.settle(); await h.step(); // the verdict is applied by the next cycle
    assert.equal(h.posted.length, 1);
    const judged = h.goal.caseChanges[0];
    assert.equal(judged.state, verdict === 'approve' ? 'approved' : 'refused');
    assert.equal(judged.judgedBy, approver.id, 'judged by the approver identity, neither the requester nor an implementer');
    assert.match(judged.judgement!, new RegExp(`Judged ${verdict}`), 'the reason is recorded on the case change');
    assert.match(h.state.actions[`case-change:${change.id}`].detail, new RegExp(`The approver ${verdict === 'approve' ? 'approved' : 'refused'} GOAL-9's case change`));
    await h.step(); await h.settle();
    assert.equal(h.prompts.length, 1, 'a judged change is never put to an approver again');
  }
});

test('unit:case-change-retry-and-status — an unanswered case change stays requested and is asked again next cycle, applied once; the pending changes are listed for master status', async () => {
  clearCaseChanges();
  let answers = 0;
  const h = harness(key => { if (answers++ < 2) throw new Error('the approver never called the tool'); return { goal: key, verdict: 'approve', reason: 'The case is corrected, not weakened' }; });
  const change = h.goal.caseChanges[0];
  assert.deepEqual(requestedCaseChanges([h.goal]).map(entry => [entry.goal, entry.id, entry.work, entry.cases]), [['GOAL-9', change.id, 'GY-1', ['signup-case']]], 'a requested change is listed among the decisions owed');
  await h.step(); await h.settle(); await h.step();
  assert.equal(h.goal.caseChanges[0].state, 'requested', 'no answer leaves it requested');
  assert.match(h.state.actions[`case-change:${change.id}`].detail, /returned no judgement.*stays requested and is put to an approver again next cycle/);
  await h.step(); await h.settle();
  assert.equal(h.prompts.length, 3, 'the next cycle asks again (the first cycle ran the primary and the fallback)');
  await h.step();
  assert.equal(h.goal.caseChanges[0].state, 'approved');
  assert.equal(h.posted.length, 1, 'the verdict is applied once');
  assert.deepEqual(requestedCaseChanges([h.goal]), [], 'a judged change is no longer owed');
});

test('unit:case-change-retry-and-status — a verdict the control plane could not record is posted again without another run, and one already judged is not posted twice', async () => {
  clearCaseChanges();
  let refusals = 1;
  const h = harness(key => ({ goal: key, verdict: 'refuse', reason: 'The request weakens the case' }), async () => { if (refusals-- > 0) throw new Error('control plane unavailable'); });
  const change = h.goal.caseChanges[0];
  await h.step(); await h.settle(); await h.step();
  assert.match(h.state.actions[`case-change:${change.id}`].detail, /could not be recorded: control plane unavailable; it is posted again next cycle/);
  assert.equal(h.goal.caseChanges[0].state, 'requested');
  await h.step();
  assert.equal(h.prompts.length, 1, 'the kept verdict is posted again; no second paid run');
  assert.equal(h.goal.caseChanges[0].state, 'refused');
  assert.equal(h.posted.length, 1);
  clearCaseChanges();
  const taken = harness(key => ({ goal: key, verdict: 'approve', reason: 'Fine' }), async () => { throw new RefusedResponse('Graphyard refused (409): already approved', 409, {}); });
  await taken.step(); await taken.settle(); await taken.step();
  assert.match(taken.state.actions[`case-change:${taken.goal.caseChanges[0].id}`].detail, /was already judged; nothing is posted again/);
});

test('unit:case-change-retry-and-status — a slow approver is waited on, never launched twice, and does not hold the cycle', async () => {
  clearCaseChanges();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness(key => ({ goal: key, verdict: 'approve', reason: 'Corrected' }), undefined, gate);
  await h.step(); await h.step(); await h.step();
  assert.equal(h.prompts.length, 1, 'one run in flight, not a second per cycle');
  assert.equal(h.goal.caseChanges[0].state, 'requested');
  release(); await h.settle(); await h.step();
  assert.equal(h.goal.caseChanges[0].state, 'approved');
  assert.equal(h.posted.length, 1);
});

test('unit:case-change-routed-to-approver — a change requested on a delivered goal is routed too, and the goals path it is read from keeps delivered goals', async () => {
  clearCaseChanges();
  assert.equal(caseChangeGoalsPath, 'goals', 'not goals?open=1, which drops delivered goals');
  const h = harness(key => ({ goal: key, verdict: 'approve', reason: 'Corrected' }), undefined, undefined, 'delivered');
  assert.equal(h.goal.stage, 'delivered');
  assert.equal(requestedCaseChanges([h.goal]).length, 1, 'a delivered goal\'s requested change is listed');
  await h.step(); await h.settle(); await h.step();
  assert.equal(h.goal.caseChanges[0].state, 'approved');
});
