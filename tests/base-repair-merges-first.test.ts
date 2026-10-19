import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeQueue } from '../src/merge-writer/executor.js';
import { baseFailureItem } from '../src/model/base-failure.js';
import type { Work } from '../src/model.js';

// GY-2150: the item the base-failure step files repairs the base every held head waits on, so the queue trials it first.

const start = Date.parse('2030-04-01T00:00:00Z');
const minute = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const candidate = (n: number) => ({ sha: `${n}`.padStart(40, 'a'), baseSha: 'b'.repeat(40), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' });
const head = (n: number, minutesAgo: number, title: string) => ({
  id: `w${n}`, key: `GY-${n}`, title, stage: 'build', createdAt: iso(start - minutesAgo * minute), stageEnteredAt: iso(start - minutesAgo * minute),
  submission: { epoch: 1, pr: n }, candidate: candidate(n), reworkRequested: false,
  observation: { source: 'control-plane', candidate: candidate(n), merged: false },
  gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] }],
}) as unknown as Work;

test('unit:base-repair-merges-first — the base-failure repair item is next ahead of older heads, beside hotfixes, and the rest keep oldest-first order', () => {
  const { title } = baseFailureItem({ check: 'test', test: 'tests/x.test.ts', baseSha: 'c'.repeat(40), blocks: [] } as never, 'main');
  const older = head(1, 300, 'Older feature'), old = head(2, 200, 'Old feature'), repair = head(3, 5, title), fix = head(4, 100, 'Hotfix: unblock');
  assert.equal(mergeQueue([older, old, repair], {}, start).next?.key, 'GY-3');
  assert.deepEqual(mergeQueue([older, old, repair, fix], {}, start).queue.map(entry => entry.key), ['GY-4', 'GY-3', 'GY-1', 'GY-2']);
});
