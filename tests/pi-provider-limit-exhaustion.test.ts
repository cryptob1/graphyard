import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, failoverKey, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { inspectProfileAccounts, masterConfigSchema, observedExhaustions, preservePartialWork, recordObservedExhaustion, readEnvironmentLog, selectAccount, type MasterConfig } from '../src/master.js';
import { idleLeaseKey } from '../src/daemon/cycle-resume.js';
import { detectRuntimeExhaustion, providerLimitNotices } from '../src/master/environments.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1817: a pi worker whose provider answered `429 code 1310 Weekly/Monthly Limit Exhausted`
// sat out a full idle bound on a spent account, twice, because the loop read the notice as
// ordinary idleness and relaunched the item on the same account. pi now has its own entry in the
// provider limit catalogs, and its zone-less reset wall clock is read in UTC: the provider names
// no zone, so the hold must not drift by whatever offset the loop host sits in.

// The 2026-10-15 and 2026-10-17 instants are the observed incident's fixed clock: the loop below
// runs on the instant the notice was read and the reset the provider named, handed in whole —
// neither Date.now() nor new Date() is read anywhere in this file.

const repository = 'owner/pi-provider-limit';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, workerA, coordinator].map(principal => ({ ...principal, token: `pi-limit-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, home: string, worktree: string;

const call = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(principal, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The pane GY-1816 epoch 1 ended on (2026-10-15T00:26Z): the provider's answer, then pi giving up. Herdr read the session idle. */
const limitError = 'Error: 429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-17 08:27:35"}';
const piPane = `● Reading GY-1816 before editing.
  ⎿ Read 40 lines

${limitError}
Retry failed after 3 attempts
`;
/** 2026-10-15T01:10:00Z, the instant the loop read the notice; each cycle advances it. */
const observedAt = Date.parse('2026-10-15T01:10:00Z');
/** 2026-10-17T08:27:35Z, the reset the notice names, read in UTC: 55h17m35s after the fixed clock. */
const resetAt = new Date(observedAt + ((55 * 60 + 17) * 60 + 35) * 1000).toISOString();
const clock = { skewMs: 0 };
const now = () => observedAt + clock.skewMs;

const settlementToken = 'e'.repeat(64);
interface Herdr { agents: { name: string; pane_id: string; agent_status: string }[]; output: Record<string, string> }
/** The loop as `master run` wires it, with Herdr an inventory the test controls and the launcher its control-plane calls. The clock never reads the wall. */
function loop(config: MasterConfig, herdr: Herdr) {
  const calls = { dispatch: [] as { work: string; profile: string; account: string | null }[], prompted: [] as string[], stopped: [] as string[] };
  const effects: DaemonEffects = {
    agents: () => herdr.agents,
    herdr: () => ({ agents: herdr.agents, available: true }),
    credentials: () => inspectProfileAccounts(config, 'worker', config.workers, Object.fromEntries(config.workers.map(profile => [profile.name, { available: true, reason: null as string | null }])), { quota: false, now, cacheMs: 0 }),
    snapshot: async () => { const snapshot = await ok(coordinator, 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: new Date(now()).toISOString() }; },
    closeSession: pane => { herdr.agents = herdr.agents.filter(agent => agent.pane_id !== pane); },
    dispatch: async (work, profile) => {
      // The real selection: the first of the profile's accounts that is logged in and not held.
      const selected = await selectAccount(config, 'worker', profile, { quota: false, now, cacheMs: 0, work: work.key });
      const claimed = await ok(workerA, 'POST', `work/${work.id}/claim`, {}) as Work;
      // Each attempt works in its own worktree: the control plane refuses a path two epochs share.
      await ok(workerA, 'POST', `work/${work.id}/workspace`, { epoch: claimed.epoch, host: 'loop-host', path: calls.dispatch.length ? `${worktree}-next` : worktree, branch: `graphyard/${claimed.key.toLowerCase()}-${claimed.epoch}` });
      // The supervisor records its containment before the agent starts, exactly as `watch` does.
      await ok(workerA, 'POST', `work/${work.id}/quarantine`, { epoch: claimed.epoch, settlementHash: createHash('sha256').update(settlementToken).digest('hex'), scope: { unit: `graphyard-watch-4242-${randomUUID()}.scope`, pid: 4242 } });
      herdr.agents = [...herdr.agents.filter(agent => agent.name !== profile.agentName), { name: profile.agentName, pane_id: `pane-${profile.name}-${calls.dispatch.length}`, agent_status: 'working' }];
      calls.dispatch.push({ work: work.key, profile: profile.name, account: selected.account?.name ?? null });
    },
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(now()).toISOString(), reason: 'no deployment endpoint in this test', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    sessionOutput: agent => herdr.output[agent.name!] ?? '',
    reportCapacity: (work, event) => ok(coordinator, 'POST', `work/${work.id}/capacity`, event) as Promise<Work>,
    selectedAccount: async (role, profile) => readEnvironmentLog(config).then(log => log.selected[`${role}:${profile}`] ?? null),
    holdAccount: (account, observed) => recordObservedExhaustion(config, account, observed, now()),
    preserveWork: async (work, epoch) => preservePartialWork(work.workspaces.find(entry => entry.epoch === epoch)!.path, `${work.key} attempt ${epoch} interrupted by provider quota exhaustion`),
    promptSession: async () => { calls.prompted.push('prompted'); },
    stopSupervisor: async orphan => {
      calls.stopped.push(`${orphan.key}:${orphan.epoch}`);
      herdr.agents = herdr.agents.filter(agent => agent.name !== orphan.agentName);
      await ok(workerA, 'POST', `work/${orphan.id}/settle`, { epoch: orphan.epoch, settlementToken });
    },
  };
  return { calls, cycle: (state: DaemonState) => runCycle(config, state, effects, now) };
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_PI_PROVIDER_LIMIT_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1750);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('pi-limit-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('pi_limit_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/pi_limit_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  home = await temporaryDirectory('pi-limit-home');
  // Two Z.AI accounts as pi environments are declared: kind `opencode` homes with a provider login.
  for (const account of ['pi-a', 'pi-b']) {
    await mkdir(join(home, account, 'opencode'), { recursive: true });
    await writeFile(join(home, account, 'opencode/auth.json'), JSON.stringify({ 'zai-coding-plan': { key: 'not-a-real-key' } }));
  }
  // The attempt worktree, with one commit the failover builds on.
  worktree = await temporaryDirectory('pi-limit-worktree');
  git(worktree, 'init', '-q', '-b', 'graphyard/attempt'); await writeFile(join(worktree, 'README.md'), 'base\n');
  git(worktree, 'add', '-A'); git(worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:pi-provider-limit-exhaustion — pi\'s 429 code 1310 "Weekly/Monthly Limit Exhausted" is its provider saying the account is spent, and its zone-less reset is read in UTC', () => {
  // The loop host is not in the provider's zone: the reset must not drift by the host's offset.
  const zone = process.env.TZ;
  process.env.TZ = 'Asia/Kolkata';
  try {
    const at = Date.parse('2026-10-15T01:10:00Z');
    const signal = detectRuntimeExhaustion(piPane, 'pi', at);
    assert.ok(signal, 'the 1310 notice is an exhaustion');
    assert.equal(signal.reason, '{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-17 08:27:35"}', 'the notice, behind the runtime\'s own Error label, is the reason');
    assert.equal(signal.resetsAt, resetAt, 'the provider named no zone, so the reset wall clock is read in UTC, not the host\'s');
    // A zone the provider did name is kept, not overwritten by the UTC default.
    const zoned = detectRuntimeExhaustion(piPane.replace('08:27:35"', '08:27:35 UTC"'), 'pi', at);
    assert.equal(zoned?.resetsAt, resetAt, 'an explicit zone survives the UTC default');
    // A zone the provider names in parentheses is that zone's wall clock: 08:27:35 PDT is 15:27:35Z, not 08:27:35Z.
    const named = detectRuntimeExhaustion(piPane.replace('08:27:35"', '08:27:35 (America/Los_Angeles)"'), 'pi', at);
    assert.equal(named?.resetsAt, '2026-10-17T15:27:35.000Z', 'a parenthesized named zone survives the UTC default');
    assert.ok(providerLimitNotices.pi, 'pi has its own entry in the catalogs');
    // Another runtime's catalog does not read pi's banner.
    assert.equal(detectRuntimeExhaustion(piPane, 'claude', at), null, 'the notice is pi\'s catalog, not Claude\'s');
    assert.equal(detectRuntimeExhaustion(piPane, 'codex', at), null, 'the notice is pi\'s catalog, not the shared provider errors');
    // An agent's prose about the limit is work, not a failover (GY-421).
    for (const prose of [
      'Tests pass; the weekly limit exhausted branch is covered.',
      'Handled the case where the Weekly/Monthly Limit Exhausted banner is on screen',
      // The bare phrase leading an agent's own line is not the provider's envelope.
      'Weekly/Monthly Limit Exhausted handling is now covered',
      '  ⎿ tmp disk quota is exhausted (a known local issue). Clearing the tsx cache, then rerunning.',
      'The 429 code 1310 handling resets at 2026-10-17 08:27:35 in the test I just added',
    ]) assert.equal(detectRuntimeExhaustion(prose, 'pi', at), null, prose);
  } finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; }
});

test('integration:pi-provider-limit-exhaustion — an idle pi session on the 1310 notice is failed over on the next session-reconcile pass: the launch account is held until the UTC reset, the attempt ends keeping its branch instead of waiting out the idle bound, and the item redispatches on an eligible account', async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  const config = masterConfigSchema.parse({
    version: 1, url, credentialFile: join(home, 'coordinator.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
    repository, baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-pi-limit',
    workers: [{ name: 'builder', principal: workerA.id, agentName: 'agent-builder', mode: 'launch', kind: 'pi', credentialFile: join(home, 'builder.token'), accounts: ['pi-a', 'pi-b'] }],
    environments: [{ name: 'pi-a', kind: 'opencode', home: join(home, 'pi-a') }, { name: 'pi-b', kind: 'opencode', home: join(home, 'pi-b') }],
  }) as MasterConfig;
  const herdr: Herdr = { agents: [], output: {} };
  const { calls, cycle } = loop(config, herdr);
  let work = await ok(operator, 'POST', 'work', { title: 'pi limit exhaustion', plannedFiles: ['src/pi.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }] }) as Work;
  work = await ok(operator, 'POST', `work/${work.id}/ready`, {}) as Work;

  // The attempt runs on the first account.
  const state = emptyDaemonState(config);
  await cycle(state);
  assert.deepEqual(calls.dispatch, [{ work: work.key, profile: 'builder', account: 'pi-a' }], 'the attempt runs on pi-a');

  // pi gave up on the spent account: its pane shows the provider's 1310 answer and Herdr reads the session idle.
  await writeFile(join(worktree, 'progress.md'), 'half-finished change\n');
  herdr.agents[0].agent_status = 'idle';
  herdr.output['agent-builder'] = piPane;
  clock.skewMs += 20_000;
  await cycle(state);
  const failover = state.actions[failoverKey('worker', work, 1)];
  assert.equal(failover?.state, 'done', failover?.detail);
  assert.match(failover.detail, /exhausted pi-a mid-session \(\{"code":"1310","message":"Weekly\/Monthly Limit Exhausted/);
  assert.ok(failover.detail.includes(`resets ${resetAt}`), failover.detail);
  assert.deepEqual(calls.prompted, [], 'the idle bound is never waited out: no re-prompt is sent to a session whose provider said the account is spent');
  assert.equal(state.actions[idleLeaseKey(work, 1)], undefined, 'the session is never recorded idle-with-lease');
  assert.deepEqual(calls.stopped, [`${work.key}:1`], 'the session\'s supervisor is stopped');
  work = await reload(work.id);
  assert.equal(work.lease, null, 'the lease is released');
  assert.equal(work.pipeline!.attempts[0].end, 'released', 'the attempt ends as released, keeping its branch');
  const exhaustion = work.capacity!.exhaustions[0];
  assert.equal(exhaustion.account, 'pi-a', 'the launch account is charged, not the profile');
  assert.equal(exhaustion.reason, limitError.replace(/^Error: 429: /, ''), 'the recorded reason is the provider\'s notice behind the runtime\'s error label');
  assert.equal(exhaustion.resetsAt, resetAt);
  assert.equal(exhaustion.partialWork.state, 'committed', 'the partial work is kept');
  assert.equal(git(worktree, 'status', '--porcelain'), '', 'the partial work is a commit on the attempt branch');
  assert.equal((await observedExhaustions(config, now()))['pi-a']?.until, resetAt, 'the spent account is held until the UTC reset');

  // The next cycle redispatches the item onto the healthy account, with no master action.
  clock.skewMs += 20_000;
  await cycle(state);
  assert.deepEqual(calls.dispatch.at(-1), { work: work.key, profile: 'builder', account: 'pi-b' });
  assert.equal((await reload(work.id)).lease?.epoch, 2);
});
