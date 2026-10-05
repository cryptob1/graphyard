import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { wellFormedFlowReport } from '../web/flow-analytics.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { queueRef, type QueueSpeculation } from '../src/merge-queue.js';
import { daemonEffects } from '../src/master-daemon.js';
import {
  classifyWait, computeFlow, coveredWindow, dayBuckets, deriveFacts, distribution, flowDrilldown, flowExport, flowLimits, flowWindowLabel, flowWindowMessage, flowWindows, gateFactStep,
  coveredUntil, defaultDeliverySpeedTargets, deliveryPathMode, deliverySpeed, deliverySpeedBreaches, deliverySpeedMinimumSample, mergeReadyGate, pooledFlowDrilldown, pooledFlowReport, projectFlow, readFlow, separateKinds, stepEntries, stepMoves, workSlices, type FlowDataset, type FlowFact, type FlowQuery, type FlowWindow, type ProjectionState,
} from '../src/flow-analytics.js';
import { attributionWindows } from '../src/attribution.js';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import InsightsFlow, { LandedPerDay, ReplayRead, WhereTimeGoes, flowNow, readReplay } from '../web/pages/insights-flow.js';
import { readStepRows } from '../web/step-moves.js';
import { readFile } from 'node:fs/promises';
import { groupOf } from '../web/groups.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { masterConfigSchema } from '../src/master/profiles.js';

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker-a', role: 'worker' };
const second: Principal = { id: 'worker-b', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['integration:flow'] };
const reader: Principal = { id: 'observer', role: 'reader' };
const tokens = { operator: 'o'.repeat(32), worker: 'w'.repeat(32), coordinator: 'm'.repeat(32), producer: 'p'.repeat(32), reader: 'r'.repeat(32) };
const head = 'a'.repeat(40), base = 'b'.repeat(40), day = 86_400_000;

let database: EmbeddedPostgres; let store: Store; let engine: Engine;
let http: ReturnType<typeof server>; let url: string; let pullRequest = 500;

before(async () => {
  const port = Number(process.env.GRAPHYARD_FLOW_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 8);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('flow'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_flow');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_flow`);
  await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  http = server(engine, [{ ...operator, token: tokens.operator }, { ...worker, token: tokens.worker }, { ...coordinator, token: tokens.coordinator }, { ...producer, token: tokens.producer }, { ...reader, token: tokens.reader }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (database) await database.stop();
});

async function create(slice: string, overrides: Record<string, unknown> = {}) {
  return engine.execute(operator, 'create', null, {
    title: `Flow fixture in ${slice}`, plannedFiles: [`${slice}/`],
    criteria: [{ id: 'AC-1', text: 'Observable delivery behavior', proofs: ['integration:flow'] }], ...overrides,
  }, randomUUID());
}
async function released(slice: string, overrides: Record<string, unknown> = {}) {
  const work = await create(slice, overrides);
  return engine.execute(operator, 'ready', work.id, {}, randomUUID());
}
async function submitted(slice: string, actor: Principal = worker, overrides: Record<string, unknown> = {}) {
  let work = await released(slice, overrides);
  work = await engine.execute(actor, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(actor, 'workspace', work.id, { epoch: work.epoch, host: 'machine-a', path: `/tmp/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}` }, randomUUID());
  return engine.execute(actor, 'submit', work.id, { epoch: work.epoch, pr: ++pullRequest }, randomUUID());
}
function observation(work: Work, slice: string, overrides: Partial<Observation> = {}): Observation {
  return {
    clockOffset: { min: 0, max: 0 },
    candidate: { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces.at(-1)!.branch, author: 'implementer', createdAt: new Date(Date.now() - 3 * 3600_000).toISOString() },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null,
    files: [`${slice}/changed.ts`], scopeFiles: [], at: new Date().toISOString(), ...overrides,
  };
}
function approval(sha = head, id = 9001, submittedAt = new Date(Date.now() - 3600_000).toISOString()) {
  return [{ reviewer: 'independent-reviewer', sha, state: 'APPROVED', id, submittedAt }];
}
function proof(sha = head) { return { proof: 'integration:flow', sha, baseSha: base, policyRevision: 1, result: 'pass' as const, executed: 9, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }; }

async function analyse(query: Partial<FlowQuery> = {}) {
  await projectFlow(store);
  const full: FlowQuery = { days: 30 as FlowWindow, ...query };
  const dataset = await readFlow(store, full);
  return { dataset, report: computeFlow(dataset, full) };
}
async function seedFact(work: Work, kind: string, observedAt: number, details: Record<string, unknown>, stage = 'build') {
  await store.pool.query(
    `INSERT INTO flow_facts(work_id,work_key,kind,observed_at,recorded_at,source,source_event,stage,work_type,slices,details,dedupe)
     VALUES($1,$2,$3,$4,$4,'graphyard',0,$5,'feature',$6,$7,$8) ON CONFLICT (dedupe) DO NOTHING`,
    [work.id, work.key, kind, new Date(observedAt).toISOString(), stage, workSlices(work).slices, JSON.stringify(details), `${kind}:${work.id}:seed:${observedAt}:${randomUUID()}`]);
}
async function api(path: string, token = tokens.operator, init: RequestInit = {}) {
  const response = await fetch(`${url}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...(init.headers ?? {}) } });
  return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
}

test('integration:flow-analytics-source-integrity', async () => {
  const slice = 'gy35-integrity';
  let work = await submitted(slice);
  work = await engine.observe(work.id, work.revision, observation(work, slice));
  // A worker assertion is recorded, but it is untrusted and must not establish a fact.
  work = await engine.execute(worker, 'evidence', work.id, proof(), randomUUID());
  const claimed = await analyse({ slice });
  const evidenceFacts = claimed.dataset.facts.filter(fact => fact.kind === 'evidence.recorded');
  assert.equal(evidenceFacts.length, 1);
  assert.equal(evidenceFacts[0].details.trusted, false);
  assert.equal(claimed.report.evidence.trusted, 0, 'an untrusted worker claim never counts as trusted evidence');
  assert.ok(claimed.report.bottleneck.categories.find(category => category.id === 'evidence')!.count >= 0);

  // Directly mutating the mutable work document cannot move any metric: analytics read the ledger.
  const counts = (value: Awaited<ReturnType<typeof analyse>>) => value.report.bottleneck.categories.map(category => `${category.id}=${category.count}`).join(',');
  const before = counts(await analyse({ slice }));
  const tampered = { ...work, stage: 'done', gates: work.gates.map(gate => ({ ...gate, passed: true, reasons: [] })) };
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [work.id, JSON.stringify(tampered)]);
  assert.equal(counts(await analyse({ slice })), before, 'a mutated lifecycle snapshot establishes nothing');
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [work.id, JSON.stringify(work)]);

  const { report, dataset } = await analyse({ slice });
  assert.equal(report.timezone, 'UTC');
  assert.match(report.window.boundaries, /Half-open/);
  assert.equal(report.window.days, 30);
  assert.ok(Object.keys(report.definitions).length >= 10, 'every metric family is defined in the payload');
  for (const definition of Object.values(report.definitions)) assert.ok(definition.formula.length > 20 && definition.sources.length);
  assert.equal(report.coverage.workItems, 1);
  assert.equal(report.coverage.projection.pendingEvents, 0);
  assert.equal(report.coverage.complete, true);

  // A ledger entry without a work item (for example a scenario definition) is skipped by
  // the projector; it must not hold the report permanently stale.
  await store.pool.query("INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,'system','scenario.defined','{}'::jsonb)");
  const withNonWork = await analyse({ slice });
  assert.equal(withNonWork.report.coverage.projection.pendingEvents, 0, 'events without a work item are not projection debt');
  assert.equal(withNonWork.report.coverage.complete, true);

  // A fact recorded exactly at the read instant is the state at that instant, never stale.
  const boundary = Date.now() - 60_000;
  await seedFact(work, 'gates.changed', boundary, { stage: 'review', unmet: ['acceptance'], firstUnmet: 'acceptance', firstUnmetReason: 'proof', reasons: [], dependencyWaiting: [], hasCandidate: true, released: true, blocker: null, violations: 0 });
  const atBoundary = await readFlow(store, { days: 30, slice, asOf: new Date(boundary).toISOString() });
  assert.equal(atBoundary.latest.find(fact => fact.workId === work.id && fact.kind === 'gates.changed')?.details.unmet.join(','), 'acceptance',
    'a fact observed exactly at the read instant is the current state');
  assert.equal(report.leadTime.bands.n, 0);
  assert.equal(report.leadTime.bands.medianMs, null, 'an empty sample is null, never zero');
  assert.ok(report.unavailable.some(entry => entry.metric === 'leadTime'));
  assert.ok(report.unavailable.some(entry => entry.metric === 'deployments' && /not zero/.test(entry.reason)));
  assert.equal(report.stageDwell.find(entry => entry.stage === 'backlog')!.sparse, true, 'small samples are flagged');
  assert.ok(report.coverage.providerTimestamps >= 0 && report.coverage.slices.observed === 1);

  // Every fact carries the exact source and the identity it was derived from.
  const sources = new Set(claimed.dataset.facts.map(fact => fact.source));
  assert.ok(sources.has('graphyard') && sources.has('github') && sources.has('ci') && sources.has('evidence'));
  const unauthenticated = await fetch(`${url}/api/analytics/flow?window=30`);
  assert.equal(unauthenticated.status, 401);
  const served = await api(`/api/analytics/flow?window=30&slice=${slice}`, tokens.reader);
  assert.equal(served.status, 200);
  assert.equal(served.body.coverage.workItems, 1);
  // The dashboard accepts the report the server serves: its shape check refuses only a malformed body.
  assert.equal(wellFormedFlowReport(served.body), true);
});

test('integration:flow-analytics-core-metrics', async () => {
  const slice = 'gy35-core';
  let work = await submitted(slice);
  work = await engine.observe(work.id, work.revision, observation(work, slice, { reviews: approval() }));
  work = await engine.execute(producer, 'evidence', work.id, proof(), randomUUID());
  const older = await submitted(slice, second);
  const now = Date.now();
  for (let index = 0; index < 6; index++)
    await seedFact(older, 'stage.changed', now - (10 - index) * day, { from: 'review', to: 'acceptance', dwellMs: (index + 1) * 3600_000, clockOrder: 'ordered' }, 'review');
  await seedFact(older, 'delivered', Date.now(), { mergeSha: 'c'.repeat(40), pr: older.submission!.pr }, 'done');

  const { report, dataset } = await analyse({ slice });
  const dwell = report.stageDwell.find(entry => entry.stage === 'review')!;
  assert.equal(dwell.n, 6);
  assert.equal(dwell.averageMs, 3600_000 * 3.5);
  assert.equal(dwell.medianMs, 3600_000 * 3.5);
  assert.equal(dwell.p90Ms, 3600_000 * 5.5);
  assert.equal(dwell.sparse, false);
  assert.deepEqual(distribution([1, 2, 3, 4]), { n: 4, averageMs: 3, medianMs: 3, p75Ms: 3, p90Ms: 4, minMs: 1, maxMs: 4, sparse: true, outliers: 0 });

  assert.ok(report.wip.some(entry => entry.count > 0 && entry.oldestMs !== null), 'work in progress reports counts and aging');
  assert.equal(report.cumulativeFlow.buckets.length, 30);
  assert.equal(report.cumulativeFlow.series.length, 8);
  assert.ok(report.cumulativeFlow.series.every(series => series.counts.length === 30));
  assert.equal(report.throughput.length, 30);
  assert.equal(report.throughput.reduce((sum, bucket) => sum + bucket.delivered, 0), 1);
  assert.equal(report.leadTime.bands.n, 1);
  assert.ok(report.leadTime.bands.medianMs! >= 0);
  assert.equal(report.leadTime.trend.length, 30);
  assert.ok(report.queueVsActive.openMs > 0 && report.queueVsActive.activeRatio !== null);
  assert.ok(report.queueVsActive.activeMs + report.queueVsActive.queueMs <= report.queueVsActive.openMs + 1);
  assert.ok(report.mergeReadyDwell.current.some(entry => entry.key === work.key), 'a fully gated candidate shows merge-ready dwell');
  assert.ok(report.coverage.facts > 0 && report.coverage.scanLimit === flowLimits.scan);
  assert.ok(Array.isArray(report.exclusions));
});

test('integration:flow-analytics-filters-windows', async () => {
  const slice = 'gy35-windows';
  const bug = await submitted(slice, worker, { type: 'bug' });
  const feature = await submitted(slice, second, { type: 'feature' });
  const stillBuilding = await submitted(slice, worker, { type: 'chore' });
  const now = Date.now();
  await seedFact(bug, 'stage.changed', now - 60 * day, { from: 'build', to: 'review', dwellMs: 5 * day, clockOrder: 'ordered' }, 'build');
  const currentReviewAt = now + 10;
  await seedFact(feature, 'stage.changed', currentReviewAt, { from: 'build', to: 'review', dwellMs: 2 * day, clockOrder: 'ordered' }, 'build');
  await settle(new Date(currentReviewAt).toISOString());

  const week = (await analyse({ days: 7, slice })).report;
  const month = (await analyse({ days: 30, slice })).report;
  const quarter = (await analyse({ days: 90, slice })).report;
  assert.equal(week.window.days, 7);
  assert.equal(week.cumulativeFlow.buckets.length, 7);
  assert.equal(quarter.cumulativeFlow.buckets.length, 90);
  const buildDwell = (value: typeof week) => value.stageDwell.find(entry => entry.stage === 'build')!.n;
  assert.equal(buildDwell(week), 1, 'only the recent transition is inside the seven-day window');
  assert.equal(buildDwell(month), 1);
  assert.equal(buildDwell(quarter), 2, 'the ninety-day window includes the older transition');
  assert.equal(Date.parse(week.window.to) - Date.parse(week.window.from), 7 * day);

  const bugs = (await analyse({ days: 90, slice, type: 'bug' })).report;
  assert.equal(bugs.coverage.workItems, 1);
  assert.equal(bugs.filters.type, 'bug');
  assert.equal(bugs.stageDwell.find(entry => entry.stage === 'build')!.n, 1);
  const elsewhere = (await analyse({ days: 90, slice: 'gy35-core' })).report;
  assert.ok(!elsewhere.bottleneck.categories.some(category => category.items.some(item => item.key === bug.key)));
  const stagedResult = await analyse({ days: 90, slice, stage: 'review' });
  const staged = stagedResult.report;
  assert.equal(staged.filters.stage, 'review');
  assert.equal(staged.coverage.workItems, 1, 'the current-stage cohort excludes work still in build');
  assert.equal(staged.stageDwell.find(entry => entry.stage === 'build')!.n, 0, 'stage dwell selects the requested from-stage');
  assert.equal(staged.stageDwell.find(entry => entry.stage === 'review')!.n, 0, 'no completed review dwell is fabricated');
  assert.equal(staged.wip.find(entry => entry.stage === 'review')!.count, 1);
  assert.ok(!JSON.stringify(staged).includes(stillBuilding.key), 'item-scoped aggregates exclude work outside the current-stage cohort');
  const stagedWip = flowDrilldown(stagedResult.dataset, staged, { metric: 'wip', key: 'review' });
  assert.equal(stagedWip.total, staged.wip.find(entry => entry.stage === 'review')!.count, 'stage-filtered aggregate and drill-down populations match');
  const stagedDwell = flowDrilldown(stagedResult.dataset, staged, { metric: 'stage-dwell', key: 'review' });
  assert.equal(stagedDwell.total, staged.stageDwell.find(entry => entry.stage === 'review')!.n, 'selected from-stage dwell matches its drill-down');
  assert.ok(week.availableSlices.includes(slice) && week.availableTypes.includes('bug'));
  const rejected = await api(`/api/analytics/flow?window=45`);
  assert.equal(rejected.status, 400);
  assert.match(JSON.stringify(rejected.body), /Window must be 24 hours, 7 days, 30 days, 90 days/);
  const lastDay = await api(`/api/analytics/flow?window=1`);
  assert.equal(lastDay.status, 200);
  const lastDayReport = lastDay.body;
  assert.equal(lastDayReport.window.days, 1);
  assert.equal(Date.parse(lastDayReport.window.to) - Date.parse(lastDayReport.window.from), day);
});

// A provider merge timestamp is rounded up to a whole second, so it can briefly sit in the
// future; the window read is half-open on the observation instant and must catch up first.
async function settle(instant: string) {
  const wait = Date.parse(instant) + 5 - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}
// A merge authorization now requires the candidate to hold the head of the global merge queue
// with Graphyard's speculative tip published for it. The queue is shared by every fixture in
// this file, so the other entries step aside and this candidate's tip is published the way
// tests/system.test.ts does; queue publication itself is proven by the merge-queue tests.
async function deliver(work: Work, slice: string, mergeSha: string, overrides: Partial<Observation> = {}) {
  const current = () => (store.list()).then(items => items.find(item => item.id === work.id)!);
  await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE id<>$1 AND document->>'stage'<>'done'", [work.id]);
  let latest = await current();
  assert.ok(latest.queue, 'a proven candidate holds a merge-queue entry');
  const speculation: QueueSpeculation = { ref: queueRef(latest.key), tip: head, base, baseTree: 'f'.repeat(40), predecessors: [], policyRevision: latest.policyRevision, publishedAt: new Date().toISOString() };
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{queue,speculation}',$2::jsonb) WHERE id=$1", [latest.id, JSON.stringify(speculation)]);
  latest = await current();
  latest = await engine.observe(latest.id, latest.revision, { ...observation(latest, slice, overrides), prState: 'open', draft: false });
  assert.ok(latest.gates.every(gate => gate.passed), `the published tip clears the merge gate: ${JSON.stringify(latest.gates.find(gate => !gate.passed)?.reasons)}`);
  // GitHub executes the merge (GY-258): the coordinator's request binds this head, and the merged
  // observation that follows completes the delivery.
  const requested = await engine.requestEnqueue(coordinator, work.id, { enqueue: true, expectedRevision: latest.revision, sha: head, baseSha: base, policyRevision: latest.policyRevision }, randomUUID());
  const mergedAt = new Date(Math.ceil((Date.parse(requested.enqueue.at) + 1) / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  latest = await current();
  const delivered = await engine.observe(latest.id, latest.revision, { ...observation(latest, slice, overrides), merged: true, mergeSha, mergedAt });
  assert.equal(delivered.stage, 'done');
  // GY-60: a merge observed without a prior request is recorded as a violation and never
  // reaches `done`; pin the attribution so a dropped request fails here, not in the analytics.
  assert.deepEqual(delivered.violations, [], 'the merged observation is attributed to the merge request');
  await settle(mergedAt);
  return { delivered, mergedAt, mergeSha };
}

test('integration:flow-analytics-phase-durations', async () => {
  const slice = 'gy35-phases';
  const now = Date.now();
  const prCreatedAt = new Date(now - 6 * 3600_000).toISOString();
  const changesAt = new Date(now - 5 * 3600_000).toISOString();
  const approvedAt = new Date(now - 4 * 3600_000).toISOString();
  let work = await submitted(slice);
  const candidate = { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces.at(-1)!.branch, author: 'implementer', createdAt: prCreatedAt };
  work = await engine.observe(work.id, work.revision, observation(work, slice, { candidate, reviews: [{ reviewer: 'first-reviewer', sha: head, state: 'CHANGES_REQUESTED', id: 9201, submittedAt: changesAt }] }));
  const reviewed = { candidate, reviews: [{ reviewer: 'first-reviewer', sha: head, state: 'DISMISSED', id: 9201, submittedAt: changesAt }, { reviewer: 'second-reviewer', sha: head, state: 'APPROVED', id: 9202, submittedAt: approvedAt }] };
  work = await engine.observe(work.id, work.revision, observation(work, slice, reviewed));
  work = await engine.execute(producer, 'evidence', work.id, proof(), randomUUID());
  const mergeSha = 'c'.repeat(40);
  const { mergedAt } = await deliver(work, slice, mergeSha, reviewed);
  const deployedAt = new Date(Date.parse(mergedAt) + 1000).toISOString();
  const recorded = await api('/api/deployments', tokens.producer, { method: 'POST', body: JSON.stringify({ provider: 'railway', externalId: 'deploy-phase-1', environment: 'production', sha: mergeSha, containedMergeShas: [mergeSha], state: 'succeeded', startedAt: deployedAt, finishedAt: new Date(Date.parse(deployedAt) + 30_000).toISOString() }) });
  assert.equal(recorded.status, 200); assert.equal(recorded.body.recorded, true);
  await settle(deployedAt);

  const { report, dataset } = await analyse({ slice });
  const phase = (id: string) => report.phases.find(entry => entry.phase === id)!;
  assert.equal(phase('pr-created-to-review-start').n, 1);
  assert.equal(phase('pr-created-to-review-start').medianMs, 3600_000, 'independently observed provider timestamps bound the first phase');
  assert.equal(phase('review-start-to-review-complete').n, 1);
  assert.equal(phase('review-start-to-review-complete').medianMs, 3600_000);
  assert.equal(phase('review-complete-to-evidence-complete').n, 1);
  assert.ok(phase('review-complete-to-evidence-complete').medianMs! >= 0);
  assert.equal(phase('evidence-complete-to-merge-authorized').n, 1);
  assert.equal(phase('merge-authorized-to-merged').n, 1);
  assert.ok(phase('merge-authorized-to-merged').medianMs! > 0);
  assert.equal(phase('merged-to-production').n, 1);
  assert.equal(phase('merged-to-production').medianMs, 1000);
  assert.equal(report.ci.runs, 2, 'each observed check run is measured once per candidate');
  assert.equal(report.ci.failures, 0);
  assert.equal(report.evidence.recorded, 1);
  assert.equal(report.evidence.trusted, 1);
  assert.equal(report.evidence.expired, 0);
  assert.ok(report.evidence.wait.n === 1);
  assert.equal(report.operations.deployments.succeeded, 1);
  assert.equal(report.operations.deployments.latency.n, 1);
  assert.equal(report.operations.deployments.latency.medianMs, 1000);
  const phaseRows = flowDrilldown(dataset, report, { metric: 'phase', key: 'merged-to-production' });
  assert.equal(phaseRows.total, 1);
  assert.equal(phaseRows.rows[0].valueMs, 1000, 'phase drill-down returns the duration behind the aggregate');
  assert.equal(phaseRows.rows[0].commit, head);

  // Merge-ready dwell closes at the observed merge; gate facts recorded after the merge
  // (the item is done, every gate passes) never reopen it up to the observation instant.
  const readyRows = flowDrilldown(dataset, report, { metric: 'merge-ready' }).rows.filter(row => row.workKey === work.key);
  assert.ok(readyRows.length >= 1, 'the delivered item was merge ready before its merge');
  assert.ok(readyRows.every(row => Date.parse(String(row.observedAt)) + Number(row.valueMs) <= Date.parse(mergedAt) + 1), 'no merge-ready interval extends past the observed merge');
  assert.ok(readyRows.some(row => row.detail === 'Merge ready until the observed merge' && row.commit === mergeSha));
  assert.ok(!report.mergeReadyDwell.current.some(entry => entry.key === work.key), 'a merged item is not merge ready now');
  assert.ok(report.mergeReadyDwell.maxMs! < 3600_000, 'dwell is bounded by the real merge, not by the observation instant');

  // A staging deployment must never end a phase that is labelled production.
  const stagingOnly = await submitted(slice, second);
  let stagingWork = await engine.observe(stagingOnly.id, stagingOnly.revision, observation(stagingOnly, slice, { reviews: approval(head, 9203) }));
  stagingWork = await engine.execute(producer, 'evidence', stagingWork.id, proof(), randomUUID());
  const stagingMerge = '5'.repeat(40);
  const stagingDelivery = await deliver(stagingWork, slice, stagingMerge, { reviews: approval(head, 9203) });
  const stagedAt = new Date(Date.parse(stagingDelivery.mergedAt) + 1000).toISOString();
  const staged = await api('/api/deployments', tokens.producer, { method: 'POST', body: JSON.stringify({ provider: 'railway', externalId: 'deploy-staging-1', environment: 'staging', sha: stagingMerge, containedMergeShas: [stagingMerge], state: 'succeeded', startedAt: stagedAt }) });
  assert.equal(staged.status, 200);
  await settle(stagedAt);
  const withStaging = await analyse({ slice });
  const production = withStaging.report.phases.find(entry => entry.phase === 'merged-to-production')!;
  assert.equal(withStaging.report.productionEnvironment, 'production');
  assert.equal(production.n, 1, 'the staging deployment does not end the production phase');
  assert.equal(production.unknown['deployed-only-outside-production-environment'], 1, 'a staging-only deployment is named as such, not counted as production');
  assert.equal(withStaging.report.operations.deployments.productionObservations, 1);
  assert.ok(withStaging.report.operations.deployments.environments.includes('staging'));
  assert.equal(flowDrilldown(withStaging.dataset, withStaging.report, { metric: 'phase', key: 'merged-to-production' }).rows.filter(row => row.workKey === stagingWork.key).length, 0, 'the phase drill-down honours the same environment');
  const stagingIsProduction = computeFlow(withStaging.dataset, { days: 30, slice, productionEnvironment: 'staging' });
  assert.equal(stagingIsProduction.productionEnvironment, 'staging');
  assert.equal(stagingIsProduction.phases.find(entry => entry.phase === 'merged-to-production')!.n, 1, 'the configured environment decides which deployment ends the phase');
  assert.equal(stagingIsProduction.phases.find(entry => entry.phase === 'merged-to-production')!.unknown['deployed-only-outside-production-environment'], 1);
  const exported = JSON.parse(flowExport(withStaging.report, flowDrilldown(withStaging.dataset, withStaging.report, { metric: 'phase' }), 'json'));
  assert.equal(exported.metadata.productionEnvironment, 'production', 'exports preserve the environment the production phase was measured against');
});

test('integration:flow-analytics-edge-cases', async () => {
  const slice = 'gy35-edges';
  const now = Date.now();
  // Absent endpoint: an observation without a provider pull-request creation time.
  let legacy = await submitted(slice);
  legacy = await engine.observe(legacy.id, legacy.revision, observation(legacy, slice, { candidate: { sha: head, baseSha: base, pr: legacy.submission!.pr, branch: legacy.workspaces.at(-1)!.branch, author: 'implementer' } }));
  // Superseded observation: a new commit replaces the candidate under review.
  const nextSha = 'd'.repeat(40);
  legacy = await engine.observe(legacy.id, legacy.revision, observation(legacy, slice, { candidate: { sha: nextSha, baseSha: base, pr: legacy.submission!.pr, branch: legacy.workspaces.at(-1)!.branch, author: 'implementer', createdAt: new Date(now - 2 * 3600_000).toISOString() } }));
  // Clock ordering: a transition whose provider timestamps arrive out of order.
  await seedFact(legacy, 'stage.changed', now - 2 * day, { from: 'review', to: 'build', dwellMs: null, clockOrder: 'inverted' }, 'review');

  const { report, dataset } = await analyse({ slice });
  const episodes = dataset.facts.filter(fact => fact.kind === 'candidate.observed');
  assert.equal(episodes.length, 2, 'a new commit opens a new candidate episode');
  assert.equal(episodes[1].details.supersedes, head);
  const firstPhase = report.phases.find(entry => entry.phase === 'pr-created-to-review-start')!;
  assert.ok(firstPhase.unknown['pull-request-creation-time-not-observed'] >= 1, 'a missing endpoint is named, not guessed');
  assert.ok(report.phases.every(entry => entry.medianMs === null || entry.n > 0));
  assert.ok(report.exclusions.some(entry => entry.reason === 'clock-inverted-transition' && entry.items.includes(legacy.key)));
  assert.equal(report.evidence.superseded, 0);

  // Multiple pull requests reaching production in one deployment, plus a rollback.
  const releaseSha = 'e'.repeat(40), firstMerge = '1'.repeat(40), secondMerge = '2'.repeat(40);
  const first = await submitted(slice);
  let firstWork = await engine.observe(first.id, first.revision, observation(first, slice, { reviews: approval(head, 9301) }));
  firstWork = await engine.execute(producer, 'evidence', firstWork.id, proof(), randomUUID());
  await deliver(firstWork, slice, firstMerge, { reviews: approval(head, 9301) });
  const secondItem = await submitted(slice, second);
  let secondWork = await engine.observe(secondItem.id, secondItem.revision, observation(secondItem, slice, { reviews: approval(head, 9302) }));
  secondWork = await engine.execute(producer, 'evidence', secondWork.id, proof(), randomUUID());
  await deliver(secondWork, slice, secondMerge, { reviews: approval(head, 9302) });
  const startedAt = new Date(Date.now() - 3600_000).toISOString();
  const containedMergeShas = [firstMerge, secondMerge];
  await api('/api/deployments', tokens.producer, { method: 'POST', body: JSON.stringify({ provider: 'railway', externalId: 'release-42', environment: 'production', sha: releaseSha, containedMergeShas, state: 'succeeded', startedAt }) });
  await api('/api/deployments', tokens.producer, { method: 'POST', body: JSON.stringify({ provider: 'railway', externalId: 'release-42', environment: 'production', sha: releaseSha, containedMergeShas, state: 'rolled_back', startedAt: new Date(Date.now() - 3500_000).toISOString() }) });
  const unlinkedExternalId = 'private-provider-deployment-unlinked';
  await api('/api/deployments', tokens.producer, { method: 'POST', body: JSON.stringify({ provider: 'railway', externalId: unlinkedExternalId, environment: 'production', sha: '9'.repeat(40), containedMergeShas: ['8'.repeat(40)], state: 'succeeded', startedAt }) });
  const abbreviated = await api('/api/deployments', tokens.producer, { method: 'POST', body: JSON.stringify({ provider: 'railway', externalId: 'abbreviated-sha', environment: 'production', sha: 'abc1234', containedMergeShas, state: 'succeeded', startedAt }) });
  assert.equal(abbreviated.status, 400, 'an abbreviated SHA is refused instead of being silently unlinked');
  const rolled = (await analyse({ slice })).report;
  assert.equal(rolled.operations.deployments.rollbacks, 1);
  assert.ok(rolled.operations.deployments.succeeded >= 1, 'deployment observations are repository-wide, not slice-filtered');
  assert.ok(rolled.operations.deployments.failureRate! > 0);
  assert.equal(rolled.operations.deployments.pullRequestsPerDeployment.max, 2, 'one deployment can carry several merged pull requests');
  const changedContainment = await api('/api/deployments', tokens.producer, { method: 'POST', body: JSON.stringify({ provider: 'railway', externalId: 'release-42', environment: 'production', sha: releaseSha, containedMergeShas: [firstMerge], state: 'succeeded', startedAt }) });
  assert.equal(changedContainment.status, 409, 'an idempotent replay cannot rewrite immutable deployment containment');
  const changedArtifact = await api('/api/deployments', tokens.producer, { method: 'POST', body: JSON.stringify({ provider: 'railway', externalId: 'release-42', environment: 'staging', sha: 'f'.repeat(40), containedMergeShas, state: 'succeeded', startedAt }) });
  assert.equal(changedArtifact.status, 409, 'an idempotent replay cannot rewrite any immutable deployment field');
  assert.ok((rolled.operations.deployments.latency.minMs ?? 0) >= 0, 'a deployment observed before its merge never becomes a negative latency');
  assert.ok(rolled.exclusions.some(entry => entry.reason === 'clock-inverted-deployment'));
  assert.ok(rolled.exclusions.some(entry => entry.reason === 'deployment-without-observed-merge'));
  assert.ok(!JSON.stringify(rolled.exclusions).includes('release-42'), 'clock-inverted exclusions do not expose provider record IDs');
  assert.ok(!JSON.stringify(rolled.exclusions).includes(unlinkedExternalId), 'unlinked deployment exclusions do not expose provider record IDs');
  const readerReport = await api(`/api/analytics/flow?window=30&slice=${slice}`, tokens.reader);
  assert.equal(readerReport.status, 200);
  assert.ok(!JSON.stringify(readerReport.body).includes('release-42'));
  assert.ok(!JSON.stringify(readerReport.body).includes(unlinkedExternalId));

  // An item that became merge ready and merged before the window contributes nothing to
  // merge-ready dwell; its interval is excluded rather than measured as a whole window.
  const priorMerge = await submitted(slice, second);
  await seedFact(priorMerge, 'gates.changed', now - 40 * day, { stage: 'merge', unmet: [], firstUnmet: null, firstUnmetReason: null, reasons: [], dependencyWaiting: [], hasCandidate: true, released: true, blocker: null, violations: 0, pr: priorMerge.submission!.pr, queued: false, mergeBlockers: 0 }, 'merge');
  await seedFact(priorMerge, 'merged', now - 39 * day, { pr: priorMerge.submission!.pr, sha: head, mergeSha: '7'.repeat(40), timestampSource: 'github' }, 'merge');
  const priorReport = await analyse({ slice });
  assert.ok(!priorReport.report.mergeReadyDwell.current.some(entry => entry.key === priorMerge.key));
  assert.ok(flowDrilldown(priorReport.dataset, priorReport.report, { metric: 'merge-ready' }).rows.every(row => row.workKey !== priorMerge.key), 'a pre-window merge has no in-window merge-ready row');
  assert.ok(priorReport.report.exclusions.some(entry => entry.reason === 'merge-ready-dwell-outside-window' && entry.items.includes(priorMerge.key)));
  assert.ok((priorReport.report.mergeReadyDwell.maxMs ?? 0) < 29 * day, 'no item is measured as merge ready for the whole window');

  // A delivery whose creation time is later than its merge is excluded from lead time and
  // from the lead-time drill-down alike, never emitted as a negative duration.
  const inverted = await released(slice);
  await seedFact(inverted, 'delivered', now - 3 * day, { mergeSha: '3'.repeat(40), pr: null, timestampSource: 'graphyard' }, 'done');
  const invertedReport = await analyse({ slice });
  assert.ok(invertedReport.report.exclusions.some(entry => entry.reason === 'clock-inverted-lead-time' && entry.items.includes(inverted.key)));
  const leadRows = flowDrilldown(invertedReport.dataset, invertedReport.report, { metric: 'lead-time' });
  assert.equal(leadRows.total, invertedReport.report.leadTime.bands.n, 'lead-time drill-down rows substantiate the aggregate n');
  assert.ok(leadRows.rows.every(row => row.workKey !== inverted.key && Number(row.valueMs) >= 0));
  const throughputRows = flowDrilldown(invertedReport.dataset, invertedReport.report, { metric: 'throughput' });
  assert.equal(throughputRows.total, invertedReport.report.throughput.reduce((sum, bucket) => sum + bucket.delivered, 0), 'throughput drill-down still counts every delivery');
  const invertedRow = throughputRows.rows.find(row => row.workKey === inverted.key)!;
  assert.equal(invertedRow.valueMs, null);
  assert.match(String(invertedRow.detail), /clock-inverted-lead-time/);

  // Outliers are reported, never silently dropped; sparse samples are flagged.
  assert.equal(distribution([1, 1, 1, 1, 1, 1, 1, 1, 1, 1000]).outliers, 1);
  assert.equal(distribution([5]).sparse, true);
  assert.equal(distribution([]).medianMs, null);
  // Empty state: a slice with no work is empty, not zero-filled.
  const empty = (await analyse({ slice: 'gy35-nothing-here' })).report;
  assert.equal(empty.coverage.workItems, 0);
  assert.equal(empty.bottleneck.narrative, 'No undelivered work item is currently recorded in scope.');
  assert.equal(empty.leadTime.bands.medianMs, null);
  assert.ok(empty.operations.deployments.observations >= 1, 'repository deployment metrics remain available for an empty work filter');
  assert.ok(empty.unavailable.length >= 3);

  // Pending Codex state is not a completion, and a repeated terminal result remains
  // a distinct append-only observation when its immutable check-run identity changes.
  const eventWork = await submitted('gy35-observation-identities');
  const state: ProjectionState = {};
  const derive = (seq: number, result: string, id: number, agentReview?: Observation['agentReview']) => deriveFacts({
    seq, work_id: eventWork.id, actor: 'system', kind: 'observed', created_at: new Date(now + seq).toISOString(),
    payload: { work: { ...eventWork, observation: observation(eventWork, 'gy35-observation-identities', { checks: [{ name: 'test', result, appId: 15368, id }], ...(agentReview ? { agentReview } : {}) }) } },
  }, state);
  assert.equal(derive(10, 'failure', 101, { provider: 'codex', sha: head, approved: false, reason: 'Waiting' }).filter(fact => fact.kind === 'review.completed').length, 0);
  const retried = derive(11, 'failure', 103);
  assert.equal(retried.filter(fact => fact.kind === 'check.observed').length, 1);
  assert.match(retried.find(fact => fact.kind === 'check.observed')!.dedupe, /:103:1:failure$/);
  assert.equal(derive(12, 'failure', 103).filter(fact => fact.kind === 'check.observed').length, 0, 'replaying the same run remains idempotent');
  const actionRequired = derive(13, 'action_required', 104).find(fact => fact.kind === 'check.observed')!;
  assert.equal(actionRequired.details.pending, false, 'action_required is a terminal conclusion, not an in-progress run');

  // A gate that keeps refusing for a different reason is a new durable fact, so refusal
  // history follows the evaluator instead of keeping the first reason it recorded.
  const gateState: ProjectionState = {};
  const gated = (seq: number, reasons: string[]) => deriveFacts({
    seq, work_id: eventWork.id, actor: 'system', kind: 'observed', created_at: new Date(now + seq).toISOString(),
    payload: { work: { ...eventWork, gates: eventWork.gates.map(gate => gate.name === 'merge' ? { name: 'merge', passed: false, reasons } : { ...gate, passed: true, reasons: [] }) } },
  }, gateState).filter(fact => fact.kind === 'gates.changed');
  assert.equal(gated(20, ['Required Graphyard check and merge-queue branch protection have not been verified']).length, 1);
  assert.equal(gated(21, ['Required Graphyard check and merge-queue branch protection have not been verified']).length, 0, 'an unchanged refusal records nothing new');
  const freshness = gated(22, ['GitHub observation missing or older than two minutes']);
  assert.equal(freshness.length, 1, 'a changed refusal reason is a new gate fact');
  assert.equal(freshness[0].details.firstUnmetReason, 'GitHub observation missing or older than two minutes');
});

test('integration:flow-analytics-operations', async () => {
  const slice = 'gy35-ops';
  const now = Date.now();
  // A blocker is reported from the live attempt, and recording it ends that attempt (GY-1008).
  let blocked = await released(slice);
  blocked = await engine.execute(worker, 'claim', blocked.id, {}, randomUUID());
  blocked = await engine.execute(worker, 'workspace', blocked.id, { epoch: blocked.epoch, host: 'machine-a', path: `/tmp/${blocked.id}`, branch: `graphyard/${blocked.key.toLowerCase()}` }, randomUUID());
  blocked = await engine.execute(worker, 'blocked', blocked.id, { epoch: blocked.epoch, reason: 'Waiting on an external provider decision' }, randomUUID());
  const root = await released(slice);
  const middle = await released(slice, { dependencies: [root.id] });
  const leaf = await released(slice, { dependencies: [middle.id] });

  const deliveredDependency = await released('gy35-out-of-scope-dependency');
  await seedFact(deliveredDependency, 'delivered', now - 1000, { mergeSha: '6'.repeat(40), pr: null }, 'done');
  const filteredDependent = await released('gy35-filtered-dependent', { dependencies: [deliveredDependency.id] });

  let reviewed = await submitted(slice, second);
  const changesAt = new Date(now - 3 * 3600_000).toISOString(), approvedAt = new Date(now - 2 * 3600_000).toISOString();
  reviewed = await engine.observe(reviewed.id, reviewed.revision, observation(reviewed, slice, { reviews: [{ reviewer: 'first-reviewer', sha: head, state: 'CHANGES_REQUESTED', id: 9401, submittedAt: changesAt }] }));
  reviewed = await engine.observe(reviewed.id, reviewed.revision, observation(reviewed, slice, { reviews: [{ reviewer: 'first-reviewer', sha: head, state: 'DISMISSED', id: 9401, submittedAt: changesAt }, { reviewer: 'second-reviewer', sha: head, state: 'APPROVED', id: 9402, submittedAt: approvedAt }] }));
  await engine.execute(operator, 'rework', reviewed.id, { reason: 'Previous worker stopped; reproduce the failure', previousWorkerStopped: true }, randomUUID());
  await engine.execute(second, 'claim', reviewed.id, {}, randomUUID());

  const longReason = `Waiting on a provider incident: ${'x'.repeat(260)}`;
  let longBlocked = await released(slice);
  longBlocked = await engine.execute(second, 'claim', longBlocked.id, {}, randomUUID());
  longBlocked = await engine.execute(second, 'workspace', longBlocked.id, { epoch: longBlocked.epoch, host: 'machine-a', path: `/tmp/${longBlocked.id}`, branch: `graphyard/${longBlocked.key.toLowerCase()}` }, randomUUID());
  longBlocked = await engine.execute(second, 'blocked', longBlocked.id, { epoch: longBlocked.epoch, reason: longReason }, randomUUID());

  const { report, dataset } = await analyse({ slice });
  const operations = report.operations;
  assert.ok(operations.blockers.some(entry => entry.reason === 'Waiting on an external provider decision' && entry.count === 1));
  const truncatedBlocker = operations.blockers.find(entry => entry.reason === longReason.slice(0, 200))!;
  assert.ok(truncatedBlocker && truncatedBlocker.count === 1, 'long blocker reasons aggregate under a bounded label');
  const blockerRows = flowDrilldown(dataset, report, { metric: 'blockers', key: truncatedBlocker.reason });
  assert.equal(blockerRows.total, 1, 'selecting the bounded label reaches the record behind the aggregate');
  assert.equal(blockerRows.rows[0].workKey, longBlocked.key);
  assert.equal(blockerRows.rows[0].detail, longReason, 'the drill-down carries the full recorded reason');
  assert.ok(operations.refusals.length > 0 && operations.refusals.every(entry => entry.count > 0));
  assert.ok(operations.refusalGates.some(entry => entry.reason === 'ready' || entry.reason === 'review' || entry.reason === 'build'));
  assert.equal(operations.criticalPath.length, 3);
  assert.deepEqual(operations.criticalPath.chain, [root.key, middle.key, leaf.key]);
  assert.ok(operations.unblocked.items.includes(root.key) && !operations.unblocked.items.includes(leaf.key));
  const filteredOperations = (await analyse({ slice: 'gy35-filtered-dependent' })).report.operations;
  assert.deepEqual(filteredOperations.criticalPath.chain, [filteredDependent.key], 'an out-of-scope delivered dependency is not treated as unfinished');
  const outsidePending = await released('gy35-out-of-scope-pending');
  const insideDependent = await released('gy35-inside-dependent', { dependencies: [outsidePending.id] });
  const crossScope = (await analyse({ slice: 'gy35-inside-dependent' })).report.operations;
  assert.deepEqual(crossScope.criticalPath.chain, [outsidePending.key, insideDependent.key], 'critical paths traverse unfinished dependencies outside the presentation filter');
  assert.equal(operations.review.findings, 1, 'a change request is a recorded finding');
  assert.equal(operations.review.approvals, 1);
  assert.equal(operations.review.independentApprovals, 1);
  assert.ok(operations.review.rounds.n >= 1 && operations.review.rounds.max! >= 3);
  assert.equal(operations.review.reworkRequests, 1);
  assert.ok(operations.review.reworkRate! > 0 && operations.review.reworkRate! <= 1);
  assert.ok(operations.leases.claims >= 3);
  assert.equal(operations.leases.reassignments, 1, 'a second epoch on the same item is a reassignment');
  assert.ok(operations.leases.losses >= 1);
  assert.ok(operations.leases.utilizationRatio !== null && operations.leases.idleCapacityMs >= 0);
  assert.deepEqual(operations.queues.map(queue => queue.queue), ['reviewer', 'proof', 'operator', 'worker', 'merge']);
  assert.ok(operations.queues.every(queue => queue.samples === 30 && queue.maxDepth !== null && queue.definition.length > 20));
  assert.equal(operations.queueDepth.length, 30);
  assert.ok(operations.deployments.observations >= 0);

  // Capacity and queueing are described without attributing work to a person.
  assert.equal(report.privacy.individualAttribution, 'excluded');
  const serialized = JSON.stringify(report);
  for (const identity of ['worker-a', 'worker-b', 'ci-runner', 'implementer', 'first-reviewer', 'second-reviewer', 'independent-reviewer', 'machine-a'])
    assert.ok(!serialized.includes(identity), `${identity} must not appear in flow analytics`);
  const facts = (await store.pool.query('SELECT details FROM flow_facts')).rows.map(row => JSON.stringify(row.details)).join('');
  for (const identity of ['worker-a', 'worker-b', 'implementer', 'first-reviewer', 'second-reviewer'])
    assert.ok(!facts.includes(identity), `${identity} must not be stored in a flow fact`);
});

test('integration:flow-analytics-bottleneck-summary', async () => {
  const slice = 'gy35-snapshot';
  const reviewWaits: Work[] = [];
  for (let index = 0; index < 5; index++) {
    const item = await submitted(slice);
    reviewWaits.push(await engine.observe(item.id, item.revision, observation(item, slice)));
  }
  const reworked = await submitted(slice);
  const observedRework = await engine.observe(reworked.id, reworked.revision, observation(reworked, slice));
  await engine.execute(operator, 'rework', observedRework.id, { reason: 'Worker stopped before review completed', previousWorkerStopped: true }, randomUUID());
  for (let index = 0; index < 4; index++) {
    const item = await submitted(slice);
    await engine.observe(item.id, item.revision, observation(item, slice, { reviews: approval(head, 9500 + index) }));
  }
  const ready = await submitted(slice);
  const observed = await engine.observe(ready.id, ready.revision, observation(ready, slice, { reviews: approval(head, 9600) }));
  await engine.execute(producer, 'evidence', observed.id, proof(), randomUUID());
  for (let index = 0; index < 5; index++) await released(slice, { dependencies: [reviewWaits[0].id] });

  const snapshot = (await analyse({ slice })).report.bottleneck;
  const count = (id: string) => snapshot.categories.find(category => category.id === id)!.count;
  assert.equal(count('review'), 6, 'six items wait on review');
  assert.equal(count('evidence'), 4, 'four items wait on acceptance evidence');
  assert.equal(count('dependency'), 5, 'five items are dependency blocked');
  assert.equal(count('merge-ready'), 1, 'one item is merge ready');
  assert.equal(count('backlog') + count('blocked') + count('implementation') + count('merge-blocked'), 0);
  assert.equal(snapshot.scope.undelivered, 16);
  assert.equal(snapshot.leading!.category, 'review');
  assert.match(snapshot.narrative, /6 of 16 undelivered item\(s\) are waiting on review/);
  assert.ok(snapshot.observedAt && Date.parse(snapshot.observedAt) > 0);
  assert.deepEqual(snapshot.unclassified, []);
  assert.equal(snapshot.scope.filters.slice, slice);
  assert.ok(snapshot.categories.every(category => category.definition.length > 20));
  assert.ok(snapshot.categories.find(category => category.id === 'review')!.items.every(item => item.waitingMs !== null && item.key.startsWith('GY-')));

  // Merge readiness is read from the durable gate fact: the proven candidate holds a merge-queue
  // entry and the merge gate only sequences it, which is not a refusal. A queued candidate whose
  // pull request stops being mergeable is merge blocked until a later observation clears it.
  const readyGate = (await analyse({ slice })).dataset.latest.find(fact => fact.workId === observed.id && fact.kind === 'gates.changed')!.details;
  assert.deepEqual(readyGate.unmet, ['merge']);
  assert.equal(readyGate.queued, true);
  assert.equal(readyGate.mergeBlockers, 0);
  assert.ok(readyGate.reasons.every((reason: string) => /merge queue|speculative tip/i.test(reason)), `only queue sequencing remains: ${JSON.stringify(readyGate.reasons)}`);
  let queued = (await store.list()).find(item => item.id === observed.id)!;
  await engine.observe(queued.id, queued.revision, observation(queued, slice, { reviews: approval(head, 9600), mergeable: false }));
  const conflicted = (await analyse({ slice })).report.bottleneck;
  assert.equal(conflicted.categories.find(category => category.id === 'merge-blocked')!.count, 1, 'a queued but unmergeable candidate is blocked, not ready');
  assert.equal(conflicted.categories.find(category => category.id === 'merge-ready')!.count, 0);
  queued = (await store.list()).find(item => item.id === observed.id)!;
  await engine.observe(queued.id, queued.revision, observation(queued, slice, { reviews: approval(head, 9600) }));
  assert.equal((await analyse({ slice })).report.bottleneck.categories.find(category => category.id === 'merge-ready')!.count, 1);
  const gate = (overrides: Record<string, unknown>) => ({ released: true, hasCandidate: true, dependencyWaiting: [], blocker: null, unmet: ['merge'], ...overrides });
  assert.equal(classifyWait(gate({ queued: true, mergeBlockers: 0 }), false), 'merge-ready');
  assert.equal(classifyWait(gate({ queued: true, mergeBlockers: 1 }), false), 'merge-blocked');
  assert.equal(classifyWait(gate({ queued: false, mergeBlockers: 0 }), false), 'merge-blocked', 'an ejected or never-queued candidate is not merge ready');
  assert.equal(classifyWait(gate({}), false), 'merge-blocked', 'a fact recorded before queue fields existed is never promoted');
  assert.equal(classifyWait(gate({ unmet: [] }), false), 'merge-ready');
  assert.equal(mergeReadyGate(gate({ unmet: ['acceptance', 'merge'], queued: true, mergeBlockers: 0 })), false);

  // The summary is computed from durable observations: a new approval moves the count.
  const promoted = reviewWaits[1];
  const current = (await store.list()).find(item => item.id === promoted.id)!;
  await engine.observe(current.id, current.revision, observation(current, slice, { reviews: approval(head, 9700) }));
  const updated = (await analyse({ slice })).report.bottleneck;
  const updatedCount = (id: string) => updated.categories.find(category => category.id === id)!.count;
  assert.equal(updatedCount('review'), 5, 'the value follows the new observation instead of a hard-coded number');
  assert.equal(updatedCount('evidence'), 5);
  assert.equal(updatedCount('dependency'), 5);
  assert.equal(updatedCount('merge-ready'), 1);

  // The drill-down population matches the summarised count exactly.
  const { dataset, report } = await analyse({ slice });
  const drilled = flowDrilldown(dataset, report, { metric: 'bottleneck', key: 'review' });
  assert.equal(drilled.total, 5);
  assert.equal(new Set(drilled.rows.map(row => row.workKey)).size, 5);
});

test('integration:flow-analytics-drilldown-export', async () => {
  const slice = 'gy35-drill';
  let work = await submitted(slice);
  work = await engine.observe(work.id, work.revision, observation(work, slice, { reviews: approval(head, 9800) }));
  work = await engine.execute(producer, 'evidence', work.id, proof(), randomUUID());
  const { dataset, report } = await analyse({ slice });

  const evidenceRows = flowDrilldown(dataset, report, { metric: 'evidence', authorized: true });
  assert.equal(evidenceRows.total, 1);
  assert.equal(evidenceRows.rows[0].workKey, work.key);
  assert.equal(evidenceRows.rows[0].commit, head);
  assert.match(String(evidenceRows.rows[0].detail), /evidence=[0-9a-f-]{36}/, 'an authorized reader reaches the exact evidence record');
  const guarded = flowDrilldown(dataset, report, { metric: 'evidence', authorized: false });
  assert.match(String(guarded.rows[0].detail), /identifiers require an authorized role/);
  assert.ok(!String(guarded.rows[0].detail).includes('evidence='));
  const reviewRows = flowDrilldown(dataset, report, { metric: 'review', key: 'APPROVED' });
  assert.equal(reviewRows.total, 1);
  assert.equal(reviewRows.rows[0].commit, head);
  const mergeReady = flowDrilldown(dataset, report, { metric: 'merge-ready' });
  assert.ok(mergeReady.rows.some(row => row.workKey === work.key));
  const bottleneckRows = flowDrilldown(dataset, report, { metric: 'bottleneck', key: 'merge-ready' });
  assert.equal(bottleneckRows.rows[0].pullRequest, work.submission!.pr);
  assert.equal(flowDrilldown(dataset, report, { metric: 'nonsense' }).error?.startsWith('Unknown drill-down metric'), true);

  const csv = flowExport(report, evidenceRows, 'csv');
  assert.equal(csv, flowExport(computeFlow(dataset, { days: 30, slice }), flowDrilldown(dataset, computeFlow(dataset, { days: 30, slice }), { metric: 'evidence', authorized: true }), 'csv'), 'the same bounded result exports identical bytes');
  assert.match(csv, /^# metric,evidence\n/);
  assert.match(csv, /\n# timezone,UTC\n/);
  assert.match(csv, new RegExp(`\\n# windowDays,30\\n`));
  assert.match(csv, /\n# windowBoundaries,"Half-open/);
  assert.match(csv, new RegExp(`\\n# filterSlice,${slice}\\n`));
  assert.match(csv, /\n# definition,Wait is review completion/);
  assert.match(csv, /\n# coverageWorkItems,1\n/);
  assert.match(csv, /\n# exclusions,/);
  assert.match(csv, /\n# generatedAt,/);
  assert.match(csv, /\nworkKey,metric,bucket,observedAt,valueMs,pullRequest,commit,detail\n/);
  assert.ok(csv.includes(`\n${work.key},evidence,integration:flow,`));
  assert.ok(csv.endsWith('\n'));
  const json = JSON.parse(flowExport(report, evidenceRows, 'json'));
  assert.equal(json.metadata.timezone, 'UTC');
  assert.equal(json.metadata.rows, 1);
  assert.equal(json.metadata.identifiersAuthorized, true);
  assert.deepEqual(json.columns, evidenceRows.columns);

  const served = await api(`/api/analytics/flow/drilldown?window=30&slice=${slice}&metric=bottleneck&key=merge-ready`);
  assert.equal(served.status, 200);
  assert.equal(served.body.rows.length, 1);
  const readerView = await api(`/api/analytics/flow/drilldown?window=30&slice=${slice}&metric=evidence`, tokens.reader);
  assert.ok(!String(readerView.body.rows[0].detail).includes('evidence='), 'a reader gets counts without evidence identifiers');
  const rawDeployments = await api('/api/deployments', tokens.reader);
  assert.equal(rawDeployments.status, 403, 'raw deployment identifiers require an audit role');
  const download = await fetch(`${url}/api/analytics/flow/export?window=30&slice=${slice}&metric=evidence&format=csv`, { headers: { Authorization: `Bearer ${tokens.operator}` } });
  assert.equal(download.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(download.headers.get('content-disposition') ?? '', /graphyard-flow-evidence-30d\.csv/);
  assert.match(await download.text(), /^# metric,evidence/);
});

// GY-161: the flow route reads the production watch itself on every request, so a merge the watch
// still reports unserved stays at Deploy in the steps history without any client having polled
// /api/status in this process (after a restart, or when only the flow report is read).
test('integration:flow-analytics-production-hold', async () => {
  const slice = 'gy161-hold';
  let work = await submitted(slice);
  const reviewed = { reviews: approval(head, 9301) };
  work = await engine.observe(work.id, work.revision, observation(work, slice, reviewed));
  work = await engine.execute(producer, 'evidence', work.id, proof(), randomUUID());
  await deliver(work, slice, '6'.repeat(40), reviewed);
  await projectFlow(store);
  const watch = { observedAt: new Date(Date.now() - 60_000).toISOString(), serving: '7'.repeat(40), error: null, pending: [work.key], incidents: [] };
  const watched = server(engine, [{ ...operator, token: tokens.operator }], null, undefined, { production: { status: () => watch } as any });
  await new Promise<void>(resolve => watched.listen(0, '127.0.0.1', resolve));
  try {
    const steps = async (base: string) => {
      const response = await fetch(`${base}/api/analytics/flow/drilldown?metric=steps&slice=${slice}`, { headers: { Authorization: `Bearer ${tokens.operator}` } });
      assert.equal(response.status, 200);
      return ((await response.json()).rows as { workKey: string; detail: string }[]).filter(row => row.workKey === work.key).map(row => row.detail);
    };
    assert.ok((await steps(url)).includes('deploy to outside'), 'with no production watch the merge takes it out of the flow');
    assert.ok(!(await steps(`http://127.0.0.1:${(watched.address() as any).port}`)).includes('deploy to outside'), 'the watch holds it at Deploy on the flow read alone');
  } finally { await new Promise<void>(resolve => watched.close(() => resolve())); }
});

test('integration:flow-analytics-master-production-environment', async () => {
  // The master verifies deployments under `config.run.productionEnvironment`, a setting on its own
  // host; its loop publishes that name and the dashboard and flow report read releases under it.
  const read = async () => ({ status: (await api('/api/status')).body.productionEnvironment, flow: (await api('/api/analytics/flow?window=7')).body.productionEnvironment });
  assert.deepEqual(await read(), { status: 'production', flow: 'production' }, 'before any publication the server reads its own setting');
  assert.equal((await api('/api/production-environment', tokens.worker, { method: 'POST', body: JSON.stringify({ environment: 'elsewhere' }) })).status, 403, 'only the master (or an operator) names it');
  assert.equal((await api('/api/production-environment', tokens.coordinator, { method: 'POST', body: JSON.stringify({ environment: ' ' }) })).status, 400);
  const posted: string[] = [];
  const mutate = async (path: string, data: unknown) => {
    posted.push(path);
    const response = await api(`/api/${path}`, tokens.coordinator, { method: 'POST', body: JSON.stringify(data) });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  let configured: string | undefined = 'graphyard / production';
  const effects = daemonEffects(process.cwd(), () => ({ url, run: { productionEnvironment: configured } }) as any, { snapshot: async () => ({ work: [], now: new Date().toISOString() }), mutate, executor: {} as any });
  try {
    await effects.publishProductionEnvironment!();
    await effects.publishProductionEnvironment!();
    assert.deepEqual(posted, ['production-environment'], 'published once, not every cycle');
    assert.deepEqual(await read(), { status: 'graphyard / production', flow: 'graphyard / production' }, 'both routes read the master-configured name per request');
    // Clearing the setting publishes what the master then resolves (its environment, else production).
    configured = undefined;
    const previous = process.env.GRAPHYARD_PRODUCTION_ENVIRONMENT; delete process.env.GRAPHYARD_PRODUCTION_ENVIRONMENT;
    try { await effects.publishProductionEnvironment!(); } finally { if (previous !== undefined) process.env.GRAPHYARD_PRODUCTION_ENVIRONMENT = previous; }
    assert.equal(posted.length, 2);
    assert.deepEqual(await read(), { status: 'production', flow: 'production' });
  } finally {
    await api('/api/production-environment', tokens.coordinator, { method: 'POST', body: JSON.stringify({ environment: 'production' }) });
  }
});

test('unit:flow-read-not-crowded-out — 25,000 check-run facts early in a 7-day window never crowd a day-7 gated merge, a direct-merge delivery or their step moves out of the report', async () => {
  const slice = 'gy183-crowded';
  const gated = await released(slice), direct = await released(slice);
  // Read as of 23:00 UTC yesterday, so "day 7" is a whole calendar day whatever the clock says now.
  const asOf = Math.floor(Date.now() / day) * day - 3600_000, from = asOf - 7 * day, dayStart = Math.floor(asOf / day) * day;
  for (const item of [gated, direct]) await seedFact(item, 'work.created', from - day, { type: 'feature' });
  await store.pool.query(`INSERT INTO flow_facts(work_id,work_key,kind,observed_at,recorded_at,source,source_event,stage,work_type,slices,details,dedupe)
    SELECT $1,$2,'check.observed',$3::timestamptz + g * interval '10 milliseconds',$3::timestamptz,'ci',0,'test','feature',$4,'{"name":"test","result":"success"}'::jsonb,concat('gy183-check:',g)
    FROM generate_series(1,25000) g`, [gated.id, gated.key, new Date(from + day).toISOString(), workSlices(gated).slices]);
  const gate = (stage: string, unmet: string[]) => ({ stage, unmet, hasCandidate: true, released: true, pr: 900 });
  await seedFact(gated, 'gates.changed', asOf - 3 * 3600_000, gate('review', ['review', 'acceptance', 'merge']), 'review');
  await seedFact(gated, 'gates.changed', asOf - 2 * 3600_000, gate('merge', ['merge']), 'merge');
  await seedFact(gated, 'merged', asOf - 40 * 60_000, { pr: 900, mergeSha: 'c'.repeat(40) }, 'done');
  await seedFact(gated, 'delivered', asOf - 40 * 60_000, { pr: 900, mergeSha: 'c'.repeat(40) }, 'done');
  await seedFact(gated, 'gates.changed', asOf - 39 * 60_000, gate('done', []), 'done');
  await seedFact(direct, 'merged', asOf - 20 * 60_000, { pr: 901, mergeSha: 'd'.repeat(40), direct: true }, 'done');
  await seedFact(direct, 'delivered', asOf - 20 * 60_000, { pr: 901, mergeSha: 'd'.repeat(40), direct: true }, 'done');

  const query: FlowQuery = { days: 7, slice, asOf: new Date(asOf).toISOString() };
  const dataset = await readFlow(store, query);
  assert.equal(dataset.truncated, true, 'the check-run facts alone exhaust the shared 20,000-row scan');
  assert.ok(dataset.covered!.toCovered < new Date(dayStart).toISOString(), 'the shared scan stops days before day 7');
  const report = computeFlow(dataset, query);
  const last = report.throughput.at(-1)!;
  assert.equal(last.bucket, new Date(dayStart).toISOString());
  assert.equal(last.delivered, 2, 'the gated merge and the direct-merge delivery both land on day 7');
  assert.equal(last.covered, true);
  assert.equal(report.throughput.reduce((sum, bucket) => sum + bucket.delivered, 0), 2);
  const moves = stepMoves(dataset, gated).filter(move => Date.parse(move.at) >= dayStart);
  assert.deepEqual(moves.map(move => `${move.from}>${move.to}@${move.at}`), [
    `null>review@${new Date(asOf - 3 * 3600_000).toISOString()}`, `review>merge@${new Date(asOf - 2 * 3600_000).toISOString()}`, `merge>deploy@${new Date(asOf - 40 * 60_000).toISOString()}`], 'the merge moves it to Deploy when it is observed');
  assert.ok(report.window.kinds.every(entry => entry.toCovered === dataset.to), 'deliveries, merges and gate changes cover the whole window');
  assert.match(report.window.covered.statement, /read past that cutoff on bounds of their own/);
});

test('unit:steps-drilldown-reads-recent-moves — the steps drill-down reads only gate and merge facts from its instant on, so more than a scan bound of earlier facts never hides the last day\'s moves; a read that stops short says so and the page names it', async () => {
  const slice = 'gy1119-recent';
  const mover = await released(slice), noise = await released(slice);
  const asOf = Math.floor(Date.now() / day) * day - 3600_000, from = asOf - 7 * day, instant = asOf - day;
  for (const item of [mover, noise]) await seedFact(item, 'work.created', from - day, { type: 'feature' });
  const gate = (stage: string, unmet: string[]) => ({ stage, unmet, hasCandidate: true, released: true, pr: 1119 });
  // Before the replay instant: more than a scan bound of check runs, then more than a bound of gate
  // facts that never move the noise item, so even the per-kind gate read past the shared scan stops early.
  const seedMany = (item: Work, kind: string, start: number, details: object) => store.pool.query(`INSERT INTO flow_facts(work_id,work_key,kind,observed_at,recorded_at,source,source_event,stage,work_type,slices,details,dedupe)
    SELECT $1::uuid,$2,$3::text,$4::timestamptz + g * interval '10 milliseconds',$4::timestamptz,'graphyard',0,'review','feature',$5,$6::jsonb,concat($3::text,':',$1::text,':',g)
    FROM generate_series(1,$7::int) g`, [item.id, item.key, kind, new Date(start).toISOString(), workSlices(item).slices, JSON.stringify(details), flowLimits.scan + 1000]);
  await seedMany(noise, 'check.observed', from + day, { name: 'test', result: 'success' });
  await seedMany(noise, 'gates.changed', from + 2 * day, gate('review', ['review', 'acceptance', 'merge']));
  await seedFact(mover, 'gates.changed', instant - 3600_000, gate('review', ['review', 'acceptance', 'merge']), 'review');
  await seedFact(mover, 'gates.changed', asOf - 3 * 3600_000, gate('merge', ['merge']), 'merge');
  // Two more observations at Merge: no move, but more gate facts than the short read below may take.
  for (const at of [asOf - 2 * 3600_000, asOf - 90 * 60_000]) await seedFact(mover, 'gates.changed', at, gate('merge', ['merge']), 'merge');
  await seedFact(mover, 'merged', asOf - 40 * 60_000, { pr: 1119, mergeSha: 'e'.repeat(40) }, 'done');

  // The whole window's read is exhausted before the instant: the moves after it were never loaded.
  const whole = await readFlow(store, { days: 7, slice, asOf: new Date(asOf).toISOString() });
  assert.ok(Date.parse(coveredUntil(whole, 'gates.changed')!) < instant, 'the window read stops before the replay instant');

  const key = new Date(instant).toISOString();
  const response = await api(`/api/analytics/flow/drilldown?window=7&metric=steps&slice=${slice}&asOf=${encodeURIComponent(new Date(asOf).toISOString())}&key=${encodeURIComponent(key)}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.rows.filter((row: any) => row.workKey === mover.key).map((row: any) => `${row.detail}@${row.observedAt}`).sort((a: string, b: string) => a.split('@')[1].localeCompare(b.split('@')[1])), [
    `review to merge@${new Date(asOf - 3 * 3600_000).toISOString()}`, `merge to deploy@${new Date(asOf - 40 * 60_000).toISOString()}`], 'every move after the instant is returned');
  assert.equal(response.body.rows.filter((row: any) => row.workKey === noise.key).length, 0, 'the noise item never moved after the instant');
  assert.deepEqual(response.body.coverage, { truncated: false, toCovered: new Date(asOf).toISOString(), statement: null });

  // A bounded read that stops before the end of its window reports truncated, with the read's statement.
  const short = await pooledFlowDrilldown(store, { days: 7, slice, asOf: new Date(asOf).toISOString(), limit: 1 }, { metric: 'steps', key });
  assert.equal(short.coverage.truncated, true);
  assert.equal(short.coverage.toCovered, new Date(asOf - 2 * 3600_000).toISOString(), 'covered to the last gate fact its own bound read');
  assert.deepEqual(short.rows.map(row => row.detail), ['review to merge'], 'no move past where the read stopped');
  assert.match(short.coverage.statement!, /1-row bound/);
  // The page reads that coverage with the rows and names the truncation instead of "No item changed step".
  const steps = await readStepRows(async () => ({ rows: [], truncated: false, next: null, coverage: short.coverage }), key);
  assert.equal(steps.coverage, short.coverage.statement);
  const replay = await readReplay(async () => ({ rows: [], truncated: false, next: null, coverage: short.coverage }), asOf);
  assert.deepEqual([replay.frames.length, replay.truncated, replay.coverage], [0, true, short.coverage.statement]);
  const full = await readReplay(async () => ({ rows: [], truncated: false, next: null, coverage: { truncated: false, statement: null } }), asOf);
  assert.deepEqual([full.truncated, full.coverage], [false, null]);
  // The Flow page's replay read is rendered with the truncated replay rather than inspected by regex
  // (GY-1154), through the component InsightsPage renders it with, not by patching React's hooks (GY-1164).
  const renderFlow = (replayData: { frames: any[]; truncated: boolean; coverage: string | null }) =>
    renderToStaticMarkup(createElement(ReplayRead, { ...replayData, replayError: '' }));
  const truncatedPage = renderFlow(replay);
  assert.match(truncatedPage, /<p class="notice" role="status" data-flow="replay-truncated">The recorded step changes were read only in part: /);
  assert.ok(truncatedPage.includes(short.coverage.statement!), 'notice carries the coverage statement');
  assert.match(truncatedPage, /<p class="muted flow-wait">No item changed step in the part of the last 24 hours that was read\.<\/p>/);

  const fullPage = renderFlow(full);
  assert.doesNotMatch(fullPage, /data-flow="replay-truncated"/);
  assert.match(fullPage, /<p class="muted flow-wait">No item changed step in the last 24 hours\.<\/p>/);
  // InsightsPage itself renders that read from its own replay state: before the read answers, the
  // page shows ReplayRead's waiting text and no truncation notice (GY-1164 review).
  const page = renderToStaticMarkup(createElement(InsightsFlow, { work: [], status: null, api: async () => null, token: '', observedAt: asOf, setSelected: () => {} } as any));
  assert.ok(page.includes('<p class="muted flow-wait">Reading the recorded step changes…</p>'), 'InsightsPage renders ReplayRead with its unread replay state');
  assert.doesNotMatch(page, /data-flow="replay-truncated"/);
});

test('unit:flow-now-includes-rework — an unowned rework item with an open candidate is shown at Build in the Now view and counted in the flow', async () => {
  const work = await submitted('gy183-rework');
  const rework = { ...work, lease: null, reworkRequested: true, stage: 'build',
    candidate: { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces.at(-1)!.branch, author: 'implementer', createdAt: new Date().toISOString() } } as unknown as Work;
  const now = Date.now();
  assert.equal(groupOf(rework, now), 'up-next', 'the Work page files unowned rework under Up next');
  const { entries, outside } = flowNow([rework], now, null);
  assert.deepEqual(entries.map(entry => [entry.item.key, entry.steps.current]), [[rework.key, 'build']]);
  assert.equal(outside.upNext, 0);
  const page = renderToStaticMarkup(createElement(InsightsFlow, { work: [rework], status: null, api: async () => null, observedAt: now, setSelected: () => {} } as unknown as Dashboard));
  assert.match(page, new RegExp(`class="now-dot[^"]*" data-step="build" data-key="${rework.key}"`), 'the item is a Now dot at Build');
  assert.match(page, /1 item is in the flow now/, 'and it is counted');
  assert.match(page, /<strong>Build<\/strong><span>1 now/);
  assert.match(page, /0 up next/);
  // Without an open candidate, work waiting for a builder is still outside the flow.
  const unstarted = { ...rework, candidate: null, submission: null } as unknown as Work;
  assert.deepEqual(flowNow([unstarted], now, null).entries, []);
});

test('integration:flow-analytics-bounded-indexed', async () => {
  const slice = 'gy35-bounds';
  const blocker = await released(slice);
  for (let index = 0; index < 27; index++) await released(slice, { dependencies: [blocker.id] });
  const spread = await submitted(slice, second);
  const now = Date.now();
  for (let index = 0; index < 210; index++)
    await seedFact(spread, 'stage.changed', now - (index + 1) * 60_000, { from: 'review', to: 'test', dwellMs: 60_000 + index, clockOrder: 'ordered' }, 'review');

  const { dataset, report } = await analyse({ slice });
  assert.equal(report.bottleneck.categories.find(category => category.id === 'dependency')!.count, 27);
  assert.equal(report.bottleneck.categories.find(category => category.id === 'dependency')!.items.length, flowLimits.distinct);
  assert.equal(report.bottleneck.categories.find(category => category.id === 'dependency')!.truncated, true);
  const dependencyRows = flowDrilldown(dataset, report, { metric: 'bottleneck', key: 'dependency' });
  assert.equal(dependencyRows.total, 27, 'bottleneck drill-down uses the full aggregate population');
  const largestWip = [...report.wip].sort((a, b) => b.count - a.count)[0];
  const wipRows = flowDrilldown(dataset, report, { metric: 'wip', key: largestWip.stage });
  assert.equal(wipRows.total, largestWip.count, 'WIP drill-down is independent of the 25-row summary preview');
  const rows = flowDrilldown(dataset, report, { metric: 'stage-dwell', key: 'review' });
  assert.equal(rows.total, 210);
  assert.equal(rows.rows.length, flowLimits.drilldown);
  assert.equal(rows.truncated, true);
  assert.ok(JSON.stringify(report).length < flowLimits.payloadBytes, 'the report payload stays inside its bound');
  assert.equal(report.cumulativeFlow.buckets.length, 30);
  assert.equal((await analyse({ days: 90, slice })).report.cumulativeFlow.buckets.length, flowLimits.buckets);
  assert.ok(report.operations.refusals.length <= flowLimits.distinct);

  // An exhausted scan bound is reported, never silently trimmed.
  const bounded = await analyse({ slice, limit: 5 });
  assert.equal(bounded.dataset.truncated, true);
  assert.equal(bounded.dataset.scanned, 5);
  assert.ok(bounded.dataset.facts.slice(5).every(fact => separateKinds.includes(fact.kind)), 'past the shared bound only the separately read kinds are added');
  assert.equal(bounded.report.coverage.truncated, true);
  assert.equal(bounded.report.coverage.complete, false);
  assert.equal(bounded.report.coverage.scanLimit, 5);

  // Deterministic ordering: the same bounded query returns the same rows in the same order.
  const repeat = await readFlow(store, { days: 30, slice, limit: 50 });
  const again = await readFlow(store, { days: 30, slice, limit: 50 });
  assert.deepEqual(repeat.facts.map(fact => fact.dedupe), again.facts.map(fact => fact.dedupe));

  // Duplicate and delayed projection passes are idempotent, including concurrent ones.
  const before = Number((await store.pool.query('SELECT count(*)::int AS total FROM flow_facts')).rows[0].total);
  await Promise.all([projectFlow(store), projectFlow(store), projectFlow(store)]);
  const after = Number((await store.pool.query('SELECT count(*)::int AS total FROM flow_facts')).rows[0].total);
  assert.equal(after, before, 'replaying the ledger inserts no duplicate fact');
  const distinct = Number((await store.pool.query('SELECT count(DISTINCT dedupe)::int AS total FROM flow_facts')).rows[0].total);
  assert.equal(distinct, after);
  const events = (await store.pool.query('SELECT seq,work_id,actor,kind,payload,created_at FROM events WHERE work_id=$1 ORDER BY seq LIMIT 5', [spread.id])).rows;
  const firstPass = events.flatMap(event => deriveFacts(event as any, {}).map(fact => fact.dedupe));
  const secondPass = events.flatMap(event => deriveFacts(event as any, {}).map(fact => fact.dedupe));
  assert.deepEqual(firstPass, secondPass, 'derivation is a pure function of the ledger');

  // Concurrent new observations keep the checkpoint monotonic and the projection complete.
  const extra = await submitted(slice);
  await engine.observe(extra.id, extra.revision, observation(extra, slice));
  const advanced = await projectFlow(store);
  assert.ok(advanced.checkpoint >= 0);
  const pending = await analyse({ slice });
  assert.equal(pending.report.coverage.projection.pendingEvents, 0);

  // A usable index backs the window scan and the per-item carry-in read.
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const plan = (await client.query('EXPLAIN SELECT * FROM flow_facts WHERE work_id=ANY($1) AND observed_at>=$2 AND observed_at<$3 ORDER BY observed_at,id LIMIT 100',
      [dataset.included.map(item => item.id), dataset.from, dataset.to])).rows.map(row => row['QUERY PLAN']).join('\n');
    assert.match(plan, /flow_facts_(work|time|kind)/, 'the window scan uses a flow_facts index');
    const indexes = (await client.query("SELECT indexname FROM pg_indexes WHERE tablename='flow_facts'")).rows.map(row => row.indexname);
    assert.ok(indexes.includes('flow_facts_work_kind_latest'), 'carry-state lookups have a work/kind/time index');
    await client.query('ROLLBACK');
  } finally { client.release(); }

  // A claim that immediately replaces an expired lease keeps its active time: the old
  // loss closes before the replacement claim opens, at one recorded instant.
  const leaseItem = await submitted('gy35-lease-replacement');
  const replacementAt = Date.now();
  await seedFact(leaseItem, 'lease.lost', replacementAt, { epoch: 1, reason: 'expired' });
  await seedFact(leaseItem, 'lease.claimed', replacementAt, { epoch: 2, reassignment: true });
  await projectFlow(store);
  const leaseQuery: FlowQuery = { days: 30, slice: 'gy35-lease-replacement' };
  const resumedDataset = await readFlow(store, leaseQuery);
  const resumedRow = computeFlow(resumedDataset, leaseQuery).queueVsActive.items.find(row => row.key === leaseItem.key)!;
  assert.ok(resumedRow, 'the replaced item stays in scope');
  assert.ok(resumedRow.activeMs >= Date.parse(resumedDataset.to) - replacementAt - 1_000, 'the replacement lease is active time, not queue time');
  const staleLease: ProjectionState = { created: true, leaseEpoch: 1 };
  const replacementEvent = { seq: 9_999_999, work_id: leaseItem.id, actor: 'system', kind: 'claim', payload: { work: { ...leaseItem, lease: { epoch: 2 } } }, created_at: new Date().toISOString() } as any;
  const replacementFacts = deriveFacts(replacementEvent, staleLease);
  assert.deepEqual(replacementFacts.filter(fact => fact.kind.startsWith('lease.')).map(fact => fact.kind), ['lease.lost', 'lease.claimed'],
    'an expiring lease closes before its replacement opens');

  // An exhausted work-item scan bound is partial coverage: the newest items are reported
  // as excluded by the bound, never silently dropped.
  const bulk = Array.from({ length: flowLimits.work + 1 }, (_, index) => `('${randomUUID()}', '{"key":"GY-BULK-${index}","type":"chore","title":"Bulk fixture ${index}","criteria":[]}'::jsonb)`);
  await store.pool.query(`INSERT INTO work_items(id,document) VALUES ${bulk.join(',')}`);
  try {
    const overflow = await readFlow(store, { days: 30, slice });
    assert.equal(overflow.work.length, flowLimits.work);
    assert.equal(overflow.workTruncated, true);
    const overflowReport = computeFlow(overflow, { days: 30, slice });
    assert.equal(overflowReport.coverage.workItemScanLimit, flowLimits.work);
    assert.equal(overflowReport.coverage.workItemsTruncated, true);
    assert.equal(overflowReport.coverage.complete, false, 'a work-item bound is partial coverage');
  } finally {
    await store.pool.query("DELETE FROM work_items WHERE document->>'key' LIKE 'GY-BULK-%'");
  }

  // The independent contained-merge join has its own +1 probe. A release commit can
  // contain more merge facts than the deployment-observation count itself suggests.
  const containmentSha = '8'.repeat(40), containmentId = randomUUID();
  await store.pool.query(`INSERT INTO deployment_observations(id,provider,external_id,environment,sha,state,started_at,producer)
    VALUES($1,'test','large-release','production',$2,'succeeded',clock_timestamp()-interval '1 second','system')`, [containmentId, '7'.repeat(40)]);
  await store.pool.query('INSERT INTO deployment_merge_observations(deployment_id,merge_sha) VALUES($1,$2)', [containmentId, containmentSha]);
  await store.pool.query(`INSERT INTO flow_facts(work_id,work_key,kind,observed_at,recorded_at,source,source_event,stage,work_type,slices,details,dedupe)
    SELECT $1,$2,'merged',clock_timestamp()-interval '2 seconds',clock_timestamp(),'github',0,'done','feature',$3,$4,concat('merge-bound:',g)
    FROM generate_series(1,$5) g`, [leaseItem.id, leaseItem.key, workSlices(leaseItem).slices, JSON.stringify({ mergeSha: containmentSha }), flowLimits.deploymentMerges + 1]);
  const mergeOverflow = await readFlow(store, { days: 30, slice });
  assert.equal(mergeOverflow.mergedForDeployments.length, flowLimits.deploymentMerges);
  assert.equal(mergeOverflow.deploymentMergesTruncated, true);
  const mergeOverflowReport = computeFlow(mergeOverflow, { days: 30, slice });
  assert.equal(mergeOverflowReport.coverage.deploymentMergeScanLimit, flowLimits.deploymentMerges);
  assert.equal(mergeOverflowReport.coverage.deploymentMergesTruncated, true);
  assert.equal(mergeOverflowReport.coverage.complete, false, 'a contained-merge join bound is partial coverage');

  // An exhausted deployment-observation bound is partial coverage too.
  const bulkDeployments = Array.from({ length: flowLimits.deployments + 1 }, (_, index) =>
    `('${randomUUID()}'::uuid,'test','bulk-${index}','production','${'9'.repeat(40)}','succeeded','${new Date(Date.now() - (index + 1) * 1_000).toISOString()}','system')`);
  await store.pool.query(`INSERT INTO deployment_observations(id,provider,external_id,environment,sha,state,started_at,producer) VALUES ${bulkDeployments.join(',')}`);
  const deploymentOverflow = await readFlow(store, { days: 30, slice });
  assert.equal(deploymentOverflow.deployments.length, flowLimits.deployments);
  assert.equal(deploymentOverflow.deploymentsTruncated, true);
  const deploymentReport = computeFlow(deploymentOverflow, { days: 30, slice });
  assert.equal(deploymentReport.coverage.deploymentScanLimit, flowLimits.deployments);
  assert.equal(deploymentReport.coverage.deploymentsTruncated, true);
  assert.equal(deploymentReport.coverage.complete, false, 'a deployment-observation bound is partial coverage');
});

const calendarItem = { id: '21111111-2222-4333-8444-555555555555', key: 'GY-900', title: 'Calendar fixture', type: 'feature', stage: 'build', plannedFiles: ['src/'], criteria: [], evidence: [], gates: [], violations: [], observation: null } as unknown as Work;
const calendarFact = (kind: string, observedAt: string, id: number): FlowFact => ({
  id, workId: calendarItem.id, workKey: calendarItem.key, kind: kind as FlowFact['kind'], observedAt, recordedAt: observedAt,
  source: 'graphyard', sourceEvent: id, stage: 'done', workType: 'feature', slices: ['src'], details: {}, dedupe: `${kind}:${id}`,
});
function calendarDataset(to: string, facts: FlowFact[], overrides: Partial<FlowDataset> = {}): FlowDataset {
  const created = calendarFact('work.created', new Date(Date.parse(to) - 10 * day).toISOString(), 1);
  return {
    observedAt: to, from: new Date(Date.parse(to) - 7 * day).toISOString(), to, days: 7, work: [calendarItem], included: [calendarItem],
    facts, latest: [created, ...facts.filter(fact => fact.kind === 'delivered')], carryIn: [], deployments: [], mergedForDeployments: [],
    scanned: facts.length, truncated: false, workTruncated: false, deploymentsTruncated: false, deploymentMergesTruncated: false,
    projection: { lastEvent: 10, updatedAt: to, pendingEvents: 0, pendingCapped: false }, ...overrides,
  };
}

test('unit:flow-calendar-buckets — daily buckets are UTC calendar days ending today, so a delivery at 22:15Z read at 22:55Z counts in today\'s bucket', () => {
  const to = '2026-09-24T22:55:00.000Z';
  const delivered = calendarFact('delivered', '2026-09-24T22:15:00.000Z', 2);
  const dataset = calendarDataset(to, [delivered]);
  const report = computeFlow(dataset, { days: 7 });
  assert.deepEqual(report.throughput.map(bucket => bucket.bucket), ['18', '19', '20', '21', '22', '23', '24'].map(date => `2026-09-${date}T00:00:00.000Z`),
    'bucket starts are UTC midnights and the last bucket is today');
  assert.equal(report.cumulativeFlow.buckets.length, 7);
  assert.equal(report.cumulativeFlow.truncated, false);
  const today = report.throughput.find(bucket => bucket.bucket === '2026-09-24T00:00:00.000Z')!;
  assert.equal(today, report.throughput.at(-1));
  assert.equal(today.delivered, 1, 'the 22:15Z delivery is in the bucket starting 2026-09-24T00:00:00.000Z');
  assert.equal(report.throughput.reduce((sum, bucket) => sum + bucket.delivered, 0), 1);
  assert.equal(report.leadTime.trend.at(-1)!.n, 1);
  const rows = flowDrilldown(dataset, report, { metric: 'throughput', key: '2026-09-24T00:00:00.000Z' });
  assert.deepEqual(rows.rows.map(row => row.workKey), ['GY-900'], 'the drill-down keys the delivery by the same calendar bucket');
  // The part of the window before the first midnight is still counted, in the first bucket.
  const early = computeFlow(calendarDataset(to, [calendarFact('delivered', '2026-09-17T23:30:00.000Z', 3)]), { days: 7 });
  assert.equal(early.throughput[0].delivered, 1);
});

test('a window ending exactly at 00:00Z ends on the day before: seven whole calendar days, none doubled and no empty today', () => {
  const to = '2026-09-25T00:00:00.000Z';
  const facts = ['18', '19', '20', '21', '22', '23', '24'].map((date, index) => calendarFact('delivered', `2026-09-${date}T00:30:00.000Z`, 2 + index));
  const report = computeFlow(calendarDataset(to, facts), { days: 7 });
  assert.deepEqual(report.throughput.map(bucket => bucket.bucket), ['18', '19', '20', '21', '22', '23', '24'].map(date => `2026-09-${date}T00:00:00.000Z`),
    'the last bucket is the day holding the window\'s last instant, not the exclusive end');
  assert.deepEqual(report.throughput.map(bucket => bucket.delivered), [1, 1, 1, 1, 1, 1, 1], 'each landing counts on the day it happened');
  assert.ok(report.throughput.every(bucket => bucket.covered));
  const buckets = dayBuckets(Date.parse(to) - 7 * day, Date.parse(to), 7);
  assert.equal(buckets.bucketOf(Date.parse('2026-09-18T00:00:00.000Z')), Date.parse('2026-09-18T00:00:00.000Z'));
  assert.equal(buckets.bucketOf(Date.parse(to)), null, 'the exclusive end is outside every bucket');
});

test('the exclusive report end is outside every calendar bucket when it falls part way through today', () => {
  const to = Date.parse('2026-09-24T22:55:00.000Z');
  const buckets = dayBuckets(to - 7 * day, to, 7);
  assert.equal(buckets.starts.at(-1), Date.parse('2026-09-24T00:00:00.000Z'));
  assert.equal(buckets.bucketOf(to - 1), Date.parse('2026-09-24T00:00:00.000Z'), 'the window\'s last instant is in today\'s bucket');
  assert.equal(buckets.bucketOf(to), null, 'the exclusive end is outside every bucket');
  assert.equal(buckets.bucketOf(Date.parse('2026-09-24T23:30:00.000Z')), null, 'an instant after the end but before midnight is outside every bucket');
});

test('facts read past the shared scan cutoff count landings and step moves but never complete a candidate episode\'s phases', () => {
  const to = '2026-09-24T22:55:00.000Z';
  const fact = (kind: string, observedAt: string, id: number, details: Record<string, unknown> = {}) => ({ ...calendarFact(kind, observedAt, id), details });
  const scanned = [
    fact('candidate.observed', '2026-09-22T10:00:00.000Z', 2, { sha: 'e'.repeat(40), pr: 902, prCreatedAt: '2026-09-22T09:00:00.000Z' }),
    fact('review.submitted', '2026-09-22T11:00:00.000Z', 3, { reviewState: 'APPROVED' }),
    fact('merge.authorized', '2026-09-22T11:30:00.000Z', 4),
  ];
  // Read only by the per-kind reads: the acceptance-clearing gate change, the merge and the delivery.
  const separate = [
    fact('gates.changed', '2026-09-23T10:00:00.000Z', 5, { stage: 'merge', unmet: ['merge'], hasCandidate: true, released: true }),
    fact('merged', '2026-09-23T12:00:00.000Z', 6, { mergeSha: 'e'.repeat(40) }),
    fact('delivered', '2026-09-23T12:00:00.000Z', 7, { mergeSha: 'e'.repeat(40) }),
  ];
  const facts = [...scanned, ...separate];
  const covered = coveredWindow(new Date(Date.parse(to) - 7 * day).toISOString(), to, scanned.at(-1)!.observedAt, 50_000, flowLimits.scan);
  const truncated = calendarDataset(to, facts, { truncated: true, covered, kindCovered: { delivered: to, merged: to, 'gates.changed': to }, scanEnd: { observedAt: scanned.at(-1)!.observedAt, id: 4 } });
  const report = computeFlow(truncated, { days: 7 });
  const phase = (id: string) => report.phases.find(entry => entry.phase === id)!.n;
  assert.equal(phase('review-complete-to-evidence-complete'), 0, 'a gate change read past the cutoff never stands in for evidence the scan did not read');
  assert.equal(phase('merge-authorized-to-merged'), 0, 'a merge read past the cutoff never completes an episode the scan stopped reading');
  assert.deepEqual(flowDrilldown(truncated, report, { metric: 'phase' }).rows.map(row => row.bucket), ['pr-created-to-review-start', 'review-start-to-review-complete'],
    'the drill-down keeps only the phases the scan read');
  assert.equal(report.throughput.find(bucket => bucket.bucket === '2026-09-23T00:00:00.000Z')!.delivered, 1, 'the delivery still lands');
  assert.deepEqual(stepMoves(truncated, calendarItem).map(move => move.to), ['merge', 'deploy'], 'and the step moves, including the merge, still count');
  // The same facts all read by the shared scan do complete those phases.
  const whole = computeFlow(calendarDataset(to, facts), { days: 7 });
  assert.equal(whole.phases.find(entry => entry.phase === 'review-complete-to-evidence-complete')!.n, 1);
  assert.equal(whole.phases.find(entry => entry.phase === 'merge-authorized-to-merged')!.n, 1);
});

test('unit:flow-truncation-visible — a truncated or stale report shows its coverage statement in place of the figures, and no zero bar is drawn for a day it never read', () => {
  const to = '2026-09-24T22:55:00.000Z', from = new Date(Date.parse(to) - 7 * day).toISOString();
  const reached = '2026-09-20T09:00:00.000Z';
  const facts = [calendarFact('delivered', '2026-09-19T10:00:00.000Z', 2)];
  const covered = coveredWindow(from, to, reached, 180_000, flowLimits.scan);
  const report = computeFlow(calendarDataset(to, facts, { truncated: true, covered }), { days: 7 });
  assert.equal(report.window.truncated, true);
  const page = renderToStaticMarkup(createElement(LandedPerDay, { report }));
  assert.match(page, /data-flow="coverage"/, 'the coverage notice appears');
  assert.ok(page.includes(escapeHtml(covered.statement.slice(0, 80))), 'the notice is the report\'s own coverage statement');
  const days = [...page.matchAll(/<div class="landed-day[^"]*" data-bucket="([^"]+)"( data-uncovered="true")?[^>]*>(.*?)<\/div>/g)].map(match => ({ bucket: match[1], uncovered: !!match[2], body: match[3] }));
  assert.equal(days.length, 7);
  const uncovered = days.filter(entry => Date.parse(entry.bucket) + day > Date.parse(reached));
  assert.deepEqual(uncovered.map(entry => entry.bucket), ['20', '21', '22', '23', '24'].map(date => `2026-09-${date}T00:00:00.000Z`));
  for (const entry of uncovered) {
    assert.ok(entry.uncovered, `${entry.bucket} is marked as not read`);
    assert.doesNotMatch(entry.body, /landed-bar|<span>0<\/span>/, `${entry.bucket} draws no zero bar`);
  }
  const read = days.filter(entry => !uncovered.includes(entry));
  assert.ok(read.every(entry => /landed-bar/.test(entry.body)), 'the days the scan read keep their bars');
  assert.match(read.find(entry => entry.bucket.startsWith('2026-09-19'))!.body, /<span>1<\/span>/);
  // A report whose projection lags the ledger says so, and draws no day as a count at all.
  const stale = computeFlow(calendarDataset(to, facts, { projection: { lastEvent: 10, updatedAt: to, pendingEvents: 42, pendingCapped: false } }), { days: 7 });
  const stalePage = renderToStaticMarkup(createElement(LandedPerDay, { report: stale }));
  assert.match(stalePage, /data-flow="coverage"[^>]*>The flow record is 42 ledger event\(s\) behind/);
  assert.doesNotMatch(stalePage, /class="landed-bar"/);
  // A complete report shows no notice and every day's bar, zeros included.
  const whole = renderToStaticMarkup(createElement(LandedPerDay, { report: computeFlow(calendarDataset(to, facts), { days: 7 }) }));
  assert.doesNotMatch(whole, /data-flow="coverage"/);
  assert.equal([...whole.matchAll(/class="landed-bar"/g)].length, 7);
});

test('unit:merged-never-prove — a gate fact recorded once the candidate merged says so, and a merged but undelivered item is never counted at Prove or any other pre-merge step', () => {
  const at = Date.parse('2026-09-24T10:00:00.000Z');
  const acceptanceRefuses = [
    { name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] }, { name: 'test', passed: true, reasons: [] },
    { name: 'acceptance', passed: false, reasons: ['AC-1: unit:flow needs trusted passing evidence'] }, { name: 'merge', passed: false, reasons: ['Acceptance must pass first'] },
  ];
  const item = { ...calendarItem, stage: 'acceptance', ready: true, gates: acceptanceRefuses, candidate: { sha: head, baseSha: base, pr: 903, branch: 'graphyard/gy-900', author: 'implementer', createdAt: new Date(at).toISOString() }, submission: { pr: 903, epoch: 1 } } as unknown as Work;
  const merged = { at: new Date(at).toISOString(), candidate: item.candidate!, merged: true, mergeSha: 'f'.repeat(40), mergedAt: new Date(at + 60_000).toISOString(), checks: [], reviews: [], files: [], scopeFiles: [] } as unknown as Observation;
  const state: ProjectionState = {};
  const gates = (seq: number, work: Work) => deriveFacts({ seq, work_id: work.id, actor: 'system', kind: 'observed', created_at: new Date(at + seq * 60_000).toISOString(), payload: { work } }, state).filter(fact => fact.kind === 'gates.changed');
  const before = gates(1, item);
  assert.equal(before.length, 1);
  assert.equal(before[0].details.merged, false);
  assert.equal(gateFactStep(before[0].details), 'prove', 'unmerged, a refusing acceptance gate is Prove');
  // The same refusing gates once the candidate merged: the merge is a new gate fact, and it records the merge.
  const after = gates(2, { ...item, observation: merged });
  assert.equal(after.length, 1, 'the merge alone is a new gate fact');
  assert.equal(after[0].details.merged, true, 'the gate fact records that the candidate merged');
  const step = gateFactStep(after[0].details);
  assert.notEqual(step, 'prove');
  assert.ok(step === 'merge' || step === 'deploy', `a merged, undelivered item is at Merge or Deploy, not ${step}`);
  // Whatever gate refuses first, rework or change requests included, a merged item never maps to a pre-merge step.
  for (const details of [
    { stage: 'acceptance', unmet: ['acceptance'], firstUnmet: 'acceptance', hasCandidate: true, merged: true },
    { stage: 'review', unmet: ['review', 'acceptance'], firstUnmet: 'review', reasons: ['Outstanding change requests must be resolved through a new review'], hasCandidate: true, merged: true },
    { stage: 'build', unmet: ['build'], firstUnmet: 'build', reasons: ['Worker has not submitted implementation for this attempt'], hasCandidate: true, reworkRequested: true, merged: true },
  ]) assert.ok(['merge', 'deploy'].includes(gateFactStep(details)!), JSON.stringify(details));
  // Its time after the merge is Deploy's in the step moves, so none of it is counted as Prove.
  const moves = stepMoves({ facts: [...before, ...after], carryIn: [] }, item);
  assert.deepEqual(moves.map(move => move.to), ['prove', 'deploy']);
  assert.equal(moves[1].at, after[0].observedAt, 'Prove ends when the merge is recorded');
});

test('a merge projected before gate facts recorded it still moves the item to Deploy at the observed merge, in the window and carried in from before it', () => {
  const fact = (kind: string, observedAt: string, id: number, details: Record<string, unknown> = {}) => ({ ...calendarFact(kind, observedAt, id), details });
  // Gate facts from before GY-183 carry no `merged` flag, so on their own they keep a merged item at Prove.
  const prove = (observedAt: string, id: number, reason: string) => fact('gates.changed', observedAt, id, { stage: 'acceptance', unmet: ['acceptance', 'merge'], firstUnmet: 'acceptance', reasons: [reason], hasCandidate: true, released: true, pr: 904 });
  const facts = [
    prove('2026-09-23T08:00:00.000Z', 2, 'AC-1 needs evidence'),
    fact('merged', '2026-09-23T09:00:00.000Z', 3, { pr: 904, mergeSha: 'a'.repeat(40) }),
    prove('2026-09-23T09:05:00.000Z', 4, 'AC-2 needs evidence'),
  ];
  const item = { ...calendarItem, stage: 'acceptance' } as Work;
  const moves = stepMoves(calendarDataset('2026-09-24T22:55:00.000Z', facts), item);
  assert.deepEqual(moves.map(move => `${move.from}>${move.to}@${move.at}`), ['null>prove@2026-09-23T08:00:00.000Z', 'prove>deploy@2026-09-23T09:00:00.000Z'],
    'Prove ends at the merge, and a later legacy gate fact never puts the item back at Prove');
  // The same history before the window opened: the item starts the window at Deploy, entered at the merge.
  const carryIn = [facts[1], facts[2]];
  const entries = stepEntries(carryIn, [facts[0], facts[2]]);
  assert.equal(entries[calendarItem.id], '2026-09-23T09:00:00.000Z');
  const carried = stepMoves({ facts: [], carryIn, stepEntries: entries, from: '2026-09-24T00:00:00.000Z', to: '2026-09-24T22:55:00.000Z' }, item);
  assert.deepEqual(carried.map(move => `${move.to}@${move.at}`), ['deploy@2026-09-23T09:00:00.000Z']);
});

test('a report that read only part of the repository\'s work items shows the work-item bound in place of its daily landings and step-time split', () => {
  const to = '2026-09-24T22:55:00.000Z';
  const report = computeFlow(calendarDataset(to, [calendarFact('delivered', '2026-09-19T10:00:00.000Z', 2)], { workTruncated: true }), { days: 7 });
  assert.equal(report.window.truncated, false, 'the fact scan itself read the whole window');
  assert.equal(report.coverage.workItemsTruncated, true);
  const page = renderToStaticMarkup(createElement(LandedPerDay, { report }));
  assert.match(page, new RegExp(`data-flow="coverage"[^>]*>The repository holds more work items than the report reads, and it read only the oldest ${flowLimits.work.toLocaleString('en-US')} work items`));
  assert.doesNotMatch(page, /class="landed-bar"/, 'no day is drawn as a count');
  assert.equal([...page.matchAll(/data-uncovered="true"/g)].length, 7);
  const dwell = (step: string, n: number) => ({ step, ...distribution(Array.from({ length: n }, () => 3600_000)) });
  const times = renderToStaticMarkup(createElement(WhereTimeGoes, { report: { ...report, stepDwell: [dwell('build', 6), dwell('review', 6)] } }));
  assert.doesNotMatch(times, /class="time-bar"/, 'no time split from a partial population');
  assert.equal([...times.matchAll(/data-sparse="partial"/g)].length, 2);
});

test('unit:sparse-step-marked — a step median from fewer than five samples, or from a partially read window, shows its sample count and a sparse marker and takes no share of the time split', () => {
  const to = '2026-09-24T22:55:00.000Z';
  const report = computeFlow(calendarDataset(to, []), { days: 7 });
  const dwell = (step: string, values: number[]) => ({ step, ...distribution(values) });
  const hours = (n: number, h: number) => Array.from({ length: n }, () => h * 3600_000);
  const sparse = { ...report, stepDwell: [dwell('build', hours(6, 2)), dwell('validate', []), dwell('test', hours(5, 1)), dwell('review', hours(7, 3)), dwell('prove', [9 * 3600_000, 9.6 * 3600_000]), dwell('merge', hours(5, 0.5)), dwell('deploy', [])] };
  const page = renderToStaticMarkup(createElement(WhereTimeGoes, { report: sparse }));
  const bar = /<div class="time-bar">(.*?)<\/div>/.exec(page)?.[1] ?? '';
  assert.ok(bar, 'the split is drawn for the steps with enough samples');
  for (const step of ['build', 'test', 'review', 'merge']) assert.match(bar, new RegExp(`time-share step-${step}"`), `${step} is in the split`);
  assert.doesNotMatch(bar, /step-prove/, 'the 2-sample step takes no share of the split');
  assert.doesNotMatch(page, /Prove \d+%/, 'nor a percentage');
  const marked = /<li data-step="prove">(.*?)<\/li>/.exec(page)?.[1] ?? '';
  assert.match(marked, /data-sparse="sparse"/, 'Prove carries the sparse marker');
  assert.match(marked, /2 samples · sparse/, 'and its sample count');
  assert.match(marked, /Prove 9h/, 'its median is still shown, marked');
  assert.doesNotMatch(page, /data-step="(build|test|review|merge)"[^>]*>[^<]*<small[^>]*data-sparse/, 'steps with enough samples carry no marker');
  // A window whose gate facts were read only in part marks every step, and draws no split at all.
  const covered = coveredWindow(new Date(Date.parse(to) - 7 * day).toISOString(), to, '2026-09-21T00:00:00.000Z', 100_000, flowLimits.scan);
  const partial = { ...sparse, window: { ...sparse.window, truncated: true, covered, kinds: [{ kind: 'gates.changed', toCovered: covered.toCovered }] } };
  const partialPage = renderToStaticMarkup(createElement(WhereTimeGoes, { report: partial }));
  assert.doesNotMatch(partialPage, /class="time-bar"/);
  assert.equal([...partialPage.matchAll(/data-sparse="partial"/g)].length, 5, 'every step with a median is marked');
  assert.match(partialPage, /6 samples · partial window/);
  // Gate facts read to the end, but the merges read only in part: merges past that read never move
  // an item to Deploy, so the step times are partial too.
  const mergesPartial = { ...partial, window: { ...partial.window, kinds: [{ kind: 'gates.changed', toCovered: to }, { kind: 'merged', toCovered: covered.toCovered }] } };
  const mergesPage = renderToStaticMarkup(createElement(WhereTimeGoes, { report: mergesPartial }));
  assert.doesNotMatch(mergesPage, /class="time-bar"/, 'no split while the merges were read in part');
  assert.equal([...mergesPage.matchAll(/data-sparse="partial"/g)].length, 5);
  // Both read to the end: only the sparse marker remains.
  const fullKinds = { ...partial, window: { ...partial.window, kinds: [{ kind: 'gates.changed', toCovered: to }, { kind: 'merged', toCovered: to }] } };
  assert.doesNotMatch(renderToStaticMarkup(createElement(WhereTimeGoes, { report: fullKinds })), /data-sparse="partial"/);
});

function escapeHtml(text: string) { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;'); }

test('a report reads each fact a bounded number of times however many items and steps it covers, so supplemental kinds past the shared scan keep /api/analytics/flow within its budget', () => {
  const to = '2026-09-24T22:55:00.000Z', start = Date.parse(to) - 6 * day;
  const items = Array.from({ length: 200 }, (_, index) => ({ ...calendarItem, id: `31111111-2222-4333-8444-${String(index).padStart(12, '0')}`, key: `GY-${1000 + index}` }) as Work);
  const facts: FlowFact[] = [];
  let id = 10;
  for (const [index, item] of items.entries()) for (let move = 0; move < 100; move++) {
    const stage = move % 2 ? 'review' : 'test';
    facts.push({ ...calendarFact('gates.changed', new Date(start + index * 1000 + move * 60_000).toISOString(), id++), workId: item.id, workKey: item.key, details: { stage, unmet: [stage], firstUnmet: stage, hasCandidate: true, reasons: [] } });
  }
  facts.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  let reads = 0;
  const counted = new Proxy(facts, { get: (target, key, receiver) => { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
  const created = items.map(item => ({ ...calendarFact('work.created', new Date(Date.parse(to) - 10 * day).toISOString(), 1), workId: item.id, workKey: item.key }));
  const dataset = calendarDataset(to, counted, { work: items, included: items, latest: created });
  const report = computeFlow(dataset, { days: 7 });
  assert.ok(report.stepDwell.some(step => step.n > 0), 'the step dwell is still computed from every item\'s moves');
  // Scanning every fact once per step and item would read 7 × 200 × 20,000 facts; the report reads each a few times.
  assert.ok(reads < 40 * facts.length, `read ${reads} facts for ${facts.length} facts`);
  const drilled = flowDrilldown(dataset, report, { metric: 'steps', key: null, authorized: true } as any);
  assert.ok(drilled.rows.length > 0);
  assert.ok(reads < 40 * facts.length, `with the steps drill-down, read ${reads} facts for ${facts.length} facts`);
});

test('unit:flow-window-24h — flow analytics offers a 24-hour window beside 7, 30 and 90 days, the schema message names it, and the existing partial-window and sparse notices cover it', () => {
  const hour = 3_600_000;
  // Observed mid-day, so the 24-hour window spans two UTC calendar days.
  const to = Date.parse('2026-09-20T15:00:00.000Z');
  const from = to - day;
  const at = (ms: number) => new Date(ms).toISOString();

  const item = { id: '11111111-2222-4333-8444-555555555556', key: 'GY-2', title: '24-hour fixture', type: 'feature', stage: 'build', plannedFiles: ['src/'], criteria: [], evidence: [], gates: [], violations: [], observation: null } as unknown as Work;
  const fact = (kind: string, observedAt: number): FlowFact => ({
    id: observedAt, workId: item.id, workKey: item.key, kind: kind as FlowFact['kind'], observedAt: at(observedAt), recordedAt: at(observedAt),
    source: 'graphyard', sourceEvent: observedAt, stage: 'build', workType: 'feature', slices: ['src'], details: {}, dedupe: `${kind}:${observedAt}`,
  });
  function dataset(overrides: Partial<FlowDataset> = {}): FlowDataset {
    const facts = [fact('work.created', from + hour), fact('lease.claimed', from + 2 * hour), fact('stage.changed', from + 3 * hour)];
    return {
      observedAt: at(to), from: at(from), to: at(to), days: 1 as FlowWindow, work: [item], included: [item],
      facts, latest: [], carryIn: [], deployments: [], mergedForDeployments: [],
      scanned: facts.length, truncated: false, workTruncated: false, deploymentsTruncated: false, deploymentMergesTruncated: false,
      projection: { lastEvent: 10, updatedAt: at(to), pendingEvents: 0, pendingCapped: false }, ...overrides,
    };
  }
  const query: FlowQuery = { days: 1 };

  // The window set, its attribution twin, and how each window reads.
  assert.deepEqual([...flowWindows], [1, 7, 30, 90]);
  assert.deepEqual([...attributionWindows], [1, 7, 30, 90]);
  assert.equal(flowWindowLabel(1), '24 hours');
  assert.equal(flowWindowLabel(30), '30 days');
  assert.equal(flowWindowMessage, 'Window must be 24 hours, 7 days, 30 days, 90 days');

  // One daily bucket (today), holding the pre-midnight sliver, and never flagged as truncated.
  const buckets = dayBuckets(from, to, 1);
  assert.deepEqual(buckets.starts, [Date.parse('2026-09-20T00:00:00.000Z')]);
  assert.equal(buckets.truncated, false);
  assert.equal(buckets.bucketOf(from), buckets.starts[0], 'the sliver before midnight counts in the one bucket');
  assert.equal(buckets.bucketOf(from - 1), null);
  assert.equal(buckets.bucketOf(to), null);

  // A 24-hour report is its own window: one bucket, a one-day span, and too few facts reads sparse.
  const report = computeFlow(dataset(), query);
  assert.equal(report.window.days, 1);
  assert.equal(Date.parse(report.window.to) - Date.parse(report.window.from), day);
  assert.equal(report.coverage.sparse, true);
  assert.equal(report.coverage.complete, true);
  assert.equal(report.window.truncated, false);

  // A scan bound hit inside the 24 hours is disclosed in hours, and the report is not complete.
  const covered = coveredWindow(at(from), at(to), at(from + 6 * hour), 40, flowLimits.scan);
  assert.equal(covered.windowMs, day);
  assert.equal(covered.fraction, 0.25);
  assert.match(covered.statement, /\(6 h of the requested 24 h, 25%\)/);
  const partial = computeFlow(dataset({ truncated: true, covered }), query);
  assert.equal(partial.coverage.truncated, true);
  assert.equal(partial.coverage.complete, false);
  assert.deepEqual(partial.window.covered, covered);

  // The export states the 24-hour window it describes.
  const csv = flowExport(partial, flowDrilldown(dataset({ truncated: true, covered }), partial, { metric: 'bottleneck', key: null, authorized: false }), 'csv');
  assert.match(csv, /\n# windowDays,1\n/);
  assert.match(csv, /# windowTruncated,true/);
});

test('manual:review-followups-triaged GY-1154.2 — narrowed drill-down totals and coverage compared with report figures under truncation', async () => {
  const slice = 'gy1154-narrowed-drilldowns';
  const gated = await released(slice), direct = await released(slice), blockedItem = await released(slice);
  const asOf = Math.floor(Date.now() / day) * day - 3600_000, from = asOf - 7 * day;
  for (const item of [gated, direct, blockedItem]) await seedFact(item, 'work.created', from - day, { type: 'feature' });

  // Exhaust the shared 20,000-row scan with check-run facts early in the window.
  await store.pool.query(`INSERT INTO flow_facts(work_id,work_key,kind,observed_at,recorded_at,source,source_event,stage,work_type,slices,details,dedupe)
    SELECT $1,$2,'check.observed',$3::timestamptz + g * interval '10 milliseconds',$3::timestamptz,'ci',0,'test','feature',$4,'{"name":"test","result":"success"}'::jsonb,concat('gy1154-check:',g)
    FROM generate_series(1,25000) g`, [gated.id, gated.key, new Date(from + day).toISOString(), workSlices(gated).slices]);

  // Facts occurring past the shared scan cutoff:
  const gate = (stage: string, unmet: string[], extra: object = {}) => ({ stage, unmet, hasCandidate: true, released: true, pr: 950, ...extra });
  await seedFact(gated, 'gates.changed', asOf - 3 * 3600_000, gate('review', ['review', 'acceptance', 'merge']), 'review');
  await seedFact(gated, 'gates.changed', asOf - 2 * 3600_000, gate('merge', ['merge'], { queued: true, mergeBlockers: 0 }), 'merge');
  await seedFact(gated, 'merged', asOf - 40 * 60_000, { pr: 950, mergeSha: 'f'.repeat(40) }, 'done');
  await seedFact(gated, 'delivered', asOf - 40 * 60_000, { pr: 950, mergeSha: 'f'.repeat(40) }, 'done');
  await seedFact(direct, 'merged', asOf - 20 * 60_000, { pr: 951, mergeSha: '7'.repeat(40), direct: true }, 'done');
  await seedFact(direct, 'delivered', asOf - 20 * 60_000, { pr: 951, mergeSha: '7'.repeat(40), direct: true }, 'done');

  // Facts of kinds NOT in separateKinds (stage.changed, review.submitted, evidence.recorded, blocker.set):
  await seedFact(gated, 'stage.changed', asOf - 4 * 3600_000, { from: 'build', to: 'review', dwellMs: 3600_000 }, 'review');
  await seedFact(gated, 'review.submitted', asOf - 3 * 3600_000, { reviewState: 'APPROVED', independent: true, timestampSource: 'github', sha: 'f'.repeat(40) }, 'review');
  await seedFact(gated, 'evidence.recorded', asOf - 2 * 3600_000, { proof: 'unit:test', result: 'passed', trusted: true, executed: 1, skipped: 0, evidenceId: 'ev-1154', sha: 'f'.repeat(40) }, 'review');
  await seedFact(blockedItem, 'blocker.set', asOf - 3600_000, { reason: 'human-decision', context: 'needs approval' }, 'build');

  const query: FlowQuery = { days: 7, slice, asOf: new Date(asOf).toISOString() };
  const { dataset, report } = await pooledFlowReport(store, query);

  assert.equal(dataset.truncated, true, 'shared scan is truncated by early check runs');
  assert.ok(dataset.scanEnd, 'scanEnd is recorded');

  // 1. Throughput & Lead-time: both count delivered facts (in separateKinds), so they agree with report.
  const throughputDrill = await pooledFlowDrilldown(store, query, { metric: 'throughput' });
  const reportDeliveries = report.throughput.reduce((sum, bucket) => sum + bucket.delivered, 0);
  assert.equal(throughputDrill.rows.length, 2, 'both deliveries past cutoff are returned');
  assert.equal(throughputDrill.rows.length, reportDeliveries, 'drill-down throughput matches report throughput total');
  assert.equal(throughputDrill.coverage.truncated, false, 'delivered facts covered the whole window');

  const leadTimeDrill = await pooledFlowDrilldown(store, query, { metric: 'lead-time' });
  assert.equal(leadTimeDrill.rows.length, 2, 'both delivered items have measurable lead times');

  // 2. Merge-ready: reads gates.changed (in separateKinds), here within its own bound on both reads (GY-1164.1).
  const mergeReadyDrill = await pooledFlowDrilldown(store, query, { metric: 'merge-ready' });
  assert.ok(mergeReadyDrill.rows.length > 0, 'merge-ready interval returned');

  // 3. Stage-dwell: stage.changed is NOT in separateKinds, so report's shared scan stopped before the stage move.
  // The drill-down narrows to stage.changed, scanning only that kind without being crowded out by check runs.
  const stageDwellDrill = await pooledFlowDrilldown(store, query, { metric: 'stage-dwell' });
  const reportStageDwellCount = report.stageDwell.find(entry => entry.stage === 'build')?.n ?? 0;
  assert.equal(reportStageDwellCount, 0, 'report stage dwell did not reach the move past the shared scan cutoff');
  assert.equal(stageDwellDrill.rows.length, 1, 'narrowed stage-dwell drill-down reached the move');
  assert.equal(stageDwellDrill.rows[0].workKey, gated.key);
  assert.equal(stageDwellDrill.coverage.truncated, false, 'single-kind scan covered to the end of the window');

  // 4. Evidence: evidence.recorded is NOT in separateKinds, so report evidence did not include the fact past cutoff.
  const evidenceDrill = await pooledFlowDrilldown(store, query, { metric: 'evidence', authorized: true });
  assert.equal(evidenceDrill.rows.length, 1, 'narrowed evidence drill-down reached the evidence past cutoff');
  assert.equal(evidenceDrill.rows[0].workKey, gated.key);
  assert.equal(evidenceDrill.coverage.truncated, false);

  // 5. Review: review.submitted is NOT in separateKinds.
  const reviewDrill = await pooledFlowDrilldown(store, query, { metric: 'review' });
  assert.equal(reviewDrill.rows.length, 1, 'narrowed review drill-down reached the review past cutoff');
  assert.equal(reviewDrill.rows[0].workKey, gated.key);
  assert.equal(reviewDrill.coverage.truncated, false);

  // 6. Blockers: blocker.set is NOT in separateKinds.
  const blockersDrill = await pooledFlowDrilldown(store, query, { metric: 'blockers' });
  assert.equal(blockersDrill.rows.length, 1, 'narrowed blockers drill-down reached the blocker past cutoff');
  assert.equal(blockersDrill.rows[0].workKey, blockedItem.key);
  assert.equal(blockersDrill.coverage.truncated, false);
});

test('manual:review-followups-triaged GY-1164.1 — a separate-kind drill-down and the report reach different instants once that kind exhausts its own bound', async () => {
  const slice = 'gy1164-merge-ready-reach';
  const item = await released(slice);
  const asOf = Math.floor(Date.now() / day) * day - 3600_000, from = asOf - 7 * day;
  const gate = { stage: 'merge', unmet: ['merge'], hasCandidate: true, released: true, pr: 1164 };
  // Gate facts G1..G8, one hour apart, with one check run between G2 and G3: on a 3-row bound the
  // report's shared scan stops at the check run with two gate facts already spent inside it.
  const at = (index: number) => from + day + index * 3600_000;
  for (let index = 1; index <= 8; index++) {
    await seedFact(item, 'gates.changed', at(index), gate, 'merge');
    if (index === 2) await seedFact(item, 'check.observed', at(2) + 60_000, { name: 'test', result: 'success' }, 'merge');
  }
  const query: FlowQuery = { days: 7, slice, asOf: new Date(asOf).toISOString(), limit: 3 };
  const { dataset } = await pooledFlowReport(store, query);
  // Report: G1, G2 and the check run, then G3..G5 on the gate bound past the cutoff.
  assert.equal(coveredUntil(dataset, 'gates.changed'), new Date(at(5)).toISOString());
  // Merge-ready drill-down: G1..G3 on its kind-only scan, then G4..G6 past it.
  const drill = await pooledFlowDrilldown(store, query, { metric: 'merge-ready' });
  assert.equal(drill.coverage.truncated, true);
  assert.equal(drill.coverage.toCovered, new Date(at(6)).toISOString(), 'the drill-down reaches a gate fact the report never read');
  assert.notEqual(drill.coverage.toCovered, coveredUntil(dataset, 'gates.changed'), 'so its reach is its own, not the report\'s');
});

test('manual:review-followups-triaged GY-1154: each follow-up listed in the description is addressed in code, or declined with a recorded reason (AC-1)', () => {
  type TriageStatus = 'addressed' | 'declined';
  interface TriageEntry {
    id: number;
    path: string;
    description: string;
    status: TriageStatus;
    reasonOrResolution: string;
  }

  const triage: TriageEntry[] = [
    {
      id: 1,
      path: 'tests/flow-analytics.test.ts:306',
      description: "the Flow page's truncation notice is checked with a regex on the source text of web/pages/insights-flow.tsx, not by rendering InsightsPage with a truncated replay",
      status: 'addressed',
      reasonOrResolution: 'unit:steps-drilldown-reads-recent-moves renders the Flow page\'s replay read (ReplayRead, as InsightsPage renders it since GY-1164) with both truncated and full replays via renderToStaticMarkup, asserting data-flow="replay-truncated" and the coverage-dependent empty-state text.',
    },
    {
      id: 2,
      path: 'src/flow-analytics.ts:49',
      description: 'drilldownKinds narrows every drill-down except phase to its own kinds, changing rows/reach when shared scan is truncated; no test compares narrowed drill-down totals with report figures',
      status: 'addressed',
      reasonOrResolution: 'Documented drilldownKinds and pooledFlowDrilldown narrowing and reach behavior under truncation; added manual:review-followups-triaged GY-1154.2 comparing narrowed drill-down totals (throughput, lead-time, merge-ready, stage-dwell, evidence, review, blockers) and their coverage against report figures under a truncated shared scan.',
    },
  ];

  assert.equal(triage.length, 2);
  for (const entry of triage) {
    assert.ok(['addressed', 'declined'].includes(entry.status));
    assert.ok(entry.reasonOrResolution.length > 0);
  }
});

test('manual:review-followups-triaged GY-1164: each follow-up from the approved review of GY-1154 is addressed in code, or declined with a recorded reason (AC-1)', async () => {
  const triage: { id: number; path: string; description: string; status: 'addressed' | 'declined'; reasonOrResolution: string }[] = [
    {
      id: 1,
      path: 'src/flow-analytics.ts',
      description: 'do not claim merge-ready drill-downs stay aligned after truncation: not true when gates.changed itself contributes rows before the shared scan',
      status: 'addressed',
      reasonOrResolution: 'The drilldownKinds and pooledFlowDrilldown comments no longer claim separateKinds drill-downs (throughput, lead-time, merge-ready) count the report\'s facts: they agree only while that kind\'s own bound is not exhausted, and each states its own reach in coverage. manual:review-followups-triaged GY-1164.1 shows a merge-ready drill-down reaching a gate fact the report never read.',
    },
    {
      id: 2,
      path: 'tests/flow-analytics.test.ts:844',
      description: 'renderFlow patches private React client internals to seed hook state, brittle across React updates',
      status: 'addressed',
      reasonOrResolution: 'InsightsPage renders its replay read through the exported ReplayRead component; unit:steps-drilldown-reads-recent-moves renders ReplayRead with the truncated and full replays through public props, and no test touches React internals.',
    },
  ];
  assert.equal(triage.length, 2);
  for (const entry of triage) assert.ok(['addressed', 'declined'].includes(entry.status) && entry.reasonOrResolution.length > 0);
  // The record is checked against the code it describes, so it cannot go stale silently.
  const [analytics, tests] = await Promise.all([readFile(new URL('../src/flow-analytics.ts', import.meta.url), 'utf8'), readFile(new URL(import.meta.url), 'utf8')]);
  assert.doesNotMatch(analytics, /align with report\s+(?:\*\s+)?figures|count the same delivered\/merged\/gate facts as the report/, 'finding 1: the alignment claim is gone');
  assert.ok(!tests.includes('__CLIENT_' + 'INTERNALS'), 'finding 2: no test reaches into React internals');
});

// GY-1232: three items merged into main within the last day, two of them promoted to production.
const hour = 3_600_000, deliveryNow = Date.parse('2026-10-05T12:00:00.000Z');
const at = (ms: number) => new Date(deliveryNow - ms).toISOString();
function mergedItem(key: string, createdAgo: number, mergedAgo: number, extra: Partial<Work> = {}, deployment?: number): Work {
  return { id: `id-${key}`, key, stage: 'done', createdAt: at(createdAgo), closure: undefined,
    delivery: { mergedAt: at(mergedAgo), mergeSha: key.padEnd(40, '0'), authorizationRevision: 1,
      ...(deployment === undefined ? {} : { deployment: { sha: 'f'.repeat(40), mergeSha: key.padEnd(40, '0'), source: 'github-deployment', observedAt: at(deployment), covers: 'exact', at: at(deployment), observer: 'graphyard' } }) },
    ...extra } as unknown as Work;
}
const deliveryItems = () => [
  // Created ready; promoted by a verified production release one hour ago.
  mergedItem('GY-A', 5 * hour, 3 * hour, { releaseDeliveries: [{ environment: 'production', policyRevision: 1, releaseId: 'r1', releaseRevision: 1, generation: 1, verifiedAt: at(1 * hour), interval: { from: at(4 * hour), to: at(1 * hour) } }] }),
  // Created ten days ago, made ready two hours ago; the deployment observation promoted it.
  mergedItem('GY-B', 10 * day, 1.5 * hour, {}, 0.5 * hour),
  // Merged ten hours ago, not yet promoted: pending.
  mergedItem('GY-C', 20 * hour, 10 * hour),
];

test('unit:delivery-speed-measured — master status reports ready→merged and merged→production count, p50 and p90 over 24 hours and 7 days, with the unpromoted item pending', () => {
  const speed = deliverySpeed(deliveryItems(), { now: deliveryNow, readyAt: new Map([['id-GY-B', at(2 * hour)]]) });
  for (const window of ['24h', '7d'] as const) {
    // Ready→merged: 2h (A), 0.5h (B), 10h (C).
    assert.deepEqual({ count: speed.readyToMerged[window].count, p50Ms: speed.readyToMerged[window].p50Ms, p90Ms: speed.readyToMerged[window].p90Ms }, { count: 3, p50Ms: 2 * hour, p90Ms: 8.4 * hour });
    // Merged→production: 2h (A), 1h (B); C pending.
    assert.deepEqual({ count: speed.mergedToProduction[window].count, pending: speed.mergedToProduction[window].pending, p50Ms: speed.mergedToProduction[window].p50Ms, p90Ms: speed.mergedToProduction[window].p90Ms },
      { count: 2, pending: 1, p50Ms: 1.5 * hour, p90Ms: 1.9 * hour });
  }
  // A merge older than a day leaves the 24-hour window and stays in the 7-day one.
  const older = deliverySpeed([...deliveryItems(), mergedItem('GY-D', 4 * day, 3 * day, {}, 2 * day)], { now: deliveryNow, readyAt: new Map([['id-GY-B', at(2 * hour)]]) });
  assert.equal(older.readyToMerged['24h'].count, 3);
  assert.equal(older.readyToMerged['7d'].count, 4);
  assert.equal(older.mergedToProduction['7d'].count, 3);
  // Unmerged and closed items are not measured.
  const open = { ...mergedItem('GY-E', hour, hour), stage: 'merge', delivery: undefined } as unknown as Work;
  assert.equal(deliverySpeed([open], { now: deliveryNow }).readyToMerged['7d'].count, 0);
  assert.equal(deliverySpeed([open], { now: deliveryNow }).readyToMerged['7d'].p90Ms, null);
});

test('unit:delivery-speed-attention — targets default to 2h and 8h, are configurable in master.json, and a breach is one attention line naming the slowest items', () => {
  assert.deepEqual(defaultDeliverySpeedTargets, { readyToMergedP90Ms: 2 * hour, mergedToProductionP90Ms: 8 * hour });
  const readyAt = new Map([['id-GY-B', at(2 * hour)]]);
  // Defaults: ready→merged p90 8.4h breaches 2h; merged→production p90 1.9h is within 8h.
  // The three-item fixture is judged with a minimum sample of one; the default minimum is GY-1275's.
  assert.deepEqual(deliverySpeedBreaches(deliverySpeed(deliveryItems(), { now: deliveryNow, readyAt }), 1).map(breach => breach.text),
    ['Ready→merged into main p90 is 8.4h over 7 days (3 items), above the 2h target; slowest: GY-C 10h, GY-A 2h, GY-B 0.5h']);
  // master.json's deliverySpeed overrides a target; the pending item counts among the slowest.
  const configured = masterConfigSchema.shape.deliverySpeed.parse({ readyToMergedP90Ms: 10 * hour, mergedToProductionP90Ms: hour });
  assert.deepEqual(deliverySpeedBreaches(deliverySpeed(deliveryItems(), { now: deliveryNow, readyAt, targets: configured }), 1).map(breach => breach.text),
    ['Merged→promoted to production p90 is 1.9h over 7 days (2 items), above the 1h target; slowest: GY-C 10h (pending), GY-A 2h, GY-B 1h']);
  assert.throws(() => masterConfigSchema.shape.deliverySpeed.parse({ readyToMergedP90Ms: 0 }));
  assert.throws(() => masterConfigSchema.shape.deliverySpeed.parse({ unknown: 1 }));
});

// GY-1275: follow-ups from the approved review of GY-1232 (PR #728), proof manual:review-followups-triaged.
const readyItems = (count: number) => Array.from({ length: count }, (_, index) => mergedItem(`GY-R${index}`, 5 * hour, 2 * hour));
test('manual:review-followups-triaged GY-1275.1 — an incomplete ready-event read leaves items with no ready event unmeasured, states the gap, and raises no ready→merged breach', () => {
  // Ten backlog items created ten days ago, merged an hour ago; only one ready event was read.
  const items = Array.from({ length: 10 }, (_, index) => mergedItem(`GY-K${index}`, 10 * day, hour));
  const readyAt = new Map([['id-GY-K0', at(2 * hour)]]);
  const partial = deliverySpeed(items, { now: deliveryNow, readyAt, readyComplete: false });
  assert.equal(partial.readyEventsComplete, false);
  assert.deepEqual({ count: partial.readyToMerged['7d'].count, unmeasured: partial.readyToMerged['7d'].unmeasured, p90Ms: partial.readyToMerged['7d'].p90Ms }, { count: 1, unmeasured: 9, p90Ms: hour });
  assert.ok(partial.statements.some(line => /ready-event read was incomplete: 9 items .* unmeasured/.test(line)));
  // Even a measured p90 over target is not judged on a partial read.
  const slow = deliverySpeed(items, { now: deliveryNow, readyAt: new Map(items.map(work => [work.id, at(9 * day)])), readyComplete: false });
  assert.ok(slow.readyToMerged['7d'].p90Ms! > slow.targets.readyToMergedP90Ms);
  assert.deepEqual(deliverySpeedBreaches(slow), []);
  // A complete read measures the same items from creation (created ready) and judges them.
  const complete = deliverySpeed(items, { now: deliveryNow, readyAt, readyComplete: true });
  assert.equal(complete.readyToMerged['7d'].count, 10);
  assert.equal(complete.readyToMerged['7d'].unmeasured, undefined);
  assert.equal(deliverySpeedBreaches(complete).length, 1);
});

test('manual:review-followups-triaged GY-1275.2 — a breach needs at least ten measured items, and a small sample carries the sparse marker', () => {
  assert.equal(deliverySpeedMinimumSample, 10);
  const one = deliverySpeed(readyItems(1), { now: deliveryNow });
  assert.equal(one.readyToMerged['7d'].p90Ms, 3 * hour);
  assert.equal(one.readyToMerged['7d'].sparse, true);
  assert.deepEqual(deliverySpeedBreaches(one), [], 'one slow item in a quiet week does not alarm');
  assert.deepEqual(deliverySpeedBreaches(deliverySpeed(readyItems(9), { now: deliveryNow })), []);
  const ten = deliverySpeed(readyItems(10), { now: deliveryNow });
  assert.equal(ten.readyToMerged['7d'].sparse, false);
  assert.deepEqual(deliverySpeedBreaches(ten).map(breach => breach.measure), ['readyToMerged']);
});

test('manual:review-followups-triaged GY-1275.3 — a reverted delivery is named as reverted among the slowest, and the report names the live delivery mode', () => {
  const reverted = { ...mergedItem('GY-V', 30 * hour, 4 * hour), stage: 'build', delivery: undefined,
    observation: { merged: true, mergedAt: at(4 * hour), mergeSha: 'v'.repeat(40), revertedDelivery: { base: 'main', files: [], removedBy: null } } } as unknown as Work;
  const speed = deliverySpeed([...readyItems(9), reverted], { now: deliveryNow });
  assert.deepEqual(speed.readyToMerged['7d'].slowest[0], { key: 'GY-V', ms: 26 * hour, reverted: true });
  // Reverted work is never promoted, so it is not pending a promotion.
  assert.equal(speed.mergedToProduction['7d'].pending, 9);
  assert.match(deliverySpeedBreaches(speed)[0].text, /slowest: GY-V 26h \(reverted\)/);
  // The live mode is read from the most recently evaluated item's github-delivery marker gate.
  const github = { ...mergedItem('GY-G', hour, hour), updatedAt: at(0), gates: [{ name: 'github-delivery', passed: true, reasons: [] }] } as unknown as Work;
  assert.equal(deliverySpeed([...readyItems(2), github], { now: deliveryNow }).deliveryMode, 'github');
  assert.match(deliverySpeed([...readyItems(2), github], { now: deliveryNow }).statements[0], /^Delivery mode: GitHub merges each pull request into main/);
  assert.equal(speed.deliveryMode, 'graphyard');
  assert.match(speed.statements[0], /^Delivery mode: Graphyard's merge queue/);
  // A newer closed item, or one not evaluated since, does not stand for the live mode.
  const closedLater = { ...mergedItem('GY-X', hour, hour), updatedAt: at(-hour), closure: { reason: 'superseded' }, gates: [{ name: 'ready', passed: true, reasons: [] }] } as unknown as Work;
  const unevaluatedLater = { ...mergedItem('GY-Y', hour, hour), updatedAt: at(-hour), gates: [] } as unknown as Work;
  assert.equal(deliveryPathMode([github, closedLater, unevaluatedLater]), 'github');
});

/**
 * The least of a DOM that react-dom/client needs to mount a page in Node: elements, text nodes and
 * the globals its commit and the page's effects read (GY-1228). It renders through React's public
 * createRoot and act, so the page's own state and effects run, and nothing reaches React internals.
 */
class FakeNode {
  childNodes: FakeNode[] = []; parentNode: FakeNode | null = null;
  constructor(readonly nodeType: number, readonly nodeName: string, readonly ownerDocument: any) {}
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): FakeNode | null { return this.childNodes.at(-1) ?? null; }
  get nextSibling(): FakeNode | null { const siblings = this.parentNode?.childNodes; return siblings ? siblings[siblings.indexOf(this) + 1] ?? null : null; }
  appendChild(child: FakeNode) { child.parentNode?.removeChild(child); this.childNodes.push(child); child.parentNode = this; return child; }
  insertBefore(child: FakeNode, before: FakeNode | null) {
    if (!before) return this.appendChild(child);
    child.parentNode?.removeChild(child); this.childNodes.splice(this.childNodes.indexOf(before), 0, child); child.parentNode = this; return child;
  }
  removeChild(child: FakeNode) { this.childNodes.splice(this.childNodes.indexOf(child), 1); child.parentNode = null; return child; }
  addEventListener() {}
  removeEventListener() {}
}
class FakeText extends FakeNode { constructor(public nodeValue: string, document: any) { super(3, '#text', document); } }
class FakeElement extends FakeNode {
  attributes = new Map<string, string>(); style: Record<string, string> = {}; clientWidth = 1200;
  constructor(readonly tagName: string, document: any, readonly namespaceURI: string | null = null) { super(1, tagName.toUpperCase(), document); }
  setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  set textContent(text: string) { this.childNodes = []; if (text) this.appendChild(new FakeText(text, this.ownerDocument)); }
  get textContent(): string { return this.childNodes.map(child => child instanceof FakeText ? child.nodeValue : (child as FakeElement).textContent).join(''); }
  get outerHTML(): string {
    const attributes = [...this.attributes].map(([name, value]) => ` ${name}="${value}"`).join('');
    return `<${this.tagName}${attributes}>${this.childNodes.map(child => child instanceof FakeText ? child.nodeValue : (child as FakeElement).outerHTML).join('')}</${this.tagName}>`;
  }
}
/** InsightsPage mounted with `api`, once its reads have settled: the page's markup as it then stands. */
async function mountedInsights(api: Dashboard['api'], observedAt: number) {
  const document: any = new FakeNode(9, '#document', null);
  Object.assign(document, {
    createElement: (tag: string) => new FakeElement(tag, document), createElementNS: (namespace: string, tag: string) => new FakeElement(tag, document, namespace),
    createTextNode: (text: string) => new FakeText(text, document), documentElement: new FakeElement('html', document),
  });
  document.body = document.documentElement.appendChild(new FakeElement('body', document));
  const scope = globalThis as any;
  const saved = Object.fromEntries(['IS_REACT_ACT_ENVIRONMENT', 'window', 'document', 'ResizeObserver', 'fetch'].map(name => [name, Object.getOwnPropertyDescriptor(scope, name)]));
  Object.assign(scope, {
    IS_REACT_ACT_ENVIRONMENT: true, document, ResizeObserver: class { observe() {} disconnect() {} },
    window: { event: undefined, HTMLIFrameElement: class {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
    // The shipping pulse reads on its own; here it reads as unavailable without touching the network.
    fetch: async () => { throw new Error('no network in this render'); },
  });
  try {
    const container = new FakeElement('div', document);
    const root = createRoot(container as any);
    await act(async () => root.render(createElement(InsightsFlow, { work: [], status: null, api, token: '', observedAt, setSelected: () => {} } as unknown as Dashboard)));
    const markup = container.outerHTML;
    await act(async () => root.unmount());
    return markup;
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) if (descriptor) Object.defineProperty(scope, name, descriptor); else delete scope[name];
  }
}

test('unit:flow-page-wires-replay-read — InsightsPage passes its resolved replay read (frames, truncated, coverage, replayError) to ReplayRead', async () => {
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  const statement = 'The steps read stopped at 2026-10-01T09:00:00.000Z on its 1-row bound.';
  const move = { workKey: 'GY-1228', observedAt: new Date(now - 3600_000).toISOString(), detail: 'review to merge' };
  const answering = (steps: () => Promise<any>): Dashboard['api'] => async (path: string) => path.startsWith('analytics/flow/drilldown') ? steps() : null;

  // A read that stopped short: the page shows the frames it read, the truncation notice with the
  // read's own statement, and the replay's partial-read note — none of which the unread page shows.
  const partial = await mountedInsights(answering(async () => ({ rows: [move], truncated: false, next: null, coverage: { truncated: true, statement } })), now);
  assert.ok(partial.includes(`<p class="notice" role="status" data-flow="replay-truncated">The recorded step changes were read only in part: ${statement}</p>`), 'coverage reaches ReplayRead');
  assert.match(partial, /data-flow="replay" data-frames="1"/, 'frames reach ReplayRead');
  assert.ok(partial.includes('<small>Only the first rows of the recorded history were returned.</small>'), 'truncated reaches ReplayRead');
  assert.doesNotMatch(partial, /Reading the recorded step changes…|data-flow="replay-error"/);

  // A read that stopped short with no move in what it read names the part it read.
  const emptyPartial = await mountedInsights(answering(async () => ({ rows: [], truncated: false, next: null, coverage: { truncated: true, statement } })), now);
  assert.ok(emptyPartial.includes('<p class="muted flow-wait">No item changed step in the part of the last 24 hours that was read.</p>'));

  // A full read: no notice and no partial-read note, and an empty one says no item changed step.
  const full = await mountedInsights(answering(async () => ({ rows: [move], truncated: false, next: null, coverage: { truncated: false, statement: null } })), now);
  assert.match(full, /data-flow="replay" data-frames="1"/);
  assert.doesNotMatch(full, /data-flow="replay-truncated"|Only the first rows of the recorded history/);
  const quiet = await mountedInsights(answering(async () => ({ rows: [], truncated: false, next: null, coverage: { truncated: false, statement: null } })), now);
  assert.ok(quiet.includes('<p class="muted flow-wait">No item changed step in the last 24 hours.</p>'));

  // A failed read: the page names the error, and ReplayRead says there is no history to replay.
  const failed = await mountedInsights(answering(async () => { throw new Error('The ledger is under load'); }), now);
  assert.ok(failed.includes('The recorded history could not be read: The ledger is under load.'), 'the page names the failed read');
  assert.ok(failed.includes('<p class="muted flow-wait">No recorded history to replay.</p>'), 'replayError reaches ReplayRead');
});

test('manual:review-followups-triaged GY-1228: each follow-up from the approved review of GY-1164 is addressed in code, or declined with a recorded reason (AC-1)', async () => {
  const triage: { ids: number[]; path: string; description: string; status: 'addressed' | 'declined'; reasonOrResolution: string }[] = [
    {
      ids: [1, 2, 6],
      path: 'src/flow-analytics.ts:664',
      description: 'the rewritten pooledFlowDrilldown docstring line runs past the file\'s usual comment wrap width',
      status: 'addressed',
      reasonOrResolution: 'GY-1164\'s final commit reflowed the docstring before it merged; every line of it is now within the file\'s widest wrapped comment line (104 characters), checked below.',
    },
    {
      ids: [4],
      path: 'tests/flow-analytics.test.ts:1454',
      description: 'the GY-1164 triage test asserted only its own hand-written list, not the code it describes',
      status: 'addressed',
      reasonOrResolution: 'The GY-1164 triage test reads src/flow-analytics.ts and this file back, asserting the alignment claim is gone and no test reaches into React internals; checked below that the read-back is still there.',
    },
    {
      ids: [3, 5, 7, 8],
      path: 'tests/flow-analytics.test.ts:843',
      description: 'nothing renders InsightsPage after its replay read resolves, so a miswired frames/truncated/coverage/replayError prop to ReplayRead would go unnoticed',
      status: 'addressed',
      reasonOrResolution: 'unit:flow-page-wires-replay-read mounts InsightsPage with react-dom/client and act on a minimal DOM, so the page\'s own effect runs readReplay; it asserts the partial, empty-partial, full, empty and failed reads each reach ReplayRead as frames, truncated, coverage and replayError.',
    },
  ];
  assert.deepEqual(triage.flatMap(entry => entry.ids).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8], 'every finding is triaged once');
  for (const entry of triage) assert.ok(['addressed', 'declined'].includes(entry.status) && entry.reasonOrResolution.length > 0);
  const [analytics, tests] = await Promise.all([readFile(new URL('../src/flow-analytics.ts', import.meta.url), 'utf8'), readFile(new URL(import.meta.url), 'utf8')]);
  const docstring = /\/\*\*\n((?: \*.*\n)+?) \*\/\nexport async function pooledFlowDrilldown/.exec(analytics)?.[1];
  assert.ok(docstring, 'findings 1, 2, 6: the pooledFlowDrilldown docstring is found');
  assert.ok(docstring.split('\n').every(line => line.length <= 104), 'findings 1, 2, 6: the docstring wraps within the file\'s comment width');
  assert.ok(tests.includes("'finding 2: no test reaches into React internals'"), 'finding 4: the GY-1164 record reads back the code it describes');
  assert.ok(tests.includes("test('unit:flow-page-wires-replay-read") && tests.includes('await act(async () => root.render(createElement(InsightsFlow'), 'findings 3, 5, 7, 8: the page itself is mounted and its effects run');
});
