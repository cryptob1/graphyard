import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Principal } from '../src/model.js';
import { applyGoalCommand, recordGoal, type Goal } from '../src/model/goal.js';
import { caseChangeGoalsPath, requestedCaseChanges } from '../src/model/goal-plan.js';
import { clearDrafts, type AcceptanceEffects } from '../src/daemon/acceptance.js';
import { caseChangeJudgementsSettled, caseChangeStep, clearCaseChangeJudgements } from '../src/daemon/case-change-judge.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';
// Time-bomb allowance (GY-1694): the 2026-10-14 daemon clock is handed to caseChangeStep as its clock; the goals are stamped with new Date() by recordGoal and applyGoalCommand, which the step never compares with it.

// GY-1805: a requested goal case change is routed to an independent approver by the loop (the one route, case-change-judge.ts, which acceptanceStep runs
// for every goal), its verdict applied as case-change-approve or case-change-refuse; master status lists the changes still owed a decision.
const master: Principal = { id: 'cc-master', role: 'coordinator', sessionKind: 'ai' };
const author: Principal = { id: 'cc-author', role: 'admin', sessionKind: 'ai' };
const approver: Principal = { id: 'cc-approver', role: 'admin', sessionKind: 'ai' };
const worker: Principal = { id: 'cc-worker', role: 'admin', sessionKind: 'ai' };

function protectedGoal(key: string): Goal {
  const at = new Date().toISOString();
  let goal = recordGoal({ statement: 'Customers can sign up', users: ['Customers'], constraints: [], deployTarget: 'uat then production' }, key, { actor: master, at });
  const outcomes = [{ id: 'signup', title: 'A customer can sign up', criteria: ['The signup page answers'], case: { id: 'signup-case', title: 'The signup outcome is reachable', description: 'A customer reads the page.', tags: ['api'], target: 'uat', required: true,
    steps: [{ kind: 'http', name: 'read the page', method: 'GET', path: '/api/board', status: 200, expect: [{ path: 'groups.backlog', type: 'array' }] }] } }];
  goal = applyGoalCommand(goal, 'draft', { outcomes, pr: 1, branch: 'graphyard/goal', head: 'a'.repeat(40) }, { actor: author, at });
  goal = applyGoalCommand(goal, 'approve', { reason: 'Right' }, { actor: approver, at });
  return applyGoalCommand(goal, 'merged', { pr: 1, mergeSha: 'b'.repeat(40) }, { actor: master, at });
}
const request = (goal: Goal) => applyGoalCommand(goal, 'case-change', { work: 'GY-1', cases: ['signup-case'], reason: 'The case saves its id as {"id":"id1"} but the runner reads variable -> path' }, { actor: worker, at: new Date().toISOString() });

function stubRunner(respond: () => unknown, prompts: string[], tools: string[], gate?: Promise<void>): Runner {
  return { name: 'stub', start<T>(prompt: string, options: RunOptions<T>) {
    prompts.push(prompt); tools.push(`${options.tool} ${options.env?.GRAPHYARD_PI_ROLE}`);
    return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async (): Promise<RunResult<T>> => {
      await gate;
      try { const parsed = options.validate(respond()); return { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] }; }
      catch (error) { return { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
    } };
  } };
}

/** The loop's case-change step over a mutable goal, the verdict applied to it as the approver identity. */
function harness(respond: (goal: string) => unknown, gate?: Promise<void>, stage?: Goal['stage']) {
  clearDrafts(); clearCaseChangeJudgements();
  const prompts: string[] = [], tools: string[] = [], notes: string[] = [], posted: string[] = [];
  let goal = request(protectedGoal('GOAL-9'));
  if (stage) goal = { ...goal, stage };
  let refusals = 0;
  const acceptance = { settings: diagnosticianSettings({}), cwd: process.cwd(), runner: async (_role: string, attempt: string) => ({ runner: stubRunner(() => respond(goal.key), prompts, tools, gate), runtime: 'stub', model: attempt }),
    judgeCaseChange: async (target: Goal, change: { id: string }, judgement: { verdict: 'approve' | 'refuse'; reason: string }) => {
      if (refusals-- > 0) throw new Error('control plane unavailable');
      posted.push(`${target.key} ${change.id} ${judgement.verdict}`);
      goal = applyGoalCommand(goal, judgement.verdict === 'approve' ? 'case-change-approve' : 'case-change-refuse', { change: change.id, reason: judgement.reason }, { actor: approver, at: new Date().toISOString(), implementers: [worker.id] });
      return goal;
    } } as unknown as AcceptanceEffects;
  let clock = Date.parse('2026-10-14T00:00:00Z');
  const step = async (advance = 6 * 60_000) => { clock += advance; await caseChangeStep({ config: { repository: 'owner/case-change' }, clock } as unknown as Cycle, acceptance, goal, async (_goal, outcome, detail) => { notes.push(`${outcome}: ${detail}`); }); await caseChangeJudgementsSettled(); };
  return { step, prompts, tools, notes, posted, failPosts: (count: number) => { refusals = count; }, get goal() { return goal; } };
}

test('unit:case-change-routed-to-approver — a requested case change is put to an approver run within one cycle and its verdict is applied as case-change-approve or case-change-refuse with the reason recorded', async () => {
  for (const verdict of ['approve', 'refuse'] as const) {
    const h = harness(key => ({ goal: key, verdict, reason: `Judged ${verdict}: the case saves its ids as the runner reads them` }));
    const change = h.goal.caseChanges[0];
    assert.equal(change.state, 'requested');
    await h.step(); // the cycle that finds it launches the approver
    assert.equal(h.prompts.length, 1, 'one approver run per requested change');
    assert.equal(h.tools[0], 'graphyard_acceptance_judgement acceptance-judge', 'the approver role judges it, never the operator agent');
    assert.match(h.prompts[0], /did not request it and did not implement GY-1/);
    assert.match(h.notes.at(-1)!, /Launched the approver's judgement of GY-1's case change/);
    await h.step(); // the verdict is applied by the next cycle
    const judged = h.goal.caseChanges[0];
    assert.equal(judged.state, verdict === 'approve' ? 'approved' : 'refused');
    assert.equal(judged.judgedBy, approver.id, 'judged by the approver identity, neither the requester nor an implementer');
    assert.match(judged.judgement!, new RegExp(`Judged ${verdict}`), 'the reason is recorded on the case change');
    assert.match(h.notes.at(-1)!, new RegExp(`The approver ${verdict === 'approve' ? 'approved' : 'refused'} GY-1's case change`));
    await h.step();
    assert.equal(h.prompts.length, 1, 'a judged change is never put to an approver again');
  }
});

test('unit:case-change-retry-and-status — an unanswered case change stays requested and is asked again, applied once; the pending changes are listed for master status', async () => {
  let answers = 0;
  const h = harness(key => { if (answers++ < 2) throw new Error('the approver never called the tool'); return { goal: key, verdict: 'approve', reason: 'The case is corrected, not weakened' }; });
  const change = h.goal.caseChanges[0];
  assert.deepEqual(requestedCaseChanges([h.goal]).map(entry => [entry.goal, entry.id, entry.work, entry.cases]), [['GOAL-9', change.id, 'GY-1', ['signup-case']]], 'a requested change is listed among the decisions owed');
  await h.step(); await h.step();
  assert.equal(h.goal.caseChanges[0].state, 'requested', 'no answer leaves it requested');
  assert.match(h.notes.at(-1)!, /returned no judgement/);
  await h.step(60 * 60_000); // the retry interval passes: asked again
  await h.step();
  assert.equal(h.goal.caseChanges[0].state, 'approved');
  assert.equal(h.posted.length, 1, 'the verdict is applied once');
  assert.deepEqual(requestedCaseChanges([h.goal]), [], 'a judged change is no longer owed');
});

test('unit:case-change-retry-and-status — a verdict the control plane could not record is posted again without another run', async () => {
  const h = harness(key => ({ goal: key, verdict: 'refuse', reason: 'The request weakens the case' }));
  h.failPosts(1);
  await h.step(); await h.step();
  assert.match(h.notes.at(-1)!, /could not be recorded: control plane unavailable/);
  assert.equal(h.goal.caseChanges[0].state, 'requested');
  await h.step(10 * 60_000);
  assert.equal(h.prompts.length, 1, 'the kept verdict is posted again; no second paid run');
  assert.equal(h.goal.caseChanges[0].state, 'refused');
  assert.equal(h.posted.length, 1);
});

test('unit:case-change-retry-and-status — a slow approver is waited on and never launched twice', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness(key => ({ goal: key, verdict: 'approve', reason: 'Corrected' }), gate);
  const first = h.step(); await new Promise(resolve => setImmediate(resolve));
  const caseChange = h.goal.caseChanges[0];
  assert.equal(caseChange.state, 'requested');
  release(); await first; await h.step(); await h.step();
  assert.equal(h.prompts.length, 1, 'one run, not a second per cycle');
  assert.equal(h.goal.caseChanges[0].state, 'approved');
  assert.equal(h.posted.length, 1);
});

test('unit:case-change-routed-to-approver — a change requested on a delivered goal is routed and listed too, from the goals path that keeps delivered goals', async () => {
  assert.equal(caseChangeGoalsPath, 'goals', 'not goals?open=1, which drops delivered goals');
  const h = harness(key => ({ goal: key, verdict: 'approve', reason: 'Corrected' }), undefined, 'delivered');
  assert.equal(h.goal.stage, 'delivered');
  assert.equal(requestedCaseChanges([h.goal]).length, 1, 'a delivered goal\'s requested change is listed');
  await h.step(); await h.step();
  assert.equal(h.goal.caseChanges[0].state, 'approved');
});
