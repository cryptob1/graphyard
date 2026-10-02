import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ejectedTipRestore, ejectionReason, restoringAfterEjection, restoringAfterEjectionPrefix, unrepairableRestore } from '../src/merge-queue.js';
import { evaluate, type Work } from '../src/model.js';
import { nextAction } from '../src/model/next-action.js';
import { refusalAction } from '../src/model/refusal-mapping.js';
import { regressionRefusals } from '../src/regression-guard.js';

// GY-638: follow-ups from the approved review of GY-568. (1) A restore that ended `unrepairable`
// leaves the carried refusal promising a restore that already failed, so its resync repeats for
// ever: the carried files must be judged as any out-of-scope change and route to rework. (2) A
// queued tip that is stale with no landing regression owes no ejection: its wait is answered by
// the queue re-speculating the tip from the item's own head, and that path is pinned here so the
// wait cannot outlive the re-speculation.
//
// Every case's title begins with the item's proof name: a manual proof's cases are the ones whose
// title begins with its name, so the proof runs exactly these and its evidence counts them.

const at = '2026-09-26T23:10:00.000Z', now = new Date(at);
const sha = (digit: string) => digit.repeat(40);
const main = sha('b');
const own = { 'GY-A': sha('1'), 'GY-B': sha('2') } as Record<string, string>;
const tip = { 'GY-B': sha('4') } as Record<string, string>;
const fileOf = (key: string) => `src/${key.toLowerCase()}.ts`;

/** A file on a head as GitHub lists it against `main`: this head changed it, `main` holds another version. */
const changed = (path: string) => ({ path, status: 'modified' as const, sha: sha('d'), baseSha: sha('e'), additions: 3, deletions: 1, binary: false });

function item(key: string, head: string, baseSha: string, sequence: number | null, files: string[], extra: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha, pr: key.charCodeAt(3), branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  return {
    id: key.toLowerCase(), key, title: key, description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: [fileOf(key)], stage: 'merge', revision: 4, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, candidate,
    workspaces: [{ host: 'machine-a', path: `/tmp/${key}`, epoch: 1, owner: 'worker', branch: candidate.branch }],
    submission: { epoch: 1, pr: candidate.pr }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    queue: sequence === null ? null : { sequence, enqueuedAt: at, policyRevision: 1, speculation: null }, queueSequence: sequence ?? 0, queueHistory: [],
    observation: { candidate, checks: [{ name: 'test', result: 'success', appId: 1 }], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED', submittedAt: at }],
      merged: false, mergeSha: null, mergeable: true, protected: true, files, scopeFiles: [changed(fileOf(key))],
      landing: { base: main, files: files.map(changed) }, at, prState: 'open', draft: false, baseTip: main, baseTree: sha('e'), baseTipContained: true },
    ...extra,
  } as unknown as Work;
}
/** A successor whose candidate is the speculative tip the queue published for it behind `predecessors`. */
function successor(key: string, sequence: number, predecessors: string[]): Work {
  // Behind its predecessors the tip holds their files too; landing on main (the head left) lists them.
  const files = [...predecessors, key].map(fileOf);
  const work = item(key, tip[key], sha('9'), sequence, files);
  const speculation = { ref: `graphyard/queue/${key}`, tip: tip[key], base: sha('9'), baseTree: sha('8'), predecessors, policyRevision: 1, publishedAt: at, reviewedHead: own[key] };
  return { ...work, queue: { ...work.queue!, speculation },
    queueHistory: [{ at, event: 'enqueued', sequence }, { at, event: 'predicted', sequence, tip: tip[key], predecessors, from: own[key] }] } as Work;
}
/** Evaluate an item and store the outcome on it, as the engine does on every save. */
function settle(work: Work, all: Work[]): Work {
  return { ...work, ...evaluate(work, all.map(entry => entry.id === work.id ? work : entry), now, [1]) } as Work;
}
const build = (work: Work) => work.gates.find(gate => gate.name === 'build')!;
const departedHead = (reason: string) => ({ ...item('GY-A', own['GY-A'], main, null, [fileOf('GY-A')]),
  queueEjection: { at, sequence: 1, reason, sha: own['GY-A'], policyRevision: 1, conflict: null } }) as Work;

test('manual:review-followups-triaged: a queued stale tip with no landing regression is not ejected — the build gate waits, and the queue re-speculating the tip from its own head ends the wait without a restore', () => {
  const head = departedHead('Required CI check test did not pass on speculative tip 111111111111');
  const queued = successor('GY-B', 2, ['GY-A']);
  // The landing check lists only the entry's own file: nothing adverse is reported, yet the tip was
  // still built behind GY-A, whose commits left the queue without landing.
  const calm = { ...queued, observation: { ...queued.observation!, landing: { base: main, files: [changed(fileOf('GY-B'))] } } } as Work;
  const all = [head, calm];

  // No adverse conclusion about the tip: it stays queued for the queue to rebuild.
  assert.equal(ejectionReason(calm, [1], all), null);
  const judged = settle(calm, all);
  assert.ok(judged.queue, 'the entry keeps its queue place');
  assert.equal(judged.queueEjection ?? null, null, 'nothing is ejected');
  assert.equal(ejectedTipRestore(judged, [head, judged]), null, 'no ejection owes a restore while the entry is queued');
  // The gates still hold the tree back while the wait stands.
  const reasons = build(judged).reasons;
  assert.equal(reasons.length, 1, reasons.join(' | '));
  assert.ok(reasons[0].startsWith(restoringAfterEjectionPrefix));
  assert.equal(nextAction(judged, [head, judged], now)?.kind, 'resync', 'the wait is a fresh reading, not a worker round');

  // The queue re-speculates: the tip is rebuilt from the entry's own head onto the base, and the
  // wait ends with no restore and nothing refused — it cannot outlive the re-speculation.
  const newTip = sha('8');
  const respec = {
    ...judged,
    candidate: { ...judged.candidate!, sha: newTip, baseSha: main },
    queue: { ...judged.queue!, speculation: { ref: 'graphyard/queue/GY-B', tip: newTip, base: main, baseTree: sha('e'), predecessors: [] as string[], policyRevision: 1, publishedAt: at, reviewedHead: own['GY-B'] } },
    queueHistory: [...(judged.queueHistory ?? []), { at, event: 'predicted' as const, sequence: 2, tip: newTip, predecessors: [] as string[], from: own['GY-B'] }],
    observation: { ...calm.observation!, candidate: { sha: newTip, baseSha: main }, files: [fileOf('GY-B')], scopeFiles: [changed(fileOf('GY-B'))], landing: { base: main, files: [changed(fileOf('GY-B'))] } },
  } as Work;
  const settled = settle(respec, [head, respec]);
  assert.equal(restoringAfterEjection(settled, [head, settled]), null, 'the rebuilt tip is not stale: the wait ended with the re-speculation');
  assert.deepEqual(build(settled).reasons, [], 'nothing refuses the rebuilt tip');
  assert.equal(ejectedTipRestore(settled, [head, settled]), null);
});

test('manual:review-followups-triaged: carried files on a head the restore could not repair are refused as any out-of-scope change and routed to rework, not to the resync that repeats', () => {
  const head = departedHead('Pull request was closed without merging');
  const ejectedTip = successor('GY-B', 2, ['GY-A']);
  const unrepairable = {
    ...ejectedTip,
    queue: null, queueSequence: 0,
    queueEjection: { at, sequence: 2, reason: `Speculative tip ${tip['GY-B'].slice(0, 12)} was built behind GY-A, which left the merge queue without landing`, sha: tip['GY-B'], policyRevision: 1, conflict: null },
    baseRefresh: {
      from: { sha: tip['GY-B'], baseSha: sha('9') }, base: main, baseTree: sha('e'), policyRevision: 1, at, head: tip['GY-B'], conflict: null, merge: null, carry: null, trigger: 'ejection restore' as const,
      restore: { contaminated: tip['GY-B'], foreign: ['GY-A'], own: null, cause: 'ejection' as const, requested: null, reason: 'ejected from the merge queue', performedAt: at, outcome: 'unrepairable' as const },
    },
  } as Work;
  const all = [head, unrepairable];

  assert.equal(unrepairableRestore(unrepairable), true, 'the record names this head unrepairable');
  assert.equal(restoringAfterEjection(unrepairable, all), null, 'the unrepairable record hands the head back to the gates');
  // Where the landing check sees the carried files, they are named as reverts answered by a sync,
  // not by the control-plane restore that has already failed.
  const landing = regressionRefusals(unrepairable, unrepairable.observation!, all);
  assert.doesNotMatch(landing.join('\n'), /^Carried from another item's tip/m, 'no restore is promised: the carried refusal is not worded');
  assert.match(landing.join('\n'), /^Landing the candidate on /m);
  assert.match(landing.join('\n'), /carried from GY-A/, 'the file is still attributed to the item whose commits the head carries');
  for (const refusal of landing) assert.equal(refusalAction(unrepairable, 'build', refusal, all, now), 'request-rework', refusal);
  // Where the diff against the bound base sees them too, the same routing holds.
  const observed = { ...unrepairable.observation!, scopeFiles: [changed(fileOf('GY-A')), changed(fileOf('GY-B'))] } as NonNullable<Work['observation']>;
  const both = regressionRefusals(unrepairable, observed, all);
  assert.match(both.join('\n'), /^Candidate changes 1 file outside its planned files/m);
  assert.match(both.join('\n'), /^Out-of-scope regression: src\/gy-a\.ts:/m);
  for (const refusal of both) assert.equal(refusalAction(unrepairable, 'build', refusal, all, now), 'request-rework', refusal);
  const judged = settle({ ...unrepairable, observation: observed }, all);
  assert.equal(nextAction(judged, [head, judged], now)?.kind, 'request-rework', 'the item is routed to rework, not to the resync that would repeat for ever');

  // The same head without the unrepairable record still waits for the restore it has not had.
  const fresh = successor('GY-B', 2, ['GY-A']);
  const freshAll = [head, fresh];
  assert.equal(unrepairableRestore(fresh), false);
  const carried = regressionRefusals(fresh, fresh.observation!, freshAll);
  assert.match(carried.join('\n'), /^Carried from another item's tip/m, 'a repairable head still waits for the control plane');
  assert.equal(refusalAction(fresh, 'build', carried[0], freshAll, now), 'resync');
});
