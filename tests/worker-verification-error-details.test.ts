import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { createContext } from '../src/cli/context.js';
import { completeCommand } from '../src/cli/complete.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { workerVerificationPump } from '../src/daemon/worker-verification.js';
import { verificationStep } from '../src/merge-writer/worker-verification.js';
import type { WorkerVerificationResult } from '../src/cli/worker-verification.js';
import type { WorkerVerificationInput } from '../src/merge-writer/worker-verification.js';
import type { Principal, Work } from '../src/model.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3506: a failing confined verification step must preserve its exit status/signal and masked
// stdout/stderr before normal cleanup deletes its temporary allocation, and expose those details
// through the completion response and durable history while keeping proof enforcement intact.

test('integration:worker-verification-error-details — a failing verification step preserves exit status and masked stdout/stderr before cleanup', { timeout: 60_000 }, async () => {
  const deadline = await verificationStep('sh', ['-c',
    'echo "verify stdout token=ghp_abcdefghijklmnopqrstuvwxyz"; echo "verify stderr token=sk-ant-api03-1234567890abcdef1234567890" >&2; exit 124',
  ], {}, () => {}).then(() => null, error => error as Error);
  assert.ok(deadline, 'exit 124 must reject');
  assert.match(deadline.message, /exit status 124: the trial container reached its deadline and was stopped/);
  assert.match(deadline.message, /verify stdout/);
  assert.match(deadline.message, /verify stderr/);
  assert.doesNotMatch(deadline.message, /ghp_abcdef/, 'stdout secret is masked');
  assert.doesNotMatch(deadline.message, /sk-ant-api03-1234567890/, 'stderr secret is masked');

  // GY-3150 / GY-3506: mask before slicing the 4000-char tail so a label straddling the boundary cannot leak its value.
  const boundary = await verificationStep(process.execPath, ['-e',
    'process.stdout.write("x".repeat(50) + "token=sk-ant-api03-boundarystdout1234567890\\n" + "y".repeat(3960)); ' +
    'process.stderr.write("x".repeat(50) + "api_key=sk-ant-api03-boundarystderr1234567890\\n" + "z".repeat(3960)); ' +
    'process.exit(1);',
  ], {}, () => {}).then(() => null, error => error as Error);
  assert.ok(boundary, 'boundary secret exit must reject');
  assert.doesNotMatch(boundary.message, /boundarystdout1234567890/, 'stdout secret across slice boundary is masked');
  assert.doesNotMatch(boundary.message, /boundarystderr1234567890/, 'stderr secret across slice boundary is masked');

  const exited = await verificationStep('sh', ['-c', 'echo "runner out detail"; echo "runner err detail" >&2; exit 2'], {}, () => {}).then(() => null, error => error as Error);
  assert.ok(exited, 'non-zero exit must reject');
  assert.match(exited.message, /exit status 2/);
  assert.match(exited.message, /runner out detail/);
  assert.match(exited.message, /runner err detail/);

  const killed = await verificationStep('sh', ['-c', 'kill -9 $$'], {}, () => {}).then(() => null, error => error as Error);
  assert.ok(killed, 'signal exit must reject');
  assert.match(killed.message, /stopped by SIGKILL/);

  // Normal cleanup removes the allocation even when the verification step fails, while the error retains its output.
  const allocations = await temporaryDirectory('verification-cleanup', process.cwd());
  const allocation = await mkdtemp(join(allocations, 'verify-'));
  const script = join(allocation, 'verify.mjs');
  await writeFile(script, 'console.log("before-cleanup stdout"); console.error("before-cleanup stderr token=ghp_abcdefghijklmnopqrstuvwxyz"); process.exit(3);\n');
  const failed = await (async () => {
    try { return await verificationStep(process.execPath, [script], {}, () => {}); }
    finally { await rm(allocation, { recursive: true, force: true }); }
  })().then(() => null, error => error as Error);
  assert.ok(failed, 'forced verify.mjs failure must reject');
  assert.match(failed.message, /exit status 3/);
  assert.match(failed.message, /before-cleanup stdout/);
  assert.match(failed.message, /before-cleanup stderr/);
  assert.doesNotMatch(failed.message, /ghp_abcdef/, 'secret is masked');
  assert.deepEqual(await readdir(allocations), [], 'normal cleanup still removes the allocation');
});

test('e2e:worker-verification-error-details — forced runner failure surfaces exit status and masked output in completion response and durable history; successful verification still enforces required proofs', { timeout: 120_000 }, async t => {
  const base = await realpath(await temporaryDirectory('verification-error-e2e', process.cwd()));
  const allocations = await temporaryDirectory('trials', base);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  const origin = join(base, 'origin.git'), checkout = join(base, 'checkout'), worktree = join(checkout, '.graphyard', 'worktrees', 'GY-1-1');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  await writeFile(join(checkout, 'README.md'), '# Fixture\n'); git(checkout, 'add', 'README.md'); git(checkout, 'commit', '-q', '-m', 'base');
  git(checkout, 'push', '-q', 'origin', 'HEAD:main'); git(checkout, 'fetch', '-q', 'origin');
  git(checkout, 'worktree', 'add', '-q', '-b', 'graphyard/gy-1-1', worktree);
  await writeFile(join(checkout, '.git', 'info', 'exclude'), '.graphyard/\n');
  await mkdir(join(worktree, 'src'), { recursive: true });
  await writeFile(join(worktree, 'src', 'feature.ts'), 'export const fixed = true;\n'); git(worktree, 'add', 'src/feature.ts'); git(worktree, 'commit', '-q', '-m', 'change');
  const head = git(worktree, 'rev-parse', 'HEAD');

  const store = await withDatabase('worker-verification-error-details');
  await store.init(); t.after(() => store.close());
  const engine = new Engine(store, 600, 'owner/project');
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  const operator: Principal = { id: 'operator', role: 'admin' };
  const worker = { id: 'worker', role: 'worker' as const, token: 'worker-' + 'w'.repeat(32) };
  const coordinator = { id: 'host', role: 'coordinator' as const, token: 'host-' + 'h'.repeat(32) };
  engine.principals = [operator, worker, coordinator];
  const proof = 'integration:worker-verification-error-details';
  let work = await engine.execute(operator, 'create', null, { type: 'bug', title: 'Verification diagnostics', criteria: [{ id: 'AC-1', text: 'Diagnostics', proofs: [proof, 'e2e:worker-verification-error-details'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'test', path: worktree, branch: 'graphyard/gy-1-1' }, randomUUID());

  const http = server(engine, [worker, coordinator]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); return new Promise<void>(resolve => http.close(() => resolve())); });
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const mutate = async (path: string, body: unknown) => (await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${coordinator.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) })).json();

  let mode: 'crash' | 'proof-fail' | 'proof-pass' = 'crash';
  const verify = async (_root: string, item: Work, input: WorkerVerificationInput, _base: string, _parent?: string, progress: (line: string) => void = () => {}): Promise<WorkerVerificationResult> => {
    if (mode === 'crash') {
      const allocation = await mkdtemp(join(allocations, 'verify-'));
      try {
        const script = join(allocation, 'verify.mjs');
        await writeFile(script, 'console.log("confined-verify-stdout: step 2 failed"); console.error("confined-verify-stderr: boom token=ghp_abcdefghijklmnopqrstuvwxyz"); process.exit(2);\n');
        await verificationStep(process.execPath, [script], {}, progress);
        throw new Error('unreachable');
      } finally { await rm(allocation, { recursive: true, force: true }); }
    }
    const passed = mode === 'proof-pass';
    return {
      record: {
        key: item.key, head: input.head, clean: true, at: new Date().toISOString(),
        ran: [{ proof, criteria: ['AC-1'], result: passed ? 'pass' : 'fail', executed: 1, failed: passed ? 0 : 1, skipped: 0, files: ['tests/worker-verification-error-details.test.ts'] }],
        outstanding: [],
      },
      rerun: { flaked: [], baseFailures: [] },
    };
  };
  const pump = workerVerificationPump(checkout, () => 'test', mutate, () => 'main', undefined, verify);
  const timer = setInterval(() => { void pump().catch(() => {}); }, 50);
  t.after(() => clearInterval(timer));

  const saved = { url: process.env.GRAPHYARD_URL, token: process.env.GRAPHYARD_TOKEN, file: process.env.GRAPHYARD_TOKEN_FILE };
  process.env.GRAPHYARD_URL = url; process.env.GRAPHYARD_TOKEN = worker.token; delete process.env.GRAPHYARD_TOKEN_FILE;
  t.after(() => {
    if (saved.url === undefined) delete process.env.GRAPHYARD_URL; else process.env.GRAPHYARD_URL = saved.url;
    if (saved.token === undefined) delete process.env.GRAPHYARD_TOKEN; else process.env.GRAPHYARD_TOKEN = saved.token;
    if (saved.file !== undefined) process.env.GRAPHYARD_TOKEN_FILE = saved.file;
  });

  const runComplete = async () => {
    const printed: unknown[] = [];
    const context = await createContext('complete', work.key, ['1', '--head', head], false);
    context.repositoryRoot = () => worktree;
    context.print = value => { printed.push(value); };
    const error = await completeCommand.run(context, work).then(() => null, (err: unknown) => err as Error);
    return { printed, error };
  };

  // 1. Forced runner failure: completion response and durable history expose exit status + masked stdout/stderr; allocation is cleaned up.
  const crashed = await runComplete();
  assert.ok(crashed.error, 'forced runner failure must fail complete');
  assert.match(crashed.error.message, /exit status 2/);
  assert.match(crashed.error.message, /confined-verify-stdout: step 2 failed/);
  assert.match(crashed.error.message, /confined-verify-stderr: boom/);
  assert.doesNotMatch(crashed.error.message, /ghp_abcdef/, 'completion response must not leak secrets');
  assert.deepEqual(await readdir(allocations), [], 'normal cleanup removes the temporary allocation');
  const eventsAfterCrash = await store.events(work.id);
  const durableFailure = eventsAfterCrash.find(event => event.kind === 'work.self-verification-failed');
  assert.ok(durableFailure, `expected durable work.self-verification-failed event; saw ${eventsAfterCrash.map(e => e.kind).join(', ')}`);
  const failureError = String((durableFailure.payload as any)?.details?.error ?? '');
  assert.match(failureError, /exit status 2/);
  assert.match(failureError, /confined-verify-stdout: step 2 failed/);
  assert.match(failureError, /confined-verify-stderr: boom/);
  assert.doesNotMatch(failureError, /ghp_abcdef/, 'durable diagnostic must not leak secrets');
  assert.equal(eventsAfterCrash.filter(event => event.kind === 'work.self-verified').length, 0);

  // 2. Successful verification with a failing required proof still refuses complete.
  mode = 'proof-fail';
  const refused = await runComplete();
  assert.ok(refused.error, 'failing required proof must refuse complete');
  assert.match(refused.error.message, /complete refused: required proofs failed/);
  const readWork = async () => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [work.id])).rows[0].document as Work;
  assert.equal((await readWork()).submission, null, 'failing proof must not submit');

  // 3. Successful verification with all required proofs passing submits the head.
  mode = 'proof-pass';
  const passed = await runComplete();
  assert.equal(passed.error, null, `passing proofs should submit: ${String(passed.error)}`);
  const submitted = await readWork();
  assert.equal(submitted.candidate?.sha, head, 'passing verification submits the head');
});
