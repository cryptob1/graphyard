import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { foldMergeLedger, ledgerMergeShas, mergeIntentSchema, mergeLedgerKinds, mergePushedSchema, mergeReconciledSchema, mergeRefusedSchema, type MergeLedgerEvent } from '../src/model/merge-ledger.js';

// GY-1519 AC-1: the merge ledger's event kinds and payload schemas, and the fold that gives each
// item's latest ledger state from the append-only rows, whatever older rows and strangers it holds.

const sha = (seed: string) => createHash('sha1').update(seed.toLowerCase()).digest('hex');
const T = '2026-10-08T05:00:00.000Z';
const intent = (key: string, n: number): MergeLedgerEvent => ({ kind: mergeLedgerKinds.intent, payload: { key, head: sha(`head${n}`), baseTip: sha('base'), mergeSha: sha(`merge${n}`), risk: 'low', at: T } });

test('unit:merge-ledger-fold — the four event kinds parse their payloads, and the fold gives each item its latest state: an intent opens it, a push and a reconciliation find it by merge commit, a refusal by head or by the item it was written under; rows nothing opened or that do not parse fold into nothing', () => {
  assert.deepEqual(mergeLedgerKinds, { intent: 'merge.intent', pushed: 'merge.pushed', reconciled: 'merge.reconciled', refused: 'merge.refused' });
  // The payload schemas: each strict, every sha lower-cased, every instant a parseable time.
  assert.equal(mergeIntentSchema.parse({ key: 'GY-1', head: sha('HEAD').toUpperCase(), baseTip: sha('b'), mergeSha: sha('m'), risk: 'high', at: T }).head, sha('head'));
  assert.throws(() => mergeIntentSchema.parse({ key: 'GY-1', head: 'short', baseTip: sha('b'), mergeSha: sha('m'), risk: 'high', at: T }));
  assert.throws(() => mergeIntentSchema.parse({ key: 'GY-1', head: sha('h'), baseTip: sha('b'), mergeSha: sha('m'), risk: 'high', at: 'yesterday' }));
  assert.equal(mergePushedSchema.parse({ mergeSha: sha('m'), pushedAt: T }).pushedAt, T);
  assert.throws(() => mergePushedSchema.parse({ mergeSha: sha('m'), pushedAt: T, extra: 1 }), /unrecognized/i);
  assert.equal(mergeReconciledSchema.parse({ mergeSha: sha('m'), observedTip: sha('t') }).observedTip, sha('t'));
  assert.equal(mergeRefusedSchema.parse({ head: sha('h'), reason: 'conflicts with main', kind: 'revert' }).kind, 'revert');
  assert.throws(() => mergeRefusedSchema.parse({ head: sha('h'), reason: 'x', kind: 'rebase' }));

  const events: MergeLedgerEvent[] = [
    intent('GY-1', 1),
    { kind: mergeLedgerKinds.pushed, payload: { mergeSha: sha('merge1'), pushedAt: '2026-10-08T05:01:00.000Z' } },
    { kind: mergeLedgerKinds.reconciled, payload: { mergeSha: sha('merge1'), observedTip: sha('tip1') } },
    intent('GY-2', 2),
    { kind: mergeLedgerKinds.refused, payload: { head: sha('head2'), reason: 'the test merge conflicts', kind: 'merge' } },
    intent('GY-3', 3),
    // Written under its item rather than found by head: the fold trusts the item it was written under.
    { kind: mergeLedgerKinds.refused, work: 'GY-3', payload: { head: sha('other'), reason: 'the revert is not the exact inverse', kind: 'revert' } },
    // Strangers: an unrelated kind, a push nothing intended, a payload that does not parse.
    { kind: 'merge.enqueued', payload: { mergeSha: sha('merge1') } },
    { kind: mergeLedgerKinds.pushed, payload: { mergeSha: sha('nobody'), pushedAt: T } },
    { kind: mergeLedgerKinds.intent, payload: { key: 'GY-9' } },
    // A `merge.reconciled` row the delivery path wrote before the ledger existed (engine.ts): its merge commit sits under details.
    intent('GY-4', 4),
    { kind: mergeLedgerKinds.reconciled, work: 'GY-4', payload: { details: { mergeSha: sha('merge4'), mergedAt: T } } },
  ];
  const folded = foldMergeLedger(events);
  assert.deepEqual(Object.keys(folded).sort(), ['GY-1', 'GY-2', 'GY-3', 'GY-4']);
  assert.deepEqual(folded['GY-1'], { key: 'GY-1', state: 'reconciled', head: sha('head1'), baseTip: sha('base'), mergeSha: sha('merge1'), risk: 'low', intentAt: T, pushedAt: '2026-10-08T05:01:00.000Z', observedTip: sha('tip1'), refusal: null, events: 3 });
  assert.equal(folded['GY-2'].state, 'refused');
  assert.deepEqual(folded['GY-2'].refusal, { kind: 'merge', reason: 'the test merge conflicts' });
  assert.equal(folded['GY-2'].mergeSha, sha('merge2'), 'the refused intent keeps the merge commit it meant to land');
  assert.deepEqual(folded['GY-3'].refusal, { kind: 'revert', reason: 'the revert is not the exact inverse' });
  assert.equal(folded['GY-3'].head, sha('other'));
  assert.equal(folded['GY-4'].state, 'reconciled');
  assert.equal(folded['GY-4'].observedTip, sha('merge4'));
  assert.deepEqual([...ledgerMergeShas(folded)].sort(), [sha('merge1'), sha('merge2'), sha('merge3'), sha('merge4')].sort());
  // A later intent for the same item starts it over, counting the rows it folded.
  const again = foldMergeLedger([...events, { kind: mergeLedgerKinds.intent, payload: { key: 'GY-1', head: sha('head1b'), baseTip: sha('tip1'), mergeSha: sha('merge1b'), risk: 'low', at: T } }]);
  assert.equal(again['GY-1'].state, 'intent'); assert.equal(again['GY-1'].pushedAt, null); assert.equal(again['GY-1'].events, 4);
  assert.deepEqual(foldMergeLedger([]), {});
});

test('unit:merge-ledger-fold imports no Node built-in: the model stays runnable wherever the model is', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/model/merge-ledger.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /from\s+'node:/);
  assert.match(source, /declare module '\.\/work\.js' \{ interface Work \{ mergeLedger\?: MergeLedgerState \| null \} \}/);
});
