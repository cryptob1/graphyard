import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCase } from '../src/e2e/case.js';
import { runCases } from '../src/e2e/runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { trialContainerDependencies, trialContainerWords } from '../src/merge-writer/trial-container.js';
import { trialEnvironment } from '../src/merge-writer/trial.js';
import { confinedSession } from '../src/e2e/steps.js';

for (const id of ['worker-filesystem-isolation', 'worker-reparenting'])
test(`e2e:${id} — the bound command case runs the real composed worker regressions`, { timeout: 180_000 }, async () => {
  const root = join(import.meta.dirname, '..');
  const file = `e2e/cases/${id}.json`;
  const definition = parseCase(file, readFileSync(join(root, file), 'utf8'));
  const scratch = await temporaryDirectory('fs-container', root);
  const environment = { ...trialEnvironment(), HOME: scratch, TMPDIR: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin' };
  const session = confinedSession(trialContainerWords([root, scratch], trialContainerDependencies(root)), environment);
  let report;
  try { report = await runCases([{ file, definition }], {
    root, url: 'http://unused.invalid', token: 'fixture-token',
    artifactsDirectory: await temporaryDirectory('fs-e2e'), processRunner: session.run, hostEnvironment: environment,
  }); } finally { await session.close(); }
  assert.equal(report.cases[0]?.outcome, 'pass', JSON.stringify(report.cases[0]));
});
