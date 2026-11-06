import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localUnitText } from '../src/install/local.js';
import type { AdapterContext } from '../src/install/adapters.js';

// GY-3179: the units src/install/local.ts writes put the operator's ~/.local/bin on PATH.
test('unit:units-local-bin-path — the local control-plane unit has ~/.local/bin on its PATH', () => {
  const ctx = { repository: 'acme/shop', local: { paths: { directory: '/srv/graphyard', postgres: '/srv/graphyard/pg' }, command: ['/usr/bin/node', 'run'] } } as unknown as AdapterContext;
  const line = localUnitText(ctx).split('\n').find(row => row.startsWith('Environment=') && row.includes('PATH='));
  assert.ok(line, 'the unit sets PATH');
  assert.ok(line.slice(line.indexOf('PATH=') + 5).replace(/"$/, '').split(':').includes(join(homedir(), '.local', 'bin')));
});
