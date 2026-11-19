import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutContainment } from '../src/server/routes/delivery.js';
import type { GitRunner } from '../src/merge-writer/local-observation.js';

// The observe-sha route answers containment from the checkout, so a production commit
// that contains a staging merge marks that item deployed, not only an exact match.
const runner = (status: number | null, seen: string[][] = []): GitRunner => async args => { seen.push([...args]); return { status, stdout: '', stderr: '' }; };

test('unit:observe-sha-checkout-containment: ancestry exit codes become yes, no or unknown', async () => {
  const seen: string[][] = [];
  assert.equal(await checkoutContainment(runner(0, seen))('a'.repeat(40), 'b'.repeat(40)), true);
  assert.deepEqual(seen[0], ['merge-base', '--is-ancestor', 'a'.repeat(40), 'b'.repeat(40)]);
  assert.equal(await checkoutContainment(runner(1))('a', 'b'), false);
  assert.equal(await checkoutContainment(runner(128))('a', 'b'), null);
  assert.equal(await checkoutContainment(runner(null))('a', 'b'), null);
});
