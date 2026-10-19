import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { applyInstall, buildPlan, InstallPaused, installRequestFromArgs, prepareInstall, resumeCommand, type InstallRequest, type ProfileRequest } from '../src/install/index.js';
import { AppStepPending, runManifestFlow } from '../src/install/manifest.js';
import { readInstallRecord } from '../src/install/secrets.js';
import { appPageBusy, startGithubSetup } from '../src/github-setup.js';
import { installedOnboarding } from '../src/onboarding.js';
import { applyProposal, herdrPluginBinding, scanProposal, setupRepository } from '../src/repository-setup.js';
import { assertMasterBinding, loadMasterConfig, setupMaster } from '../src/master.js';
import { APP_PENDING } from '../src/master/profiles.js';
import { appKey, GRAPHYARD_APP_ID, harness, REPOSITORY, WEBHOOK_SECRET } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const execFile = promisify(execFileCallback);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const PRO_403 = { stdout: '', stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)', code: 1 };
const exists = (path: string) => stat(path).then(() => true, () => false);
const confirmedApp = { appId: GRAPHYARD_APP_ID, slug: 'graphyard-owner-project', installationId: 500, privateKey: appKey, webhookSecret: WEBHOOK_SECRET };

test('unit:install-preflight-branch-protection — install reads no branch protection (GY-2009): a 403 "Upgrade to GitHub Pro", an admin-rights refusal or a 5xx on the protection endpoint changes nothing, and preflight has no protection gate', async () => {
  for (const result of [PRO_403, { stdout: '', stderr: 'gh: Must have admin rights to Repository. (HTTP 403)', code: 1 }, { stdout: '', stderr: 'gh: HTTP 502: Bad Gateway', code: 1 }]) {
    const fixture = await harness({ provider: 'compose', extraResponses: [{ match: `gh api repos/${REPOSITORY}/branches/main/protection`, result }] });
    try {
      const plan = await buildPlan(await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'compose' }, fixture.deps, 'plan'));
      assert.ok(!plan.preflight.some(item => item.name === 'Branch protection'), 'no branch-protection preflight item');
      assert.ok(!plan.actions.some(action => action.id === 'github.protection'), 'no protection action');
      assert.ok(!plan.humanSteps.some(step => /branch protection|GitHub Pro/i.test(step)), plan.humanSteps.join('\n'));
      assert.equal(plan.preflight.find(item => item.name === 'GitHub CLI')!.ok, true);
      assert.ok(!fixture.commandLines().some(line => /\/protection|\/rulesets/.test(line)), 'the protection endpoint is never called');
    } finally { await fixture.cleanup(); }
  }
});

test('unit:init-reuses-install-identities — init --scan --apply never mints a second principal set or App page beside an install, in either order', async () => {
  // GY-2009: install has no App step, so init never meets an install waiting at one; it reuses the finished install's identities.
  const fixture = await harness({ provider: 'compose' });
  try {
    const proposal = await scanProposal(fixture.root, { url: 'https://graphyard.example' });
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GRAPHYARD_')) delete env[key];
    env.GRAPHYARD_CONFIG_HOME = fixture.configHome;
    await execFile(process.execPath, [launcher, 'init', '--scan', '--url', 'https://graphyard.example'], { cwd: fixture.root, env });
    // The install finished. init reuses its identities (no App: install registers none) and writes no principals.
    const finished = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'compose' }, fixture.deps, 'apply');
    await applyInstall(finished, await buildPlan(finished));
    const installUrl = (await readInstallRecord(finished.directory))!.url!;
    const installed = await installedOnboarding(fixture.root, REPOSITORY, installUrl, fixture.configHome);
    assert.deepEqual(installed, { directory: finished.directory, url: installUrl, githubApp: null });
    assert.deepEqual(await installedOnboarding(fixture.root, REPOSITORY, null, fixture.configHome), installed, "no selected server means the install's own");
    // Another server is not the install's: its identities and App are not reused for it, and nothing is minted either.
    await assert.rejects(installedOnboarding(fixture.root, REPOSITORY, 'https://other.example', fixture.configHome), (error: Error) => {
      assert.ok(error.message.startsWith(`graphyard install --apply owns owner/project's identities and App for ${installUrl} (`), error.message); assert.match(error.message, /install\.json\), not https:\/\/other\.example\./);
      assert.match(error.message, /init mints no principals for another server beside the install's\. Nothing was written/);
      return true;
    });
    const otherServer = await execFile(process.execPath, [launcher, 'init', '--scan', '--apply', '--url', 'https://other.example'], { cwd: fixture.root, env }).then(() => null, error => error);
    assert.ok(otherServer, 'init --scan --apply against another server exits non-zero');
    assert.match(String(otherServer.stderr), /not https:\/\/other\.example/);
    for (const file of ['principals.json', 'repository-setup.json', 'profiles']) assert.equal(await exists(join(fixture.root, '.graphyard', file)), false, `${file} was not written for another server`);
    let appPageOpened = false;
    const result = await applyProposal(fixture.root, proposal, { url: installUrl, installed: installed!, githubSetup: async () => { appPageOpened = true; return { appId: 1, slug: 'second' }; } });
    assert.equal(appPageOpened, false, 'init opened no App page of its own');
    assert.equal(result.githubApp, null, 'the install registered no App, so none is reused or minted');
    assert.equal(result.principalsFile, null);
    assert.equal(await exists(join(fixture.root, '.graphyard/principals.json')), false, 'never a second principals file');
    assert.ok(result.unchanged.some(entry => /principal and grant registry \(managed by graphyard install/.test(entry)));
    assert.doesNotMatch(result.next, /Install the principals array as GRAPHYARD_PRINCIPALS/);
    assert.match(result.next, /nothing needs installing as GRAPHYARD_PRINCIPALS/);
    assert.ok(result.applied.includes('AGENTS.md coordination section'), 'the onboarding files are still committed');
    const record = await readInstallRecord(finished.directory);
    assert.ok(record!.principals.every(principal => principal.id.startsWith('owner-project-')), "the install's principals stand");
  } finally { await fixture.cleanup(); }

  // The App page port, both orders: whichever of install and init holds it, the other gets a named
  // refusal, never a raw EADDRINUSE.
  const root = await temporaryDirectory('app-page');
  const holder = createServer(); await new Promise<void>(accept => holder.listen(0, '127.0.0.1', accept));
  const port = (holder.address() as any).port;
  try {
    await execFile('git', ['init', '-q', root]);
    const named = (error: any) => { assert.equal(error.code, 'GRAPHYARD_APP_PAGE_BUSY'); assert.match(error.message, new RegExp(`Port ${port} already serves a GitHub App setup page`)); assert.doesNotMatch(error.message, /EADDRINUSE/); return true; };
    await assert.rejects(startGithubSetup(root, REPOSITORY, 'https://graphyard.example', port), named);
    await assert.rejects(runManifestFlow(root, REPOSITORY, 'https://graphyard.example', { port, announce: () => {}, dependencies: { file: join(root, 'app.json') } }), named);
    assert.equal(appPageBusy(4311).message.includes('http://127.0.0.1:4311'), true);
  } finally { await new Promise<void>(accept => holder.close(() => accept())); await rm(root, { recursive: true, force: true }); }
});

test('unit:install-herdr-plugin-guard — the plan shows a Herdr relink and a plugin bound to another server is never repointed without --herdr-rebind', async () => {
  const fixture = await harness({ provider: 'compose' });
  const pluginDirectory = join(fixture.configHome, 'herdr-plugin');
  const herdrCalls: string[][] = [];
  const runHerdr = (args: string[]) => { herdrCalls.push(args); return args[1] === 'config-dir' ? pluginDirectory : ''; };
  try {
    // A fresh machine: the plan links and enables the plugin and says how.
    const unbound = await buildPlan(await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'compose' }, { ...fixture.deps, runHerdr }, 'plan'));
    const link = unbound.actions.find(action => action.id === 'local.herdr')!;
    assert.equal(link.state, 'create'); assert.match(link.title, /Link and enable Herdr's graphyard plugin.*herdr plugin link.*herdr plugin enable/);

    // A host already running a Graphyard install: its plugin is bound to the production server.
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(join(pluginDirectory, 'config.json'), JSON.stringify({ url: 'https://production.example', token: 'production-worker-token-0123456789abcdef' }), { mode: 0o600 });
    assert.deepEqual(await herdrPluginBinding(runHerdr), { configDirectory: pluginDirectory, url: 'https://production.example', bound: 'https://production.example' });
    const plan = await buildPlan(await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'compose' }, { ...fixture.deps, runHerdr }, 'plan'));
    const relink = plan.actions.find(action => action.id === 'local.herdr')!;
    assert.equal(relink.state, 'update');
    assert.match(relink.title, /^Relink Herdr's graphyard plugin, now bound to https:\/\/production\.example, to this installation .*refused without --herdr-rebind$/);
    assert.deepEqual(plan.drift.find(entry => entry.action === 'local.herdr'), { action: 'local.herdr', field: 'Herdr graphyard plugin url', expected: 'this installation', observed: 'https://production.example' });
    const gate = plan.preflight.find(item => item.name === 'Herdr plugin')!;
    assert.equal(gate.ok, false); assert.match(gate.detail, /bound to https:\/\/production\.example/); assert.match(gate.fix!, /--herdr-rebind .* or --no-herdr/);
    const refused = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'compose' }, { ...fixture.deps, runHerdr }, 'apply');
    await assert.rejects(applyInstall(refused, await buildPlan(refused)), /Preflight is incomplete; the installer changed nothing[\s\S]*Herdr plugin/);
    assert.equal(JSON.parse(await readFile(join(pluginDirectory, 'config.json'), 'utf8')).url, 'https://production.example', 'the production binding is untouched');

    // A binding nobody can inspect (config.json unreadable as JSON, or naming no server) fails closed:
    // it is shown as a relink and refused without --herdr-rebind, never mistaken for no binding.
    const productionConfig = await readFile(join(pluginDirectory, 'config.json'), 'utf8');
    for (const [content, reason] of [['{not json', /not valid JSON/], [JSON.stringify({ token: 'x' }), /names no server url/]] as const) {
      await writeFile(join(pluginDirectory, 'config.json'), content, { mode: 0o600 });
      const binding = (await herdrPluginBinding(runHerdr))!;
      assert.equal(binding.url, null); assert.match(binding.bound, reason);
      const opaque = await buildPlan(await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'compose' }, { ...fixture.deps, runHerdr }, 'plan'));
      assert.equal(opaque.actions.find(action => action.id === 'local.herdr')!.state, 'update');
      assert.match(opaque.actions.find(action => action.id === 'local.herdr')!.title, /now bound to a configuration that cannot be inspected .*refused without --herdr-rebind$/);
      assert.equal(opaque.preflight.find(item => item.name === 'Herdr plugin')!.ok, false);
      assert.equal(await readFile(join(pluginDirectory, 'config.json'), 'utf8'), content, 'the uninspectable binding is untouched');
    }
    await writeFile(join(pluginDirectory, 'config.json'), productionConfig, { mode: 0o600 });

    // --no-herdr leaves it alone; --herdr-rebind names the relink and allows it.
    const skipped = await buildPlan(await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'compose', herdr: 'skip' }, { ...fixture.deps, runHerdr }, 'plan'));
    assert.equal(skipped.preflight.find(item => item.name === 'Herdr plugin'), undefined);
    assert.match(skipped.actions.find(action => action.id === 'local.herdr')!.title, /Leave Herdr untouched \(--no-herdr\)/);
    const requests: ProfileRequest[] = [];
    const rebind = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'compose', herdr: 'rebind' }, { ...fixture.deps, runHerdr, registerProfiles: async request => { requests.push(request); return fixture.deps.registerProfiles!(request); } }, 'apply');
    const rebindPlan = await buildPlan(rebind);
    assert.equal(rebindPlan.preflight.find(item => item.name === 'Herdr plugin'), undefined);
    assert.match(rebindPlan.actions.find(action => action.id === 'local.herdr')!.title, /now bound to https:\/\/production\.example.*--herdr-rebind allows it/);
    await applyInstall(rebind, rebindPlan);
    assert.ok(requests.length && requests.every(request => request.herdrRebind === true), 'the rebind choice reaches repository setup');
  } finally { await fixture.cleanup(); }

  // init --herdr, through setupRepository: the same refusal before any write, and the relink reported when allowed.
  const root = await temporaryDirectory('herdr-init');
  const config = join(root, 'herdr-private');
  try {
    await execFile('git', ['init', '-q', root]);
    await execFile('git', ['remote', 'add', 'origin', `git@github.com:${REPOSITORY}.git`], { cwd: root });
    await mkdir(config, { recursive: true });
    await writeFile(join(config, 'config.json'), JSON.stringify({ url: 'https://production.example', token: 'x' }), { mode: 0o600 });
    const calls: string[][] = [];
    const run = (args: string[]) => { calls.push(args); return args[1] === 'config-dir' ? config : ''; };
    const fetcher = (async () => new Response(JSON.stringify({ actor: { id: 'worker-a', role: 'worker' }, repository: REPOSITORY }))) as unknown as typeof fetch;
    const connection = { url: 'https://new.example', cliPath: launcher, hostId: 'host', token: 'worker-token-0123456789abcdef0123456789' };
    await assert.rejects(setupRepository(root, connection, { herdr: true, fetcher, runHerdr: run, executors: false }), /bound to https:\/\/production\.example; linking it for https:\/\/new\.example would repoint.*--herdr-rebind/);
    assert.ok(!calls.some(args => args[1] === 'link' || args[1] === 'enable'), 'nothing was linked or enabled');
    assert.equal(await exists(join(root, 'AGENTS.md')), false); assert.equal(await exists(join(root, '.graphyard/connection.json')), false);
    const result = await setupRepository(root, connection, { herdr: true, herdrRebind: true, fetcher, runHerdr: run, executors: false });
    assert.deepEqual(result.herdr, { previous: 'https://production.example', bound: 'https://new.example', relinked: true });
    assert.equal(JSON.parse(await readFile(join(config, 'config.json'), 'utf8')).url, 'https://new.example');
    // An uninspectable config.json is refused the same way, before any write.
    await writeFile(join(config, 'config.json'), '{not json', { mode: 0o600 });
    calls.length = 0;
    await assert.rejects(setupRepository(root, { ...connection, url: 'https://third.example' }, { herdr: true, fetcher, runHerdr: run, executors: false }), /bound to a configuration that cannot be inspected \(.*config\.json: not valid JSON\); linking it for https:\/\/third\.example would repoint/);
    assert.ok(!calls.some(args => args[1] === 'link' || args[1] === 'enable'), 'nothing was linked or enabled over an uninspectable binding');
    assert.equal(await readFile(join(config, 'config.json'), 'utf8'), '{not json');
    await writeFile(join(config, 'config.json'), JSON.stringify({ url: 'https://new.example', token: 'x' }), { mode: 0o600 });
    // Rebinding the same server again is no relink.
    assert.deepEqual((await setupRepository(root, connection, { herdr: true, fetcher, runHerdr: run, executors: false })).herdr, { previous: 'https://new.example', bound: 'https://new.example', relinked: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:install-app-timeout-resume — an App step nobody confirms prints what was completed and the resume command; the master works before the App', async () => {
  // The manifest flow's own timeout never claims credentials it did not write.
  const scratch = await temporaryDirectory('manifest');
  try {
    await execFile('git', ['init', '-q', scratch]);
    const file = join(scratch, 'github-app.json');
    const timedOut = await runManifestFlow(scratch, REPOSITORY, 'https://graphyard.example', { port: 0, timeoutMs: 0, announce: () => {}, wait: async () => {}, dependencies: { file } }).then(() => null, error => error);
    assert.ok(timedOut instanceof AppStepPending); assert.equal(timedOut.saved, false);
    assert.match(timedOut.message, /was not confirmed within 0 s\. Rerun graphyard install --apply once the human confirms it; everything before the App step is kept\. Nothing was confirmed, so no App credentials were saved\./);
    assert.doesNotMatch(timedOut.message, /resume from the saved credentials/);
    await writeFile(file, JSON.stringify({ appId: 7, slug: 'registered', privateKey: appKey, webhookSecret: 'w', repository: REPOSITORY }), { mode: 0o600 });
    const registered = await runManifestFlow(scratch, REPOSITORY, 'https://graphyard.example', { port: 0, timeoutMs: 0, announce: () => {}, wait: async () => {}, dependencies: { file } }).then(() => null, error => error);
    assert.equal(registered.saved, true); assert.match(registered.message, new RegExp(`returned the App registration to ${file}`));
  } finally { await rm(scratch, { recursive: true, force: true }); }

  // GY-2009: install itself has no App step to pause at: it completes without ever calling the App flow, and resumes nothing.
  const fixture = await harness({ provider: 'compose' });
  try {
    const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'compose', reviewer: 'claude-reviewer' }, { ...fixture.deps,
      githubApp: async () => { throw new Error('install must never run the App flow'); } }, 'apply');
    const done = await applyInstall(session, await buildPlan(session));
    assert.equal(done.github, null);
    assert.equal(done.health, true);
    assert.match(done.protection, /deploy key/i);
    assert.equal(await exists(join(session.directory, 'github-app.json')), false, 'no App credential file is written');
    assert.equal((await readInstallRecord(session.directory))!.github, null);
  } finally { await fixture.cleanup(); }

  // master environments and master harness succeed before the App is confirmed, against a control
  // plane that reports no App yet; once it has one, the pending binding is refused until rebound.
  const root = await temporaryDirectory('pending-master'), credentials = await temporaryDirectory('pending-credentials'), environments = await temporaryDirectory('pending-environments');
  let appId: number | null = null;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.startsWith('/api/status')) return response.end(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: REPOSITORY, baseBranch: 'main', githubAppId: appId }));
    response.statusCode = 404; response.end('{}');
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    await execFile('git', ['init', '-q', root]);
    await execFile('git', ['remote', 'add', 'origin', `https://github.com/${REPOSITORY}.git`], { cwd: root });
    const token = 'coordinator-token-0123456789abcdef0123456789';
    // The control plane is the merge writer, so a plane with no GitHub App reads as App-pending.
    await setupMaster(root, { url, token, cliPath: launcher, credentialDirectory: credentials });
    const pending = await loadMasterConfig(root);
    assert.equal(pending.githubAppId, APP_PENDING);
    const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_CONFIG_HOME: credentials };
    for (const key of Object.keys(env)) if (key.startsWith('GRAPHYARD_') && key !== 'GRAPHYARD_CONFIG_HOME') delete env[key];
    const cli = (args: string[]) => execFile(process.execPath, [launcher, ...args], { cwd: root, env }).then(result => ({ code: 0, stdout: result.stdout, stderr: result.stderr }), (error: any) => ({ code: error.code as number, stdout: String(error.stdout), stderr: String(error.stderr) }));
    const harnessResult = await cli(['master', 'harness', 'claude']);
    assert.equal(harnessResult.code, 0, harnessResult.stderr); assert.ok(Array.isArray(JSON.parse(harnessResult.stdout).added));
    const environmentsResult = await cli(['master', 'environments', '--directory', environments]);
    assert.equal(environmentsResult.code, 0, environmentsResult.stderr); assert.ok(JSON.parse(environmentsResult.stdout));

    // The binding stays strict: a pending config against a server with an App, or a real id against another, refuses.
    appId = 1234;
    const stale = await cli(['master', 'harness', 'claude']);
    assert.notEqual(stale.code, 0); assert.match(stale.stderr, /now has GitHub App 1234 but this master was configured while the App step was pending; rerun graphyard install --apply/);
    assert.throws(() => assertMasterBinding({ ...pending, githubAppId: 1234 }, { actor: { role: 'coordinator' }, repository: REPOSITORY, baseBranch: 'main', githubAppId: null }), /GitHub App changed/);
    assert.throws(() => assertMasterBinding({ ...pending, githubAppId: 1234 }, { actor: { role: 'coordinator' }, repository: REPOSITORY, baseBranch: 'main', githubAppId: 4321 }), /GitHub App changed/);
    await setupMaster(root, { url, token, cliPath: launcher, credentialDirectory: credentials });
    assert.equal((await loadMasterConfig(root)).githubAppId, 1234, 'the run after the App step binds the confirmed App');
    const rebound = await cli(['master', 'harness', 'claude']);
    assert.equal(rebound.code, 0, rebound.stderr);
  } finally {
    await new Promise<void>(accept => server.close(() => accept()));
    for (const directory of [root, credentials, environments]) await rm(directory, { recursive: true, force: true });
  }
});

test('unit:install-app-timeout-resume — a self-contained host writes its tokens on the host, never a local one, and runs no App step (GY-2009)', async () => {
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test' });
  try {
    const inputs = { repository: REPOSITORY, provider: 'host' as const, selfContained: true, sshHost: '203.0.113.20', sshUser: 'root', domain: 'graphyard.example.test' };
    const session = await prepareInstall(fixture.root, inputs, { ...fixture.deps, githubApp: async () => { throw new Error('install must never run the App flow'); } }, 'apply');
    const summary = await applyInstall(session, await buildPlan(session));
    const tokens = session.context.host!.layout.tokensDirectory;
    for (const principal of session.principals) {
      assert.equal(await exists(join(session.directory, `${principal.id}.token`)), false, 'no local token file exists to be claimed');
      assert.ok(fixture.hostFiles.has(`${tokens}/${principal.id}.token`), `${principal.id} token written on the host`);
    }
    assert.equal(summary.github, null);
  } finally { await fixture.cleanup(); }
});

test('unit:install-app-timeout-resume — the resume command carries every install input, so the rerun targets the same server, identity and spend consent', async () => {
  // Every flag install accepts, with values a shell must quote; the printed command parses back to the same request.
  const everything: Required<Omit<InstallRequest, 'selfContained' | 'local' | 'migrate' | 'githubAppFile' | 'noGithubApp'>> = {
    repository: REPOSITORY, provider: 'hetzner', baseBranch: 'release', domain: 'graphyard.example.com', workers: 3, producerProofs: ['unit', 'browser'],
    reviewer: 'claude-reviewer', reviewPolicy: 'agent', requiredChecks: ['ci / test', "lint's check"], reviewCount: 2,
    sshHost: '203.0.113.7', sshUser: 'deploy', sshKey: 'operator key', workspace: 'My Team', image: 'ghcr.io/example/graphyard:1.2',
    port: 4320, serverName: 'foo', serverType: 'cx32', location: 'fsn1', maxMonthly: 19.52, confirmPrice: 7.05,
    createEnvironments: true, herdr: 'rebind',
  };
  const roundTrip = async (request: InstallRequest) => {
    const command = resumeCommand({ inputs: { baseBranch: 'main', ...request } as any });
    const { stdout } = await execFile('sh', ['-c', `printf '%s\\0' ${command}`]);
    const words = stdout.split('\0').slice(0, -1);
    assert.deepEqual(words.slice(0, 2), ['graphyard', 'install']); assert.equal(words.at(-1), '--apply');
    return { command, parsed: installRequestFromArgs(words.slice(2)).request };
  };
  const server = await roundTrip(everything);
  assert.deepEqual(server.parsed, { ...everything, noGithubApp: true }, 'every request is App-free (GY-2009)');
  for (const flag of ['--ssh-user deploy', "--ssh-key 'operator key'", '--server-name foo', '--server-type cx32', '--location fsn1', '--create-environments', '--max-monthly 19.52', '--confirm-price 7.05', "--workspace 'My Team'", '--herdr-rebind']) assert.ok(server.command.includes(flag), `${flag} in ${server.command}`);
  // A self-contained host keeps --target, --local and --migrate; --no-herdr survives too.
  const host: InstallRequest = { repository: REPOSITORY, provider: 'host', selfContained: true, local: true, migrate: true, herdr: 'skip' };
  const resumedHost = await roundTrip(host);
  assert.deepEqual(resumedHost.parsed, { ...host, noGithubApp: true }); assert.match(resumedHost.command, /--target host .*--local --migrate .*--no-herdr --apply$/);
  const createdHost: InstallRequest = { repository: REPOSITORY, provider: 'hetzner', selfContained: true, sshKey: 'k', maxMonthly: 0 };
  assert.deepEqual((await roundTrip(createdHost)).parsed, { ...createdHost, noGithubApp: true });
});
