import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupFromZeroChecks, setupLine, setupSteps, type SetupFromZeroInput } from '../src/setup-from-zero.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { detectStack } from '../src/onboarding.js';
import { appManifest, reviewerAppManifest } from '../src/github-setup.js';
import { frameworkReportFormats } from '../src/readiness.js';
import { reviewerCommand } from '../src/cli/master-reviewer.js';
import type { MasterConfig } from '../src/master.js';
import { revertApproverEnv } from '../src/install/index.js';
import { composeBundle, PRIVATE_KEY_CONTAINER_PATH, REVERT_APPROVER_KEY_CONTAINER_PATH, type AdapterContext } from '../src/install/adapters.js';

/**
 * GY-1352 AC-3: `graphyard doctor` reports each prerequisite docs/setup-from-zero.md depends on as a
 * named pass/fail line naming the checklist step that fixes it. A fixture installation with every
 * prerequisite in place passes every line; removing each prerequisite in turn fails exactly its line.
 */
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const appId = 7001;
const protection = {
  required_status_checks: { strict: false, checks: [{ context: 'test', app_id: 15368 }, { context: 'Graphyard / merge', app_id: appId }, { context: 'graphyard/landable', app_id: appId }] },
  enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
  required_pull_request_reviews: { required_approving_review_count: 0 },
};
const status = () => ({
  actor: { role: 'admin' }, github: true, githubAppId: appId, githubRepository: { id: 1, fullName: 'owner/scratch' }, baseBranch: 'main',
  appPermissions: { verifiedAt: '2026-10-06T00:00:00.000Z', missing: [], attention: [] }, reviewerApps: [] as unknown[],
});
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const writePrivate = async (file: string, text: string) => { await writeFile(file, text); await chmod(file, 0o600); };

/** A fresh installation with every prerequisite the checklist names in place. */
async function installation() {
  const directory = await temporaryDirectory('doctor-setup-from-zero');
  const root = join(directory, 'repo'), environments = join(directory, 'agents'), credentials = join(directory, 'credentials');
  await mkdir(join(root, '.graphyard'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'git@github.com:owner/scratch.git');
  git('-c', 'user.email=fixture@example.test', '-c', 'user.name=fixture', 'commit', '-q', '--allow-empty', '-m', 'init');
  await writePrivate(join(root, '.graphyard/connection.json'), json({ url: 'http://127.0.0.1:4310', cliPath: launcher, hostId: 'fixture', token: 'x'.repeat(40) }));
  await mkdir(credentials, { recursive: true, mode: 0o700 });
  await writePrivate(join(credentials, 'reviewer.json'), json({ appId: 7002 }));
  await writePrivate(join(root, '.graphyard/master.json'), json({ reviewer: { appId: 7002, installationId: 9, slug: 'scratch-reviewer', credentialFile: join(credentials, 'reviewer.json') } }));
  const claude = join(environments, 'claude-a'), codex = join(environments, 'codex-a');
  await mkdir(claude, { recursive: true }); await mkdir(codex, { recursive: true });
  await writePrivate(join(claude, '.credentials.json'), json({ claudeAiOauth: { accessToken: 'fixture', refreshToken: 'fixture' } }));
  await writePrivate(join(claude, 'settings.json'), json({ skipDangerousModePermissionPrompt: true }));
  await writePrivate(join(claude, '.claude.json'), json({ hasCompletedOnboarding: true }));
  await writePrivate(join(codex, 'auth.json'), json({ tokens: { access_token: 'fixture' } }));
  return { directory, root, environments, claude, codex, credentials };
}

type Fixture = Awaited<ReturnType<typeof installation>>;
const input = (fixture: Fixture, overrides: Partial<SetupFromZeroInput> = {}): SetupFromZeroInput => ({
  root: fixture.root, env: {}, status: status(), environments: fixture.environments, sandbox: () => null,
  github: (_command, args) => args[1].endsWith('/protection') ? JSON.stringify(protection) : args[1].includes('rulesets') ? '[]' : '{}', ...overrides,
});
const lineOf = async (setup: SetupFromZeroInput, id: string) => {
  const checks = await setupFromZeroChecks(setup);
  const check = checks.find(entry => entry.id === id);
  assert.ok(check, `doctor reports a ${id} line`);
  return { check, checks };
};

test('unit:doctor-setup-from-zero — a complete installation passes every named line; each missing prerequisite fails exactly its own line, naming the checklist step that fixes it', async () => {
  const fixture = await installation();
  const complete = await setupFromZeroChecks(input(fixture));
  assert.deepEqual(complete.map(check => check.id), ['control-plane', 'credentials-file', 'github-app', 'reviewer-app', 'branch-protection', 'agent-environment:claude-a', 'agent-environment:codex-a', 'worker-sandbox']);
  assert.deepEqual(complete.filter(check => check.status !== 'pass').map(setupLine), [], 'a complete installation passes every line');

  const cases: [string, string, keyof typeof setupSteps, RegExp, (fixture: Fixture) => Promise<Partial<SetupFromZeroInput> | void>][] = [
    ['control plane unreachable', 'control-plane', 'install', /not reachable: connect ECONNREFUSED/, async () => ({ status: null, failure: 'connect ECONNREFUSED 127.0.0.1:4310' })],
    ['credentials file absent', 'credentials-file', 'install', /connection\.json does not exist/, async f => { await rm(join(f.root, '.graphyard/connection.json')); }],
    ['credentials file not 0600', 'credentials-file', 'install', /has mode 0644; it must be 0600/, async f => { await chmod(join(f.root, '.graphyard/connection.json'), 0o644); }],
    ['GitHub App unbound', 'github-app', 'app', /no bound GitHub App/, async () => ({ status: { ...status(), github: false, githubAppId: null } })],
    ['App permissions short', 'github-app', 'app', /missing permissions: deployments read/, async () => ({ status: { ...status(), appPermissions: { verifiedAt: '2026-10-06T00:00:00.000Z', missing: [{ permission: 'deployments', required: 'read' }], attention: [] } } })],
    ['reviewer App unbound', 'reviewer-app', 'reviewer', /no reviewer App/, async f => { await writePrivate(join(f.root, '.graphyard/master.json'), json({})); }],
    ['branch unprotected', 'branch-protection', 'protection', /protection is unreadable/, async () => ({ github: () => { throw new Error('gh: Branch not protected (HTTP 404)'); } })],
    ['protection off policy', 'branch-protection', 'protection', /Required check Graphyard \/ merge is not bound to Graphyard App 7001; Administrator enforcement is disabled/,
      async () => ({ github: (_command: string, args: string[]) => args[1].endsWith('/protection') ? JSON.stringify({ ...protection, enforce_admins: { enabled: false }, required_status_checks: { strict: false, checks: [] } }) : '{}' })],
    ['Claude not logged in', 'agent-environment:claude-a', 'environments', /not logged in/, async f => { await rm(join(f.claude, '.credentials.json')); }],
    ['Claude consent not given', 'agent-environment:claude-a', 'environments', /bypass-permissions consent is not recorded/, async f => { await writePrivate(join(f.claude, 'settings.json'), json({})); }],
    ['Claude first run not complete', 'agent-environment:claude-a', 'environments', /first-run onboarding is not complete/, async f => { await writePrivate(join(f.claude, '.claude.json'), json({})); }],
    ['Codex not logged in', 'agent-environment:codex-a', 'environments', /not logged in/, async f => { await rm(join(f.codex, 'auth.json')); }],
    ['Codex folder trust unrecordable', 'agent-environment:codex-a', 'environments', /config\.toml is not writable/, async f => { await writePrivate(join(f.codex, 'config.toml'), ''); await chmod(join(f.codex, 'config.toml'), 0o400); }],
    ['no agent environment', 'agent-environments', 'environments', /no agent environment/, async f => ({ environments: join(f.directory, 'none') })],
    ['sandbox cannot write the shared Git paths', 'worker-sandbox', 'sandbox', /the worker confinement cannot write the shared Git paths: bubblewrap \(bwrap\) is not installed/, async () => ({ sandbox: () => 'bubblewrap (bwrap) is not installed' })],
  ];
  // Lines judged from a missing prerequisite's answer fail with it, saying so; nothing else may.
  const dependents: Record<string, string[]> = { 'control plane unreachable': ['github-app', 'branch-protection'], 'GitHub App unbound': ['branch-protection'] };
  for (const [name, id, step, detail, remove] of cases) {
    const missing = await installation();
    const overrides = (await remove(missing)) ?? {};
    // A process running as root can write a 0400 file, so that one case asserts only where it can.
    if (name === 'Codex folder trust unrecordable' && process.getuid?.() === 0) continue;
    const { check, checks } = await lineOf(input(missing, overrides), id);
    assert.equal(check.status, 'fail', `${name}: the ${id} line fails`);
    assert.match(check.detail, detail, `${name}: the ${id} line says what is missing`);
    assert.equal(check.step, setupSteps[step], `${name}: the ${id} line names the checklist step that fixes it`);
    assert.match(setupLine(check), new RegExp(`^FAIL ${id}: .*\\(fix: docs/setup-from-zero\\.md step \\d+ \\(`), `${name}: the printed line is named and points at the checklist`);
    const others = checks.filter(entry => entry.id !== id && entry.status === 'fail' && !(dependents[name] ?? []).includes(entry.id));
    assert.deepEqual(others.map(setupLine), [], `${name}: only the missing prerequisite fails`);
  }
});

test('unit:doctor-setup-from-zero — graphyard doctor prints the named lines for a fixture installation, and a missing prerequisite fails exactly its line', async () => {
  const fixture = await installation();
  const shims = join(fixture.directory, 'bin');
  await mkdir(shims);
  // gh answers the protection read as a repository admin would; bwrap's confinement probe succeeds.
  await writeFile(join(shims, 'gh'), `#!/usr/bin/env node\nconst path = process.argv[3] ?? '';\nprocess.stdout.write(path.endsWith('/protection') ? ${JSON.stringify(JSON.stringify(protection))} : path.includes('rulesets') ? '[]' : '{}');\n`, { mode: 0o755 });
  await writeFile(join(shims, 'bwrap'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  let reviewerApps: unknown[] = [];
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/status') return response.end(JSON.stringify({ ...status(), reviewerApps }));
    if (request.url === '/api/validation/definitions') return response.end(JSON.stringify({ definitions: [] }));
    response.statusCode = 404; response.end('{}');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await writePrivate(join(fixture.root, '.graphyard/connection.json'), json({ url, cliPath: launcher, hostId: 'fixture', token: 'x'.repeat(40) }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GRAPHYARD_')));
  const doctor = () => new Promise<any>((done, fail) => {
    const child = spawn(process.execPath, [launcher, 'doctor'], { cwd: fixture.root, env: { ...env, PATH: `${shims}:${process.env.PATH}`, GRAPHYARD_AGENT_ENVIRONMENTS: fixture.environments }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', fail);
    child.on('close', code => { try { assert.equal(code, 0, err); done(JSON.parse(out)); } catch (error) { fail(error); } });
  });
  try {
    const complete = await doctor();
    assert.deepEqual(complete.setupFromZero.lines.filter((line: string) => !line.startsWith('PASS ')), [], 'every prerequisite of the complete fixture passes');
    assert.equal(complete.setupFromZero.ready, true);
    await writePrivate(join(fixture.root, '.graphyard/master.json'), json({}));
    const missing = await doctor();
    assert.equal(missing.setupFromZero.ready, false);
    assert.deepEqual(missing.setupFromZero.lines.filter((line: string) => line.startsWith('FAIL ')), [`FAIL reviewer-app: no reviewer App: GRAPHYARD_REVIEWER_APPS is empty and .graphyard/master.json binds no reviewer (fix: ${setupSteps.reviewer})`]);
    reviewerApps = [{ id: 'scratch-reviewer', runtime: 'claude', appId: 7002, botUserId: 1 }];
    assert.equal((await doctor()).setupFromZero.ready, true, 'a reviewer App the server serves counts as bound');
  } finally { server.close(); }
});

test('unit:doctor-setup-from-zero — a scratch repository whose tests run on Node\'s built-in runner is detected, so test-formats does not ask for a suite it already has', () => {
  const scan = (test: string) => detectStack({ files: ['package.json'], contents: { 'package.json': JSON.stringify({ name: 'scratch', scripts: { test } }) } });
  assert.deepEqual(scan('node --test').frameworks, ['node:test']);
  assert.deepEqual(scan('node --import tsx --test tests/').frameworks, ['node:test']);
  assert.deepEqual(scan('node scripts/run.js && echo --test').frameworks, [], 'a --test outside the node command is not the runner');
  assert.equal(frameworkReportFormats['node:test'].format, 'junit-xml-v1');
});

test('unit:doctor-setup-from-zero — a local Compose install registers its App on the loopback origin with the webhook off; any other plain-HTTP origin is still refused', () => {
  const local = appManifest('owner/scratch', 'http://127.0.0.1:4310', 'http://127.0.0.1:4311');
  assert.equal(local.url, 'http://127.0.0.1:4310');
  assert.deepEqual(local.hook_attributes, { url: 'http://127.0.0.1:4310/api/github/webhook', active: false });
  assert.equal(appManifest('owner/scratch', 'https://graphyard.example', 'http://127.0.0.1:4311').hook_attributes.active, true);
  assert.equal(reviewerAppManifest('claude', 'owner/scratch', 'http://localhost:4310', 'http://127.0.0.1:4311').url, 'http://localhost:4310');
  assert.throws(() => appManifest('owner/scratch', 'http://graphyard.example', 'http://127.0.0.1:4311'), /HTTPS origin/);
});

test('unit:doctor-setup-from-zero — master reviewer setup registers a reviewer App on a Compose install\'s loopback origin, and refuses any other plain-HTTP origin before opening its page', async () => {
  const fixture = await installation();
  const master = { url: 'http://127.0.0.1:4310', repository: 'owner/scratch', credentialFile: join(fixture.credentials, 'master', 'master.token') } as unknown as MasterConfig;
  const before = new Set(process.listeners('SIGINT'));
  const log = console.log; let page = '';
  console.log = (line: string) => { page = line; };
  try { await reviewerCommand(fixture.root, master, ['setup', '--port', '0'], () => {}); } finally {
    console.log = log;
    // The command serves until Ctrl+C; its own stop handler closes the page server.
    for (const stop of process.listeners('SIGINT').filter(listener => !before.has(listener))) { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); (stop as () => void)(); }
  }
  assert.match(page, /^Open http:\/\/127\.0\.0\.1:\d+ in your browser and register the reviewer App/);
  await assert.rejects(reviewerCommand(fixture.root, { ...master, url: 'http://graphyard.example' }, ['setup', '--port', '0'], () => {}), /HTTPS origin \(or http:\/\/ on loopback/);
});

test('unit:doctor-setup-from-zero — install sets the reviewer App as the main guard\'s revert approver, and Compose mounts its key as a file instead of the env file', async () => {
  const fixture = await installation();
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nreviewer\n-----END RSA PRIVATE KEY-----\n';
  assert.deepEqual(await revertApproverEnv({ directory: fixture.credentials, reviewers: [] }), [], 'no reviewer App, no revert approver');
  await writePrivate(join(fixture.credentials, 'github-reviewer-claude.json'), json({ appId: 7002, installationId: 9, slug: 'scratch-reviewer', privateKey: pem, reviewer: 'claude', repository: 'owner/scratch' }));
  const values = await revertApproverEnv({ directory: fixture.credentials, reviewers: [{ name: 'claude', appId: 7002, botUserId: 1 }] });
  assert.deepEqual(values.map(value => [value.name, value.secret ? '<secret>' : value.value]), [['GRAPHYARD_REVERT_APPROVER_APP_ID', '7002'], ['GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID', '9'], ['GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY', '<secret>']]);
  const context = { workdir: '/srv/graphyard', databasePassword: 'p'.repeat(32), installId: 'fixture', image: 'graphyard:fixture', port: 4310 } as unknown as AdapterContext;
  const files = composeBundle(context, [{ name: 'GITHUB_PRIVATE_KEY', value: 'app-key\nline', secret: true }, ...values], 'loopback');
  const file = (name: string) => files.find(entry => entry.path === `/srv/graphyard/${name}`);
  const environment = file('server.env')!.content;
  assert.ok(!environment.includes('PRIVATE KEY-----'), 'the raw PEM never reaches the env file');
  assert.match(environment, new RegExp(`^GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY_FILE=${REVERT_APPROVER_KEY_CONTAINER_PATH}$`, 'm'));
  assert.match(environment, /^GRAPHYARD_REVERT_APPROVER_APP_ID=7002$/m);
  assert.equal(file('revert-approver-private-key.pem')?.content, pem);
  assert.equal(file('revert-approver-private-key.pem')?.mode, 0o600);
  assert.match(file('compose.yaml')!.content, new RegExp(`volumes: \\["\\./github-private-key\\.pem:${PRIVATE_KEY_CONTAINER_PATH}:ro", "\\./revert-approver-private-key\\.pem:${REVERT_APPROVER_KEY_CONTAINER_PATH}:ro"\\]`));
});
