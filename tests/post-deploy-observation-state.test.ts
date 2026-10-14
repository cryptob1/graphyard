import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchable } from '../src/coordination.js';
import { buildMasterStatus } from '../src/master.js';
import { dispatchSchedule } from '../src/master/status.js';
import { upNextHold } from '../src/model/board.js';
import { actionAccount, nextAction } from '../src/model/next-action.js';
import * as model from '../src/model.js';
import type { Work } from '../src/model.js';

// Read at call time, so a tree without the export fails a test case rather than the file's import.
const loopObservation = (work: Work, at: Date, all: unknown[] = []) => (model as unknown as { loopObservation: (work: Work, at: Date, all: unknown[]) => unknown }).loopObservation(work, at, all);

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

const reading = (extra: object = {}) => ({ proof: 'manual:post-deploy/rate-on-serving-release', trusted: true, result: 'pass', policyRevision: 1, sha: 'a'.repeat(40), baseSha: 'm'.repeat(40), executed: 1, skipped: 0, at: iso(now), ...extra });

test('unit:observation-class-needs-the-follow-up-reading — a head-anchored code criterion on a -on-serving-release proof is dispatched as before; a failed, expired or other-release reading does not end the wait; a due or expired-window wait is a hold on the board', () => {
  const proof = 'manual:rate-on-serving-release', parent = { id: '11111111-1111-4111-8111-111111111111', delivery: { mergeSha: 'm'.repeat(40) } };
  const request = `post-deploy:${parent.id}:AC-1:${proof}:${'a'.repeat(40)}`;
  const follow = (extra: Partial<Work> = {}) => item(6, { description: `Post-deploy follow-up: ${request}\n\nowed`, criteria: [{ id: 'AC-1', text: 'The rate holds', proofs: [proof] }], ...extra });
  const read = (work: Work) => loopObservation(work, new Date(now), [parent]);
  const codeLike = item(7, { criteria: [{ id: 'AC-1', text: `From this head against the serving release aaaaaaaaaaaa that carries GY-9's merge bbbbbbbbbbbb: the dispatcher skips it`, proofs: ['manual:skip-on-serving-release'] }] });
  assert.equal(loopObservation(codeLike, new Date(now)), null);
  assert.equal(dispatchable(codeLike, now), true);
  assert.ok(read(follow()));
  for (const bad of [{ result: 'fail' }, { expiresAt: iso(now - hour) }, { sha: 'c'.repeat(40) }, { sha: `${'a'.repeat(12)}${'c'.repeat(28)}` }, { baseSha: 'n'.repeat(40) }, { skipped: 1 }, { policyRevision: 0 }, { revocation: { at: iso(now), actor: 'x', reason: 'y' } }]) {
    assert.ok(read(follow({ evidence: [reading({ proof, ...bad })] as never })), JSON.stringify(bad));
  }
  assert.equal(read(follow({ evidence: [reading({ proof })] as never })), null);
  assert.ok(loopObservation(follow({ evidence: [reading({ proof })] as never }), new Date(now)), 'an unknown parent binds nothing');
  // A later failed reading of the same proof and release withdraws an earlier pass.
  assert.ok(read(follow({ evidence: [reading({ proof, at: iso(now - 2 * hour) }), reading({ proof, result: 'fail', at: iso(now - hour) })] as never })));
  assert.equal(read(follow({ evidence: [reading({ proof, result: 'fail', at: iso(now - 2 * hour) }), reading({ proof, at: iso(now - hour) })] as never })), null);
  // The criterion's wording alone is not the class: without the filer's request identity it is dispatched.
  const imitation = item(8, { description: '', criteria: [{ id: 'AC-1', text: codeLike.criteria[0].text, proofs: [proof] }] });
  assert.equal(loopObservation(imitation, new Date(now)), null);
  const due = follow();
  assert.match(upNextHold(due, [due], now)?.text ?? '', /reading of manual:rate-on-serving-release/);
  const lapsed = follow({ observationWindow: { notBefore: iso(now - hour), basis: 'criterion-window', detail: 'd' } });
  assert.match(upNextHold(lapsed, [lapsed], now)?.text ?? '', /which is due and which the loop records in its deployment-verification step/);
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
  const read = item(5, { evidence: [reading()] as never });
  assert.equal(loopObservation(read, new Date(now)), null);
  // The recorded reading ends the wait, never the exclusion: the still-open item is not handed to a worker.
  assert.equal(dispatchable(read, now), false);
  assert.notEqual(nextAction(read, [read], new Date(now))?.kind, 'dispatch');
  assert.deepEqual((loopObservation(windowed, new Date(now + 7 * hour)) as { due: boolean }).due, true);
  assert.deepEqual((loopObservation(windowed, new Date(now)) as { due: boolean }).due, false);
  const later = new Date(now + 7 * hour);
  assert.equal(dispatchable(windowed, later.getTime()), false);
  // GY-1779: a due reading is the loop's own to record, a wait on the loop, never an operator-proof escalation.
  assert.equal(nextAction(windowed, [windowed], later), null);
  assert.deepEqual([actionAccount(windowed, [windowed], later).wait?.kind, actionAccount(windowed, [windowed], later).wait?.on], ['window', 'loop']);
  assert.equal(nextAction(item(1), [item(1)], new Date(now)), null, 'an unwindowed one is due at once, on the loop');
  const after = buildMasterStatus({ now: iso(now + 7 * hour), work: [windowed, read] } as never, [], []);
  assert.deepEqual([after.counts.ready, after.counts.waiting], [1, 1]);
});

test('unit:observation-wait-names-reading — a windowed wait names the observation due then, never a dispatch; a due one is a pending reading of the loop, not a missing submission and not attention', () => {
  const windowed = item(4, { observationWindow: { notBefore: iso(now + 6 * hour), basis: 'criterion-window', detail: 'merged 7 days before' } });
  const wait = actionAccount(windowed, [windowed], new Date(now)).wait!;
  assert.match(wait.detail, /first exist at/);
  assert.doesNotMatch(wait.detail, /dispatches it then/);
  const later = iso(now + 7 * hour);
  const status = buildMasterStatus({ now: later, work: [windowed] } as never, [], []), row = status.work[0]!;
  assert.equal(row.attention, null);
  assert.match(row.observing!, /the loop records in its deployment-verification step/);
  assert.deepEqual((status as { pendingReadings: { key: string; due: boolean }[] }).pendingReadings.map(entry => [entry.key, entry.due]), [['GY-4', true]]);
});
