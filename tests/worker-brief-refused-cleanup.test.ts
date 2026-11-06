import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerPrompt } from '../src/master/dispatch.js';

test('unit:worker-brief-refused-cleanup — a refused cleanup of untracked files is not a blocker; stopping is for refusals that block the change', () => {
  const brief = workerPrompt({ cliPath: '/bin/graphyard' } as any, { key: 'GY-73', title: 'Cleans up' } as any, { principal: 'worker-a' } as any, 1);
  assert.match(brief, /A refused cleanup of untracked files is not a blocker: leave them, git add only your own paths and submit; stop only when a refusal blocks the change\./);
});
