import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { renderHelp } from '../src/cli/index.js';
// @ts-expect-error Dependency-free documentation script.
import { capabilities, cliSurface, documentation, documentedRoutes, expandPath, gateNames, httpRoutes, missing, parsedFlags, proofFamilies, refusalTriggers, serverEnvironment, sourceEnvironment, surface, workCommands } from '../scripts/docs-coverage.mjs';

/**
 * Condensing the guides may remove repetition and rationale, never a name a reader has to be
 * able to find. Each set below is extracted from the code that defines it, so a surface added
 * in source fails this inventory until the documentation names it.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const help = renderHelp();

test('integration:docs-coverage every CLI command and flag, server and source environment variable, capability, gate, proof family, refusal trigger, work command and HTTP route appears in the documentation', () => {
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
  for (const command of ['create', 'claim', 'submit', 'evidence', 'autosettle', 'autoscope', 'revoke']) assert.ok(workCommands(root).includes(command), `the engine defines ${command}`);
});

test('integration:docs-coverage HTTP routes are extracted from the route modules, and a route the guides stop spelling is reported', () => {
  const routes = httpRoutes(root);
  // String paths, a captured segment, an alternation and an optional group all become concrete paths.
  for (const route of ['GET /healthz', 'POST /api/intake', 'POST /api/work/*/lead-ruling', 'POST /api/work/*/*', 'POST /api/delivery/rollback-settle', 'GET /api/analytics/flow', 'GET /api/analytics/flow/export', 'POST /api/proof-grants/*/revoke', 'GET /api/attribution/manifest/*/*'])
    assert.ok(routes.includes(route), `the server registers ${route}`);
  assert.ok(routes.length >= 70, 'the extracted routes are the real ones, not an empty list');
  assert.ok(routes.every((route: string) => /^(GET|POST) \/[a-z*/-]+$/.test(route)), 'every route expanded to one concrete path');

  // The guides' compact notation covers exactly what it spells, under the method it names.
  assert.deepEqual(expandPath('/api/validation[/capacity|/attempt/REQUEST_ID]'), ['/api/validation/capacity', '/api/validation/attempt/*', '/api/validation']);
  assert.deepEqual(expandPath('/api/work/:id/merge-(acquire|cancel)'), ['/api/work/*/merge-acquire', '/api/work/*/merge-cancel']);
  assert.deepEqual(expandPath('/api/delivery/{release,approve}'), ['/api/delivery/release', '/api/delivery/approve']);
  const documented = documentedRoutes([{ text: 'Send `GET|POST /api/scenarios`, `POST /api/work/GY-N/lead-ruling` or `GET /api/delivery[/observations?environment=ID]`; `/api/intake` alone names no method.' }]);
  assert.deepEqual([...documented].sort(), ['GET /api/delivery', 'GET /api/delivery/observations', 'GET /api/scenarios', 'POST /api/scenarios', 'POST /api/work/*/lead-ruling']);

  // The loss the reviewer of GY-80 caught by hand: both HTTP-only mutations gone from every page.
  const stripped = documentation(root).map((page: { path: string; text: string }) => ({ ...page, text: page.text.replace(/POST \/api\/intake|POST \/api\/work\/:id\/lead-ruling/g, '') }));
  const lost = routes.filter((route: string) => !documentedRoutes(stripped).has(route));
  assert.deepEqual(lost, ['POST /api/intake', 'POST /api/work/*/lead-ruling']);
});

test('integration:docs-coverage options the help omits and variables the server never reads are extracted, and losing one is reported', () => {
  // `parseArgs` accepts these; the rendered help prints none of them.
  const flags = parsedFlags(root);
  for (const flag of ['--browser-executable', '--merge-method', '--no-auto-merge', '--cli-path']) {
    assert.ok(flags.includes(flag), `the CLI parses ${flag}`);
    assert.ok(!cliSurface(help).flags.includes(flag), `${flag} is reachable only through the parsed options`);
  }
  // Read by the CLI, a runner container or a test run: outside the server's import graph.
  const variables = sourceEnvironment(root), server = serverEnvironment(root);
  for (const name of ['GRAPHYARD_REQUEST_ID', 'GRAPHYARD_HOST_ID', 'GRAPHYARD_TARGET_URL', 'GRAPHYARD_TEST_PORT']) {
    assert.ok(variables.includes(name), `source names ${name}`);
    assert.ok(!server.includes(name), `${name} is out of the server's reach`);
  }
  assert.ok(variables.every((name: string) => /^GRAPHYARD_[A-Z0-9]+(_[A-Z0-9]+)*$/.test(name)), 'a prefix the code builds names from is not a variable');

  // The losses the reviewer of GY-80 caught by hand: stripped from every page, each is reported.
  const lost = ['GRAPHYARD_REQUEST_ID', 'GRAPHYARD_HOST_ID', 'GRAPHYARD_TARGET_URL', 'GRAPHYARD_TEST_PORT', '--browser-executable'];
  const stripped = documentation(root).map((page: { path: string; text: string }) => ({ ...page, text: lost.reduce((text, name) => text.replaceAll(name, ''), page.text) }));
  const gaps = missing(root, help, stripped);
  for (const name of lost) assert.ok(gaps.some((gap: string) => gap.includes(` ${name} is documented nowhere`)), `${name} is reported once no page names it`);

  // A longer name does not document a shorter one: `--deployment-url` is not `--deployment`.
  const prefixed = missing(root, help, [{ path: 'only.md', text: '`--deployment-url` and `GRAPHYARD_TOKEN_FILE`' }]);
  assert.ok(prefixed.includes('cli flag --deployment is documented nowhere'));
  assert.ok(prefixed.includes('environment variable GRAPHYARD_TOKEN is documented nowhere'));
  assert.ok(!prefixed.includes('cli flag --deployment-url is documented nowhere'));
});

test('integration:docs-coverage the generated index pages stay consistent with the pages they list', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [join(root, 'scripts/check-docs.mjs')], { cwd: root });
  assert.match(stdout, /generated indexes resolve/);
  const pages = documentation(root);
  assert.ok(pages.length > 30, 'the corpus is read');
  for (const page of pages) assert.ok(page.text.length > 0, `${page.path} is not empty`);
});
