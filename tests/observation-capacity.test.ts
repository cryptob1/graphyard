import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { evaluate, type Work } from '../src/model.js';
import { nextAction } from '../src/model/next-action.js';
import { assumedObservationRequests, defaultHourlyLimit, mergePathReserve, observationCadence, steadyStateInterval } from '../src/github.js';
import { observationThroughputStatus } from '../src/cli/master-status.js';
import { observationClaim, observationClaimBatch, observationFreshnessBounds, reviewCadenceCapMs, reviewObservationFreshnessMs } from '../src/observation-priority.js';
import { simulateObservationScheduler } from '../src/observation-simulation.js';
import { defaultDatabasePoolSize, defaultObservationConcurrency, observationCapacity, observationConcurrency } from '../src/server/main.js';

// GY-1114: unit:observation-priority-keeps-merge-and-review-fresh.

const CI = 15368;
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const now = Date.parse('2026-10-02T12:00:00Z');

const item = (key: string, pr: number, head: string, baseSha: string, overrides: Partial<Work> = {}): Work => ({
  id: randomUUID(), key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [] }],
  policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/'], stage: 'merge', revision: 3, policyRevision: 1, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  stageEnteredAt: new Date(now).toISOString(), ready: true, epoch: 1, lease: null, workspaces: [{ host: 'machine', path: `/w/${key}`, branch: `graphyard/${key.toLowerCase()}-1`, epoch: 1, owner: 'implementer' }],
  candidate: { sha: head, baseSha, pr, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' }, submission: { epoch: 1, pr }, reworkRequested: false, scenarioRequirements: [],
  evidence: [], observation: null, blocker: null, gates: [], violations: [], escalations: [], implementers: [], queueHistory: [], ...overrides } as unknown as Work);

const observed = (work: Work, at: string, approved: boolean) => ({
  candidate: work.candidate!, checks: ['test', 'typecheck'].map((name, index) => ({ name, result: 'success', appId: CI, id: index + 1 })),
  reviews: approved ? [{ reviewer: 'independent-reviewer', sha: work.candidate!.sha, state: 'APPROVED', id: 900, submittedAt: at }] : [],
  merged: false, mergeSha: null, mergeable: true, prState: 'open' as const, draft: false,
  baseTip: work.candidate!.baseSha, baseTipContained: true, protected: true, files: ['src/server/routes/feature.ts'], at,
  scopeFiles: [{ path: 'src/feature.ts', status: 'modified' as const, sha: sha(`scope-${work.key}`), additions: 3, deletions: 1, binary: false }],
}) as Work['observation'];

/**
 * The 2026-10-02 fleet at 100 open items: `queuedCount` approved entries in the merge queue (the
 * head band is the merge band; the rest wait behind it) and `reviewCount` unapproved candidates
 * whose next action is the review request. Every reading is `ageMs` old.
 */
function fleet(queuedCount: number, reviewCount: number, ageMs = 30_000) {
  const base = sha('main-capacity'), at = new Date(now - ageMs).toISOString();
  const queued = Array.from({ length: queuedCount }, (_, index) => item(`GY-Q${index}`, 300 + index, sha(`q${index}`), base, {
    queue: { sequence: index + 1, enqueuedAt: new Date(now - 3_600_000).toISOString(), policyRevision: 1, speculation: null } } as Partial<Work>));
  const review = Array.from({ length: reviewCount }, (_, index) => item(`GY-R${index}`, 600 + index, sha(`r${index}`), base,
    { stage: 'review', criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['manual:budget'] }] } as Partial<Work>));
  const raw = [...queued.map(work => ({ ...work, observation: observed(work, at, true) })), ...review.map(work => ({ ...work, observation: observed(work, at, false) }))] as Work[];
  return raw.map(work => ({ ...work, ...evaluate(work, raw, new Date(now), [CI]) }) as Work);
}

test('unit:observation-priority-keeps-merge-and-review-fresh — at 100 open items the default workers keep the merge and review bands inside their bounds while steady items wait; the pool and workers are sized together; master status reports lag per band', () => {
  const all = fleet(60, 40);
  const date = new Date(now);
  const reviewItems = all.filter(work => work.key.startsWith('GY-R'));
  assert.ok(reviewItems.every(work => nextAction(work, all, date)?.kind === 'request-review'), 'the forty candidates are review-requested');
  assert.deepEqual(observationFreshnessBounds, { merge: 120_000, review: 30 * 60_000, steady: null });

  // At 100 open candidates the fleet's steady-state interval reaches an hour, past the review bound:
  // the 2026-10-02 stall. A review request is polled at a third of its bound however far that stretches.
  const steadyMs = steadyStateInterval(100, null, null);
  assert.equal(steadyMs, 3_600_000);
  assert.equal(observationCadence(reviewItems[0], all, date, reviewItems[0].observation, steadyMs).ms, reviewCadenceCapMs);
  assert.equal(observationCadence(all[30], all, date, all[30].observation, steadyMs).ms, steadyMs, 'a queued entry behind the head band keeps the fleet bound');

  // A review request past half its bound joins the protected prefix, ahead of starved backlog jobs.
  const aged = all.map(work => work.key === 'GY-R7' ? { ...work, observation: { ...work.observation!, at: new Date(now - 16 * 60_000).toISOString() } } : work);
  const plan = observationClaim(aged, 1, now);
  const byKey = new Map(aged.map(work => [work.id, work.key]));
  assert.deepEqual(plan.order.slice(0, plan.headCount).map(id => byKey.get(id)), ['GY-Q0', 'GY-Q1', 'GY-R7'], 'the head band, then the aged review request');
  assert.equal(observationClaim(all, 1, now).headCount, 2, 'fresh review requests stay behind the prefix');

  // The default configuration: a pool of 16 and eight workers, never more than half the pool.
  const capacity = observationCapacity({});
  assert.deepEqual(capacity, { poolMax: defaultDatabasePoolSize, concurrency: defaultObservationConcurrency });
  assert.deepEqual([capacity.poolMax, capacity.concurrency], [16, 8]);
  assert.deepEqual(observationCapacity({ GRAPHYARD_OBSERVATION_CONCURRENCY: '12' }), { poolMax: 24, concurrency: 12 }, 'naming the workers grows the pool to fit them');
  assert.deepEqual(observationCapacity({ GRAPHYARD_DATABASE_POOL_SIZE: '10' }), { poolMax: 10, concurrency: 5 }, 'naming the pool caps the workers at half');
  assert.deepEqual(observationCapacity({ GRAPHYARD_DATABASE_POOL_SIZE: '10', GRAPHYARD_OBSERVATION_CONCURRENCY: '9' }), { poolMax: 10, concurrency: 5 });
  assert.deepEqual(observationCapacity({ GRAPHYARD_DATABASE_POOL_SIZE: 'nope', GRAPHYARD_OBSERVATION_CONCURRENCY: '0' }), { poolMax: 16, concurrency: 8 }, 'unparseable values keep the defaults');
  for (const pool of [2, 3, 12, 16, 40]) assert.ok(observationConcurrency(pool) <= Math.floor(pool / 2) || pool < 2, `a pool of ${pool} holds at most half as workers`);

  // The simulation: two hours of the default workers over this fleet, each observation 6.5-19.5 s
  // (the incident's jobs took 10-13 s) and half the readings changed. Merge and review stay inside their bounds; steady items wait.
  const run = simulateObservationScheduler({ all, workers: capacity.concurrency, steadyMs, jobMs: 13_000, durationMs: 2 * 3_600_000, changedShare: 0.5 });
  const band = (name: string) => run.bands.find(entry => entry.band === name)!;
  assert.deepEqual(run.bands.map(entry => [entry.band, entry.items]), [['merge', 2], ['review', 40], ['steady', 58]]);
  assert.ok(band('merge').worstLagMs <= 120_000, `the merge band's worst lag ${band('merge').worstLagMs} ms is inside two minutes`);
  assert.ok(band('review').worstLagMs <= reviewObservationFreshnessMs, `the review band's worst lag ${band('review').worstLagMs} ms is inside thirty minutes`);
  assert.ok(band('steady').worstLagMs > reviewObservationFreshnessMs, 'steady items wait past the review bound: they have none');
  assert.ok(run.withinBounds && run.claims > 0);

  // The simulation discriminates: the schedule before GY-1114 — a review request settled to the fleet
  // bound, four workers — leaves the review band an hour stale, as on 2026-10-02.
  const before = simulateObservationScheduler({ all, workers: 4, steadyMs, jobMs: 13_000, durationMs: 2 * 3_600_000, changedShare: 0.5, settledCadence: (_work, name, ms) => name === 'review' ? steadyMs : ms });
  assert.ok(!before.withinBounds && before.bands.find(entry => entry.band === 'review')!.worstLagMs > reviewObservationFreshnessMs, 'the old schedule breaches the review bound');

  // Master status: lag per band against its bound, and one attention item per band past it.
  const stale = fleet(4, 3).map(work => work.key === 'GY-R1' ? { ...work, observation: { ...work.observation!, at: new Date(now - 41 * 60_000).toISOString() } }
    : work.key === 'GY-Q1' ? { ...work, observation: { ...work.observation!, at: new Date(now - 200_000).toISOString() } } : work) as Work[];
  const report = observationThroughputStatus(null, { work: stale, now: new Date(now).toISOString(), jobs: [] }, now);
  assert.deepEqual(report.bands.map(entry => [entry.band, entry.items, entry.boundMs, entry.pastBound, entry.oldest]),
    [['merge', 2, 120_000, 1, 'GY-Q1'], ['review', 3, 1_800_000, 1, 'GY-R1'], ['steady', 2, null, 0, report.bands[2].oldest]]);
  assert.equal(report.bands[1].lagMs, 41 * 60_000);
  assert.deepEqual(report.attention.map(entry => entry.text.slice(0, 40)), ['The merge band has 1 of 2 item(s) observ', 'The review band has 1 of 3 item(s) obser']);
  assert.match(report.attention[1].text, /oldest GY-R1, 41m0s\): their review requests may name heads that have since moved/);
  assert.match(String(report.attention[0].next), /GRAPHYARD_OBSERVATION_CONCURRENCY with GRAPHYARD_DATABASE_POOL_SIZE/);
  assert.deepEqual(observationThroughputStatus(null, { work: fleet(4, 3), now: new Date(now).toISOString(), jobs: [] }, now).attention, [], 'every band inside its bound raises nothing');
});

// GY-1178: the follow-ups of GY-1114's review.

test('the merge band master status reports spans the queue positions the workers claim with the merge path, parallel tips included', () => {
  // Queue positions 2 and 3 are claimed with the merge path under four parallel tips (processJob's
  // band); with no tips in flight their lag was reported as steady, understating the merge band.
  const all = fleet(6, 0).map(work => work.key === 'GY-Q3' ? { ...work, observation: { ...work.observation!, at: new Date(now - 200_000).toISOString() } } : work) as Work[];
  const claimed = observationClaim(all, observationClaimBatch(1, 4), now);
  const byKey = new Map(all.map(work => [work.id, work.key]));
  assert.deepEqual(claimed.order.slice(0, claimed.headCount).map(id => byKey.get(id)), ['GY-Q0', 'GY-Q1', 'GY-Q2', 'GY-Q3']);
  const status = (mergeQueue: { batchSize: number; parallelTips: number } | null) => observationThroughputStatus(mergeQueue ? { mergeQueue } : null, { work: all, now: new Date(now).toISOString(), jobs: [] }, now);
  const tips = status({ batchSize: 1, parallelTips: 4 });
  assert.deepEqual(tips.bands.map(entry => [entry.band, entry.items, entry.pastBound]), [['merge', 4, 1], ['review', 0, 0], ['steady', 2, 0]]);
  assert.match(tips.attention[0].text, /The merge band has 1 of 4 item\(s\).*oldest GY-Q3/);
  assert.deepEqual(status({ batchSize: 3, parallelTips: 1 }).bands[0].items, 3, 'a batch wider than the tips sets the band');
  // Unpublished settings keep the head band of two, as the workers' defaults do.
  assert.deepEqual(status(null).bands.map(entry => [entry.band, entry.items, entry.pastBound]), [['merge', 2, 0], ['review', 0, 0], ['steady', 4, 0]]);
  assert.equal(observationClaimBatch(), 1);
});

test('a large review-requested fleet stays inside the review bound without spending past the hourly limit less the merge-path reserve', () => {
  // 180 review requests polled at the ten-minute cap, a tenth of readings changed. A settled reading
  // is answered with free 304s and "costs at most a couple of charged requests" (src/github.ts); a
  // changed one costs a full observation. Polling the cap faster, or removing it, fails one bound.
  const settledPollRequests = 2;
  const all = fleet(20, 180), durationMs = 2 * 3_600_000;
  const run = simulateObservationScheduler({ all, workers: observationCapacity({}).concurrency, steadyMs: steadyStateInterval(all.length, null, null), jobMs: 13_000, durationMs, changedShare: 0.1 });
  const review = run.bands.find(entry => entry.band === 'review')!;
  assert.equal(review.items, 180);
  assert.ok(run.withinBounds && review.worstLagMs <= reviewObservationFreshnessMs, `the review band's worst lag ${review.worstLagMs} ms is inside thirty minutes`);
  const perHour = ((run.claims - run.changedReadings) * settledPollRequests + run.changedReadings * assumedObservationRequests) / (durationMs / 3_600_000);
  assert.ok(perHour <= defaultHourlyLimit - mergePathReserve, `the fleet charges ${perHour} requests an hour, inside ${defaultHourlyLimit - mergePathReserve}`);
  // The cap alone: every review request polled once per cap interval, all settled.
  assert.ok(180 * (3_600_000 / reviewCadenceCapMs) * settledPollRequests <= defaultHourlyLimit - mergePathReserve);
});

test('with advance the simulation moves items between bands as their readings change, and the bounds still hold', () => {
  // A changed reading of a review request approves it into the back of the queue; one of the queue
  // head merges it. Items leave the review band, queued entries move up into the merge band.
  const all = fleet(10, 30);
  let sequence = 100;
  const advance = (work: Work, fleet: Work[], at: number): Work | null => {
    if (work.key.startsWith('GY-R') && !work.queue) {
      const queued = { ...work, stage: 'merge', queue: { sequence: ++sequence, enqueuedAt: new Date(at).toISOString(), policyRevision: 1, speculation: null }, observation: observed(work, new Date(at).toISOString(), true) } as Work;
      return { ...queued, ...evaluate(queued, fleet.map(entry => entry.id === work.id ? queued : entry), new Date(at), [CI]) } as Work;
    }
    const head = fleet.filter(entry => entry.queue && entry.stage !== 'done').sort((a, b) => a.queue!.sequence - b.queue!.sequence)[0];
    return head?.id === work.id ? { ...work, stage: 'done', queue: null } as Work : null;
  };
  const options = { all, workers: 8, steadyMs: steadyStateInterval(all.length, null, null), jobMs: 13_000, durationMs: 3_600_000, changedShare: 0.3 };
  const fixed = simulateObservationScheduler(options);
  assert.equal(fixed.bandChanges, 0, 'without advance every item keeps its starting band');
  const moving = simulateObservationScheduler({ ...options, advance });
  const count = (band: string) => moving.bands.find(entry => entry.band === band)!.items;
  assert.ok(moving.bandChanges > 10, `items moved between bands ${moving.bandChanges} times`);
  assert.ok(count('review') < 30, `review requests were approved out of the review band (${count('review')} left)`);
  assert.ok(count('merge') <= 2 && count('merge') + count('review') + count('steady') < 40, 'merged heads leave the open fleet');
  assert.ok(moving.withinBounds, JSON.stringify(moving.bands));
});
