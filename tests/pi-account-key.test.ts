import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectFleetSession, type FleetClient, type FleetSelection } from '../src/fleet.js';
import { launchApprover, loadMasterConfig, masterConfigSchema, setupMaster } from '../src/master.js';
import type { Work } from '../src/model.js';
import { RegistryError, applyRegistryMutation, chooseSession, emptyRegistry, endRegistrySession, fleetView, foldObservations, proposedRuntimes, recordRunOutcome, supersededByRequest, unjudgedHoldMs,
  type AgentRegistry, type FleetSession, type RegistryMutation } from '../src/model/registry.js';
import { accountKeyEnvironment } from '../src/runner/roles.js';
import { clearRuns } from '../src/runner/registry.js';
import type { FilesystemProbe } from '../src/install/worktree-root.js';

/**
 * GY-446: a registry Pi account launched the bare `pi` with only its login home, so an account whose
 * provider key lives outside Pi's auth.json had no key, every headless approver on it died unjudged,
 * and the loop relaunched on the same account. An account now names its key by reference — a file in
 * its login home and the variable the runtime reads — which a headless run reads at launch into its
 * own environment only; an account is smoke-tested before its first session and after any change to
 * it; and two consecutive runs of a role that end without a result hold it from that role for an hour.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x'), approverToken = 'approver-token-'.padEnd(40, 'x');
const coordinatorStatus = (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch;
const accepted = (async () => new Response(JSON.stringify({ ok: true }))) as typeof fetch;
const durable: FilesystemProbe = async path => ({ probed: path, volatile: null, freeBytes: 200e9 });
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'graphyard-pi-key-')));
// A key in the test's own environment would reach every run it starts, so the keyless case is keyless.
const inherited = process.env.ZAI_API_KEY; delete process.env.ZAI_API_KEY;
after(async () => { clearRuns(); if (inherited !== undefined) process.env.ZAI_API_KEY = inherited; await rm(scratch, { recursive: true, force: true }); });
const decisionId = (n: number) => `0e3b2c1a-7f00-4a70-8170-${String(n).padStart(12, '0')}`;

/**
 * The control plane's registry in memory, through the same pure functions the server runs, with its
 * ledger: every change appends the change and the whole resulting document, as src/agent-registry.ts does.
 */
function memoryRegistry(host: string) {
  let registry: AgentRegistry = emptyRegistry();
  const ledger: { kind: string; change: unknown; registry: AgentRegistry }[] = [];
  const at = () => new Date().toISOString();
  const append = (kind: string, change: unknown) => ledger.push({ kind, change: structuredClone(change), registry: structuredClone(registry) });
  const mutate = (kind: RegistryMutation, input: unknown) => { registry = applyRegistryMutation(registry, kind, input, { actor: 'operator', at: at() }).registry; append(kind, input); return registry.revision; };
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      for (const superseded of supersededByRequest(registry, request)) Object.assign(superseded, { endedAt: at(), endReason: 'superseded' });
      foldObservations(registry, request, { actor: 'coordinator', at: at() });
      const choice = chooseSession(registry, request, Date.now());
      if (!choice.account) { append('refused', { reason: choice.reason }); return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision } satisfies FleetSelection; }
      const session: FleetSession = { id: crypto.randomUUID(), role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host, work: request.work, principal: request.principal, group: request.group,
        selectedAt: at(), selectedBy: 'coordinator', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry.sessions.push(session); registry.revision++; append('selected', { session });
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
    },
    end: async (id, reason, outcome) => {
      const session = registry.sessions.find(entry => entry.id === id);
      if (session && endRegistrySession(registry, session, reason, outcome, at())) { registry.revision++; append('session-ended', { session: id, reason, outcome }); }
    },
  };
  return { client, mutate, ledger, current: () => registry };
}

async function installation() {
  const root = join(scratch, `repository-${crypto.randomUUID().slice(0, 8)}`), credentials = join(root, '..', `credentials-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(root); await mkdir(credentials, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'pi account key\n');
  git('add', 'README.md'); git('-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.test', 'commit', '-q', '-m', 'initial');
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'workspace', run: { worktreeRoot: join(root, '..', 'worktrees') } }, coordinatorStatus, { probe: durable });
  const approverFile = join(credentials, 'approver.token');
  await writeFile(approverFile, approverToken, { mode: 0o600 });
  const file = join(root, '.graphyard/master.json'), config = JSON.parse(await readFile(file, 'utf8'));
  config.approver = { id: 'graphyard-approver-project', credentialFile: approverFile };
  await writeFile(file, JSON.stringify(masterConfigSchema.parse(config), null, 2), { mode: 0o600 });
  return { root, credentials, config: await loadMasterConfig(root) };
}

/**
 * A stand-in `pi` on PATH, as the real one behaves: with no ZAI_API_KEY it prints Pi's own error and
 * exits 1. With one it answers the smoke prompt, and on an approver prompt it either judges (calls
 * graphyard_decide) or, when its home holds a `silent` marker, settles without a result. It records
 * every start — its home and the key it saw — in the test's own record, outside every Graphyard log.
 */
async function fakePi() {
  const bin = join(scratch, `bin-${crypto.randomUUID().slice(0, 8)}`), record = join(bin, 'launched.jsonl');
  await mkdir(bin);
  await writeFile(join(bin, 'fake-pi.mjs'), `import { appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2), home = process.env.PI_CODING_AGENT_DIR ?? '', prompt = args.at(-1), smoke = prompt === 'Reply with the single word OK.';
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ home, smoke, key: process.env.ZAI_API_KEY ?? null }) + '\\n');
const out = record => process.stdout.write(JSON.stringify(record) + '\\n');
out({ type: 'session', id: 's' });
if (!process.env.ZAI_API_KEY) { process.stderr.write('No API key found for zai.\\n\\nUse /login to log into a provider.\\n'); process.exit(1); }
if (smoke) { out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] } }); out({ type: 'agent_settled' }); process.exit(0); }
const decision = /Judge decision (\\S+) on/.exec(prompt)?.[1];
if (!existsSync(home + '/silent')) out({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'graphyard_decide', isError: false, result: { content: [{ type: 'text', text: 'recorded' }], details: { decision, approve: true, reason: 'justified' } } });
out({ type: 'agent_settled' });
`);
  await writeFile(join(bin, 'pi'), `#!/bin/sh\nexec '${process.execPath}' '${join(bin, 'fake-pi.mjs')}' "$@"\n`); await chmod(join(bin, 'pi'), 0o755);
  const path = process.env.PATH; process.env.PATH = `${bin}${delimiter}${path}`;
  return { record, restore: () => { process.env.PATH = path; }, runs: async () => (await readFile(record, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

/** A Pi login home: Pi's own auth.json is empty, as in the incident, and the key lives in `zai.key`. */
async function piHome(name: string, key: string | null, options: { silent?: boolean } = {}) {
  const home = join(scratch, `${name}-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(home, { recursive: true }); await writeFile(join(home, 'auth.json'), '{}');
  if (key !== null) await writeFile(join(home, 'zai.key'), `${key}\n`, { mode: 0o600 });
  if (options.silent) await writeFile(join(home, 'silent'), '');
  return home;
}
const zaiKey = { file: 'zai.key', variable: 'ZAI_API_KEY' };
const secret = () => `zai-fixture-${crypto.randomUUID()}`;

function piFleet(registry: ReturnType<typeof memoryRegistry>, host: string, accounts: { name: string; home: string; key?: typeof zaiKey }[]) {
  registry.mutate('apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'pi'),
    models: [{ name: 'glm-flash', id: 'zai/glm-5.3-flash' }],
    accounts: accounts.map(account => ({ name: account.name, runtime: 'pi', model: 'glm-flash', credential: { host, home: account.home, ...(account.key ? { key: account.key } : {}) } })),
    roles: [{ name: 'approver', accounts: accounts.map(account => account.name), concurrency: 4 }],
    reason: 'Approvers on Pi',
  });
}

function item(key: string): Work {
  return { id: `id-${key}`, key, title: 'Pi approver', description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: [], criteria: [{ id: 'AC-1', text: 'Judge', proofs: ['unit:pi-account-key-by-reference'] }],
    policy: { checks: ['test'], review: true }, stage: 'review', revision: 1, policyRevision: 1, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [], candidate: null,
    submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: [], observation: null, autoDispatch: { review: null, producers: [], history: [] } } as unknown as Work;
}
const noHerdr = (() => JSON.stringify({ result: {} })) as never;

/** Every file under `directory`, recursively, that contains `needle`. */
async function filesContaining(directory: string, needle: string, skip: string[] = []): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (skip.includes(path)) continue;
    if (entry.isDirectory()) found.push(...await filesContaining(path, needle, skip));
    else if (entry.isFile() && (await readFile(path, 'utf8').catch(() => '')).includes(needle)) found.push(path);
  }
  return found;
}

test('unit:pi-account-key-by-reference — a Pi account names its key file and variable; the headless launch reads the key into that run\'s environment only, and no registry document, log or ledger event holds the key', async () => {
  const { root, credentials, config } = await installation(), registry = memoryRegistry(config.hostId), key = secret();
  const home = await piHome('pi-a', key);
  piFleet(registry, config.hostId, [{ name: 'pi-a', home, key: zaiKey }]);
  assert.deepEqual(registry.current().accounts[0].credential.key, zaiKey, 'the registry stores the reference');
  const pi = await fakePi();
  try {
    const launched = await launchApprover(root, item('GY-901'), decisionId(1), undefined, { agents: [], available: true }, noHerdr, { registry: registry.client, quota: false, cacheMs: 0 }, undefined, { fetcher: accepted });
    assert.equal(launched.runtime, 'pi'); assert.equal(launched.account?.environment, 'pi-a');
    const run = (await launched.settled)!;
    assert.equal(run.result?.ok, true, `the approver judged its decision: ${JSON.stringify(run.result)}`);
    const runs = await pi.runs();
    assert.deepEqual(runs.map(entry => entry.smoke), [true, false], 'a smoke test, then the approver run');
    for (const entry of runs) { assert.equal(entry.home, home); assert.equal(entry.key, key, 'the run\'s environment carries the key on the variable the account names'); }
    assert.equal(process.env.ZAI_API_KEY, undefined, 'the key never enters the loop\'s own environment');

    // Nowhere the control plane or the loop keeps anything: not the registry document, not a ledger
    // event, not the run's record, not a file the installation wrote (its logs, records and state).
    assert.ok(!JSON.stringify(registry.current()).includes(key), 'the registry document');
    assert.ok(!JSON.stringify(registry.ledger).includes(key), 'the ledger');
    assert.ok(!JSON.stringify(run).includes(key), 'the run record');
    assert.deepEqual(await filesContaining(root, key), [], 'the repository\'s Graphyard state and logs');
    assert.deepEqual(await filesContaining(credentials, key), [], 'the coordinator\'s private state and environment log');
    assert.equal(registry.current().accounts[0].smoke?.result, 'pass');
    assert.equal(registry.current().sessions.at(-1)!.outcome, 'result');
  } finally { pi.restore(); }

  // The key is read only from a private file.
  await chmod(join(home, 'zai.key'), 0o644);
  assert.throws(() => accountKeyEnvironment({ name: 'pi-a', home, key: zaiKey }), /mode 0600/);
  await chmod(join(home, 'zai.key'), 0o600);
  assert.deepEqual(accountKeyEnvironment({ name: 'pi-a', home, key: zaiKey }), { ZAI_API_KEY: key });
  assert.deepEqual(accountKeyEnvironment({ name: 'pi-a', home, key: null }), {}, 'an account that names no key adds nothing');
  assert.throws(() => accountKeyEnvironment({ name: 'pi-a', home: join(home, 'missing'), key: zaiKey }), error => error instanceof Error && !error.message.includes(key) && /key file cannot be read/.test(error.message));
});

test('unit:pi-account-key-by-reference — a registry write that carries a key-like value is refused, in any field; only the reference is stored', () => {
  let registry = applyRegistryMutation(emptyRegistry(), 'apply', { runtimes: proposedRuntimes.filter(runtime => runtime.name === 'pi'), models: [{ name: 'glm-flash', id: 'zai/glm-5.3-flash' }], reason: 'fixture' }, { actor: 'operator', at: new Date().toISOString() }).registry;
  const account = (credential: object, extra: object = {}) => ({ account: { name: 'pi-a', runtime: 'pi', model: 'glm-flash', credential: { host: 'h', home: '/home/pi-a', ...credential }, ...extra }, reason: 'Pi account' });
  const refuses = (input: object, pattern: RegExp | ((error: unknown) => boolean)) => assert.throws(() => applyRegistryMutation(registry, 'account.set', input, { actor: 'operator', at: new Date().toISOString() }), pattern, JSON.stringify(input));
  // The key itself, wherever it is pasted: as the key file, as a note, as the reason.
  refuses(account({ key: { file: 'sk-ant-api03-abcdefghijklmnop', variable: 'ZAI_API_KEY' } }), /never the key/);
  refuses(account({ key: zaiKey }, { note: 'sk-zai-0123456789abcdef' }), error => error instanceof RegistryError && /input\.account\.note looks like a credential/.test(error.message));
  refuses({ ...account({ key: zaiKey }), reason: 'Bearer abcdefghijklmnop' }, /input\.reason looks like a credential/);
  // A reference outside the login home, or on a variable the launcher owns, is not a reference.
  refuses(account({ key: { file: '/etc/zai.key', variable: 'ZAI_API_KEY' } }), /inside the account home/);
  refuses(account({ key: { file: '../zai.key', variable: 'ZAI_API_KEY' } }), /inside the account home/);
  refuses(account({ key: { file: 'zai.key', variable: 'GRAPHYARD_TOKEN' } }), /owned by the launcher/);
  registry = applyRegistryMutation(registry, 'account.set', account({ key: zaiKey }), { actor: 'operator', at: new Date().toISOString() }).registry;
  assert.deepEqual(registry.accounts[0].credential, { host: 'h', home: '/home/pi-a', key: zaiKey });
});

test('unit:account-smoke-gate — an account is smoke-tested before it is first chosen and after any change to it; a failure makes it ineligible with the runtime\'s own error and nothing launches on it', async () => {
  const { root, config } = await installation(), registry = memoryRegistry(config.hostId);
  // The incident: the account names no key, so Pi finds none in its empty auth.json.
  const keyless = await piHome('pi-a', secret());
  piFleet(registry, config.hostId, [{ name: 'pi-a', home: keyless }]);
  const pi = await fakePi();
  try {
    await assert.rejects(launchApprover(root, item('GY-902'), decisionId(2), undefined, { agents: [], available: true }, noHerdr, { registry: registry.client, quota: false, cacheMs: 0 }, undefined, { fetcher: accepted }),
      /No healthy agent account for approver.*pi-a failed its smoke test: No API key found for zai\./s);
    assert.deepEqual((await pi.runs()).map(entry => entry.smoke), [true], 'the smoke test ran, and no approver session launched');
    const account = registry.current().accounts[0];
    assert.equal(account.smoke?.result, 'fail'); assert.equal(account.smoke?.reason, 'No API key found for zai. Use /login to log into a provider.', 'Pi\'s own error, on one line');
    assert.equal(registry.current().sessions.length, 0, 'no session was selected on the account');
    assert.match(fleetView(registry.current(), Date.now()).accounts[0].ineligible!, /failed its smoke test: No API key found for zai/);

    // A failed account is not tested again on every launch: it stays out until it is changed.
    await assert.rejects(launchApprover(root, item('GY-902'), decisionId(2), undefined, { agents: [], available: true }, noHerdr, { registry: registry.client, quota: false, cacheMs: 0 }, undefined, { fetcher: accepted }), /failed its smoke test/);
    assert.equal((await pi.runs()).length, 1);

    // The fix is a registry change — naming the key — and the change is tested before any session.
    registry.mutate('account.set', { account: { name: 'pi-a', runtime: 'pi', model: 'glm-flash', credential: { host: config.hostId, home: keyless, key: zaiKey } }, reason: 'Name the z.ai key' });
    assert.equal(registry.current().accounts[0].smoke, undefined, 'the change clears the old result');
    const launched = await launchApprover(root, item('GY-902'), decisionId(2), undefined, { agents: [], available: true }, noHerdr, { registry: registry.client, quota: false, cacheMs: 0 }, undefined, { fetcher: accepted });
    assert.equal((await launched.settled)!.result?.ok, true);
    assert.deepEqual((await pi.runs()).map(entry => entry.smoke), [true, true, false]);
    assert.equal(registry.current().accounts[0].smoke?.result, 'pass');
    // A passed account is not tested again until it changes.
    await (await launchApprover(root, item('GY-903'), decisionId(3), undefined, { agents: [], available: true }, noHerdr, { registry: registry.client, quota: false, cacheMs: 0 }, undefined, { fetcher: accepted })).settled;
    assert.deepEqual((await pi.runs()).map(entry => entry.smoke), [true, true, false, false]);
    // A change to the runtime or model an account runs is a change to it too.
    registry.mutate('model.set', { model: { name: 'glm-flash', id: 'zai/glm-5.3-flash-2' }, reason: 'New model version' });
    assert.equal(registry.current().accounts[0].smoke, undefined);
  } finally { pi.restore(); }

  // The executor side, alone: an injected smoke test is run once per untested account and reported.
  const tested: string[] = [], alone = memoryRegistry(config.hostId);
  piFleet(alone, config.hostId, [{ name: 'pi-x', home: await piHome('pi-x', null) }, { name: 'pi-y', home: await piHome('pi-y', null) }]);
  const chosen = await selectFleetSession(config, 'approver', { name: 'approver' }, { registry: alone.client, quota: false, cacheMs: 0, smoke: async account => { tested.push(account.name); return account.name === 'pi-x' ? { ok: false, error: '401 invalid api key' } : { ok: true, error: null }; } });
  assert.deepEqual(tested.sort(), ['pi-x', 'pi-y']);
  assert.equal(chosen?.account.name, 'pi-y', 'the account that failed is passed over for the next');
  assert.match(chosen!.skipped[0].reason, /pi-x failed its smoke test: 401 invalid api key/);
});

test('unit:account-smoke-gate — two consecutive approver runs on one account that end without a result hold it from the role for an hour, and the loop falls through to the next account', async () => {
  const { root, config } = await installation(), registry = memoryRegistry(config.hostId);
  const silent = await piHome('pi-a', secret(), { silent: true }), judging = await piHome('pi-b', secret());
  piFleet(registry, config.hostId, [{ name: 'pi-a', home: silent, key: zaiKey }, { name: 'pi-b', home: judging, key: zaiKey }]);
  const pi = await fakePi();
  const launch = async (n: number) => {
    const launched = await launchApprover(root, item(`GY-91${n}`), decisionId(10 + n), undefined, { agents: [], available: true }, noHerdr, { registry: registry.client, quota: false, cacheMs: 0 }, undefined, { fetcher: accepted });
    return { account: launched.account?.environment, run: (await launched.settled)! };
  };
  try {
    const first = await launch(1);
    assert.equal(first.account, 'pi-a'); assert.equal(first.run.result?.ok, false);
    assert.deepEqual(registry.current().accounts.find(entry => entry.name === 'pi-a')!.unjudged?.approver?.runs, 1, 'one run without a result is counted, not held');
    const second = await launch(2);
    assert.equal(second.account, 'pi-a', 'one run without a result does not move the role');
    const held = registry.current().accounts.find(entry => entry.name === 'pi-a')!.unjudged!.approver!;
    assert.ok(held.until && Math.abs(Date.parse(held.until) - Date.now() - unjudgedHoldMs) < 60_000, 'the second in a row holds the account for an hour');
    const third = await launch(3);
    assert.equal(third.account, 'pi-b', 'the loop falls through to the next account instead of relaunching on pi-a');
    assert.equal(third.run.result?.ok, true);
    const view = fleetView(registry.current(), Date.now(), config.hostId);
    assert.match(view.accounts.find(entry => entry.name === 'pi-a')!.held[0].reason, /pi-a is held from approver until .*2 consecutive approver runs on it ended without a result/);
    assert.equal(view.accounts.find(entry => entry.name === 'pi-a')!.eligible, true, 'the hold is for the role, not the account');
  } finally { pi.restore(); }

  // The rule itself: a result clears the count, a hold lapses after its hour, and other roles are untouched.
  const at = Date.parse('2026-09-25T20:45:00Z'), iso = (offset: number) => new Date(at + offset).toISOString();
  const model = registry.current();
  const session = { account: 'pi-b', role: 'approver' as const };
  recordRunOutcome(model, session, 'no-result', 'the run ended without a graphyard_decide call', iso(0));
  recordRunOutcome(model, session, 'result', 'judged', iso(1));
  recordRunOutcome(model, session, 'no-result', 'the run ended without a graphyard_decide call', iso(2));
  assert.equal(chooseSession(model, { role: 'approver', host: config.hostId }, at + 3).account?.name, 'pi-b', 'a result between two unjudged runs resets the count');
  recordRunOutcome(model, session, 'no-result', 'the run ended without a graphyard_decide call', iso(3));
  model.accounts.find(entry => entry.name === 'pi-a')!.unjudged = {};
  assert.equal(chooseSession(model, { role: 'approver', host: config.hostId }, at + 4).account?.name, 'pi-a');
  model.accounts.find(entry => entry.name === 'pi-a')!.enabled = false;
  assert.match((chooseSession(model, { role: 'approver', host: config.hostId }, at + 4) as { reason: string }).reason, /pi-b is held from approver/);
  assert.equal(chooseSession(model, { role: 'approver', host: config.hostId }, at + unjudgedHoldMs + 4).account?.name, 'pi-b', 'the hold lapses after its hour');
  model.roles.push({ name: 'producer', accounts: ['pi-b'], concurrency: 1 });
  assert.equal(chooseSession(model, { role: 'producer', host: config.hostId }, at + 4).account?.name, 'pi-b', 'a hold from the approver role does not keep the account from producing');
  // A run the loop cancelled is not the account's failure, and a session ended first still takes its outcome once.
  const late: FleetSession = { ...registry.current().sessions.at(-1)!, account: 'pi-b', endedAt: iso(0), endReason: 'gone from Herdr', outcome: undefined };
  const copy = structuredClone(model); copy.sessions.push(late);
  assert.equal(endRegistrySession(copy, late, 'the run ended', 'no-result', iso(5)), true);
  assert.equal(endRegistrySession(copy, late, 'the run ended', 'no-result', iso(6)), false, 'recorded once');
  assert.equal(late.endReason, 'gone from Herdr', 'the first end stands');
  assert.ok((await stat(silent)).isDirectory());
});
