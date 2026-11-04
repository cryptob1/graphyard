import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard } from '../src/model/board.js';
import { stalledCards } from '../src/model/actionless.js';
import { trialRefusal } from '../src/model/gates.js';
import type { Work } from '../src/model.js';

// 2026-11-04: the Work board showed 13 Blocked, most "Nothing is happening … stuck at Automated
// checks" and overdue, while only two had a recorded blocker: the rest were healthy submitted heads
// waiting their turn in the merge writer's serial queue behind one trial in flight.

const minute = 60_000, now = Date.parse('2026-11-04T20:09:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (n: number) => n.toString(16).padStart(40, 'a'), base = 'b'.repeat(40);
/** A submitted control-plane head, built and reviewed, waiting 62 minutes for the merge writer's trial. */
const head = (n: number, extra: Partial<Work> = {}): Work => ({
  id: `00000000-0000-4000-8000-0000000000${n}`, key: `GY-${n}`, title: `Item ${n}`, description: '', type: 'task', priority: 2, stage: 'test', ready: true, epoch: 1, revision: 5, policyRevision: 1,
  createdAt: iso(now - (200 - n) * minute), updatedAt: iso(now - 62 * minute), stageEnteredAt: iso(now - 62 * minute), lease: null, lastAssignment: { owner: 'implementer', epoch: 1 },
  workspaces: [], candidate: { sha: sha(n), baseSha: base, createdAt: iso(now - 62 * minute) }, submission: { epoch: 1, sha: sha(n), at: iso(now - 62 * minute) },
  reworkRequested: false, scenarioRequirements: [], evidence: [], observation: { source: 'control-plane' }, blocker: null, violations: [], criteria: [],
  policy: { checks: ['test'], review: true }, dependencies: [], nextAction: null,
  gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] },
    { name: 'test', passed: false, reasons: [trialRefusal(sha(n), base)] }],
  ...extra,
}) as unknown as Work;

test('integration:board-queue-not-blocked — a head queued behind the merge in flight is moving with its queue position and the item ahead, never Blocked or overdue; a recorded blocker still is Blocked', () => {
  const flight = head(10, { mergeLedger: { key: 'GY-10', state: 'intent', head: sha(10), baseTip: base, mergeSha: 'c'.repeat(40), risk: 'normal', intentAt: iso(now - 20 * minute),
    pushedAt: null, observedTip: null, refusal: null, trialStep: { step: 'tests', at: iso(now - 3 * minute) }, events: 1 } });
  const blocked = head(13, { blocker: 'npm test fails in src/engine.ts on the trial merge' });
  const work = [flight, head(11), head(12), blocked];
  const board = buildBoard(work, now);
  const row = (key: string) => Object.values(board.groups).flat().find(entry => entry.key === key)!;

  for (const [key, position] of [['GY-11', 1], ['GY-12', 2]] as const) {
    assert.equal(row(key).group, 'moving', `${key} is moving`);
    assert.equal(row(key).overdue, false, `${key} is not overdue for its queue wait`);
    assert.deepEqual(row(key).queue, { position, of: 3, ahead: 'GY-10', step: 'tests' });
    assert.equal(row(key).does, `In the merge queue: ${position} of 3, behind GY-10 (tests)`);
  }
  assert.equal(stalledCards(work, now).some(card => card.item.key === 'GY-11' || card.item.key === 'GY-12'), false, 'no queued head is a stall');
  assert.equal(row('GY-10').group, 'moving');
  // A recorded blocker is Blocked, wherever its head would sit in the queue.
  assert.equal(row('GY-13').group, 'blocked');
  assert.deepEqual(board.counts, { 'needs-you': 0, blocked: 1, moving: 3, 'up-next': 0, backlog: 0 });

  // A queue behind a flight whose trial stopped advancing is not moving: those heads stay stalls.
  const stale = { ...flight, mergeLedger: { ...flight.mergeLedger!, trialStep: { step: 'tests', at: iso(now - 45 * minute) } } } as Work;
  const stuck = buildBoard([stale, head(11), head(12), blocked], now);
  assert.equal(stuck.groups.blocked.some(entry => entry.key === 'GY-11'), true);
});
