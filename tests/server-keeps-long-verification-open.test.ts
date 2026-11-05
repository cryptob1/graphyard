import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { workerVerificationTimeoutMs } from '../src/merge-writer/worker-verification.js';
import { withDatabase } from './helpers/postgres.js';

test('unit:server-keeps-long-verification-open — a simulated verification past 300 seconds receives its HTTP reply', async t => {
  const store = await withDatabase('long-verification');
  await store.init(); t.after(() => store.close());
  const engine = new Engine(store, 600, 'owner/project'); engine.gitRunner = null;
  const operator = { id: 'operator', role: 'admin' as const, sessionKind: 'human' as const };
  const worker = { id: 'worker', role: 'worker' as const, token: 'worker-test-token' };
  const host = { id: 'host', role: 'coordinator' as const, token: 'host-test-token' };
  engine.principals = [operator, worker, host];
  let work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Long verification',
    criteria: [{ id: 'AC-1', text: 'Replies', proofs: ['unit:server-keeps-long-verification-open', 'e2e:fixture'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'test', path: process.cwd(), branch: 'graphyard/test' }, randomUUID());
  const http = server(engine, [worker, host]);
  // Scale socket time by 1000: 300 ms represents the reported 300 s cutoff.
  // Use real socket timers and a real delayed host reply, not a mocked response.
  http.setTimeout(300);
  const timeouts: number[] = [];
  http.prependListener('request', (_req, res) => {
    const original = res.setTimeout;
    res.setTimeout = function (ms, callback) {
      timeouts.push(ms);
      return original.call(this, ms / 1000, callback);
    };
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); return new Promise<void>(resolve => http.close(() => resolve())); });
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const api = async (path: string, body: unknown, token = host.token) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const head = 'a'.repeat(40);
  const pending = api(`work/${work.id}/worker-verification`, { head, epoch: 1, mode: 'verify' }, worker.token)
    .then(value => ({ value, error: null }), error => ({ value: null, error }));
  let jobs: any[] = [];
  for (let i = 0; i < 100 && !jobs.length; i++) {
    jobs = await api('worker-verifications/take', { host: 'test' });
    if (!jobs.length) await delay(10);
  }
  assert.equal(jobs.length, 1);
  await delay(400); // 400 simulated seconds, beyond the old cutoff.
  const result = { record: { key: work.key, head, clean: true, at: new Date().toISOString(), ran: [], outstanding: [] },
    rerun: { flaked: [], baseFailures: [] } };
  await api('worker-verifications/finish', { id: jobs[0].id, result });
  const reply = await pending;
  assert.equal(reply.error, null);
  assert.deepEqual(reply.value, result);
  assert.deepEqual(timeouts, [workerVerificationTimeoutMs + 60_000]);
  assert.equal(http.timeout, 300, 'other routes retain the ordinary socket timeout');
  assert.equal(http.requestTimeout, 300_000, 'request uploads retain their limit');
  assert.equal(http.headersTimeout, 60_000, 'headers retain their limit');
  assert.equal((await store.events(work.id)).filter(event => event.kind === 'work.self-verified').length, 1);
});
