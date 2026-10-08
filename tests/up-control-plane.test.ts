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
import type { UpDependencies, UpEvent, UpRequest } from '../src/up.js';
import { appKey, temporaryRepository } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const execFile = promisify(execFileCallback);

/**
 * GY-1550 / GY-1552 (children of GY-1527, `up --merger control-plane`):
 * - GY-1550: `graphyard install --no-github-app` installs a control plane with no GitHub App; the
 *   proof runs the installer against a live server started without GitHub and checks no App flow
 *   runs, no GITHUB_APP_* variable is written, and `/api/status.github` is false.
 * - GY-1552: `up --merger control-plane` step order (proofs unit:up-control-plane-steps and
 *   unit:up-github-steps-unchanged) lands after the install-flag and deploy-key children.
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
function recordingAdapter(environments: EnvValue[][], options: { variables?: Record<string, string>; merge?: boolean; unread?: boolean } = {}): ProviderAdapter {
  const adapter: ProviderAdapter = {
    provider: 'compose',
    preflight: async () => [{ name: 'test provider', ok: true, detail: 'a live control plane is already running' }],
    // unread: the service exists but its variable listing could not be read (Railway swallows an
    // unparsable `variables --json`), so nothing is known about what it holds.
    observe: async () => options.unread
      ? { ...emptyObservation(), installed: true, app: true, variables: {}, variablesObserved: false }
      : { ...emptyObservation(), installed: !!options.variables, variables: options.variables ?? {}, variablesObserved: true },
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

  // A merge-style service whose variable listing could not be read is refused too: the only
  // other guard would be the server reporting an App after the deploy.
  const unreadEnv: EnvValue[][] = [];
  const unread = await prepareInstall(root, installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--no-github-app', '--apply']).request,
    dependenciesFor(recordingAdapter(unreadEnv, { merge: true, unread: true })));
  const unreadPlan = await buildPlan(unread);
  const unreadGate = unreadPlan.preflight.find(item => item.name === 'GitHub App')!;
  assert.equal(unreadGate.ok, false);
  assert.match(unreadGate.detail, /variables of the .* could not be read/);
  await assert.rejects(applyInstall(unread, unreadPlan), /Preflight is incomplete/);
  assert.deepEqual(unreadEnv, [], 'an unread merge-style listing writes no environment');
  // The same unread listing on a rewrite adapter is no refusal: the core-only write replaces it.
  const unreadRewrite = await buildPlan(await prepareInstall(root, installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--no-github-app', '--apply']).request,
    dependenciesFor(recordingAdapter([], { unread: true }))));
  assert.ok(unreadRewrite.preflight.every(item => item.ok), JSON.stringify(unreadRewrite.preflight));

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

/**
 * GY-1552 (child of GY-1527): `up --merger control-plane` — step order, install --no-github-app,
 * no browser profile, gh repo create when missing, deploy-key + POST /api/merger, and the github-mode
 * step list unchanged. Proofs: unit:up-control-plane-steps, unit:up-github-steps-unchanged.
 */
const upModule = () => import('../src/up.js');
const UP_SERVER = 'http://127.0.0.1:4310';
const UP_ADMIN = 'a'.repeat(40);

/** A simulated host for the control-plane merger path: install finishes without Apps; accounts and the loop turn green. */
function controlPlaneUpWorld() {
  const calls: string[][] = [];
  const ghCalls: string[][] = [];
  let installed = false, accounts = false, loop = false, merger: 'github' | 'control-plane' = 'github';
  let repoExists = false;
  const deployKeys: string[] = [];
  const mergers: { token: string; requestId: string }[] = [];
  let clock = 0;
  const status = () => installed ? {
    github: false, githubRepository: 'owner/project', appPermissions: { missing: [] }, reviewerApps: [],
    mergeWriter: { merger, line: merger === 'control-plane' ? 'control-plane writer' : null },
    fleet: accounts
      ? { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, smoke: { result: 'pass' } }] }
      : { roles: [], accounts: [] },
    setup: { protection: 'off', loop },
  } : null;
  const deps = (checkout: string, events: UpEvent[]): UpDependencies => ({
    root: checkout, pollMs: 1, emit: event => { events.push(event); },
    now: () => clock, sleep: async ms => { clock += ms; },
    serverUrl: async () => installed ? UP_SERVER : null,
    masterToken: async () => installed ? 'm'.repeat(40) : null,
    operatorToken: async () => UP_ADMIN,
    signIn: async () => null,
    status: async () => status(),
    publishOnboarding: async () => null,
    onboardingMerged: async () => true,
    installDirectory: () => join(checkout, 'install-dir'),
    ensureDeployKey: async (installDir, repository) => {
      deployKeys.push(`${installDir}:${repository}`);
      return join(installDir, 'deploy-key');
    },
    setMerger: async (token, requestId) => { mergers.push({ token, requestId }); merger = 'control-plane'; },
    gh: async args => {
      ghCalls.push(args);
      if (args[0] === 'repo' && args[1] === 'view') return repoExists ? { code: 0, stdout: '{"name":"project"}' } : { code: 1, stdout: '', stderr: 'not found' };
      if (args[0] === 'repo' && args[1] === 'create') { repoExists = true; return { code: 0, stdout: 'Created' }; }
      return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
    },
    async cli(args) {
      calls.push(args);
      if (args[0] === 'install' && args.includes('--plan')) {
        return { code: 0, stdout: JSON.stringify({
          installId: 'owner-project', installDirectory: join(checkout, 'install-dir'),
          principals: [{ id: 'owner-project-operator', role: 'admin', sessionKind: 'human' }],
          preflight: [{ name: 'GitHub CLI', ok: true }], browserApps: [],
        }) };
      }
      if (args[0] === 'install' && args.includes('--apply')) {
        installed = true;
        return { code: 0, stdout: JSON.stringify({ ok: true, installDirectory: join(checkout, 'install-dir'), principals: [{ id: 'owner-project-operator', role: 'admin' }] }) };
      }
      if (args.join(' ') === 'master registry propose --apply') { accounts = true; return { code: 0, stdout: '{}' }; }
      if (args.join(' ') === 'master restart') { loop = true; return { code: 0, stdout: '{}' }; }
      return { code: 0, stdout: '{}' };
    },
  });
  return { calls, ghCalls, deployKeys, mergers, setRepoExists: (value: boolean) => { repoExists = value; }, deps };
}

test('unit:up-control-plane-steps — up --merger control-plane runs preflight, control-plane (install --no-github-app), host-supervisor, deploy-key, merger-setting, master-autonomy, onboarding, accounts, harness, master-loop, goal; needs no browser profile; creates the repository with gh repo create when missing', async () => {
  const { runUp, upRequestFromArgs, upControlPlaneSteps, upStepsFor, upMergerControlPlane } = await upModule();
  const request = upRequestFromArgs(['--repo', 'owner/project', '--provider', 'compose', '--agent', '--merger', 'control-plane', '--goal', 'goal.md']);
  assert.equal(request.merger, 'control-plane');
  assert.equal(upMergerControlPlane(request), true);
  assert.deepEqual([...upStepsFor(request)], [...upControlPlaneSteps]);
  assert.deepEqual([...upControlPlaneSteps], ['preflight', 'control-plane', 'host-supervisor', 'deploy-key', 'merger-setting', 'master-autonomy', 'onboarding', 'accounts', 'harness', 'master-loop', 'goal']);

  const checkout = await temporaryDirectory('up-control-plane-steps');
  await writeFile(join(checkout, 'goal.md'), 'Ship the control-plane merger path for a repository with no GitHub Apps.\n');
  const world = controlPlaneUpWorld();
  world.setRepoExists(false);
  const events: UpEvent[] = [];
  const result = await runUp(request, world.deps(checkout, events));
  assert.equal(result.exitCode, 0, result.next);
  assert.deepEqual(result.completed, [...upControlPlaneSteps]);

  const started = events.filter(event => event.kind === 'step' && event.state === 'start').map(event => event.kind === 'step' ? event.step : '');
  assert.deepEqual(started, [...upControlPlaneSteps], 'every control-plane step starts in order');

  const plans = world.calls.filter(args => args[0] === 'install' && args.includes('--plan'));
  const applies = world.calls.filter(args => args[0] === 'install' && args.includes('--apply'));
  assert.ok(plans.length && plans.every(args => args.includes('--no-github-app')), 'preflight plans with --no-github-app');
  assert.ok(applies.length && applies.every(args => args.includes('--no-github-app')), 'control-plane install applies with --no-github-app');
  assert.ok(!world.calls.flat().includes('--reviewer'), 'no reviewer App flag');
  assert.ok(!world.calls.flat().some(arg => arg === '--reuse-app'), 'no App reuse');
  assert.deepEqual(world.ghCalls[0], ['repo', 'view', 'owner/project', '--json', 'name']);
  assert.deepEqual(world.ghCalls[1], ['repo', 'create', 'owner/project', '--private']);
  assert.equal(world.deployKeys.length, 1);
  assert.match(world.deployKeys[0]!, /install-dir:owner\/project$/);
  assert.equal(world.mergers.length, 1);
  assert.equal(world.mergers[0]!.token, UP_ADMIN);
  assert.ok(world.mergers[0]!.requestId.length >= 32, 'Idempotency-Key is fixed for the merger POST');
  assert.ok(result.completed.includes('goal'));
  assert.ok(!events.some(event => event.kind === 'handoff'), 'no browser or device handoff');
});

test('unit:up-github-steps-unchanged — without --merger control-plane the step list stays the github-mode list and install still registers Apps (no --no-github-app, no deploy-key or merger-setting)', async () => {
  const { runUp, upRequestFromArgs, upSteps, upStepsFor, upControlPlaneSteps, upMergerControlPlane } = await upModule();
  assert.deepEqual([...upSteps], ['preflight', 'control-plane', 'host-supervisor', 'master-autonomy', 'onboarding', 'accounts', 'harness', 'master-loop', 'goal']);
  assert.ok(!upSteps.includes('deploy-key' as never) && !upSteps.includes('merger-setting' as never), 'github-mode list has no deploy-key or merger-setting');
  assert.notDeepEqual([...upSteps], [...upControlPlaneSteps], 'control-plane inserts the two merger steps');

  const github = upRequestFromArgs(['--repo', 'owner/project', '--provider', 'compose']);
  assert.equal(github.merger, undefined);
  assert.equal(upMergerControlPlane(github), false);
  assert.deepEqual([...upStepsFor(github)], [...upSteps]);

  const checkout = await temporaryDirectory('up-github-steps-unchanged');
  const calls: string[][] = [];
  const events: UpEvent[] = [];
  let clock = 0, installed = false, app = false, reviewer = false, accounts = false, loop = false;
  const request: UpRequest = { repository: 'owner/project', provider: 'compose', agent: false, reviewer: 'claude', master: 'claude', goalFile: null, browserProfile: null };
  const result = await runUp(request, {
    root: checkout, pollMs: 1, emit: event => { events.push(event); },
    now: () => clock, sleep: async ms => { clock += ms; if (clock >= 3) { app = true; reviewer = true; } if (clock >= 6) accounts = true; },
    serverUrl: async () => installed ? UP_SERVER : null,
    masterToken: async () => installed ? 'm'.repeat(40) : null,
    operatorToken: async () => UP_ADMIN,
    signIn: async () => null,
    status: async () => installed ? {
      github: app, githubRepository: 'owner/project', appPermissions: { missing: [] },
      reviewerApps: reviewer ? [{ id: 'claude', appId: 9 }] : [],
      fleet: accounts
        ? { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, smoke: { result: 'pass' } }] }
        : { roles: [], accounts: [] },
      setup: { protection: app ? 'checks' : 'off', loop },
    } : null,
    publishOnboarding: async () => null,
    onboardingMerged: async () => true,
    async cli(args) {
      calls.push(args);
      if (args[0] === 'install' && args.includes('--plan')) {
        return { code: 0, stdout: JSON.stringify({ installId: 'owner-project', installDirectory: '/install/owner-project',
          principals: [{ id: 'owner-project-operator', role: 'admin', sessionKind: 'human' }], preflight: [{ name: 'GitHub CLI', ok: true }] }) };
      }
      if (args[0] === 'install' && args.includes('--apply')) {
        installed = true; app = true; reviewer = true;
        return { code: 0, stdout: JSON.stringify({ ok: true }) };
      }
      if (args.join(' ') === 'master registry propose --apply') { accounts = true; return { code: 0, stdout: '{}' }; }
      if (args.join(' ') === 'master restart') { loop = true; return { code: 0, stdout: '{}' }; }
      return { code: 0, stdout: '{}' };
    },
  });
  assert.equal(result.exitCode, 0, result.next);
  assert.ok(!result.completed.some(step => step === 'deploy-key' || step === 'merger-setting'));
  assert.deepEqual(result.completed, [...upSteps].filter(step => step !== 'goal'));
  const applies = calls.filter(args => args[0] === 'install' && args.includes('--apply'));
  assert.ok(applies.length && applies.every(args => args.includes('--reviewer') && args.includes('claude')), 'github mode still passes --reviewer');
  assert.ok(applies.every(args => !args.includes('--no-github-app')), 'github mode never passes --no-github-app');
  assert.ok(!events.some(event => event.kind === 'step' && (event.step === 'deploy-key' || event.step === 'merger-setting')));
});

test('up --merger control-plane is refused beside --local, which provisions no master identities', async () => {
  const { upRequestFromArgs } = await import('../src/up.js');
  assert.throws(() => upRequestFromArgs(['--repo', 'acme/shop', '--local', '--merger', 'control-plane']), /cannot be combined with --local/);
});
