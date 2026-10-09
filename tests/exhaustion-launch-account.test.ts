import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, failoverKey, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { atomicPrivateWrite, environmentLogPath, holdRepeatedLimitAccount, inspectProfileAccounts, masterConfigSchema, observedExhaustions, preservePartialWork, readEnvironmentLog, recordEnvironmentLog, recordObservedExhaustion, selectAccount, sessionAccount, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { profileLaunchedFile } from '../src/master/dispatch-reservation.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { limitHost, limitLoop, type LimitPlane } from './helpers/limit-loop.js';

// GY-1582, 2026-10-09 09:57-10:00Z: worker profile opencode-secondary fell back to Claude account
// claude-b because its OpenCode accounts were spent. Its launch record named claude-b, but the
// environment log's selection for the profile still named opencode-b from an earlier launch, and
// the mid-session failover charged Claude's weekly-limit menu to opencode-b. claude-b stayed
// eligible, and every relaunch landed on it again. A worker's exhaustion is now charged to the
// account its own launch record names, and an account an item's consecutive launches each ended
// on is held before the next launch is chosen.

/** The menu every one of those sessions opened on, as Claude Code drew it. */
const limitMenu = `● Reading the item before editing.
  ⎿  You've hit your weekly limit · resets Oct 12, 3pm (America/Los_Angeles)

   What do you want to do?

   ❯ 1. Stop and wait for limit to reset
     2. Wait here, then continue automatically at Oct 12, 3pm
     3. Add funds to continue with usage credits

   Enter to confirm · Esc to cancel
`;
const reset = '2026-10-12T22:00:00.000Z';

const repository = 'owner/exhaustion-launch-account';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, workerA, coordinator].map(principal => ({ ...principal, token: `gy1582-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store | undefined, engine: Engine, http: ReturnType<typeof server> | undefined, url: string, port: number;

const ok = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
};
const reload = async (id: string) => (await store!.list()).find(item => item.id === id)!;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const worktree = async (name: string) => {
  const path = await temporaryDirectory(`exhaustion-launch-account-${name}`);
  git(path, 'init', '-q', '-b', 'graphyard/attempt'); await writeFile(join(path, 'README.md'), 'base\n');
  git(path, 'add', '-A'); git(path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  return path;
};

/** One host's agent homes: OpenCode opencode-b, Claude claude-b and its shared-login twin claude-b2, and claude-c on its own login. */
async function host(name: string) {
  const home = await temporaryDirectory(`exhaustion-launch-account-${name}`);
  const logins: Record<string, string> = { 'claude-b': 'subscription-b', 'claude-b2': 'subscription-b', 'claude-c': 'subscription-c' };
  for (const [account, login] of Object.entries(logins)) {
    await mkdir(join(home, account), { recursive: true });
    await writeFile(join(home, account, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'not-a-real-token', refreshToken: 'not-a-real-token' } }));
    await writeFile(join(home, account, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: `${login}-account`, organizationUuid: `${login}-org` } }));
  }
  await mkdir(join(home, 'opencode-b'), { recursive: true });
  return home;
}
const configFor = (home: string, worker: Record<string, unknown>) => masterConfigSchema.parse({
  version: 1, url, credentialFile: join(home, 'coordinator.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
  repository, baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: `graphyard-master-${randomUUID().slice(0, 8)}`,
  workers: [{ principal: workerA.id, mode: 'launch', credentialFile: join(home, 'worker.token'), ...worker }],
  environments: [{ name: 'opencode-b', kind: 'opencode', home: join(home, 'opencode-b') }, ...['claude-b', 'claude-b2', 'claude-c'].map(name => ({ name, kind: 'claude', home: join(home, name) }))],
}) as MasterConfig;

const settlementToken = 'e'.repeat(64);
interface Herdr { agents: { name: string; pane_id: string; agent_status: string }[]; output: Record<string, string> }
/**
 * The loop as `master run` wires it: the account a failover charges comes from the production
 * `sessionAccount`, and each launch writes the profile's launch record as dispatchWork does. A
 * launch's account is the registry's choice when `choose` gives one, which (as on 2026-10-09)
 * leaves the environment log's selection as it was; otherwise it is the production selection. The
 * repeated-limit replay runs on the production dispatchWork instead (tests/helpers/limit-loop.ts).
 */
function loop(root: string, config: MasterConfig, herdr: Herdr, choose: (work: Work, profile: WorkerProfile) => string | null = () => null) {
  const calls = { dispatch: [] as { work: string; epoch: number; account: string | null }[], stopped: [] as string[] };
  const effects: DaemonEffects = {
    agents: () => herdr.agents,
    herdr: () => ({ agents: herdr.agents, available: true }),
    credentials: () => inspectProfileAccounts(config, 'worker', config.workers, Object.fromEntries(config.workers.map(profile => [profile.name, { available: true, reason: null as string | null }])), { quota: false, cacheMs: 0 }),
    snapshot: async () => { const snapshot = await ok(coordinator, 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: snapshot.now }; },
    closeSession: pane => { herdr.agents = herdr.agents.filter(agent => agent.pane_id !== pane); },
    dispatch: async (work, profile) => {
      let account = choose(work, profile);
      account ??= (await selectAccount(config, 'worker', profile, { quota: false, cacheMs: 0, work: work.key })).account?.name ?? null;
      const claimed = await ok(workerA, 'POST', `work/${work.id}/claim`, {}) as Work;
      await ok(workerA, 'POST', `work/${work.id}/workspace`, { epoch: claimed.epoch, host: 'loop-host', path: await worktree(`${work.key}-${claimed.epoch}`), branch: `graphyard/${claimed.key.toLowerCase()}-${claimed.epoch}` });
      await ok(workerA, 'POST', `work/${work.id}/quarantine`, { epoch: claimed.epoch, settlementHash: createHash('sha256').update(settlementToken).digest('hex'), scope: { unit: `graphyard-watch-4242-${randomUUID()}.scope`, pid: 4242 } });
      const kind = config.environments!.find(entry => entry.name === account)?.kind ?? null;
      await mkdir(join(root, '.graphyard/dispatch'), { recursive: true });
      await writeFile(profileLaunchedFile(root, profile.name), JSON.stringify({ key: work.key, epoch: claimed.epoch, agentName: profile.agentName, at: new Date().toISOString(), runtime: kind, account }));
      herdr.agents.push({ name: profile.agentName, pane_id: `pane-${profile.name}-${calls.dispatch.length}`, agent_status: 'working' });
      calls.dispatch.push({ work: work.key, epoch: claimed.epoch!, account });
    },
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'no deployment endpoint in this test', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    sessionOutput: agent => herdr.output[agent.name!] ?? '',
    answerSession: () => { throw new Error('the loop never answers the limit menu'); },
    reportCapacity: (work, event) => ok(coordinator, 'POST', `work/${work.id}/capacity`, event) as Promise<Work>,
    selectedAccount: (role, profile, launch) => sessionAccount(root, config, role, profile, launch),
    holdAccount: (account, observed) => recordObservedExhaustion(config, account, observed),
    preserveWork: async (work, epoch) => preservePartialWork(work.workspaces.find(entry => entry.epoch === epoch)!.path, `${work.key} attempt ${epoch} interrupted by provider quota exhaustion`),
    stopSupervisor: async orphan => {
      calls.stopped.push(`${orphan.key}:${orphan.epoch}`);
      herdr.agents = herdr.agents.filter(agent => agent.name !== orphan.agentName);
      await ok(workerA, 'POST', `work/${orphan.id}/settle`, { epoch: orphan.epoch, settlementToken });
    },
  };
  return { calls, cycle: (state: DaemonState) => runCycle(config, state, effects) };
}
const newItem = async (title: string) => {
  const work = await ok(operator, 'POST', 'work', { title, plannedFiles: [`src/${randomUUID().slice(0, 8)}.ts`], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }] }) as Work;
  return ok(operator, 'POST', `work/${work.id}/ready`, {}) as Promise<Work>;
};
/** The session stops on Claude's limit menu, and the loop's next cycle fails it over. */
const spend = async (herdr: Herdr, agentName: string, cycle: () => Promise<unknown>) => {
  herdr.agents.find(agent => agent.name === agentName)!.agent_status = 'blocked';
  herdr.output[agentName] = limitMenu;
  await cycle();
  herdr.output[agentName] = '';
};

before(async () => {
  port = Number(process.env.GRAPHYARD_EXHAUSTION_LAUNCH_ACCOUNT_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1582);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('exhaustion-launch-account-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start();
});
/** Each scenario runs against a control plane of its own, so one's open item is not the other's to dispatch. */
async function controlPlane(name: string) {
  http?.close(); await store?.close();
  await database.createDatabase(name);
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/${name}`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http!.address() as { port: number }).port}`;
}
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:exhaustion-charged-to-launch-account — the 09:59Z limit menu is charged to claude-b, the account the session launched on, never the profile\'s opencode-b, and the next dispatch passes over claude-b and its shared-login twin', async () => {
  await controlPlane('launch_account_replay');
  const home = await host('replay'), root = await temporaryDirectory('exhaustion-launch-account-root');
  const config = configFor(home, { name: 'opencode-secondary', agentName: 'graphyard-opencode-2', kind: 'opencode', accounts: ['opencode-b', 'claude-b', 'claude-b2', 'claude-c'] });
  // An earlier launch of the profile on its own OpenCode account left the selection naming opencode-b.
  await recordEnvironmentLog(config, [], [], { key: 'worker:opencode-secondary', environment: 'opencode-b', kind: 'opencode', at: '2026-10-09T09:40:00.000Z', work: 'GY-1578' });
  const herdr: Herdr = { agents: [], output: {} };
  let registryChoice: string | null = 'claude-b';
  const { calls, cycle } = loop(root, config, herdr, () => { const chosen = registryChoice; registryChoice = null; return chosen; });
  let work = await newItem('replay 09:59Z');
  const state = emptyDaemonState(config);

  await cycle(state);
  assert.deepEqual(calls.dispatch, [{ work: work.key, epoch: 1, account: 'claude-b' }], 'opencode-secondary fell back to Claude account claude-b');
  assert.equal((await readEnvironmentLog(config)).selected['worker:opencode-secondary']?.environment, 'opencode-b', 'the selection log still names the profile\'s nominal account, as it did at 09:59Z');

  await spend(herdr, 'graphyard-opencode-2', () => cycle(state));
  const failover = state.actions[failoverKey('worker', work, 1)];
  assert.equal(failover?.state, 'done', failover?.detail);
  assert.match(failover.detail, /exhausted claude-b mid-session \(You've hit your weekly limit/);
  assert.doesNotMatch(failover.detail, /opencode-b/);
  work = await reload(work.id);
  const exhaustion = work.capacity!.exhaustions.at(-1)!;
  assert.deepEqual({ account: exhaustion.account, runtime: exhaustion.runtime, resetsAt: exhaustion.resetsAt }, { account: 'claude-b', runtime: 'claude', resetsAt: reset }, 'the item records the account and runtime the session ran on');
  const held = await observedExhaustions(config);
  assert.equal(held['claude-b']?.until, reset, 'claude-b is held until the reset its menu names');
  assert.match(held['claude-b'].reason, /^You've hit your weekly limit/, 'with the notice the session showed');
  assert.equal(held['opencode-b'], undefined, 'opencode-b, which the session never ran on, is unchanged');
  assert.deepEqual(Object.keys(held), ['claude-b']);

  // The next dispatch: opencode-b is not logged in, claude-b is held, claude-b2 is its twin.
  await cycle(state);
  assert.deepEqual(calls.dispatch.at(-1), { work: work.key, epoch: 2, account: 'claude-c' }, 'neither claude-b nor its shared-login twin claude-b2 is chosen');
  const skipped = (await readEnvironmentLog(config)).skipped.filter(entry => entry.work === work.key);
  assert.ok(skipped.some(entry => entry.environment === 'claude-b' && entry.cause === 'exhausted'), 'claude-b is skipped as exhausted');
  assert.ok(skipped.some(entry => entry.environment === 'claude-b2' && /same provider login as claude-b/.test(entry.reason)), 'claude-b2 is skipped as claude-b\'s twin');

  // A launch record of another attempt is not this one's: the selection is read instead.
  assert.deepEqual(await sessionAccount(root, config, 'worker', 'opencode-secondary', { work: work.key, epoch: 1 }), (await readEnvironmentLog(config)).selected['worker:opencode-secondary']);
  assert.deepEqual(await sessionAccount(root, config, 'worker', 'opencode-secondary', { work: work.key, epoch: 2 }), { environment: 'claude-c', kind: 'claude' });
});

test('unit:repeated-limit-launch-holds-account — an item whose two consecutive launches on one account each end on its limit notice is not launched onto it a third time by the real dispatch: the account is held and the attempt routed to an eligible one, and a hold that cannot be placed refuses the dispatch before anything is claimed', async () => {
  await controlPlane('launch_account_repeat');
  const plane: LimitPlane = { url, coordinatorToken: token(coordinator), api: (as, method, path, body) => ok(as === 'coordinator' ? coordinator : workerA, method, path, body) };
  const host = await limitHost(plane, [{ name: 'claude-primary', principal: workerA.id, token: token(workerA), accounts: ['claude-b', 'claude-c'] }], { 'claude-b': 'subscription-b', 'claude-c': 'subscription-c' });
  const { config } = host, profile = config.workers[0];
  const { launches, refused, spend, cycle, dispatch, world } = limitLoop(plane, host);
  let work = await newItem('repeated limit');
  const state = emptyDaemonState(config);
  /** The hold each notice placed lapses or is lost (as a hold charged elsewhere was at 09:59Z). */
  const lapse = async () => { const log = await readEnvironmentLog(config); log.exhausted = {}; await atomicPrivateWrite(environmentLogPath(config), log); };

  await cycle(state);
  assert.deepEqual(launches.map(entry => [entry.epoch, entry.account]), [[1, 'claude-b']], `the real dispatch launched it on claude-b: ${JSON.stringify(refused)}`);
  spend(launches.at(-1)!, 'Oct 12, 3pm');
  await cycle(state);
  assert.equal(state.actions[failoverKey('worker', work, 1)]?.state, 'done', state.actions[failoverKey('worker', work, 1)]?.detail);
  await lapse();

  // One limit notice is not yet a repeat: with no hold standing, claude-b is chosen again.
  await cycle(state);
  assert.deepEqual(launches.at(-1) && [launches.at(-1)!.epoch, launches.at(-1)!.account], [2, 'claude-b'], JSON.stringify(refused));
  spend(launches.at(-1)!, 'Oct 12, 3pm');
  await cycle(state);
  assert.equal(state.actions[failoverKey('worker', work, 2)]?.state, 'done');
  await lapse();
  work = await reload(work.id);
  assert.deepEqual(work.capacity!.exhaustions.map(entry => [entry.epoch, entry.account]), [[1, 'claude-b'], [2, 'claude-b']]);

  // A hold that cannot be placed (the environment log unwritable, so no hold can stand) refuses
  // the dispatch before any claim, rather than letting selection hand claude-b back a third time.
  const log = environmentLogPath(config);
  await rm(log, { force: true }); await mkdir(log);
  const snapshot = await ok(coordinator, 'GET', 'work-snapshot');
  await assert.rejects(dispatch(work, profile, [], { work: snapshot.work, now: snapshot.now }), (error: Error) => {
    assert.match(error.message, new RegExp(`${work.key}'s last worker launches each ended on claude-b's limit notice, and the hold that keeps the next launch off it could not be placed: .*; nothing was claimed`));
    return true;
  });
  assert.equal((await reload(work.id)).epoch, 2, 'nothing was claimed');
  assert.equal(launches.length, 2, 'and nothing launched');
  assert.equal(world.kinds.length, 2, 'no runtime was started for the refused dispatch');
  await rmdir(log);

  // The third launch, through the loop: claude-b is held again before the choice, and the attempt goes to claude-c.
  await cycle(state);
  assert.deepEqual(launches.at(-1) && [launches.at(-1)!.key, launches.at(-1)!.epoch, launches.at(-1)!.account], [work.key, 3, 'claude-c'], `not relaunched onto claude-b a third time: ${JSON.stringify(refused)}`);
  const held = (await observedExhaustions(config))['claude-b'];
  assert.equal(held?.until, reset, 'held until the reset its last notice named');
  assert.match(held.reason, new RegExp(`${work.key}'s last 2 worker launches \\(epochs 1, 2\\) each ended on claude-b's limit notice`));
  assert.equal(held.work, work.key);

  // Held already, nothing is placed again; an item whose last launch ended elsewhere holds nothing.
  work = await reload(work.id);
  assert.equal(await holdRepeatedLimitAccount(config, work), null);
  await lapse();
  const elsewhere = { ...work, capacity: { ...work.capacity!, exhaustions: [...work.capacity!.exhaustions, { ...work.capacity!.exhaustions.at(-1)!, epoch: 3, account: 'claude-c' }] } };
  assert.equal(await holdRepeatedLimitAccount(config, elsewhere), null);
  // Nor does a repeat older than the window.
  assert.equal(await holdRepeatedLimitAccount(config, work, Date.now() + 3 * 3_600_000), null);
});
