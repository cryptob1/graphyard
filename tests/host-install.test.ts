import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { applyInstall, buildPlan, prepareInstall, type InstallInputs } from '../src/install/index.js';
import { claimHash, hostRuntimes, HOST_USER, MIGRATE_SOURCE_VARIABLE, SIGNIN_CLAIM_VARIABLE } from '../src/install/host.js';
import { hostSizing, recommendServerType, parseServerTypes } from '../src/install/pricing.js';
import { ensureTokens, fingerprint, installDirectory, plannedPrincipals, Vault, writeInstallRecord } from '../src/install/secrets.js';
import { principalSchema } from '../src/server/principals.js';
import { authenticate } from '../src/server/auth.js';
import { signinRoutes, claimHashOf } from '../src/server/routes/signin.js';
import { claimFromHash } from '../web/pages/login.js';
import { allText, harness, HETZNER_SERVER_TYPES, type Harness } from './install-harness.js';

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
    assert.ok(!plan.actions.some(action => action.id === 'local.profiles'), 'profiles are not registered on the operator machine');
  } finally { await fixture.cleanup(); }
});

test('unit:host-install-plan — apply provisions the fixture host: units, runtimes, loop, executors, Herdr and 0600 credentials', async () => {
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test' });
  try {
    const { session, summary } = await applyHost(fixture, hostInputs());
    const lines = hostLines(fixture);
    const files = fixture.hostFiles;

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

    // Accounts come from the installation's registry: each gets a 0700 home here and is registered on this host.
    for (const kind of ['claude', 'codex', 'opencode', 'pi']) assert.ok(lines.includes(`install -d -m 0700 -o graphyard -g graphyard ${CONFIG}/accounts/${kind}-a`), kind);
    const registryApply = fixture.requests.find(request => request.url.endsWith('/api/agent-registry/apply'))!;
    const change = JSON.parse(registryApply.body!);
    assert.deepEqual(change.accounts.map((account: any) => [account.name, account.credential.host, account.credential.home]),
      ['claude', 'codex', 'opencode', 'pi'].map(kind => [`${kind}-a`, 'graphyard-host', `${CONFIG}/accounts/${kind}-a`]));
    assert.deepEqual(change.roles.find((role: any) => role.name === 'approver').accounts, ['claude-a', 'codex-a', 'opencode-a', 'pi-a']);
    assert.ok(!change.roles.find((role: any) => role.name === 'worker').accounts.includes('pi-a'), 'Pi is proposed for the narrow roles only');

    assert.deepEqual(summary.host!.units.filter(unit => unit.active !== 'active'), []);
    assert.equal(summary.host!.sessionViewer, 'local');
    assert.equal(summary.profiles.master.configured, true);

    // No secret reaches plan output, and a re-plan reads the credentials back from the host rather than rotating them.
    const again = await prepareInstall(fixture.root, hostInputs(), fixture.deps, 'plan');
    for (const [principal, token] of session.tokens) assert.equal(again.tokens.get(principal), token, `${principal} rotated`);
    const replanned = JSON.stringify(await buildPlan(again));
    for (const token of session.tokens.values()) assert.ok(!replanned.includes(token));
    assert.ok(!replanned.includes(session.context.databasePassword));
    assert.match(replanned, /"fingerprint":"[0-9a-f]{12}"/);
  } finally { await fixture.cleanup(); }
});

test('unit:self-contained-auth-plan — no provisioning token on the host, principals generated there 0600, one sign-in, every runtime connected from the dashboard', async () => {
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
    // (d) Every runtime the host installs has a dashboard connection path; API keys are sealed, subscriptions use device-code or setup-token.
    for (const runtime of hostRuntimes) {
      const action = plan.actions.find(entry => entry.id === `dashboard.connect.${runtime.kind}`)!;
      assert.ok(action, runtime.kind);
      assert.match(action.title, /Agents → Connect an account/);
      assert.match(action.human!, /nobody logs into the host/);
    }
    assert.match(plan.actions.find(action => action.id === 'dashboard.connect.claude')!.title, /setup-token/);
    assert.match(plan.actions.find(action => action.id === 'dashboard.connect.codex')!.title, /device-code/);
    assert.match(plan.actions.find(action => action.id === 'dashboard.connect.pi')!.title, /sealed to the host/);
    for (const account of plan.host!.accounts) assert.ok(account.connections.length && account.connections.every(entry => entry.dashboard.startsWith('Agents → Connect an account')), account.name);
  } finally {
    if (previous === undefined) delete process.env.HCLOUD_TOKEN; else process.env.HCLOUD_TOKEN = previous;
    await fixture.cleanup();
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

test('unit:host-migration — --migrate freezes the old loop, backs up, restores before the server starts, and re-registers', async () => {
  const OLD_DATABASE = 'postgres://graphyard:old-database-password-0123456789@old.example.test:5432/graphyard';
  const BACKUP = JSON.stringify({ format: 'graphyard-backup-v1', digest: `sha256:${'b'.repeat(64)}`, tables: [], sequences: [] });
  const oldRegistry = { version: 1, revision: 7, updatedAt: null, sessions: [], refusals: [], lastMutation: null,
    runtimes: [{ name: 'claude', launch: { kind: 'claude', args: [], environment: {}, homeVariable: 'CLAUDE_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: '.credentials.json' } }, { name: 'cursor', launch: { kind: 'cursor', args: [], environment: {}, homeVariable: null, modelFlag: null, login: null, loginFile: null } }],
    models: [{ name: 'opus', id: 'claude-opus', cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'frontier', contextTokens: null } }],
    accounts: [
      { name: 'claude-primary', runtime: 'claude', model: 'opus', credential: { host: 'workstation', home: '/home/operator/.coding_agents/claude-a' }, enabled: true, maxSessions: 2 },
      { name: 'cursor-primary', runtime: 'cursor', model: 'opus', credential: { host: 'workstation', home: null }, enabled: true, maxSessions: null },
    ],
    roles: [{ name: 'worker', accounts: ['claude-primary', 'cursor-primary'], concurrency: 4 }] };
  const fixture = await harness({ provider: 'host', serverUrl: 'https://graphyard.example.test', registry: oldRegistry,
    extraResponses: [
      { match: 'is-active graphyard-master.service', result: { stdout: 'inactive\n', stderr: '', code: 3 } },
      { match: '/migration/backup-', result: BACKUP },
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
    assert.deepEqual(plan.host!.migration!.map(step => step.id), ['migrate.freeze', 'migrate.backup', 'migrate.copy', 'migrate.restore', 'migrate.cutover', 'migrate.reregister']);
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
    const backup = local.findIndex(line => line.includes(' db backup '));
    const verify = local.findIndex(line => line.includes(' db verify '));
    assert.ok(freeze >= 0 && freeze < backup && backup < verify, local.join('\n'));
    assert.ok(local.some(line => line === 'systemctl --user stop graphyard-executor@*.service'), 'the old executors are stopped');
    const backupCommand = fixture.transport.commands[backup];
    assert.equal(backupCommand.input, OLD_DATABASE, 'the old database reaches db backup on standard input');
    assert.ok(!backupCommand.args.join(' ').includes('old-database-password'));

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
    assert.deepEqual(change.accounts.map((account: any) => [account.name, account.model, account.credential.host, account.credential.home, account.maxSessions]),
      [['claude-primary', 'opus', 'graphyard-host', `${CONFIG}/accounts/claude-primary`, 2]]);
    assert.deepEqual(change.roles, [], 'existing roles are kept as they are');
    assert.deepEqual(summary.host!.accounts.map(account => [account.name, account.moved]), [['claude-primary', true]]);

    // The record says where the installation came from, by fingerprint only.
    const { readInstallRecord } = await import('../src/install/secrets.js');
    const record = (await readInstallRecord(directory))!;
    assert.equal(record.provider, 'host');
    assert.equal(record.selfContained, true);
    assert.equal(record.migratedFrom?.provider, 'railway');
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
