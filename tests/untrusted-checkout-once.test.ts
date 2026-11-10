import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { checkoutTrustLine, checkoutTrustRefusals, type CheckoutTrustFleet } from '../src/harness.js';
import { checkoutTrustKey, runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { encodeLoopCheckoutTrust, loopCheckoutTrust } from '../src/model/loop-presence.js';
import { setupChecklist } from '../src/model/setup-checklist.js';
import { runUp, upExitCodes, upRequestFromArgs, upStateFile, type UpDependencies, type UpEvent } from '../src/up.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { withDatabase } from './helpers/postgres.js';
import type { Principal } from '../src/model.js';

// GY-3225: a checkout that carries its own Claude configuration (.mcp.json, .claude/settings.json),
// untrusted in a registered Claude account's config, refuses every launch of that account — the
// trust step never records trust for such a folder (harness.ts). Setup stops at the harness step
// once, naming each account home and both remedies; the loop holds the named roles' launches behind
// one standing attention line, opening no pane per retry, until the account configs record trust or
// the role gains --setting-sources user; the Setup checklist shows the same line as one item.

const host = 'loop-host';
const checkout = await temporaryDirectory('untrusted-checkout');
const homeA = await temporaryDirectory('untrusted-account-a');
const homeB = await temporaryDirectory('untrusted-account-b');
const configA = join(homeA, '.claude.json'), configB = join(homeB, '.claude.json');
await mkdir(join(checkout, '.claude'), { recursive: true });
await writeFile(join(checkout, '.mcp.json'), '{}\n');
await writeFile(join(checkout, '.claude', 'settings.json'), '{}\n');
/** An account config that records no trust, and one that records the checkout's folder trusted. */
const untrusted = () => JSON.stringify({ projects: {} });
const trusting = () => JSON.stringify({ projects: { [realpathSync(checkout)]: { hasTrustDialogAccepted: true } } });

/** The registry the fixture fleet reads as: one claude runtime, two accounts on this host, and roles over them. */
const fleet = (roles: CheckoutTrustFleet['roles']): CheckoutTrustFleet => ({
  runtimes: [{ name: 'claude', launch: { kind: 'claude', args: [] } }],
  accounts: [
    { name: 'claude-a', runtime: 'claude', credential: { host, home: homeA } },
    { name: 'claude-b', runtime: 'claude', credential: { host, home: homeB } },
  ],
  roles,
});

test('unit:tests/untrusted-checkout-once.test.ts — the check names every untrusted claude account whose launch loads the checkout project settings, and nobody else', async () => {
  await Promise.all([writeFile(configA, untrusted()), writeFile(configB, untrusted())]);
  const master = fleet([{ name: 'master', accounts: ['claude-a', 'claude-b'], policy: { args: [] } }]);
  const refusals = await checkoutTrustRefusals(checkout, master, host);
  assert.deepEqual(refusals.map(entry => entry.account), ['claude-a', 'claude-b'], 'both untrusted accounts of the role are named');
  assert.equal(refusals[0].home, homeA);
  assert.equal(refusals[0].file, configA);
  assert.equal(refusals[0].folder, realpathSync(checkout));
  assert.ok(refusals[0].carried.includes('.claude/settings.json'));
  // The line names both account homes and both remedies, on one line.
  const line = checkoutTrustLine(refusals);
  assert.ok(line.includes(`CLAUDE_CONFIG_DIR=${homeA} claude`) && line.includes(`CLAUDE_CONFIG_DIR=${homeB} claude`), line);
  assert.ok(line.includes('master registry role set master claude-a,claude-b --arg=--setting-sources --arg=user'), line);
  assert.ok(!/[\r\n]/.test(line), 'the line rides a presence header, so it carries no newline');
  // A role that already runs --setting-sources user loads no project settings and refuses nobody.
  assert.deepEqual(await checkoutTrustRefusals(checkout, fleet([{ name: 'master', accounts: ['claude-a', 'claude-b'], policy: { args: ['--setting-sources', 'user'] } }]), host), []);
  // A worker, reviewer or producer session of a checkout that carries settings launches with
  // --setting-sources user (prepareSessionHarness), so it is never refused this way.
  for (const role of ['worker', 'reviewer', 'producer']) assert.deepEqual(await checkoutTrustRefusals(checkout, fleet([{ name: role, accounts: ['claude-a', 'claude-b'], policy: { args: [] } }]), host), []);
  // Another host's account is not this host's to read, a non-claude runtime has no folder trust, and
  // a checkout that carries no Claude configuration of its own refuses nobody.
  assert.deepEqual(await checkoutTrustRefusals(checkout, { ...master, accounts: master.accounts.map(account => ({ ...account, credential: { ...account.credential, host: 'other-host' } })) }, host), []);
  assert.deepEqual(await checkoutTrustRefusals(checkout, { ...master, runtimes: [{ name: 'codex', launch: { kind: 'codex', args: [] } }], accounts: master.accounts.map(account => ({ ...account, runtime: 'codex' })) }, host), []);
  const plain = await temporaryDirectory('untrusted-plain-checkout');
  assert.deepEqual(await checkoutTrustRefusals(plain, master, host), []);
  // The account configs recording trust — what the operator's one prompt writes — refuses nobody.
  await Promise.all([writeFile(configA, trusting()), writeFile(configB, trusting())]);
  assert.deepEqual(await checkoutTrustRefusals(checkout, master, host), []);
  await Promise.all([writeFile(configA, untrusted()), writeFile(configB, untrusted())]);
});

test('unit:tests/untrusted-checkout-once.test.ts — up stops at the harness step naming both account homes and both remedies, and completes once trust is recorded', async () => {
  await mkdir(join(checkout, '.graphyard'), { recursive: true });
  await writeFile(upStateFile(checkout), JSON.stringify({ version: 1, repository: 'owner/untrusted-checkout', provider: 'compose', noHerdr: false,
    completed: ['preflight', 'control-plane', 'host-supervisor', 'deploy-key', 'master-autonomy', 'onboarding', 'accounts'] }));
  const events: UpEvent[] = [];
  const calls: string[][] = [];
  const green = {
    fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-b'] }], accounts: [{ name: 'claude-a' }, { name: 'claude-b' }] },
    setup: { loop: true },
  };
  const dependencies: UpDependencies = {
    root: checkout, emit: event => events.push(event), now: Date.now, sleep: async () => {},
    serverUrl: async () => 'http://127.0.0.1:4310', masterToken: async () => 't'.repeat(40), status: async () => green,
    publishOnboarding: async () => null,
    checkoutTrust: async root => checkoutTrustRefusals(root, fleet([{ name: 'master', accounts: ['claude-a', 'claude-b'], policy: { args: [] } }]), host),
    async cli(args) { calls.push(args); return { code: 0, stdout: '{}' }; },
  };
  const request = upRequestFromArgs(['--repo', 'owner/untrusted-checkout']);
  const stopped = await runUp(request, dependencies);
  assert.equal(stopped.exitCode, upExitCodes.prerequisite, 'the stop asks a person, it is not a failed command');
  const failed = events.find(event => event.kind === 'step-failed');
  assert.equal(failed && failed.kind === 'step-failed' ? failed.step : null, 'harness');
  const detail = failed && failed.kind === 'step-failed' ? failed.detail : '';
  for (const home of [homeA, homeB]) assert.ok(detail.includes(`CLAUDE_CONFIG_DIR=${home} claude`), detail);
  assert.ok(detail.includes('--arg=--setting-sources --arg=user'), detail);
  assert.ok(detail.includes('accept the prompt'), detail);
  assert.ok(!calls.some(args => args.includes('restart')), 'the run never started the master loop it could not launch for');

  // The operator's trust recorded, a rerun passes the harness step and finishes green.
  await Promise.all([writeFile(configA, trusting()), writeFile(configB, trusting())]);
  const rerun = await runUp(request, dependencies);
  assert.ok(rerun.ok, rerun.next);
  assert.ok(rerun.completed.includes('harness'));
  await Promise.all([writeFile(configA, untrusted()), writeFile(configB, untrusted())]);
});

test('unit:tests/untrusted-checkout-once.test.ts — the loop holds the named roles behind one attention line, opens no panes, and launches once trust or the role arguments change', async () => {
  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/untrusted-checkout', baseBranch: 'main', githubAppId: 1234, hostId: host, masterAgentName: 'graphyard-master-untrusted', workers: [],
  }) as MasterConfig;
  let roleArgs: string[] = [];
  const state: DaemonState = emptyDaemonState(config);
  let launches = 0;
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [], now: new Date(clock).toISOString() }),
    agents: () => [],
    herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    dispatch: async () => { throw new Error('the held cycle dispatches no worker'); },
    closeSession: () => {},
    persist: async () => {},
    checkoutTrust: () => checkoutTrustRefusals(checkout, fleet([{ name: 'master', accounts: ['claude-a', 'claude-b'], policy: { args: roleArgs } }]), host),
    masterSession: { launch: async () => { launches++; return { agentName: 'graphyard-master-untrusted', pane: 'w1:p1', runtime: 'claude', account: 'claude-a', session: null }; } },
  };
  let clock = Date.now();
  const cycle = () => runCycle(config, state, effects, () => clock);

  // Three held cycles: one standing attention line, and no launch (so no pane opened per retry).
  for (let held = 0; held < 3; held++) { await cycle(); clock += 20_000; }
  assert.equal(launches, 0);
  const standing = state.actions[checkoutTrustKey];
  assert.equal(standing?.kind, 'attention');
  assert.equal(standing?.state, 'failed');
  assert.equal(standing?.attempts, 1, 'one line, touched while it stands, never re-raised');
  const detail = standing!.detail;
  assert.ok(detail.includes(`CLAUDE_CONFIG_DIR=${homeA} claude`) && detail.includes(`CLAUDE_CONFIG_DIR=${homeB} claude`), detail);
  assert.ok(detail.includes('--arg=--setting-sources --arg=user'), detail);
  // The line is what the loop names to the control plane, and the Setup checklist shows one item for it.
  assert.equal(loopCheckoutTrust(encodeLoopCheckoutTrust(detail)), detail);
  assert.equal(loopCheckoutTrust('off'), null);
  const items = setupChecklist({ setup: { checkoutTrust: detail } });
  assert.deepEqual(items.filter(item => item.id === 'checkout-trust').map(item => item.line), [detail]);
  assert.ok(!setupChecklist({ setup: { loop: true } }).some(item => item.id === 'checkout-trust'), 'no item once the refusal stands no more');

  // The account configs recording trust: the hold lifts, the standing line goes, and the launch goes ahead.
  await Promise.all([writeFile(configA, trusting()), writeFile(configB, trusting())]);
  await cycle(); clock += 20_000;
  assert.equal(launches, 1, 'relaunches only after the account config records trust, then launches');
  assert.equal(state.actions[checkoutTrustKey], undefined, 'the standing line went with the hold');

  // Trust withdrawn again holds the launch once more; the role gaining --setting-sources user lifts it.
  await Promise.all([writeFile(configA, untrusted()), writeFile(configB, untrusted())]);
  await cycle(); clock += 20_000;
  assert.equal(launches, 1, 'untrusted again, the launch is held again');
  assert.ok(state.actions[checkoutTrustKey]);
  roleArgs = ['--setting-sources', 'user'];
  await cycle(); clock += 20_000;
  assert.equal(launches, 2, 'the role gaining --setting-sources user lifts the hold');
  assert.equal(state.actions[checkoutTrustKey], undefined);
});

// The standing line rides the loop's coordination-read header into /api/status, where the Setup page reads it.
let store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, coordinator].map(principal => ({ ...principal, token: `${principal.id}-${'x'.repeat(32)}` }));

before(async () => {
  store = await withDatabase('untrusted-checkout-once');
  await store.init();
  engine = new Engine(store, 7200, 'owner/untrusted-checkout');
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(() => { http?.close(); return store?.close(); });

test('unit:tests/untrusted-checkout-once.test.ts — the loop\'s read header carries the standing line into the status the Setup page shows', async () => {
  const detail = checkoutTrustLine(await checkoutTrustRefusals(checkout, fleet([{ name: 'master', accounts: ['claude-a', 'claude-b'], policy: { args: [] } }]), host));
  const read = await fetch(`${url}/api/work-snapshot`, { headers: {
    Authorization: `Bearer ${credentials[1]!.token}`,
    'x-graphyard-loop-interval': '20',
    'x-graphyard-loop-checkout-trust': encodeLoopCheckoutTrust(detail),
  } });
  assert.equal(read.status, 200);
  const status = await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${credentials[0]!.token}` } });
  const body = await status.json() as any;
  assert.equal(body.setup.checkoutTrust, detail);
  assert.deepEqual(setupChecklist(body).filter(item => item.id === 'checkout-trust').map(item => item.line), [detail], 'the Setup page shows one matching item');
  // A loop that names none (the hold lifted, or an older loop) shows no item.
  const clear = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${credentials[1]!.token}`, 'x-graphyard-loop-interval': '20', 'x-graphyard-loop-checkout-trust': 'off', 'Idempotency-Key': randomUUID() } });
  assert.equal(clear.status, 200);
  const after = await (await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${credentials[0]!.token}` } })).json() as any;
  assert.equal(after.setup.checkoutTrust, null);
  assert.ok(!setupChecklist(after).some(item => item.id === 'checkout-trust'));
});
