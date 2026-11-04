import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedTests } from '../src/merge-writer/trial.js';

// 2026-11-04: a trial with more than 100 failed files was refused by the merge record ("Too big:
// expected array to have <=100 items"), so the head was never recorded and the queue retried it forever.
test('unit:trial-record-many-failures — a mass failure is recorded with at most 100 failed files of at most 300 characters', () => {
  const failed = Array.from({ length: 150 }, (_, index) => `tests/${'x'.repeat(index === 0 ? 400 : 4)}-${index}.test.ts`);
  const recorded = recordedTests({ passed: 7, failed, files: 160 });
  assert.equal(recorded.failed.length, 100);
  assert.ok(recorded.failed.every(file => file.length <= 300));
  assert.deepEqual({ passed: recorded.passed, files: recorded.files }, { passed: 7, files: 160 });
  assert.deepEqual(recordedTests({ passed: 1, failed: ['tests/a.test.ts'], files: 2 }).failed, ['tests/a.test.ts']);
});
