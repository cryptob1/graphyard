import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { FLOW_DEPLOYMENT_ENDPOINT, PRODUCTION_OBSERVATION_ENDPOINT, shippingPulse, type ShippingPulse } from '../src/shipping-pulse.js';
import { ProductionDelivery } from '../src/production-delivery.js';
import { ShippingPulseView } from '../web/shipping-pulse.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-129: the PR-to-production split must say when it has no inputs at all, must count a
// delivery the master verified with `master verify-deployment`, and must never show a
// coverage figure without the reason behind it.

let database: EmbeddedPostgres; let store: Store;
before(async () => {
  const port = Number(process.env.GRAPHYARD_PULSE_COVERAGE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 46);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('pulse-coverage-test'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_pulse_coverage_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_pulse_coverage_test`); await store.init();
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const AUTHORIZED_REVISION = 4;
const repositoryNow = async () => (await store.pool.query('SELECT statement_timestamp() AS now')).rows[0].now as Date;

/**
 * One delivered work item as the ledger records it: the create event, the immutable snapshot
 * the delivery cites, and the observation that recorded the merge with GitHub's pull-request
 * creation time. The mutable document is a full delivered work item, so the engine can also
 * accept a post-deployment fact against it.
 */
async function ledgerDelivery(suffix: string, mergedHoursAgo: number, prHoursBeforeMerge: number | null = 6) {
  const id = randomUUID(), now = await repositoryNow();
  const mergedAt = new Date(now.getTime() - mergedHoursAgo * 3_600_000);
  const createdAt = new Date(mergedAt.getTime() - 24 * 3_600_000);
  const key = `GY-${suffix}`, mergeSha = suffix.padStart(40, 'c'), baseSha = 'b'.repeat(40);
  const candidate = { pr: Number(suffix), sha: suffix.padStart(40, 'a'), baseSha, branch: `pulse-${suffix}`, author: 'worker' };
  const evidence = { proof: 'integration:pulse', trusted: true, result: 'pass', executed: 1, skipped: 0, sha: candidate.sha, baseSha, policyRevision: 1, producer: 'producer', recordedAt: mergedAt.toISOString() };
  const criteria = [{ id: 'AC-1', text: 'Ships', proofs: ['integration:pulse'] }];
  const delivery = { mergedAt: mergedAt.toISOString(), mergedAtRepository: mergedAt.toISOString(), repositoryClockOffsetMs: 0, mergeSha, authorizationRevision: AUTHORIZED_REVISION };
  const observation = prHoursBeforeMerge === null ? null : { prCreatedAt: new Date(mergedAt.getTime() - prHoursBeforeMerge * 3_600_000).toISOString() };
  const base = {
    id, key, title: `Delivery ${suffix}`, description: '', type: 'feature', priority: 1, stage: 'done', ready: true, epoch: 1,
    revision: AUTHORIZED_REVISION, policyRevision: 1, policy: { checks: [], review: false }, criteria, evidence: [evidence],
    dependencies: [], plannedFiles: [], workspaces: [], implementers: ['worker'], gates: [], violations: [], queueHistory: [],
    scenarioRequirements: [], lease: null, candidate, submission: { epoch: 1, pr: Number(suffix) }, observation, blocker: null,
    reworkRequested: false, createdAt: createdAt.toISOString(), updatedAt: mergedAt.toISOString(), stageEnteredAt: mergedAt.toISOString(),
  };
  const authorized = { ...base };
  const work = { ...base, revision: AUTHORIZED_REVISION + 1, delivery };
  await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [id, work]);
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload,created_at) VALUES($1,'operator','create',$2,$3)", [id, { work: { id, key } }, createdAt]);
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'coordinator','merge.execution.acquired',$2)", [id, { work: authorized }]);
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES($1,'github','github.observed',$2)", [id, { work }]);
  return { id, key, mergeSha, mergedAt, work };
}

const render = (pulse: ShippingPulse) => renderToStaticMarkup(createElement(ShippingPulseView, { pulse, repository: 'owner/project', stale: false, elapsed: 0, onRefresh: () => {} }));
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('unit:dominant-exclusion-reason-shown — the page states the single dominant exclusion reason and its count beside the coverage line, and the API returns the same reasons', async () => {
  // Every delivery in this fixture is excluded for one cause: nothing has recorded a
  // production instant for any of them.
  for (const suffix of ['301', '302', '303', '304', '305', '306']) await ledgerDelivery(suffix, 2 + Number(suffix.slice(-1)));
  const pulse = await shippingPulse(store.pool);
  assert.equal(pulse.prToProduction.eligible, 6); assert.equal(pulse.prToProduction.sampleSize, 0); assert.equal(pulse.prToProduction.coveragePercent, 0);
  assert.deepEqual(pulse.prToProduction.exclusions, { 'no-verifiable-production-deployment': 6 });
  assert.deepEqual(pulse.prToProduction.dominantExclusion, { reason: 'no-verifiable-production-deployment', count: 6 });
  const markup = render(pulse);
  // The reason sits in the coverage sentence itself, not behind the disclosure.
  const coverage = /<p class="pulse-coverage">(.*?)<\/p>/s.exec(markup);
  assert.ok(coverage, 'the coverage line is rendered');
  assert.match(text(coverage![1]), /0 included of 6 \(0% coverage\) · 6 excluded, most often no verifiable production deployment \(6, every exclusion\)\./);
  // The full breakdown stays available as the disclosure, with the same reason.
  assert.match(markup, /<details><summary>Why records were excluded<\/summary><ul><li>no verifiable production deployment: 6<\/li><\/ul><\/details>/);
});

test('unit:unconfigured-production-endpoint-stated — with no production observation at all the page says the endpoint is not configured, and with three observations it calls the sample sparse', async () => {
  const zero = await shippingPulse(store.pool);
  assert.equal(zero.prToProduction.configured, false);
  assert.deepEqual(zero.prToProduction.sources, { providerObservations: false, verifiedDeliveries: 0 });
  assert.equal(zero.prToProduction.sparse, true, 'the statistical flag still holds; the page must not lead with it');
  assert.ok(zero.prToProduction.unconfiguredReason);
  const unconfigured = text(render(zero));
  assert.match(unconfigured, /Production endpoint not configured\./);
  assert.match(unconfigured, /no deployment-provider observation has ever been recorded/);
  assert.match(unconfigured, /no deliveries can be measured until it is/);
  assert.ok(unconfigured.includes(PRODUCTION_OBSERVATION_ENDPOINT), 'names the endpoint that feeds the metric');
  assert.ok(unconfigured.includes(FLOW_DEPLOYMENT_ENDPOINT), 'names POST /api/deployments and says it does not feed the metric');
  assert.match(unconfigured, /POST \/api\/deployments records deployments for flow analytics and does not feed this metric/);
  assert.match(unconfigured, /producer credential whose deploymentProviders scope names the provider/);
  assert.match(unconfigured, /master verify-deployment also counts/);
  assert.doesNotMatch(unconfigured, /Sparse sample/);
  // Coverage is still explained on the same page.
  assert.match(unconfigured, /0 included of 6 \(0% coverage\) · 6 excluded, most often no verifiable production deployment/);
  assert.match(unconfigured, /no deployment-provider observation is recorded · 0 in this window verified with master verify-deployment/);

  // Three provider observations, each containing one delivered merge: the metric now has
  // inputs and three included deliveries, which is a thin sample rather than a missing source.
  const delivery = new ProductionDelivery(store);
  const producer = { id: 'deployment-observer', role: 'producer' as const, deploymentProviders: ['railway'] };
  const observedNow = await repositoryNow();
  for (const suffix of ['301', '302', '303']) {
    await delivery.observe(producer, {
      provider: 'railway', deploymentId: `deploy-${suffix}`, status: 'succeeded', kind: 'deployment',
      deployedAt: new Date(observedNow.getTime() - 3_600_000).toISOString(), clockOffset: { min: 0, max: 0 },
      commitSha: 'd'.repeat(40), sourceUrl: `https://railway.example/deployment/${suffix}`, mergeShas: [suffix.padStart(40, 'c')],
    }, randomUUID());
  }
  const three = await shippingPulse(store.pool);
  assert.equal(three.prToProduction.configured, true); assert.equal(three.prToProduction.unconfiguredReason, null);
  assert.equal(three.prToProduction.sampleSize, 3); assert.equal(three.prToProduction.sparse, true);
  assert.deepEqual(three.prToProduction.sources, { providerObservations: true, verifiedDeliveries: 0 });
  assert.deepEqual(three.prToProduction.dominantExclusion, { reason: 'no-verifiable-production-deployment', count: 3 });
  const sparse = text(render(three));
  assert.match(sparse, /Sparse sample\. Fewer than 5 deliveries have a verified production endpoint/);
  assert.doesNotMatch(sparse, /Production endpoint not configured/);
  assert.match(sparse, /3 included of 6 \(50% coverage\) · 3 excluded, most often no verifiable production deployment \(3, every exclusion\)\./);
});

test('integration:verified-delivery-counts-as-production — a delivery verified through master verify-deployment is included with its merge-to-production duration', async () => {
  const before = await shippingPulse(store.pool);
  const verified = await ledgerDelivery('310', 3);
  const excludedStill = await shippingPulse(store.pool);
  assert.equal(excludedStill.prToProduction.eligible, before.prToProduction.eligible + 1);
  assert.equal(excludedStill.prToProduction.sampleSize, before.prToProduction.sampleSize, 'an unverified delivery with no provider observation is excluded');
  assert.equal(excludedStill.prToProduction.exclusions['no-verifiable-production-deployment'], (before.prToProduction.exclusions['no-verifiable-production-deployment'] ?? 0) + 1);

  // The record `master verify-deployment` writes through the coordinator credential: the
  // release it observed serving this delivery's merge, bound to the delivery by the engine.
  const engine = new Engine(store, [15368], 120, 'owner/project');
  const release = 'e'.repeat(40);
  const observedAt = new Date(Date.now() - 5_000).toISOString();
  const recorded = await engine.execute({ id: 'master', role: 'coordinator' }, 'deployment', verified.id, { sha: release, mergeSha: verified.mergeSha, source: 'endpoint', observedAt }, randomUUID());
  assert.equal(recorded.delivery!.deployment!.sha, release); assert.equal(recorded.delivery!.deployment!.covers, 'descendant');
  const ledger = await store.pool.query("SELECT payload->'work'->'delivery'->'deployment' AS deployment FROM events WHERE work_id=$1 AND kind='deployment'", [verified.id]);
  assert.equal(ledger.rows.length, 1, 'the verification is an append-only ledger event, the table the pulse reads');
  const verifiedAt = Date.parse(ledger.rows[0].deployment.at);

  const after = await shippingPulse(store.pool);
  assert.equal(after.prToProduction.configured, true);
  assert.equal(after.prToProduction.sources.verifiedDeliveries, 1);
  assert.equal(after.prToProduction.sampleSize, before.prToProduction.sampleSize + 1, 'the verified delivery is included rather than excluded');
  assert.equal(after.prToProduction.exclusions['no-verifiable-production-deployment'], before.prToProduction.exclusions['no-verifiable-production-deployment'] ?? 0);
  // Its production instant is the repository-clock instant the verification was recorded, so
  // merge → production for this delivery is that instant minus its merge, to the tenth of an hour.
  const expectedMergeToProduction = (verifiedAt - verified.mergedAt.getTime()) / 3_600_000;
  const included = before.prToProduction.sampleSize;
  const priorTotal = (before.prToProduction.split.mergeToProductionAverageHours ?? 0) * included;
  assert.equal(after.prToProduction.split.mergeToProductionAverageHours, Math.round((priorTotal + expectedMergeToProduction) / (included + 1) * 10) / 10);
  assert.equal(after.prToProduction.split.prToMergeAverageHours, 6, 'every fixture delivery opened its pull request six hours before merging');
  assert.equal(after.prToProduction.averageHours, Math.round((6 * (included + 1) + priorTotal + expectedMergeToProduction) / (included + 1) * 10) / 10);
  // A second delivery already covered by a provider observation keeps the provider's instant:
  // the verification stands in only where no provider reported.
  const covered = await engine.execute({ id: 'master', role: 'coordinator' }, 'deployment', (await store.pool.query("SELECT id FROM work_items WHERE document->>'key'='GY-301'")).rows[0].id, { sha: release, mergeSha: '301'.padStart(40, 'c'), source: 'endpoint', observedAt }, randomUUID());
  assert.ok(covered.delivery!.deployment);
  const both = await shippingPulse(store.pool);
  assert.equal(both.prToProduction.sources.verifiedDeliveries, 2);
  assert.equal(both.prToProduction.sampleSize, after.prToProduction.sampleSize, 'GY-301 was already included through its provider observation');
  assert.equal(both.prToProduction.split.mergeToProductionAverageHours, after.prToProduction.split.mergeToProductionAverageHours, 'the provider instant is kept over the later verification instant');
  const markup = text(render(both));
  assert.match(markup, /deployment-provider observations are recorded · 2 in this window verified with master verify-deployment/);
});
