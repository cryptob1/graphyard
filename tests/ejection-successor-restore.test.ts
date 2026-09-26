import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routineDecision } from '../src/master-daemon.js';
import { neededDecision } from '../src/daemon/decisions.js';
import { ejectedTipRestore, restoringAfterEjection, restoringAfterEjectionPrefix } from '../src/merge-queue.js';
import { evaluate, type Work } from '../src/model.js';
import { nextAction } from '../src/model/next-action.js';
import { classifyScope, regressionRefusals } from '../src/regression-guard.js';

// GY-568, 2026-09-26 09:00-09:30Z: the queue head GY-371 was ejected. Its successors' candidates were
// still speculative tips built on GY-371's tip, so their landing check on main listed GY-371's files
// as reverts ("would revert N files outside its planned files", N = 44…75) and each was sent back to a
// worker, although the ejection restore rebuilt every branch from the item's own head moments later.

const at = '2026-09-26T09:10:00.000Z', now = new Date(at), clock = Date.parse(at);
const sha = (digit: string) => digit.repeat(40);
const main = sha('b');
const own = { 'GY-A': sha('1'), 'GY-B': sha('2'), 'GY-C': sha('3') } as Record<string, string>;
const tip = { 'GY-B': sha('4'), 'GY-C': sha('5') } as Record<string, string>;
const restored = { 'GY-B': sha('6'), 'GY-C': sha('7') } as Record<string, string>;
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
  const next = { ...work, ...evaluate(work, all.map(entry => entry.id === work.id ? work : entry), now, [1]) } as Work;
  return next;
}
const build = (work: Work) => work.gates.find(gate => gate.name === 'build')!;

test('unit:successors-restored-before-gates — ejecting the head of a 3-entry queue restores both successors before any tree gate judges them, asks for no rework, and the revert check then sees only their own files', () => {
  const head = { ...item('GY-A', own['GY-A'], main, null, [fileOf('GY-A')]),
    queueEjection: { at, sequence: 1, reason: 'Required CI check test did not pass on speculative tip 111111111111', sha: own['GY-A'], policyRevision: 1 } } as Work;
  let b = successor('GY-B', 2, ['GY-A']), c = successor('GY-C', 3, ['GY-A', 'GY-B']);
  let all = [head, b, c];

  for (const key of ['GY-B', 'GY-C']) {
    const before = all.find(entry => entry.key === key)!;
    // Without the restore rule this observation reads as the item reverting the head's files.
    const stale = regressionRefusals({ ...before, queueHistory: [] }, before.observation!, all);
    assert.match(stale.join('\n'), /^Landing the candidate on /m, `${key}: the stale tip's own observation lists the head's files as reverts`);

    const judged = settle(before, all);
    const reasons = build(judged).reasons;
    assert.equal(reasons.length, 1, `${key}: the build gate waits under one reason, not a list of reverts: ${reasons.join(' | ')}`);
    assert.ok(reasons[0].startsWith(restoringAfterEjectionPrefix), `${key}: the item waits with 'restoring after predecessor ejection'`);
    assert.match(reasons[0], /built behind GY-A(, GY-B)?, which left the merge queue without landing/);
    assert.doesNotMatch(reasons.join('\n'), /Landing|Out-of-scope|Candidate changes|conflict/, `${key}: no tree-dependent refusal is read from the stale tip`);
    // The entry leaves the queue so the restore can run, and the ejection names why.
    assert.equal(judged.queue, null);
    assert.match(judged.queueEjection!.reason, /built behind GY-A(, GY-B)?, which left the merge queue without landing/);
    assert.doesNotMatch(judged.queueEjection!.reason, /would revert work outside its planned files/);
    all = all.map(entry => entry.id === judged.id ? judged : entry);
  }
  b = all.find(entry => entry.key === 'GY-B')!; c = all.find(entry => entry.key === 'GY-C')!;

  for (const judged of [b, c]) {
    // No rework decision is requested, and the next action is the fresh reading that runs the restore.
    assert.equal(neededDecision(judged, { autoMerge: true }), null, `${judged.key}: no rework decision`);
    assert.equal(routineDecision(judged, { autoMerge: true }, clock), null);
    assert.equal(nextAction(judged, all, now)?.kind, 'resync', `${judged.key}: the fresh reading runs the restore; no worker round is owed`);
    // The restore the ejection owes resets the branch to the item's own reviewed head.
    const owed = ejectedTipRestore(judged, all);
    assert.ok(owed, `${judged.key}: the control plane owes the branch restore`);
    assert.equal(owed!.own, own[judged.key]);
    assert.ok(owed!.foreign.includes('GY-A'));
  }

  // The restore ran and published a head, but GitHub has not been observed at it yet: still waiting.
  const performed = (work: Work): Work => ({ ...work, baseRefresh: {
    from: { sha: work.candidate!.sha, baseSha: work.candidate!.baseSha }, base: main, baseTree: sha('e'), policyRevision: 1, at, head: restored[work.key], conflict: null, merge: null, carry: null, trigger: 'ejection restore',
    restore: { contaminated: work.candidate!.sha, foreign: ['GY-A'], own: own[work.key], cause: 'ejection', requested: null, reason: 'ejected from the merge queue', performedAt: at, outcome: 'restored' } } } as Work);
  b = settle(performed(b), all); c = settle(performed(c), all);
  all = [head, b, c];
  for (const judged of [b, c]) {
    const reasons = build(judged).reasons;
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], new RegExp(`^${restoringAfterEjectionPrefix}.*restored the branch to ${restored[judged.key].slice(0, 12)}.*judged once GitHub is observed at that head`));
    assert.equal(neededDecision(judged, { autoMerge: true }), null);
  }

  // GitHub observed at the restored head: the tree gates judge it, and see only the item's own file.
  const observed = (work: Work): Work => {
    const candidate = { ...work.candidate!, sha: restored[work.key], baseSha: main };
    return { ...work, candidate, observation: { ...work.observation!, candidate, files: [fileOf(work.key)], scopeFiles: [changed(fileOf(work.key))],
      landing: { base: main, files: [changed(fileOf(work.key))] }, reviews: [], at } } as Work;
  };
  b = settle(observed(b), all); c = settle(observed(c), all);
  all = [head, b, c];
  for (const judged of [b, c]) {
    assert.equal(restoringAfterEjection(judged, all), null, `${judged.key}: the restored head is judged`);
    assert.deepEqual(build(judged).reasons, [], `${judged.key}: nothing on the restored head is out of scope`);
    assert.deepEqual(regressionRefusals(judged, judged.observation!, all), []);
    const seen = [...classifyScope(judged.plannedFiles, judged.observation!.scopeFiles!), ...classifyScope(judged.plannedFiles, judged.observation!.landing!.files!)].map(finding => finding.path);
    assert.deepEqual([...new Set(seen)], [fileOf(judged.key)], `${judged.key}: the revert check sees only its own file`);
    assert.equal(neededDecision(judged, { autoMerge: true }), null, `${judged.key}: still no rework decision`);
  }
});

test('unit:foreign-tip-files-not-reverts — files that came from another item\'s tip or an ejected predecessor are attributed to it by name and send the candidate to no worker', () => {
  const head = { ...item('GY-A', own['GY-A'], main, null, [fileOf('GY-A')]),
    queueEjection: { at, sequence: 1, reason: 'Pull request was closed without merging', sha: own['GY-A'], policyRevision: 1 } } as Work;
  const b = successor('GY-B', 2, ['GY-A']);
  const all = [head, b];

  // The revert check itself: the head's file is named as GY-A's, not as this change reverting it.
  const refusals = regressionRefusals(b, b.observation!, all);
  assert.equal(refusals.length, 1, refusals.join(' | '));
  assert.match(refusals[0], /^Carried from another item's tip: 1 file the candidate would change belongs to GY-A, whose unlanded commits this head carries \(src\/gy-a\.ts: .*carried from GY-A/);
  assert.match(refusals[0], /no worker is asked to revert them/);
  assert.doesNotMatch(refusals.join('\n'), /^(Landing|Out-of-scope|Candidate changes)/m);

  // An open candidate the landing check found in the head's history is attributed the same way,
  // even where no prediction record names it (a branch contaminated some other way).
  const d = item('GY-D', sha('a'), main, null, [fileOf('GY-D')]);
  const e = { ...item('GY-E', sha('c'), main, null, [fileOf('GY-D'), fileOf('GY-E')]) } as Work;
  e.observation = { ...e.observation!, landing: { ...e.observation!.landing!, foreign: [{ key: 'GY-D', pr: d.candidate!.pr, head: d.candidate!.sha }] } } as Work['observation'];
  const foreign = regressionRefusals(e, e.observation!, [d, e]);
  assert.equal(foreign.length, 1);
  assert.match(foreign[0], /^Carried from another item's tip: .*belongs to GY-D/);

  // Neither refusal sends the candidate to a worker: both are answered by the control plane's restore.
  for (const [work, set] of [[b, all], [e, [d, e]]] as const) {
    const judged = settle(work, [...set]);
    const buildReasons = build(judged).reasons;
    assert.ok(buildReasons.length > 0);
    assert.doesNotMatch(buildReasons.join('\n'), /^(Landing|Out-of-scope|Candidate changes)/m, `${work.key}: no revert is laid at the candidate's door`);
    assert.equal(nextAction(judged, [...set].map(entry => entry.id === judged.id ? judged : entry), now)?.kind, 'resync', `${work.key}: no rework`);
    assert.equal(neededDecision(judged, { autoMerge: true }), null, `${work.key}: no rework decision`);
  }

  // A file a delivery shipped is still the candidate reverting it, whatever tip it rides on.
  const shipped = { ...item('GY-S', sha('f'), main, null, [fileOf('GY-B')]), stage: 'done' } as Work;
  const stillOwn = regressionRefusals({ ...b, plannedFiles: [] }, { ...b.observation!, scopeFiles: [], landing: { base: main, files: [changed(fileOf('GY-B'))] } }, [head, b, shipped]);
  assert.match(stillOwn.join('\n'), /^Landing regression: src\/gy-b\.ts: .*shipped by GY-S/m);
});
