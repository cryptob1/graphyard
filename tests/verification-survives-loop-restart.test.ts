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
import { completeCommand } from '../src/cli/complete.js';
import { requestWorkerVerification } from '../src/cli/worker-verification.js';
import type { CliContext } from '../src/cli/context.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';

// Require pre-merge review for the fixture's changed source, just as this sensitive fix does.
setRepositoryPolicy({ ...repositoryPolicy(), risk: { sensitive: [{ glob: 'app.js', rule: 'fixture requires independent review' }], declared: true }, e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

async function until(condition: () => Promise<boolean>, message: string) {
  for (let i = 0; i < 200; i++) { if (await condition()) return; await delay(10); }
  assert.fail(message);
}

async function fixture(t: TestContext) {
  const root = await temporaryDirectory('verification-restart', process.cwd());
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(root, '.gitignore'), '.graphyard/\nnode_modules/\n');
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'app.js'), 'export const answer = 0;\n');
  git('add', '.'); git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-qb', 'graphyard/restart');
  await writeFile(join(root, 'app.js'), 'export const answer = 42;\n');
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'tests/required.test.ts'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer } from '../app.js';
test('integration:restart-required', () => assert.equal(answer, 42));
`);
  git('add', '.'); git('commit', '-qm', 'implementation');
  const head = git('rev-parse', 'HEAD');
  const store = await withDatabase('verification-restart'); await store.init(); t.after(() => store.close());
  const engine = new Engine(store, 600, 'owner/project'); engine.gitRunner = gitRunnerFor(root);
  const operator = { id: 'operator', role: 'admin' as const, sessionKind: 'human' as const };
  const worker = { id: 'worker', role: 'worker' as const, token: 'worker-test-token' };
  const host = { id: 'host', role: 'coordinator' as const, token: 'host-test-token' };
  const peer = { id: 'peer', role: 'coordinator' as const, token: 'peer-test-token' };
  const master = { id: 'master', role: 'operator-agent' as const, token: 'master-test-token', scope: { workItems: ['*'], repositories: ['owner/project'] } };
  engine.principals = [operator, worker, host, peer, master];
  let work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Survives loop restart',
    criteria: [{ id: 'AC-1', text: 'Required validation', proofs: ['integration:restart-required', 'e2e:fixture'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'test', path: root, branch: 'graphyard/restart' }, randomUUID());
  const http = server(engine, [worker, host, peer, master]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); return new Promise<void>(resolve => http.close(() => resolve())); });
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const api = async (path: string, body?: unknown, token = host.token) => {
    const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
    return result;
  };
  const start = () => api(`work/${work.id}/worker-verification`, { head, epoch: 1, mode: 'verify' }, worker.token).then(value => ({ value, error: null }), error => ({ value: null, error }));
  const pending = async (token = host.token) => (await api('work-snapshot', undefined, token)).workerVerifications;
  const result = { record: { key: work.key, head, clean: true, at: new Date().toISOString(), ran: [], outstanding: [] }, rerun: { flaked: [], baseFailures: [] } };
  return { root, git, head, work, store, api, start, pending, result, worker, host, peer, master };
}

test('integration:verification-survives-loop-restart — a restarted pump rejects abandoned work and stale replies cannot settle its retry', async t => {
  const f = await fixture(t);
  const old = workerVerificationPump(f.root, () => 'test', f.api, () => f.root);
  await old(); // Initialize the old loop before a request is assigned.
  const abandoned = f.start();
  await until(async () => (await f.pending()).length === 1, 'request queued');
  const [job] = await f.api('worker-verifications/take', { host: 'test' });
  assert.deepEqual(await f.api('worker-verifications/take', { host: 'test' }), [], 'active work is never taken twice');
  assert.deepEqual(await f.api('worker-verifications/restart', { host: 'test' }, f.peer.token), { interrupted: 0 });
  assert.deepEqual(await f.api('worker-verifications/restart', { host: 'other' }), { interrupted: 0 });
  await assert.rejects(f.api('worker-verifications/restart', { host: 'test' }, f.worker.token), /403/);
  const restarted = workerVerificationPump(f.root, () => 'test', f.api, () => f.root);
  await restarted();
  const interrupted = await abandoned;
  assert.match(String(interrupted.error), /409.*restart.*retry verify/);
  assert.match(String(interrupted.error), new RegExp(f.head));
  assert.equal((await f.store.events(f.work.id)).filter(event => event.kind === 'work.self-verified').length, 0);
  const retry = f.start();
  await until(async () => (await f.pending()).length === 1, 'same worker retries');
  const [next] = await f.api('worker-verifications/take', { host: 'test' });
  assert.notEqual(next.id, job.id);
  await assert.rejects(f.api('worker-verifications/finish', { id: job.id, result: f.result }), /409/);
  await assert.rejects(f.api('worker-verifications/progress', { id: job.id, line: 'old reply' }), /409/);
  await restarted(); // Ordinary polling must not repeat restart cleanup.
  assert.equal((await f.pending()).length, 1);
  await f.api('worker-verifications/finish', { id: next.id, result: f.result });
  assert.deepEqual((await retry).value, f.result);
  assert.equal((await f.store.events(f.work.id)).filter(event => event.kind === 'work.self-verified').length, 1);
});

test('integration:verification-coordinator-status — master and coordinator see queued/running age and progress without worker credentials', async t => {
  const f = await fixture(t);
  const request = f.start();
  await until(async () => (await f.pending()).length === 1, 'request queued');
  const [queued] = await f.pending(f.master.token);
  assert.equal(queued.key, f.work.key); assert.equal(queued.head, f.head);
  assert.equal(queued.state, 'queued'); assert.equal(queued.executor, null);
  assert.ok(queued.ageSeconds >= 0); assert.ok(Number.isFinite(Date.parse(queued.requestedAt)));
  // Starting a loop preserves work that has never been assigned.
  assert.deepEqual(await f.api('worker-verifications/restart', { host: 'test' }), { interrupted: 0 });
  const [job] = await f.api('worker-verifications/take', { host: 'test' });
  await f.api('worker-verifications/progress', { id: job.id, line: 'waiting for a trial slot' });
  for (const token of [f.host.token, f.master.token]) {
    const [running] = (await f.api('status', undefined, token)).workerVerifications;
    assert.equal(running.state, 'running'); assert.equal(running.executor, f.host.id);
    assert.deepEqual(running.progress, ['waiting for a trial slot']);
    assert.ok(running.ageSeconds >= queued.ageSeconds);
    assert.deepEqual(Object.keys(running).sort(), ['key', 'head', 'epoch', 'host', 'executor', 'requestedAt', 'ageSeconds', 'state', 'progress'].sort());
  }
  assert.deepEqual(await f.pending(f.worker.token), []);
  await f.api('worker-verifications/finish', { id: job.id, result: f.result });
  assert.equal((await request).error, null);
  assert.deepEqual(await f.pending(), []);
});

test('e2e:verification-survives-loop-restart — optional verify retries its preserved head through real validation, then complete submits and leaves independent gates intact', { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  const printed: any[] = [];
  const context = { args: ['1', '--head', f.head], repositoryRoot: () => f.root,
    api: (path: string, body?: unknown) => f.api(path, body, f.worker.token), print: (value: any) => printed.push(value) } as unknown as CliContext;
  const startComplete = () => requestWorkerVerification(context, f.work, { mode: 'verify', head: f.head, epoch: 1 }).then(() => null, error => error);
  const abandoned = startComplete();
  await until(async () => (await f.pending()).length === 1, 'verify queued');
  const [old] = await f.api('worker-verifications/take', { host: 'test' });
  let executions = 0;
  const restarted = workerVerificationPump(f.root, () => 'test', f.api, () => f.root, undefined, async (...args) => {
    executions++;
    return runWorkerVerification(...args);
  });
  await restarted();
  assert.match(String(await abandoned), /restart.*retry verify/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.head);
  const completed = startComplete();
  await until(async () => (await f.pending()).length === 1, 'retry queued');
  await restarted();
  await assert.rejects(f.api('worker-verifications/finish', { id: old.id, result: f.result }), /409/);
  const completionError = await completed;
  if (completionError) throw completionError;
  assert.equal(executions, 1);
  await completeCommand.run(context, f.work);
  const recorded = (await f.store.list()).find(work => work.id === f.work.id)!;
  assert.equal(recorded.candidate?.sha, f.head); assert.equal(recorded.submission?.epoch, 1);
  assert.equal(recorded.lease, null); assert.equal(recorded.pipeline?.attempts.length, 1);
  assert.equal(recorded.gates.find(gate => gate.name === 'review')?.passed, false);
  assert.equal(recorded.gates.find(gate => gate.name === 'acceptance')?.passed, false);
  assert.notEqual(recorded.stage, 'done'); assert.equal(recorded.evidence.length, 0);
  const records = (await f.store.events(f.work.id)).filter(event => event.kind === 'work.self-verified');
  assert.equal(records.length, 1);
  const ran = records[0]!.payload.details.record.ran;
  assert.ok(ran.some((run: any) => run.proof === 'integration:restart-required' && run.result === 'pass' && run.executed > 0), JSON.stringify(ran));
  assert.equal(printed.length, 1);
});
