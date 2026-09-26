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
import { detectRuntimeExhaustion } from '../src/master/environments.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-421: mid-session exhaustion is recognized only from the runtime's own provider-authored
// limit notice. GY-402's epoch 2 was failed over on the worker's own narration — "tmp disk
// quota is exhausted (a known local issue)…" — while claude-c had 86% of its 5-hour window left:
// a generic quota-exhausted pattern had matched the prose about a disk. The loop now judges a
// session's output against its runtime's own provider limit messages (the catalogs in
// src/master/environments.ts), and a worker that writes "quota" about anything is working, not
// exhausted. Everything here runs against a real Postgres, the real HTTP routes and a real Git
// worktree; each test is named for the proof it produces.

const repository = 'owner/exhaustion-notice';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, workerA, coordinator].map(principal => ({ ...principal, token: `exhaust-${principal.id}-${'x'.repeat(32)}` }));
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

const settlementToken = 'e'.repeat(64);
interface Herdr { agents: { name: string; pane_id: string; agent_status: string }[]; output: Record<string, string> }
/** The loop as `master run` wires it, with Herdr an inventory the test controls and the launcher its two control-plane calls. */
function loop(config: MasterConfig, herdr: Herdr, clock: { skewMs: number }) {
  const now = () => Date.now() + clock.skewMs;
  const calls = { dispatch: [] as { work: string; profile: string; account: string | null }[], stopped: [] as string[] };
  const effects: DaemonEffects = {
    agents: () => herdr.agents,
    herdr: () => ({ agents: herdr.agents, available: true }),
    credentials: () => inspectProfileAccounts(config, 'worker', config.workers, Object.fromEntries(config.workers.map(profile => [profile.name, { available: true, reason: null as string | null }])), { quota: false, now, cacheMs: 0 }),
    snapshot: async () => { const snapshot = await ok(coordinator, 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: new Date(Date.parse(snapshot.now) + clock.skewMs).toISOString() }; },
    closeSession: pane => { herdr.agents = herdr.agents.filter(agent => agent.pane_id !== pane); },
    dispatch: async (work, profile) => {
      // The real selection: the first of the profile's accounts that is logged in and not held.
      const selected = await selectAccount(config, 'worker', profile, { quota: false, now, cacheMs: 0, work: work.key });
      const claimed = await ok(workerA, 'POST', `work/${work.id}/claim`, {}) as Work;
      await ok(workerA, 'POST', `work/${work.id}/workspace`, { epoch: claimed.epoch, host: 'loop-host', path: worktree, branch: `graphyard/${claimed.key.toLowerCase()}-${claimed.epoch}` });
      // The supervisor records its containment before the agent starts, exactly as `watch` does.
      await ok(workerA, 'POST', `work/${work.id}/quarantine`, { epoch: claimed.epoch, settlementHash: createHash('sha256').update(settlementToken).digest('hex'), scope: { unit: `graphyard-watch-4242-${randomUUID()}.scope`, pid: 4242 } });
      herdr.agents.push({ name: profile.agentName, pane_id: `pane-${profile.name}-${calls.dispatch.length}`, agent_status: 'working' });
      calls.dispatch.push({ work: work.key, profile: profile.name, account: selected.account?.name ?? null });
    },
    requestProof: () => {},
    merge: async () => { throw new Error('no candidate reaches the merge step here'); },
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'no deployment endpoint in this test', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    sessionOutput: agent => herdr.output[agent.name!] ?? '',
    reportCapacity: (work, event) => ok(coordinator, 'POST', `work/${work.id}/capacity`, event) as Promise<Work>,
    selectedAccount: async (role, profile) => readEnvironmentLog(config).then(log => log.selected[`${role}:${profile}`] ?? null),
    holdAccount: (account, observed) => recordObservedExhaustion(config, account, observed, now()),
    preserveWork: async (work, epoch) => preservePartialWork(work.workspaces.find(entry => entry.epoch === epoch)!.path, `${work.key} attempt ${epoch} interrupted by provider quota exhaustion`),
    stopSupervisor: async orphan => {
      calls.stopped.push(`${orphan.key}:${orphan.epoch}`);
      herdr.agents = herdr.agents.filter(agent => agent.name !== orphan.agentName);
      await ok(workerA, 'POST', `work/${orphan.id}/settle`, { epoch: orphan.epoch, settlementToken });
    },
  };
  return { calls, cycle: (state: DaemonState) => runCycle(config, state, effects, now) };
}

before(async () => {
  const port = Number(process.env.GRAPHYARD_EXHAUSTION_NOTICE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 78);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('exhaustion-notice-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('exhaustion_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/exhaustion_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  home = await temporaryDirectory('exhaustion-home');
  await mkdir(join(home, 'env-a'), { recursive: true });
  await writeFile(join(home, 'env-a/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'not-a-real-token', refreshToken: 'not-a-real-token' } }));
  // The attempt worktree, with one commit the failover may build on.
  worktree = await temporaryDirectory('exhaustion-worktree');
  git(worktree, 'init', '-q', '-b', 'graphyard/attempt'); await writeFile(join(worktree, 'README.md'), 'base\n');
  git(worktree, 'add', '-A'); git(worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

// The transcript the incident turned on: the worker's own narration of a /tmp disk quota, which
// the generic patterns of the time matched as a provider limit notice.
const gy402Transcript = `● Update(src/daemon/cycle-sessions.ts)
  ⎿ tmp disk quota is exhausted (a known local issue). Clearing the tsx cache, as the memory note recommends, then rerunning.
`;

test('unit:exhaustion-only-provider-notice: only the runtime\'s own provider limit notice is an exhaustion, and the agent\'s prose about a quota never is', () => {
  const now = Date.parse('2026-09-26T02:00:00Z');
  // Free text an agent writes about a quota — a disk's, a summary's — is a failover on nothing.
  for (const prose of [
    gy402Transcript,
    'The /tmp quota is exhausted on this box; I cleared the cache and will rerun.',
    'we are out of quota on the disk, cleaning up now',
    'GY-89: escalate once when every account quota is exhausted',
    'Added a test for the rate limit reached path',
    'Done: the dispatcher now waits when the usage limit is reached.',
    'Error: I fixed the rate limit reached bug and updated the docs',
  ]) for (const runtime of ['claude', 'codex', 'opencode', 'cursor', undefined]) {
    assert.equal(detectRuntimeExhaustion(prose, runtime, now), null, `${runtime ?? 'unnamed'}: ${prose}`);
  }
  // The provider-authored notices, per runtime, with the reset time each names.
  assert.deepEqual(detectRuntimeExhaustion("⎿ You've hit your usage limit · resets 2026-10-01T00:00:00Z\n", 'claude', now),
    { reason: "You've hit your usage limit · resets 2026-10-01T00:00:00Z", resetsAt: '2026-10-01T00:00:00.000Z' });
  assert.equal(detectRuntimeExhaustion('Claude AI usage limit reached|1790409600', 'claude', now)!.resetsAt, new Date(1790409600_000).toISOString());
  assert.equal(detectRuntimeExhaustion("You've reached your usage limit for Codex. It resets 2026-10-02T00:00:00Z", 'codex', now)!.resetsAt, '2026-10-02T00:00:00.000Z');
  assert.equal(detectRuntimeExhaustion('Error: Weekly usage limit reached for GLM Coding Plan.\nYour quota will reset at 2026-09-26 08:30:00 UTC', 'opencode', now)!.resetsAt, '2026-09-26T08:30:00.000Z');
  assert.ok(detectRuntimeExhaustion("You've reached your spend limit for this billing cycle. It resets on 10/8.", 'cursor', now), 'a cursor spend limit is its provider\'s notice');
  const api429 = detectRuntimeExhaustion('Rate limit reached for requests', 'codex', now);
  assert.ok(api429, 'a notice that names no time is still an exhaustion');
  assert.equal(api429.resetsAt, null, 'it records an unknown reset rather than a guess');
  // A runtime with no catalog of its own is judged against the provider APIs' shared usage errors,
  // behind the severity label every runtime draws in front of them.
  assert.ok(detectRuntimeExhaustion('Error code: 429 - You exceeded your current quota, please check your plan and billing details.', 'gemini', now), 'the provider API\'s usage error is a notice on any runtime');
  assert.equal(detectRuntimeExhaustion(gy402Transcript, 'gemini', now), null, 'the shared provider errors never match the agent\'s own prose either');
});

test('integration:exhaustion-only-provider-notice — a stopped session narrating a disk quota is left working; a real Claude limit notice fails it over with the parsed reset time', async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  const config = masterConfigSchema.parse({
    version: 1, url, credentialFile: join(home, 'coordinator.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
    repository, baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-exhaustion',
    workers: [{ name: 'builder', principal: workerA.id, agentName: 'agent-builder', mode: 'launch', kind: 'claude', credentialFile: join(home, 'builder.token'), accounts: ['env-a'] }],
    environments: [{ name: 'env-a', kind: 'claude', home: join(home, 'env-a') }],
  }) as MasterConfig;
  const herdr: Herdr = { agents: [], output: {} }, clock = { skewMs: 0 };
  const { calls, cycle } = loop(config, herdr, clock);
  let work = await ok(operator, 'POST', 'work', { title: 'exhaustion notice', plannedFiles: ['src/exhaustion.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }] }) as Work;
  work = await ok(operator, 'POST', `work/${work.id}/ready`, {}) as Work;

  const state = emptyDaemonState(config);
  await cycle(state);
  assert.deepEqual(calls.dispatch, [{ work: work.key, profile: 'builder', account: 'env-a' }], 'the attempt runs on the profile\'s account');

  // The session stops mid-work and its screen carries the worker's own narration of a disk quota
  // (GY-402). This is not a provider limit notice: nothing fails over.
  herdr.agents[0].agent_status = 'idle';
  herdr.output['agent-builder'] = gy402Transcript;
  clock.skewMs += 20_000;
  await cycle(state);
  assert.equal(state.actions[failoverKey('worker', work, 1)], undefined, 'the worker\'s own prose about a quota fails nothing over');
  work = await reload(work.id);
  assert.equal(work.lease?.owner, workerA.id, 'the attempt is still live');
  assert.equal(work.lease?.epoch, 1);
  assert.equal(work.capacity ?? null, null, 'no exhaustion is recorded on the item');
  assert.deepEqual(calls.stopped, [], 'the supervisor is not stopped on the worker\'s own prose');
  assert.deepEqual(Object.keys(await observedExhaustions(config)), [], 'no account is held on the worker\'s prose');

  // The provider's own limit notice, on the same stopped session, is the real thing: the attempt
  // ends on the record, with the reset time the notice names parsed onto the account hold.
  const resetsAt = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 5 * 86_400_000).toISOString(); // a future hour, whatever the date
  herdr.output['agent-builder'] = `● Update(feature.ts)\n  ⎿ You've hit your usage limit · resets ${resetsAt}\n`;
  clock.skewMs += 20_000;
  await cycle(state);
  const failover = state.actions[failoverKey('worker', work, 1)];
  assert.equal(failover?.state, 'done', failover?.detail);
  assert.match(failover.detail, /exhausted env-a mid-session \(You've hit your usage limit/);
  assert.ok(failover.detail.includes(`resets ${resetsAt}`), failover.detail);
  work = await reload(work.id);
  assert.equal(work.lease, null, 'the attempt ended on the record');
  assert.equal(work.pipeline!.attempts[0].end, 'released');
  assert.equal(work.capacity!.exhaustions[0].account, 'env-a');
  assert.equal(work.capacity!.exhaustions[0].reason, `You've hit your usage limit · resets ${resetsAt}`);
  assert.equal(work.capacity!.exhaustions[0].resetsAt, resetsAt, 'the notice\'s reset time is recorded as parsed');
  assert.deepEqual(calls.stopped, [`${work.key}:1`], 'the supervisor is stopped through the containment scope it recorded');
  assert.equal((await observedExhaustions(config))['env-a']?.until, resetsAt, 'the spent account is held until it resets');

  // And the hold keeps the next dispatch off the spent account, whatever the item's readiness.
  clock.skewMs += 20_000;
  await cycle(state);
  assert.equal(calls.dispatch.length, 1, 'the held account is not dispatched onto');
});
