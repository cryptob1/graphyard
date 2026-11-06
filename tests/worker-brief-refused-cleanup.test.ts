import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerPrompt } from '../src/master/dispatch.js';

test('unit:worker-brief-refused-cleanup — a refused cleanup of untracked files is not a blocker; stopping is for refusals that block the change', () => {
  const brief = workerPrompt({ cliPath: '/bin/graphyard' } as any, { key: 'GY-73', title: 'Cleans up' } as any, { principal: 'worker-a' } as any, 1);
  assert.match(brief, /A refused cleanup of untracked local files is not a blocker: leave those files, stage only your own paths \(git add <paths>\), and continue to test, commit and submit; stop only when a refused command blocks the change itself\./);
});
