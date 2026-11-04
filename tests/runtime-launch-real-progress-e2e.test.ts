import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCase } from '../src/e2e/case.js';
import { runCases } from '../src/e2e/runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

test('e2e:runtime-launch-real-progress — the bound command case exercises real terminal requests, DNS and failed-launch releases', { timeout: 150_000 }, async () => {
  const root = join(import.meta.dirname, '..'), file = 'e2e/cases/runtime-launch-real-progress.json';
  const definition = parseCase(file, readFileSync(join(root, file), 'utf8'));
  // The merge writer runs command cases in its private-root trial. This case's
  // nested namespaces reproduce /run masking and retain the real socket policy.
  const report = await runCases([{ file, definition }], {
    root, url: 'http://unused.invalid', token: 'fixture-token', artifactsDirectory: await temporaryDirectory('runtime-e2e'),
  });
  assert.equal(report.cases[0]?.outcome, 'pass', JSON.stringify(report.cases[0]));
});
