import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { withDatabase } from './helpers/postgres.js';
import { save, type Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { readRegistry } from '../src/agent-registry.js';
import { compactLedger } from '../src/store/compaction.js';
import type { Work } from '../src/model.js';

/**
 * GY-3402: the core database ran at 87% CPU. The reads of the install-wide records — the agent
 * registry (every registry operation reads it: dispatch, session settles, observations, the Agents
 * and Costs pages), connect requests and team access (each master loop pass) — asked for
 * `work_id IS NULL AND kind LIKE 'family.%'`. A LIKE cannot use a btree under the database's
 * en_US collation, so each one was a sequential scan of the whole ledger. On a ledger of 200,000
 * loop bookkeeping rows these reads must go through an index, return the same rows the LIKE did,
 * and the pages and item history read the same before and after a retention pass.
 */
const token = 'operator-' + 'a'.repeat(32);
let store: Store, http: ReturnType<typeof server>, base: string, itemId: string;
const families = ['agent-registry.', 'connect-account.', 'team-access.'];
// Every events statement the reads under test send, as the database receives it. Installed before
// the store connects: each connection's query wrapper (store/statements.ts) binds the prototype's.
const seen: { text: string; values: unknown[] }[] = [];
let recording = false;
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (this: pg.Client, config: any, values?: any, ...rest: any[]) {
  const text = typeof config === 'string' ? config : config?.text;
  if (recording && typeof text === 'string' && /\bFROM events\b/.test(text)) seen.push({ text, values: Array.isArray(values) ? values : config?.values ?? [] });
  return (query as any).call(this, config, values, ...rest);
} as typeof query;

const call = async (path: string, body?: unknown) => {
  const response = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json() as any;
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(json)}`);
  return json;
};
/** What the Agents page, connect list, team access and the item's history show. */
const pages = async () => ({
  registry: await call('agent-registry/document'),
  registryHistory: await call('agent-registry/history'),
  connects: await call('agent-registry/connect'),
  teamAccess: await call('team-access/host'),
  history: await call(`events?work=${itemId}&routine=include&limit=500`),
});

before(async () => {
  store = await withDatabase('events-hot-query'); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;

  // 200,000 old loop bookkeeping rows (work_id NULL), the bulk of an unowned ledger.
  await store.pool.query(`INSERT INTO events(actor, kind, payload, created_at)
    SELECT 'fixture-coordinator', 'loop-state.saved', '{"ids":["x"]}', now() - interval '30 days' + d * interval '1 millisecond' FROM generate_series(1, 200000) d`);
  // One item with a lifecycle and routine saves through the real writer.
  itemId = randomUUID();
  const work = { id: itemId, key: 'GY-H1', title: 'Hot query sample', type: 'bug', priority: 1, stage: 'build', ready: true, revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    epoch: 1, lease: { epoch: 1, owner: 'implementer', expiresAt: new Date().toISOString() }, submission: null, workspaces: [], dependencies: [], evidence: [],
    criteria: [{ id: 'AC-1', text: 'sample', proofs: ['integration:x'] }], actionQueue: { actions: [] }, gates: [] } as unknown as Work;
  await store.pool.query('INSERT INTO work_items(id, document) VALUES($1,$2)', [itemId, JSON.stringify(work)]);
  const db = await store.pool.connect();
  try {
    await save(db, work, 'graphyard', 'create', new Date());
    for (let n = 0; n < 3; n++) {
      work.lease = { epoch: 1, owner: 'implementer', expiresAt: new Date(Date.now() + (n + 1) * 60_000).toISOString() } as Work['lease'];
      await save(db, work, 'graphyard', 'heartbeat', new Date());
    }
  } finally { db.release(); }
  // The install-wide records, through their real routes: a registry, a connect request, a host's team-access report.
  await call('agent-registry/apply', {
    runtimes: [{ name: 'claude', launch: { kind: 'claude', args: [], environment: {}, homeVariable: 'CLAUDE_CONFIG_DIR', modelFlag: null, login: null, loginFile: '.credentials.json' } }],
    models: [{ name: 'claude-default', id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null } }],
    accounts: [{ name: 'claude-q', runtime: 'claude', model: 'claude-default', credential: { host: 'host-a', home: '/tmp/claude-q' }, enabled: true, maxSessions: null }],
    roles: [{ name: 'worker', accounts: ['claude-q'], concurrency: 1 }],
    reason: 'fixture: one worker account',
  });
  await call('agent-registry/connect', { host: 'host-a', provider: 'claude', reason: 'fixture: a second Claude account' });
  await call('team-access/host', { dnsName: 'yard.tail-test.ts.net', ip: '100.64.0.7', applied: { team: null } });
  // Newer bookkeeping after them, as the loop keeps writing.
  await store.pool.query(`INSERT INTO events(actor, kind, payload) SELECT 'fixture-coordinator', 'loop-state.saved', '{"ids":["x"]}' FROM generate_series(1, 2000)`);
  await store.pool.query('ANALYZE events');
});

after(async () => {
  http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
  await store.close();
});

test('integration:events-hot-query — the install-wide record reads (agent registry, connect requests, team access) go through an index, never a sequential scan of events, and return the rows the kind LIKE returned', async () => {
  recording = true;
  try {
    await readRegistry(store.pool);
    await call('agent-registry/history');
    await call('agent-registry/connect');
    await call('team-access/host');
  } finally { recording = false; }
  const family = seen.filter(statement => /work_id IS NULL/.test(statement.text));
  assert.ok(family.length >= 4, `each read sent its install-wide statement: ${family.map(s => s.text).join('\n')}`);
  for (const statement of family) {
    const plan = (await store.pool.query(`EXPLAIN ${statement.text}`, statement.values)).rows.map(row => row['QUERY PLAN']).join('\n');
    assert.doesNotMatch(plan, /Seq Scan on events/, `no sequential scan of events for:\n${statement.text}\n${plan}`);
  }
  const registryPlan = (await store.pool.query(`EXPLAIN ${family[0].text}`)).rows.map(row => row['QUERY PLAN']).join('\n');
  assert.match(registryPlan, /events_unowned_family/, `the registry read probes events_unowned_family:\n${registryPlan}`);
  // The family predicate selects exactly the rows the LIKE did.
  for (const prefix of families) {
    const like = (await store.pool.query(`SELECT seq FROM events WHERE work_id IS NULL AND kind LIKE $1 ORDER BY seq`, [`${prefix}%`])).rows.map(row => row.seq);
    const indexed = (await store.pool.query(`SELECT seq FROM events WHERE work_id IS NULL AND split_part(kind,'.',1) = $1 ORDER BY seq`, [prefix.slice(0, -1)])).rows.map(row => row.seq);
    assert.ok(like.length > 0, `${prefix} rows were seeded`);
    assert.deepEqual(indexed, like, `${prefix}: the same rows`);
  }
});

test('e2e:events-after-trim — item history, the Agents page registry, connect requests and team access show the same before and after a retention pass', async () => {
  const before = await pages();
  assert.equal(before.registry.registry?.accounts?.[0]?.name ?? before.registry.accounts?.[0]?.name, 'claude-q', 'the registry shows its account');
  assert.ok(before.registryHistory.length >= 1, 'the registry history shows its change');
  assert.equal(before.connects.connects.length, 1, 'the connect request shows');
  assert.equal(before.connects.connects[0].provider, 'claude');
  assert.ok(before.history.some((event: any) => event.kind === 'create') && before.history.some((event: any) => event.kind === 'heartbeat'), 'the item history shows its create and heartbeats');
  const pass = await compactLedger(store.pool, { batch: 50_000, batches: 10, pauseMs: 0 });
  assert.ok(pass.total >= 200_000, `the pass trimmed the old bookkeeping rows (${pass.total})`);
  assert.deepEqual(await pages(), before, 'every page reads what it read before the pass');
});
