import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { stallRenewalWindowMs } from '../src/engine.js';

// GY-1811: the operations reference once claimed a recorded renewal fault buys one more lease
// period; the engine grants a plane-stall fault only stallRenewalWindowMs (30s), never another
// lease period. This pin keeps the page's stated window equal to the constant the engine grants,
// so either moving alone fails here until the page and the engine agree again.

test('unit:stall-window-docs — the operations reference states the engine stallRenewalWindowMs, never a further lease period', async () => {
  const docs = await readFile(new URL('../docs/operations-reference.md', import.meta.url), 'utf8');
  const stated = docs.match(/(\d+)s `stallRenewalWindowMs`/);
  assert.ok(stated, 'the page states its stall window in seconds beside the engine constant stallRenewalWindowMs');
  assert.equal(Number(stated![1]) * 1000, stallRenewalWindowMs, 'the stated window equals the engine stallRenewalWindowMs');
  assert.match(docs, /not another lease period/, 'the page denies a further lease period');
});
