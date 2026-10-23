import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { actionIdleMs, idleActionable, queueSnapshot, reconcileActions } from '../src/model/actions.js';
import { actionJudgment, executorRunnableKinds, humanNeeded, humanNeededActions, nextAction } from '../src/model/next-action.js';
// Time-bomb allowance (GY-1694): 2026-09-21 `at` is the fixed now handed to nextAction.

/**
 * GY-104: an item stops only for a judgement it actually needs. The test here is named for the
 * proof it produces: unit:human-needed-actions-visible.
 */

const rows = (work: Work) => work.actionQueue?.actions ?? [];

// ---- AC-4: an action no executor may run is owed by somebody, and counted apart -----------------

const at = '2026-09-21T12:00:00.000Z';
const probe = (overrides: Partial<Work> = {}): Work => ({
  id: `id-${overrides.key ?? 'GY-1'}`, key: 'GY-1', title: 'Owed', type: 'feature', description: '',
  priority: 2, dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, 
  ready: true, stage: 'merge', epoch: 1, revision: 1, policyRevision: 1,
  gates: [], violations: [], evidence: [], workspaces: [], agentRequests: [], sessions: [],
  lease: null, submission: null, candidate: null, observation: null, blocker: null,
  createdAt: at, updatedAt: at, stageEnteredAt: at,
  ...overrides,
} as unknown as Work);

test('unit:human-needed-actions-visible — an item whose only action is escalate is recorded as needing a person, listed on the human-facing page from the moment it is computed, and counted apart from the rows executors are taking', () => {
  const now = new Date(Date.parse(at) + 30_000);
  // The one refusal no executor step answers: branch protection nobody has verified.
  const refusal = 'Required Graphyard check and merge-queue branch protection have not been verified';
  const owedItem = probe({ gates: [{ name: 'merge', passed: false, reasons: [refusal] }] } as Partial<Work>);
  const computed = nextAction(owedItem, [owedItem], new Date(at))!;
  assert.equal(computed.kind, 'attention');
  assert.equal(actionJudgment.attention, 'in-step');
  assert.ok(!executorRunnableKinds.includes('attention'), 'no executor may hold a handler for it, so no executor will ever claim the row');
  assert.deepEqual(computed.needsHuman, { decision: `resolving ${owedItem.key}'s refusal`, resolve: `graphyard diagnose ${owedItem.key} — ${refusal}` });
  assert.deepEqual(humanNeeded(computed), computed.needsHuman, 'what the action records is what the rule says');

  // Beside it, a row an executor is simply yet to take.
  const queuedItem = probe({ key: 'GY-2', id: 'id-GY-2', gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }] } as Partial<Work>);
  assert.equal(nextAction(queuedItem, [queuedItem], new Date(at))!.kind, 'dispatch');
  const work = [owedItem, queuedItem];
  for (const item of work) {
    item.nextAction = nextAction(item, work, new Date(at));
    reconcileActions(item, work, new Date(at), { next: item.nextAction });
  }

  // Visible as needing a person straight away: the wait is measured from the moment the control
  // plane computed the action, not from the moment the row grew old enough for the idle list.
  const owed = humanNeededActions(work, now);
  assert.deepEqual(owed.map(entry => [entry.key, entry.source, entry.kind]), [[owedItem.key, 'action', 'attention']]);
  assert.equal(owed[0].action, rows(owedItem)[0].id, 'the row it belongs to is named');
  assert.equal(owed[0].since, at);
  assert.equal(owed[0].waitedMs, 30_000);
  assert.ok(owed[0].waitedMs < actionIdleMs, 'inside the idle bound, where nothing else would have reported it');
  assert.equal(idleActionable(work, now).length, 0, 'the queue itself calls nothing idle yet');

  // Both rows are unclaimed.
  const queue = queueSnapshot(work, now);
  assert.deepEqual(queue.waiting.map(row => row.kind).sort(), ['attention', 'dispatch']);
});
