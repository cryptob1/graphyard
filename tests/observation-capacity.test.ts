import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { evaluate, type Work } from '../src/model.js';
import { nextAction } from '../src/model/next-action.js';
import { assumedObservationRequests, CHECK_NAME, defaultHourlyLimit, GitHub, mergePathReserve, observationCadence, steadyStateInterval } from '../src/github.js';
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

// GY-1195: the follow-ups of GY-1178's review. The hourly guard below priced a settled poll at a
// fixed two charged requests; the soak here measures it from the real `observe` path instead.

const APP = 1234, REPOSITORY = 'owner/project';
const etagOf = (body: string) => `"${createHash('sha1').update(body).digest('hex')}"`;

/**
 * GitHub's REST surface at the fetch level, as tests/github-rate-budget.test.ts models it: every GET
 * answers with an ETag and honours If-None-Match with a free 304, every other answer is charged.
 * `conditional = false` is the regression the soak must catch: settled polls paid in full.
 */
class Provider {
  main = sha('main-soak');
  pulls = new Map<number, { head: string; branch: string; approved: boolean }>();
  conditional = true;
  charged = 0;
  open(pr: number, branch: string, approved: boolean) { this.pulls.set(pr, { head: sha(`head-${pr}`), branch, approved }); return this.pulls.get(pr)!; }
  private contains(base: string, head: string) { return base === head || base === this.main && [...this.pulls.values()].some(pr => pr.head === head); }
  private body(path: string): unknown {
    const [route, query = ''] = path.replace(`/repos/${REPOSITORY}`, '').split('?'); const params = new URLSearchParams(query);
    if (route === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: this.main } };
    if (route === '/rules/branches/main') return [];
    let match = /^\/pulls\/(\d+)$/.exec(route);
    if (match) {
      const pr = this.pulls.get(Number(match[1]))!;
      return { number: Number(match[1]), state: 'open', draft: false, merged: false, mergeable: true, merge_commit_sha: null, merged_at: null, created_at: '2026-10-02T10:00:00Z', user: { login: 'implementer', id: 7 },
        head: { sha: pr.head, ref: pr.branch, repo: { full_name: REPOSITORY } }, base: { sha: this.main, ref: 'main', repo: { full_name: REPOSITORY } } };
    }
    match = /^\/pulls\/(\d+)\/reviews$/.exec(route);
    if (match) { const pr = this.pulls.get(Number(match[1]))!; return params.get('page') !== '1' || !pr.approved ? [] : [{ id: 900 + Number(match[1]), user: { login: 'independent-reviewer' }, commit_id: pr.head, state: 'APPROVED', submitted_at: '2026-10-02T10:05:00Z' }]; }
    match = /^\/pulls\/(\d+)\/files$/.exec(route);
    if (match) return params.get('page') !== '1' ? [] : [{ filename: 'src/server/routes/feature.ts', status: 'modified', sha: sha(`blob-${match[1]}`), additions: 3, deletions: 1, patch: '@@' }];
    match = /^\/commits\/([a-f0-9]{40})\/check-runs$/.exec(route);
    if (match) return params.get('check_name') ? { check_runs: [] } : { check_runs: ['test', 'typecheck'].map((name, index) => ({ id: index + 1, name, status: 'completed', conclusion: 'success', app: { id: CI } })) };
    match = /^\/commits\/([a-f0-9]{40})$/.exec(route);
    if (match) return { sha: match[1], parents: [], commit: { tree: { sha: sha(`tree-${match[1]}`) } }, author: { login: 'implementer' } };
    match = /^\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/.exec(route);
    // Every head is one commit cut from the base tip, so a comparison lists that commit, as GitHub's does.
    if (match) { const commits = match[1] === match[2] ? [] : [{ sha: match[2] }]; return { status: match[1] === match[2] ? 'identical' : this.contains(match[1], match[2]) ? 'ahead' : 'diverged', total_commits: commits.length, commits, files: [] }; }
    if (route.endsWith('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: APP }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    throw new Error(`Unexpected request ${path}`);
  }
  fetch = async (url: unknown, options: any = {}): Promise<Response> => {
    const method = options.method ?? 'GET', path = String(url).replace('https://api.github.com', '');
    const headers = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '5000', 'x-ratelimit-used': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 3000), 'x-ratelimit-resource': 'core' };
    assert.equal(method, 'GET', `observation only reads (${method} ${path})`);
    const text = JSON.stringify(this.body(path)), etag = etagOf(`${path}:${text}`);
    if (this.conditional && options.headers?.['If-None-Match'] === etag) return new Response(null, { status: 304, headers: { ...headers, etag } });
    this.charged++;
    return new Response(text, { status: 200, headers: { ...headers, etag, 'content-type': 'application/json' } });
  };
}

type Soak = { settledPolls: number; settledCharged: number; settledMax: number; changedPolls: number; changedCharged: number; reviewPolls: number; reviewWorstGapMs: number; chargedPerHour: number };

/**
 * One simulated hour of the real observation loop over 20 queued entries and 180 review requests:
 * each item is observed through `GitHub.observe` against the provider when the cadence its observed
 * state earns says so, the shared per-cycle reads timed on the simulated clock. Every tenth poll of a
 * review request finds a pushed head and is paid for in full. What GitHub charged is counted per poll.
 */
async function soak(conditional: boolean): Promise<Soak> {
  const api = new Provider();
  const github = new GitHub({ repository: REPOSITORY, base: 'main', appId: APP, installationId: 2, privateKey: 'not-used' });
  // The provider is injected into this one client (GY-1208), so no other request in the process reaches it.
  github.fetch = api.fetch as typeof fetch;
  Object.assign(github, { token: 'fixture-token', expires: Date.now() + 3 * 3_600_000 });
  github.controlPlaneLogin = async () => 'graphyard-owner-project[bot]';
  const start = Date.now(); let clock = 0;
  github.clock = () => start + clock;
  const queued = Array.from({ length: 20 }, (_, index) => { const pr = api.open(300 + index, `graphyard/gy-q${index}-1`, true);
    return item(`GY-Q${index}`, 300 + index, pr.head, api.main, { queue: { sequence: index + 1, enqueuedAt: new Date(start - 3_600_000).toISOString(), policyRevision: 1, speculation: null } } as Partial<Work>); });
  const review = Array.from({ length: 180 }, (_, index) => { const pr = api.open(600 + index, `graphyard/gy-r${index}-1`, false);
    return item(`GY-R${index}`, 600 + index, pr.head, api.main, { stage: 'review', criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['manual:budget'] }] } as Partial<Work>); });
  let all: Work[] = [...queued, ...review];
  const apply = (work: Work, observation: Work['observation'], at: number) => {
    const next = { ...work, candidate: observation!.candidate, observation } as Work;
    const fleet = all.map(entry => entry.id === work.id ? next : entry);
    return { ...next, ...evaluate(next, fleet, new Date(at), [CI]) } as Work;
  };
  // The fleet settles before the hour: every item is observed, with every peer observed, until a whole round costs nothing.
  for (let round = 0, before = -1; before !== api.charged; round++) {
    assert.ok(round < 4, `the fleet settles within four rounds (${api.charged} charged)`);
    before = api.charged;
    for (const work of [...all]) {
      const observation = await github.observe(all.find(entry => entry.id === work.id)!, all);
      all = all.map(entry => entry.id === work.id ? apply(entry, observation, start) : entry);
    }
  }
  assert.ok(all.filter(work => work.key.startsWith('GY-R')).every(work => nextAction(work, all, new Date(start))?.kind === 'request-review'), 'the 180 review requests are review-requested on their real observations');
  const steadyMs = steadyStateInterval(all.length, null, null);
  api.conditional = conditional; api.charged = 0;
  const hour = 3_600_000, due = new Map(all.map(work => [work.id, 0])), lastAt = new Map<string, number>();
  const result: Soak = { settledPolls: 0, settledCharged: 0, settledMax: 0, changedPolls: 0, changedCharged: 0, reviewPolls: 0, reviewWorstGapMs: 0, chargedPerHour: 0 };
  let reviewPolls = 0;
  while (true) {
    const next = Math.min(...due.values()); if (next >= hour) break; clock = next;
    for (const work of [...all]) {
      if (due.get(work.id) !== clock) continue;
      const current = all.find(entry => entry.id === work.id)!, isReview = current.key.startsWith('GY-R');
      const changed = isReview && ++reviewPolls % 10 === 0;
      if (changed) api.pulls.get(current.submission!.pr)!.head = sha(`head-${current.key}-${reviewPolls}`);
      const before = api.charged;
      const observation = await github.observe(current, all);
      const charged = api.charged - before;
      if (changed) { result.changedPolls++; result.changedCharged += charged; }
      else { result.settledPolls++; result.settledCharged += charged; result.settledMax = Math.max(result.settledMax, charged); }
      const observed = apply(current, observation, start + clock);
      all = all.map(entry => entry.id === work.id ? observed : entry);
      const cadence = observationCadence(observed, all, new Date(start + clock), current.observation, steadyMs);
      if (isReview) {
        result.reviewPolls++;
        if (lastAt.has(work.id)) result.reviewWorstGapMs = Math.max(result.reviewWorstGapMs, clock - lastAt.get(work.id)!);
        lastAt.set(work.id, clock);
      }
      due.set(work.id, clock + cadence.ms);
    }
  }
  result.chargedPerHour = api.charged;
  return result;
}

let measured: Promise<Soak> | null = null;
const settledSoak = () => measured ??= soak(true);

test('a real-loop hour over a large review-requested fleet: settled polls cost what the budget guard prices them at, and GitHub is charged inside the hourly limit less the merge-path reserve', async () => {
  const run = await settledSoak();
  const reserved = defaultHourlyLimit - mergePathReserve;
  assert.ok(run.reviewPolls >= 180 * (3_600_000 / reviewCadenceCapMs), `every review request is polled at the cap (${run.reviewPolls} polls)`);
  assert.ok(run.reviewWorstGapMs <= reviewCadenceCapMs, `no review request waits past the cap (${run.reviewWorstGapMs} ms)`);
  assert.ok(run.changedPolls > 0 && run.changedCharged / run.changedPolls > 2, 'a pushed head is paid for, so the soak counts real charges');
  assert.ok(run.changedCharged / run.changedPolls <= assumedObservationRequests, `a changed reading costs ${run.changedCharged / run.changedPolls} on average, inside the ${assumedObservationRequests} the guard prices it at`);
  assert.ok(run.settledMax <= 2, `a settled poll costs at most a couple of charged requests on the real observe path; the dearest cost ${run.settledMax}`);
  assert.ok(run.chargedPerHour <= reserved, `the real loop charged ${run.chargedPerHour} requests in the hour, inside ${reserved}`);
  // The soak discriminates: settled polls paid in full — conditional reads lost — breach the bound.
  const regressed = await soak(false);
  assert.ok(regressed.settledMax > 2 && regressed.chargedPerHour > reserved, `without free 304s the same hour charges ${regressed.chargedPerHour}, past ${reserved}`);
});

test('a large review-requested fleet stays inside the review bound without spending past the hourly limit less the merge-path reserve', async () => {
  // 180 review requests polled at the ten-minute cap, a tenth of readings changed. A settled reading
  // is priced at the dearest settled poll the real-loop soak measured, never below one request; a
  // changed one costs a full observation. Polling the cap faster, or removing it, fails one bound.
  const settledPollRequests = Math.max(1, (await settledSoak()).settledMax);
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
