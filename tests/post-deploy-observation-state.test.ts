import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchable } from '../src/coordination.js';
import { buildMasterStatus } from '../src/master.js';
import { dispatchSchedule } from '../src/master/status.js';
import { nextAction } from '../src/model/next-action.js';
import * as model from '../src/model.js';
import type { Work } from '../src/model.js';

// Read at call time, so a tree without the export fails a test case rather than the file's import.
const loopObservation = (work: Work, at: Date) => (model as unknown as { loopObservation: (work: Work, at: Date) => unknown }).loopObservation(work, at);

// GY-1762: a systemDriven item whose criteria are all manual post-deploy proofs has no code for a worker:
// it is not dispatched, and it counts as waiting on the loop's reading, not as ready.

const hour = 3_600_000, now = Date.parse('2026-10-12T12:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
const manual = [{ id: 'AC-1', text: 'The loop reads the rate on the serving release', proofs: ['manual:post-deploy/rate-on-serving-release'] }];
const code = [{ id: 'AC-1', text: 'The dispatcher skips it', proofs: ['unit:skips'] }, ...manual.map(criterion => ({ ...criterion, id: 'AC-2' }))];
const item = (n: number, extra: Partial<Work> = {}): Work => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, key: `GY-${n}`, title: `Observation ${n}`, description: '', type: 'chore', priority: 2, stage: 'ready', ready: true, epoch: 0, revision: 5, policyRevision: 1,
  createdAt: iso(now - 40 * hour), updatedAt: iso(now - 33 * hour), stageEnteredAt: iso(now - 33 * hour), lease: null, lastAssignment: null, systemDriven: true,
  workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], criteria: manual,
  policy: { checks: ['test', 'typecheck'], review: true }, dependencies: [], plannedFiles: [],
  gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
  ...extra,
}) as unknown as Work;

test('unit:observation-item-not-dispatched — the dispatcher skips an all-manual post-deploy item and dispatches one with a code criterion or a hand-driven one', () => {
  const observing = item(1), withCode = item(2, { criteria: code }), handDriven = item(3, { systemDriven: false });
  assert.equal(dispatchable(observing, now), false);
  assert.equal(dispatchable(withCode, now), true);
  assert.equal(dispatchable(handDriven, now), true);
  assert.deepEqual(dispatchSchedule([observing, withCode, handDriven], now).order.map(entry => entry.key).sort(), ['GY-2', 'GY-3']);
  assert.notEqual(nextAction(observing, [observing], new Date(now))?.kind, 'dispatch');
  assert.equal(nextAction(withCode, [withCode], new Date(now))?.kind, 'dispatch');
});

test('unit:observation-item-counted-waiting — it counts as waiting with what it waits for, and as ready again once the wait has ended', () => {
  const snapshot = (...work: Work[]) => buildMasterStatus({ now: iso(now), work } as never, [], []);
  const windowed = item(4, { observationWindow: { notBefore: iso(now + 6 * hour), basis: 'criterion-window', detail: 'merged 7 days before' } });
  const status = snapshot(item(1), windowed, item(2, { criteria: code }));
  assert.equal(status.counts.ready, 1);
  assert.equal(status.counts.waiting, 2);
  const row = (key: string) => status.work.find(entry => entry.key === key)!;
  assert.match(row('GY-1').observing!, /manual:post-deploy\/rate-on-serving-release on the serving release/);
  assert.match(row('GY-4').observing!, new RegExp(`first exist at ${iso(now + 6 * hour)}`));
  assert.equal(row('GY-2').observing, null);

  // The window closing makes the reading owed, not the item dispatchable: only a recorded trusted reading ends the wait.
  const read = item(5, { evidence: [{ proof: 'manual:post-deploy/rate-on-serving-release', trusted: true }] as never });
  assert.equal(loopObservation(read, new Date(now)), null);
  // The recorded reading ends the wait, never the exclusion: the still-open item is not handed to a worker.
  assert.equal(dispatchable(read, now), false);
  assert.notEqual(nextAction(read, [read], new Date(now))?.kind, 'dispatch');
  assert.deepEqual((loopObservation(windowed, new Date(now + 7 * hour)) as { due: boolean }).due, true);
  assert.deepEqual((loopObservation(windowed, new Date(now)) as { due: boolean }).due, false);
  const later = new Date(now + 7 * hour);
  assert.equal(dispatchable(windowed, later.getTime()), false);
  assert.equal(nextAction(windowed, [windowed], later)?.kind, 'escalate');
  assert.equal(nextAction(item(1), [item(1)], new Date(now))?.kind, 'escalate', 'an unwindowed one owes its reading at once');
  const after = buildMasterStatus({ now: iso(now + 7 * hour), work: [windowed, read] } as never, [], []);
  assert.deepEqual([after.counts.ready, after.counts.waiting], [1, 1]);
});
