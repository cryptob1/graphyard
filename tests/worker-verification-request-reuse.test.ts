import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { workerVerificationPump } from '../src/daemon/worker-verification.js';
import { runWorkerVerification } from '../src/merge-writer/worker-verification.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { verificationQueue } from '../src/server/worker-verification-queue.js';
import { completeCommand } from '../src/cli/complete.js';
import type { CliContext } from '../src/cli/context.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';

setRepositoryPolicy({ ...repositoryPolicy(), risk: { sensitive: [{ glob: 'app.js', rule: 'fixture requires independent review' }], declared: true }, e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

async function until(condition: () => Promise<boolean>, message: string) {
  for (let i = 0; i < 300; i++) { if (await condition()) return; await delay(10); }
  assert.fail(message);
}

async function fixture(t: TestContext) {
  const root = await temporaryDirectory('verification-reuse', process.cwd());
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(root, '.gitignore'), '.graphyard/\nnode_modules/\n');
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'app.js'), 'export const answer = 0;\n');
  git('add', '.'); git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-qb', 'graphyard/reuse');
  await writeFile(join(root, 'app.js'), 'export const answer = 42;\n');
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'tests/required.test.ts'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer } from '../app.js';
test('integration:reuse-required', () => assert.equal(answer, 42));
`);
  git('add', '.'); git('commit', '-qm', 'implementation');
  const head = git('rev-parse', 'HEAD');
  const store = await withDatabase('verification-reuse'); await store.init(); t.after(() => store.close());
  const engine = new Engine(store, 600, 'owner/project'); engine.gitRunner = gitRunnerFor(root);
  const operator = { id: 'operator', role: 'admin' as const, sessionKind: 'human' as const };
  const worker = { id: 'worker', role: 'worker' as const, token: 'worker-test-token' };
  const host = { id: 'host', role: 'coordinator' as const, token: 'host-test-token' };
  engine.principals = [operator, worker, host];
  let work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Reuses a pending verification',
    criteria: [{ id: 'AC-1', text: 'Required validation', proofs: ['integration:reuse-required', 'e2e:fixture'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'test', path: root, branch: 'graphyard/reuse' }, randomUUID());
  const http = server(engine, [worker, host]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); return new Promise<void>(resolve => http.close(() => resolve())); });
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const api = async (path: string, body?: unknown, token = host.token, signal?: AbortSignal) => {
    const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
    return result;
  };
  const start = (input: Record<string, unknown> = {}, signal?: AbortSignal) => api(`work/${work.id}/worker-verification`, { head, epoch: 1, mode: 'complete', ...input }, worker.token, signal)
    .then(value => ({ value, error: null }), error => ({ value: null, error }));
  const pending = async () => (await api('work-snapshot')).workerVerifications as any[];
  const result = { record: { key: work.key, head, clean: true, at: new Date().toISOString(), ran: [], outstanding: [] }, rerun: { flaked: [], baseFailures: [] } };
  return { root, git, head, work, store, api, start, pending, result, worker };
}

test('integration:worker-verification-request-reuse — identical repeats share one host verification; changed inputs and stale epochs do not', async t => {
  const f = await fixture(t);
  const waitMs = verificationQueue.waitMs; verificationQueue.waitMs = 5_000; t.after(() => { verificationQueue.waitMs = waitMs; });
  const first = f.start(), repeat = f.start();
  await until(async () => (await f.pending()).length >= 1, 'request queued');
  await delay(100); // Let the repeat reach the server.
  assert.equal((await f.pending()).length, 1, 'a repeat of the same work, epoch, head and inputs joins the pending verification');
  // Changed verification inputs run their own job.
  const changed = f.start({ preserves: ['kept'] });
  await until(async () => (await f.pending()).length === 2, 'changed inputs queue their own verification');
  // A stale lease epoch is refused, never joined.
  const stale = await f.start({ epoch: 2 });
  assert.match(String(stale.error), /40[39]/);
  assert.equal((await f.pending()).length, 2);
  const jobs = await f.api('worker-verifications/take', { host: 'test' });
  assert.equal(jobs.length, 2);
  const same = jobs.find((job: any) => !job.input.preserves), other = jobs.find((job: any) => job.input.preserves);
  await f.api('worker-verifications/finish', { id: same.id, result: f.result });
  const [a, b] = await Promise.all([first, repeat]);
  assert.deepEqual(a.value, f.result); assert.deepEqual(b.value, f.result);
  assert.equal((await f.pending()).length, 1, 'the changed-input job is still pending');
  await f.api('worker-verifications/finish', { id: other.id, error: 'runner failed' });
  assert.match(String((await changed).error), /422.*runner failed/);
  assert.deepEqual(await f.pending(), []);
  // Once settled, the same identity runs a fresh verification.
  const again = f.start();
  await until(async () => (await f.pending()).length === 1, 'a later request queues anew');
  const [next] = await f.api('worker-verifications/take', { host: 'test' });
  assert.ok(![same.id, other.id].includes(next.id));
  await f.api('worker-verifications/finish', { id: next.id, result: f.result });
  assert.deepEqual((await again).value, f.result);
  // A caller whose time runs out while the host runs its verification leaves it running; the repeat joins it.
  verificationQueue.waitMs = 300;
  const timedOut = f.start();
  await until(async () => (await f.pending()).length === 1, 'the verification queues');
  const [running] = await f.api('worker-verifications/take', { host: 'test' });
  assert.match(String((await timedOut).error), /504.*timed out/);
  verificationQueue.waitMs = 5_000;
  const rejoined = f.start();
  await delay(100);
  assert.deepEqual((await f.pending()).map(entry => entry.state), ['running'], 'the repeat joins the running verification');
  assert.deepEqual(await f.api('worker-verifications/take', { host: 'test' }), []);
  await f.api('worker-verifications/finish', { id: running.id, result: f.result });
  assert.deepEqual((await rejoined).value, f.result);
});

test('e2e:worker-verification-request-reuse — an interrupted complete and its repeat run one host verification and submit through unchanged gates', { timeout: 240_000 }, async t => {
  const f = await fixture(t);
  // The caller gives up while host admission is still waiting.
  const abort = new AbortController();
  const interrupted = f.start({}, abort.signal);
  await until(async () => (await f.pending()).length === 1, 'first request queued');
  abort.abort();
  assert.ok((await interrupted).error);
  const printed: any[] = [];
  const context = { args: ['1', '--head', f.head], repositoryRoot: () => f.root,
    api: (path: string, body?: unknown) => f.api(path, body, f.worker.token), print: (value: any) => printed.push(value) } as unknown as CliContext;
  const completed = completeCommand.run(context, f.work).then(() => null, error => error);
  await delay(200);
  const queued = await f.pending();
  assert.equal(queued.length, 1, 'the repeat joins the queued verification');
  assert.equal(queued[0].state, 'queued');
  let executions = 0;
  const pump = workerVerificationPump(f.root, () => 'test', f.api, () => f.root, undefined, async (...args) => {
    executions++;
    return runWorkerVerification(...args);
  });
  await pump();
  const completionError = await completed;
  if (completionError) throw completionError;
  assert.equal(executions, 1);
  const recorded = (await f.store.list()).find(work => work.id === f.work.id)!;
  assert.equal(recorded.candidate?.sha, f.head); assert.equal(recorded.submission?.epoch, 1);
  assert.equal(recorded.lease, null); assert.equal(recorded.pipeline?.attempts.length, 1);
  assert.equal(recorded.gates.find(gate => gate.name === 'review')?.passed, false);
  assert.equal(recorded.gates.find(gate => gate.name === 'acceptance')?.passed, false);
  assert.notEqual(recorded.stage, 'done');
  const ran = (await f.store.events(f.work.id)).filter(event => event.kind === 'work.self-verified').at(-1)!.payload.details.record.ran;
  assert.ok(ran.some((run: any) => run.proof === 'integration:reuse-required' && run.result === 'pass' && run.executed > 0), JSON.stringify(ran));
  assert.equal(printed.length, 1);
  assert.deepEqual(await f.pending(), []);
});
