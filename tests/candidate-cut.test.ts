import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assessCut, assessExactCut, cutDue, type CutCommit } from '../src/daemon/candidate-cut.js';
import { candidateSettings, candidateSettingsSchema, defaultCandidateEveryMerges, defaultCandidateIdleMinutes } from '../src/master/merge-writer-settings.js';
import { masterRunSchema } from '../src/master/profiles.js';

// GY-1526: the cut rule — a candidate is due at 5 merges after the newest cut or once one merge has
// waited 15 minutes — and the exact cut's bounded batch (GY-1904).

const start = Date.parse('2030-05-01T12:00:00Z');
const minute = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
/** Main's first-parent history newest first: `ages` are each merge's minutes before `start`, newest first. */
const history = (...ages: number[]): CutCommit[] => ages.map((age, index) => ({ sha: sha(`merge-${index}-${age}`), at: iso(start - age * minute) }));
const defaults = candidateSettings({});

test('unit:candidate-cut-due — cutDue is true at 5 or more first-parent merges after the newest cut, or at one merge 15 or more minutes old with no cut since, and false otherwise; run.candidates.everyMerges (never above five) and run.candidates.idleMinutes override both', () => {
  assert.deepEqual(defaults, { everyMerges: 5, idleMinutes: 15 });
  assert.equal(defaultCandidateEveryMerges, 5); assert.equal(defaultCandidateIdleMinutes, 15);
  const cut = { candidates: [{ id: '20300501T100000Z', sha: sha('cut'), cutAt: iso(start - 120 * minute) }] };
  // Four fresh merges after the cut: neither threshold is met.
  const four = [...history(1, 2, 3, 4), { sha: sha('cut'), at: iso(start - 120 * minute) }, ...history(200)];
  assert.equal(cutDue(cut, four, start, defaults), false, 'four merges, the oldest four minutes old, are not due');
  assert.match(assessCut(cut, four, start, defaults).reason, /4 merge\(s\) landed on main after candidate 20300501T100000Z; the next candidate is cut at 5 merges or once one has waited 15 minutes/);
  // The fifth merge makes the count.
  const five = [{ sha: sha('fifth'), at: iso(start) }, ...four];
  assert.equal(cutDue(cut, five, start, defaults), true, 'five merges after the cut are due');
  assert.match(assessCut(cut, five, start, defaults).reason, /5 merge\(s\) landed on main after candidate 20300501T100000Z, at or past the 5-merge cut/);
  // A wider everyMerges an older master.json carries still parses, and takes effect as five.
  assert.deepEqual(candidateSettings(masterRunSchema.parse({ intervalSeconds: 20, candidates: { everyMerges: 10 } })), { everyMerges: 5, idleMinutes: 15 });
  // One merge that has waited 15 minutes is due on its own; at 14 it is not. The age is the commit time, never the loop's reads.
  const lone = (age: number) => [{ sha: sha('lone'), at: iso(start - age * minute) }, { sha: sha('cut'), at: iso(start - 120 * minute) }];
  assert.equal(cutDue(cut, lone(14), start, defaults), false);
  assert.equal(cutDue(cut, lone(15), start, defaults), true, 'a single merge fifteen minutes old is due');
  assert.match(assessCut(cut, lone(15), start, defaults).reason, /has waited 15 minute\(s\), at or past the 15-minute idle cut/);
  assert.equal(cutDue(cut, lone(15), start - minute, defaults), false, 'a minute earlier the same merge is not due yet');
  // The merges counted are those after the newest cut: a merge older than the cut is never counted, and a quiet main after the cut is nothing to cut.
  assert.equal(cutDue(cut, [{ sha: sha('cut'), at: iso(start - 120 * minute) }, ...history(300, 400)], start, defaults), false, 'merges before the cut do not count');
  assert.match(assessCut(cut, [{ sha: sha('cut'), at: iso(start - 120 * minute) }], start, defaults).reason, /No merge has landed on main after candidate 20300501T100000Z; nothing to cut/);
  // With no cut recorded every merge in the history counts, and an idle merge is due at once at fifteen minutes.
  assert.equal(cutDue({ candidates: [] }, history(16), start, defaults), true);
  assert.equal(cutDue({ candidates: null }, history(1, 2), start, defaults), false);
  assert.equal(cutDue({ candidates: [] }, [], start, defaults), false, 'an empty history is never due: never cut on idle with zero merges');
  // A cut whose SHA the history read no longer reaches counts everything read, as the release cut itself does.
  assert.equal(cutDue({ candidates: [{ id: 'old', sha: sha('unreachable'), cutAt: iso(start - 9000 * minute) }] }, history(1, 2, 3, 4, 5, 6, 7, 8, 9, 10), start, defaults), true);
  // The overrides: three merges or thirty idle minutes.
  const tuned = candidateSettings(masterRunSchema.parse({ intervalSeconds: 20, candidates: { everyMerges: 3, idleMinutes: 30 } }));
  assert.deepEqual(tuned, { everyMerges: 3, idleMinutes: 30 });
  assert.equal(cutDue(cut, [...history(1, 2, 3), { sha: sha('cut'), at: iso(start - 120 * minute) }], start, tuned), true, 'three merges are due under everyMerges 3');
  assert.equal(cutDue(cut, lone(20), start, tuned), false, 'twenty idle minutes are not due under idleMinutes 30');
  assert.equal(cutDue(cut, lone(30), start, tuned), true);
  assert.equal(cutDue(cut, lone(20), start, defaults), true, 'the same merge is due under the default fifteen');
  // The schema is strict and bounded, and lives beside run.mergeWriter.
  assert.throws(() => candidateSettingsSchema.parse({ everyMerges: 0 }));
  assert.throws(() => candidateSettingsSchema.parse({ idleMinutes: 15, cadence: 'x' }));
  assert.throws(() => masterRunSchema.parse({ intervalSeconds: 20, candidates: { everyMerges: 1000 } }));
  assert.deepEqual(candidateSettings(masterRunSchema.parse({ intervalSeconds: 20 })), defaults);
});

test('unit:exact-cut-takes-five — an exact cut takes the oldest five waiting changes at most, whatever the cap or backlog, leaves the rest waiting, and a scheduled partial batch waits its bounded wait', () => {
  const backlog = (count: number, age = 1) => Array.from({ length: count }, (_, index) => ({ workId: `w-${index + 1}`, key: `GY-${index + 1}`, mergeSha: sha(`m-${index}`), mergedAt: iso(start - (age + count - index) * minute), pr: null }));
  const six = assessExactCut(backlog(6), { trigger: 'manual', now: start, cap: 5, waitMinutes: 15 });
  assert.equal(six.due, true); assert.deepEqual(six.members.map(member => member.key), ['GY-1', 'GY-2', 'GY-3', 'GY-4', 'GY-5']); assert.equal(six.waiting, 1);
  assert.equal(assessExactCut(backlog(9), { trigger: 'manual', now: start, cap: 50, waitMinutes: 15 }).members.length, 5, 'a cap above five still cuts five');
  assert.equal(assessExactCut(backlog(5).slice(0, 2), { trigger: 'manual', now: start, cap: 2, waitMinutes: 15, total: 8 }).waiting, 6, 'total counts the backlog the caller did not read whole');
  assert.equal(assessExactCut([], { trigger: 'manual', now: start, cap: 5, waitMinutes: 15 }).due, false);
  const partial = assessExactCut(backlog(2), { trigger: 'schedule', now: start, cap: 5, waitMinutes: 15 });
  assert.equal(partial.due, false); assert.deepEqual(partial.members, []); assert.match(partial.reason, /a candidate is cut at 5 changes or once GY-1 has waited 15 minutes/);
  assert.equal(assessExactCut(backlog(2, 14), { trigger: 'schedule', now: start, cap: 5, waitMinutes: 15 }).due, true, 'the oldest change has waited 16 minutes');
  assert.equal(assessExactCut(backlog(5), { trigger: 'schedule', now: start, cap: 5, waitMinutes: 60 }).due, true, 'a full batch is due at once');
});

