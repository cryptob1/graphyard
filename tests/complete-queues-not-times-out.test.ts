import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { createContext } from '../src/cli/context.js';
import { completeCommand } from '../src/cli/complete.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { workerVerificationPump } from '../src/daemon/worker-verification.js';
import { verificationQueue } from '../src/server/worker-verification-queue.js';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { daemonEffects, type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master.js';
import type { WorkerVerificationResult } from '../src/cli/worker-verification.js';
import type { WorkerVerificationInput } from '../src/merge-writer/worker-verification.js';
import type { Principal, Work } from '../src/model.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3537: a worker's complete whose verification still waited for a heavy-job slot when its
// request's time ran out failed "Host worker verification timed out", and the worker blocked:
// finished, correct work sat blocked for hours until someone noticed. Here every slot is held past
// the request's bound (shortened to 1 s): complete returns queued with no blocker, and once a slot
// frees the loop runs that verification and submits the head, with no master action and no second
// complete.
const proof = 'integration:complete-queues-not-times-out';

test(`${proof} — with every slot held, complete returns queued without a blocker; when a slot frees the loop submits the head`, { timeout: 120_000 }, async t => {
  const base = await realpath(await temporaryDirectory('complete-queues', process.cwd()));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  const origin = join(base, 'origin.git'), checkout = join(base, 'checkout'), worktree = join(checkout, '.graphyard', 'worktrees', 'GY-1-1');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  await writeFile(join(checkout, 'README.md'), '# Fixture\n'); git(checkout, 'add', 'README.md'); git(checkout, 'commit', '-q', '-m', 'base');
  git(checkout, 'push', '-q', 'origin', 'HEAD:main'); git(checkout, 'fetch', '-q', 'origin');
  git(checkout, 'worktree', 'add', '-q', '-b', 'graphyard/gy-1-1', worktree);
  await writeFile(join(checkout, '.git', 'info', 'exclude'), '.graphyard/\n');
  // A store change is sensitive, so the submitted head owes review next.
  await mkdir(join(worktree, 'src', 'store'), { recursive: true });
  await writeFile(join(worktree, 'src', 'store', 'queued.ts'), 'export const queued = 1;\n'); git(worktree, 'add', 'src/store/queued.ts'); git(worktree, 'commit', '-q', '-m', 'change');
  const head = git(worktree, 'rev-parse', 'HEAD');

  const store = await withDatabase('complete-queues-not-times-out');
  await store.init(); t.after(() => store.close());
  const engine = new Engine(store, 600, 'owner/project');
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  const operator: Principal = { id: 'operator', role: 'admin' };
  const worker = { id: 'worker', role: 'worker' as const, token: 'worker-' + 'w'.repeat(32) };
  const coordinator = { id: 'host', role: 'coordinator' as const, token: 'host-' + 'h'.repeat(32) };
  engine.principals = [operator, worker, coordinator];
  let work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Queues for verification', criteria: [{ id: 'AC-1', text: 'Queues', proofs: [proof, 'e2e:complete-queues-not-times-out'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'test', path: worktree, branch: 'graphyard/gy-1-1' }, randomUUID());
  const http = server(engine, [worker, coordinator]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); return new Promise<void>(resolve => http.close(() => resolve())); });
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const mutate = async (path: string, body: unknown) => (await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${coordinator.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) })).json();

  // Every host slot is held: each verification says it waits, and starts only once `free` is called.
  let free!: () => void;
  const slot = new Promise<void>(resolve => { free = resolve; });
  let ran = 0;
  const verify = async (_root: string, item: Work, input: WorkerVerificationInput, _base: string, _parent?: string, progress: (line: string) => void = () => {}): Promise<WorkerVerificationResult> => {
    progress(`graphyard: worker verification ${item.key} waits for a host heavy-job slot: every Graphyard project on this host shares 1 at once`);
    await slot;
    ran++;
    return { record: { key: item.key, head: input.head, clean: true, at: new Date().toISOString(), ran: [{ proof, criteria: ['AC-1'], result: 'pass', executed: 1, failed: 0, skipped: 0, files: ['tests/complete-queues-not-times-out.test.ts'] }], outstanding: [] }, rerun: { flaked: [], baseFailures: [] } } as never;
  };
  const pump = workerVerificationPump(checkout, () => 'test', mutate, () => 'main', undefined, verify);
  const wait = verificationQueue.waitMs;
  verificationQueue.waitMs = 1_000;
  t.after(() => { verificationQueue.waitMs = wait; free(); });

  const shown: string[] = [];
  t.mock.method(console, 'error', (line: unknown) => { shown.push(String(line)); });
  const saved = { url: process.env.GRAPHYARD_URL, token: process.env.GRAPHYARD_TOKEN, file: process.env.GRAPHYARD_TOKEN_FILE };
  process.env.GRAPHYARD_URL = url; process.env.GRAPHYARD_TOKEN = worker.token; delete process.env.GRAPHYARD_TOKEN_FILE;
  const printed: any[] = [];
  try {
    const context = await createContext('complete', work.key, ['1', '--head', head], false);
    context.repositoryRoot = () => worktree;
    context.print = value => { printed.push(value); };
    const completed = completeCommand.run(context, work).then(() => null, (error: unknown) => error);
    for (let tries = 0; tries < 40; tries++) { await pump(); await new Promise(resolve => setTimeout(resolve, 50)); }
    const failed = await completed;
    assert.equal(failed, null, `complete succeeds while its verification still waits for a slot: ${String(failed)}`);
  } finally {
    process.env.GRAPHYARD_URL = saved.url; process.env.GRAPHYARD_TOKEN = saved.token;
    if (saved.file !== undefined) process.env.GRAPHYARD_TOKEN_FILE = saved.file;
    if (saved.url === undefined) delete process.env.GRAPHYARD_URL;
    if (saved.token === undefined) delete process.env.GRAPHYARD_TOKEN;
  }
  assert.deepEqual(printed, ['queued for verification; the loop submits it'], 'one plain line');
  assert.equal(ran, 0, 'nothing has verified yet');
  const readWork = async () => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [work.id])).rows[0].document as Work;
  const queued = await readWork();
  assert.equal(queued.blocker, null, 'no blocker');
  assert.equal(queued.lease, null, 'the worker\'s attempt ended');
  assert.equal(queued.submission, null, 'not submitted before it is verified');
  assert.equal(queued.finishedBlockerHead?.head, head, 'the head is recorded as finished and queued');

  // A slot frees: the loop runs the verification and submits the head. No unblock, no second complete.
  free();
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/project',
    credentialFile: join(base, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test', baseBranch: 'main', githubAppId: 1234, masterAgentName: 'master',
    workers: [{ name: 'worker-1', principal: 'graphyard-worker-1', agentName: 'gy-worker-1', mode: 'launch', kind: 'codex', credentialFile: join(base, 'worker-1.token') }],
    run: { masterHeartbeatMinutes: 240 } });
  const asLoop = async (path: string, data: unknown) => { const [, id, command] = path.split('/'); return engine.execute(coordinator, command as never, id, data, randomUUID()); };
  const production = daemonEffects(checkout, () => config, { snapshot: async () => ({ work: [queued], now: new Date().toISOString() }), mutate: asLoop, verify });
  const launches: string[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [queued], now: new Date().toISOString() }),
    agents: () => [], credentials: async () => ({}), closeSession: () => {},
    dispatch: async (item: Work) => { launches.push(item.key); },
    persist: async () => {},
    resubmit: production.resubmit!,
  };
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects, () => Date.now());
  for (let waited = 0; (await readWork()).submission === null; waited += 50) {
    assert.ok(waited < 15_000, 'the loop submits the queued head');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const submitted = await readWork();
  assert.deepEqual(launches, [], 'no worker launch');
  assert.equal(submitted.candidate?.sha, head, 'the queued head is the candidate');
  assert.equal(submitted.candidate?.author, 'worker');
  assert.equal(submitted.finishedBlockerHead, null);
  assert.equal(submitted.blocker, null);
  assert.equal(submitted.stage, 'review');
  const kinds = (await store.pool.query('SELECT kind FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows.map(row => row.kind);
  assert.ok(!kinds.includes('blocked'), `no blocker in the item's history: ${kinds.join(', ')}`);
  assert.equal(kinds.filter(kind => kind === 'submit').length, 0, 'the worker sent no second request');
});
