import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { routineDecision, syncConflict } from '../src/master-daemon.js';
import { buildMasterStatus } from '../src/master.js';
import { ejectedTipRestore, predecessorWait } from '../src/merge-queue.js';
import { evaluate, type Work } from '../src/model.js';
import { placeInQueue, queueEjectionRecord } from '../src/model/queue.js';

// GY-321, 2026-09-25: GY-173, GY-177, GY-182 and GY-245 were ejected because their speculative
// merge conflicted behind queued predecessors, while each head merged cleanly into main. The loop
// asked each worker to sync with main, which resolves nothing, and the ejected head never
// re-entered the queue once the predecessor it conflicted with had landed or left.

const at = '2026-09-25T12:00:00.000Z', now = new Date(at), clock = Date.parse(at);
const sha = (digit: string) => digit.repeat(40);
const base = sha('b'), movedBase = sha('c');
const conflict = (head: string, key: string) => `Speculative merge of ${head.slice(0, 12)} into graphyard/${key.toLowerCase()}-1 conflicts and cannot be resolved by Graphyard`;

function item(key: string, head: string, sequence: number | null, extra: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: Number(key.slice(3)), branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' };
  return {
    id: key.toLowerCase(), key, title: key, description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'merge', revision: 4, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, candidate,
    workspaces: [{ host: 'machine-a', path: `/tmp/${key}`, epoch: 1, owner: 'worker', branch: candidate.branch }],
    submission: { epoch: 1, pr: candidate.pr }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    queue: sequence === null ? null : { sequence, enqueuedAt: at, policyRevision: 1, speculation: null }, queueSequence: sequence ?? 0, queueHistory: [],
    observation: { candidate, checks: [{ name: 'test', result: 'success', appId: 1 }], reviews: [{ reviewer: 'reviewer', sha: head, state: 'APPROVED', submittedAt: at }],
      merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false,
      baseTip: base, baseTree: sha('e'), baseTipContained: true },
    ...extra,
  } as unknown as Work;
}
/** The queue ejecting `work` for a speculative-merge conflict, recorded as the engine records it. */
function eject(work: Work, all: Work[]): Work {
  const { ejection, history } = queueEjectionRecord(work, all, conflict(work.candidate!.sha, work.key), now);
  return { ...work, queue: null, queueEjection: ejection, queueHistory: history };
}
const decide = (work: Work) => routineDecision(work, { autoMerge: true }, clock);
const place = (work: Work, all: Work[]) => placeInQueue(work, all.map(entry => entry.id === work.id ? work : entry), now, [1], true);

test('unit:predecessor-conflict-waits — a speculative conflict behind a queued predecessor asks for no rework and waits for it by name; one on the base tip asks for a sync keyed on that tip', () => {
  // Behind a predecessor: the tip GY-2 conflicted on held GY-1.
  const predecessor = item('GY-1', sha('1'), 1);
  const queued = item('GY-2', sha('2'), 2);
  const behind = eject(queued, [predecessor, queued]);
  assert.deepEqual(behind.queueEjection!.predecessors, ['GY-1'], 'the ejection records the predecessors the conflicting prediction held');
  assert.deepEqual(behind.queueHistory!.at(-1)!.predecessors, ['GY-1']);
  assert.equal(syncConflict(behind), null, 'merging the base resolves nothing, so no sync round is asked');
  assert.equal(decide(behind), null, 'no rework decision is needed for a conflict with a predecessor');
  assert.deepEqual(predecessorWait(behind, [predecessor, behind]), ['GY-1']);
  const waiting = place(behind, [predecessor, behind]);
  assert.equal(waiting.queue, null);
  assert.match(waiting.reasons[0], /^Waiting for GY-1 to land or leave the merge queue: /, 'the item reports that it waits for its predecessor, naming it');

  // On the base tip: nothing was ahead, so the conflict is with the base itself.
  const alone = item('GY-3', sha('3'), 3);
  const onBase = eject(alone, [alone]);
  assert.deepEqual(onBase.queueEjection!.predecessors, [], 'a merge onto the base branch tip records no predecessors');
  const decision = decide(onBase);
  assert.equal(decision?.action, 'rework');
  assert.equal(decision?.binding, `${sha('3')}:queue-conflict:3:${base}`, 'the rework is keyed on the base tip the head conflicts with');
  assert.match(decision!.reason, /graphyard sync GY-3/);
  // A record from before the rule names no predecessors and still reads as a base conflict.
  const legacy = { ...onBase, queueEjection: { ...onBase.queueEjection!, predecessors: undefined } } as Work;
  assert.equal(decide(legacy)?.binding, `${sha('3')}:queue-conflict:3:${base}`);
});

test('unit:predecessor-conflict-reenters — the ejected head re-enters at the back once its predecessor lands or is ejected, and stays out while it is still queued', () => {
  const predecessor = item('GY-1', sha('1'), 1);
  const other = item('GY-4', sha('4'), 5);
  const queued = item('GY-2', sha('2'), 2);
  const ejected = eject(queued, [predecessor, queued, other]);

  // Still queued ahead: out, however often it is evaluated.
  assert.equal(place(ejected, [predecessor, ejected, other]).queue, null, 'stays out while the predecessor is still queued');

  // The predecessor is ejected: the same head re-enters with a new sequence at the back.
  const predecessorOut = { ...predecessor, queue: null, queueEjection: { at, sequence: 1, reason: 'Pull request was closed without merging', sha: sha('1'), policyRevision: 1 } } as Work;
  const afterEjection = place(ejected, [predecessorOut, ejected, other]);
  assert.ok(afterEjection.queue, 're-enters after its predecessor is ejected');
  assert.equal(afterEjection.queue!.sequence, 6, 'a new sequence behind every entry');
  assert.equal(afterEjection.ejection, null);
  assert.equal(afterEjection.history.at(-1)!.event, 'enqueued');

  // The predecessor lands: the base moves first, and nothing re-enters until the refresh has run.
  const landed = { ...predecessor, stage: 'done', queue: null, observation: { ...predecessor.observation!, merged: true, mergeSha: movedBase } } as Work;
  const behindMovedBase = { ...ejected, observation: { ...ejected.observation!, baseTip: movedBase, baseTipContained: false } } as Work;
  assert.equal(place(behindMovedBase, [landed, behindMovedBase, other]).queue, null, 'the base refresh brings the head onto the new tip before it re-enters');
  // The refresh found the head already contains the new tip: the same head re-enters.
  const refreshed = { ...behindMovedBase, observation: { ...behindMovedBase.observation!, baseTipContained: true },
    baseRefresh: { from: { sha: sha('2'), baseSha: base }, base: movedBase, baseTree: sha('f'), policyRevision: 1, at, head: sha('2'), conflict: null, merge: null, carry: null } } as Work;
  const afterLanding = place(refreshed, [landed, refreshed, other]);
  assert.ok(afterLanding.queue, 're-enters after its predecessor lands');
  assert.equal(afterLanding.queue!.sequence, 6);
  // The refresh conflicts with the new base: that is a base conflict, and it asks for rework.
  const conflicted = { ...behindMovedBase, baseRefresh: { ...refreshed.baseRefresh!, head: null, conflict: `Candidate ${sha('2').slice(0, 12)} cannot be brought onto base branch tip ${movedBase.slice(0, 12)} without resolving a conflict` } } as Work;
  assert.equal(place(conflicted, [landed, conflicted, other]).queue, null);
  const decision = decide(conflicted);
  assert.equal(decision?.action, 'rework');
  assert.equal(decision?.binding, `${sha('2')}:conflict`, 'the refresh conflict (baseRefreshConflict) is what asks for the rework');
});

test('unit:predecessor-conflict-status — an ejected tip is still restored first, and master status names the predecessors in the merge refusal', async () => {
  const predecessor = item('GY-1', sha('1'), 1);
  // The branch head is a speculative tip published behind GY-1, then ejected: it carries GY-1's
  // unlanded commits, so it is restored to its own head before anything re-enters.
  const tip = sha('5'), own = sha('2');
  const queued = item('GY-2', tip, 2, { queueHistory: [{ at, event: 'predicted', sequence: 2, tip, predecessors: ['GY-1'], from: own }] } as Partial<Work>);
  const ejected = eject(queued, [predecessor, queued]);
  const predecessorOut = { ...predecessor, queue: null } as Work;
  const restore = ejectedTipRestore(ejected, [predecessorOut, ejected]);
  assert.ok(restore, 'the ejected speculative tip still owes its restore');
  assert.equal(restore!.own, own);
  assert.deepEqual(restore!.foreign, ['GY-1']);
  assert.equal(place(ejected, [predecessorOut, ejected]).queue, null, 'the contaminated tip does not re-enter; its restored head does');

  // master status: the waiting item's merge refusal names its predecessors.
  const waiting = eject(item('GY-2', own, 2), [predecessor, item('GY-2', own, 2)]);
  const graded = [predecessor, waiting].map(work => {
    const all = [predecessor, waiting];
    const result = evaluate(work, all, now, [1]);
    return { ...work, stage: result.stage, gates: result.gates, violations: result.violations, queue: result.queue, queueSequence: result.queueSequence, queueEjection: result.queueEjection, queueHistory: result.queueHistory } as Work;
  });
  assert.equal(graded[1].queue, null);
  const status = buildMasterStatus({ work: graded, now: at }, [], []);
  const row = status.work.find((entry: { key: string }) => entry.key === 'GY-2')!;
  assert.equal(row.refusal?.gate, 'merge');
  assert.match(row.refusal!.reason, /^Waiting for GY-1 to land or leave the merge queue: /);

  // docs/github.md states the rule.
  const docs = await readFile(new URL('../docs/github.md', import.meta.url), 'utf8');
  assert.match(docs, /conflicting only with entries ahead of it re-enters unchanged/);
});
