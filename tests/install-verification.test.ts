import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { GitHub } from '../src/github.js';
import { applyInstall, buildPlan, prepareInstall, type InstallDependencies } from '../src/install/index.js';
import { verifyDelivery, VERIFICATION_CHECK } from '../src/install/github.js';
import { emptyObservation, type ProviderAdapter } from '../src/install/adapters.js';
import { detectHerdr, detectRuntimes, masterRuntime, reviewerProfiles, workerProfiles } from '../src/install/runtimes.js';
import { ensureTokens, installDirectory, plannedPrincipals, prepareInstallDirectory, Vault } from '../src/install/secrets.js';
import { fakeTransport, type Transport } from '../src/install/transport.js';
import { appKey, githubResponses, harness, temporaryRepository, GRAPHYARD_APP_ID, WEBHOOK_SECRET } from './install-harness.js';

const INSTALL_ID = 'owner-project';

/** Other suites run a database in this same process; take a port the kernel says is free. */
async function freePort() {
  const { createServer } = await import('node:net');
  const probe = createServer();
  await new Promise<void>(accept => probe.listen(0, '127.0.0.1', accept));
  const port = (probe.address() as any).port;
  await new Promise<void>(accept => probe.close(() => accept()));
  return port;
}
let database: EmbeddedPostgres; let store: Store; let http: ReturnType<typeof server>; let live: string;
let root: string; let configHome: string; let tokens: Map<string, string>;
const principals = plannedPrincipals(INSTALL_ID, { workers: 2 });

const github = {
  config: { repository: 'owner/project', base: 'main', appId: GRAPHYARD_APP_ID, installationId: 500, privateKey: appKey, reviewerApps: [] },
  reviewRepository: async () => ({ id: 1, fullName: 'owner/project' }),
  reviewPermissions: async () => ({ pull_requests: 'write', issues: 'read', checks: 'write' }),
  // The permission preflight has not run in this process; status reports that rather than failing.
  permissionReport: () => null,
} as unknown as GitHub;

before(async () => {
  root = await temporaryRepository();
  configHome = await mkdtemp(join(tmpdir(), 'graphyard-verify-'));
  const directory = installDirectory(INSTALL_ID, configHome);
  await prepareInstallDirectory(directory, root);
  tokens = await ensureTokens(directory, principals, new Vault());

  const port = Number(process.env.GRAPHYARD_INSTALL_TEST_PORT ?? 0) || await freePort();
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-verify-db-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: (message: unknown) => console.error('postgres:', String(message)), postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_install');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_install`); await store.init();
  const engine = new Engine(store, [15368], 120, 'owner/project');
  http = server(engine, principals.map(principal => ({ ...principal, token: tokens.get(principal.id)! })), github);
  await new Promise<void>(accept => http.listen(0, '127.0.0.1', accept));
  live = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => {
  if (http) await new Promise<void>(accept => http.close(() => accept()));
  if (store) await store.close();
  if (database) await database.stop();
  await rm(root, { recursive: true, force: true });
  await rm(configHome, { recursive: true, force: true });
});

/** A provider that is already healthy: the verification under test is Graphyard's, not Docker's. */
function stubAdapter(): ProviderAdapter {
  return {
    provider: 'compose',
    preflight: async () => [{ name: 'test provider', ok: true, detail: 'a live control plane is already running' }],
    observe: async () => emptyObservation(),
    plan: () => [
      { id: 'provider.provision.database', target: 'provider', title: 'Start Postgres', state: 'create' },
      { id: 'provider.provision.app', target: 'provider', title: 'Start the Graphyard application', state: 'create' },
    ],
    provision: async () => {},
    setEnv: async () => {},
    deploy: async () => {},
    url: async () => live,
    health: async (_context, url) => { try { return ((await (await fetch(`${url}/healthz`)).json()) as any)?.ok === true; } catch { return false; } },
    logs: async () => '',
  };
}

test('the installer verifies /healthz, authenticated /api/status, and webhook delivery against a live control plane', async () => {
  const deliveries: any[] = [];
  const herdrCommands: string[][] = [];
  const transport = fakeTransport({ responses: githubResponses({ installed: false, protection: null, deliveries: [], hookConfig: null }) });
  const hybrid = (async (input: any, init: any = {}) => {
    const url = String(input);
    if (!url.startsWith('https://api.github.com')) return fetch(input, init);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/access_tokens')) return json(201, { token: 'installation-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (url.endsWith('/app/hook/config')) return json(200, { url: `${live}/api/github/webhook`, content_type: 'json' });
    if (url.includes('/app/hook/deliveries')) return json(200, deliveries);
    if (url.includes('/check-runs')) { deliveries.unshift({ id: 1, event: 'check_run', status_code: 202, delivered_at: new Date().toISOString() }); return json(201, { id: 7 }); }
    return json(404, {});
  }) as unknown as typeof fetch;

  const dependencies: InstallDependencies = {
    transport: transport as Transport, fetch: hybrid, configHome, sourceRoot: root, adapter: stubAdapter(),
    cliPath: join(root, 'package.json'), hostId: 'verification-host', wait: async () => {}, log: () => {},
    githubApp: async () => ({ appId: GRAPHYARD_APP_ID, slug: 'graphyard-owner-project', installationId: 500, privateKey: appKey, webhookSecret: WEBHOOK_SECRET }),
    detectRuntimes: async () => [
      { kind: 'claude', program: 'claude', path: '/usr/bin/claude', authenticated: true, reason: 'signed in' },
      { kind: 'codex', program: 'codex', path: '/usr/bin/codex', authenticated: true, reason: 'signed in' },
      { kind: 'gemini', program: 'gemini', path: '/usr/bin/gemini', authenticated: false, reason: 'no stored login' },
    ],
    detectHerdr: async () => ({ available: true, version: 'herdr 0.7.1', reason: 'available' }),
    runHerdr: args => { herdrCommands.push(args); return args[1] === 'config-dir' ? join(configHome, 'herdr-plugin') : ''; },
  };

  const session = await prepareInstall(root, { repository: 'owner/project', provider: 'compose', workers: 2 }, dependencies);
  const summary = await applyInstall(session, await buildPlan(session));

  assert.equal(summary.health, true, 'GET /healthz did not report a healthy database');
  assert.equal(summary.status.role, 'admin');
  assert.equal(summary.status.actor, `${INSTALL_ID}-operator`);
  assert.equal(summary.status.repository, 'owner/project');
  assert.equal(summary.status.githubAppId, GRAPHYARD_APP_ID);
  assert.equal(summary.webhook.delivered, true, summary.webhook.detail);
  assert.equal(summary.webhook.statusCode, 202);

  // Profiles: one master, one profile per worker principal, bound to a detected runtime.
  assert.equal(summary.profiles.repository.connected, true);
  assert.equal(summary.profiles.repository.herdr, true, summary.profiles.repository.detail);
  assert.equal(summary.profiles.master.configured, true, summary.profiles.master.detail);
  assert.equal(summary.profiles.master.kind, 'claude');
  assert.deepEqual(summary.profiles.workers.map(worker => worker.kind), ['claude', 'codex']);
  assert.ok(herdrCommands.some(command => command[0] === 'plugin' && command[1] === 'link'));
  assert.ok(herdrCommands.some(command => command[0] === 'plugin' && command[1] === 'enable'));

  const master = JSON.parse(await readFile(join(root, '.graphyard/master.json'), 'utf8'));
  assert.equal(master.repository, 'owner/project');
  assert.equal(master.workers.length, 2);
  assert.ok(master.credentialFile.startsWith(session.directory), 'the coordinator credential must stay in the installation directory');
  assert.equal((await stat(master.credentialFile)).mode & 0o777, 0o600);
  for (const profile of master.workers) {
    assert.ok(profile.credentialFile.startsWith(join(session.directory, 'tokens')));
    assert.equal(session.principals.find(principal => principal.id === profile.principal)!.role, 'worker');
  }

  const instructions = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.match(instructions, /## Graphyard coordination/);
  assert.match(instructions, /## Graphyard master agent/);
  for (const token of tokens.values()) assert.ok(!instructions.includes(token));

  // Each registered credential authenticates as exactly its own role on the live server.
  for (const principal of session.principals) {
    const response = await fetch(`${live}/api/status`, { headers: { Authorization: `Bearer ${tokens.get(principal.id)}` } });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as any).actor.role, principal.role);
  }
  assert.equal((await fetch(`${live}/api/status`, { headers: { Authorization: 'Bearer not-a-real-credential-0000000000' } })).status, 401);
  assert.ok(summary.nextSteps.some(step => step.includes('Never copy an admin, coordinator, or producer credential')));
});

test('an unhealthy service fails the install instead of reporting success', async () => {
  const fixture = await harness({ provider: 'compose', healthy: false });
  try {
    const session = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'compose' }, fixture.deps);
    await assert.rejects(applyInstall(session, await buildPlan(session)), /did not become healthy/);
  } finally { await fixture.cleanup(); }
});

test('a rejected webhook signature is reported as a secret mismatch, not as a slow delivery', async () => {
  const rejected = [{ id: 1, event: 'check_run', status_code: 401, delivered_at: new Date().toISOString() }];
  const app = { request: async () => rejected };
  const proof = await verifyDelivery(app, Date.now(), async () => {}, 3);
  assert.equal(proof.delivered, false);
  assert.equal(proof.statusCode, 401);
  assert.match(proof.detail, /GITHUB_WEBHOOK_SECRET does not match/);

  const silent = await verifyDelivery({ request: async () => [] }, Date.now(), async () => {}, 2);
  assert.equal(silent.delivered, false);
  assert.match(silent.detail, /No webhook delivery was observed/);
  assert.equal(VERIFICATION_CHECK, 'Graphyard / install verification');
});

test('runtime and Herdr detection report only what is present and signed in', async () => {
  const present = fakeTransport({ responses: [
    { match: 'command -v claude', result: '/usr/local/bin/claude' },
    { match: 'command -v herdr', result: '/usr/local/bin/herdr' },
    { match: 'herdr --version', result: 'herdr 0.7.1' },
  ] });
  const home = await mkdtemp(join(tmpdir(), 'graphyard-home-'));
  try {
    const table = [{ kind: 'claude', program: 'claude', credentials: ['.claude/.credentials.json'] }, { kind: 'codex', program: 'codex', credentials: ['.codex/auth.json'] }];
    const unauthenticated = await detectRuntimes(present as Transport, home, table);
    assert.deepEqual(unauthenticated.map(runtime => runtime.kind), ['claude'], 'a runtime that is not installed is never reported');
    assert.equal(unauthenticated[0].authenticated, false);
    assert.match(unauthenticated[0].reason, /sign in to claude first/);
    assert.equal(masterRuntime(unauthenticated), null);
    assert.deepEqual(workerProfiles('owner-project', ['w1'], unauthenticated, principal => `/tokens/${principal}`), []);

    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude/.credentials.json'), '{}');
    const authenticated = await detectRuntimes(present as Transport, home, table);
    assert.equal(authenticated[0].authenticated, true);
    assert.equal(masterRuntime(authenticated)?.kind, 'claude');

    const profiles = workerProfiles('owner-project', ['w1', 'w2'], authenticated, principal => `/tokens/${principal}.token`);
    assert.deepEqual(profiles.map(profile => profile.name), ['claude-1', 'claude-2']);
    assert.deepEqual(profiles.map(profile => profile.credentialFile), ['/tokens/w1.token', '/tokens/w2.token']);
    assert.ok(profiles.every(profile => profile.mode === 'launch' && Object.keys(profile.environment).length === 0));
    assert.deepEqual(reviewerProfiles(authenticated, 'claude'), [{ name: 'claude-reviewer', runtime: 'claude', reviewerApp: 'claude', timeoutSeconds: 1800 }]);
    assert.deepEqual(reviewerProfiles(authenticated, null), []);

    assert.deepEqual(await detectHerdr(present as Transport), { available: true, version: 'herdr 0.7.1', reason: 'herdr is available; repository setup links and enables the Graphyard plugin' });
    const absent = fakeTransport({ responses: [{ match: 'command -v herdr', result: { stdout: '', stderr: '', code: 1 } }] });
    assert.equal((await detectHerdr(absent as Transport)).available, false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
