import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impossibleScopePaths } from '../src/cli/session-commands.js';

// GY-1763. The decision-refused instances on GY-1696 were scope requests for paths no repository holds;
// each is refused at filing now, so no approver decision is requested and refused.
const tracked = ['src/daemon/faults.ts', 'docs/coordination.md', 'tests/a.test.ts', 'package.json'];

test('truncated master-status field names and local credential files are refused at filing', () => {
  assert.deepEqual(impossibleScopePaths(['daemon.relea', 'upgrade.align'], tracked), ['daemon.relea', 'upgrade.align']);
  assert.deepEqual(impossibleScopePaths(['.graphyard/master.json'], tracked), ['.graphyard/master.json']);
});

test('tracked files, directories, and new files under tracked directories pass', () => {
  assert.deepEqual(impossibleScopePaths(['src/daemon/faults.ts', 'docs/', 'src/daemon/new.ts', 'src/new/dir/x.ts', 'package.json', 'vitest.config.ts'], tracked), []);
});

test('without a tracked listing nothing is judged', () => {
  assert.deepEqual(impossibleScopePaths(['daemon.relea'], null), []);
});
