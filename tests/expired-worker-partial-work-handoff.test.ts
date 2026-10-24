import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { daemonEffects, emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, workerPrompt, type MasterConfig } from '../src/master.js';
import { redispatchPreservesAttempt } from '../src/model/capacity.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2953: a supervisor's time bound or a worker's silence ends an attempt by its lapsed lease with
// nothing submitted, and the loop used to reconcile the lease and remove the worktree without ever
// putting the attempt's work on the record — the redispatch then started from the shared base and
// redid hours of work blind. The close step now keeps what the attempt had not committed as one WIP
// commit on its own branch and records the capacity exhaustion that ends the lease with that
// partial work, before any cleanup, so the next worker's handoff names the commit. The historical
// workspace reservation stays on the record; the old lease authority ends with the attempt.

const HOST = 'loop-host';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const workerB: Principal = { id: 'worker-b', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, workerA, workerB].map(principal => ({ ...principal, token: `${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, install: string;

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
const git = (args: string[], cwd = install) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 190;
  database = new EmbeddedPostgres({
    databaseDir: await temporaryDirectory('expired-work-db'), user: 'graphyard', password: 'testing-only', port, persistent: false,
    onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'],
  });
  await database.initialise(); await database.start(); await database.createDatabase('expired_work');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/expired_work`);
  await store.init();
  // A five-second lease is the attempt's own time bound: every expiry below is the bound, in real time.
  engine = new Engine(store, 5, 'owner/expired-work');
  engine.submissionObserver = null; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  install = await temporaryDirectory('expired-work-install');
  await writeFile(join(install, 'coordinator.token'), `${'c'.repeat(40)}\n`, { mode: 0o600 });
});

after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('integration:expired-worker-partial-work-handoff — a worker attempt ended by its lease bound with committed and uncommitted changes has both preserved on its branch and identified in the next worker\'s handoff before the worktree is cleaned, the old lease authority ended and the historical reservation retained', async () => {
  await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
  const filed = await ok(operator, 'POST', 'work', {
    title: 'Preserve a timed-out attempt\'s partial work',
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:expired-worker-partial-work-handoff'] }],
  }) as Work;
  await ok(operator, 'POST', `work/${filed.id}/ready`, {});

  // The attempt's worktree: a real worktree of the shared repository, holding one committed
  // change and, on top of it, one modified and one untracked file the attempt never committed.
  const branch = `graphyard/${filed.key.toLowerCase()}-1`;
  const worktree = join(install, '.graphyard', 'worktrees', `${filed.key.toLowerCase()}-1`);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'fixture@graphyard.invalid']);
  git(['config', 'user.name', 'Graphyard Fixture']);
  await writeFile(join(install, 'README.md'), 'shared base\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  await mkdir(dirname(worktree), { recursive: true });
  git(['worktree', 'add', '-b', branch, worktree]);
  await writeFile(join(worktree, 'diagnostics.ts'), 'export const finding = "soak thresholds tracked for two hours";\n');
  git(['add', 'diagnostics.ts'], worktree);
  git(['commit', '-q', '-m', 'diagnostics so far'], worktree);
  await writeFile(join(worktree, 'diagnostics.ts'), 'export const finding = "soak thresholds tracked for two hours, and one more finding";\n');
  await writeFile(join(worktree, 'population.ts'), 'export const stage = 3;\n');

  // The attempt claims, registers its session and its workspace, and then its lease reaches its bound.
  const claimed = await ok(workerA, 'POST', `work/${filed.id}/claim`, {}) as Work;
  assert.equal(claimed.epoch, 1);
  await ok(workerA, 'POST', `work/${filed.id}/session`, { id: 'worker-a:1', kind: 'implementation', principal: workerA.id, epoch: claimed.epoch, runtime: 'codex', host: HOST, pane: 'pane-gy-90', agentName: 'agent-builder', subject: `${filed.key}: ${filed.title}`, state: 'running' });
  await ok(workerA, 'POST', `work/${filed.id}/workspace`, { epoch: claimed.epoch, host: HOST, path: worktree, branch });

  const config = masterConfigSchema.parse({
    version: 1, url, credentialFile: join(install, 'coordinator.token'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository: 'owner/expired-work', baseBranch: 'main', githubAppId: 1234, hostId: HOST, masterAgentName: 'graphyard-master-expired',
    workers: [{ name: 'builder', principal: workerB.id, agentName: 'agent-builder', mode: 'launch', kind: 'codex', credentialFile: join(install, 'builder.token'), agentArgs: [], approvals: 'auto', environment: {} }],
  }) as MasterConfig;

  // The loop's own effects, with only the world beyond the control plane replaced: Herdr is empty,
  // the dispatch is the next worker's claim, and the coordination read is the server's own clock.
  const closed: string[] = [], launched: { key: string; epoch: number }[] = [];
  const snapshot = async () => {
    const response = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${token(coordinator)}`, 'X-Graphyard-View': 'coordination' } });
    assert.equal(response.status, 200);
    const snap = await response.json() as { work: Work[]; now: string };
    return { work: snap.work, now: snap.now };
  };
  const mutate = async (path: string, data: unknown, requestId?: string) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token(coordinator)}`, 'Content-Type': 'application/json', 'Idempotency-Key': requestId ?? randomUUID() }, body: JSON.stringify(data) });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} refused (${response.status}): ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return undefined; }
  };
  const real = daemonEffects(install, config, { snapshot, mutate });
  const effects: DaemonEffects = {
    ...real,
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({ builder: { available: true, reason: null } }),
    closeSession: pane => { closed.push(pane); },
    dispatch: async work => {
      const next = await ok(workerB, 'POST', `work/${work.id}/claim`, {}) as Work;
      launched.push({ key: work.key, epoch: next.epoch });
      return { pane: null, epoch: next.epoch };
    },
    dispatchTick: async () => {}, sweepCheckouts: async () => {}, masterSession: undefined, mergeWriter: null,
  };
  const state: DaemonState = emptyDaemonState(config);

  // Reconciliation: the close step ends the bounded attempt — keeping its work before any cleanup —
  // and the dispatch step sends the item back out; the next worker claims epoch 2.
  await new Promise(resolve => setTimeout(resolve, 5_200));
  await runCycle(config, state, effects);
  const resumed = await reload(filed.id);

  // The attempt's work is on the record: one WIP commit on its own branch holds both the uncommitted
  // rest and the history the attempt had already committed.
  const exhaustion = resumed.capacity?.exhaustions?.[0];
  const wip = git(['rev-parse', 'HEAD'], worktree);
  assert.equal(exhaustion?.role, 'worker');
  assert.equal(exhaustion?.epoch, 1);
  assert.equal(exhaustion?.cause, 'interrupted');
  assert.equal(exhaustion?.owner, workerA.id);
  assert.equal(exhaustion?.partialWork.state, 'committed');
  assert.equal(exhaustion?.partialWork.commit, wip);
  assert.equal(exhaustion?.partialWork.branch, branch);
  assert.equal(exhaustion?.partialWork.path, worktree);
  assert.equal(git(['log', '--format=%s', branch]).split('\n').slice(0, 2).join('\n'), `WIP: ${filed.key} attempt 1 expired\ndiagnostics so far`);
  assert.match(git(['show', '--name-only', '--format=', wip]), /population\.ts/, 'the untracked file the attempt never committed is in the preserved commit');

  // The old lease authority ended with the attempt, released once, ready to be redispatched; the
  // open epoch-2 row beside it is the redispatch's own claim, landed in the same cycle.
  assert.deepEqual(resumed.pipeline?.attempts?.map(attempt => [attempt.epoch, attempt.end]), [[1, 'released'], [2, null]]);
  assert.ok(redispatchPreservesAttempt(resumed, 1).ok, 'the ended attempt is on the record exactly as the redispatch reads it');

  // And the redispatch happened: the next worker claimed epoch 2, and its handoff names the commit.
  assert.deepEqual(launched, [{ key: filed.key, epoch: 2 }]);
  const assigned = await reload(filed.id);
  assert.equal(assigned.epoch, 2);
  assert.equal(assigned.lease?.owner, workerB.id);
  const handoff = workerPrompt({ cliPath: config.cliPath }, assigned, { principal: workerB.id }, assigned.epoch);
  assert.match(handoff, /The previous attempt \(epoch 1\) was ended by its lapsed lease/);
  assert.match(handoff, new RegExp(`its work is kept as commit ${wip}`));
  assert.ok(handoff.includes(`on local branch ${branch}`));
  assert.ok(handoff.includes('cherry-pick or git merge instead of redoing it'));

  // The worktree still stands: the preservation happened before any cleanup.
  assert.ok(existsSync(worktree), 'the worktree stands until the cleanup cycle, which runs after the work was preserved');
  assert.equal(state.actions[`reclaim:lease:${filed.id}:1`]?.state, 'done');
  assert.match(state.actions[`reclaim:lease:${filed.id}:1`]?.detail ?? '', new RegExp(`commit ${wip.slice(0, 12)}`));
  assert.equal(state.actions[`close:${filed.id}:worker-a:1`]?.state, 'done', 'the ended session is closed on the record');

  // Cleanup: the next cycle removes the ended attempt's worktree — the preserved commit and the
  // historical reservation survive it.
  await runCycle(config, state, effects);
  const cleaned = await reload(filed.id);
  assert.equal(state.actions[`worktree:${filed.id}:1`]?.state, 'done');
  assert.ok(!existsSync(worktree), 'the ended attempt\'s worktree is cleaned only after its work was preserved');
  assert.equal(Date.parse(state.actions[`reclaim:lease:${filed.id}:1`].at) <= Date.parse(state.actions[`worktree:${filed.id}:1`].at), true, 'the preservation is recorded before the cleanup');
  assert.equal(git(['rev-parse', '--verify', branch]), wip, 'the preserved commit survives the worktree cleanup');
  assert.deepEqual(cleaned.workspaces?.map(space => [space.epoch, space.branch, space.host]), [[1, branch, HOST]], 'the historical workspace reservation stays on the record');
  assert.equal(cleaned.sessions?.find(handle => handle.id === 'worker-a:1')?.state, 'finished');
  assert.equal(cleaned.lease?.owner, workerB.id, 'the new attempt holds the lease the lapsed one left');
  assert.ok(closed.includes('pane-gy-90'), 'the ended session\'s pane was closed');
});
