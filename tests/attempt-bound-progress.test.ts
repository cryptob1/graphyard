import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, masterRunSchema, type MasterConfig } from '../src/master.js';
import { workerPrompt } from '../src/master/dispatch.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { defaultAttemptBoundMinutes, defaultAttemptCeilingMinutes } from '../src/master/attempt-bound.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2961: an attempt still making progress is not cut off at the fixed no-submission bound. The
// loop reads the attempt's worktree every cycle and records what changed there on the session
// handle, so a worktree showing a new commit (or changed files) inside the progress window keeps
// its attempt past the bound and is stopped only at the ceiling; one with neither is stopped at
// the bound, as the server's renewal refusal alone did. Each test is named for the proof it makes.

const repository = 'owner/attempt-bound';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, worker].map(principal => ({ ...principal, token: `${principal.id}-${'x'.repeat(32)}` }));
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

/** The item claimed so its lease is live across the whole fixture clock, with its session running. */
const item = async (key: string, title: string) => {
  const filed = await ok(operator, 'POST', 'work', { title, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:attempt-bound-extends-while-progressing'] }] }) as Work;
  await ok(operator, 'POST', `work/${filed.id}/ready`, {});
  const claimed = await ok(worker, 'POST', `work/${filed.id}/claim`, {}) as Work;
  await ok(worker, 'POST', `work/${filed.id}/workspace`, { epoch: claimed.epoch, host: 'loop-host', path: `/srv/worktrees/${key.toLowerCase()}-1`, branch: `graphyard/${key.toLowerCase()}-1` });
  await ok(worker, 'POST', `work/${filed.id}/session`, { id: `${worker.id}:1`, kind: 'implementation', principal: worker.id, epoch: claimed.epoch, runtime: 'claude', host: 'loop-host', pane: `pane-${key.toLowerCase()}`, subject: `${key}: ${title}`, state: 'running' });
  return claimed;
};

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2961;
  database = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('attempt-bound-db'), user: 'graphyard', password: 'testing-only', port, persistent: false,
    onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise(); await database.start(); await database.createDatabase('attempt_bound');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/attempt_bound`);
  await store.init();
  // An 11-hour lease keeps every fixture lease live under the clock, which runs nine hours ahead.
  engine = new Engine(store, 40_000, repository);
  engine.submissionObserver = null; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('unit:attempt-bound-extends-while-progressing — an attempt whose worktree commits every ten minutes runs past the bound and is stopped only at the ceiling; one with no commit or file change is stopped at the bound', async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  const now = Date.now(), minute = 60_000;
  const progressing = await item('GY-71', 'Commits every ten minutes');
  const idle = await item('GY-72', 'Idle from the claim');
  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository, baseBranch: 'main', githubAppId: 1234, hostId: 'loop-host', masterAgentName: 'graphyard-master-bound', workers: [],
  }) as MasterConfig;
  const herdr = [
    { name: 'worker-a', pane_id: 'pane-gy-71', agent_status: 'working' },
    { name: 'worker-a', pane_id: 'pane-gy-72', agent_status: 'working' },
  ];
  // The progressing worktree shows a new commit on every read; the idle one never changes.
  let commit = 0;
  const readings: Record<'progressing' | 'idle', { head: string | null; dirty: string | null }> = {
    progressing: { get head() { return (++commit).toString(16).padStart(7, '0'); }, dirty: null },
    idle: { head: '0000000', dirty: null },
  };
  const state: DaemonState = emptyDaemonState(config);
  let clockNow = now;
  const closed: string[] = [], stops: { key: string; why: string }[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => {
      const response = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${token(coordinator)}`, 'X-Graphyard-View': 'coordination' } });
      assert.equal(response.status, 200);
      const snap = await response.json() as { work: Work[] };
      return { work: snap.work, now: new Date(clockNow).toISOString() };
    },
    agents: () => herdr as any, herdr: () => ({ agents: herdr as any[], available: true }),
    credentials: async () => ({}),
    dispatch: async () => { throw new Error('the fixture launches nothing'); },
    closeSession: pane => { closed.push(pane); },
    recordSession: async (target, handle) => { await ok(coordinator, 'POST', `work/${target.id}/session`, handle); },
    worktreeState: space => ({ ...readings[space.path.includes('gy-71') ? 'progressing' : 'idle'] }),
    endAttemptBound: async (target, session, why) => {
      stops.push({ key: target.key, why });
      await ok(coordinator, 'POST', `work/${target.id}/capacity`, {
        event: 'exhausted', role: 'worker', epoch: session.epoch, cause: 'interrupted',
        profile: session.principal, account: null, runtime: session.runtime,
        reason: `stopped by the attempt bound: ${why}`.slice(0, 500), resetsAt: null,
        partialWork: { state: 'committed', commit: 'a'.repeat(40), detail: 'the uncommitted rest is kept for the successor' },
      });
      return { state: 'committed', commit: 'a'.repeat(40), detail: 'kept' };
    },
    persist: async () => {},
  };

  // Ten-minute cycles from the claim to half an hour past the eight-hour ceiling.
  for (let step = 1; step <= 51; step++) {
    clockNow = now + step * 10 * minute;
    await runCycle(config, state, effects, () => clockNow, undefined, () => {});

  }

  // The idle attempt was stopped once, at the bound (130 minutes), with its lease released.
  const idleAfter = await reload(idle.id);
  assert.equal(idleAfter.lease, null, 'the idle attempt\'s lease is released at the bound');
  assert.equal(idleAfter.pipeline?.attempts?.[0]?.end, 'released');
  const idleStop = stops.find(stop => stop.key === idle.key);
  assert.ok(idleStop, 'the idle attempt was stopped');
  assert.match(idleStop.why, /no commit and no file change for 20m past the 130m bound/);
  assert.equal(idleAfter.capacity?.exhaustions.at(-1)?.partialWork?.commit, 'a'.repeat(40), 'the idle stop keeps the uncommitted work for the successor');
  assert.equal(idleAfter.sessions?.find(entry => entry.id === `${worker.id}:1`)?.state, 'finished', 'the stopped session is recorded finished');

  // The progressing attempt ran past the bound and was stopped only at the ceiling.
  const progressingAfter = await reload(progressing.id);
  assert.equal(progressingAfter.lease, null, 'the progressing attempt\'s lease is released at the ceiling');
  const progressingStops = stops.filter(stop => stop.key === progressing.key);
  assert.equal(progressingStops.length, 1, 'the progressing attempt was stopped exactly once');
  assert.match(progressingStops[0]!.why, /8h ceiling/);
  assert.equal(progressingAfter.capacity?.exhaustions.length, 1);
  const handle = progressingAfter.sessions?.find(entry => entry.id === `${worker.id}:1`);
  assert.equal(handle?.state, 'finished');
  assert.match(handle?.outcome ?? '', /attempt bound/);
});

test('unit:brief-and-status-name-attempt-bound — the launch brief names the session\'s end instant and the handoff rule, and master status names a live attempt\'s remaining time', async () => {
  const now = Date.now(), claimedAt = new Date(now - 50 * 60_000).toISOString();
  const brief = workerPrompt(
    { cliPath: '/bin/graphyard', run: masterRunSchema.parse({}) },
    { key: 'GY-73', title: 'Names the bound', lastAssignment: { owner: 'worker-a', epoch: 1, claimedAt } },
    { principal: 'worker-a' }, 1);
  assert.ok(brief.includes(`Your session ends at ${new Date(now - 50 * 60_000 + defaultAttemptBoundMinutes * 60_000).toISOString()}`), 'the brief names the bound instant');
  assert.ok(brief.includes(`nothing runs past ${new Date(now - 50 * 60_000 + defaultAttemptCeilingMinutes * 60_000).toISOString()}`), 'the brief names the ceiling instant');
  assert.ok(brief.includes('commit forward often, and a successor receives your diff'), 'the brief names the handoff rule');
  // The install's own bound and ceiling are what the brief names.
  const tuned = workerPrompt(
    { cliPath: '/bin/graphyard', run: masterRunSchema.parse({ attemptBoundMinutes: 60, attemptCeilingMinutes: 1440 }) },
    { key: 'GY-73', title: 'Names the bound', lastAssignment: { owner: 'worker-a', epoch: 1, claimedAt } },
    { principal: 'worker-a' }, 1);
  assert.ok(tuned.includes(`Your session ends at ${new Date(now + 10 * 60_000).toISOString()}`), 'the configured bound is named');
  assert.ok(tuned.includes(`nothing runs past ${new Date(now + 1390 * 60_000).toISOString()}`), 'the configured ceiling is named');
  // No claim time on the record, no instant to name.
  const plain = workerPrompt({ cliPath: '/bin/graphyard' }, { key: 'GY-73', title: 'Names the bound' }, { principal: 'worker-a' }, 1);
  assert.ok(!plain.includes('Your session ends at'), 'a brief without a claim time names no instant');

  // Master status names the remaining time of a live attempt.
  const root = await temporaryDirectory('attempt-bound-status');
  const item = {
    id: 'work-73', key: 'GY-73', title: 'Names the bound', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:brief-and-status-name-attempt-bound'] }],
    policy: { checks: ['test'], review: true }, stage: 'build', revision: 3, policyRevision: 1,
    createdAt: claimedAt, updatedAt: claimedAt, stageEnteredAt: claimedAt, ready: true, epoch: 1,
    lease: { owner: 'worker-a', epoch: 1, expiresAt: new Date(now + 60 * 60_000).toISOString() },
    lastAssignment: { owner: 'worker-a', epoch: 1, claimedAt },
    workspaces: [{ host: 'loop-host', path: '/srv/worktrees/GY-73-1', epoch: 1, owner: 'worker-a', branch: 'graphyard/gy-73-1' }],
    sessions: [{ id: 'worker-a:1', kind: 'implementation', principal: 'worker-a', epoch: 1, runtime: 'claude', host: 'loop-host', pane: 'pane-73', subject: 'GY-73: Names the bound', state: 'running', startedAt: claimedAt, updatedAt: claimedAt, endedAt: null, outcome: null, agentName: null, role: null, head: null, workspace: null, tab: null, attach: null, transcript: null }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
  } as unknown as Work;
  const master = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository, baseBranch: 'main', githubAppId: 1234, hostId: 'loop-host', masterAgentName: 'graphyard-master-bound', workers: [],
  }) as MasterConfig;
  const report = await masterStatusReport(root, master, async () => ({ work: [item], now: new Date(now).toISOString() }), async () => { throw new Error('no git in the fixture'); });
  const attempt = report.sessions.find(session => session.id === 'worker-a:1')?.attempt;
  assert.ok(attempt, 'master status names a live attempt\'s bound');
  assert.equal(attempt.boundIn, '80m', 'the remaining time of the bound is named (130m bound, claimed 50m ago)');
  assert.equal(attempt.boundAt, new Date(now + 80 * 60_000).toISOString(), 'the bound falls at the claim plus the bound');
  assert.equal(attempt.ceilingIn, '430m', 'the remaining time of the ceiling is named (8h ceiling, claimed 50m ago)');
  assert.equal(attempt.ceilingAt, new Date(now + 430 * 60_000).toISOString());
  assert.equal(attempt.fresh, false, 'an attempt with no recorded progress reads as not extending');
});
