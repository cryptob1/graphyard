import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryStopAttention } from '../src/retry-stop.js';
import { unansweredRequestAttention } from '../src/cli/unanswered-requests.js';
import { classifyAttention, trackFaults, type FaultRecord } from '../src/model/fault-classes.js';

// GY-1091, 2026-10-01: five unclassified faults in 24 hours, from two shared causes.
//
// - GY-727, GY-859, GY-1069: "GY-N is awaiting rework for a non-exercising proof: ..." — the line
//   unansweredRequestAttention raises for a producer that recorded its proof as not exercising its
//   criterion (GY-817). Its builder set no kind and no catalogue signature named its wording.
// - GY-73 (PR #501, approval 5379316566) and GY-957 (PR #508, approval 5375815849): "The loop stopped
//   retrying follow-up filing ... Graphyard refused the follow-ups for GY-1071 (409): Idempotency key
//   reused with different input". Two ledger records of one approval — the reviewed head's and the
//   head it was carried onto — appended its findings under the approval's one key, and the reason
//   names the head: GY-1071's ledger shows approval 5379316566 appended "at ccc14e051e77" at 12:41,
//   while the second record's kept append named "at 23f92d8bbe37" and was refused on every retry
//   until the retry stopped. The create path already resolved such a refusal (GY-598); the append did
//   not. The stop line itself also carried no kind. GY-1249 removed the follow-up filing, so the
//   append no longer exists; the stop line's classification is still tested below.
// The test is named for the proof it produces: manual:fault-class-unclassified.

const nonExercising = [
  ['GY-727', 'unit:reconcile-tick-bounded was recorded as not exercising AC-2 on bc00115a30ef: the mutation removing "Batches yield if they exceed reconcileBatchMs time. Exercise: removed batch time limit check." survived'],
  ['GY-859', 'unit:sync-restores-out-of-scope was recorded as not exercising AC-1 on 418b569602f4: the mutation removing "removed the --restore branch of syncWork in src/cli/workspace.ts (restore loop, commit, recheck)" survived'],
  ['GY-1069', 'unit:docs-no-duplication was recorded as not exercising AC-2 on a5119748b68b: the mutation removing "reverted the docs shrink (README.md and docs/ restored to base)" survived'],
] as const;

test('manual:fault-class-unclassified — GY-727, GY-859, GY-1069: a non-exercising proof awaiting rework is a proof fault, never unclassified', () => {
  const rows = nonExercising.map(([key, finding]) => ({ key, dispatch: { review: null, producers: [{ requestId: `request-${key}`, sinceMs: 600_000, group: 'claude',
    session: { state: 'completed', attempt: 1, resolution: 'recorded its proofs as not exercising their criterion', verdict: null }, unexercised: [finding] }] } }));
  const lines = unansweredRequestAttention(rows);
  assert.equal(lines.length, 3);
  const record: FaultRecord = { instances: [], open: {}, failing: {} };
  const opened = trackFaults(record, classifyAttention(lines), '2026-10-01T17:01:27.555Z');
  assert.deepEqual(opened.map(entry => [entry.subject, entry.kind, entry.faultClass]), nonExercising.map(([key]) => [key, 'nonexercising-proof', 'proof']));
  // A line recorded before its builder set the kind — the instances' own text — is recognised by its wording.
  for (const line of lines) {
    assert.match(line.text, /^GY-\d+ is awaiting rework for a non-exercising proof: /);
    const [worded] = classifyAttention([{ subject: line.subject, text: line.text }]);
    assert.deepEqual([worded.kind, worded.faultClass], ['nonexercising-proof', 'proof'], line.text);
  }
});

test('manual:fault-class-unclassified — a stopped loop retry is a loop fault, never unclassified', () => {
  const recorded = [
    { item: 'GY-73', step: 'follow-up filing for approval 5379316566 (PR #501)', error: 'the follow-ups could not be appended to GY-1071: Graphyard refused the follow-ups for GY-1071 (409): Idempotency key reused with different input' },
    { item: 'GY-957', step: 'follow-up filing for approval 5375815849 (PR #508)', error: 'the follow-ups could not be appended to GY-1054: Graphyard refused the follow-ups for GY-1054 (409): Idempotency key reused with different input' },
  ];
  for (const stop of recorded) {
    const line = retryStopAttention({ ...stop, count: 10, at: '2026-10-01T14:22:19.728Z' });
    for (const item of classifyAttention([line, { subject: line.subject, text: line.text }])) assert.deepEqual([item.kind, item.faultClass], ['retry-stopped', 'loop'], line.text);
  }
});
