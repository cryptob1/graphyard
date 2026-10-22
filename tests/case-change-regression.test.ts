import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentGoal, protectedCaseRefusals, type Goal } from '../src/model/goal.js';

// GY-1806 regression: GY-1800 blocked three times (seq 2590616, 2591382, 2591855) because its requested case change on
// GOAL-1 (candidate-batches-five) reached no approver. Since GY-2874 the master's case change is a grant applied at once;
// a change recorded before then counts only when it was approved, so a request left unjudged is no grant.
const modifies = { files: ['e2e/cases/candidate-batches-five.json'], scopeFiles: [{ path: 'e2e/cases/candidate-batches-five.json', status: 'modified' as const, baseSha: 'a'.repeat(40), sha: 'b'.repeat(40), additions: 1, deletions: 1, binary: false }], contractMoved: null };
const legacy = (state: string) => ({ id: 'change-gy-1800', work: 'GY-1800', cases: ['candidate-batches-five'], reason: 'the save entries read variable -> path', requestedBy: 'implementer', requestedAt: '2026-10-14T15:12:00Z',
  state, judgedBy: state === 'requested' ? null : 'approver', judgedAt: state === 'requested' ? null : '2026-10-14T15:20:00Z', judgement: null });
const goal = (caseChanges: unknown[]) => currentGoal({ id: 'id-GOAL-1', key: 'GOAL-1', stage: 'planning', revision: 1, caseChanges, protected: { cases: ['candidate-batches-five'], outcomes: ['small'] },
  acceptance: { outcomes: [{ id: 'small', case: { id: 'candidate-batches-five' } }] } } as unknown as Goal);

test('unit:gy-1800-case-change-reaches-approver — GY-1800 passes on a granted case change and is refused on an unjudged legacy request', () => {
  assert.equal(protectedCaseRefusals({ key: 'GY-1800' }, modifies, [goal([legacy('requested')])]).length, 1, 'an unjudged request is no grant');
  assert.equal(protectedCaseRefusals({ key: 'GY-1800' }, modifies, [goal([legacy('refused')])]).length, 1, 'a refused request is no grant');
  const approved = goal([legacy('approved')]);
  assert.deepEqual(approved.caseChanges[0], { id: 'change-gy-1800', work: 'GY-1800', cases: ['candidate-batches-five'], reason: 'the save entries read variable -> path', by: 'approver', at: '2026-10-14T15:20:00Z' });
  assert.deepEqual(protectedCaseRefusals({ key: 'GY-1800' }, modifies, [approved]), []);
  const granted = goal([{ id: 'change-gy-1800', work: 'GY-1800', cases: ['candidate-batches-five'], reason: 'the save entries read variable -> path', by: 'master', at: '2026-10-21T00:00:00Z' }]);
  assert.deepEqual(protectedCaseRefusals({ key: 'GY-1800' }, modifies, [granted]), [], 'the master\'s grant needs no human step');
});
