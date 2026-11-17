import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTests } from './helpers/run-tests.js';

test('unit:test-browser-tests-human-decisions-spec-ts-pinned — answering survives a delayed pre-answer poll', async () => {
  const suite = await runTests({ browser: true, args: ['browser-tests/human-decisions.spec.ts', '--workers=2'], stdio: 'pipe' });
  assert.equal(suite.code, 0, `${suite.stdout}\n${suite.stderr}`);
  const regression = await runTests({ browser: true, args: ['--config', 'tests/browser/playwright.config.ts', 'human-decisions-stale-poll'], stdio: 'pipe' });
  assert.equal(regression.code, 0, `${regression.stdout}\n${regression.stderr}`);
  assert.match(regression.stdout, /1 passed/);
});
