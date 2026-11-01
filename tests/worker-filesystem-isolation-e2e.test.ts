import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCase } from '../src/e2e/case.js';
import { runCases } from '../src/e2e/runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

test('e2e:worker-filesystem-isolation — the bound command case runs the real host-write, deletion and socket regressions', { timeout: 180_000 }, async () => {
  const root = join(import.meta.dirname, '..');
  const file = 'e2e/cases/worker-filesystem-isolation.json';
  const definition = parseCase(file, readFileSync(join(root, file), 'utf8'));
  const report = await runCases([{ file, definition }], {
    root, url: 'http://unused.invalid', token: 'fixture-token',
    artifactsDirectory: await temporaryDirectory('fs-e2e'),
  });
  assert.equal(report.cases[0]?.outcome, 'pass', JSON.stringify(report.cases[0]?.failingStep));
});
