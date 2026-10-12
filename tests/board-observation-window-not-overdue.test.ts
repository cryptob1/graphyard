import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, groupOf } from '../src/model/board.js';
import type { Work } from '../src/model.js';

// GY-1740 AC-3: on the board an item held by a future observation window is not overdue and is not in the
// Blocked group. The operator's Work page on 2026-10-12 showed GY-1689, GY-1721, GY-1722, GY-1724 and GY-1725
// as Blocked and 8h-33h overdue, two of them as faults, while each only waited for its reading's instant.

const hour = 3_600_000, now = 1000 * 24 * hour;
const iso = (at: number) => new Date(at).toISOString();
const criteria = [{ id: 'AC-1', text: 'From this head against the serving release: the rate is below 3 per 7 days after the change ships', proofs: ['manual:intervention-pattern-escalation-build-on-serving-release'] }];
/** A released post-deploy follow-up whose attempt ended 33 hours ago, with no worker on it. */
const followUp = (n: number, extra: Partial<Work>): Work => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, key: `GY-${n}`, title: `Follow-up ${n}`, description: '', type: 'chore', priority: 2, stage: 'build', ready: true, epoch: 1, revision: 5, policyRevision: 1,
  createdAt: iso(now - 40 * hour), updatedAt: iso(now - 33 * hour), stageEnteredAt: iso(now - 33 * hour), lease: null, lastAssignment: { owner: 'implementer', epoch: 1 },
  workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], criteria,
  policy: { checks: ['test', 'typecheck'], review: true }, dependencies: [], plannedFiles: [],
  gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
  ...extra,
}) as unknown as Work;

test('unit:board-observation-window-not-overdue — an item held by a future observation window is neither overdue nor Blocked, with or without the blocker that recorded its wait; past the window it is judged as before', () => {
  const window = { notBefore: iso(now + 6 * hour), basis: 'operator-hold' as const, detail: 'graphyard-operator held it until then: the 24h window has not elapsed' };
  const waitBlocker = `The observation AC-1 requires cannot exist before ${iso(now + 6 * hour)}`;
  const held = followUp(1, { observationWindow: window });
  const heldStillBlocked = followUp(2, { observationWindow: window, blocker: waitBlocker });
  const lapsed = followUp(3, { observationWindow: { ...window, notBefore: iso(now - hour) }, blocker: 'npm test fails in src/engine.ts' });
  const unheld = followUp(4, { blocker: waitBlocker });
  const board = buildBoard([held, heldStillBlocked, lapsed, unheld], now);
  const row = (key: string) => Object.values(board.groups).flat().find(entry => entry.key === key)!;

  for (const key of ['GY-1', 'GY-2']) {
    assert.notEqual(row(key).group, 'blocked', `${key} is not in the Blocked group`);
    assert.equal(row(key).overdue, false, `${key} is not overdue`);
    assert.equal(row(key).group, 'up-next');
    assert.match(row(key).does, /Waiting for its observation window: the reading it owes can first exist at /);
  }
  assert.equal(groupOf(heldStillBlocked, now), 'up-next');
  assert.equal(board.groups.blocked.some(entry => entry.key === 'GY-1' || entry.key === 'GY-2'), false);

  // A window that has passed holds nothing: a recorded fault is Blocked and, 33 hours on, overdue.
  assert.deepEqual([row('GY-3').group, row('GY-3').overdue], ['blocked', true]);
  // Without a window, the recorded wait still reads as Blocked: the loop's `window` is what moves it (AC-2).
  assert.equal(row('GY-4').group, 'blocked');
  // Past the instant the same item is ordinary Up next work again.
  assert.equal(groupOf(held, now + 7 * hour), 'up-next');
});
