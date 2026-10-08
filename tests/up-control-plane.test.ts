import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { APP_VARIABLES, applyInstall, buildPlan, derivedVariables, installRequestFromArgs, prepareInstall, resumeCommand, type InstallDependencies } from '../src/install/index.js';
import { emptyObservation, type ProviderAdapter } from '../src/install/adapters.js';
import type { EnvValue } from '../src/install/types.js';
import { ensureTokens, installDirectory, installRecordSchema, plannedPrincipals, prepareInstallDirectory, Vault, writeInstallRecord } from '../src/install/secrets.js';
import { fakeTransport, type Transport } from '../src/install/transport.js';
import { appKey, temporaryRepository } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const execFile = promisify(execFileCallback);

/**
 * GY-1550 (child of GY-1527, `up --merger control-plane`): `graphyard install --no-github-app`
 * installs a control plane with no GitHub App at all. The proof runs the installer against a live
 * server started without GitHub, the way the deployed one starts when GITHUB_APP_ID is unset, and
 * checks what the criterion names: no App flow runs, no GITHUB_APP_* variable is ever written, and
 * the server's own `/api/status` reports `github: false`. The later `up` control-plane child
 * extends this file.
 */
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
const principals = plannedPrincipals(INSTALL_ID, { workers: 1 });

before(async () => {
  root = await temporaryRepository();
  configHome = await temporaryDirectory('no-app');
  const directory = installDirectory(INSTALL_ID, configHome);
  await prepareInstallDirectory(directory, root);
  tokens = await ensureTokens(directory, principals, new Vault());

  const port = Number(process.env.GRAPHYARD_INSTALL_TEST_PORT ?? 0) || await freePort();
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('no-app-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: (message: unknown) => console.error('postgres:', String(message)), postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_no_app');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_no_app`); await store.init();
  const engine = new Engine(store, [15368], 120, 'owner/project');
  // The server exactly as src/server/main.ts starts it without GITHUB_APP_ID: githubFromEnv() is null.
  http = server(engine, principals.map(principal => ({ ...principal, token: tokens.get(principal.id)! })), null);
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

/** A provider that is already healthy, recording every environment it is handed. */
function recordingAdapter(environments: EnvValue[][], options: { variables?: Record<string, string>; merge?: boolean } = {}): ProviderAdapter {
  const adapter: ProviderAdapter = {
    provider: 'compose',
    preflight: async () => [{ name: 'test provider', ok: true, detail: 'a live control plane is already running' }],
    observe: async () => ({ ...emptyObservation(), installed: !!options.variables, variables: options.variables ?? {}, variablesObserved: true }),
    plan: () => [{ id: 'provider.provision.app', target: 'provider', title: 'Start the Graphyard application', state: 'create' }],
    provision: async () => {},
    setEnv: async (_context, values) => { environments.push(values); },
    deploy: async () => {},
    url: async () => live,
    health: async (_context, url) => { try { return ((await (await fetch(`${url}/healthz`)).json()) as any)?.ok === true; } catch { return false; } },
    logs: async () => '',
  };
  // Railway/local expose applyVariables: setEnv merges and keeps variables absent from a write.
  if (options.merge) adapter.applyVariables = async (context, values) => { await adapter.setEnv(context, values); };
  return adapter;
}

function dependenciesFor(adapter: ProviderAdapter, transport = fakeTransport({ responses: [{ match: 'gh auth status', result: 'Logged in to github.com account installer' }] })): InstallDependencies {
  return {
    transport: transport as Transport, configHome, sourceRoot: root, adapter,
    cliPath: join(root, 'package.json'), hostId: 'no-app-host', wait: async () => {}, log: () => {},
    githubApp: async () => { throw new Error('the App manifest flow must never run with --no-github-app'); },
    detectRuntimes: async () => [{ kind: 'claude', program: 'claude', path: '/usr/bin/claude', authenticated: true, reason: 'signed in' }],
    detectHerdr: async () => ({ available: false, version: null, reason: 'not installed' }),
  };
}

test('integration:install-without-github-app — install --no-github-app registers no App, writes no GITHUB_APP_* variable, and the server serves with /api/status.github false', async () => {
  const environments: EnvValue[][] = [];
  let appFlows = 0;
  const transport = fakeTransport({ responses: [{ match: 'gh auth status', result: 'Logged in to github.com account installer' }] });
  const dependencies: InstallDependencies = {
    ...dependenciesFor(recordingAdapter(environments), transport),
    githubApp: async () => { appFlows += 1; throw new Error('the App manifest flow must never run with --no-github-app'); },
  };
  const { request } = installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--workers', '1', '--no-github-app', '--apply']);
  assert.equal(request.noGithubApp, true);
  const session = await prepareInstall(root, request, dependencies);
  const plan = await buildPlan(session);

  // The plan: no App step, no App variables, no webhook, no protection, no browser click and no App to create.
  assert.ok(plan.preflight.every(item => item.ok), JSON.stringify(plan.preflight));
  assert.ok(plan.preflight.some(item => item.name === 'GitHub App' && /--no-github-app/.test(item.detail)));
  const ids = plan.actions.map(action => action.id);
  for (const absent of ['github.env', 'github.webhook', 'github.ci-app-ids', 'github.protection', 'github.reviewer']) assert.ok(!ids.includes(absent), `${absent} must not be planned: ${ids.join(', ')}`);
  const appAction = plan.actions.find(action => action.id === 'github.app')!;
  assert.equal(appAction.state, 'satisfied'); assert.match(appAction.title, /--no-github-app/);
  assert.equal(plan.actions.find(action => action.id === 'verify.webhook')!.state, 'satisfied');
  assert.deepEqual(plan.browserApps, []);
  assert.ok(!plan.humanSteps.some(step => /GitHub App/.test(step)), plan.humanSteps.join('\n'));
  const planned = JSON.stringify(plan.actions.flatMap(action => action.values ?? []).map(value => value.name));
  for (const name of APP_VARIABLES) assert.ok(!planned.includes(name), `${name} must not be planned`);

  const summary = await applyInstall(session, plan);

  // The apply: the App flow never ran, no gh command was needed, and the deployed environment holds no App variable.
  assert.equal(appFlows, 0);
  assert.deepEqual(transport.commands.filter(command => command.program === 'gh'), [], 'an install without an App makes no GitHub CLI call');
  assert.ok(environments.length >= 1, 'the core variables were deployed');
  for (const values of environments) for (const name of APP_VARIABLES) assert.ok(!values.some(value => value.name === name), `${name} was written to the deployment`);
  assert.ok(environments.at(-1)!.some(value => value.name === 'GITHUB_REPOSITORY' && value.value === 'owner/project'), 'the repository is still named without an App');

  // The summary and the record: no App, the no-App choice persisted, no webhook, protection left alone.
  assert.equal(summary.health, true);
  assert.equal(summary.github, null);
  assert.equal(summary.status.githubAppId, null);
  assert.equal(summary.status.role, 'admin');
  assert.equal(summary.status.repository, 'owner/project');
  assert.equal(summary.webhook.skipped, true); assert.match(summary.webhook.detail, /--no-github-app/);
  assert.match(summary.protection, /^not required: no GitHub App is bound/);
  assert.ok(summary.nextSteps.some(step => /--no-github-app/.test(step)), summary.nextSteps.join('\n'));
  assert.ok(!summary.nextSteps.some(step => /reviewer App|publishes/.test(step)), summary.nextSteps.join('\n'));
  assert.equal(summary.profiles.master.configured, true, summary.profiles.master.detail);
  const record = JSON.parse(await readFile(join(session.directory, 'install.json'), 'utf8'));
  assert.equal(record.github, null);
  assert.equal(record.noGithubApp, true);

  // The server itself, as the criterion states it: authenticated /api/status reports github false.
  const admin = principals.find(principal => principal.role === 'admin')!;
  const status = await (await fetch(`${live}/api/status`, { headers: { Authorization: `Bearer ${tokens.get(admin.id)}` } })).json() as any;
  assert.equal(status.github, false);
  assert.equal(status.githubAppId, null);
  assert.equal(status.repository, 'owner/project');

  // A rerun is the same request: the resume command carries the flag and parses back to it.
  const command = resumeCommand(session);
  assert.ok(command.includes('--no-github-app'), command);
  const { stdout } = await execFile('sh', ['-c', `printf '%s\\0' ${command}`]);
  const words = stdout.split('\0').slice(0, -1);
  assert.equal(installRequestFromArgs(words.slice(2)).request.noGithubApp, true);

  // derivedVariables on the recorded no-App install never yields GITHUB_APP_* even when a saved
  // registration exists on the host (what master setup --apply would otherwise push).
  await writeFile(join(session.directory, 'github-app.json'), `${JSON.stringify({
    appId: 999, installationId: 888, slug: 'graphyard-owner-project', repository: 'owner/project',
    privateKey: appKey, webhookSecret: 'webhook-secret-for-test',
  })}\n`, { mode: 0o600 });
  const repair = await prepareInstall(root, { repository: 'owner/project', provider: 'compose', workers: 1 }, dependencies);
  assert.equal(repair.record?.noGithubApp, true);
  assert.equal(repair.inputs.noGithubApp, undefined);
  assert.ok(repair.savedApp.app, 'a leftover registration is still readable on the host');
  const derived = await derivedVariables(repair);
  for (const name of APP_VARIABLES) assert.ok(!derived.some(value => value.name === name), `${name} must not be derived for a no-App install record`);
});

test('integration:install-without-github-app refuses a live App binding and merge-style leftovers before changing the deployment', async () => {
  const at = new Date().toISOString();
  const directory = installDirectory(INSTALL_ID, configHome);
  await writeInstallRecord(directory, installRecordSchema.parse({
    version: 1, installId: INSTALL_ID, repository: 'owner/project', provider: 'compose', baseBranch: 'main',
    reviewPolicy: 'github', domain: null, url: live, principals: principals.map(principal => ({ id: principal.id, role: principal.role, fingerprint: 'a'.repeat(12) })),
    github: { appId: 42, installationId: 7, slug: 'graphyard-owner-project', webhookFingerprint: 'b'.repeat(12), ciAppIds: [] },
    reviewers: [], profiles: [], createdAt: at, updatedAt: at,
  }), new Vault());

  const boundEnv: EnvValue[][] = [];
  const bound = await prepareInstall(root, installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--no-github-app', '--apply']).request, dependenciesFor(recordingAdapter(boundEnv)));
  const boundPlan = await buildPlan(bound);
  const boundGate = boundPlan.preflight.find(item => item.name === 'GitHub App')!;
  assert.equal(boundGate.ok, false);
  assert.match(boundGate.detail, /already binds GitHub App graphyard-owner-project/);
  await assert.rejects(applyInstall(bound, boundPlan), /Preflight is incomplete/);
  assert.deepEqual(boundEnv, [], 'a refused transition writes no environment');

  // Clear the record binding so the merge-style leftover path is the only refusal.
  await writeInstallRecord(directory, installRecordSchema.parse({
    version: 1, installId: INSTALL_ID, repository: 'owner/project', provider: 'compose', baseBranch: 'main',
    reviewPolicy: 'github', domain: null, url: live, principals: principals.map(principal => ({ id: principal.id, role: principal.role, fingerprint: 'a'.repeat(12) })),
    github: null, noGithubApp: false, reviewers: [], profiles: [], createdAt: at, updatedAt: at,
  }), new Vault());

  const mergeEnv: EnvValue[][] = [];
  const leftover = { GITHUB_APP_ID: '42', GITHUB_INSTALLATION_ID: '7', GITHUB_PRIVATE_KEY: 'kept', GITHUB_WEBHOOK_SECRET: 'kept', GITHUB_CI_APP_IDS: '15368' };
  const merge = await prepareInstall(root, installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--no-github-app', '--apply']).request,
    dependenciesFor(recordingAdapter(mergeEnv, { variables: leftover, merge: true })));
  const mergePlan = await buildPlan(merge);
  const mergeGate = mergePlan.preflight.find(item => item.name === 'GitHub App')!;
  assert.equal(mergeGate.ok, false);
  assert.match(mergeGate.detail, /still holds GITHUB_APP_ID/);
  await assert.rejects(applyInstall(merge, mergePlan), /Preflight is incomplete/);
  assert.deepEqual(mergeEnv, [], 'a refused merge-style leftover writes no environment');

  // A whole-environment rewrite with orphaned App variables is allowed: the core-only write clears them.
  const rewriteEnv: EnvValue[][] = [];
  const rewrite = await prepareInstall(root, installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--no-github-app', '--apply']).request,
    dependenciesFor(recordingAdapter(rewriteEnv, { variables: leftover })));
  const rewritePlan = await buildPlan(rewrite);
  assert.ok(rewritePlan.preflight.every(item => item.ok), JSON.stringify(rewritePlan.preflight));
  const summary = await applyInstall(rewrite, rewritePlan);
  assert.equal(summary.github, null);
  assert.equal(summary.status.githubAppId, null);
  for (const values of rewriteEnv) for (const name of APP_VARIABLES) assert.ok(!values.some(value => value.name === name), `${name} must not be rewritten onto a no-App deployment`);
  assert.equal(JSON.parse(await readFile(join(rewrite.directory, 'install.json'), 'utf8')).noGithubApp, true);
});

test('integration:install-without-github-app refuses the flags that need an App: --github-app, --reuse-app, --reviewer and a self-contained --target', () => {
  const base = ['--provider', 'compose', '--repo', 'owner/project', '--no-github-app'];
  assert.throws(() => installRequestFromArgs([...base, '--github-app', 'app.json']), /--no-github-app registers no GitHub App, so it cannot be combined with --github-app/);
  assert.throws(() => installRequestFromArgs([...base, '--reuse-app', 'graphyard-owner-project']), /cannot be combined with --reuse-app/);
  assert.throws(() => installRequestFromArgs([...base, '--reviewer', 'claude-reviewer']), /cannot be combined with --reviewer/);
  assert.throws(() => installRequestFromArgs(['--target', 'host', '--repo', 'owner/project', '--no-github-app']), /cannot be combined with --target/);
  assert.equal(installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project']).request.noGithubApp, undefined, 'without the flag the App flow stays the default');
});
