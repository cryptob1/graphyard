import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliRequestTimeoutMs } from '../src/cli/context.js';

// 2026-09-27: the full work snapshot took ~31 s at 19 MB, so the CLI's 30 s request bound failed every
// read of it, worker sync and complete included, stalling submissions for the whole fleet (GY-864 bounds the reads).
test('unit:cli-request-timeout-covers-snapshot — one CLI request waits long enough for a large work snapshot', () => {
  assert.ok(cliRequestTimeoutMs >= 120_000, `the CLI request bound is ${cliRequestTimeoutMs} ms`);
});
