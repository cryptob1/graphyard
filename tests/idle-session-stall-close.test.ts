import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { accountHeldForRole } from '../src/model/capacity.js';
import { assertDispatchable, masterConfigSchema, observedExhaustions, recordObservedExhaustion, selectAccount, type MasterConfig } from '../src/master.js';
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
  const filed = await ok(operator, 'POST', 'work', { title, type: 'chore', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:idle-session-after-reprompt-is-ended'] }] }) as Work;
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

test('unit:limit-notice-ends-attempt-at-once — the close step ends a stopped session whose pane carries \'You\'ve reached your Fable limit\' at once as a limit, with the lease released, the item dispatchable, and the account excluded from the dispatch', async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  const now = Date.now(), clock = now + 60_000, iso = (at: number) => new Date(at).toISOString();
  // Inside the inactivity window with no re-prompt on record: only the notice can end it, and it does, this same cycle.
  const limited = await item('GY-48', 'Stopped on its Fable limit');
  const busy = await item('GY-49', 'Working with a notice behind it');
  for (const { filed, session } of [limited, busy]) await ok(workerA, 'POST', `work/${filed.id}/session`, session);

  const root = await temporaryDirectory('fable-limit-hold');
  const credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, 't'.repeat(40), { mode: 0o600 });
  for (const name of ['claude-c', 'claude-d']) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'x' } }));
  }
  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile, cliPath: '/bin/graphyard',
    repository, baseBranch: 'main', githubAppId: 1234, hostId: 'loop-host', masterAgentName: 'graphyard-master-fable', workers: [],
    environments: [{ name: 'claude-c', kind: 'claude', home: join(root, 'claude-c') }, { name: 'claude-d', kind: 'claude', home: join(root, 'claude-d') }],
  }) as MasterConfig;
  const fable = 'You\'ve reached your Fable limit. Run /usage-credits to continue or switch models with /model.';
  const herdr = [
    { name: 'agent-gy-48', pane_id: 'pane-gy-48', agent_status: 'idle' },
    { name: 'agent-gy-49', pane_id: 'pane-gy-49', agent_status: 'working' },
  ];
  const state: DaemonState = emptyDaemonState(config);
  const screens: Record<string, string> = {
    'pane-gy-48': `● Editing tests/parser.test.ts\n  ⎿ Edited 2 lines\n\n${fable}\n`,
    'pane-gy-49': `${fable}\n`,
  };
  const closed: string[] = [], prompts: string[] = [], reads: string[] = [], stalls: { key: string; reason: string; resetsAt: string | null }[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => {
      const response = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${token(coordinator)}`, 'X-Graphyard-View': 'coordination' } });
      assert.equal(response.status, 200);
      const snap = await response.json() as { work: Work[] };
      return { work: snap.work, now: iso(clock) };
    },
    agents: () => herdr as any, herdr: async () => ({ agents: herdr as any[], available: true }),
    credentials: async () => ({}),
    dispatch: async () => { throw new Error('the fixture launches nothing'); },
    closeSession: pane => { closed.push(pane); },
    recordSession: async (target, handle) => { await ok(coordinator, 'POST', `work/${target.id}/session`, handle); },
    promptSession: async session => { prompts.push(session.pane ?? ''); },
    sessionScreen: session => { reads.push(session.pane ?? ''); return screens[session.pane ?? ''] ?? null; },
    // The production end holds the account the notice spent and records the limit on the item.
    endStall: async (target, session, stall) => {
      const reason = `${stall.reason} on its provider's limit notice: ${stall.notice?.reason ?? ''}`.slice(0, 500);
      stalls.push({ key: target.key, reason, resetsAt: stall.notice?.resetsAt ?? null });
      await recordObservedExhaustion(config, 'claude-c', { at: iso(clock), resetsAt: stall.notice?.resetsAt ?? null, reason, role: 'worker', profile: 'builder', work: target.key }, clock);
      await ok(coordinator, 'POST', `work/${target.id}/capacity`, {
        event: 'exhausted', role: 'worker', epoch: session.epoch, profile: 'builder', account: 'claude-c', runtime: session.runtime,
        reason, resetsAt: stall.notice?.resetsAt ?? null,
        partialWork: { state: 'not-applicable', detail: 'the stalled attempt left its worktree as it stood; the redispatch starts from the shared base' },
      });
    },
    persist: async () => {},
  };

  await runCycle(config, state, effects, () => clock, undefined, line => console.error(`[cycle] ${line}`));

  // Ended at once: one cycle, no re-prompt, no window waited, the pane closed.
  assert.ok(!prompts.includes('pane-gy-48'), 'no re-prompt is sent — the notice ends the attempt at once');
  assert.ok(closed.includes('pane-gy-48'), 'the pane is closed');
  const after = await reload(limited.filed.id);
  assert.equal(after.lease, null, 'the lease is released');
  assert.equal(after.pipeline?.attempts?.[0]?.end, 'released', 'the attempt ended, not left open');
  const limit = after.capacity?.exhaustions?.[0];
  assert.equal(limit?.cause ?? 'quota', 'quota', 'the end is a limit end, not an interruption');
  assert.match(limit?.reason ?? '', /stopped on its provider's limit notice: You've reached your Fable limit/, 'the notice is the reason');
  // The hold is the Fable wording's default: the next 08:00 local after the notice.
  const local = new Date(clock);
  const at = (day: number) => new Date(local.getFullYear(), local.getMonth(), day, 8).getTime();
  const nextEight = new Date(at(local.getDate()) > clock ? at(local.getDate()) : at(local.getDate() + 1)).toISOString();
  assert.equal(stalls.find(stall => stall.key === limited.filed.key)?.resetsAt, nextEight);
  assert.equal(limit?.resetsAt, nextEight, "the notice's reset is on the record");
  assert.equal(after.sessions?.at(-1)?.state, 'finished');
  assert.match(after.sessions?.at(-1)?.outcome ?? '', /Fable limit/);
  const allAfter = await store.list();
  assert.doesNotThrow(() => assertDispatchable(after, allAfter, iso(clock)), 'the item is dispatchable again');

  // The account the notice spent is excluded from that dispatch: held for its reset, the profile's
  // next selection fails over to the healthy account and refuses the held one outright.
  const held = await observedExhaustions(config, clock);
  assert.equal(accountHeldForRole(held, 'claude-c', clock), true, 'the account is held');
  assert.equal(accountHeldForRole(held, 'claude-d', clock), false);
  const profile = { name: 'builder', principal: 'worker-a', agentName: 'agent-builder', mode: 'launch', kind: 'claude', accounts: ['claude-c', 'claude-d'] } as any;
  const chosen = await selectAccount(config, 'worker', profile, { quota: false, now: () => clock, cacheMs: 0, work: 'GY-48' });
  assert.equal(chosen.account?.name, 'claude-d', 'the dispatch excludes the held account');
  await assert.rejects(selectAccount(config, 'worker', { ...profile, accounts: ['claude-c'] }, { quota: false, now: () => clock, cacheMs: 0, work: 'GY-48' }), /exhausted its quota mid-session/, 'a profile with only the held account waits for its reset');

  // A session Herdr still reports working is left alone, whatever its pane shows.
  assert.ok(!reads.includes('pane-gy-49'), 'a working session\'s pane is not judged');
  const busyAfter = await reload(busy.filed.id);
  assert.ok(busyAfter.lease, 'the working session keeps its lease');
  assert.ok(!stalls.some(stall => stall.key === busy.filed.key));
  assert.ok(!closed.includes('pane-gy-49'));
});
