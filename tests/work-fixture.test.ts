import test from 'node:test';
import assert from 'node:assert/strict';
import { storedWorkSchema } from '../src/model-boundary/work.js';
import { workFixture } from './helpers/work-fixture.js';

test('unit:work-fixture — workFixture() parses with the stored-work schema, with and without overrides', () => {
  const plain = workFixture();
  assert.deepEqual(storedWorkSchema.parse(plain), plain);
  const leased = workFixture({ key: 'GY-7', stage: 'build', epoch: 1, lease: { owner: 'w', epoch: 1, expiresAt: plain.createdAt } });
  assert.equal(storedWorkSchema.parse(leased).id, 'id-GY-7');
  assert.equal(storedWorkSchema.safeParse({ ...plain, stage: 'nowhere' }).success, false);
  assert.equal(storedWorkSchema.safeParse({ ...plain, gates: undefined }).success, false);
});
