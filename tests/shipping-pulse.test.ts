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
import { ProductionDelivery } from '../src/production-delivery.js';

let database: EmbeddedPostgres; let store: Store;
before(async () => {
  const port = Number(process.env.GRAPHYARD_PULSE_TEST_PORT ?? 15448);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-pulse-test-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_pulse_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_pulse_test`); await store.init();
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

// The revision the merge execution authorized; the recording observation is one later.
const AUTHORIZED_REVISION = 4;

async function ledgerDelivery(hoursAgo: number, intentHoursBefore: number | null, suffix: string, prHoursBefore: number | null = null) {
  const id = randomUUID(), now = (await store.pool.query('SELECT statement_timestamp() AS now')).rows[0].now as Date;
  const mergedAt = new Date(now.getTime() - hoursAgo * 3_600_000);
  const candidate = { pr: Number(suffix), sha: suffix.padStart(40, 'a'), baseSha: 'b'.repeat(40), branch: `pulse-${suffix}`, author: 'worker' };
  const evidence = { proof: 'integration:pulse', trusted: true, result: 'pass', executed: 1, skipped: 0, sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1 };
  const criteria = [{ proofs: ['integration:pulse'] }];
  // The immutable snapshot the delivery cites, then the observation that recorded it.
  const authorized = { id, key: `GY-${suffix}`, revision: AUTHORIZED_REVISION, candidate, policyRevision: 1, evidence: [evidence], criteria, violations: [] };
  const work = { id, key: `GY-${suffix}`, title: `Delivery ${suffix}`, revision: AUTHORIZED_REVISION + 1, candidate, policyRevision: 1, observation: prHoursBefore === null ? undefined : { prCreatedAt: new Date(mergedAt.getTime() - prHoursBefore * 3_600_000).toISOString() }, delivery: { mergedAt: mergedAt.toISOString(), mergeSha: suffix.padStart(40, 'c'), authorizationRevision: AUTHORIZED_REVISION }, evidence: [evidence], criteria, violations: suffix === '2' ? ['Observed policy context'] : [] };
  await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [id, { id, mutable: true, delivery: { mergedAt: now.toISOString() } }]);
  if (intentHoursBefore !== null) await store.pool.query("INSERT INTO events(work_id,actor,kind,payload,created_at) VALUES($1,'operator','create',$2,$3)", [id, { work: { id, key: work.key } }, new Date(mergedAt.getTime() - intentHoursBefore * 3_600_000)]);
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'coordinator','merge.execution.acquired',$2)", [id, { work: authorized }]);
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'github','github.observed',$2)", [id, { work }]);
  return { id, work, authorized, mergedAt };
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
  assert.deepEqual(pulse.recent[0].quality, { passingProofs: 1, requiredProofs: 1, violations: [] });
  assert.deepEqual(pulse.recent[1].quality.violations, ['Observed policy context']);
});

test('bounded aggregation is served by the delivery and production-merge indexes', async () => {
  // Asserted with sequential scans disabled: the question is whether the indexed key can
  // satisfy the pulse predicate and ordering at all, not what a planner prefers on a small
  // table. A mismatched index expression would still force a sequential scan here.
  const db = await store.pool.connect();
  try {
    await db.query('BEGIN'); await db.query('SET LOCAL enable_seqscan=off');
    const explain = async (sql: string, params: unknown[]) =>
      (await db.query(`EXPLAIN ${sql}`, params)).rows.map(row => row['QUERY PLAN']).join('\n');
    const plan = await explain(`SELECT DISTINCT ON (e.work_id) e.work_id, e.seq
      FROM events e WHERE e.kind='github.observed' AND e.payload->'work'->'delivery'->>'mergedAt' IS NOT NULL
        AND graphyard_instant(e.payload->'work'->'delivery'->>'mergedAt') BETWEEN $1 AND $2
      ORDER BY e.work_id ASC, e.seq ASC`,
      [new Date(Date.now() - 84 * 86_400_000).toISOString(), new Date().toISOString()]);
    // The range must appear as an Index Cond. A text-keyed index still shows up in the
    // plan but demotes the range to a Filter, reading every delivery row in the ledger.
    assert.match(plan, /Index Scan using events_delivery_instant/);
    assert.match(plan, /Index Cond:[^\n]*graphyard_instant/);
    assert.doesNotMatch(plan, /Filter:[^\n]*graphyard_instant/);
    const lookup = await explain(`SELECT pom.deployed_at FROM production_observation_merges pom
      WHERE pom.merge_sha=$1 AND pom.status='succeeded' AND pom.kind='deployment'
      ORDER BY pom.deployed_at ASC, pom.observation_id ASC LIMIT 101`, ['c'.repeat(40)]);
    // The cap stops the scan because the index already supplies deployment order; an index
    // keyed on observation_id would have to sort every mapping for the merge SHA first.
    assert.match(lookup, /Index Only Scan using production_merges_deploy_order/);
    assert.match(lookup, /Index Cond: \(merge_sha =/);
    assert.doesNotMatch(lookup, /Sort Key/);
    const authorization = await explain(`SELECT e.payload->'work' FROM events e
      WHERE e.work_id=$1 AND e.payload ? 'work' AND e.payload->'work'->>'revision'=$2
      ORDER BY e.seq DESC LIMIT 1`, [randomUUID(), String(AUTHORIZED_REVISION)]);
    // Recent-delivery quality resolves one cited revision per delivery. Work identity and
    // revision must both be index conditions, and seq must come from the same index, or the
    // probe degrades into a walk of that work item's whole history.
    assert.match(authorization, /events_work_revision/);
    assert.match(authorization, /Index Cond:[^\n]*revision/);
    assert.doesNotMatch(authorization, /Filter:[^\n]*revision/);
    assert.doesNotMatch(authorization, /Sort Key/);
  } finally { await db.query('ROLLBACK'); db.release(); }
});

test('PR-to-production uses exact retained containment and excludes superseded, rollback, invalid, and missing observations', async () => {
  const delivery = new ProductionDelivery(store);
  const producer = { id: 'deployment-observer', role: 'producer' as const };
  const first = await ledgerDelivery(10, 2, '101', 20);
  const second = await ledgerDelivery(8, 2, '102', 10);
  const outlier = await ledgerDelivery(200, 2, '105', 100);
  const superseded = await ledgerDelivery(6, 2, '103', 12);
  const invalid = await ledgerDelivery(5, 2, '104', -1);
  const observedNow = (await store.pool.query('SELECT statement_timestamp() AS now')).rows[0].now as Date;
  const observe = (deploymentId: string, status: 'succeeded' | 'superseded', kind: 'deployment' | 'rollback', hoursAgo: number, mergeShas: string[]) => delivery.observe(producer, {
    provider: 'railway', deploymentId, status, kind, deployedAt: new Date(observedNow.getTime() - hoursAgo * 3_600_000).toISOString(),
    commitSha: 'd'.repeat(40), sourceUrl: `https://railway.example/deployment/${deploymentId}`, mergeShas,
  }, randomUUID());
  await observe('shared', 'succeeded', 'deployment', 1, [first.work.delivery.mergeSha, second.work.delivery.mergeSha]);
  await observe('slow', 'succeeded', 'deployment', 1, [outlier.work.delivery.mergeSha]);
  await observe('old', 'succeeded', 'deployment', 3, [superseded.work.delivery.mergeSha]);
  await observe('old', 'superseded', 'deployment', 3, []);
  await observe('rollback', 'succeeded', 'rollback', 1, [superseded.work.delivery.mergeSha]);
  await observe('invalid-clock', 'succeeded', 'deployment', 1, [invalid.work.delivery.mergeSha]);
  await assert.rejects(() => delivery.observe({ id: 'worker', role: 'worker' }, { provider: 'railway' }, randomUUID()), /trusted producer/);
  const pulse = await shippingPulse(store.pool);
  assert.deepEqual({ average: pulse.prToProduction.averageHours, median: pulse.prToProduction.medianHours, p90: pulse.prToProduction.p90Hours }, { average: 115, median: 29, p90: 299 });
  assert.equal(pulse.prToProduction.sampleSize, 3);
  assert.deepEqual(pulse.prToProduction.split, { prToMergeAverageHours: 43.3, mergeToProductionAverageHours: 71.7 });
  assert.equal(pulse.prToProduction.exclusions['superseded-deployment'], 1);
  assert.equal(pulse.prToProduction.exclusions['invalid-clock-order'], 1);
  assert.equal(pulse.prToProduction.exclusions['missing-pr-created-at'], 3);
  assert.equal(pulse.prToProduction.sparse, true);
});

test('recorded quality reads the cited authorization snapshot, not requirements revised after it', async () => {
  const id = randomUUID(), now = (await store.pool.query('SELECT statement_timestamp() AS now')).rows[0].now as Date;
  const mergedAt = new Date(now.getTime() - 3_600_000);
  const candidate = { pr: 900, sha: 'e'.repeat(40), baseSha: 'f'.repeat(40), branch: 'quality', author: 'worker' };
  const applicable = { proof: 'integration:pulse', trusted: true, result: 'pass', executed: 2, skipped: 0, sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 3 };
  const authorized = {
    id, key: 'GY-QUALITY', revision: 11, candidate, policyRevision: 3,
    // One required proof; an obsolete pass from an earlier candidate, a pass under an
    // earlier policy revision, a skipped run, and the one pass that authorized the merge.
    evidence: [
      { ...applicable, sha: '0'.repeat(40) },
      { ...applicable, policyRevision: 2 },
      { ...applicable, executed: 1, skipped: 1 },
      applicable,
    ],
    criteria: [{ proofs: ['integration:pulse'] }, { proofs: ['integration:pulse'] }],
    violations: [],
  };
  // A merge observed after its execution expired records the work item as it stands then:
  // the operator has since added a requirement and revised policy, and no evidence can
  // exist for that revision. Reading this snapshot would restate the delivery as 0 of 2.
  const work = {
    ...authorized, revision: 13, title: 'Quality context', policyRevision: 4,
    criteria: [...authorized.criteria, { proofs: ['manual:added-after-the-merge'] }],
    delivery: { mergedAt: mergedAt.toISOString(), mergeSha: '9'.repeat(40), authorizationRevision: authorized.revision },
    violations: ['Post-merge checks differ from the recorded authorization; follow-up required'],
  };
  await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [id, { id }]);
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'coordinator','merge.execution.acquired',$2)", [id, { work: authorized }]);
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'github','github.observed',$2)", [id, { work }]);
  const pulse = await shippingPulse(store.pool);
  const entry = pulse.recent.find(item => item.key === 'GY-QUALITY');
  // The authorized totals stand, and the violation the delivery itself recorded is kept.
  assert.deepEqual(entry!.quality, { passingProofs: 1, requiredProofs: 1, violations: ['Post-merge checks differ from the recorded authorization; follow-up required'] });
});

test('a delivery whose cited authorization is not retained reports unknown proofs, never zero', async () => {
  const id = randomUUID(), now = (await store.pool.query('SELECT statement_timestamp() AS now')).rows[0].now as Date;
  const mergedAt = new Date(now.getTime() - 3 * 3_600_000);
  const work = {
    id, key: 'GY-UNRESOLVED', title: 'Unretained authorization', revision: 40,
    candidate: { pr: 902, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, policyRevision: 1,
    delivery: { mergedAt: mergedAt.toISOString(), mergeSha: '7'.repeat(40), authorizationRevision: 39 },
    evidence: [], criteria: [{ proofs: ['integration:pulse'] }], violations: [],
  };
  await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [id, { id }]);
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'github','github.observed',$2)", [id, { work }]);
  const pulse = await shippingPulse(store.pool);
  const entry = pulse.recent.find(item => item.key === 'GY-UNRESOLVED');
  assert.equal(entry!.quality.passingProofs, null); assert.equal(entry!.quality.requiredProofs, null);
  assert.match(entry!.quality.unavailableReason!, /no longer in the retained ledger/);
});

test('delivery timestamps are read as instants regardless of the recorded offset', async () => {
  const now = (await store.pool.query('SELECT statement_timestamp() AS now')).rows[0].now as Date;
  const mergedAt = new Date(now.getTime() - 2 * 3_600_000);
  // Same instant, written with a +05:30 offset instead of Z. Text ordering would sort it
  // wrongly; the indexed instant expression must place it exactly two hours ago.
  const shifted = new Date(mergedAt.getTime() + 5.5 * 3_600_000).toISOString().replace('Z', '+05:30');
  const id = randomUUID();
  const work = { id, key: 'GY-OFFSET', title: 'Offset delivery', candidate: { pr: 901, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, policyRevision: 1, delivery: { mergedAt: shifted, mergeSha: '8'.repeat(40), authorizationRevision: 1 }, evidence: [], criteria: [], violations: [] };
  await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [id, { id }]);
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'github','github.observed',$2)", [id, { work }]);
  const parsed = (await store.pool.query('SELECT graphyard_instant($1) AS at', [shifted])).rows[0].at as Date;
  assert.equal(parsed.getTime(), mergedAt.getTime());
  const pulse = await shippingPulse(store.pool);
  const entry = pulse.recent.find(item => item.key === 'GY-OFFSET');
  assert.equal(Date.parse(entry!.mergedAt), mergedAt.getTime());
});

test('API requires authentication and bounded larger histories are explicitly partial', async () => {
  await store.pool.query(`WITH generated AS (SELECT i, ('10000000-0000-0000-0000-' || lpad(i::text,12,'0'))::uuid id FROM generate_series(1,$1) i),
    inserted AS (INSERT INTO work_items(id,document) SELECT id,jsonb_build_object('id',id) FROM generated RETURNING id)
    INSERT INTO events(work_id,actor,kind,payload)
    SELECT id,'github','github.observed',jsonb_build_object('work',jsonb_build_object('id',id,'key','GY-BULK-'||row_number() OVER (),'title','Bulk','candidate',jsonb_build_object('pr',1),'delivery',jsonb_build_object('mergedAt',(statement_timestamp()-interval '2 days')::text,'mergeSha',repeat('d',40)),'criteria','[]'::jsonb,'evidence','[]'::jsonb,'violations','[]'::jsonb)) FROM inserted`, [SHIPPING_PULSE_LIMIT + 1]);
  const pulse = await shippingPulse(store.pool);
  assert.equal(pulse.completeness, 'partial'); assert.match(pulse.partialReason!, /lower-bound samples/); assert.equal(pulse.recent.length, 10);
  const http = server(new Engine(store, [15368], 120, 'owner/project'), [{ id: 'reader', role: 'reader', token: 'r'.repeat(32) }, { id: 'producer', role: 'producer', token: 'p'.repeat(32) }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(http.address() as any).port}`;
  try {
    assert.equal((await fetch(`${origin}/api/shipping-pulse`)).status, 401);
    const response = await fetch(`${origin}/api/shipping-pulse`, { headers: { Authorization: `Bearer ${'r'.repeat(32)}` } });
    assert.equal(response.status, 200); assert.equal((await response.json()).completeness, 'partial');
    const denied = await fetch(`${origin}/api/production-observations`, { method: 'POST', headers: { Authorization: `Bearer ${'r'.repeat(32)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: '{}' });
    assert.equal(denied.status, 403);
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
});
