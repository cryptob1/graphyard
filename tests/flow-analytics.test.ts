import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Observation, Principal, Work } from '../src/model.js';
import {
  classifyWait, computeFlow, deriveFacts, distribution, flowDrilldown, flowExport, flowLimits,
  projectFlow, readFlow, workSlices, type FlowQuery, type FlowWindow, type ProjectionState,
} from '../src/flow-analytics.js';

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
  const port = Number(process.env.GRAPHYARD_FLOW_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-flow-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
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
    files: [`${slice}/changed.ts`], at: new Date().toISOString(), ...overrides,
  };
}
function approval(sha = head, id = 9001, submittedAt = new Date(Date.now() - 3600_000).toISOString()) {
  return [{ reviewer: 'independent-reviewer', sha, state: 'APPROVED', id, submittedAt }];
}
function proof(sha = head) { return { proof: 'integration:flow', sha, baseSha: base, policyRevision: 1, result: 'pass' as const, executed: 9, skipped: 0 }; }

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
});

// A provider merge timestamp is rounded up to a whole second, so it can briefly sit in the
// future; the window read is half-open on the observation instant and must catch up first.
async function settle(instant: string) {
  const wait = Date.parse(instant) + 5 - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}
async function deliver(work: Work, slice: string, mergeSha: string, overrides: Partial<Observation> = {}) {
  const current = () => (store.list()).then(items => items.find(item => item.id === work.id)!);
  let latest = await current();
  const granted = await engine.acquireMerge(coordinator, work.id, { expectedRevision: latest.revision, sha: head, baseSha: base, policyRevision: latest.policyRevision }, randomUUID());
  const verified = await engine.verifyMerge(coordinator, work.id, { executionId: granted.execution.id }, { ...observation(latest, slice, overrides), prState: 'open', draft: false }, randomUUID());
  const mergedAt = new Date(Math.ceil((Date.parse(verified.verifiedAt) + 1) / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  latest = await current();
  const delivered = await engine.observe(latest.id, latest.revision, { ...observation(latest, slice, overrides), merged: true, mergeSha, mergedAt });
  assert.equal(delivered.stage, 'done');
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
});

test('integration:flow-analytics-operations', async () => {
  const slice = 'gy35-ops';
  const now = Date.now();
  const blocked = await submitted(slice);
  await engine.execute(worker, 'blocked', blocked.id, { epoch: blocked.epoch, reason: 'Waiting on an external provider decision' }, randomUUID());
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

  const { report } = await analyse({ slice });
  const operations = report.operations;
  assert.ok(operations.blockers.some(entry => entry.reason === 'Waiting on an external provider decision' && entry.count === 1));
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
  assert.deepEqual(operations.queues.map(queue => queue.queue), ['reviewer', 'proof', 'operator', 'worker']);
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
  assert.equal(bounded.dataset.facts.length, 5);
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
  const bulk = Array.from({ length: flowLimits.work + 1 }, (_, index) => `('${randomUUID()}', '{"key":"GY-BULK-${index}","type":"chore","title":"Bulk fixture ${index}"}'::jsonb)`);
  await store.pool.query(`INSERT INTO work_items(id,document) VALUES ${bulk.join(',')}`);
  const overflow = await readFlow(store, { days: 30, slice });
  assert.equal(overflow.work.length, flowLimits.work);
  assert.equal(overflow.workTruncated, true);
  const overflowReport = computeFlow(overflow, { days: 30, slice });
  assert.equal(overflowReport.coverage.workItemScanLimit, flowLimits.work);
  assert.equal(overflowReport.coverage.workItemsTruncated, true);
  assert.equal(overflowReport.coverage.complete, false, 'a work-item bound is partial coverage');

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
