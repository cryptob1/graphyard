import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, DELIVERY_EVENT_PREDICATE, DELIVERY_REPOSITORY_INSTANT } from '../src/store.js';
import { shippingPulse, SHIPPING_PULSE_LIMIT } from '../src/shipping-pulse.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { ProductionDelivery, PRODUCTION_CLOCK_PRECISION_MS } from '../src/production-delivery.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

let database: EmbeddedPostgres; let store: Store;
before(async () => {
  const port = Number(process.env.GRAPHYARD_PULSE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 9);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('pulse-test'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
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
  assert.equal(pulse.completeness, 'complete'); assert.equal(pulse.truncated, false);
  assert.equal(pulse.counts.days7, 1); assert.equal(pulse.counts.days30, 2);
  assert.equal(pulse.weeks.length, 12); assert.equal(pulse.weeks.reduce((sum, week) => sum + week.count, 0), 3);
  assert.deepEqual(pulse.intentToMerge, { medianHours: 3, sampleSize: 2, excluded: 1 });
  assert.deepEqual(pulse.recent.map(item => item.key), ['GY-1', 'GY-2', 'GY-3']);
  assert.deepEqual(pulse.recent[0].quality, { passingProofs: 1, requiredProofs: 1, violations: [] });
  assert.deepEqual(pulse.recent[1].quality.violations, ['Observed policy context']);
});

test('deduplication is global, so a delivery from before the window is never recounted inside it', async () => {
  const before = await shippingPulse(store.pool);
  const now = (await store.pool.query('SELECT statement_timestamp() AS now')).rows[0].now as Date;
  const id = randomUUID();
  // Delivered well outside the 12-week reporting window - and outside any scan of it.
  const deliveredAt = new Date(now.getTime() - 200 * 86_400_000);
  const base = {
    id, key: 'GY-RECOUNT', title: 'Delivered long ago', revision: 2,
    candidate: { pr: 600, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, policyRevision: 1,
    evidence: [], criteria: [], violations: [],
  };
  const delivery = (mergedAt: Date) => ({ mergedAt: mergedAt.toISOString(), mergedAtRepository: mergedAt.toISOString(), repositoryClockOffsetMs: 0, mergeSha: '5'.repeat(40), authorizationRevision: 1 });
  await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [id, { id }]);
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'github','github.observed',$2)", [id, { work: { ...base, delivery: delivery(deliveredAt) } }]);
  // Months later the item is observed again - a re-observation, a follow-up check, any
  // event that carries the work document forward. This snapshot still describes the same
  // single delivery, but a lifecycle field moved its recorded merge time into the window.
  // Filtering the window before deduplicating would treat this event as the item's first
  // delivery, count a second delivery for a work item that shipped once, and file it under
  // the wrong week. Deduplicating globally first settles the item on its real first
  // delivery event, which is outside the window, so the window contains nothing for it.
  const inWindow = new Date(now.getTime() - 3 * 86_400_000);
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'github','github.observed',$2)", [id, { work: { ...base, revision: 3, delivery: delivery(inWindow) } }]);
  const after = await shippingPulse(store.pool);
  assert.equal(after.counts.days7 - before.counts.days7, 0, 'a delivery from before the window is not recounted inside it');
  assert.equal(after.counts.days30 - before.counts.days30, 0);
  assert.equal(after.weeks.reduce((sum, week) => sum + week.count, 0) - before.weeks.reduce((sum, week) => sum + week.count, 0), 0);
  assert.equal(after.recent.filter(item => item.key === 'GY-RECOUNT').length, 0);
  // The scanned event range still reaches the later snapshot, so the regression is about
  // ordering deduplication before filtering rather than about how far the scan reaches.
  const scanned = await store.pool.query(`SELECT count(*)::int AS matches FROM events
    WHERE ${DELIVERY_EVENT_PREDICATE} AND work_id=$1 AND ${DELIVERY_REPOSITORY_INSTANT} BETWEEN $2 AND $3`,
    [id, new Date(now.getTime() - 84 * 86_400_000).toISOString(), now.toISOString()]);
  assert.equal(scanned.rows[0].matches, 1, 'the later delivery-bearing snapshot is inside the scanned window');
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
    const plan = await explain(`SELECT DISTINCT ON (work_id) work_id, seq
      FROM events WHERE kind='github.observed' AND payload->'work'->'delivery'->>'mergedAt' IS NOT NULL
        AND ${DELIVERY_REPOSITORY_INSTANT} BETWEEN $1 AND $2
      ORDER BY work_id ASC, seq ASC`,
      [new Date(Date.now() - 84 * 86_400_000).toISOString(), new Date().toISOString()]);
    // The range must appear as an Index Cond. An index keyed on any other expression -
    // text, or the provider merge timestamp the pulse no longer compares against the
    // repository clock - still shows up in the plan but demotes the range to a Filter,
    // reading every delivery row in the ledger.
    assert.match(plan, /Index Scan using events_delivery_repository_instant/);
    assert.match(plan, /Index Cond:[^\n]*graphyard_instant/);
    assert.doesNotMatch(plan, /Filter:[^\n]*graphyard_instant/);
    // Global deduplication costs one probe per in-window candidate, and that probe has to
    // be an exact index lookup: the first delivery-bearing event for a work item is not
    // findable from the window index, and scanning the item's history for it would put an
    // unbounded walk inside a per-row subquery.
    const firstDelivery = await explain(`SELECT first.seq FROM events first
      WHERE first.work_id=$1 AND ${DELIVERY_EVENT_PREDICATE}
      ORDER BY first.seq ASC LIMIT 1`, [randomUUID()]);
    assert.match(firstDelivery, /Index Only Scan using events_delivery_first/);
    assert.match(firstDelivery, /Index Cond: \(work_id =/);
    assert.doesNotMatch(firstDelivery, /Sort Key/);
    const lookup = await explain(`SELECT pom.observation_id FROM production_observation_merges pom
      WHERE pom.merge_sha=$1 AND pom.status='succeeded' AND pom.kind='deployment'
      ORDER BY pom.deployed_at_repository ASC, pom.observation_id ASC LIMIT 101`, ['c'.repeat(40)]);
    // The cap stops the scan because the index already supplies deployment order on the
    // repository clock - the clock the durations are published on. Keyed on observation_id
    // it would sort every mapping for the merge SHA first; keyed on the raw provider
    // timestamp the cap would stop at the wrong 101 whenever that clock is offset.
    assert.match(lookup, /Index Only Scan using production_merges_repository_order/);
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
  const producer = { id: 'deployment-observer', role: 'producer' as const, deploymentProviders: ['railway'] };
  const first = await ledgerDelivery(10, 2, '101', 20);
  const second = await ledgerDelivery(8, 2, '102', 10);
  const outlier = await ledgerDelivery(200, 2, '105', 100);
  const superseded = await ledgerDelivery(6, 2, '103', 12);
  const invalid = await ledgerDelivery(5, 2, '104', -1);
  const observedNow = (await store.pool.query('SELECT statement_timestamp() AS now')).rows[0].now as Date;
  // This provider's clock was measured to stand with the repository's, so the recorded
  // repository instants equal the reported ones and the arithmetic below is unchanged.
  const clockOffset = { min: 0, max: 0 };
  const observe = (deploymentId: string, status: 'succeeded' | 'superseded', kind: 'deployment' | 'rollback', hoursAgo: number, mergeShas: string[]) => delivery.observe(producer, {
    provider: 'railway', deploymentId, status, kind, deployedAt: new Date(observedNow.getTime() - hoursAgo * 3_600_000).toISOString(), clockOffset,
    commitSha: 'd'.repeat(40), sourceUrl: `https://railway.example/deployment/${deploymentId}`, mergeShas,
  }, randomUUID());
  await observe('shared', 'succeeded', 'deployment', 1, [first.work.delivery.mergeSha, second.work.delivery.mergeSha]);
  await observe('slow', 'succeeded', 'deployment', 1, [outlier.work.delivery.mergeSha]);
  await observe('old', 'succeeded', 'deployment', 3, [superseded.work.delivery.mergeSha]);
  await observe('old', 'superseded', 'deployment', 3, []);
  await observe('rollback', 'succeeded', 'rollback', 1, [superseded.work.delivery.mergeSha]);
  await observe('invalid-clock', 'succeeded', 'deployment', 1, [invalid.work.delivery.mergeSha]);
  await assert.rejects(() => delivery.observe({ id: 'worker', role: 'worker' }, { provider: 'railway' }, randomUUID()), /trusted producer/);
  // Deployment authority is its own lane. An acceptance collector holds the same
  // `producer` role and a proof allowlist, and that allowlist must not let it forge
  // production-delivery history; a deployment observer scoped to one provider must not
  // reach another. Neither denial is repaired by widening the proof allowlist.
  await assert.rejects(() => delivery.observe({ id: 'test-collector', role: 'producer', proofs: ['integration:pulse'] },
    { provider: 'railway', deploymentId: 'forged', status: 'succeeded', kind: 'deployment', deployedAt: new Date(observedNow.getTime() - 3_600_000).toISOString(), clockOffset, commitSha: 'd'.repeat(40), sourceUrl: 'https://railway.example/deployment/forged', mergeShas: [first.work.delivery.mergeSha] },
    randomUUID()), /no deployment-observer authority/);
  await assert.rejects(() => delivery.observe({ id: 'other-provider-observer', role: 'producer', deploymentProviders: ['fly'] },
    { provider: 'railway', deploymentId: 'out-of-scope', status: 'succeeded', kind: 'deployment', deployedAt: new Date(observedNow.getTime() - 3_600_000).toISOString(), clockOffset, commitSha: 'd'.repeat(40), sourceUrl: 'https://railway.example/deployment/out-of-scope', mergeShas: [first.work.delivery.mergeSha] },
    randomUUID()), /does not cover this provider/);
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

test('recorded quality re-checks evidence expiry on the authorization clock, not the provider clock', async () => {
  const id = randomUUID(), now = (await store.pool.query('SELECT statement_timestamp() AS now')).rows[0].now as Date;
  // The repository clock trails GitHub's. `Engine.observe` therefore authorized this
  // merge at a cutoff that precedes the raw provider `mergedAt`, and the evidence expiry
  // falls between the two: live when the merge was authorized, expired at the provider
  // instant. Re-checking on the provider clock would restate an authorized delivery as
  // unproven, so the delivery carries the instant the judgement actually used.
  const mergedAt = new Date(now.getTime() - 3_600_000);
  const evidenceAsOf = new Date(mergedAt.getTime() - 20_000);
  const expiresAt = new Date(mergedAt.getTime() - 10_000);
  const candidate = { pr: 903, sha: '1'.repeat(40), baseSha: '2'.repeat(40), branch: 'skewed', author: 'worker' };
  const evidence = { proof: 'integration:pulse', trusted: true, result: 'pass', executed: 1, skipped: 0, sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1, expiresAt: expiresAt.toISOString() };
  const authorized = { id, key: 'GY-SKEW', revision: 20, candidate, policyRevision: 1, evidence: [evidence], criteria: [{ proofs: ['integration:pulse'] }], violations: [] };
  const work = { ...authorized, revision: 21, title: 'Clock-skewed delivery', delivery: { mergedAt: mergedAt.toISOString(), mergeSha: '6'.repeat(40), authorizationRevision: authorized.revision, evidenceAsOf: evidenceAsOf.toISOString() } };
  await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [id, { id }]);
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'coordinator','merge.execution.acquired',$2)", [id, { work: authorized }]);
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'github','github.observed',$2)", [id, { work }]);
  const pulse = await shippingPulse(store.pool);
  const entry = pulse.recent.find(item => item.key === 'GY-SKEW');
  assert.deepEqual(entry!.quality, { passingProofs: 1, requiredProofs: 1, violations: [] });
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

test('repository-clock comparisons use the merge instant the delivery carried onto that clock', async () => {
  const before = await shippingPulse(store.pool);
  const now = (await store.pool.query('SELECT statement_timestamp() AS now')).rows[0].now as Date;
  // The repository clock runs ten minutes ahead of GitHub's. Merge verification bounds how
  // precisely that offset is measured, not how large it can be, and afterwards the recorded
  // instant is the only thing relating the two clocks. Every value below is stated on the
  // clock that produced it, exactly as the ledger holds them.
  const offsetMs = 600_000;
  const record = async (key: string, repositoryMergedAt: Date, mergeSha: string, times: { intentAt?: Date; prCreatedAt?: Date } = {}) => {
    const id = randomUUID(), providerMergedAt = new Date(repositoryMergedAt.getTime() - offsetMs);
    const work = {
      id, key, title: key, revision: 2, candidate: { pr: 800, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, policyRevision: 1,
      ...(times.prCreatedAt ? { observation: { prCreatedAt: times.prCreatedAt.toISOString() } } : {}),
      delivery: { mergedAt: providerMergedAt.toISOString(), mergedAtRepository: repositoryMergedAt.toISOString(), repositoryClockOffsetMs: offsetMs, mergeSha, authorizationRevision: 1 },
      evidence: [], criteria: [], violations: [],
    };
    await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [id, { id }]);
    if (times.intentAt) await store.pool.query("INSERT INTO events(work_id,actor,kind,payload,created_at) VALUES($1,'operator','create',$2,$3)", [id, { work: { id, key } }, times.intentAt]);
    await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'github','github.observed',$2)", [id, { work }]);
  };
  // A minute inside the seven-day window on the repository clock, nine minutes outside it
  // on GitHub's. The raw provider timestamp would drop it from the window entirely.
  await record('GY-CLOCK-WINDOW', new Date(now.getTime() - 7 * 86_400_000 + 60_000), '1'.repeat(40));
  // The newest delivery. Its append-only intent event was written five minutes after the
  // raw provider merge timestamp and five minutes before the repository merge instant, so
  // judging the interval on the provider clock reads the work as created after it merged
  // and silently drops it from the median instead of measuring five minutes. Its pull
  // request was created two minutes after the merge on GitHub's own clock, which stays a
  // genuine ordering violation only because that timestamp is carried across with the same
  // offset rather than compared raw against a repository instant.
  const newest = new Date(now.getTime() - 60_000);
  await record('GY-CLOCK-INTENT', newest, '2'.repeat(40),
    { intentAt: new Date(newest.getTime() - offsetMs + 300_000), prCreatedAt: new Date(newest.getTime() - offsetMs + 120_000) });
  await new ProductionDelivery(store).observe({ id: 'deployment-observer', role: 'producer', deploymentProviders: ['railway'] }, {
    provider: 'railway', deploymentId: 'clock-order', status: 'succeeded', kind: 'deployment', deployedAt: new Date(now.getTime() - 30_000).toISOString(), clockOffset: { min: 0, max: 0 },
    commitSha: 'a'.repeat(40), sourceUrl: 'https://railway.example/deployment/clock-order', mergeShas: ['2'.repeat(40)],
  }, randomUUID());
  const after = await shippingPulse(store.pool);
  assert.equal(after.counts.days7 - before.counts.days7, 2, 'the seven-day window admits the boundary delivery on the repository clock');
  assert.equal(after.recent[0].key, 'GY-CLOCK-INTENT');
  assert.equal(Date.parse(after.recent[0].mergedAt), newest.getTime(), 'the reported merge instant is the repository-clock one');
  assert.equal(after.intentToMerge.sampleSize - before.intentToMerge.sampleSize, 1, 'the intent interval is measured, not discarded as out of order');
  assert.equal((after.prToProduction.exclusions['invalid-clock-order'] ?? 0) - (before.prToProduction.exclusions['invalid-clock-order'] ?? 0), 1,
    'a pull request created after its own merge stays an ordering violation once both provider times are carried across together');
});

test('production durations are measured on one clock whether the provider runs fast or slow', async () => {
  const before = await shippingPulse(store.pool);
  const delivery = new ProductionDelivery(store);
  const producer = { id: 'deployment-observer', role: 'producer' as const, deploymentProviders: ['fast', 'slow'] };
  const now = (await store.pool.query('SELECT statement_timestamp() AS now')).rows[0].now as Date;
  // Two deliveries an hour apart on the repository clock, each deployed exactly one hour
  // after its own merge. Nothing about the deployments differs except the clock that
  // timestamped them.
  const record = async (key: string, mergeSha: string, mergedAgoHours: number) => {
    const id = randomUUID(), mergedAt = new Date(now.getTime() - mergedAgoHours * 3_600_000);
    const work = {
      id, key, title: key, revision: 2, candidate: { pr: 700, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, policyRevision: 1,
      observation: { prCreatedAt: new Date(mergedAt.getTime() - 3_600_000).toISOString() },
      delivery: { mergedAt: mergedAt.toISOString(), mergedAtRepository: mergedAt.toISOString(), repositoryClockOffsetMs: 0, mergeSha, authorizationRevision: 1 },
      evidence: [], criteria: [], violations: [],
    };
    await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [id, { id }]);
    await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'github','github.observed',$2)", [id, { work }]);
    return mergedAt;
  };
  const fastMerge = await record('GY-FAST-CLOCK', '3'.repeat(40), 10);
  const slowMerge = await record('GY-SLOW-CLOCK', '4'.repeat(40), 9);
  const aheadMs = 2 * 3_600_000;
  // A provider clock running two hours fast stamps a deployment that really happened one
  // hour after its merge as three hours after it. Reported raw, the published
  // merge-to-production duration is inflated by the entire offset.
  await delivery.observe(producer, {
    provider: 'fast', deploymentId: 'ahead', status: 'succeeded', kind: 'deployment',
    deployedAt: new Date(fastMerge.getTime() + 3_600_000 + aheadMs).toISOString(), clockOffset: { min: -aheadMs, max: -aheadMs },
    commitSha: 'b'.repeat(40), sourceUrl: 'https://railway.example/deployment/ahead', mergeShas: ['3'.repeat(40)],
  }, randomUUID());
  // A provider clock running two hours slow stamps the same deployment an hour *before*
  // its own merge. Compared raw against the repository merge instant it is discarded as
  // unverifiable, losing a real production endpoint rather than merely biasing one.
  await delivery.observe(producer, {
    provider: 'slow', deploymentId: 'behind', status: 'succeeded', kind: 'deployment',
    deployedAt: new Date(slowMerge.getTime() + 3_600_000 - aheadMs).toISOString(), clockOffset: { min: aheadMs, max: aheadMs },
    commitSha: 'c'.repeat(40), sourceUrl: 'https://railway.example/deployment/behind', mergeShas: ['4'.repeat(40)],
  }, randomUUID());
  const after = await shippingPulse(store.pool);
  assert.equal(after.prToProduction.sampleSize - before.prToProduction.sampleSize, 2,
    'a deployment stamped before its merge by a slow provider clock is still a verified endpoint');
  assert.equal((after.prToProduction.exclusions['no-verifiable-production-deployment'] ?? 0)
    - (before.prToProduction.exclusions['no-verifiable-production-deployment'] ?? 0), 0);
  // Both deployments ran one hour after their merge and two hours after their pull request
  // was created, whichever clock is asked. The ledger holds earlier deliveries too, so the
  // two new samples are read out of the published averages by weight. The tolerance covers
  // only the tenth-of-an-hour rounding the response applies; reading the fast provider's
  // timestamp raw would contribute three hours per sample instead of one.
  const weighted = (pulse: Awaited<ReturnType<typeof shippingPulse>>, hours: number | null) => (hours ?? 0) * pulse.prToProduction.sampleSize;
  const tolerance = 0.05 * (before.prToProduction.sampleSize + after.prToProduction.sampleSize);
  const contributed = (pick: (value: typeof after.prToProduction) => number | null) =>
    weighted(after, pick(after.prToProduction)) - weighted(before, pick(before.prToProduction));
  assert.ok(Math.abs(contributed(value => value.split.mergeToProductionAverageHours) - 2) <= tolerance,
    'each deployment contributes the one hour it actually took, not the offset of the clock that stamped it');
  assert.ok(Math.abs(contributed(value => value.split.prToMergeAverageHours) - 2) <= tolerance);
  assert.ok(Math.abs(contributed(value => value.averageHours) - 4) <= tolerance);
});

test('a deployment whose measured clock bracket is too wide or still in the future is refused', async () => {
  const delivery = new ProductionDelivery(store);
  const producer = { id: 'deployment-observer', role: 'producer' as const, deploymentProviders: ['railway'] };
  const now = (await store.pool.query('SELECT statement_timestamp() AS now')).rows[0].now as Date;
  const reported = (deploymentId: string, deployedAt: Date, clockOffset: { min: number; max: number }) => ({
    provider: 'railway', deploymentId, status: 'succeeded' as const, kind: 'deployment' as const,
    deployedAt: deployedAt.toISOString(), clockOffset, commitSha: 'b'.repeat(40),
    sourceUrl: `https://railway.example/deployment/${deploymentId}`, mergeShas: ['b'.repeat(40)],
  });
  // A bracket this wide does not locate the deployment on the repository clock well enough
  // to attribute it to an instant, so it is refused rather than normalized by its midpoint.
  await assert.rejects(() => delivery.observe(producer, reported('imprecise', new Date(now.getTime() - 3_600_000),
    { min: 0, max: PRODUCTION_CLOCK_PRECISION_MS * 2 }), randomUUID()), /measured to within/);
  await assert.rejects(() => delivery.observe(producer, reported('inverted', new Date(now.getTime() - 3_600_000),
    { min: 1000, max: -1000 }), randomUUID()), /inverted/);
  // A provider clock running fast no longer loses the observation: the measured offset
  // carries the timestamp back onto the repository clock, where it is already in the past.
  const accepted = await delivery.observe(producer, reported('fast-but-real', new Date(now.getTime() + 60_000), { min: -120_000, max: -110_000 }), randomUUID());
  assert.equal(accepted.status, 'succeeded');
  assert.ok(Date.parse(accepted.deployedAtRepository) <= now.getTime());
  // Even at its earliest bound this one has not happened yet, so no reading of the two
  // clocks makes the report possible and it is refused rather than recorded as fact.
  await assert.rejects(() => delivery.observe(producer, reported('impossible', new Date(now.getTime() + 600_000), { min: 0, max: 0 }), randomUUID()), /still in the future/);
});

test('API requires authentication and bounded larger histories are explicitly partial', async () => {
  await store.pool.query(`WITH generated AS (SELECT i, ('10000000-0000-0000-0000-' || lpad(i::text,12,'0'))::uuid id FROM generate_series(1,$1) i),
    inserted AS (INSERT INTO work_items(id,document) SELECT id,jsonb_build_object('id',id) FROM generated RETURNING id)
    INSERT INTO events(work_id,actor,kind,payload)
    SELECT id,'github','github.observed',jsonb_build_object('work',jsonb_build_object('id',id,'key','GY-BULK-'||row_number() OVER (),'title','Bulk','candidate',jsonb_build_object('pr',1),'delivery',jsonb_build_object('mergedAt',(statement_timestamp()-interval '2 days')::text,'mergeSha',repeat('d',40)),'criteria','[]'::jsonb,'evidence','[]'::jsonb,'violations','[]'::jsonb)) FROM inserted`, [SHIPPING_PULSE_LIMIT + 1]);
  const pulse = await shippingPulse(store.pool);
  assert.equal(pulse.completeness, 'partial'); assert.equal(pulse.truncated, true); assert.equal(pulse.recent.length, 10);
  // Truncation makes the counts lower bounds; it does not make the durations bounds, and
  // the explanation must not describe them as if it did.
  assert.match(pulse.partialReason!, /counts are lower bounds/i);
  assert.match(pulse.partialReason!, /durations are not bounds/i);
  assert.doesNotMatch(pulse.partialReason!, /statistics are lower-bound/i);
  const http = server(new Engine(store, [15368], 120, 'owner/project'), [{ id: 'reader', role: 'reader', token: 'r'.repeat(32) }, { id: 'producer', role: 'producer', deploymentProviders: ['railway'], token: 'p'.repeat(32) }, { id: 'collector', role: 'producer', proofs: ['integration:pulse'], token: 'c'.repeat(32) }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(http.address() as any).port}`;
  try {
    assert.equal((await fetch(`${origin}/api/shipping-pulse`)).status, 401);
    const response = await fetch(`${origin}/api/shipping-pulse`, { headers: { Authorization: `Bearer ${'r'.repeat(32)}` } });
    assert.equal(response.status, 200); assert.equal((await response.json()).completeness, 'partial');
    const denied = await fetch(`${origin}/api/production-observations`, { method: 'POST', headers: { Authorization: `Bearer ${'r'.repeat(32)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: '{}' });
    assert.equal(denied.status, 403);
    // A configured producer without an explicit deployment-observer scope is denied over
    // HTTP too, so a proof-collector credential cannot reach the ingestion path at all.
    const unscoped = await fetch(`${origin}/api/production-observations`, { method: 'POST', headers: { Authorization: `Bearer ${'c'.repeat(32)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ provider: 'railway', deploymentId: 'deploy-unscoped', status: 'succeeded', kind: 'deployment', deployedAt: new Date(Date.now() - 3_600_000).toISOString(), clockOffset: { min: 0, max: 0 }, commitSha: 'e'.repeat(40), sourceUrl: 'https://railway.app/deploy/unscoped', mergeShas: ['f'.repeat(40)] }) });
    assert.equal(unscoped.status, 403);
    assert.match((await unscoped.json()).error ?? '', /deployment-observer authority/);
    // An over-long key would otherwise reach the receipts primary key and exceed the
    // B-tree entry limit, turning a valid observation into a 500.
    const oversized = await fetch(`${origin}/api/production-observations`, { method: 'POST', headers: { Authorization: `Bearer ${'p'.repeat(32)}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'k'.repeat(3000) }, body: JSON.stringify({ provider: 'railway', deploymentId: 'deploy-oversized', status: 'succeeded', kind: 'deployment', deployedAt: new Date(Date.now() - 3_600_000).toISOString(), clockOffset: { min: 0, max: 0 }, commitSha: 'e'.repeat(40), sourceUrl: 'https://railway.app/deploy/oversized', mergeShas: ['f'.repeat(40)] }) });
    assert.equal(oversized.status, 400);
    assert.match((await oversized.json()).error ?? '', /Idempotency-Key/);
    const accepted = await fetch(`${origin}/api/production-observations`, { method: 'POST', headers: { Authorization: `Bearer ${'p'.repeat(32)}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'k'.repeat(200) }, body: JSON.stringify({ provider: 'railway', deploymentId: 'deploy-bounded', status: 'succeeded', kind: 'deployment', deployedAt: new Date(Date.now() - 3_600_000).toISOString(), clockOffset: { min: 0, max: 0 }, commitSha: 'e'.repeat(40), sourceUrl: 'https://railway.app/deploy/bounded', mergeShas: ['f'.repeat(40)] }) });
    assert.equal(accepted.status, 200);
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
});
