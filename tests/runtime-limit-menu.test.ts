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
import { classifyRuntimePrompt, inspectProfileAccounts, masterConfigSchema, observedExhaustions, preservePartialWork, recordObservedExhaustion, readEnvironmentLog, selectAccount, type MasterConfig } from '../src/master.js';
import { detectRuntimeExhaustion } from '../src/master/environments.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1566: a Claude worker launched onto a spent account printed its limit notice and then its
// usage-limit menu, and sat blocked on it for 32 minutes: Herdr reported the pane blocked, the
// supervisor kept renewing the lease, and nothing failed it over. The menu is now read as the
// account's exhaustion, with the reset time its notice names; the loop never chooses on it — one
// choice spends money, which only a person may do — and fails the session over instead.

/** The screen GY-1565 epoch 3 stood on, as Claude Code drew it. */
const limitMenu = `● Reading GY-1565 before editing.
  ⎿  You've hit your weekly limit · resets Oct 10, 10pm (America/Los_Angeles)

 What do you want to do?

 ❯ 1. Stop and wait for limit to reset
   2. Wait here, then continue automatically at Oct 10, 10pm
   3. Switch to usage credits

 Enter to confirm · Esc to cancel
`;
const notice = "You've hit your weekly limit · resets Oct 10, 10pm (America/Los_Angeles)";
/** The same menu as a later Claude Code draws it (read off a live pane on 2026-10-09): no-break spaces, a rule above, and a funds choice. */
const fundsMenu = `  Ran 1 shell command
  ⎿\u00a0 You've hit your weekly limit\u00a0· resets Oct 12, 3pm (America/Los_Angeles)
     Use your limit reset to reset it now: clau.de/reset

✻ Cogitated for 22s · done 1:10 PM
${'▔'.repeat(80)}
   What do you want to do?

   ❯\u00a01. Stop and wait for limit to reset
     2. Wait here, then continue automatically at Oct 12, 3pm
     3. Add funds to continue with usage credits

   Enter to confirm · Esc to cancel
`;

test('unit:runtime-limit-menu-detected — Claude\'s usage-limit menu is the account\'s exhaustion with its parsed reset, and is never answered', () => {
  const now = Date.parse('2026-10-09T02:49:00Z');
  const prompt = classifyRuntimePrompt(limitMenu, now)!;
  assert.equal(prompt.kind, 'usage-limit');
  assert.equal(prompt.keys, null, 'the loop sends the menu no keys: never "Switch to usage credits"');
  assert.equal(prompt.answer, null);
  assert.match(prompt.text, /What do you want to do\? \/ 1\. Stop and wait for limit to reset/);
  // 10pm in Los Angeles on Oct 10 (PDT, UTC-7), whatever zone the host runs in.
  assert.deepEqual(prompt.exhaustion, { reason: notice, resetsAt: '2026-10-11T05:00:00.000Z' });
  assert.deepEqual(detectRuntimeExhaustion(limitMenu, 'claude', now), prompt.exhaustion, 'the stopped-session judge reads the same menu');
  assert.deepEqual(detectRuntimeExhaustion(limitMenu, undefined, now), prompt.exhaustion, 'whatever runtime the profile names');
  const funds = classifyRuntimePrompt(fundsMenu, now)!;
  assert.equal(funds.kind, 'usage-limit');
  assert.equal(funds.keys, null, 'nor "Add funds to continue with usage credits"');
  assert.equal(funds.exhaustion!.resetsAt, '2026-10-12T22:00:00.000Z', '3pm in Los Angeles on Oct 12');
  assert.match(funds.exhaustion!.reason, /^You've hit your weekly limit/);
  // Drawn in a box, with escapes and its notice behind a label, it is the same menu.
  const boxed = `\u001b[2m⎿ API Error: Claude Code · ${notice}\u001b[0m\n╭────────────╮\n│ What do you want to do?   │\n│ ❯ 1. Stop and wait for limit to reset │\n│   2. Wait here, then continue automatically at Oct 10, 10pm │\n│   3. Switch to usage credits │\n╰────────────╯\n Enter to confirm · Esc to cancel`;
  assert.equal(classifyRuntimePrompt(boxed, now)!.kind, 'usage-limit');
  assert.equal(detectRuntimeExhaustion(boxed, 'claude', now)!.resetsAt, '2026-10-11T05:00:00.000Z');
  // With its notice scrolled away, the wait choice names the reset.
  const bare = limitMenu.replace(/^.*weekly limit.*$/m, '');
  assert.equal(classifyRuntimePrompt(bare, now)!.kind, 'usage-limit');
  assert.equal(classifyRuntimePrompt(bare, now)!.exhaustion!.resetsAt, new Date(2026, 9, 10, 22, 0).toISOString(), 'the wait choice is read in the host\'s zone');

  // An agent's prose about the menu or about a quota is not the menu.
  for (const prose of [
    // The menu's choices quoted in a summary, with prose after them.
    `Options the runtime offers:\n 1. Stop and wait for limit to reset\n 2. Wait here, then continue automatically\n 3. Switch to usage credits\nI will implement the failover next.`,
    // No question directly above the choices.
    `${notice}\n 1. Stop and wait for limit to reset\n 3. Switch to usage credits`,
    // The question, but not the runtime's choices.
    ` What do you want to do?\n ❯ 1. Yes\n   2. No`,
    // The stop choice alone.
    ` What do you want to do?\n ❯ 1. Stop and wait for limit to reset\n   2. Something else`,
    '● tmp disk quota is exhausted (a known local issue). Clearing the tsx cache, then rerunning.',
  ]) {
    assert.notEqual(classifyRuntimePrompt(prose, now)?.kind, 'usage-limit', prose);
    if (!prose.includes(notice)) assert.equal(detectRuntimeExhaustion(prose, 'claude', now), null, prose);
  }
});

const repository = 'owner/runtime-limit-menu';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, workerA, coordinator].map(principal => ({ ...principal, token: `menu-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, home: string, worktrees: string[];

const ok = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const settlementToken = 'e'.repeat(64);
interface Herdr { agents: { name: string; pane_id: string; agent_status: string }[]; output: Record<string, string> }
/** The loop as `master run` wires it, with Herdr an inventory the test controls and the launcher its control-plane calls. */
function loop(config: MasterConfig, herdr: Herdr, clock: { skewMs: number }) {
  const now = () => Date.now() + clock.skewMs;
  const calls = { dispatch: [] as { work: string; profile: string; account: string | null }[], stopped: [] as string[], keys: [] as string[][] };
  const effects: DaemonEffects = {
    agents: () => herdr.agents,
    herdr: () => ({ agents: herdr.agents, available: true }),
    credentials: () => inspectProfileAccounts(config, 'worker', config.workers, Object.fromEntries(config.workers.map(profile => [profile.name, { available: true, reason: null as string | null }])), { quota: false, now, cacheMs: 0 }),
    snapshot: async () => { const snapshot = await ok(coordinator, 'GET', 'work-snapshot'); return { work: snapshot.work as Work[], now: new Date(Date.parse(snapshot.now) + clock.skewMs).toISOString() }; },
    closeSession: pane => { herdr.agents = herdr.agents.filter(agent => agent.pane_id !== pane); },
    dispatch: async (work, profile) => {
      const selected = await selectAccount(config, 'worker', profile, { quota: false, now, cacheMs: 0, work: work.key });
      const claimed = await ok(workerA, 'POST', `work/${work.id}/claim`, {}) as Work;
      await ok(workerA, 'POST', `work/${work.id}/workspace`, { epoch: claimed.epoch, host: 'loop-host', path: worktrees[claimed.epoch - 1], branch: `graphyard/${claimed.key.toLowerCase()}-${claimed.epoch}` });
      await ok(workerA, 'POST', `work/${work.id}/quarantine`, { epoch: claimed.epoch, settlementHash: createHash('sha256').update(settlementToken).digest('hex'), scope: { unit: `graphyard-watch-4242-${randomUUID()}.scope`, pid: 4242 } });
      herdr.agents.push({ name: profile.agentName, pane_id: `pane-${profile.name}-${calls.dispatch.length}`, agent_status: 'working' });
      calls.dispatch.push({ work: work.key, profile: profile.name, account: selected.account?.name ?? null });
    },
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'no deployment endpoint in this test', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    sessionOutput: agent => herdr.output[agent.name!] ?? '',
    answerSession: (_agent, keys) => { calls.keys.push(keys); },
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
  const port = Number(process.env.GRAPHYARD_RUNTIME_LIMIT_MENU_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1566);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('runtime-limit-menu-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('limit_menu_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/limit_menu_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  home = await temporaryDirectory('runtime-limit-menu-home');
  for (const account of ['env-a', 'env-b']) {
    await mkdir(join(home, account), { recursive: true });
    await writeFile(join(home, account, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'not-a-real-token', refreshToken: 'not-a-real-token' } }));
  }
  // Each attempt's own worktree, with one commit the failover may build on.
  worktrees = [];
  for (const epoch of [1, 2]) {
    const worktree = await temporaryDirectory(`runtime-limit-menu-worktree-${epoch}`);
    git(worktree, 'init', '-q', '-b', 'graphyard/attempt'); await writeFile(join(worktree, 'README.md'), 'base\n');
    git(worktree, 'add', '-A'); git(worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
    worktrees.push(worktree);
  }
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:blocked-limit-menu-fails-over — a worker blocked on the usage-limit menu is ended, its account held until the parsed reset, and its item redispatched to a healthy account by the loop alone', async () => {
  const config = masterConfigSchema.parse({
    version: 1, url, credentialFile: join(home, 'coordinator.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
    repository, baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-limit-menu',
    workers: [{ name: 'builder', principal: workerA.id, agentName: 'agent-builder', mode: 'launch', kind: 'claude', credentialFile: join(home, 'builder.token'), accounts: ['env-a', 'env-b'] }],
    environments: [{ name: 'env-a', kind: 'claude', home: join(home, 'env-a') }, { name: 'env-b', kind: 'claude', home: join(home, 'env-b') }],
  }) as MasterConfig;
  const herdr: Herdr = { agents: [], output: {} }, clock = { skewMs: 0 };
  const { calls, cycle } = loop(config, herdr, clock);
  let work = await ok(operator, 'POST', 'work', { title: 'limit menu', plannedFiles: ['src/limit-menu.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }] }) as Work;
  work = await ok(operator, 'POST', `work/${work.id}/ready`, {}) as Work;

  // The loop's host is not in the notice's zone: the reset is read in the zone the notice names.
  const zone = process.env.TZ;
  process.env.TZ = 'Asia/Kolkata';
  try {
    const state = emptyDaemonState(config);
    await cycle(state);
    assert.deepEqual(calls.dispatch, [{ work: work.key, profile: 'builder', account: 'env-a' }], 'the attempt runs on the first account');

    // Blocked on the agent's own prose about a quota (GY-402): not the provider, so no failover.
    herdr.agents[0].agent_status = 'blocked';
    herdr.output['agent-builder'] = '● Update(src/limit-menu.ts)\n  ⎿ tmp disk quota is exhausted (a known local issue). Clearing the tsx cache, then rerunning.\n';
    clock.skewMs += 20_000;
    await cycle(state);
    assert.equal(state.actions[failoverKey('worker', work, 1)], undefined, 'the agent\'s prose about a quota fails nothing over');
    work = await reload(work.id);
    assert.equal(work.lease?.epoch, 1, 'the attempt is still live');
    assert.deepEqual(Object.keys(await observedExhaustions(config)), [], 'no account is held on prose');

    // Blocked on Claude's usage-limit menu: the session is ended, never answered, in this one cycle.
    herdr.output['agent-builder'] = limitMenu;
    clock.skewMs += 20_000;
    await cycle(state);
    const failover = state.actions[failoverKey('worker', work, 1)];
    assert.equal(failover?.state, 'done', failover?.detail);
    assert.match(failover.detail, /exhausted env-a mid-session \(You've hit your weekly limit/);
    assert.deepEqual(calls.keys, [], 'the loop never chooses on the menu, least of all "Switch to usage credits"');
    assert.deepEqual(calls.stopped, [`${work.key}:1`], 'the session\'s supervisor is stopped');
    work = await reload(work.id);
    assert.equal(work.lease, null, 'the lease is released');
    assert.equal(work.pipeline!.attempts[0].end, 'released');
    const exhaustion = work.capacity!.exhaustions[0];
    assert.equal(exhaustion.account, 'env-a');
    assert.equal(exhaustion.reason, notice);
    assert.ok(exhaustion.resetsAt && Date.parse(exhaustion.resetsAt) > Date.now(), 'the reset is parsed from the notice');
    assert.equal(new Date(exhaustion.resetsAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric' }), 'Oct 10, 10 PM', 'read in the zone the notice names');
    assert.equal((await observedExhaustions(config))['env-a']?.until, exhaustion.resetsAt, 'the spent account is held until it resets');

    // The next cycle redispatches the item onto the healthy account, with no master action.
    clock.skewMs += 20_000;
    await cycle(state);
    assert.deepEqual(calls.dispatch.at(-1), { work: work.key, profile: 'builder', account: 'env-b' });
    assert.equal((await reload(work.id)).lease?.epoch, 2);
  } finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; }
});
