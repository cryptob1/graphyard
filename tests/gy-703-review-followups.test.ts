import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { needsSmoke, runsHeadless, selectFleetSession, smokeDefaultTimeoutMs, type FleetClient, type FleetProbe, type FleetSelection } from '../src/fleet.js';
import { launchApprover, loadMasterConfig, masterConfigSchema, setupMaster } from '../src/master.js';
import type { Work } from '../src/model.js';
import { accountIneligibility, applyRegistryMutation, chooseSession, emptyRegistry, endRegistrySession, foldObservations, proposedRuntimes, smokeRetestMs, supersededByRequest,
  type AgentRegistry, type FleetAccount, type FleetRuntime, type FleetSession, type RegistryMutation } from '../src/model/registry.js';
import type { SmokeResult } from '../src/runner/pi.js';
import { clearRuns } from '../src/runner/registry.js';
import type { Runner } from '../src/runner/types.js';
import type { FilesystemProbe } from '../src/install/worktree-root.js';

/**
 * GY-703, the follow-ups from the approved review of GY-446 (PR #250):
 *
 * 1. A smoke test ran inline in every selection with piSmoke's 120s default, so a hanging provider
 *    stalled the launch and the loop cycle; concurrent selections each tested the same untested
 *    account; and a result lived only in the select request it folded into, so a select that threw
 *    lost a test the account paid for and paid for it again. One test per account is now shared
 *    while it runs, its result is held until a select the control plane accepted carried it, and a
 *    one-prompt test is bounded well below 120s by default.
 * 2. A transient smoke failure (a 429, a provider outage) barred the account until an operator
 *    edited it; a failure is now retested automatically once `smokeRetestMs` has passed.
 * 3. `needsSmoke` keyed on the literal kind 'pi'; the gate and the launcher's headless path now
 *    read one list (`headlessRunKinds`), so a headless runtime added there is gated and launched
 *    by the same edit.
 * 4. A headless run whose `settled` rejected was released without an outcome (approver and
 *    producer), so crashed runs never reached the unjudged-run hold; they are released as
 *    'no-result' now.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x'), approverToken = 'approver-token-'.padEnd(40, 'x');
const coordinatorStatus = (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch;
const accepted = (async () => new Response(JSON.stringify({ ok: true }))) as typeof fetch;
const durable: FilesystemProbe = async path => ({ probed: path, volatile: null, freeBytes: 200e9 });
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'graphyard-review-followups-')));
after(async () => { clearRuns(); await rm(scratch, { recursive: true, force: true }); });
const decisionId = (n: number) => `0e3b2c1a-7f00-4a70-8170-${String(n).padStart(12, '0')}`;
const noHerdr = (() => JSON.stringify({ result: {} })) as never;

/**
 * The control plane's registry in memory, through the same pure functions the server runs. The
 * select folds the request's observations, chooses, and records the session; `end` records the
 * outcome the executor released with. `failNextSelect` makes the next select throw, as an
 * unreachable control plane does after the observations were gathered but before they were folded.
 */
function memoryRegistry(host: string) {
  let registry: AgentRegistry = emptyRegistry();
  const at = () => new Date().toISOString();
  let failSelect: Error | null = null;
  const mutate = (kind: RegistryMutation, input: unknown) => { registry = applyRegistryMutation(registry, kind, input, { actor: 'operator', at: at() }).registry; return registry.revision; };
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      if (failSelect) throw failSelect;
      for (const superseded of supersededByRequest(registry, request)) Object.assign(superseded, { endedAt: at(), endReason: 'superseded' });
      foldObservations(registry, request, { actor: 'coordinator', at: at() });
      const choice = chooseSession(registry, request, Date.now());
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision } satisfies FleetSelection;
      const session: FleetSession = { id: crypto.randomUUID(), role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host, work: request.work, principal: request.principal, group: request.group,
        selectedAt: at(), selectedBy: 'coordinator', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry.sessions.push(session); registry.revision++;
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
    },
    end: async (id, reason, outcome) => {
      const session = registry.sessions.find(entry => entry.id === id);
      if (session && endRegistrySession(registry, session, reason, outcome, at())) registry.revision++;
    },
  };
  return { client, mutate, current: () => registry, failNextSelect: (error: Error | null) => { failSelect = error; } };
}

/** A pi fleet of one host: the runtime as proposed, one model, the accounts, the named narrow roles. */
function piFleet(registry: ReturnType<typeof memoryRegistry>, host: string, accounts: { name: string; home: string }[], roles: ('approver' | 'producer')[] = ['approver']) {
  registry.mutate('apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'pi'),
    models: [{ name: 'glm-flash', id: 'zai/glm-5.3-flash' }],
    accounts: accounts.map(account => ({ name: account.name, runtime: 'pi', model: 'glm-flash', credential: { host, home: account.home } })),
    roles: roles.map(name => ({ name, accounts: accounts.map(account => account.name), concurrency: 4 })),
    reason: 'GY-703 fixture',
  });
}

/** A Pi login home whose auth.json exists, so the probe reads the account as logged in. */
async function piHome(name: string) {
  const home = join(scratch, `${name}-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(home, { recursive: true }); await writeFile(join(home, 'auth.json'), '{}');
  return home;
}

/** A `pi` on PATH that never answers: the session event, then nothing, until the smoke bound kills it. */
async function hangingPi() {
  const bin = join(scratch, `bin-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(bin);
  await writeFile(join(bin, 'fake-pi.mjs'), `process.stdout.write(JSON.stringify({ type: 'session', id: 's' }) + '\\n'); setInterval(() => {}, 1 << 30);`);
  await writeFile(join(bin, 'pi'), `#!/bin/sh\nexec '${process.execPath}' '${join(bin, 'fake-pi.mjs')}' "$@"\n`); await chmod(join(bin, 'pi'), 0o755);
  const path = process.env.PATH; process.env.PATH = `${bin}${delimiter}${path}`;
  return { restore: () => { process.env.PATH = path; } };
}

async function installation() {
  const root = join(scratch, `repository-${crypto.randomUUID().slice(0, 8)}`), credentials = join(root, '..', `credentials-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(root); await mkdir(credentials, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'review followups\n');
  git('add', 'README.md'); git('-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.test', 'commit', '-q', '-m', 'initial');
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'workspace', run: { worktreeRoot: join(root, '..', 'worktrees') } }, coordinatorStatus, { probe: durable });
  const approverFile = join(credentials, 'approver.token');
  await writeFile(approverFile, approverToken, { mode: 0o600 });
  const file = join(root, '.graphyard/master.json'), config = JSON.parse(await readFile(file, 'utf8'));
  config.approver = { id: 'graphyard-approver-project', credentialFile: approverFile };
  await writeFile(file, JSON.stringify(masterConfigSchema.parse(config), null, 2), { mode: 0o600 });
  return { root, config: await loadMasterConfig(root) };
}

function item(key: string): Work {
  return { id: `id-${key}`, key, title: 'Review followups', description: '', type: 'chore', priority: 1, dependencies: [], plannedFiles: [], criteria: [{ id: 'AC-1', text: 'Judge', proofs: ['unit:review-followups'] }],
    policy: { checks: ['test'], review: true }, stage: 'review', revision: 1, policyRevision: 1, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [], candidate: null,
    submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: [], observation: null, autoDispatch: { review: null, producers: [], history: [] } } as unknown as Work;
}

/** A runner whose every run dies before it produces anything: `result()` rejects, as a crashed spawn does. */
const crashingRunner = (): Runner => ({
  name: 'pi',
  start: () => ({ id: 'crash', events: [], onEvent: () => () => {}, cancel: () => {}, result: () => Promise.reject(new Error('the runner died')) }),
});

test('unit:review-followups-smoke-sharing — concurrent selections test an untested account once, a select that throws does not lose the result it paid for, and an accepted select hands it to the registry', async () => {
  const { config } = await installation(), host = config.hostId;
  const registry = memoryRegistry(host);
  piFleet(registry, host, [{ name: 'pi-x', home: await piHome('pi-x') }], ['approver', 'producer']);
  const tested: string[] = [];
  const probe = (delayMs = 0, result: SmokeResult = { ok: true, error: null }): FleetProbe =>
    ({ registry: registry.client, quota: false, cacheMs: 0, smoke: async account => { tested.push(account.name); await new Promise(resolve => setTimeout(resolve, delayMs)); return result; } });

  // Two roles ask within the same cycle: one smoke test, both requests carry it, the registry holds it.
  const [approver, producer] = await Promise.all([
    selectFleetSession(config, 'approver', { name: 'approver' }, probe(50)),
    selectFleetSession(config, 'producer', { name: 'producer' }, probe(50)),
  ]);
  assert.deepEqual(tested, ['pi-x'], 'one test for both selections, not one each');
  assert.equal(approver?.account.name, 'pi-x'); assert.equal(producer?.account.name, 'pi-x');
  assert.equal(registry.current().accounts[0].smoke?.result, 'pass', 'the accepted selects folded the result');

  // An account changed since says nothing about the changed login: the change is tested again.
  tested.length = 0;
  registry.mutate('account.set', { account: { name: 'pi-x', runtime: 'pi', model: 'glm-flash', credential: { host, home: await piHome('pi-x-2') } }, reason: 'The login moved' });
  const again = await selectFleetSession(config, 'approver', { name: 'approver' }, probe());
  assert.deepEqual(tested, ['pi-x'], 'the changed account is tested again');
  assert.equal(again?.account.name, 'pi-x');

  // A select that throws after the test ran loses nothing: the next select reuses the held result.
  // The account is changed first, so the document carries no result and a test is actually due.
  tested.length = 0;
  registry.mutate('account.set', { account: { name: 'pi-x', runtime: 'pi', model: 'glm-flash', credential: { host, home: await piHome('pi-x-3') } }, reason: 'The login moved again' });
  registry.failNextSelect(new Error('The agent registry at https://graphyard.example is unreachable: the network is gone'));
  await assert.rejects(selectFleetSession(config, 'approver', { name: 'approver' }, probe(20)), /unreachable/);
  registry.failNextSelect(null);
  assert.deepEqual(tested, ['pi-x'], 'the failed select still ran the test');
  assert.equal(registry.current().accounts[0].smoke, undefined, 'and the control plane never received it');
  const retried = await selectFleetSession(config, 'approver', { name: 'approver' }, probe());
  assert.deepEqual(tested, ['pi-x'], 'the retry reuses the held result instead of paying for it again');
  assert.equal(retried?.account.name, 'pi-x');
  assert.equal(registry.current().accounts[0].smoke?.result, 'pass', 'and the registry holds it once the retry is accepted');

  // A held result never outlives an accepted select: past it, the next due account is tested fresh.
  // (The document's result is cleared without a revision bump, so only the held entry could answer.)
  tested.length = 0;
  delete registry.current().accounts[0].smoke;
  await assert.rejects(selectFleetSession(config, 'approver', { name: 'approver' }, probe(0, { ok: false, error: '401 invalid api key' })), /failed its smoke test: 401 invalid api key/);
  assert.deepEqual(tested, ['pi-x'], 'the due account is tested again, not answered from what the process held');
  assert.equal(registry.current().accounts[0].smoke?.result, 'fail', 'the fresh result is what folds, whatever an older one said');
});

test('unit:review-followups-smoke-backoff — a failed smoke test is retested after smokeRetestMs, not barred until an operator edits the account; the refusal says when it is retested', async () => {
  const { config } = await installation(), host = config.hostId;
  const registry = memoryRegistry(host);
  piFleet(registry, host, [{ name: 'pi-x', home: await piHome('pi-x') }]);
  const now = Date.now(), iso = (offset: number) => new Date(now + offset).toISOString();
  const piRuntime = registry.current().runtimes[0], account = registry.current().accounts[0];

  // The gate itself: no result is tested; a fresh failure is not; a failure past the backoff is.
  assert.equal(needsSmoke(account, piRuntime, now), true, 'an account with no result is tested');
  account.smoke = { result: 'fail', reason: '429 too many requests', at: iso(0), by: 'coordinator' };
  assert.equal(needsSmoke(account, piRuntime, now + 1), false, 'a fresh failure is not retested at once');
  assert.equal(needsSmoke(account, piRuntime, now + smokeRetestMs), true, 'the failure is retested once its backoff has passed');
  account.enabled = false;
  assert.equal(needsSmoke(account, piRuntime, now + smokeRetestMs + 1), false, 'a disabled account is never tested');
  account.enabled = true;

  // The ineligibility the registry reads while the failure stands, and the retest it names.
  const message = accountIneligibility(registry.current(), account, now + 1, host);
  assert.match(message!, /pi-x failed its smoke test: 429 too many requests/);
  assert.match(message!, /it is tested again at /, 'the account is barred for the backoff, not until an operator edits it');

  // The executor's own view: a fresh failure is not retested and the account is passed over; past
  // the backoff the retest runs and what it saw is what the registry holds.
  const tested: string[] = [];
  const probe: FleetProbe = { registry: registry.client, quota: false, cacheMs: 0, smoke: async probed => { tested.push(probed.name); return { ok: false, error: '503 provider outage' }; } };
  await assert.rejects(selectFleetSession(config, 'approver', { name: 'approver' }, probe), /failed its smoke test: 429/);
  assert.deepEqual(tested, [], 'a fresh failure is not retested by the next selection');
  account.smoke = { ...account.smoke!, at: iso(-smokeRetestMs - 1) };
  await assert.rejects(selectFleetSession(config, 'approver', { name: 'approver' }, probe), /failed its smoke test: 503 provider outage/);
  assert.deepEqual(tested, ['pi-x'], 'the stale failure is retested');
  assert.equal(registry.current().accounts[0].smoke?.reason, '503 provider outage', 'the retest folds its own result, which restarts the backoff');
});

test('unit:review-followups-headless-gate — the smoke gate and the launcher read one list of headless runtimes, and a one-prompt smoke test is bounded far below 120s by default', () => {
  assert.equal(runsHeadless('pi'), true, 'pi is the headless runner of GY-169');
  assert.equal(runsHeadless('claude'), false, 'an interactive runtime is not headless');
  assert.equal(runsHeadless('muse'), false);
  assert.equal(smokeDefaultTimeoutMs, 30_000, 'a one-prompt test that outlasts this is a hanging provider, and no launch waits 120s on one');
  const shape = structuredClone(proposedRuntimes.find(runtime => runtime.name === 'pi')!);
  const runtime = (kind: string) => ({ ...structuredClone(shape), name: kind, launch: { ...shape.launch, kind } }) as FleetRuntime;
  const account = { name: 'a', runtime: 'r', model: 'm', credential: { host: 'h', home: null }, enabled: true, maxSessions: null, smoke: null } as FleetAccount;
  const at = Date.now();
  assert.equal(needsSmoke(account, runtime('pi'), at), true, 'a headless runtime account with no result is tested');
  assert.equal(needsSmoke(account, runtime('claude'), at), false, 'an interactive runtime account is not smoke-gated: its session is its own check');
});

test('unit:review-followups-smoke-timeout — a hanging provider answers the smoke test with the timeout failure instead of stalling the launch, on the bound the probe names', async () => {
  const { config } = await installation(), host = config.hostId;
  const registry = memoryRegistry(host);
  piFleet(registry, host, [{ name: 'pi-x', home: await piHome('pi-x') }]);
  const pi = await hangingPi();
  try {
    await assert.rejects(selectFleetSession(config, 'approver', { name: 'approver' }, { registry: registry.client, quota: false, cacheMs: 0, smokeTimeoutMs: 1100 }),
      /gave no answer within 1s/, 'the smoke bound reaches the run, and the launch fails fast instead of hanging');
    assert.match(registry.current().accounts[0].smoke!.reason!, /gave no answer within 1s/, 'the timeout folds as the failure it is');
  } finally { pi.restore(); }
});

test('unit:review-followups-crash-outcome — a headless approver run whose settled rejects is released as a run without a result, so it counts toward the unjudged-run hold', async () => {
  const { root, config } = await installation(), host = config.hostId;
  const registry = memoryRegistry(host);
  piFleet(registry, host, [{ name: 'pi-x', home: await piHome('pi-x') }]);
  // A passing smoke test in the document, so the launch runs the injected crashing runner and nothing spawns.
  registry.current().accounts[0].smoke = { result: 'pass', reason: null, at: new Date().toISOString(), by: 'coordinator' };
  const launched = await launchApprover(root, item('GY-704'), decisionId(1), undefined, { agents: [], available: true }, noHerdr, { registry: registry.client, quota: false, cacheMs: 0 }, undefined, { fetcher: accepted, filesystem: durable, runner: crashingRunner() });
  assert.equal(launched.session, registry.current().sessions.at(-1)!.id, 'the run holds a registry session');
  await assert.rejects(launched.settled!, /the runner died/, 'the crash is what the launch settles with');
  const session = registry.current().sessions.at(-1)!;
  assert.equal(session.outcome, 'no-result', 'the release named the outcome, where it named none before');
  assert.match(session.endReason!, /ended without a result.*the runner died/);
  assert.equal(registry.current().accounts[0].unjudged?.approver?.runs, 1, 'the crashed run reaches the unjudged-run count, where it never did before');
  assert.ok(session.endedAt, 'the slot is given back either way');
});
