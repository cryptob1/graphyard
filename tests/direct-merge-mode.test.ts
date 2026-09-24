import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine, unauthorizedMergeViolation } from '../src/engine.js';
import { server } from '../src/server.js';
import { directMergeFromEnv, directMergeStatus } from '../src/direct-merge.js';
import type { Observation, Principal, Work } from '../src/model.js';

/**
 * Direct-merge mode: an operator-owned window inside which a merge no execution authorized is
 * delivered as operator-authorized instead of held with the unauthorized-merge violation. Only an
 * admin credential or the deployment environment opens one; setting it clears items already held.
 */
const repository = 'owner/project';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const principals = [operator, coordinator, worker];
const credentials = principals.map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const agent = { id: 'master-operator-agent', token: `master-operator-agent-${'m'.repeat(32)}` };
const base = 'b'.repeat(40);
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
let pg: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 153;
  pg = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-direct-merge-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('direct_merge_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/direct_merge_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const created = await request(token(operator), 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: ['decision:merge'], scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'The master agent' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });

async function request(credential: string, path: string, body?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const events = async (id: string, kind: string) => (await store.pool.query('SELECT actor, payload FROM events WHERE work_id=$1 AND kind=$2 ORDER BY seq', [id, kind])).rows;

/** A submitted item whose pull request GitHub then reports merged at `mergedAt`, with no merge execution. */
async function mergedWithoutExecution(mergedAt: string, observer = engine) {
  const n = ++serial;
  let w = await engine.execute(operator, 'create', null, { title: `Direct merge ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID()); w = await engine.execute(worker, 'claim', w.id, {}, randomUUID());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/direct-merge-${n}`, branch: `graphyard/direct-${n}` }, randomUUID());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: 700 + n }, randomUUID());
  const mergeSha = sha(`merge-${n}`);
  const observation: Observation = { clockOffset: { min: 0, max: 0 }, candidate: { sha: sha(w.key), baseSha: base, pr: 700 + n, branch: w.workspaces[0].branch, author: 'implementer' },
    checks: [], reviews: [], protected: true, mergeable: false, merged: true, prState: 'closed', mergeSha, mergedAt, baseTip: mergeSha, baseTree: '7e'.repeat(20), files: [], scopeFiles: [], at: new Date().toISOString() };
  return { work: await observer.observe(w.id, (await reload(w.id)).revision, observation), mergeSha };
}

test('integration:direct-merge-admin-only — only an admin credential sets or clears direct-merge mode; coordinator, worker and operator-agent identities are refused and nothing is recorded', async () => {
  for (const credential of [token(coordinator), token(worker), agent.token]) {
    const refused = await request(credential, 'direct-merges/on', { since: '2026-01-01T00:00:00Z', reason: 'agents may not bypass the gates' });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal((await request(credential, 'direct-merges/off', { reason: 'nor clear it' })).status, 403);
  }
  assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM events WHERE kind LIKE 'policy.direct-merge.%'")).rows[0].n, 0);
  assert.equal((await request(token(operator), 'direct-merges/on', { since: 'not a time', reason: 'bad' })).status, 400);
});

test('integration:direct-merge-delivers-inside-window — with the mode on, an unauthorized merge inside the window is delivered as operator-authorized with no violation, and the event names the setting and who set it; a merge before `since` or after `off` is still held', async () => {
  const on = await request(token(operator), 'direct-merges/on', { since: '2026-01-01T00:00:00Z', reason: 'The development repository merges straight into main' });
  assert.equal(on.status, 200, JSON.stringify(on.body)); assert.equal(on.body.on, true);
  const status = await request(token(coordinator), 'status');
  assert.match(status.body.directMerge.line, /^Direct-merge mode is on since 2026-01-01T00:00:00.000Z, set by human-operator \(The development repository merges straight into main\): gated merging is bypassed/);

  const inside = await mergedWithoutExecution('2026-02-01T10:00:00Z');
  assert.equal(inside.work.stage, 'done'); assert.deepEqual(inside.work.violations, []);
  const record = (inside.work.delivery as any).operatorAuthorization;
  assert.equal(inside.work.delivery!.mergeSha, inside.mergeSha); assert.equal(record.execution, null); assert.equal(record.operator, operator.id);
  assert.equal(record.directMerge.setBy, operator.id); assert.equal(record.directMerge.since, '2026-01-01T00:00:00.000Z'); assert.match(record.decision, /^direct-merge:\d+$/);
  const recorded = await events(inside.work.id, 'merge.operator-authorized');
  assert.equal(recorded.length, 1); assert.equal(recorded[0].actor, operator.id);
  assert.equal(recorded[0].payload.details.directMerge.reason, 'The development repository merges straight into main'); assert.match(recorded[0].payload.details.judgement, /inside the direct-merge window from 2026-01-01T00:00:00.000Z that human-operator set/);

  const early = await mergedWithoutExecution('2025-12-01T10:00:00Z');
  assert.equal(early.work.stage === 'done', false); assert.ok(early.work.violations.includes(unauthorizedMergeViolation), 'a merge before since is still held');
  assert.equal(early.work.delivery, undefined);

  const off = await request(token(operator), 'direct-merges/off', { reason: 'Back to gated merging' });
  assert.equal(off.status, 200, JSON.stringify(off.body)); assert.equal(off.body.on, false);
  assert.equal((await request(token(coordinator), 'status')).body.directMerge.line, null);
  assert.equal((await request(token(operator), 'direct-merges/off', { reason: 'again' })).status, 409);
  await delay(20);
  const late = await mergedWithoutExecution(new Date().toISOString());
  assert.ok(late.work.violations.includes(unauthorizedMergeViolation), 'a merge after off is held'); assert.equal(late.work.delivery, undefined);
  // The closed window still covers what landed inside it.
  assert.equal((await reload(inside.work.id)).stage, 'done');
  const history = (await request(token(operator), 'direct-merges')).body.history;
  assert.equal(history.length, 1); assert.ok(history[0].until, 'off closed the window at the instant it was written');
});

test('integration:direct-merge-clears-held-items — setting the mode delivers every item already held with the violation whose merge lies inside the window, in the same call', async () => {
  const held = await mergedWithoutExecution('2025-06-01T08:00:00Z');
  assert.ok(held.work.violations.includes(unauthorizedMergeViolation));
  const on = await request(token(operator), 'direct-merges/on', { since: '2025-01-01T00:00:00Z', reason: 'Merged straight into main since January' });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.ok(on.body.delivered.includes(held.work.key), JSON.stringify(on.body.delivered));
  const delivered = await reload(held.work.id);
  assert.equal(delivered.stage, 'done'); assert.deepEqual(delivered.violations, []);
  assert.equal((delivered.delivery as any).operatorAuthorization.directMerge.setBy, operator.id);
  assert.equal((await events(held.work.id, 'merge.operator-authorized'))[0].actor, operator.id);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM jobs WHERE work_id=$1', [held.work.id])).rows[0].n, 0, 'the integration job is retired');
  assert.equal((await store.pool.query("SELECT actor FROM events WHERE kind='policy.direct-merge.set' ORDER BY seq DESC LIMIT 1")).rows[0].actor, operator.id);
});

test('integration:direct-merge-environment — GRAPHYARD_DIRECT_MERGE_SINCE alone opens a window set by the deployment environment, and the reconciliation tick clears a held item inside it with no command', async () => {
  const held = await mergedWithoutExecution('2024-03-01T12:00:00Z');
  assert.ok(held.work.violations.includes(unauthorizedMergeViolation));
  assert.equal(directMergeFromEnv({ GRAPHYARD_DIRECT_MERGE_SINCE: 'soon' }), null, 'an unparseable value opens nothing');
  const previous = process.env.GRAPHYARD_DIRECT_MERGE_SINCE;
  process.env.GRAPHYARD_DIRECT_MERGE_SINCE = '2024-01-01T00:00:00Z';
  try {
    const deployed = new Engine(store, [15368], 120, repository); deployed.submissionObserver = null;
    assert.equal(deployed.directMergeEnvironment?.setBy, 'deployment environment');
    await deployed.reconcile();
    const delivered = await reload(held.work.id);
    assert.equal(delivered.stage, 'done'); assert.deepEqual(delivered.violations, []);
    const recorded = await events(held.work.id, 'merge.operator-authorized');
    assert.equal(recorded.length, 1); assert.equal(recorded[0].actor, 'deployment environment'); assert.equal(recorded[0].payload.details.decision, 'direct-merge:environment');
    const status = await directMergeStatus(store.pool, deployed.directMergeEnvironment, new Date());
    assert.match(status.line!, /since 2024-01-01T00:00:00.000Z, set by deployment environment/);
    // The observation path honours it too.
    const observed = await mergedWithoutExecution('2024-04-01T12:00:00Z', deployed);
    assert.equal(observed.work.stage, 'done');
  } finally { if (previous === undefined) delete process.env.GRAPHYARD_DIRECT_MERGE_SINCE; else process.env.GRAPHYARD_DIRECT_MERGE_SINCE = previous; }
});
