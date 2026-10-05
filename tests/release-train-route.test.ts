import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { releaseState, type Observation, type Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1101 through the control plane: an observed merge starts the item's release-train record, and
 * `POST /api/release-candidates` — what the release CLI sends after `validate` and `promote` — moves
 * every merged item the candidate contains, leaving the delivery itself untouched.
 */
const repository = 'owner/project';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const credentials = [operator, coordinator, worker].map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const base = 'b'.repeat(40);
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
let pg: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1117;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('release-train'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('release_train_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/release_train_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });

async function request(credential: string, path: string, body?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;

test('an observed merge is merged-pending-release, and a promoted UAT-passed candidate reported through the API makes it Done without touching the delivery', async () => {
  // Deliver through a direct-merge window, the shortest observed-merge path a test can drive.
  assert.equal((await request(token(operator), 'direct-merges/on', { since: '2026-01-01T00:00:00Z', reason: 'Test repository merges straight into main' })).status, 200);
  let w = await engine.execute(operator, 'create', null, { title: 'Release train', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID()); w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: '/tmp/release-train-1', branch: 'graphyard/release-1' }, randomUUID());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 901 }, randomUUID());
  const mergeSha = sha('merge-1');
  const observation: Observation = { clockOffset: { min: 0, max: 0 }, candidate: { sha: sha(w.key), baseSha: base, pr: 901, branch: 'graphyard/release-1', author: 'implementer' },
    checks: [], reviews: [], protected: true, mergeable: false, merged: true, prState: 'closed', mergeSha, mergedAt: '2026-02-01T10:00:00Z', baseTip: mergeSha, baseTree: '7e'.repeat(20), files: [], scopeFiles: [], at: new Date().toISOString() };
  const merged = await engine.observe(w.id, (await reload(w.id)).revision, observation);
  assert.equal(merged.stage, 'done');
  assert.equal(releaseState(merged), 'merged-pending-release');
  assert.deepEqual(merged.releaseTrain!.proofs, ['integration:claim-safety']);
  const delivery = merged.delivery;

  const items = [{ key: w.key, mergeSha, pr: 901 }];
  const failed = { candidate: { id: '20261003T060000Z', sha: sha('rc-1'), items },
    uat: { result: 'failed', suites: [{ name: 'proof integration:claim-safety', passed: false, detail: '1 of 2 cases failed' }], followUp: 'GY-77' }, production: null };
  assert.equal((await request(token(worker), 'release-candidates', failed)).status, 403, 'a worker cannot move the release train');
  const reported = await request(token(coordinator), 'release-candidates', failed);
  assert.equal(reported.status, 200, JSON.stringify(reported.body));
  assert.deepEqual(reported.body.items, [{ key: w.key, state: 'merged-pending-release', changed: true }]);
  let item = await reload(w.id);
  assert.equal(item.releaseTrain!.candidate!.uat, 'failed');
  assert.deepEqual(item.releaseTrain!.candidate!.failing, ['proof integration:claim-safety']);
  assert.deepEqual(item.delivery, delivery, 'a failed candidate never reworks or reverts the merge');
  assert.equal(item.stage, 'done');

  const promoted = { candidate: { id: '20261003T120000Z', sha: sha('rc-2'), items },
    uat: { result: 'passed', suites: [{ name: 'proof integration:claim-safety', passed: true, detail: '2 cases passed' }], followUp: null }, production: { at: '2026-10-03T13:00:00.000Z' } };
  const done = await request(token(coordinator), 'release-candidates', promoted);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body.items, [{ key: w.key, state: 'released', changed: true }]);
  item = await reload(w.id);
  assert.equal(releaseState(item), 'released');
  assert.equal(item.releaseTrain!.releasedAt, '2026-10-03T13:00:00.000Z');
  assert.deepEqual(item.delivery, delivery);
  assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM events WHERE work_id=$1 AND kind='release.promoted'", [w.id])).rows[0].n, 1);
  // Released is terminal: the candidate is no longer pending anywhere, and a replay changes nothing.
  assert.deepEqual((await request(token(coordinator), 'release-candidates', failed)).body.items, []);
  assert.equal((await request(token(coordinator), 'release-candidates', { candidate: { id: 'not-an-id', sha: sha('x'), items } })).status, 400);
});
