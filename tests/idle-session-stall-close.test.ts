import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { assertDispatchable, masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2943: a worker that stopped on its provider's rate limit sat at its prompt for over half an
// hour while the supervisor kept renewing its lease, so the item idled in build and eleven
// dependants waited on it. The loop's close step now re-prompts a session Herdr reports idle with
// no recorded activity for the inactivity window once, and ends one still idle a whole window
// after that re-prompt: the attempt ends as stalled, the lease is released, and the item is
// dispatchable again. A pane whose screen carries the provider's limit notice ends as stalled on
// that notice, with its reset on the record for the account hold.

const repository = 'owner/idle-stall';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, workerA].map(principal => ({ ...principal, token: `${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(principal, method, path, body);
  assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;

/** The item the fixture session runs, claimed so its lease is live across the whole fixture clock. */
const item = async (key: string, title: string) => {
  const filed = await ok(operator, 'POST', 'work', { title, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:idle-session-after-reprompt-is-ended'] }] }) as Work;
  await ok(operator, 'POST', `work/${filed.id}/ready`, {});
  const claimed = await ok(workerA, 'POST', `work/${filed.id}/claim`, {}) as Work;
  return { filed: claimed, session: { id: `worker-a:1`, kind: 'implementation' as const, principal: workerA.id, epoch: claimed.epoch, runtime: 'pi', host: 'loop-host', pane: `pane-${key.toLowerCase()}`, agentName: `agent-${key.toLowerCase()}`, subject: `${key}: ${title}`, state: 'running' as const } };
};

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2943;
  database = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('idle-stall-db'), user: 'graphyard', password: 'testing-only', port, persistent: false,
    onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise(); await database.start(); await database.createDatabase('idle_stall');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/idle_stall`);
  await store.init();
  // A two-hour lease keeps every fixture lease live under the clock, which runs 30 minutes ahead.
  engine = new Engine(store, 7200, repository);
  engine.submissionObserver = null; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:idle-session-after-reprompt-is-ended — the close step ends a session idle past the window after its re-prompt (stalled, lease released, item dispatchable), re-prompts one that has had no re-prompt, and leaves a session inside the window alone', async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  const now = Date.now(), window = 10 * 60_000, clock = now + 30 * 60_000, iso = (at: number) => new Date(at).toISOString();
  const stalled = await item('GY-31', 'Stalled after its re-prompt');
  const limited = await item('GY-32', 'Stalled on the provider limit notice');
  const inside = await item('GY-33', 'Idle inside the window');
  const quiet = await item('GY-34', 'Idle with no re-prompt yet');
  const busy = await item('GY-35', 'Working');
  for (const { filed, session } of [stalled, limited, inside, quiet, busy]) await ok(workerA, 'POST', `work/${filed.id}/session`, session);

  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository, baseBranch: 'main', githubAppId: 1234, hostId: 'loop-host', masterAgentName: 'graphyard-master-idle', workers: [],
  }) as MasterConfig;
  const herdr = [
    { name: 'agent-gy-31', pane_id: 'pane-gy-31', agent_status: 'idle' },
    { name: 'agent-gy-32', pane_id: 'pane-gy-32', agent_status: 'idle' },
    { name: 'agent-gy-33', pane_id: 'pane-gy-33', agent_status: 'idle' },
    { name: 'agent-gy-34', pane_id: 'pane-gy-34', agent_status: 'idle' },
    { name: 'agent-gy-35', pane_id: 'pane-gy-35', agent_status: 'working' },
  ];
  const state: DaemonState = emptyDaemonState(config);
  const reprompt = (item: { filed: Work }, minutesAgo: number) => {
    state.actions[`reprompt:${item.filed.id}:worker-a:1`] = { kind: 'wake', work: item.filed.key, principal: workerA.id, state: 'done', detail: 'fixture', attempts: 1, cycle: 0, epoch: null, at: iso(clock - minutesAgo * 60_000) };
  };
  reprompt(stalled, 15); reprompt(limited, 15); reprompt(inside, 2);

  const closed: string[] = [], prompts: { pane: string | null; text: string }[] = [], stalls: { key: string; reason: string; noticeResetsAt: string | null }[] = [];
  const screens: Record<string, string> = { 'pane-gy-32': 'Error: 429: {"code":"1302","message":"Rate limit reached for requests"}\nRetry failed after 3 attempts\n' };
  const effects: DaemonEffects = {
    snapshot: async () => {
      const response = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${token(coordinator)}`, 'X-Graphyard-View': 'coordination' } });
      assert.equal(response.status, 200);
      const snap = await response.json() as { work: Work[] };
      return { work: snap.work, now: iso(clock) };
    },
    agents: () => herdr as any, herdr: () => ({ agents: herdr as any[], available: true }),
    credentials: async () => ({}),
    dispatch: async () => { throw new Error('the fixture launches nothing'); },
    closeSession: pane => { closed.push(pane); },
    recordSession: async (target, handle) => { await ok(coordinator, 'POST', `work/${target.id}/session`, handle); },
    promptSession: async (session, text) => { prompts.push({ pane: session.pane, text }); },
    sessionScreen: session => screens[session.pane ?? ''] ?? null,
    endStall: async (target, session, stall) => {
      stalls.push({ key: target.key, reason: stall.reason, noticeResetsAt: stall.notice?.resetsAt ?? null });
      await ok(coordinator, 'POST', `work/${target.id}/capacity`, {
        event: 'exhausted', role: 'worker', epoch: session.epoch, ...(stall.notice ? {} : { cause: 'interrupted' }),
        profile: 'builder', account: null, runtime: session.runtime, reason: `${stall.reason}${stall.notice ? ` on its provider's limit notice: ${stall.notice.reason}` : ''}`.slice(0, 500),
        resetsAt: stall.notice?.resetsAt ?? null,
        partialWork: { state: 'not-applicable', detail: 'the stalled attempt left its worktree as it stood; the redispatch starts from the shared base' },
      });
    },
    persist: async () => {},
  };

  await runCycle(config, state, effects, () => clock, undefined, line => console.error(`[cycle] ${line}`));

  // Stalled past the window after its re-prompt: ended, lease released, dispatchable again.
  const stalledAfter = await reload(stalled.filed.id);
  assert.equal(stalledAfter.lease, null, 'the stalled attempt\'s lease is released');
  assert.equal(stalledAfter.capacity?.exhaustions?.[0]?.cause, 'interrupted');
  assert.match(stalledAfter.capacity?.exhaustions?.[0]?.reason ?? '', /^stalled: no activity after the re-prompt/);
  assert.equal(stalledAfter.pipeline?.attempts?.[0]?.end, 'released', 'the attempt ended as released, not left open');
  assert.equal(stalledAfter.sessions?.at(-1)?.state, 'finished');
  assert.match(stalledAfter.sessions?.at(-1)?.outcome ?? '', /^stalled: no activity after the re-prompt/);
  const allAfter = await store.list();
  assert.doesNotThrow(() => assertDispatchable(stalledAfter, allAfter, iso(clock)), 'the item is dispatchable again');
  assert.deepEqual(stalls.find(stall => stall.key === stalled.filed.key), { key: stalled.filed.key, reason: 'stalled: no activity after the re-prompt', noticeResetsAt: null });
  assert.ok(closed.includes('pane-gy-31'), 'the stalled session\'s pane is closed');

  // The pane whose screen carries the provider's limit notice ends as stalled on that notice.
  const limitedAfter = await reload(limited.filed.id);
  assert.equal(limitedAfter.lease, null);
  assert.equal(limitedAfter.capacity?.exhaustions?.[0]?.cause ?? 'quota', 'quota', 'the notice makes the end a quota exhaustion, not an interruption');
  assert.ok(Date.parse(limitedAfter.capacity?.exhaustions?.[0]?.resetsAt ?? '') >= clock + 15 * 60_000, 'the notice\'s default 15-minute reset is on the record');
  assert.doesNotThrow(() => assertDispatchable(limitedAfter, allAfter, iso(clock)));

  // Idle inside the window after its re-prompt: left alone, lease live, no pane closed.
  const insideAfter = await reload(inside.filed.id);
  assert.ok(insideAfter.lease && Date.parse(insideAfter.lease.expiresAt) > clock, 'the inside-window session keeps its lease');
  assert.equal(insideAfter.sessions?.at(-1)?.state, 'running');
  assert.ok(!stalls.some(stall => stall.key === inside.filed.key), 'no inside-window session is ended');
  assert.ok(!closed.includes('pane-gy-33'));

  // Idle with no re-prompt yet: the loop's single re-prompt goes out, the session is not ended.
  assert.equal(prompts.find(prompt => prompt.pane === 'pane-gy-34')?.text?.includes(quiet.filed.key), true, 'the quiet session is re-prompted with its own work');
  assert.ok(!stalls.some(stall => stall.key === quiet.filed.key));
  assert.equal(state.actions[`reprompt:${quiet.filed.id}:worker-a:1`]?.state, 'done', 'the re-prompt is recorded once');

  // A session Herdr reports working is never touched.
  assert.ok(!prompts.some(prompt => prompt.pane === 'pane-gy-35'));
  assert.ok(!stalls.some(stall => stall.key === busy.filed.key));
  assert.ok(!closed.includes('pane-gy-35'));
});
