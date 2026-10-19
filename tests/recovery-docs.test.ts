import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

/**
 * GY-2172 moved rollback and recovery into docs/delivery.md and dropped the copied JSON samples:
 * the schemas themselves stay covered by the delivery code tests. What the docs must keep is the
 * route and command surface an operator acts on.
 */
const guide = await readFile(new URL('../docs/delivery.md', import.meta.url), 'utf8');

test('the documented recovery surface names every rollback route, fencing mode and the recovery commands', async () => {
  for (const route of ['/api/delivery/rollback', '/api/delivery/rollback-claim', 'rollback-settle', 'rollback-resolve']) {
    assert.ok(guide.includes(route), `delivery.md names ${route}`);
  }
  assert.match(guide, /`provider`\/`serialized`\/`none`/, 'the fencing modes are named');
  assert.match(guide, /never automatic with `none`|never automatic/, 'fencing none is never automatic');
  assert.match(guide, /## Main watch/, 'the main watch section survives the trim');
  assert.match(guide, /## Coordinator recovery/, 'the coordinator recovery section survives the trim');
});
