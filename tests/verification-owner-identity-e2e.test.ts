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

// The same private-root composition the normal merge trial uses, with its bound command case.
test('e2e:verification-owner-identity — the bound case executes the real interrupted reservation regression in a private root', { timeout: 180_000 }, async () => {
  const root = join(import.meta.dirname, '..'), file = 'e2e/cases/verification-owner-identity.json';
  const definition = parseCase(file, readFileSync(join(root, file), 'utf8'));
  const home = await temporaryDirectory('verification-owner-container', root);
  const environment = { ...trialEnvironment(), HOME: home, TMPDIR: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin' };
  const session = confinedSession(trialContainerWords([home, root], trialContainerDependencies(root)), environment);
  let report;
  try {
    report = await runCases([{ file, definition }], { root, url: 'http://unused.invalid', token: 'fixture-token',
      artifactsDirectory: await temporaryDirectory('verification-owner-artifacts'), processRunner: session.run, hostEnvironment: environment });
  } finally { await session.close(); }
  assert.equal(report.cases[0]?.outcome, 'pass', JSON.stringify(report.cases[0]));
});
