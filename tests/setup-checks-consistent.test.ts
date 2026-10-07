import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as install from '../src/install/index.js';
import { buildProposal, collectScanInput, detectDeploy, detectStack, discover, proposeDelivery } from '../src/onboarding.js';
import { applyProposal } from '../src/repository-setup.js';
import * as setup from '../src/setup-from-zero.js';
import { setupFromZeroChecks, setupSteps } from '../src/setup-from-zero.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1412 AC-2 (pilot gaps G6, G7, G10, G11): install preflight checks the gh scopes each provider
 * needs; onboarding honours GRAPHYARD_CONFIG_HOME and creates the credential files its profiles
 * name; doctor tells a reachable plane with no credential from an unreachable one; and doctor and
 * `init --scan` report frameworks from one detector.
 */
const launcher = join(import.meta.dirname, '../bin/graphyard.mjs');
// Namespace imports, so a test against code without these symbols fails as a test case, not at load.
const githubCliPreflight: typeof install.githubCliPreflight = (...args) => install.githubCliPreflight(...args);
const setupNext: typeof setup.setupNext = (...args) => setup.setupNext(...args);
const signedIn = (scopes: string) => ({ code: 0, stdout: `github.com\n  ✓ Logged in to github.com account pilot (keyring)\n  - Token scopes: ${scopes}\n` });

async function repository(files: Record<string, string>) {
  const root = join(await temporaryDirectory('setup-checks'), 'repo');
  await mkdir(root, { recursive: true });
  for (const [path, text] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', 'git@github.com:owner/scratch.git');
  return root;
}

test('unit:setup-checks-consistent — install preflight checks gh scopes per provider; compose needs no admin:repo_hook', () => {
  const compose = githubCliPreflight('compose', signedIn("'gist', 'read:org', 'repo'"), 'owner/scratch');
  assert.equal(compose.ok, true); assert.match(compose.detail, /compose polls GitHub, so it needs no admin:repo_hook/);
  const railway = githubCliPreflight('railway', signedIn("'gist', 'read:org', 'repo'"), 'owner/scratch');
  assert.equal(railway.ok, false); assert.match(railway.detail, /lacks scope admin:repo_hook/); assert.equal(railway.fix, 'Run: gh auth refresh --scopes repo,admin:repo_hook');
  assert.equal(githubCliPreflight('railway', signedIn("'admin:repo_hook', 'repo'"), 'owner/scratch').ok, true);
  const noRepo = githubCliPreflight('compose', signedIn("'gist'"), 'owner/scratch');
  assert.equal(noRepo.ok, false); assert.match(noRepo.detail, /lacks scope repo/);
  const absent = githubCliPreflight('compose', { code: 1, stdout: '' }, 'owner/scratch');
  assert.equal(absent.ok, false); assert.match(absent.fix!, /gh auth login --scopes repo \(/); assert.doesNotMatch(absent.fix!, /--scopes repo,admin:repo_hook/);
  assert.equal(githubCliPreflight('hetzner', { code: 0, stdout: 'Logged in to github.com account pilot' }, 'owner/scratch').ok, true, 'a login whose scopes gh does not list is not refused for them');
});

test('unit:setup-checks-consistent — onboarding puts worker credentials under GRAPHYARD_CONFIG_HOME and init --apply creates the files its profiles name', async () => {
  const root = await repository({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  const configHome = await temporaryDirectory('setup-checks-config');
  const previous = process.env.GRAPHYARD_CONFIG_HOME;
  process.env.GRAPHYARD_CONFIG_HOME = configHome;
  try {
    const proposal = buildProposal(await collectScanInput(root), { repository: 'owner/scratch', runtimes: ['codex'] });
    const file = proposal.profiles.workers[0].credentialFile;
    assert.equal(file, join(configHome, 'workers', 'codex-primary.token'));

    await applyProposal(root, proposal, { url: 'http://127.0.0.1:4310' });
    await assert.rejects(stat(file), /ENOENT/, 'a library caller that did not ask writes no credential');

    const first = await applyProposal(root, proposal, { url: 'http://127.0.0.1:4310', writeCredentials: true });
    assert.ok(first.applied.includes('codex-primary credential file'));
    const registry = JSON.parse(await readFile(join(root, '.graphyard/principals.json'), 'utf8'));
    assert.equal((await readFile(file, 'utf8')).trim(), registry.principals.find((entry: any) => entry.id === 'worker-1').token);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const second = await applyProposal(root, proposal, { url: 'http://127.0.0.1:4310', writeCredentials: true });
    assert.ok(second.unchanged.includes('codex-primary credential file'), 'an existing credential is kept');
  } finally { if (previous === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = previous; }
});

test('unit:setup-checks-consistent — a reachable plane with no credential is reported as reachable, credential missing', async () => {
  const base = { root: '/nonexistent', env: {}, status: null, failure: 'Set GRAPHYARD_TOKEN to your individual credential', environments: '/nonexistent', sandbox: () => null };
  const plane = async (reachable: boolean, env = {}) => (await setupFromZeroChecks({ ...base, env, reachable })).find(check => check.id === 'control-plane')!;
  assert.match((await plane(true)).detail, /^reachable, credential missing: Set GRAPHYARD_TOKEN/);
  assert.match((await plane(true, { GRAPHYARD_TOKEN: 'x' })).detail, /^reachable, credential refused/);
  assert.match((await plane(false)).detail, /^not reachable: /);
  assert.equal((await plane(true)).step, setupSteps.install);

  const checks = await setupFromZeroChecks({ ...base, reachable: true });
  const readiness = (first: string) => ({ next: 'Set GRAPHYARD_URL and GRAPHYARD_TOKEN …', items: [{ id: 'repository', status: first === 'repository' ? 'missing' : 'ready' }, { id: 'server', status: 'missing' }] });
  assert.match(setupNext(readiness('server'), checks), /^FAIL control-plane: reachable, credential missing: .*\(fix: docs\/setup-from-zero\.md step 3/);
  assert.equal(setupNext(readiness('repository'), checks), 'Set GRAPHYARD_URL and GRAPHYARD_TOKEN …', 'an earlier step keeps its own recovery');
});

test('unit:setup-checks-consistent — graphyard doctor against a live plane without a credential says reachable and names step 3', async () => {
  const root = await repository({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/healthz' ? 200 : 401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.url === '/healthz' ? { ok: true } : { error: 'unauthenticated' }));
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GRAPHYARD_')) delete env[key];
    env.GRAPHYARD_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    env.GRAPHYARD_AGENT_ENVIRONMENTS = await temporaryDirectory('setup-checks-agents');
    const { stdout } = await promisify(execFile)(process.execPath, [launcher, 'doctor'], { cwd: root, env });
    const doctor = JSON.parse(stdout);
    const line = doctor.setupFromZero.lines.find((entry: string) => entry.includes(' control-plane: '));
    assert.match(line, /^FAIL control-plane: reachable, credential missing/);
    assert.equal(doctor.next, line, 'next names the step that connects the plane, not init --url SERVER --token-stdin');
    assert.deepEqual(doctor.discovered.frameworks, ['node:test'], 'doctor reports the framework init --scan detects');
  } finally { await new Promise(accept => server.close(accept)); }
});

test('unit:setup-checks-consistent — doctor and init --scan share one framework detector', async () => {
  for (const files of <Record<string, string>[]>[
    { 'package.json': JSON.stringify({ scripts: { test: 'node --import tsx --test tests/' }, devDependencies: { vitest: '1' } }) },
    { 'package.json': JSON.stringify({ devDependencies: { mocha: '1', '@playwright/test': '1' } }) },
    { 'pyproject.toml': '[tool.pytest.ini_options]\n' },
  ]) {
    const root = await repository(files);
    const scanned = detectStack(await collectScanInput(root)).frameworks;
    assert.ok(scanned.length, `the fixture ${Object.keys(files)[0]} has a framework`);
    assert.deepEqual((await discover(root)).frameworks, scanned);
  }
});

test('unit:setup-checks-consistent — a repository with no deploy target defaults to per-pr delivery; one with a target keeps release candidates', async () => {
  const delivery = async (files: Record<string, string>) => {
    const input = await collectScanInput(await repository(files)), stack = detectStack(input);
    return proposeDelivery(input, detectDeploy(input, stack), stack).mode;
  };
  const pkg = JSON.stringify({ scripts: { test: 'node --test' } });
  assert.equal(await delivery({ 'package.json': pkg }), 'per-pr');
  assert.equal(await delivery({ 'package.json': pkg, 'railway.json': '{}' }), 'release-candidate');
});
