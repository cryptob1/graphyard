import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { freePort } from '../src/cli/test-isolation.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { completeCommand } from '../src/cli/complete.js';
import type { CliContext } from '../src/cli/context.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema } from '../src/master.js';
import { acquireVerificationSlot, heldSlots, slotsDirectoryVariable, heldVariable } from '../src/master/verification-slots.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { mergeOne, runMergeTrial } from '../src/merge-writer/executor.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { verificationQueue } from '../src/server/worker-verification-queue.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

for (const proof of ['integration:drop-worker-host-verification', 'e2e:drop-worker-host-verification']) {
  test(`${proof} — complete submits with every slot held; master status records no worker verification and the merge trial refuses the failing head`, { timeout: 120_000 }, async t => {
    const root = await temporaryDirectory('drop-worker-host-verification');
    const checkout = join(root, 'checkout'), origin = join(root, 'origin.git'), slots = join(root, 'slots');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
    await writeFile(join(checkout, '.gitignore'), '.graphyard/\n');
    await writeFile(join(checkout, 'package.json'), JSON.stringify({ scripts: { build: 'node --eval 0', test: 'node --test --test-reporter=tap proof.cjs' } }));
    await writeFile(join(checkout, 'proof.cjs'), "const { test } = require('node:test'); test('unit:fixture', () => {});\n");
    const port = await freePort();
    await writeFile(join(checkout, 'serve.cjs'), `require('node:http').createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1');`);
    await writeFile(join(checkout, 'graphyard.json'), JSON.stringify({ e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'node serve.cjs', url: `http://127.0.0.1:${port}`, readySeconds: 1 } } }));
    await mkdir(join(checkout, 'e2e', 'cases'), { recursive: true });
    await writeFile(join(checkout, 'e2e/cases/fixture.json'), JSON.stringify({ id: 'fixture', title: 'Fixture', target: 'any', required: false, steps: [{ kind: 'command', name: 'fixture', run: 'true' }] }));
    git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'base'); git(checkout, 'push', '-q', 'origin', 'HEAD:main');
    const base = git(origin, 'rev-parse', 'main');
    const branch = 'graphyard/gy-1-1', worktree = join(root, 'worktree');
    git(checkout, 'worktree', 'add', '-qb', branch, worktree);
    await mkdir(join(worktree, 'src', 'store'), { recursive: true });
    await writeFile(join(worktree, 'src', 'store', 'change.ts'), 'export const changed = true;\n');
    await writeFile(join(worktree, 'proof.cjs'), "const { test } = require('node:test'); const assert = require('node:assert/strict'); test('unit:fixture', () => assert.fail('deliberate candidate failure'));\n");
    git(worktree, 'add', '.'); git(worktree, 'commit', '-qm', 'failing head');
    const head = git(worktree, 'rev-parse', 'HEAD');

    const store = await withDatabase('drop-worker-host-verification'); await store.init(); t.after(() => store.close());
    const engine = new Engine(store, 600, 'owner/project');
    engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
    const operator = { id: 'operator', role: 'admin' as const };
    const worker = { id: 'worker', role: 'worker' as const, token: 'worker-fixture-token' };
    const coordinator = { id: 'host', role: 'coordinator' as const, token: 'host-fixture-token' };
    engine.principals = [operator, worker, coordinator];
    let work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Submit without host verification', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:fixture', 'e2e:fixture'] }] }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'test', path: worktree, branch }, randomUUID());
    const http = server(engine, [worker, coordinator]);
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    t.after(() => { http.closeAllConnections(); return new Promise<void>(resolve => http.close(() => resolve())); });
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const api = async (path: string, body?: unknown, token = coordinator.token, requestId: string = randomUUID()) => {
      const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': requestId }, body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    };
    const config = masterConfigSchema.parse({ version: 1, repository: 'owner/project', baseBranch: 'main', url, credentialFile: '/unused', cliPath: '/unused', githubAppId: 1, hostId: 'test', masterAgentName: 'fixture', workers: [], run: { mergeWriter: { deployKeyFile: join(root, 'unused-key') } } });
    const status = () => masterStatusReport(root, config, path => api(path), async () => { throw new Error('no runtime in fixture'); });
    const previousSlots = process.env[slotsDirectoryVariable], previousHeld = process.env[heldVariable];
    process.env[slotsDirectoryVariable] = slots; delete process.env[heldVariable];
    t.after(() => {
      if (previousSlots === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previousSlots;
      if (previousHeld === undefined) delete process.env[heldVariable]; else process.env[heldVariable] = previousHeld;
    });
    const holders: Awaited<ReturnType<typeof acquireVerificationSlot>>[] = [];
    for (let n = 0; n < 3; n++) holders.push(await acquireVerificationSlot({ directory: slots, label: `occupied ${n}`, ...(n === 2 ? { reserved: true } : {}) }));
    t.after(() => { for (const holder of holders) holder.release(); });
    assert.equal(heldSlots(slots).length, 3, 'both ordinary slots and the reservation are held');
    // Bound the obsolete request on the base tip so this regression fails promptly, not in 55 minutes.
    const waitMs = verificationQueue.waitMs; verificationQueue.waitMs = 1_000;
    t.after(() => { verificationQueue.waitMs = waitMs; });
    const requests: string[] = [];
    const context = { args: ['1', '--head', head], repositoryRoot: () => worktree, print: () => {},
      api: (path: string, body: unknown, id: string) => { requests.push(path); return api(path, body, worker.token, id); },
    } as unknown as CliContext;
    await completeCommand.run(context, work);
    assert.deepEqual(requests, [`work/${work.id}/submit`], 'complete sends only the head; no host verification request');
    const submitted = (await store.workDocument(work.id))!;
    assert.equal(submitted.stage, 'review');
    assert.equal(submitted.candidate?.sha, head);
    assert.equal(submitted.lease, null);
    assert.equal(heldSlots(slots).length, 3, 'complete finished before any holder released its slot');
    assert.deepEqual((await status()).workerVerifications, []);
    assert.deepEqual(await api('worker-verifications/take', { host: 'test' }), []);
    assert.ok(!(await store.events(work.id)).some(event => event.kind === 'work.self-verified'));

    for (const holder of holders) holder.release();
    // Run the real merge trial and its real failing test. Only the container launcher is omitted:
    // this fixture tests submission and verdict handling, not the separately tested isolation boundary.
    const run: ChildRun = async (command, args, options) => {
      if (args.includes('/graphyard-harness/node_modules/tsx/dist/loader.mjs')) {
        const script = args.at(-1)!;
        const harness = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
        await writeFile(script, (await readFile(script, 'utf8')).replaceAll('/graphyard-harness', harness));
        args = args.map(arg => arg === '/graphyard-harness/node_modules/tsx/dist/loader.mjs' ? fileURLToPath(new URL(import.meta.resolve('tsx'))) : arg);
        options = { ...options, timeoutMs: 15_000 };
      }
      return defaultChildRun(command, args, { ...options, wrapper: [] });
    };
    const reads = mergeWriterReads(config, checkout, run, {
      base: join(root, 'trials'),
      trial: input => runMergeTrial({ ...input, retries: 0, attribute: false }),
      record: async (item, event) => { await api(`work/${item.id}/merge-record`, event); },
    });
    const outcome = await mergeOne(reads, submitted);
    assert.equal(outcome.outcome, 'refused', JSON.stringify(outcome));
    assert.ok(outcome.outcome === 'refused');
    assert.match(outcome.reason, /trial failed: tests/);
    assert.match(outcome.trial!.logTail, /deliberate candidate failure/);
    assert.equal(git(origin, 'rev-parse', 'main'), base, 'the failing head was not pushed');
    assert.deepEqual((await status()).workerVerifications, []);
    const recorded = (await store.workDocument(work.id))!;
    assert.equal(recorded.mergeLedger?.state, 'refused');
    assert.ok(!(await store.events(work.id)).some(event => event.kind === 'work.self-verified'));
  });
}
