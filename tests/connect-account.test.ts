import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { connectDefaultRoles, connectProviders, parseLoginOutput, redactKey } from '../src/fleet.js';
import { checkAgentEnvironment, hostKeyPair, processConnectAccounts, unsealToHost, writeProviderAuthFile } from '../src/master/environments.js';
import { type FleetView } from '../src/model/registry.js';
import type { Principal } from '../src/model.js';
import { sealForHost } from '../web/seal.js';
import { ConnectCard, default as FleetPage, type ConnectView } from '../web/pages/fleet.js';

const operator: Principal = { id: 'operator', role: 'admin' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const principals = [operator, coordinator];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(40)}`]));
const HOST = 'connect-host-1';
/** A throwaway key made per run, so no key-shaped literal sits in the repository's history. */
const KEY = `fixture-${randomUUID()}`;

let database: EmbeddedPostgres, store: Store, engine: Engine;
let http: ReturnType<typeof server>, url: string, scratch: string, bin: string;
let originalPath = '';

before(async () => {
  const port = Number(process.env.GRAPHYARD_CONNECT_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 48);
  scratch = await mkdtemp(join(tmpdir(), 'graphyard-connect-'));
  bin = join(scratch, 'bin');
  await mkdir(bin, { recursive: true });
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('connect_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/connect_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  http = server(engine, principals.map(p => ({ ...p, token: tokens.get(p.id)! })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
  // The provider CLIs this host pretends to have: `login` prints a URL and code, then blocks — as
  // a real device login does — until the operator signs in (the test drops `signed-in` into the
  // login home), and only then writes the login file; anything else is the smoke prompt answering
  // fine. Real spawn, real PATH — only the executables are fakes.
  for (const command of ['codex', 'claude', 'opencode', 'cursor-agent']) {
    await writeFile(join(bin, command), [
      '#!/bin/sh',
      'case "$1" in',
      '  login)',
      '    echo "Visit https://example.com/device and enter code ABCD-1234"',
      '    while [ ! -f "$CODEX_HOME/signed-in" ]; do sleep 0.05; done',
      '    printf \'{"tokens":{"access_token":"fake-token"}}\\n\' > "$CODEX_HOME/auth.json"',
      '    ;;',
      '  *) exit 0;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });
  }
  originalPath = process.env.PATH ?? '';
  process.env.PATH = `${bin}:${originalPath}`;
  await writeFile(join(scratch, 'master.token'), tokens.get(coordinator.id)!, { mode: 0o600 });
  // The coordinator checkout's own configuration, as the host's executor finds it: the research
  // append lands here, never in the repository this test runs from.
  await writeFile(join(scratch, 'master.json'), JSON.stringify({
    version: 1, url: 'https://connect.test', credentialFile: join(scratch, 'master.token'), cliPath: join(bin, 'graphyard'),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 15368, hostId: HOST, masterAgentName: 'graphyard-master-project',
  }), { mode: 0o600 });
  // The worker's first pass registers this host's public key with the control plane.
  await runWorker();
});

after(async () => {
  process.env.PATH = originalPath;
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (database) await database.stop();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function call(path: string, actor: Principal, data?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, body: await response.json() as any };
}
const ok = async (path: string, actor: Principal, data?: unknown) => { const result = await call(path, actor, data); assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`); return result.body; };

/** The host worker's configuration and injectables, pointed at the test control plane. */
const workerOptions = (overrides: Record<string, unknown> = {}) => ({
  root: join(scratch, 'agents'),
  keyFile: join(scratch, 'connect.key'),
  binDirectory: join(scratch, 'wrapper-bin'),
  masterFile: join(scratch, 'master.json'),
  pollMs: 10,
  loginTimeoutMs: 15_000,
  smokeTimeoutMs: 10_000,
  ...overrides,
});
/** Run the host worker once over whatever connects are open. */
const runWorker = (overrides: Record<string, unknown> = {}) =>
  processConnectAccounts({ url, hostId: HOST, credentialFile: join(scratch, 'master.token') }, workerOptions(overrides));
/** The connect requests as the operator's browser sees them. */
const connectViews = async () => (await ok('agent-registry/connect', operator)).connects as ConnectView[];

test('unit:connect-account-default-roles — a strong account joins worker and reviewer, a cheap one research, approver and the unit producer, appended to the failover order', async () => {
  assert.deepEqual([...connectDefaultRoles('strong')], ['worker', 'reviewer']);
  assert.deepEqual([...connectDefaultRoles('fast')], ['research', 'approver', 'producer']);
  // A fleet that already serves its roles from one account, so the append order is visible.
  await ok('agent-registry/apply', operator, {
    runtimes: [
      { name: 'claude', launch: { kind: 'claude', args: [], environment: {}, homeVariable: 'CLAUDE_CONFIG_DIR', modelFlag: null, login: null, loginFile: '.credentials.json' } },
      { name: 'opencode', launch: { kind: 'opencode', args: [], environment: {}, homeVariable: 'XDG_DATA_HOME', modelFlag: null, login: null, loginFile: 'opencode/auth.json' } },
    ],
    models: [{ name: 'claude-default', id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null } }],
    accounts: [{ name: 'claude-q', runtime: 'claude', model: 'claude-default', credential: { host: HOST, home: '/tmp/claude-q' }, enabled: true, maxSessions: null }],
    roles: [
      { name: 'worker', accounts: ['claude-q'], concurrency: 2 },
      { name: 'approver', accounts: ['claude-q'], concurrency: 1 },
    ],
    reason: 'fixture: the fleet before the first connect',
  });
  // The cheap account: connected from the UI, sealed, smoke-tested by the worker, placed by default.
  const { hosts } = await ok('agent-registry/connect/host-key', operator);
  const publicKey = hosts.find((entry: { host: string }) => entry.host === HOST)?.publicKey;
  assert.ok(publicKey, 'the host registered its public key');
  const cheap = connectProviders.find(provider => provider.tier === 'fast')!;
  assert.equal(cheap.id, 'z.ai');
  await ok('agent-registry/connect', operator, { host: HOST, provider: cheap.id, sealed: await sealForHost(publicKey, KEY), reason: 'Connect the z.ai coding plan' });
  // The smoke prompt targets the provider and model being connected, so healthy means this key worked.
  const smoked: string[][] = [];
  const cheapReports = await runWorker({ runner: async (_command: string, args: string[]) => { smoked.push(args); return ''; } });
  assert.equal(cheapReports[0].state, 'healthy', `the cheap account connected: ${cheapReports[0].detail}`);
  assert.deepEqual(smoked[0], cheap.smoke.args, 'the smoke ran with the provider catalog\'s pinned command');
  assert.ok(cheap.smoke.args.includes('zai-coding-plan/glm-5.3-flash'), 'the smoke pins the z.ai provider and model');
  const cheapName = cheapReports[0].detail.split(' ')[0];
  // Research is the host's own configuration: the card claims it only once the host appended the
  // account's wrapper as its research command, which this pass did.
  const masterFile = JSON.parse(await readFile(join(scratch, 'master.json'), 'utf8'));
  assert.equal(masterFile.run.research.command, join(scratch, 'wrapper-bin', `pi-${cheapName.split('-').at(-1)}`), 'the account\'s wrapper became the host\'s research command');
  const document = await ok('agent-registry/document', operator);
  const roleOrder = (name: string) => document.roles.find((role: { name: string }) => role.name === name)?.accounts as string[] | undefined;
  assert.deepEqual(roleOrder('approver'), ['claude-q', cheapName], 'a cheap account is appended to the approver failover order, not prepended');
  assert.deepEqual(roleOrder('producer'), [cheapName], 'a cheap account joins the unit producer');
  assert.ok(!roleOrder('worker')?.includes(cheapName), 'a cheap account does not take worker');
  assert.deepEqual((await connectViews()).find(entry => entry.provider === cheap.id)?.placement, ['research', 'approver', 'producer'], 'the card states the cheap account joined research, approver and producer');
  // A cheap account whose research append could not land joins only the registry roles: the card
  // never claims a placement the fleet cannot launch.
  await ok('agent-registry/connect', operator, { host: HOST, provider: cheap.id, sealed: await sealForHost(publicKey, KEY), reason: 'Connect a second z.ai key on a host without a readable master configuration' });
  const secondReports = await runWorker({ masterFile: join(scratch, 'absent', 'master.json') });
  assert.equal(secondReports[0].state, 'healthy', `the second cheap account connected: ${secondReports[0].detail}`);
  assert.equal(secondReports[0].detail, `${secondReports[0].detail.split(' ')[0]} joined approver, producer`, 'without the research append the worker claims only the registry roles');
  assert.deepEqual((await connectViews()).filter(entry => entry.provider === cheap.id).at(-1)?.placement, ['approver', 'producer'], 'research placement is absent until the host confirms it');
  // The strong account: appended to worker and reviewer in the same way.
  const strong = connectProviders.find(provider => provider.id === 'anthropic-api')!;
  await ok('agent-registry/connect', operator, { host: HOST, provider: strong.id, sealed: await sealForHost(publicKey, KEY), reason: 'Connect the Anthropic API key' });
  const strongReports = await runWorker();
  assert.equal(strongReports[0].state, 'healthy', `the strong account connected: ${strongReports[0].detail}`);
  const strongName = strongReports[0].detail.split(' ')[0];
  const after = await ok('agent-registry/document', operator);
  assert.deepEqual(after.roles.find((role: { name: string }) => role.name === 'reviewer')?.accounts, [strongName], 'a strong account joins reviewer');
  assert.equal(after.roles.find((role: { name: string }) => role.name === 'worker')?.accounts.at(-1), strongName, 'a strong account is appended to the worker failover order');
});

test('unit:api-key-sealed-to-host — a pasted key is sealed to the host, stored as ciphertext only, written at mode 0600, and a failed smoke test is what the card shows', async () => {
  const { hosts } = await ok('agent-registry/connect/host-key', operator);
  const publicKey = hosts.find((entry: { host: string }) => entry.host === HOST)?.publicKey!;
  // The browser seals the key; the wire and the ledger see ciphertext only.
  const sealed = await sealForHost(publicKey, KEY);
  assert.ok(!JSON.stringify(sealed).includes(KEY), 'the sealed payload carries no plaintext');
  await ok('agent-registry/connect', operator, { host: HOST, provider: 'openai-api', sealed, reason: 'Connect the OpenAI API key' });
  // A key pasted in the open is refused, never stored.
  const raw = await call('agent-registry/connect', operator, { host: HOST, provider: 'openai-api', reason: KEY });
  assert.equal(raw.status, 400, 'a connect whose fields look like a credential is refused');
  // The worker unseals, writes the provider's own auth file at mode 0600, and this smoke fails.
  const failing = async () => { throw new Error(`provider error: quota exhausted for ${KEY}`); };
  const reports = await runWorker({ runner: failing });
  assert.equal(reports[0].state, 'failed', 'a failed smoke test is reported');
  const view = (await connectViews()).find(entry => entry.provider === 'openai-api')!;
  assert.equal(view.state, 'failed');
  assert.ok(view.error!.includes('[redacted]'), 'the provider error is shown with the key redacted');
  assert.ok(!JSON.stringify(view).includes(KEY), 'no API response carries the key');
  assert.ok(!JSON.stringify(reports).includes(KEY), 'no worker report carries the key');
  // The auth file landed in a fresh login home at mode 0600, with the key inside.
  const home = join(scratch, 'agents', view.name!);
  assert.equal(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')).OPENAI_API_KEY, KEY, 'the key is written into the provider auth file in the login home');
  assert.equal((await stat(join(home, 'auth.json'))).mode & 0o777, 0o600, 'the auth file is at mode 0600');
  // Nothing at rest holds the plaintext: not the ledger, not any API read, not the registry history.
  const events = (await store.pool.query("SELECT kind, payload FROM events WHERE work_id IS NULL AND kind LIKE 'connect-account.%'")).rows;
  assert.ok(events.some((row: { kind: string }) => row.kind === 'connect-account.request'), 'the connect is on the append-only ledger');
  assert.ok(!JSON.stringify(events).includes(KEY), 'the ledger holds ciphertext only');
  for (const path of ['agent-registry/connect', 'agent-registry', 'agent-registry/history']) {
    const read = JSON.stringify(await ok(path, operator));
    assert.ok(!read.includes(KEY), `${path} carries no plaintext key`);
    assert.ok(!read.includes(sealed.ciphertext.slice(0, 24)), `${path} serves no sealed payload to a browser`);
  }
  // The host's private half opens what was stored: the ciphertext alone is what travelled.
  const { privateKey } = await hostKeyPair(join(scratch, 'master.token'), join(scratch, 'connect.key'));
  const stored = events.find((row: { kind: string }) => row.kind === 'connect-account.request').payload.connect.sealed;
  assert.equal(unsealToHost(privateKey, stored), KEY, 'the stored ciphertext unseals on the host and only there');
  // The card: a failed smoke test is what it shows.
  const markup = renderToStaticMarkup(createElement(ConnectCard, { connect: view }));
  assert.ok(markup.includes('Failed') && markup.includes('[redacted]'), 'the card shows the failed smoke test');
  assert.ok(!markup.includes(KEY), 'the card carries no key');
});

test('unit:subscription-login-relayed — the provider login runs on the host, its URL and code reach the UI, and the card turns healthy once the login file appears and the smoke passes', async () => {
  await ok('agent-registry/connect', operator, { host: HOST, provider: 'chatgpt', reason: 'Connect the ChatGPT subscription' });
  const working = runWorker();
  // While the login still waits on the operator, the URL and code are already on the card.
  let pending: ConnectView | undefined;
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 25))) {
    pending = (await connectViews()).find(entry => entry.provider === 'chatgpt');
    if (pending?.state === 'waiting-login' && pending.url && pending.code) break;
  }
  assert.equal(pending?.state, 'waiting-login', 'the connect waits on the operator\'s sign-in');
  assert.equal(pending!.url, 'https://example.com/device', 'the sign-in URL reaches the UI while the login is pending');
  assert.equal(pending!.code, 'ABCD-1234', 'the code reaches the UI while the login is pending');
  const pendingHome = join(scratch, 'agents', pending!.name!);
  await assert.rejects(stat(join(pendingHome, 'auth.json')), 'no login file exists before the operator signs in');
  const pendingCard = renderToStaticMarkup(createElement(ConnectCard, { connect: pending! }));
  assert.ok(pendingCard.includes('Finish the sign-in in your own browser') && pendingCard.includes('https://example.com/device') && pendingCard.includes('ABCD-1234'), 'the pending card shows the URL and code to finish the sign-in with');
  // The operator finishes the sign-in in their own browser; the login writes its file and exits.
  await writeFile(join(pendingHome, 'signed-in'), '');
  const reports = await working;
  assert.equal(reports[0].state, 'healthy', `the subscription connected: ${reports[0].detail}`);
  const view = (await connectViews()).find(entry => entry.provider === 'chatgpt')!;
  assert.equal(view.state, 'healthy');
  assert.equal(view.url, 'https://example.com/device', 'the sign-in URL the login printed reached the control plane');
  assert.equal(view.code, 'ABCD-1234', 'the code the login printed reached the control plane');
  assert.match(view.name!, /^codex-/, 'the host assigned the account its login home name');
  // The login file the provider wrote is in the login home, and the registry holds the account.
  const home = join(scratch, 'agents', view.name!);
  assert.ok(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')).tokens.access_token, 'the login file appeared in the login home');
  const document = await ok('agent-registry/document', operator);
  const account = document.accounts.find((entry: { name: string }) => entry.name === view.name);
  assert.ok(account, 'the account is registered');
  assert.equal(account.credential.host, HOST);
  assert.equal(account.credential.home, home);
  const fleet = await ok('agent-registry', operator);
  assert.ok((fleet.accounts as { name: string }[]).some(entry => entry.name === view.name), 'the account is on the operator\'s fleet view');
  // The health the account's card shows comes from this host's probe, which now reads a logged-in login.
  const health = await checkAgentEnvironment({ name: view.name!, kind: 'codex', home }, {});
  assert.equal(health.loggedIn, true, 'the probe reads the login file and reports the account logged in');
  assert.equal(health.healthy, true, 'and healthy, which is what the card shows');
  // And the UI shows what the login printed, and that the account is healthy.
  const markup = renderToStaticMarkup(createElement(ConnectCard, { connect: view }));
  assert.ok(markup.includes('https://example.com/device'), 'the URL is on the card');
  assert.ok(markup.includes('ABCD-1234'), 'the code is on the card');
  assert.ok(markup.includes('Connected'), 'the card says healthy');
});

test('unit:agents-page-simple-default — the page opens on account cards and the connect button, with no form field outside Advanced', async () => {
  const at = new Date().toISOString();
  const fleet: FleetView = {
    revision: 1, updatedAt: at, configured: true, host: null,
    runtimes: [{ name: 'claude', launch: { kind: 'claude', args: [], environment: {}, homeVariable: 'CLAUDE_CONFIG_DIR', modelFlag: null, login: null, loginFile: '.credentials.json' } }],
    models: [{ name: 'claude-default', id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null } }],
    accounts: [{ name: 'claude-a', runtime: 'claude', model: 'claude-default', modelId: null, cost: null, capability: { tier: 'strong', contextTokens: null }, host: HOST, home: '/tmp/claude-a', enabled: true, maxSessions: null, note: null,
      roles: [{ role: 'worker', preference: 1, of: 1 }], liveSessions: [], quota: 'unknown', loggedIn: true, usage: [], resetsAt: null, observedAt: at, quotaSource: 'probe', eligible: true, ineligible: null }],
    roles: [], sessions: [], refusals: [], lastMutation: null, attention: [],
  };
  const connects: ConnectView[] = [{
    id: randomUUID(), at, updatedAt: at, host: HOST, provider: 'chatgpt', state: 'waiting-login', name: 'codex-a', home: '/tmp/codex-a',
    url: 'https://example.com/device', code: 'ABCD-1234', error: null, detail: null, placement: ['worker', 'reviewer'], worker: coordinator.id,
  }];
  const api = async () => { throw new Error('the default view renders without fetching'); };
  const markup = renderToStaticMarkup(createElement(FleetPage, { api, status: { actor: { role: 'admin' }, fleet, connects } } as any));
  assert.ok(markup.includes('Connect an account'), 'one primary connect action sits at the top');
  assert.equal(markup.split('data-connect-account').length - 1, 1, 'exactly one Connect an account button on the default view');
  assert.ok(markup.includes('data-account="claude-a"'), 'the operator\'s accounts open as cards');
  assert.ok(markup.includes('Roles:'), 'each card states the roles that use the account');
  assert.ok(markup.includes('Login:'), 'each card states its health (login and quota)');
  assert.ok(markup.includes('Resets:'), 'each card states when exhausted quota resets');
  assert.ok(markup.includes('data-change-roles="claude-a"'), 'the card offers change, which opens the role editor');
  assert.ok(markup.includes('https://example.com/device') && markup.includes('ABCD-1234'), 'a sign-in under way shows its URL and code');
  // Nothing on the default view asks for an executable, a home variable, a host path or a CLI flag:
  // every form field sits inside the collapsed Advanced section and nowhere else.
  const advancedAt = markup.indexOf('<details class="advanced');
  assert.ok(advancedAt > 0, 'the registry forms live behind a collapsed Advanced section');
  const before = markup.slice(0, advancedAt), inside = markup.slice(advancedAt);
  assert.ok(!/<input|<select|<textarea/.test(before), 'no form field outside Advanced');
  assert.ok(/<input|<select/.test(inside), 'the six registry forms are inside Advanced');
  for (const label of ['Executable', 'home variable', 'Startup arguments', 'Tools flag', 'Login home on that host']) {
    assert.ok(inside.includes(label), `Advanced keeps the ${label} field`);
    assert.ok(!before.includes(label), `the default view never asks for ${label}`);
  }
  assert.ok(!markup.includes('<details class="advanced" open'), 'Advanced is collapsed by default');
});

test('connect helpers — parseLoginOutput and redactKey', () => {
  const printed = parseLoginOutput('Visit https://example.com/device and enter code ABCD-1234 to finish.');
  assert.equal(printed.url, 'https://example.com/device');
  assert.equal(printed.code, 'ABCD-1234');
  assert.equal(redactKey(`quota exhausted for ${KEY} today`, KEY), 'quota exhausted for [redacted] today');
});

test('connect writes — the provider auth file lands at mode 0600 merged over what was there', async () => {
  const home = join(scratch, 'write-test');
  await mkdir(join(home, 'opencode'), { recursive: true });
  const provider = connectProviders.find(entry => entry.id === 'z.ai')!;
  await writeFile(join(home, 'opencode', 'auth.json'), '{}', { mode: 0o600 });
  await writeProviderAuthFile(provider, home, KEY);
  const stored = JSON.parse(await readFile(join(home, 'opencode', 'auth.json'), 'utf8'));
  assert.equal(stored['zai-coding-plan'].type, 'api', 'the entry is the provider/runtime union\'s api kind, so the runtime actually reads it');
  assert.equal(stored['zai-coding-plan'].key, KEY);
  assert.equal((await stat(join(home, 'opencode', 'auth.json'))).mode & 0o777, 0o600);
});

test('connect upkeep — a pending connect can be cancelled, and each host re-registers an unchanged key without appending', async () => {
  const requested = await ok('agent-registry/connect', operator, { host: 'connect-host-down', provider: 'cursor', reason: 'Connect Cursor on a host whose executor is down' });
  assert.equal((await ok(`agent-registry/connect/${requested.id}/cancel`, operator, {})).state, 'cancelled', 'a pending connect is cancelled from the card');
  assert.equal((await call(`agent-registry/connect/${requested.id}/cancel`, operator, {})).status, 409, 'a finished connect cannot be cancelled again');
  const count = async () => Number((await store.pool.query("SELECT count(*) FROM events WHERE work_id IS NULL AND kind='connect-account.host-key'")).rows[0].count);
  const second = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  await ok('agent-registry/connect/host-key', coordinator, { host: 'connect-host-2', publicKey: second });
  const registered = await count();
  // Two hosts ticking in turn: each one's unchanged key is found by host, not by the newest row.
  for (let tick = 0; tick < 3; tick++) {
    await runWorker();
    await ok('agent-registry/connect/host-key', coordinator, { host: 'connect-host-2', publicKey: second });
  }
  assert.equal(await count(), registered, 'no host-key event is appended for an unchanged key');
});
