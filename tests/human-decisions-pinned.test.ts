import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTests } from './helpers/run-tests.js';

test('unit:test-browser-tests-human-decisions-spec-ts-pinned — answering survives a delayed pre-answer poll', async () => {
  const result = await runTests({ browser: true, args: ['browser-tests/human-decisions.spec.ts', '--workers=2'], stdio: 'pipe' });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
});
