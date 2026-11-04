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
  reworkRequested: false, scenarioRequirements: [], evidence: [], observation: { source: 'control-plane', candidate: { sha: sha(n) } }, blocker: null, violations: [], criteria: [],
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

  // A stale flight reports its own stall, while the waiting heads keep their positions.
  const stale = { ...flight, mergeLedger: { ...flight.mergeLedger!, trialStep: { step: 'tests', at: iso(now - 45 * minute) } } } as Work;
  const stuck = buildBoard([stale, head(11), head(12), blocked], now);
  assert.equal(stuck.groups.blocked.some(entry => entry.key === 'GY-10'), true);
  assert.equal(stuck.groups.blocked.some(entry => entry.key === 'GY-13'), true);
  for (const [key, position] of [['GY-11', 1], ['GY-12', 2]] as const) {
    const queued = stuck.groups.moving.find(entry => entry.key === key)!;
    assert.deepEqual(queued.queue, { position, of: 3, ahead: 'GY-10', step: 'tests' });
    assert.equal(queued.overdue, false);
  }
});

test('integration:board-queue-not-blocked — three real batch positions publish their flights before trials finish, leaving only additional heads queued', async () => {
  const { mergeStack } = await import('../src/merge-writer/batch.js');
  const { mergeRecordKinds } = await import('../src/merge-writer/executor.js');
  const { foldMergeLedger } = await import('../src/model-boundary/merge-ledger.js');
  const work = Array.from({ length: 16 }, (_, index) => head(index + 1));
  work[15]!.blocker = 'Recorded failure';
  const events: import('../src/model/merge-ledger.js').MergeLedgerEvent[] = [];
  let started = 0, ready!: () => void, finish!: () => void;
  const trialsStarted = new Promise<void>(resolve => { ready = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let tip = base;
  const running = mergeStack({
    baseBranch: 'main', retrials: 0, now: () => now, holds: async () => false,
    fetch: async () => tip,
    merge: async (candidate) => ({ mergeSha: candidate, files: [] }),
    record: async (item, event) => {
      const { kind, ...payload } = event;
      events.push({ kind: mergeRecordKinds[kind], work: item.key, payload: kind === 'intent' ? { ...payload, key: item.key } : payload });
      const ledger = foldMergeLedger(events);
      for (const item of work) item.mergeLedger = ledger[item.key];
    },
    trial: async () => {
      if (++started === 3) ready();
      await pending;
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {} };
    },
    push: async sha => { tip = sha; return 'pushed'; },
  }, [work.slice(0, 4), work.slice(4, 8), work.slice(8, 12)]);
  await Promise.race([trialsStarted, running.then(results => { assert.fail(JSON.stringify(results)); })]);
  try {
    const board = buildBoard(work, now);
    for (let index = 0; index < 12; index++) {
      const row = board.groups.moving.find(row => row.key === work[index]!.key);
      assert.ok(row, 'every head in all three running batches is moving');
      assert.ok(!row.queue, 'running heads do not occupy waiting positions');
    }
    for (let index = 12; index < 15; index++) {
      const row = board.groups.moving.find(row => row.key === work[index]!.key)!;
      assert.deepEqual(row.queue, { position: index - 11, of: 4, ahead: 'GY-1', step: 'queue wait' });
      assert.equal(row.overdue, false);
    }
    assert.equal(board.groups.blocked[0]!.key, 'GY-16');
    assert.equal(board.counts.blocked, 1);
    assert.equal(stalledCards(work, now).filter(card => !card.item.blocker).length, 0);
  } finally { finish(); await running; }
});
