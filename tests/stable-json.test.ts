import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonChanged, stableJson } from '../src/model/stable-json.js';

// 2026-09-25: reconcile compared JSON.stringify(work) before and after evaluation. jsonb returns
// keys in its own order, so an unchanged merge-queue entry whose evaluation rebuilt an object in
// another key order was re-saved every tick; each save bumped the revision and discarded the
// GitHub observation taken meanwhile, and the merge queue deadlocked.

test('unit:reconcile-change-detection-key-order: the same content in another key order, or with undefined members, is unchanged', () => {
  const stored = { key: 'GY-356', queue: { batch: { tip: null, size: 1, state: 'testing', members: ['GY-356'] }, sequence: 406 }, stage: 'merge' };
  const rebuilt = { stage: 'merge', queue: { sequence: 406, batch: { members: ['GY-356'], state: 'testing', size: 1, tip: null, underTest: undefined } }, key: 'GY-356', lease: undefined };
  assert.notEqual(JSON.stringify(stored), JSON.stringify(rebuilt), 'plain stringify reports a change');
  assert.equal(stableJson(stored), stableJson(rebuilt), 'stable JSON does not');

  // A real change is still a change; array order still matters.
  assert.notEqual(stableJson(stored), stableJson({ ...stored, stage: 'done' }));
  assert.notEqual(stableJson({ a: [1, 2] }), stableJson({ a: [2, 1] }));
  assert.equal(stableJson({ a: [undefined] }), JSON.stringify({ a: [undefined] }), 'undefined array members serialise as null, like JSON.stringify');
  assert.equal(stableJson('x'), '"x"');
  assert.equal(stableJson(undefined), 'null');

  // What reconcile calls (GY-1027): its plain-stringify snapshot, judged as stableJson judges.
  assert.equal(jsonChanged(JSON.stringify(stored), rebuilt), false, 'another key order and undefined members are no change');
  assert.equal(jsonChanged(JSON.stringify(stored), structuredClone(stored)), false);
  assert.equal(jsonChanged(JSON.stringify(stored), { ...rebuilt, stage: 'done' }), true);
  assert.equal(jsonChanged(JSON.stringify({ a: [1, 2] }), { a: [2, 1] }), true, 'array order matters');
  assert.equal(jsonChanged(JSON.stringify({ a: { b: 1 } }), { a: { b: 1, c: null } }), true, 'a member set to null is a change');
  assert.equal(jsonChanged(JSON.stringify({ a: [1] }), { a: { 0: 1 } }), true, 'an object is not an array');
  assert.equal(jsonChanged(JSON.stringify({ at: '2026-10-01T00:00:00.000Z' }), { at: new Date('2026-10-01T00:00:00.000Z') }), false, 'a Date is its ISO text');
});
