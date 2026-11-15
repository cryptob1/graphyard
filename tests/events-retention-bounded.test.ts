import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { databaseUrl } from './helpers/postgres.js';
import { Store, save } from '../src/store.js';
import { compactLedger, candidateSql, ledgerCompactionBatch, ledgerCompactedKind, ledgerRetentionMs } from '../src/store/compaction.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { storedLoopState } from '../src/server/loop-state.js';
import { reviewRecordSchema } from '../src/reviewer.js';
import type { Work } from '../src/model.js';

// GY-3037: the fixture files an item, and every item owes an e2e proof; it declares the serve one needs.
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

/**
 * GY-3342: events retention is cheap and the events table stays small. On a ledger of 200,000
 * events one retention pass deletes in bounded batches, every statement it runs stays under a fixed
 * bound, /healthz and /api/events keep answering while it runs, only rows inside the retention rule
 * remain, and the seeded kinds store small rows (loop bookkeeping names ids, not whole records).
 */
const statementBoundMs = 1_000, readBoundMs = 2_000, rowBytes = { heartbeat: 600, 'loop-state.saved': 400 } as Record<string, number>;
const token = 'operator-' + 'a'.repeat(32);
const sha = (c: string) => c.repeat(40);

test('e2e:events-retention-bounded — one retention pass over 200,000 events deletes in bounded batches with short statements while healthz and /api/events answer, and keeps only rows inside the retention rule', async t => {
  const url = await databaseUrl('events-retention');
  const store = new Store(url); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  const http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const retention = new pg.Pool({ connectionString: url, max: 2 });
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await retention.end(); await store.close(); });

  // One row of each seeded kind through its real writer: a loop-state save of four review records, and a routine heartbeat save.
  const reviews = Array.from({ length: 4 }, (_, i) => reviewRecordSchema.parse({ id: randomUUID(), key: `GY-${i + 1}`, pr: i + 1, sha: sha('a'), baseSha: sha('b'), policyRevision: 1,
    profile: 'claude-reviewer', agentName: `review-${i}`, pane: null, sessionDirectory: '/var/lib/graphyard/sessions/review', requestedAt: new Date().toISOString(),
    tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), requestId: randomUUID(), attempt: 1, state: 'pending' }));
  await storedLoopState(store, { id: 'fixture-coordinator', role: 'coordinator' }, 'scope-a').write('reviews', reviews);
  const sampleId = randomUUID();
  const work = { id: sampleId, key: 'GY-R0', title: 'Retention sample', type: 'feature', priority: 3, stage: 'build', ready: true, revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    epoch: 1, lease: { epoch: 1, owner: 'implementer', expiresAt: new Date().toISOString() }, submission: null, workspaces: [], dependencies: [], evidence: [],
    criteria: [{ id: 'AC-1', text: 'x'.repeat(2_000), proofs: ['integration:x'] }], actionQueue: { actions: [] }, gates: [] } as unknown as Work;
  await store.pool.query('INSERT INTO work_items(id, document) VALUES($1,$2)', [sampleId, JSON.stringify(work)]);
  const db = await store.pool.connect();
  try {
    await save(db, work, 'graphyard', 'create', new Date());
    work.lease = { epoch: 1, owner: 'implementer', expiresAt: new Date(Date.now() + 60_000).toISOString() } as Work['lease'];
    await save(db, work, 'graphyard', 'heartbeat', new Date());
  } finally { db.release(); }
  const sample = async (kind: string) => (await store.pool.query('SELECT payload FROM events WHERE kind=$1 ORDER BY seq DESC LIMIT 1', [kind])).rows[0].payload;
  const loopPayload = await sample('loop-state.saved'), heartbeatPayload = await sample('heartbeat');
  assert.ok(heartbeatPayload.delta, 'a routine save stores a delta');

  // 200,000 events, each a copy of its writer's row: 400 items with a create row, 300 old heartbeats and one recent;
  // 70,000 old loop-state saves and 10,000 recent ones.
  const items = 400, oldBeats = 300, oldLoop = 70_000, recentLoop = 10_000;
  for (let n = 1; n <= items; n++) {
    const item = randomUUID(), doc = { id: item, key: `GY-S${n}`, title: `Seed ${n}`, type: 'chore', stage: 'build', ready: true, priority: 3, epoch: 1, evidence: [], revision: 0 };
    await store.pool.query('INSERT INTO work_items(id, document) VALUES($1,$2)', [item, JSON.stringify(doc)]);
    const created = (await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload, created_at) VALUES($1, 'graphyard', 'create', $2, now() - interval '30 days') RETURNING seq`, [item, JSON.stringify({ work: doc })])).rows[0].seq;
    await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload, created_at)
      SELECT $1, 'graphyard', 'heartbeat', jsonb_set(jsonb_set($2::jsonb, '{delta,base}', to_jsonb($3::bigint)), '{delta,revision}', to_jsonb(d)),
        CASE WHEN d > $4::int THEN now() - interval '1 hour' ELSE now() - interval '30 days' + d * interval '1 second' END
      FROM generate_series(1, $4::int + 1) d`, [item, JSON.stringify(heartbeatPayload), created, oldBeats]);
  }
  await store.pool.query(`INSERT INTO events(actor, kind, payload, created_at)
    SELECT 'fixture-coordinator', 'loop-state.saved', $1, CASE WHEN d > $2::int THEN now() - interval '1 hour' ELSE now() - interval '30 days' + d * interval '10 milliseconds' END
    FROM generate_series(1, $2::int + $3::int) d`, [JSON.stringify(loopPayload), oldLoop, recentLoop]);
  await store.pool.query('ANALYZE events');
  const total = Number((await store.pool.query('SELECT count(*) AS n FROM events')).rows[0].n);
  assert.ok(total >= 200_000, `the seeded ledger holds ${total} events`);

  // The average stored row of each seeded kind stays small.
  const sizes = (await store.pool.query(`SELECT kind, avg(pg_column_size(e.*))::int AS bytes FROM events e WHERE kind = ANY($1::text[]) GROUP BY kind`, [Object.keys(rowBytes)])).rows;
  console.log(`average stored row: ${JSON.stringify(sizes)}`);
  for (const { kind, bytes } of sizes) assert.ok(bytes < rowBytes[kind], `the average ${kind} row is ${bytes} bytes, over ${rowBytes[kind]}`);

  // The plans a batch runs: candidate reads stay inside the seq window, and the delete goes by primary key.
  const window = [['heartbeat'], new Date(Date.now() - ledgerRetentionMs), '0', String(ledgerCompactionBatch)];
  for (const sql of candidateSql) console.log(`candidate plan:\n${(await store.pool.query(`EXPLAIN ${sql}`, window)).rows.map(row => row['QUERY PLAN']).join('\n')}`);
  const deletePlan = (await store.pool.query('EXPLAIN DELETE FROM events WHERE seq = ANY($1::bigint[])', [['1', '2', '3']])).rows.map(row => row['QUERY PLAN']).join('\n');
  console.log(`delete plan:\n${deletePlan}`);
  assert.doesNotMatch(deletePlan, /Seq Scan on events/, 'the delete never scans the ledger');

  // Every statement retention runs is timed, and every delete counted.
  const statements: { ms: number; sql: string; deleted?: number }[] = [];
  const timed = { connect: async () => {
    const client = await retention.connect(), query = client.query.bind(client) as (...args: any[]) => Promise<pg.QueryResult>;
    return Object.assign(Object.create(client), { query: async (...args: any[]) => {
      const started = performance.now(), result = await query(...args), sql = String(args[0]);
      statements.push({ ms: performance.now() - started, sql: sql.slice(0, 80), ...(sql.startsWith('DELETE') ? { deleted: result.rowCount ?? 0 } : {}) });
      return result;
    }, release: () => client.release() });
  } } as unknown as pg.Pool;

  // Reads of healthz and /api/events while retention runs.
  let running = true;
  const reads: { path: string; ms: number; status: number; healthy?: boolean }[] = [];
  const reader = (async () => {
    while (running) {
      for (const path of ['/healthz', '/api/events?limit=50']) {
        const started = performance.now();
        const response = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
        const body = await response.json() as { healthy?: boolean };
        reads.push({ path, ms: performance.now() - started, status: response.status, ...(path === '/healthz' ? { healthy: body.healthy } : {}) });
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  })();
  const started = performance.now();
  let runs = 0;
  try {
    for (let run = await compactLedger(timed); runs++, run.cursor !== 0; run = await compactLedger(timed)) assert.ok(runs < 50, 'one pass finishes');
  } finally { running = false; await reader; }
  const passMs = performance.now() - started;

  const slowest = statements.reduce((max, entry) => entry.ms > max.ms ? entry : max);
  const deletes = statements.filter(entry => entry.deleted !== undefined);
  const audits = (await store.pool.query('SELECT payload FROM events WHERE kind=$1', [ledgerCompactedKind])).rows.map(row => row.payload.details.total as number);
  const slowestRead = (path: string) => Math.round(Math.max(...reads.filter(read => read.path === path).map(read => read.ms)));
  console.log(`retention pass: ${runs} runs, ${audits.length} batches, ${deletes.reduce((sum, entry) => sum + entry.deleted!, 0)} rows deleted in ${Math.round(passMs)} ms; largest batch ${Math.max(...audits)} rows (bound ${ledgerCompactionBatch}); slowest statement ${Math.round(slowest.ms)} ms (bound ${statementBoundMs} ms): ${slowest.sql}`);
  console.log(`concurrent reads: ${reads.length}; slowest /healthz ${slowestRead('/healthz')} ms, slowest /api/events ${slowestRead('/api/events?limit=50')} ms (bound ${readBoundMs} ms)`);
  assert.ok(audits.length > 1 && audits.every(n => n <= ledgerCompactionBatch), `every batch deletes at most ${ledgerCompactionBatch} rows: ${audits.join(',')}`);
  assert.ok(deletes.every(entry => entry.deleted! <= ledgerCompactionBatch), 'no delete statement removes more than one batch');
  assert.ok(slowest.ms < statementBoundMs, `the slowest statement took ${Math.round(slowest.ms)} ms: ${slowest.sql}`);
  assert.ok(reads.length >= 4, 'reads ran during retention');
  for (const read of reads) {
    assert.equal(read.status, 200, `${read.path} answered ${read.status}`);
    assert.ok(read.ms < readBoundMs, `${read.path} took ${Math.round(read.ms)} ms`);
    if (read.healthy !== undefined) assert.equal(read.healthy, true, 'healthz stays healthy while retention runs');
  }

  // Only rows inside the retention rule remain: every create row, each item's recent save and the recent loop
  // bookkeeping; no heartbeat or loop-state row past the window.
  const left = Object.fromEntries((await store.pool.query(`SELECT kind || ':' || CASE WHEN created_at < now() - interval '14 days' THEN 'old' ELSE 'recent' END AS k, count(*)::int AS n
    FROM events WHERE kind <> $1 GROUP BY 1`, [ledgerCompactedKind])).rows.map(row => [row.k, row.n]));
  assert.deepEqual(left, { 'create:old': items, 'create:recent': 1, 'heartbeat:recent': items + 1, 'loop-state.saved:recent': recentLoop + 1 });
});
