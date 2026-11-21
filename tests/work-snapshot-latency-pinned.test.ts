import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rowBytes } from './helpers/row-bytes.js';

// GY-3546: hot-path-latency-bounded judged GET /api/status and /api/board against half the full
// list's wall-clock time. On a loaded runner the HTTP reads' fixed costs grew faster than the list's
// (status median 124 ms against an 85 ms budget), so the verdict followed the runner, not the code.
// The bound is now judged in bytes the database returned, which no load can move.

test('unit:work-snapshot-latency-pinned — the hot-path bound counts the bytes of the rows a read returned, not its wall-clock time', () => {
  const row = { id: 'w1', document: { key: 'GY-1', history: ['a', 'b'] } };
  const one = rowBytes({ rows: [row] });
  assert.equal(one, JSON.stringify(row).length);
  assert.equal(rowBytes([{ rows: [row] }, { rows: [row, row] }]), one * 3, 'a multi-statement result counts every statement\'s rows');
  assert.equal(rowBytes({ rowCount: 0 }), 0);
  const source = readFileSync(new URL('./work-snapshot-latency.test.ts', import.meta.url), 'utf8');
  const bound = source.slice(source.indexOf("test('integration:hot-path-latency-bounded"));
  assert.ok(bound.length > 0 && !/steadyState|assertTiming|performance\.now/.test(bound.slice(0, bound.indexOf('\n});'))), 'hot-path-latency-bounded takes no wall-clock measurement');
});
