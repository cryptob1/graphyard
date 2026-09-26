import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store, wakeJob } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { GitHub, firstObservationOwed, headClaimBand, observationClaimOrder, observationHeadCount, observationFreshnessMs, observationThroughput, processJob, waitsOnObservation } from '../src/github.js';
import { evaluate, type Principal, type Work } from '../src/model.js';
import { nextAction } from '../src/model/next-action.js';
import { observationConcurrency, observationWorkers } from '../src/server/main.js';
import { observationThroughputStatus } from '../src/cli/master-status.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-492. Each test is named for the proof it produces: unit:job-claim-priority,
// unit:parallel-observation-jobs, unit:observation-lag-visible.

const APP = 1234, CI = 15368, REPOSITORY = 'owner/project';
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ---- The provider at the fetch level, as github-rate-budget.test.ts mocks it ----

class Api {
  main = sha('main-1');
  pulls = new Map<number, { head: string; branch: string; approved: boolean; checks: 'success' | 'in_progress' }>();
  limit = 5000; remaining = 5000; resetAt = Math.ceil(Date.now() / 1000) + 3600;
  requests: { method: string; path: string; status: number }[] = [];
  open(pr: number, branch: string, options: { approved?: boolean; checks?: 'success' | 'in_progress' } = {}) {
    this.pulls.set(pr, { head: sha(`head-${pr}-${this.main}`), branch, approved: options.approved ?? true, checks: options.checks ?? 'success' });
    return this.pulls.get(pr)!;
  }
  private contains(base: string, head: string) { return base === head || base === this.main && [...this.pulls.values()].some(pr => pr.head === head); }
  private body(method: string, path: string): unknown {
    if (method !== 'GET') return { id: 12 };
    const [route, query = ''] = path.replace(`/repos/${REPOSITORY}`, '').split('?'); const params = new URLSearchParams(query);
    if (route === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: this.main } };
    let match = /^\/pulls\/(\d+)$/.exec(route);
    if (match) {
      const pr = this.pulls.get(Number(match[1]))!;
      return { number: Number(match[1]), state: 'open', draft: false, merged: false, mergeable: true, merge_commit_sha: null, merged_at: null, created_at: '2026-09-21T10:00:00Z', user: { login: 'implementer', id: 7 },
        head: { sha: pr.head, ref: pr.branch, repo: { full_name: REPOSITORY } }, base: { sha: this.main, ref: 'main', repo: { full_name: REPOSITORY } } };
    }
    match = /^\/pulls\/(\d+)\/reviews$/.exec(route);
    if (match) return params.get('page') !== '1' ? [] : this.pulls.get(Number(match[1]))!.approved ? [{ id: 40 + Number(match[1]), user: { login: 'independent-reviewer' }, commit_id: this.pulls.get(Number(match[1]))!.head, state: 'APPROVED', submitted_at: '2026-09-21T10:05:00Z' }] : [];
    match = /^\/pulls\/(\d+)\/files$/.exec(route);
    if (match) return params.get('page') !== '1' ? [] : [{ filename: 'src/feature.ts', status: 'modified', sha: sha(`blob-${match[1]}`), additions: 3, deletions: 1, patch: '@@' }];
    match = /^\/commits\/([a-f0-9]{40})\/check-runs$/.exec(route);
    if (match) {
      if (params.get('check_name')) return { check_runs: [] };
      const pr = [...this.pulls.values()].find(entry => entry.head === match![1]);
      return { check_runs: ['test', 'typecheck'].map((name, index) => ({ id: index + 1, name, status: pr?.checks === 'success' ? 'completed' : 'in_progress', conclusion: pr?.checks === 'success' ? 'success' : null, app: { id: CI } })) };
    }
    match = /^\/commits\/([a-f0-9]{40})$/.exec(route);
    if (match) return { sha: match[1], parents: [], commit: { tree: { sha: sha(`tree-${match[1]}`) } }, author: { login: 'implementer' } };
    match = /^\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/.exec(route);
    if (match) return { status: match[1] === match[2] ? 'identical' : this.contains(match[1], match[2]) ? 'ahead' : 'diverged', files: [] };
    if (route.endsWith('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: APP }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    throw new Error(`Unexpected request ${method} ${path}`);
  }
  private headers(extra: Record<string, string> = {}) {
    return { 'x-ratelimit-limit': String(this.limit), 'x-ratelimit-remaining': String(Math.max(0, this.remaining)), 'x-ratelimit-used': String(this.limit - this.remaining), 'x-ratelimit-reset': String(this.resetAt), 'x-ratelimit-resource': 'core', ...extra };
  }
  fetch = async (url: unknown, options: any = {}): Promise<Response> => {
    const method = options.method ?? 'GET'; const path = String(url).replace('https://api.github.com', '');
    if (method === 'POST' && path.endsWith('/merges')) { this.remaining--; this.requests.push({ method, path, status: 204 }); return new Response(null, { status: 204, headers: this.headers() }); }
    const text = JSON.stringify(this.body(method, path));
    this.remaining--; this.requests.push({ method, path, status: 200 });
    return new Response(text, { status: 200, headers: { ...this.headers(), etag: `"${sha(path + text)}"`, 'content-type': 'application/json' } });
  };
  client() {
    const github = new GitHub({ repository: REPOSITORY, base: 'main', appId: APP, installationId: 2, privateKey: 'not-used' });
    Object.assign(github, { token: 'fixture-token', expires: Date.now() + 3_600_000 });
    github.controlPlaneLogin = async () => 'graphyard-owner-project[bot]';
    return github;
  }
}

// ---- Hand-built work items, for the cases that read documents without observing them ----

const item = (key: string, pr: number, head: string, baseSha: string, overrides: Partial<Work> = {}): Work => ({
  id: randomUUID(), key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [] }],
  policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/'], stage: 'merge', revision: 3, policyRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  stageEnteredAt: new Date().toISOString(), ready: true, epoch: 1, lease: null, workspaces: [{ host: 'machine', path: `/w/${key}`, branch: `graphyard/${key.toLowerCase()}-1`, epoch: 1, owner: 'implementer' }],
  candidate: { sha: head, baseSha, pr, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' }, submission: { epoch: 1, pr }, reworkRequested: false, scenarioRequirements: [],
  evidence: [], observation: null, blocker: null, gates: [], violations: [], escalations: [], implementers: [], queueHistory: [], ...overrides } as unknown as Work);

/** A current observation: in scope, checked, approved, so only the queue itself refuses the merge. */
const observed = (work: Work, at = new Date(Date.now() - 30_000).toISOString(), approved = true) => ({
  candidate: work.candidate!, checks: ['test', 'typecheck'].map((name, index) => ({ name, result: 'success', appId: CI, id: index + 1 })),
  reviews: approved ? [{ reviewer: 'independent-reviewer', sha: work.candidate!.sha, state: 'APPROVED', id: 900, submittedAt: at }] : [],
  merged: false, mergeSha: null, mergeable: true, prState: 'open' as const, draft: false,
  baseTip: work.candidate!.baseSha, baseTipContained: true, protected: true, files: ['src/feature.ts'], at,
  scopeFiles: [{ path: 'src/feature.ts', status: 'modified' as const, sha: sha(`scope-${work.key}`), additions: 3, deletions: 1, binary: false }],
});

/** `count` queued entries whose sequence order is the queue order: entry 0 is the head. */
const queued = (count: number, baseSha: string, observationAgeMs = 30_000) => {
  const base = Array.from({ length: count }, (_, index) => item(`GY-Q${String(index).padStart(2, '0')}`, 300 + index, sha(`head-q${index}-${baseSha}`), baseSha, {
    queue: { sequence: index + 1, enqueuedAt: new Date(Date.now() - 3_600_000).toISOString(), policyRevision: 1, speculation: null } }));
  return base.map(work => {
    const observation = observed(work, new Date(Date.now() - observationAgeMs).toISOString()) as Work['observation'];
    return { ...work, observation, ...evaluate({ ...work, observation }, base, new Date(), [CI]) } as Work;
  });
};

let database: EmbeddedPostgres, store: Store, engine: Engine;
let port = 0, databases = 0;
before(async () => {
  port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 492;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('observation-throughput'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start();
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

/** A fresh database per scenario, so one scenario's jobs never order the next. */
async function freshStore() {
  if (store) await store.close();
  const name = `graphyard_test_${++databases}`;
  await database.createDatabase(name);
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/${name}`); await store.init();
  return store;
}
const insert = async (works: Work[]) => {
  for (const work of works) await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [work.id, work]);
};
/** When each job became due: the head last, its queue behind it, the waiting item and the backlog before it. */
const dueAt = (position: number) => new Date(Date.now() - (position === 0 ? 1_000 : (120 - position) * 60_000));

test('unit:job-claim-priority — thirty due jobs with the head due last are claimed head first: the queue head and its band, then a submission never observed, then the item a review waits on, then the backlog by availability, which is what availability alone still claims', async () => {
  await freshStore();
  const base = sha('main-priority');
  const queue = queued(30, base);
  // An unapproved head with manual-only proofs: nothing but the review gate refuses it, so its
  // next action is the review request the loop can only make from a fresh observation.
  const waitingWork = item('GY-WAIT', 500, sha(`head-wait-${base}`), base, { criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['manual:budget'] }] });
  const waitingObservation = observed(waitingWork, new Date(Date.now() - 30_000).toISOString(), false) as Work['observation'];
  const waiting = { ...waitingWork, observation: waitingObservation, ...evaluate({ ...waitingWork, observation: waitingObservation }, queue, new Date(), [CI]) } as Work;
  // A submitted item with no candidate observed yet: its next action is a resync, and only its first
  // observation serves it. It is ranked after the head band, ahead of the review-waiting items that come
  // due again every cycle (2026-09-26: behind them, one worker never reached eight such submissions).
  const ordinaryWork = item('GY-BACK', 501, sha(`head-back-${base}`), base, { candidate: null, observation: null, stage: 'build' });
  const ordinary = { ...ordinaryWork, ...evaluate(ordinaryWork, queue, new Date(), [CI]) } as Work;
  const all = [...queue, waiting, ordinary];
  assert.equal(nextAction(waiting, all, new Date())?.kind, 'request-review', 'the waiting item is built for the review request the loop owes');
  assert.ok(waitsOnObservation(waiting, all));
  assert.equal(nextAction(ordinary, all, new Date())?.kind, 'resync', 'the unread submission waits on its first reading');
  assert.ok(!waitsOnObservation(ordinary, all));
  assert.ok(firstObservationOwed(ordinary) && !firstObservationOwed(waiting) && !firstObservationOwed(queue[0]), 'only a submission never observed owes a first reading');
  assert.ok(!waitsOnObservation(queue[10], all), 'a queued entry behind the band is backlog for claiming');
  await insert(all);
  for (const [position, work] of [...queue.entries(), [30, waiting] as [number, Work], [31, ordinary] as [number, Work]]) {
    const availableAt = position === 30 ? new Date(Date.now() - 90 * 60_000) : position === 31 ? new Date(Date.now() - 180 * 60_000) : dueAt(position);
    await store.pool.query('INSERT INTO jobs(work_id,available_at) VALUES($1,$2)', [work.id, availableAt]);
  }
  // The band the claim order reaches: two entries at least, the batch size when it is larger.
  assert.equal(headClaimBand(0), 2); assert.equal(headClaimBand(1), 2); assert.equal(headClaimBand(5), 5);
  const order = observationClaimOrder(all, 5);
  assert.deepEqual(order.slice(0, 7), [queue[0].id, queue[1].id, queue[2].id, queue[3].id, queue[4].id, ordinary.id, waiting.id], 'head and band first, then the unread submission, then the item a review waits on');
  assert.ok(!order.includes(queue[10].id), 'a queued entry behind the band is not named; it falls back to availability');
  // Availability alone claims the oldest job: the head is due last, so the backlog wins.
  const unprioritised = await store.takeJob();
  assert.equal(unprioritised?.work_id, ordinary.id, 'without the order the head waits behind every older job');
  await store.pool.query('UPDATE jobs SET token=NULL,locked_until=NULL WHERE work_id=$1', [ordinary.id]);
  // With the claim order the head wins although it became due last, then its band, then the unread
  // submission, then the review-waiting item, then the rest of the queue by availability.
  const claims: string[] = [];
  for (let index = 0; index < 8; index++) claims.push((await store.takeJob(observationClaimOrder(all, 5), observationHeadCount(all, 5)))!.work_id);
  const byId = new Map(all.map(work => [work.id, work.key]));
  assert.deepEqual(claims.map(id => byId.get(id)),
    ['GY-Q00', 'GY-Q01', 'GY-Q02', 'GY-Q03', 'GY-Q04', 'GY-BACK', 'GY-WAIT', 'GY-Q05'],
    'priority reorders the due jobs; availability orders what the priority does not name');
});

test('unit:starved-job-claimed — a job due longer than the starvation bound is claimed right after the queue-head band, ahead of named jobs that just came due', async () => {
  await freshStore();
  const base = sha('main-starved');
  // The claim query itself: a head the order names first, a named job that just came due (a review
  // waiting on a reading), and a job no list names that has been due ten minutes (2026-09-26: an item
  // whose only refusal was a stale observation waited 40 minutes behind named jobs due every cycle).
  const head = item('GY-HEAD', 520, sha(`head-h-${base}`), base);
  const named = item('GY-NAMED', 521, sha(`head-n-${base}`), base);
  const starved = item('GY-STARVED', 522, sha(`head-s-${base}`), base);
  await insert([head, named, starved]);
  for (const [work, ageMs] of [[head, 1_000], [named, 2_000], [starved, 10 * 60_000]] as [Work, number][])
    await store.pool.query('INSERT INTO jobs(work_id,available_at) VALUES($1,$2)', [work.id, new Date(Date.now() - ageMs)]);
  const byId = new Map([head, named, starved].map(work => [work.id, work.key]));
  const claims: string[] = [];
  for (let index = 0; index < 3; index++) claims.push(byId.get((await store.takeJob([head.id, named.id], 1))!.work_id)!);
  assert.deepEqual(claims, ['GY-HEAD', 'GY-STARVED', 'GY-NAMED'], 'the head band first, then the job due ten minutes, then the named job that just came due');
  // Inside the bound the named list still wins: a job due one minute waits behind it.
  await freshStore();
  await insert([head, named, starved]);
  for (const [work, ageMs] of [[head, 1_000], [named, 2_000], [starved, 60_000]] as [Work, number][])
    await store.pool.query('INSERT INTO jobs(work_id,available_at) VALUES($1,$2)', [work.id, new Date(Date.now() - ageMs)]);
  const early: string[] = [];
  for (let index = 0; index < 3; index++) early.push(byId.get((await store.takeJob([head.id, named.id], 1))!.work_id)!);
  assert.deepEqual(early, ['GY-HEAD', 'GY-NAMED', 'GY-STARVED'], 'within the bound the claim order is unchanged');
});

test('unit:wake-keeps-seniority — waking a job already due keeps its due time, so an item saved every minute still reaches the starvation bound', async () => {
  await freshStore();
  const base = sha('main-wake');
  const head = item('GY-WHEAD', 530, sha(`head-wh-${base}`), base);
  const named = item('GY-WNAMED', 531, sha(`head-wn-${base}`), base);
  const busy = item('GY-BUSY', 532, sha(`head-wb-${base}`), base);
  await insert([head, named, busy]);
  for (const [work, ageMs] of [[head, 1_000], [named, 2_000], [busy, 10 * 60_000]] as [Work, number][])
    await store.pool.query('INSERT INTO jobs(work_id,available_at) VALUES($1,$2)', [work.id, new Date(Date.now() - ageMs)]);
  // Every save of the item wakes its job; a wake must not make a long-due job look freshly due.
  await store.transaction(async db => { await wakeJob(db, busy.id); await wakeJob(db, busy.id); });
  const due = (await store.pool.query('SELECT available_at FROM jobs WHERE work_id=$1', [busy.id])).rows[0].available_at as Date;
  assert.ok(Date.now() - due.getTime() > 9 * 60_000, 'the wake kept the job due since ten minutes ago');
  const byId = new Map([head, named, busy].map(work => [work.id, work.key]));
  const claims: string[] = [];
  for (let index = 0; index < 3; index++) claims.push(byId.get((await store.takeJob([head.id, named.id], 1))!.work_id)!);
  assert.deepEqual(claims, ['GY-WHEAD', 'GY-BUSY', 'GY-WNAMED'], 'the woken job is still claimed as starved');
  // A job scheduled for later is still made due now by a wake.
  await store.pool.query("UPDATE jobs SET token=NULL,locked_until=NULL,available_at=now()+interval '5 minutes' WHERE work_id=$1", [named.id]);
  await store.transaction(async db => { await wakeJob(db, named.id); });
  const woken = (await store.pool.query('SELECT available_at FROM jobs WHERE work_id=$1', [named.id])).rows[0].available_at as Date;
  assert.ok(woken.getTime() <= Date.now() + 1_000, 'a wake still brings a later job forward');
});

test('unit:parallel-observation-jobs — twenty due jobs whose observations each take a second are processed in about five seconds at concurrency four, and no item is ever observed twice at once', async t => {
  await freshStore();
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client();
  const operator: Principal = { id: 'operator', role: 'admin' };
  const worker: Principal = { id: 'agent-a', role: 'worker' };
  engine = new Engine(store, [CI], 120, REPOSITORY); engine.controlPlaneAppId = APP;
  engine.principals = [operator, worker]; engine.submissionObserver = null;
  let prNumber = 600;
  for (let index = 0; index < 20; index++) {
    let work = await engine.execute(operator, 'create', null, { title: `Parallel ${index}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:budget'] }] }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/parallel/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
    api.open(++prNumber, `graphyard/${work.key.toLowerCase()}-1`);
    await engine.execute(worker, 'submit', work.id, { epoch: 1, pr: prNumber }, randomUUID());
    await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL,error=NULL WHERE work_id=$1', [work.id]);
  }
  assert.equal(Number((await store.pool.query('SELECT count(*) AS n FROM jobs WHERE available_at<=now()')).rows[0].n), 20, 'twenty jobs are due at once');
  // The fake provider's observations take a second, and an overlap on one item is a failure the
  // pool must never cause: SKIP LOCKED means two workers cannot hold one job.
  const seen = new Set<string>(), inFlight = new Map<string, number>();
  const underlying = github.observe.bind(github);
  github.observe = (async (work: Work, all: Work[]) => {
    const concurrent = (inFlight.get(work.id) ?? 0) + 1;
    inFlight.set(work.id, concurrent);
    try {
      assert.equal(concurrent, 1, `${work.key} is observed twice at once`);
      await sleep(1000);
      const observation = await underlying(work, all);
      seen.add(work.id);
      return observation;
    } finally { inFlight.set(work.id, concurrent - 1); }
  }) as typeof github.observe;
  const concurrency = observationConcurrency(12);
  assert.equal(concurrency, 4, 'the default concurrency is four jobs at once');
  const started = Date.now();
  await observationWorkers(engine, github, 4, () => seen.size >= 20);
  const elapsedMs = Date.now() - started;
  assert.ok(seen.size >= 20, `every due job was observed (${seen.size})`);
  assert.ok(elapsedMs >= 4500, `four workers at 1 s each need five rounds; ${elapsedMs} ms is too fast to be honest`);
  assert.ok(elapsedMs < 10_000, `twenty 1 s observations at concurrency four take about 5 s, not ${elapsedMs} ms (one worker would take 20 s)`);
  // The durations the workers recorded are what the throughput report reads.
  const throughput = github.budget().throughput;
  assert.equal(throughput.count, 20);
  assert.ok(throughput.jobsPerMinute > 0); assert.ok(throughput.medianDurationMs! >= 1000); assert.ok(throughput.p90DurationMs! >= throughput.medianDurationMs!);
});

test('unit:observation-lag-visible — master status reports what the workers achieve and how old the oldest due job and the queue head\'s observation are, and raises one attention item once the head passes two minutes', () => {
  const now = Date.now();
  const base = sha('main-lag');
  const docs = ([
    { ...item('GY-HEAD', 700, sha(`head-h-${base}`), base), queue: { sequence: 1, enqueuedAt: new Date(now - 3_600_000).toISOString(), policyRevision: 1, speculation: null } },
    { ...item('GY-MID', 701, sha(`head-m-${base}`), base), queue: { sequence: 2, enqueuedAt: new Date(now - 3_600_000).toISOString(), policyRevision: 1, speculation: null } },
  ] as Work[]).map((work, index) => ({ ...work, observation: observed(work, new Date(now - 181_000).toISOString()) as Work['observation'] }));
  const snapshot = { work: docs, now: new Date(now).toISOString(), jobs: [
    { work_id: docs[0].id, available_at: new Date(now - 3_600_000).toISOString(), locked_until: null, error: null },
    { work_id: docs[1].id, available_at: new Date(now - 7_200_000).toISOString(), locked_until: new Date(now + 60_000).toISOString(), error: null },
    { work_id: docs[1].id, available_at: new Date(now - 480_000).toISOString(), locked_until: null, error: null, held_until: new Date(now + 60_000).toISOString() },
  ] };
  const coordinator = { githubBudget: { throughput: { jobsPerMinute: 6.1, medianDurationMs: 9000, p90DurationMs: 13000 } } };
  const report = observationThroughputStatus(coordinator, snapshot as { work: Work[]; now: string; jobs: { work_id: string; available_at: string; locked_until: string | null; error: string | null; held_until?: string | null }[] }, now);
  assert.deepEqual([report.jobsPerMinute, report.medianDurationMs, report.p90DurationMs], [6.1, 9000, 13000], 'the throughput the server reported is carried');
  assert.equal(report.head, 'GY-HEAD', 'the queue head is named');
  assert.equal(report.oldestDueJobMs, 3_600_000, 'the locked and the held job are not backlog; the head\'s own job is the oldest due one');
  assert.ok(report.headObservationAgeMs! > observationFreshnessMs, 'the head has passed the freshness the merge gate demands');
  assert.equal(report.attention.length, 1);
  const [lagItem] = report.attention;
  assert.equal(lagItem.subject, 'github');
  assert.match(lagItem.text, /The merge-queue head GY-HEAD has gone 3m\d?s without an observation/);
  assert.match(lagItem.text, /the oldest due job has waited 60m0s/);
  assert.match(lagItem.text, /observing 6\.1 job\(s\)\/min \(median 9000 ms, p90 13000 ms\)/);
  assert.match(lagItem.text, /the queue stalls until its head is observed/);
  assert.equal(lagItem.role, 'control plane');
  // A fresh head, a missing budget reading and no queue at all raise nothing.
  const freshDocs = docs.map((work, index) => ({ ...work, observation: observed(work, new Date(now - 20_000).toISOString()) as Work['observation'] }));
  assert.deepEqual(observationThroughputStatus(coordinator, { ...snapshot, work: freshDocs }, now).attention, [], 'a head observed within two minutes is not lag');
  assert.deepEqual(observationThroughputStatus(coordinator, { ...snapshot, work: [], jobs: [] }, now).attention, [], 'no queue head, nothing to raise');
  assert.deepEqual(observationThroughputStatus(null, snapshot, now).attention.length, 1, 'the item is raised without a budget reading too');
  // The throughput arithmetic itself: windowed, ordered, and empty when nothing ran.
  const durations = [12_000, 4_000, 8_000, 16_000].map((ms, index) => ({ at: now - index * 60_000, ms }));
  assert.deepEqual(observationThroughput(durations, now), { windowMs: 600_000, count: 4, jobsPerMinute: 0.4, medianDurationMs: 12_000, p90DurationMs: 16_000 });
  assert.deepEqual(observationThroughput([{ at: now - 700_000, ms: 5_000 }], now), { windowMs: 600_000, count: 0, jobsPerMinute: 0, medianDurationMs: null, p90DurationMs: null }, 'durations past the window are not throughput');
});
