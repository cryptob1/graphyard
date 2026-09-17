import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { shippingPulse, SHIPPING_PULSE_LIMIT } from '../src/shipping-pulse.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';

let database: EmbeddedPostgres; let store: Store;
before(async () => {
  const port = Number(process.env.GRAPHYARD_PULSE_TEST_PORT ?? 15448);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-pulse-test-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_pulse_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_pulse_test`); await store.init();
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

async function ledgerDelivery(hoursAgo: number, intentHoursBefore: number | null, suffix: string) {
  const id = randomUUID(), now = (await store.pool.query('SELECT statement_timestamp() AS now')).rows[0].now as Date;
  const mergedAt = new Date(now.getTime() - hoursAgo * 3_600_000);
  const candidate = { pr: Number(suffix), sha: suffix.padStart(40, 'a'), baseSha: 'b'.repeat(40), branch: `pulse-${suffix}`, author: 'worker' };
  const work = { id, key: `GY-${suffix}`, title: `Delivery ${suffix}`, candidate, delivery: { mergedAt: mergedAt.toISOString(), mergeSha: suffix.padStart(40, 'c'), authorizationRevision: 1 }, evidence: [{ trusted: true, result: 'pass', executed: 1, skipped: 0 }], criteria: [{ proofs: ['integration:pulse'] }], violations: suffix === '2' ? ['Observed policy context'] : [] };
  await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [id, { id, mutable: true, delivery: { mergedAt: now.toISOString() } }]);
  if (intentHoursBefore !== null) await store.pool.query("INSERT INTO events(work_id,actor,kind,payload,created_at) VALUES($1,'operator','create',$2,$3)", [id, { work: { id, key: work.key } }, new Date(mergedAt.getTime() - intentHoursBefore * 3_600_000)]);
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'github','github.observed',$2)", [id, { work }]);
  return { id, work };
}

test('pulse uses exact append-only deliveries, deduplicates, orders, and computes documented windows and median', async () => {
  const first = await ledgerDelivery(24, 2, '1');
  const second = await ledgerDelivery(10 * 24, 4, '2');
  await ledgerDelivery(40 * 24, null, '3');
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'github','github.observed',$2)", [first.id, { work: first.work }]);
  const fake = await store.pool.query('SELECT id FROM work_items WHERE id<>$1 LIMIT 1', [first.id]);
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'worker','submit',$2)", [fake.rows[0].id, { work: { ...second.work, key: 'GY-FAKE' } }]);
  const pulse = await shippingPulse(store.pool);
  assert.equal(pulse.completeness, 'complete');
  assert.equal(pulse.counts.days7, 1); assert.equal(pulse.counts.days30, 2);
  assert.equal(pulse.weeks.length, 12); assert.equal(pulse.weeks.reduce((sum, week) => sum + week.count, 0), 3);
  assert.deepEqual(pulse.intentToMerge, { medianHours: 3, sampleSize: 2, excluded: 1 });
  assert.deepEqual(pulse.recent.map(item => item.key), ['GY-1', 'GY-2', 'GY-3']);
  assert.deepEqual(pulse.recent[1].quality.violations, ['Observed policy context']);
});

test('API requires authentication and bounded larger histories are explicitly partial', async () => {
  await store.pool.query(`WITH generated AS (SELECT i, ('10000000-0000-0000-0000-' || lpad(i::text,12,'0'))::uuid id FROM generate_series(1,$1) i),
    inserted AS (INSERT INTO work_items(id,document) SELECT id,jsonb_build_object('id',id) FROM generated RETURNING id)
    INSERT INTO events(work_id,actor,kind,payload)
    SELECT id,'github','github.observed',jsonb_build_object('work',jsonb_build_object('id',id,'key','GY-BULK-'||row_number() OVER (),'title','Bulk','candidate',jsonb_build_object('pr',1),'delivery',jsonb_build_object('mergedAt',(statement_timestamp()-interval '2 days')::text,'mergeSha',repeat('d',40)),'criteria','[]'::jsonb,'evidence','[]'::jsonb,'violations','[]'::jsonb)) FROM inserted`, [SHIPPING_PULSE_LIMIT + 1]);
  const pulse = await shippingPulse(store.pool);
  assert.equal(pulse.completeness, 'partial'); assert.match(pulse.partialReason!, /lower-bound samples/); assert.equal(pulse.recent.length, 10);
  const http = server(new Engine(store, [15368], 120, 'owner/project'), [{ id: 'reader', role: 'reader', token: 'r'.repeat(32) }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(http.address() as any).port}`;
  try {
    assert.equal((await fetch(`${origin}/api/shipping-pulse`)).status, 401);
    const response = await fetch(`${origin}/api/shipping-pulse`, { headers: { Authorization: `Bearer ${'r'.repeat(32)}` } });
    assert.equal(response.status, 200); assert.equal((await response.json()).completeness, 'partial');
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
});
