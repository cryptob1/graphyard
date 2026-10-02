import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createPublicKey, createVerify } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseEnv } from 'node:util';
import { dirname, join } from 'node:path';
import { applyInstall, buildPlan, prepareInstall, type InstallInputs } from '../src/install/index.js';
import { claimHash, ghWrapper, hostGithubFiles, hostLayout, hostRuntimes, CONNECT_PATH, HOST_GH_WRAPPER, OPENCODE_WORKER_PERMISSION, HOST_USER, MIGRATE_SOURCE_VARIABLE, SIGNIN_CLAIM_VARIABLE } from '../src/install/host.js';
import { hostSizing, recommendServerType, parseServerTypes } from '../src/install/pricing.js';
import { ensureTokens, fingerprint, installDirectory, plannedPrincipals, Vault, writeInstallRecord } from '../src/install/secrets.js';
import { principalSchema } from '../src/server/principals.js';
import { workerConfinementRefusal } from '../src/master/profiles.js';
import { connectProvider } from '../src/fleet.js';
import { createPiHome, writeProviderAuthFile } from '../src/master/connect-accounts.js';
import { authenticate } from '../src/server/auth.js';
import { signinRoutes, claimHashOf } from '../src/server/routes/signin.js';
import { claimFromHash } from '../web/pages/login.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { allText, appKey, harness, GRAPHYARD_APP_ID, HETZNER_SERVER_TYPES, type Harness } from './install-harness.js';

// GY-717: the self-contained Graphyard host. Each test is named for the proof it produces, and its
// title states the behaviour in that proof's own criterion's words, so a producer's stripped run
// removes — and names — that criterion and nothing adjacent: unit:host-install-plan exercises AC-1
// (one machine provisioning every unit, runtime and credential path, no secret in the plan output),
// unit:self-contained-auth-plan exercises AC-4 (authentication for a self-contained install needs
// no SSH and no manual file editing), unit:host-migration exercises AC-3 (the database moves
// without losing work, and the old loop is refused leases after cutover), and
// unit:host-size-and-price-confirmed exercises AC-5 (the size follows the planned concurrency, the
// price is shown before anything is created, and creation is refused unconfirmed).

const CONFIG = '/home/graphyard/.config/graphyard/owner-project';
const hostInputs = (extra: Partial<InstallInputs> = {}): InstallInputs => ({ repository: 'owner/project', provider: 'host', selfContained: true, sshHost: '203.0.113.20', sshUser: 'root', domain: 'graphyard.example.test', ...extra });
const hetznerInputs = (extra: Partial<InstallInputs> = {}): InstallInputs => ({ repository: 'owner/project', provider: 'hetzner', selfContained: true, sshKey: 'graphyard-key', domain: 'graphyard.example.test', ...extra });

const hostOf = (fixture: Harness) => [...fixture.remotes.values()][0];
const hostLines = (fixture: Harness) => hostOf(fixture).commands.map(command => [command.program, ...command.args].join(' '));
const serverEnv = (fixture: Harness) => parseEnv(fixture.hostFiles.get('/opt/graphyard/owner-project/server.env')!.content);

async function applyHost(fixture: Harness, inputs: InstallInputs) {
  const session = await prepareInstall(fixture.root, inputs, fixture.deps);
  const plan = await buildPlan(session);
  return { session, plan, summary: await applyInstall(session, plan) };
}

test('unit:host-install-plan — the host plan names every unit, runtime and credential path, and discloses no secret', async () => {
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test' });
  try {
    const plan = await buildPlan(await prepareInstall(fixture.root, hostInputs({ workers: 2 }), fixture.deps, 'plan'));
    assert.equal(plan.secretsRedacted, true);
    assert.ok(plan.preflight.every(item => item.ok), JSON.stringify(plan.preflight.filter(item => !item.ok)));
    const host = plan.host!;
    assert.equal(host.user, HOST_USER);
    assert.equal(host.configDirectory, CONFIG);

    // Postgres, the server and TLS are system units; Herdr, the loop and the executors run in the graphyard user manager.
    const units = Object.fromEntries(host.units.map(unit => [unit.name, unit]));
    for (const name of ['graphyard-postgres.service', 'graphyard-server.service', 'graphyard-proxy.service']) assert.equal(units[name]?.path, `/etc/systemd/system/${name}`, name);
    assert.equal(units['graphyard-herdr.service']?.path, '/home/graphyard/.config/systemd/user/graphyard-herdr.service');
    assert.equal(units['graphyard-master.service']?.path, '/home/graphyard/.config/systemd/user/graphyard-master.service');
    assert.ok(units['graphyard-executor@1.service'] && units['graphyard-executor@2.service'], 'executor slots are supervised units');

    assert.deepEqual(host.runtimes.map(runtime => runtime.kind), ['claude', 'codex', 'opencode', 'pi']);
    // Every credential lives under the host account's ~/.config/graphyard/<install>/ with mode 0600.
    for (const credential of host.credentials) {
      assert.ok(credential.path.startsWith(`${CONFIG}/`), credential.path);
      assert.equal(credential.mode, '0600');
    }
    for (const principal of plan.principals) assert.ok(host.credentials.some(entry => entry.path === `${CONFIG}/tokens/${principal.id}.token`), principal.id);
    for (const kind of ['claude', 'codex', 'opencode', 'pi']) assert.ok(host.accounts.some(account => account.runtime === kind && account.home === `${CONFIG}/accounts/${kind}-a`), kind);
    // The dashboard reaches sessions on the same machine: no relay is provisioned, and the plan says so.
    assert.equal(host.sessionViewer, 'local');
    assert.equal(plan.actions.find(action => action.id === 'host.session-viewer')?.state, 'satisfied');
    // Workers' GitHub credential: minted on the host from the App key, never typed in.
    assert.ok(host.credentials.some(entry => entry.path === `${CONFIG}/github/app-private-key.pem`));
    assert.match(plan.actions.find(action => action.id === 'host.github')!.title, /mint one-hour App installation tokens narrowed to owner\/project/);
    assert.ok(!plan.actions.some(action => action.id === 'local.profiles'), 'profiles are not registered on the operator machine');
  } finally { await fixture.cleanup(); }
});

test('unit:host-install-plan — apply provisions the fixture host: units, runtimes, loop, executors, Herdr and 0600 credentials', async () => {
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test' });
  try {
    const { session, summary } = await applyHost(fixture, hostInputs());
    const lines = hostLines(fixture);
    const files = fixture.hostFiles;

    // Workers install dependencies and run unit proofs under bubblewrap, so the bootstrap provides it
    // and proves the unprivileged user namespaces it needs by running it.
    const bootstrap = lines.find(line => line.startsWith('sh -c set -eu'))!;
    assert.match(bootstrap, /command -v bwrap >\/dev\/null \|\| apt-get install -y bubblewrap/);
    assert.match(bootstrap, /kernel\.apparmor_restrict_unprivileged_userns=0/);
    assert.match(bootstrap, /\nbwrap --unshare-user --ro-bind \/ \/ true/);

    for (const name of ['graphyard-postgres.service', 'graphyard-server.service', 'graphyard-proxy.service']) {
      const unit = files.get(`/etc/systemd/system/${name}`)!;
      assert.ok(unit, name);
      assert.match(unit.content, /Restart=always/);
      assert.match(unit.content, /WorkingDirectory=\/opt\/graphyard\/owner-project/);
      assert.doesNotMatch(unit.content, /@[A-Z]+@/, `${name} was rendered`);
    }
    assert.equal(files.get('/home/graphyard/.config/systemd/user/graphyard-herdr.service')?.owner, '1001:1001');
    assert.ok(lines.includes('systemctl enable --now graphyard-postgres.service'));
    assert.ok(lines.includes('systemctl restart graphyard-server.service graphyard-proxy.service'));
    assert.ok(!lines.some(line => line.startsWith('docker build ')), 'a pulled release image is not rebuilt');
    assert.ok(lines.some(line => line.startsWith('npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai @mariozechner/pi-coding-agent')));
    assert.ok(lines.some(line => line.includes('systemctl --user enable --now graphyard-herdr.service')));
    assert.ok(lines.some(line => line.includes('workspace create --cwd /home/graphyard/code/owner-project --label graphyard-owner-project')));

    // Every principal credential is written on the host only, 0600, owned by the graphyard account.
    for (const principal of session.principals) {
      const file = files.get(`${CONFIG}/tokens/${principal.id}.token`)!;
      assert.equal(file.mode, 0o600, principal.id);
      assert.equal(file.owner, '1001:1001');
      assert.equal(file.content.trim(), session.tokens.get(principal.id));
    }
    assert.equal(files.get(`${CONFIG}/database.password`)?.mode, 0o600);
    // No credential is written on the operator's machine: only the install record lives there.
    assert.ok(![...fixture.transport.files.keys()].some(path => path.endsWith('.token')));

    // The loop takes the coordinator credential on standard input and is supervised; executors are installed.
    const master = hostOf(fixture).commands.find(command => command.args.includes('master') && command.args.includes('init'))!;
    assert.equal(master.input, session.tokens.get('owner-project-master'));
    assert.ok(!master.args.some(arg => arg.includes(master.input!)), 'the coordinator credential is never an argument');
    assert.ok(master.args.includes('--herdr-workspace') && master.args.includes('w1'));
    assert.ok(lines.some(line => line.includes('graphyard-executor.mjs --install --count 2')));
    assert.ok(lines.some(line => line.includes('systemctl --user enable --now graphyard-master.service')));

    // master init keeps its copy of the coordinator credential inside <install>/, and the executors
    // create every connected account's login home under <install>/accounts.
    assert.ok(master.args.includes(`GRAPHYARD_CONFIG_HOME=${CONFIG}`), master.args.join(' '));
    assert.ok(lines.some(line => line.includes(`systemctl --user set-environment GRAPHYARD_AGENT_ENVIRONMENTS=${CONFIG}/accounts GRAPHYARD_CONFIG_HOME=${CONFIG}`)));
    assert.match(files.get('/home/graphyard/.config/environment.d/graphyard.conf')!.content, new RegExp(`^GRAPHYARD_AGENT_ENVIRONMENTS=${CONFIG}/accounts$`, 'm'));
    assert.ok(lines.includes(`install -d -m 0700 -o graphyard -g graphyard ${CONFIG}/accounts`));
    // A fresh registry gets no placeholder accounts: each joins when it is connected from the dashboard.
    assert.ok(!fixture.requests.some(request => request.url.endsWith('/api/agent-registry/apply')), 'no account is registered before it is connected');
    assert.deepEqual(summary.host!.accounts.map(account => [account.name, account.login]), ['claude', 'codex', 'opencode', 'pi'].map(kind => [`${kind}-a`, null]));

    // The managed repository is cloned with the App's installation token on standard input: never an argument, never stored.
    const clone = hostOf(fixture).commands.find(command => command.args.some(arg => arg.includes('clone --quiet')))!;
    assert.equal(clone.input, 'installation-token-for-tests');
    assert.ok(clone.args.includes('https://github.com/owner/project.git'));
    assert.ok(!clone.args.some(arg => arg.includes('installation-token-for-tests')));
    assert.ok(![...files.values()].some(file => file.content.includes('installation-token-for-tests')), 'the clone token is written nowhere on the host');

    // Workers push and open pull requests with nobody logging in: gh is installed, the App key and the
    // token helper sit in <install>/github at 0600, gh is wrapped, and git is pointed at the helper.
    assert.match(bootstrap, /command -v gh >\/dev\/null \|\| \(apt-get update && apt-get install -y gh\)/);
    for (const name of ['app.json', 'app-private-key.pem', 'graphyard-github-credential.mjs']) {
      const file = files.get(`${CONFIG}/github/${name}`)!;
      assert.ok(file, name);
      assert.equal(file.mode, 0o600, name);
      assert.equal(file.owner, '1001:1001', name);
    }
    assert.equal(files.get(`${CONFIG}/github/app-private-key.pem`)!.content.trim(), appKey.trim());
    assert.deepEqual(JSON.parse(files.get(`${CONFIG}/github/app.json`)!.content), { appId: GRAPHYARD_APP_ID, installationId: 500, repository: 'owner/project' });
    assert.equal(files.get(HOST_GH_WRAPPER)?.mode, 0o755);
    assert.ok(lines.some(line => line.endsWith(`git config --global credential.https://github.com.helper !node ${CONFIG}/github/graphyard-github-credential.mjs`)), 'git uses the helper for github.com');
    assert.ok(lines.some(line => line.endsWith('git config --global user.name graphyard-owner-project[bot]')), 'commits carry the App bot identity');

    assert.deepEqual(summary.host!.units.filter(unit => unit.active !== 'active'), []);
    assert.equal(summary.host!.sessionViewer, 'local');
    assert.equal(summary.profiles.master.configured, true);

    // No secret reaches plan output, and a re-plan reads the credentials back from the host rather than rotating them.
    const again = await prepareInstall(fixture.root, hostInputs(), fixture.deps, 'plan');
    for (const [principal, token] of session.tokens) assert.equal(again.tokens.get(principal), token, `${principal} rotated`);
    const replanned = JSON.stringify(await buildPlan(again));
    for (const token of session.tokens.values()) assert.ok(!replanned.includes(token));
    assert.ok(!replanned.includes(session.context.databasePassword));
    assert.ok(!replanned.includes(appKey.split('\n')[1]) && !JSON.stringify(summary).includes(appKey.split('\n')[1]), 'the App key reaches no plan or summary');
    assert.match(replanned, /"fingerprint":"[0-9a-f]{12}"/);
  } finally { await fixture.cleanup(); }
});

test('unit:host-install-plan — every installed worker profile passes the launch confinement check, opencode included', async () => {
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test' });
  try {
    await applyHost(fixture, hostInputs({ workers: 3 }));
    const profiles = [...fixture.hostFiles.entries()].filter(([path]) => path.startsWith(`${CONFIG}/profiles/`)).map(([, file]) => JSON.parse(file.content));
    assert.deepEqual(profiles.map(profile => profile.kind).sort(), ['claude', 'codex', 'opencode']);
    for (const profile of profiles) assert.equal(workerConfinementRefusal(profile), null, profile.name);
    assert.equal(profiles.find(profile => profile.kind === 'opencode').environment.OPENCODE_PERMISSION, OPENCODE_WORKER_PERMISSION);
  } finally { await fixture.cleanup(); }
});

test('unit:host-install-plan — the Graphyard server starts on the host even when the registry has no release image: the host builds it from its own checkout before the server unit starts', async () => {
  const image = 'ghcr.io/cryptob1/graphyard:';
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test',
    extraResponses: [{ match: 'docker image inspect', result: { stdout: '', stderr: 'Error response from daemon: No such image', code: 1 } }] });
  try {
    const { plan } = await applyHost(fixture, hostInputs());
    assert.match(plan.actions.find(action => action.id === 'host.image')!.title, /when the registry does not have it, build it on the host from \/home\/graphyard\/graphyard/);
    const lines = hostLines(fixture);
    const build = lines.findIndex(line => line.startsWith('docker build ') && line.includes(`--tag ${image}`) && line.endsWith(' /home/graphyard/graphyard'));
    assert.ok(build >= 0, 'the image is built from the host\'s Graphyard checkout');
    assert.match(lines[build], /--build-arg GRAPHYARD_BUILD_REVISION=\S+/);
    assert.ok(build > lines.findIndex(line => line.includes('compose.yaml pull')), 'the build is the fallback after the pull');
    assert.ok(build < lines.indexOf('systemctl restart graphyard-server.service graphyard-proxy.service'), 'the image exists before the server unit starts');
  } finally { await fixture.cleanup(); }
});

test('unit:host-install-plan — a server image that can be neither pulled nor built fails the install with the reason', async () => {
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test',
    extraResponses: [
      { match: 'docker image inspect', result: { stdout: '', stderr: 'No such image', code: 1 } },
      { match: 'docker build', result: { stdout: '', stderr: 'failed to solve: npm ci exited 1', code: 1 } },
    ] });
  try {
    await assert.rejects(applyHost(fixture, hostInputs()), /could not be pulled, and building it from \/home\/graphyard\/graphyard at \S+ failed: failed to solve: npm ci exited 1/);
    assert.ok(!hostLines(fixture).includes('systemctl restart graphyard-server.service graphyard-proxy.service'), 'no server is started without an image');
  } finally { await fixture.cleanup(); }
});

test('unit:host-install-plan — a loop that cannot be set up on the host fails the install instead of reporting success', async () => {
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test',
    extraResponses: [{ match: 'master init', result: { stdout: '', stderr: 'master init: Herdr workspace w1 is not reachable', code: 1 } }] });
  try {
    await assert.rejects(applyHost(fixture, hostInputs()), /master init did not complete on graphyard-host: master init: Herdr workspace w1 is not reachable/);
    assert.ok(!hostLines(fixture).some(line => line.includes('graphyard-executor.mjs --install')), 'nothing is supervised after the failure');
  } finally { await fixture.cleanup(); }
});

test('unit:host-install-plan — a re-apply that cannot read the host\'s existing credentials refuses instead of rotating them', async () => {
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test' });
  try {
    await applyHost(fixture, hostInputs());
    const password = fixture.hostFiles.get(`${CONFIG}/database.password`)!.content;
    // The same host and operator machine, with the SSH read of the database password failing transiently.
    const flaky = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test', root: fixture.root, configHome: fixture.configHome, hostFiles: fixture.hostFiles,
      extraResponses: [{ match: `cat ${CONFIG}/database.password`, result: { stdout: '', stderr: 'ssh: connect to host 203.0.113.20 port 22: Connection timed out', code: 255 } }] });
    await assert.rejects(applyHost(flaky, hostInputs()), /existing credentials could not be read, so none is generated .*database\.password: exit 255 ssh: connect to host/);
    assert.equal(fixture.hostFiles.get(`${CONFIG}/database.password`)!.content, password, 'the database password is not rotated');
  } finally { await fixture.cleanup(); }
});

test('unit:host-install-plan — a private managed repository that cannot be cloned fails the install with the reason', async () => {
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test',
    extraResponses: [{ match: 'clone --quiet', result: { stdout: '', stderr: "remote: Repository not found.\nfatal: repository 'https://github.com/owner/project.git/' not found", code: 128 } }] });
  try {
    await assert.rejects(applyHost(fixture, hostInputs()), /Cloning owner\/project into \/home\/graphyard\/code\/owner-project on graphyard-host failed: .*not found/);
  } finally { await fixture.cleanup(); }
});

test('unit:self-contained-auth-plan — self-contained authentication needs no SSH and no manual file editing: the cloud provisioning token is used only by the installer and never stored on the host, the installer generates Graphyard\'s own principals and prints one admin sign-in for the dashboard, and every agent account is connected from the dashboard — API keys pasted once and sealed to the host (never returned by any API), subscription logins by the runtime\'s own device-code or setup-token flow shown in the dashboard', async () => {
  const PROVISIONING_TOKEN = 'hcloud-provisioning-token-0123456789abcdefghijklmnopqrstuvwxyz';
  const previous = process.env.HCLOUD_TOKEN;
  process.env.HCLOUD_TOKEN = PROVISIONING_TOKEN;
  const fixture = await harness({ provider: 'hetzner', selfContained: true, serverUrl: 'https://graphyard.example.test',
    extraResponses: [{ match: 'hcloud context active', result: 'graphyard' }] });
  try {
    const { session, plan, summary } = await applyHost(fixture, hetznerInputs({ maxMonthly: 25 }));

    // (a) The cloud token is used by the installer here and never stored on, sent to, or run on the host.
    const hostText = [...fixture.hostFiles.values()].map(file => file.content).join('\n') + hostOf(fixture).commands.map(command => `${command.args.join(' ')} ${command.input ?? ''}`).join('\n');
    assert.ok(!hostText.includes(PROVISIONING_TOKEN));
    assert.ok(!allText(fixture).includes(PROVISIONING_TOKEN));
    assert.ok(!fixture.transport.commands.some(command => /hcloud.*(context export|cli\.toml)|\.config\/hcloud/.test(`${command.program} ${command.args.join(' ')}`)), 'the installer never reads the hcloud credential');

    // (b) Graphyard's own principals are generated for the host and written there, 0600.
    for (const principal of plan.principals) {
      const file = fixture.hostFiles.get(`${CONFIG}/tokens/${principal.id}.token`);
      assert.ok(file, principal.id);
      assert.equal(file!.mode, 0o600);
    }
    // One admin sign-in is printed; the host holds only its hash, and the plan never holds it.
    const claim = new URL(summary.signIn!).hash;
    const code = claimFromHash(claim)!;
    assert.ok(code, summary.signIn);
    assert.equal(serverEnv(fixture)[SIGNIN_CLAIM_VARIABLE], claimHash(code));
    assert.ok(!hostText.includes(code), 'the claim itself never reaches the host');
    assert.ok(!JSON.stringify(plan).includes(code));
    assert.ok(!JSON.stringify(summary).includes(session.tokens.get('owner-project-operator')!), 'the admin credential is not printed');

    // (c) GitHub is connected through the existing App-manifest flow.
    assert.equal(plan.actions.find(action => action.id === 'github.app')?.state, 'create');
    // (d) Every runtime the host installs has a dashboard connection path, with a sealed key or the runtime's own login.
    for (const runtime of hostRuntimes) {
      const action = plan.actions.find(entry => entry.id === `dashboard.connect.${runtime.kind}`)!;
      assert.ok(action, runtime.kind);
      assert.ok(action.title.includes(CONNECT_PATH), action.title);
      assert.match(action.human!, /nobody logs into the host/);
      assert.ok(runtime.connections.length, runtime.kind);
      for (const entry of runtime.connections) {
        assert.ok(entry.dashboard.startsWith(CONNECT_PATH) && entry.file, entry.provider);
        // The path is one the dashboard really offers: a connect provider for this same runtime, writing this same file.
        const provider = connectProvider(entry.provider);
        assert.ok(provider, `${entry.provider} is offered by ${CONNECT_PATH}`);
        assert.equal(provider!.runtime, runtime.kind, `${entry.provider} connects a ${runtime.kind} account`);
        assert.equal(provider!.kind, entry.method === 'api-key' ? 'api-key' : 'subscription', entry.provider);
        assert.equal(entry.method === 'api-key' ? provider!.authFile : provider!.loginFile, entry.file, entry.provider);
      }
    }
    // Each account's credential is a file one of its runtime's connections writes in its own login home.
    for (const account of plan.host!.accounts) assert.ok(account.connections.some(entry => account.credentialFile === `${account.home}/${entry.file}`), `${account.name}: ${account.credentialFile}`);
    // Pi, end to end on disk: the pasted key lands in Pi's own auth document in a pi-<letter> home, 0600,
    // with z.ai as the default provider the registry account launches with — no OpenCode account involved.
    const accounts = await temporaryDirectory('gy717-accounts');
    const pi = await createPiHome(accounts);
    assert.equal(pi.name, 'pi-a');
    const zaiKey = 'zai-fixture-key-for-the-pi-connect';
    const written = await writeProviderAuthFile(connectProvider('pi-zai')!, pi.home, zaiKey);
    assert.equal(written, join(pi.home, 'auth.json'));
    assert.deepEqual(JSON.parse(readFileSync(written, 'utf8')), { zai: { type: 'api_key', key: zaiKey } });
    assert.equal(statSync(written).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(join(pi.home, 'settings.json'), 'utf8')).defaultProvider, 'zai');
    assert.equal((await createPiHome(accounts)).name, 'pi-b', 'a second Pi connect takes the next free home');
    assert.deepEqual(hostRuntimes.find(runtime => runtime.kind === 'claude')!.connections.map(entry => entry.method), ['login', 'api-key']);
    assert.match(plan.actions.find(action => action.id === 'dashboard.connect.pi')!.title, /seals it to the host, the server keeps only ciphertext and never returns it/);
    assert.match(plan.actions.find(action => action.id === 'dashboard.connect.codex')!.title, /shows its URL and code/);
    for (const account of plan.host!.accounts) assert.ok(account.credentialFile.startsWith(`${CONFIG}/accounts/`), account.credentialFile);
  } finally {
    if (previous === undefined) delete process.env.HCLOUD_TOKEN; else process.env.HCLOUD_TOKEN = previous;
    await fixture.cleanup();
  }
});

test('unit:self-contained-auth-plan — with no SSH and no manual file editing, a worker on a fresh host has a working push and pull request credential: git\'s credential helper and the gh wrapper mint a narrowed one-hour App installation token from the key the installer wrote', async () => {
  const directory = await temporaryDirectory('gy717-github');
  const requests: { url: string; authorization: string; body: any }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url ?? '', authorization: String(request.headers.authorization ?? ''), body: JSON.parse(body || '{}') });
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ token: `minted-worker-token-${requests.length}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The files the installer puts on the host, written into a scratch <install>/github.
    const layout = { ...hostLayout('owner-project', '/opt/graphyard/owner-project', '/var/lib/graphyard/owner-project'), githubDirectory: directory };
    for (const file of hostGithubFiles(layout, 'owner/project', { appId: GRAPHYARD_APP_ID, installationId: 500, slug: 'graphyard-owner-project', privateKey: appKey }, '1001:1001')) {
      if (file.path === HOST_GH_WRAPPER) continue;
      writeFileSync(file.path, file.path.endsWith('app.json') ? JSON.stringify({ ...JSON.parse(file.content), api }) : file.content, { mode: file.mode });
    }
    const helper = join(directory, 'graphyard-github-credential.mjs');
    const env = { PATH: process.env.PATH ?? '', HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    const run = (program: string, args: string[], input = '') => new Promise<string>((resolve, reject) => {
      const child = execFile(program, args, { env, timeout: 30_000 }, (error, stdout, stderr) => error ? reject(new Error(`${program} ${args.join(' ')}: ${stderr || error.message}`)) : resolve(stdout));
      child.stdin!.end(input);
    });

    // git push authenticates through the helper exactly as the host's git config points it.
    const filled = await run('git', ['-c', 'credential.helper=', '-c', `credential.https://github.com.helper=!node ${helper}`, 'credential', 'fill'], 'protocol=https\nhost=github.com\npath=owner/project.git\n\n');
    assert.match(filled, /^username=x-access-token$/m);
    assert.match(filled, /^password=minted-worker-token-1$/m);
    // The token is an App installation token for this installation, narrowed to the managed repository.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/app/installations/500/access_tokens');
    assert.deepEqual(requests[0].body, { repositories: ['project'], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } });
    const [header, claims, signature] = requests[0].authorization.replace(/^Bearer /, '').split('.');
    assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(createPublicKey(appKey), signature, 'base64url'), 'signed with the App key');
    assert.equal(JSON.parse(Buffer.from(claims, 'base64url').toString()).iss, String(GRAPHYARD_APP_ID));
    assert.equal(statSync(join(directory, 'token.json')).mode & 0o777, 0o600, 'the cached token is private');

    // gh pr create takes GH_TOKEN from the wrapper; the cached token is reused, not re-minted.
    const fakeGh = join(directory, 'fake-gh');
    writeFileSync(fakeGh, '#!/bin/sh\necho "GH_TOKEN=$GH_TOKEN args=$*"\n', { mode: 0o755 });
    const wrapper = join(directory, 'gh');
    writeFileSync(wrapper, ghWrapper(helper, fakeGh), { mode: 0o755 });
    assert.equal((await run(wrapper, ['pr', 'create', '--fill'])).trim(), 'GH_TOKEN=minted-worker-token-1 args=pr create --fill');
    assert.equal(requests.length, 1, 'a cached token is reused until near its expiry');
    // Another host's credential request is left to git's next helper.
    assert.doesNotMatch(await run('node', [helper, 'get'], 'protocol=https\nhost=example.test\n\n'), /password=/);
  } finally {
    server.close();
  }
});

test('unit:self-contained-auth-plan — the sign-in claim is spent once and refused afterwards', async () => {
  const code = 'claim-for-the-signin-route-test-0123456789';
  const events: string[] = [];
  const services: any = {
    signinClaim: { hash: claimHashOf(code), principal: 'owner-project-operator', token: 'admin-token-for-the-signin-route-test-0123456789' },
    engine: { store: { transaction: async (fn: any) => fn({ query: async (sql: string, values: unknown[]) => {
      if (sql.startsWith('SELECT')) return { rowCount: events.includes(String(values[1])) ? 1 : 0, rows: [] };
      events.push(JSON.parse(String(values[2])).claim); return { rowCount: 1, rows: [] };
    } }) } },
  };
  const route = signinRoutes.routes[0];
  const call = async (presented: string) => {
    let status = 200, body: unknown = null;
    const result = await route.handle({ services, body: async () => Buffer.from(JSON.stringify({ code: presented })), send: (code: number, data: unknown) => { status = code; body = data; return Symbol.for('sent') as any; } } as any, []);
    return { status, body: body ?? result };
  };
  assert.equal((await call('not-the-claim-0123456789')).status, 401);
  const first = await call(code);
  assert.equal(first.status, 200);
  assert.equal((first.body as any).token, services.signinClaim.token);
  assert.equal((await call(code)).status, 410, 'a spent claim is refused');
});

test('unit:host-migration — --migrate moves the database (backup/restore) onto the host without losing work: every old writer is fenced before the snapshot, the verified backup is restored before the server starts, executors and agent accounts are re-registered, the old loop is left stopped, and the old loop is refused leases after cutover', async () => {
  const OLD_DATABASE = 'postgres://graphyard:old-database-password-0123456789@old.example.test:5432/graphyard';
  const BACKUP = JSON.stringify({ format: 'graphyard-backup-v1', digest: `sha256:${'b'.repeat(64)}`, tables: [], sequences: [] });
  const oldRegistry = { version: 1, revision: 7, updatedAt: null, sessions: [], refusals: [], lastMutation: null,
    runtimes: [{ name: 'claude', launch: { kind: 'claude', args: [], environment: {}, homeVariable: 'CLAUDE_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: '.credentials.json' } }, { name: 'cursor', launch: { kind: 'cursor', args: [], environment: {}, homeVariable: null, modelFlag: null, login: null, loginFile: null } }],
    models: [{ name: 'opus', id: 'claude-opus', cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'frontier', contextTokens: null } }],
    accounts: [
      { name: 'claude-primary', runtime: 'claude', model: 'opus', credential: { host: 'install-test-host', home: '/home/operator/.coding_agents/claude-a' }, enabled: true, maxSessions: 2 },
      { name: 'claude-laptop', runtime: 'claude', model: 'opus', credential: { host: 'laptop', home: '/home/operator/.coding_agents/claude-b' }, enabled: true, maxSessions: null },
      { name: 'cursor-primary', runtime: 'cursor', model: 'opus', credential: { host: 'workstation', home: null }, enabled: true, maxSessions: null },
    ],
    roles: [{ name: 'worker', accounts: ['claude-primary', 'claude-laptop', 'cursor-primary'], concurrency: 4 }] };
  const LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: 'old-machine-access-token-0123456789', refreshToken: 'old-machine-refresh-token-0123456789' } });
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test', registry: oldRegistry,
    extraResponses: [
      { match: 'is-active graphyard-master.service', result: { stdout: 'inactive\n', stderr: '', code: 3 } },
      // db backup really writes the file it names (mode 0600, like the CLI does), so the installer
      // reads the artifact itself rather than a scripted answer.
      { match: 'db backup', result: (line: string) => {
        const file = line.split(' ').pop()!;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, BACKUP, { mode: 0o600 });
        return JSON.stringify({ file, digest: JSON.parse(BACKUP).digest });
      } },
      { match: '/migration/backup-', result: BACKUP },
      { match: 'cat /home/operator/.coding_agents/claude-a/.credentials.json', result: LOGIN },
    ] });
  try {
    // The installation being moved: Railway, with its own credentials on this machine.
    const directory = installDirectory('owner-project', fixture.configHome);
    const oldVault = new Vault();
    const oldTokens = await (async () => { const { mkdir } = await import('node:fs/promises'); await mkdir(`${directory}/tokens`, { recursive: true, mode: 0o700 }); return ensureTokens(directory, plannedPrincipals('owner-project'), oldVault); })();
    const now = new Date().toISOString();
    await writeInstallRecord(directory, { version: 1, installId: 'owner-project', repository: 'owner/project', provider: 'railway', baseBranch: 'main', reviewPolicy: 'github', domain: null, url: 'https://old.up.railway.app',
      principals: plannedPrincipals('owner-project').map(principal => ({ id: principal.id, role: principal.role, fingerprint: fingerprint(oldTokens.get(principal.id)!) })), github: null, reviewers: [], profiles: [], createdAt: now, updatedAt: now }, oldVault);

    const deps = { ...fixture.deps, environment: { [MIGRATE_SOURCE_VARIABLE]: OLD_DATABASE } };
    const inputs = hostInputs({ migrate: true });
    const plan = await buildPlan(await prepareInstall(fixture.root, inputs, deps, 'plan'));
    assert.deepEqual(plan.host!.migration!.map(step => step.id), ['migrate.freeze', 'migrate.fence', 'migrate.backup', 'migrate.copy', 'migrate.restore', 'migrate.cutover', 'migrate.reregister']);
    assert.ok(!plan.drift.some(entry => entry.field === 'provider'), 'moving the provider is the migration, not drift');
    assert.ok(!JSON.stringify(plan).includes('old-database-password'), 'the old connection string never reaches the plan');

    const session = await prepareInstall(fixture.root, inputs, deps);
    const summary = await applyInstall(session, await buildPlan(session));

    // Order across both machines: freeze, backup, verify here; copy, restore there; only then the server.
    const timeline = [
      ...fixture.transport.commands.map(command => ({ where: 'local', command })),
    ];
    const local = timeline.map(entry => [entry.command.program, ...entry.command.args].join(' '));
    const freeze = local.findIndex(line => line === 'systemctl --user disable --now graphyard-master.service');
    const fence = local.findIndex(line => line.includes(' db fence'));
    const backup = local.findIndex(line => line.includes(' db backup '));
    const verify = local.findIndex(line => line.includes(' db verify '));
    // The old server, its webhooks and any session still calling it are fenced before the snapshot.
    assert.ok(freeze >= 0 && freeze < fence && fence < backup && backup < verify, local.join('\n'));
    assert.equal(fixture.transport.commands[fence].input, OLD_DATABASE, 'the old database reaches db fence on standard input');
    assert.ok(local.some(line => line === 'systemctl --user stop graphyard-executor@*.service'), 'the old executors are stopped');
    const backupCommand = fixture.transport.commands[backup];
    assert.equal(backupCommand.input, OLD_DATABASE, 'the old database reaches db backup on standard input');
    assert.ok(!backupCommand.args.join(' ').includes('old-database-password'));
    // The verified file crosses from the disk it was written to: no `cat` may carry it through a
    // command output buffer, which a grown ledger exceeds.
    assert.ok(!fixture.transport.commands.some(command => command.program === 'cat' && command.args[0]?.includes('/migration/')), 'the backup file is read from disk, not through an exec output buffer');

    const remote = hostLines(fixture);
    const postgres = remote.indexOf('systemctl enable --now graphyard-postgres.service');
    const restore = remote.findIndex(line => line.includes('db restore'));
    const server = remote.indexOf('systemctl restart graphyard-server.service graphyard-proxy.service');
    assert.ok(postgres >= 0 && postgres < restore && restore < server, remote.join('\n'));
    assert.equal(fixture.hostFiles.get(`${CONFIG}/migration/backup.json`)?.content, BACKUP);
    assert.equal(fixture.hostFiles.get(`${CONFIG}/migration/backup.json`)?.mode, 0o600);
    assert.ok(fixture.hostFiles.has(`${CONFIG}/migration/restored`));

    // The old loop is refused leases after cutover: its coordinator credential is not one the new server knows.
    const principals = principalSchema.parse(JSON.parse(serverEnv(fixture).GRAPHYARD_PRINCIPALS!));
    const { createHash } = await import('node:crypto');
    const services: any = {
      principals: principals.map(({ token, ...actor }) => ({ actor, hash: createHash('sha256').update(token).digest() })),
      operatorAgents: { authenticate: async () => null, assertConfiguredPrincipalSafe: async () => {} },
    };
    const renew = (token: string) => authenticate(services, `Bearer ${token}`, 'owner/project', 'POST', '/api/work/GY-1/renew');
    await assert.rejects(renew(oldTokens.get('owner-project-master')!), (error: any) => error.status === 401 || /valid Graphyard bearer token/.test(error.message));
    assert.equal((await renew(session.tokens.get('owner-project-master')!)).id, 'owner-project-master');

    // Executors re-register from the host's units; registry accounts of installed runtimes move onto the host.
    assert.ok(remote.some(line => line.includes('graphyard-executor.mjs --install --count 2')));
    const change = JSON.parse(fixture.requests.find(request => request.url.endsWith('/api/agent-registry/apply'))!.body!);
    assert.deepEqual(change.accounts.map((account: any) => [account.name, account.model, account.credential.host, account.credential.home, account.maxSessions, account.enabled]),
      [['claude-primary', 'opus', 'graphyard-host', `${CONFIG}/accounts/claude-primary`, 2, true], ['claude-laptop', 'opus', 'graphyard-host', `${CONFIG}/accounts/claude-laptop`, null, false]]);
    assert.match(change.accounts[1].note, /connect it again in Settings › Agents › Connect an account/);
    assert.deepEqual(change.roles, [], 'existing roles are kept as they are');
    assert.deepEqual(summary.host!.accounts.map(account => [account.name, account.moved, account.login]), [['claude-primary', true, 'copied'], ['claude-laptop', true, 'connect']]);
    // A login on this machine comes along: only the login file, 0600, owned by the graphyard account, never in any output.
    const copied = fixture.hostFiles.get(`${CONFIG}/accounts/claude-primary/.credentials.json`)!;
    assert.deepEqual([copied.content, copied.mode, copied.owner], [LOGIN, 0o600, '1001:1001']);
    assert.ok(!JSON.stringify(summary).includes('old-machine-access-token'));

    // The record says where the installation came from, by fingerprint only.
    const { readInstallRecord } = await import('../src/install/secrets.js');
    const record = (await readInstallRecord(directory))!;
    assert.equal(record.provider, 'host');
    assert.equal(record.selfContained, true);
    assert.equal(record.migratedFrom?.provider, 'railway');
  } finally { await fixture.cleanup(); }
});

test('unit:host-migration — a migration that fails before cutover releases the old database\'s fence, so the old installation keeps its work writable', async () => {
  const OLD_DATABASE = 'postgres://graphyard:old-database-password-0123456789@old.example.test:5432/graphyard';
  const BACKUP = JSON.stringify({ format: 'graphyard-backup-v1', digest: `sha256:${'c'.repeat(64)}`, tables: [], sequences: [] });
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test',
    extraResponses: [
      { match: 'is-active graphyard-master.service', result: { stdout: 'inactive\n', stderr: '', code: 3 } },
      { match: 'db backup', result: (line: string) => {
        const file = line.split(' ').pop()!;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, BACKUP, { mode: 0o600 });
        return JSON.stringify({ file });
      } },
      { match: 'db restore', result: { stdout: '', stderr: 'db restore: the target database is not empty', code: 1 } },
    ] });
  try {
    const deps = { ...fixture.deps, environment: { [MIGRATE_SOURCE_VARIABLE]: OLD_DATABASE } };
    const session = await prepareInstall(fixture.root, hostInputs({ migrate: true }), deps);
    await assert.rejects(applyInstall(session, await buildPlan(session)), /not empty/);
    const local = fixture.transport.commands.map(command => [command.program, ...command.args].join(' '));
    const fence = local.findIndex(line => line.includes(' db fence') && !line.includes('--release'));
    const release = local.findIndex(line => line.includes(' db fence --release'));
    assert.ok(fence >= 0 && release > fence, local.join('\n'));
    assert.equal(fixture.transport.commands[release].input, OLD_DATABASE, 'the old database reaches the release on standard input');
    assert.ok(!hostLines(fixture).includes('systemctl restart graphyard-server.service graphyard-proxy.service'), 'the host server never starts on a failed restore');
    assert.ok(!fixture.hostFiles.has(`${CONFIG}/migration/restored`));
  } finally { await fixture.cleanup(); }
});

test('unit:host-migration — --migrate without the old database refuses before anything changes', async () => {
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test' });
  try {
    const session = await prepareInstall(fixture.root, hostInputs({ migrate: true }), { ...fixture.deps, environment: {} });
    const plan = await buildPlan(session);
    assert.equal(plan.preflight.find(item => item.name === 'Migration source')?.ok, false);
    await assert.rejects(applyInstall(session, plan), /Preflight is incomplete; the installer changed nothing/);
    assert.equal(fixture.hostFiles.size, 0);
  } finally { await fixture.cleanup(); }
});

test('unit:host-size-and-price-confirmed — the size follows the planned concurrency and the GY-612 bounds', () => {
  const offers = parseServerTypes(HETZNER_SERVER_TYPES, 'nbg1');
  assert.ok(!offers.some(offer => offer.name === 'cx11'), 'deprecated types are never recommended');
  // One worker and a reviewer: 2 × 3 GiB + 2 verification slots × 2 GiB + 2 GiB, above the 4 GiB floor → 16 GB.
  assert.deepEqual(hostSizing(16, 2), { agents: 2, totalGiB: 16, verificationSlots: 2, floorGiB: 4, requiredGiB: 12, fits: true });
  assert.equal(hostSizing(8, 2).fits, false);
  assert.equal(recommendServerType(offers, 2)?.name, 'cx42', 'the cheapest x86 type that fits');
  assert.equal(recommendServerType(offers, 6)?.name, 'cx52');
  assert.equal(recommendServerType(offers, 20), null);
});

test('unit:host-size-and-price-confirmed — --target hetzner shows the recommended type and its price, and refuses to create it unconfirmed', async () => {
  const fixture = await harness({ provider: 'hetzner', selfContained: true, serverUrl: 'https://graphyard.example.test' });
  try {
    const unconfirmed = await prepareInstall(fixture.root, hetznerInputs({ workers: 1 }), fixture.deps);
    const plan = await buildPlan(unconfirmed);
    assert.deepEqual({ type: plan.price?.serverType, monthly: plan.price?.monthly, currency: plan.price?.currency, recommended: plan.price?.recommended }, { type: 'cx42', monthly: 19.52, currency: 'EUR', recommended: true });
    const price = plan.preflight.find(item => item.name === 'Monthly price')!;
    assert.equal(price.ok, false);
    assert.match(price.detail, /cx42 \(16 GB\) at nbg1: 19\.52 EUR\/month/);
    assert.match(price.fix!, /--confirm-price 19\.52|--max-monthly/);
    assert.match(plan.actions.find(action => action.id === 'provider.provision.server')!.command!, /--type cx42/);
    await assert.rejects(applyInstall(unconfirmed, plan), /Preflight is incomplete; the installer changed nothing/);
    assert.ok(!fixture.commandLines().some(line => line.startsWith('hcloud server create') || line.startsWith('hcloud volume create')), 'nothing was bought');

    for (const [spend, ok] of [[{ maxMonthly: 10 }, false], [{ confirmPrice: 19.5 }, false], [{ maxMonthly: 20 }, true], [{ confirmPrice: 19.52 }, true]] as const) {
      const planned = await buildPlan(await prepareInstall(fixture.root, hetznerInputs({ workers: 1, ...spend }), fixture.deps, 'plan'));
      assert.equal(planned.preflight.find(item => item.name === 'Monthly price')!.ok, ok, JSON.stringify(spend));
    }

    const confirmed = await prepareInstall(fixture.root, hetznerInputs({ workers: 1, confirmPrice: 19.52 }), fixture.deps);
    await applyInstall(confirmed, await buildPlan(confirmed));
    const create = fixture.transport.commands.find(command => command.program === 'hcloud' && command.args[1] === 'create' && command.args[0] === 'server')!;
    assert.deepEqual(create.args.slice(create.args.indexOf('--type'), create.args.indexOf('--type') + 2), ['--type', 'cx42']);
    // One command from nothing to a running self-contained host: the created server is bootstrapped and runs the fleet.
    const lines = hostLines(fixture);
    assert.ok(lines.some(line => line.startsWith('sh -c set -eu')), 'the created server is bootstrapped');
    assert.ok(lines.some(line => line.includes('master init')));
    assert.ok(fixture.hostFiles.has('/etc/systemd/system/graphyard-server.service'));
    assert.match(fixture.hostFiles.get('/opt/graphyard/owner-project/compose.yaml')!.content, /\/mnt\/graphyard\/postgres/);
  } finally { await fixture.cleanup(); }
});
