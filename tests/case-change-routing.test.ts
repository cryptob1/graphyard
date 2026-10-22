import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Principal } from '../src/model.js';
import { applyGoalCommand, protectedCaseRefusals, recordGoal, type Goal } from '../src/model/goal.js';

// GY-1805, GY-2874: a goal case change is the master's grant, applied at once: no approver judges it. A granted change lets the
// item it names modify the case; any other item, or any case it does not name, is still refused.
const master: Principal = { id: 'cc-master', role: 'coordinator', sessionKind: 'ai' };

function protectedGoal(key: string): Goal {
  const at = new Date().toISOString();
  let goal = recordGoal({ statement: 'Customers can sign up', users: ['Customers'], constraints: [], deployTarget: 'uat then production' }, key, { actor: master, at });
  const outcomes = [{ id: 'signup', title: 'A customer can sign up', criteria: ['The signup page answers'], case: { id: 'signup-case', title: 'The signup outcome is reachable', description: 'A customer reads the page.', tags: ['api'], target: 'uat', required: true,
    steps: [{ kind: 'http', name: 'read the page', method: 'GET', path: '/api/board', status: 200, expect: [{ path: 'groups.backlog', type: 'array' }] }] } }];
  goal = applyGoalCommand(goal, 'draft', { outcomes, pr: 1, branch: 'graphyard/goal', head: 'a'.repeat(40) }, { actor: master, at });
  return applyGoalCommand(goal, 'merged', { pr: 1, mergeSha: 'b'.repeat(40) }, { actor: master, at });
}
const grant = (goal: Goal, cases = ['signup-case']) => applyGoalCommand(goal, 'case-change', { work: 'GY-1', cases, reason: 'The case saves its id as {"id":"id1"} but the runner reads variable -> path' }, { actor: master, at: new Date().toISOString() });
const modifies = { files: ['e2e/cases/signup-case.json'], scopeFiles: [{ path: 'e2e/cases/signup-case.json', status: 'modified' as const, baseSha: 'c'.repeat(40), sha: 'd'.repeat(40), additions: 1, deletions: 1, binary: false }], contractMoved: null };

test('unit:case-change-granted-at-once — a case change is recorded as the master\'s grant and lets the item it names modify the case', () => {
  const goal = protectedGoal('GOAL-9');
  const [refused] = protectedCaseRefusals({ key: 'GY-1' }, modifies, [goal]);
  assert.match(refused, /modifies required case signup-case \(outcome signup of GOAL-9\); only the master grants a change to it \(graphyard goal case-change GOAL-9 GY-1 CASE -- REASON\)/);
  const granted = grant(goal);
  const change = granted.caseChanges[0];
  assert.deepEqual([change.work, change.cases, change.by], ['GY-1', ['signup-case'], master.id], 'the grant is recorded with who granted it');
  assert.deepEqual(Object.keys(change).sort(), ['at', 'by', 'cases', 'id', 'reason', 'work'], 'no requested or judged state');
  assert.deepEqual(protectedCaseRefusals({ key: 'GY-1' }, modifies, [granted]), [], 'the granted item passes with no further step');
  assert.equal(protectedCaseRefusals({ key: 'GY-2' }, modifies, [granted]).length, 1, 'a grant covers only the item it names');
});

test('unit:case-change-granted-at-once — a case change names only cases the goal protects, and only once its acceptance has merged', () => {
  const goal = protectedGoal('GOAL-9');
  assert.throws(() => grant(goal, ['board']), /GOAL-9 does not protect board; it protects signup-case/);
  const drafting = recordGoal({ statement: 'Customers can sign up', users: ['Customers'], constraints: [], deployTarget: 'uat then production' }, 'GOAL-10', { actor: master, at: new Date().toISOString() });
  assert.throws(() => grant(drafting), /GOAL-10 protects no case yet/);
  const delivered = grant({ ...goal, stage: 'delivered' });
  assert.equal(delivered.caseChanges.length, 1, 'a delivered goal still takes a grant');
  assert.deepEqual(protectedCaseRefusals({ key: 'GY-1' }, modifies, [delivered]), []);
});
