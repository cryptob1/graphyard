import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { observeSessions, reportedHandle } from '../src/model/session-state.js';
import { daemonEffects } from '../src/daemon/effects-production.js';
import { readRegistry } from '../src/agent-registry.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { assertDispatchable } from '../src/master/dispatch.js';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Every fixture item carries an E2E proof and declares the serve its trial needs.
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3074: this proof drives observation mutations before each close cycle. The
// older stall fixtures start from hand-built idle snapshots and cannot reproduce
// liveness refreshes moving the inactivity window.

const repository = 'owner/idle-stall';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, workerA].map(principal => ({ ...principal, token: `${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

let store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

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
  const filed = await ok(operator, 'POST', 'work', { title, type: 'chore', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:idle-session-after-reprompt-is-ended', 'e2e:fixture'] }] }) as Work;
  await ok(operator, 'POST', `work/${filed.id}/ready`, {});
  const claimed = await ok(workerA, 'POST', `work/${filed.id}/claim`, {}) as Work;
  return { filed: claimed, session: { id: `worker-a:1`, kind: 'implementation' as const, principal: workerA.id, epoch: claimed.epoch, runtime: 'pi', host: 'loop-host', pane: `pane-${key.toLowerCase()}`, agentName: `agent-${key.toLowerCase()}`, subject: `${key}: ${title}`, state: 'running' as const } };
};

before(async () => {
  store = await withDatabase('idle-session-observations');
  await store.init();
  // A two-hour lease keeps every fixture lease live under the clock, which runs 45 minutes ahead.
  engine = new Engine(store, 7200, repository);
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); });

test('unit:idle-session-after-reprompt-is-ended — real observations preserve both idle windows, progress prevents closure, and stall recovery keeps the commit and frees the registry slot', async t => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  const start = Date.now(), minute = 60_000;
  let clock = start, available = true;
  const iso = () => new Date(clock).toISOString();
  const transaction = store.transaction.bind(store);
  t.mock.method(store, 'transaction', ((fn: (db: never, now: Date) => Promise<never>, options?: never) =>
    transaction(db => fn(db as never, new Date(clock)), options)) as typeof store.transaction);
  const stalled = await item('GY-61', 'Observed idle');
  const active = await item('GY-62', 'Making progress');
  const busy = await item('GY-63', 'Still working');
  for (const fixture of [stalled, active, busy]) await ok(workerA, 'POST', `work/${fixture.filed.id}/session`, fixture.session);
  const root = await temporaryDirectory('observed-idle-work');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const branch = `graphyard/${stalled.filed.key.toLowerCase()}-1`;
  git('init', '-q', '-b', branch);
  await writeFile(join(root, 'work.txt'), 'committed implementation');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Work to preserve');
  const head = git('rev-parse', 'HEAD');
  await ok(workerA, 'POST', `work/${stalled.filed.id}/workspace`, { epoch: 1, host: 'loop-host', path: root, branch });
  const activeRoot = await temporaryDirectory('observed-active-work');
  execFileSync('git', ['clone', '-q', root, activeRoot]);
  const activeBranch = `graphyard/${active.filed.key.toLowerCase()}-1`;
  execFileSync('git', ['-C', activeRoot, 'checkout', '-qb', activeBranch]);
  await ok(workerA, 'POST', `work/${active.filed.id}/workspace`, { epoch: 1, host: 'loop-host', path: activeRoot, branch: activeBranch });

  // A real registry slot follows the lease, and is settled by the ordinary registry read.
  await ok(operator, 'POST', 'agent-registry/runtimes', { runtime: proposedRuntimes.find(runtime => runtime.name === 'claude'), reason: 'fixture' });
  await ok(operator, 'POST', 'agent-registry/models', { model: { name: 'fixture' }, reason: 'fixture' });
  await ok(operator, 'POST', 'agent-registry/accounts', { account: { name: 'fixture', runtime: 'claude', model: 'fixture', credential: { host: 'loop-host', home: root } }, reason: 'fixture' });
  await ok(operator, 'POST', 'agent-registry/roles', { role: { name: 'worker', accounts: ['fixture'], concurrency: 1 }, reason: 'fixture' });
  const selection = await ok(coordinator, 'POST', 'agent-registry/select', { role: 'worker', host: 'loop-host', work: stalled.filed.key, principal: workerA.id, observations: [] });
  assert.equal(selection.selected, true);
  const registry = await readRegistry(store.pool);
  registry.sessions.at(-1)!.selectedAt = new Date(start - 10 * minute).toISOString();
  await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [operator.id, 'agent-registry.fixture', JSON.stringify({ change: {}, registry })]);

  const config = masterConfigSchema.parse({ version: 1, url, credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository, baseBranch: 'main', githubAppId: 1234, hostId: 'loop-host', masterAgentName: 'master-observed-idle', workers: [], run: { inactivityMinutes: 10 } }) as MasterConfig;
  const state = emptyDaemonState(config), prompts: string[] = [], closed: string[] = [];
  const agents = [stalled, active, busy].map(fixture => ({ name: fixture.session.agentName, pane_id: fixture.session.pane, agent_status: fixture === busy ? 'working' : 'idle' }));
  const snapshot = async () => ({ work: await store.list(), now: iso() });
  const production = daemonEffects(root, config, { snapshot, mutate: (path, body) => ok(coordinator, 'POST', path, body) });
  let dirty: string | null = null;
  const effects: DaemonEffects = {
    snapshot, agents: () => available ? agents : [], herdr: () => ({ agents: available ? agents : [], available }), credentials: async () => ({}),
    dispatch: async () => { throw new Error('fixture launches nothing'); }, persist: async () => {},
    closeSession: pane => { closed.push(pane); }, promptSession: async session => { prompts.push(session.id + ':' + session.pane); },
    sessionScreen: () => available ? null : "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.",
    recordSession: production.recordSession, endStall: production.endStall,
    // Enable the real worktree progress step, without reaching the two-hour attempt bound.
    endAttemptBound: async () => { throw new Error('not at attempt bound'); },
    worktreeState: () => ({ head, dirty }),
  };
  const cycle = async (minutes: number) => {
    clock = start + minutes * minute;
    const report = observeSessions(await store.list(), available ? agents : null, new Date(clock), { hostId: 'loop-host', refreshMs: 0 });
    for (const entry of report.entries.filter(entry => entry.changed)) await ok(coordinator, 'POST', `work/${entry.workId}/session`, reportedHandle(entry));
    await runCycle(config, state, effects, () => clock);
  };
  const count = (fixture: typeof stalled) => prompts.filter(prompt => prompt.endsWith(':' + fixture.session.pane)).length;
  for (let at = 0; at <= 10; at++) await cycle(at);
  assert.equal(count(stalled), 1, 'repeated observations do not postpone the first prompt');
  assert.equal(count(active), 1);
  assert.equal(count(busy), 0);
  const observed = (await reload(stalled.filed.id)).sessions![0];
  assert.equal(observed.updatedAt, new Date(start).toISOString());
  assert.equal(observed.observedAt, iso());
  // A real session update after the reminder starts a new inactivity window.
  clock = start + 15 * minute;
  await ok(workerA, 'POST', `work/${active.filed.id}/session`, { ...active.session, head });
  for (let at = 15; at <= 18; at++) await cycle(at);
  available = false;
  await cycle(19);
  assert.equal(closed.length, 0, 'unavailable inventory is not evidence of an idle or stopped runtime');
  available = true;
  await cycle(20);
  const ended = await reload(stalled.filed.id);
  assert.equal(count(stalled), 1, 'the second window closes rather than sending another prompt');
  assert.equal(ended.lease, null);
  assert.equal(ended.sessions![0].state, 'finished');
  assert.match(ended.sessions![0].outcome!, /stalled: no activity after the re-prompt/);
  assert.ok(closed.includes(stalled.session.pane));
  assert.deepEqual(ended.capacity!.exhaustions[0].partialWork, { state: 'clean', commit: head, path: root, branch, detail: 'the worktree held no uncommitted change; every commit of the attempt is on its branch' });
  assert.equal(git('rev-parse', 'HEAD'), head);
  const all = await store.list();
  assert.doesNotThrow(() => assertDispatchable(ended, all, iso()));
  const settled = await ok(coordinator, 'GET', 'agent-registry/document');
  assert.ok(settled.sessions.at(-1).endedAt, 'the registry slot is released with the lease');
  assert.match(settled.sessions.at(-1).endReason, /implementation session finished/);
  assert.ok((await reload(active.filed.id)).lease, 'actual activity prevents closure after the old prompt');
  assert.ok((await reload(busy.filed.id)).lease, 'working sessions are left alone');
  // New worktree progress in the very cycle an idle window expires must count immediately.
  dirty = 'changed-files';
  await cycle(25);
  assert.equal(count(active), 1, 'same-cycle worktree progress prevents a false re-prompt');
  for (let at = 26; at <= 35; at++) await cycle(at);
  assert.equal(count(active), 2, 'a new quiet spell gets its own single reminder');
  for (let at = 36; at <= 45; at++) await cycle(at);
  assert.equal((await reload(active.filed.id)).lease, null);
  assert.equal(count(active), 2);
});
