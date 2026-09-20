import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { renderHelp } from '../src/cli/index.js';
// @ts-expect-error Dependency-free documentation script.
import { capabilities, cliSurface, documentation, gateNames, missing, proofFamilies, refusalTriggers, serverEnvironment, surface } from '../scripts/docs-coverage.mjs';

/**
 * Condensing the guides may remove repetition and rationale, never a name a reader has to be
 * able to find. Each set below is extracted from the code that defines it, so a surface added
 * in source fails this inventory until the documentation names it.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const help = renderHelp();

test('integration:docs-coverage every CLI command and flag, server environment variable, capability, gate, proof family and refusal trigger appears in the documentation', () => {
  const gaps = missing(root, help);
  assert.deepEqual(gaps, [], gaps.join('\n'));
  assert.ok(surface(root, help).length >= 150, 'the extracted surface is the real one, not an empty list');
});

test('integration:docs-coverage the surface is extracted from the code that defines it', () => {
  const { commands, flags } = cliSurface(help);
  for (const command of ['claim', 'complete', 'watch', 'sync', 'master merge', 'grants grant', 'operator-agent rotate'])
    assert.ok(commands.includes(command), `the CLI help defines ${command}`);
  for (const flag of ['--token-stdin', '--previous-worker-stopped', '--allow-overlap', '--attestation'])
    assert.ok(flags.includes(flag), `the CLI help defines ${flag}`);
  const environment = serverEnvironment(root);
  for (const name of ['GRAPHYARD_PRINCIPALS', 'DATABASE_URL', 'GITHUB_WEBHOOK_SECRET', 'GRAPHYARD_MAX_REVIEWERS', 'GRAPHYARD_GENERATED_FILES'])
    assert.ok(environment.includes(name), `the server reads ${name}`);
  assert.deepEqual(gateNames(root), ['ready', 'build', 'review', 'test', 'acceptance', 'merge']);
  assert.deepEqual(proofFamilies(root), ['unit', 'integration', 'e2e', 'manual']);
  assert.deepEqual(refusalTriggers(root), ['lease-loss', 'evidence-policy-conflict', 'security-concern', 'requirement-weakening']);
  for (const capability of ['intent:create', 'policy:bootstrap', 'decision:approve']) assert.ok(capabilities(root).includes(capability));
});

test('integration:docs-coverage the generated index pages stay consistent with the pages they list', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [join(root, 'scripts/check-docs.mjs')], { cwd: root });
  assert.match(stdout, /generated indexes resolve/);
  const pages = documentation(root);
  assert.ok(pages.length > 30, 'the corpus is read');
  for (const page of pages) assert.ok(page.text.length > 0, `${page.path} is not empty`);
});
