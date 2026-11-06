import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeBundle, type AdapterContext } from '../src/install/adapters.js';

const serverEnv = (values: { name: string; value: string }[]) => {
  const ctx = { workdir: '/fixture', installId: 'test', image: 'graphyard:test', port: 4310 } as AdapterContext;
  return composeBundle(ctx, values as any).find(file => file.path.endsWith('/server.env'))!.content.split('\n');
};

test('unit:tests/compose-safe-directory.test.ts — server env carries safe.directory=/repo exactly once, also from a deployed env that holds it', () => {
  const fresh = serverEnv([]);
  assert.deepEqual(fresh.filter(line => line.startsWith('GIT_CONFIG_')), ['GIT_CONFIG_COUNT=1', 'GIT_CONFIG_KEY_0=safe.directory', 'GIT_CONFIG_VALUE_0=/repo']);
  const deployed = serverEnv(fresh.filter(Boolean).map(line => ({ name: line.split('=')[0], value: line.slice(line.indexOf('=') + 1) })));
  assert.deepEqual(deployed, fresh);
});
