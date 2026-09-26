import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server/index.js';
import { CHECK_NAME, GitHub, baseRefCycleMs, billableBudgetShare, observationThroughputStatus, processJob, protectionShareMs } from '../src/github.js';
import type { Principal, Work } from '../src/model.js';

// GY-806: GitHub API use fits the rate limit. Each test is named for the proof it produces:
// unit:github-immutable-cache, unit:github-shared-cycle-reads, unit:webhook-driven-observation,
// unit:github-budget-projection.

const APP = 1234, CI = 15368, REPOSITORY = 'owner/project';
const realFetch = globalThis.fetch;
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');

/**
 * GitHub's REST surface at the fetch level, as much of it as an observation reads. Every answer is
 * a 200 that costs budget — no ETag, so nothing is ever a free 304 — which is the worst case the
 * caches have to hold the spend down in on their own.
 */
class Api {
  main = sha('main-1');
  pulls = new Map<number, { head: string; branch: string }>();
  limit = 5000; remaining = 5000; resetAt = Math.ceil(Date.now() / 1000) + 3000;
  requests: { method: string; path: string }[] = [];
  open(pr: number, branch: string) { this.pulls.set(pr, { head: sha(`head-${pr}-${this.main}`), branch }); return this.pulls.get(pr)!; }
  private body(method: string, path: string): unknown {
    if (method !== 'GET') return { id: 12 };
    const [route, query = ''] = path.replace(`/repos/${REPOSITORY}`, '').split('?'); const params = new URLSearchParams(query);
    if (route === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: this.main } };
    let match = /^\/pulls\/(\d+)$/.exec(route);
    if (match) {
      const pr = this.pulls.get(Number(match[1])) ?? { head: sha(`unknown-${match[1]}`), branch: 'graphyard/unknown' };
      return { number: Number(match[1]), state: 'open', draft: false, merged: false, mergeable: true, merge_commit_sha: null, merged_at: null, created_at: '2026-09-26T10:00:00Z', user: { login: 'implementer', id: 7 },
        head: { sha: pr.head, ref: pr.branch, repo: { full_name: REPOSITORY } }, base: { sha: this.main, ref: 'main', repo: { full_name: REPOSITORY } } };
    }
    if (/^\/pulls\/(\d+)\/reviews$/.test(route)) return [];
    match = /^\/pulls\/(\d+)\/files$/.exec(route);
    if (match) return params.get('page') !== '1' ? [] : [{ filename: 'src/feature.ts', status: 'modified', sha: sha(`blob-${match[1]}`), additions: 3, deletions: 1, patch: '@@' }];
    if (/^\/commits\/[a-f0-9]{40}\/check-runs$/.test(route)) return { check_runs: params.get('check_name') ? [] : [{ id: 1, name: 'test', status: 'in_progress', conclusion: null, app: { id: CI } }] };
    match = /^\/commits\/([a-f0-9]{40})$/.exec(route);
    if (match) return { sha: match[1], parents: [], commit: { tree: { sha: sha(`tree-${match[1]}`) }, message: 'change' }, author: { login: 'implementer' } };
    match = /^\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/.exec(route);
    if (match) {
      const ahead = match[1] === this.main && [...this.pulls.values()].some(pr => pr.head === match![2]);
      return { status: match[1] === match[2] ? 'identical' : ahead ? 'ahead' : 'diverged', ahead_by: 1, total_commits: 1, commits: [{ sha: match[2] }], files: [{ filename: 'src/feature.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }] };
    }
    if (route.endsWith('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: APP }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    if (route === '/check-runs' || /^\/check-runs\/\d+$/.test(route)) return { id: 12 };
    throw new Error(`Unexpected request ${method} ${path}`);
  }
  fetch = async (url: unknown, options: any = {}): Promise<Response> => {
    const method = options.method ?? 'GET'; const path = String(url).replace('https://api.github.com', '');
    if (!path.startsWith(`/repos/${REPOSITORY}`)) throw new Error(`Unexpected request ${method} ${path}`);
    this.requests.push({ method, path: path.replace(`/repos/${REPOSITORY}`, '') }); this.remaining--;
    return new Response(JSON.stringify(this.body(method, path)), { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-limit': String(this.limit), 'x-ratelimit-remaining': String(Math.max(0, this.remaining)), 'x-ratelimit-used': String(this.limit - this.remaining), 'x-ratelimit-reset': String(this.resetAt), 'x-ratelimit-resource': 'core' } });
  };
  client() {
    const github = new GitHub({ repository: REPOSITORY, base: 'main', appId: APP, installationId: 2, privateKey: 'not-used' });
    Object.assign(github, { token: 'fixture-token', expires: Date.now() + 3_600_000 });
    github.controlPlaneLogin = async () => 'graphyard-owner-project[bot]';
    return github;
  }
  count(pattern: RegExp) { return this.requests.filter(request => request.method === 'GET' && pattern.test(request.path)).length; }
}

/** A submitted item as the control plane holds it, for the cases that need no database. */
const item = (index: number, api: Api): Work => {
  const pr = 100 + index, key = `GY-${900 + index}`, head = api.open(pr, `graphyard/gy-${900 + index}-1`).head;
  return { id: `item-${index}`, key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['manual:budget'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'build', revision: 3, policyRevision: 1, createdAt: '2026-09-26T09:00:00Z', updatedAt: '2026-09-26T09:00:00Z',
    stageEnteredAt: '2026-09-26T09:00:00Z', ready: true, epoch: 1, lease: null, workspaces: [{ host: 'machine', path: `/w/${key}`, branch: `graphyard/gy-${900 + index}-1`, epoch: 1, owner: 'implementer' }],
    candidate: { sha: head, baseSha: api.main, pr, branch: `graphyard/gy-${900 + index}-1`, author: 'implementer' }, submission: { epoch: 1, pr }, reworkRequested: false, scenarioRequirements: [],
    evidence: [], observation: null, blocker: null, gates: [], violations: [], escalations: [], implementers: [], queueHistory: [] } as unknown as Work;
};
const immutable = /^\/(commits\/[a-f0-9]{40}|compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40})(\?(?!per_page=1$).*)?$/;

test('unit:github-immutable-cache — a commit by SHA and a compare of two exact SHAs are fetched at most once: a second observation cycle over the same SHAs makes no request for them', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client();
  const items = Array.from({ length: 3 }, (_, index) => item(index, api));
  /** One observation cycle: every item observed, and the reads a queue step makes of the same SHAs. */
  const cycle = async () => {
    for (const work of items) {
      await github.observe(work, items);
      const head = work.candidate!.sha;
      await github.commitTree(head);
      await github.changedFiles(api.main, head);
      await github.diffPatchId(api.main, head);
      await github.aheadBy(api.main, head);
      await github.historySince(api.main, head);
    }
  };
  await cycle();
  const first = api.requests.filter(request => request.method === 'GET' && immutable.test(request.path)).map(request => request.path);
  assert.ok(first.some(path => path.startsWith('/commits/')) && first.some(path => path.startsWith('/compare/')), 'the first cycle reads commits and compares');
  assert.equal(new Set(first).size, first.length, 'even within one cycle each immutable path is asked once');
  const before = api.requests.length;
  await cycle();
  const second = api.requests.slice(before);
  assert.deepEqual(second.filter(request => request.method === 'GET' && immutable.test(request.path)), [], 'the second cycle asks nothing it already has');
  assert.ok(second.some(request => /\/check-runs/.test(request.path)) && second.some(request => /^\/pulls\/\d+$/.test(request.path)), 'mutable reads are still made');

  // Concurrent first reads of one commit share a single request, and a caller cannot corrupt the cached answer.
  const fresh = sha('never-read');
  const [one, two] = await Promise.all([github.request(`/commits/${fresh}`), github.request(`/commits/${fresh}`)]);
  one.commit.tree.sha = 'mutated';
  assert.equal(two.commit.tree.sha, sha(`tree-${fresh}`));
  assert.equal((await github.request(`/commits/${fresh}`)).commit.tree.sha, sha(`tree-${fresh}`));
  assert.equal(api.count(new RegExp(`^/commits/${fresh}$`)), 1);
});

test('unit:github-shared-cycle-reads — twenty items observed in one cycle make one base-ref read and at most one protection read; a new cycle, a base push or a protection event reads again', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client();
  let now = Date.parse('2026-09-26T12:00:00Z');
  github.clock = () => now;
  // The webhook is live: its push event is what ends a cycle early when the base moves.
  github.noteWebhook('check_run', { repository: { full_name: REPOSITORY } });
  const items = Array.from({ length: 20 }, (_, index) => item(index, api));
  const refs = () => api.count(/^\/git\/ref\/heads\/main$/), protections = () => api.count(/^\/branches\/main\/protection$/);
  // Half the fleet at once, as the observation workers run, and the rest one after another.
  await Promise.all(items.slice(0, 10).map(work => github.observe(work, items)));
  for (const work of items.slice(10)) { now += 500; await github.observe(work, items); }
  assert.equal(refs(), 1, 'one ref read for the whole cycle');
  assert.ok(protections() <= 1, `at most one protection read (${protections()})`);
  assert.ok(api.count(/^\/pulls\/\d+$/) >= 20, 'every item still reads its own pull request');

  // The next cycle reads the ref again; protection is kept for five minutes.
  now += baseRefCycleMs;
  await github.observe(items[0], items);
  assert.deepEqual([refs(), protections()], [2, 1]);
  // A push to the base branch ends the cycle at once, and the observation binds the new tip.
  api.main = sha('main-2');
  github.noteWebhook('push', { ref: 'refs/heads/main', after: api.main });
  const moved = await github.observe(items[1], items);
  assert.equal(refs(), 3); assert.equal(moved.baseTip, api.main);
  // A protection event ends the protection share; so does its five minutes.
  github.noteWebhook('branch_protection_rule', { action: 'edited' });
  await github.observe(items[2], items);
  assert.equal(protections(), 2);
  now += protectionShareMs;
  await github.observe(items[3], items);
  assert.equal(protections(), 3);

  // Without a live webhook nothing would say the base moved, so each observation reads it itself.
  now += 2 * 60 * 60_000;
  const quiet = refs();
  for (const work of items.slice(0, 3)) await github.observe(work, items);
  assert.equal(refs() - quiet, 3);
});

// ---- The control plane, for the webhook-driven observation ----

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let http: ReturnType<typeof server>, origin = '';
const adminToken = 'o'.repeat(40);
let port = 0;
before(async () => {
  port = Number(process.env.GRAPHYARD_GITHUB_BUDGET_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 187);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-github-budget-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
});
after(async () => { if (http) await new Promise(resolve => http.close(resolve)); if (store) await store.close(); if (database) await database.stop(); });

async function serve(github: GitHub) {
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [CI], 120, REPOSITORY); engine.controlPlaneAppId = APP;
  engine.principals = [operator, worker];
  engine.submissionObserver = null;
  http = server(engine, [{ id: 'operator', role: 'admin', token: adminToken }], github);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
}
let prNumber = 300;
async function submitted(api: Api, title: string) {
  const pr = ++prNumber;
  let work = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['manual:budget'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/budget/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  api.open(pr, `graphyard/${work.key.toLowerCase()}-1`);
  return engine.execute(worker, 'submit', work.id, { epoch: 1, pr }, randomUUID());
}
const reload = async (work: Work) => (await store.list()).find(entry => entry.id === work.id)!;
const jobRow = async (work: Work) => (await store.pool.query('SELECT error, available_at, deferred_reason, clock_timestamp() AS now FROM jobs WHERE work_id=$1', [work.id])).rows[0] as { error: string | null; available_at: Date; deferred_reason: string | null; now: Date };
async function deliver(event: string, payload: unknown) {
  process.env.GITHUB_WEBHOOK_SECRET ??= 'webhook-secret-for-the-test';
  const raw = JSON.stringify(payload);
  const response = await realFetch(`${origin}/api/github/webhook`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': randomUUID(), 'x-hub-signature-256': `sha256=${createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET).update(raw).digest('hex')}` } });
  assert.equal(response.status, 202, 'the delivery is accepted');
}

test('unit:webhook-driven-observation — a check_run delivery re-observes its item at once, ahead of a polled job due earlier, and the poll that follows within its interval is skipped', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client(); await serve(github);
  let woken = await submitted(api, 'Named by the check run'); let polled = await submitted(api, 'Due by its poll');
  // Both are observed once; then the woken item's poll is an hour away and the other's is overdue.
  for (let index = 0; index < 2; index++) { await store.pool.query('UPDATE jobs SET available_at=now()'); await processJob(engine, github); }
  woken = await reload(woken); polled = await reload(polled);
  assert.ok(woken.observation && polled.observation, 'both items were observed');
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour' WHERE work_id=$1", [woken.id]);
  await store.pool.query("UPDATE jobs SET available_at=now()-interval '1 minute' WHERE work_id=$1", [polled.id]);
  const observedAt = { woken: woken.observation!.at, polled: polled.observation!.at };

  await deliver('check_run', { action: 'completed', repository: { full_name: REPOSITORY }, check_run: { head_sha: woken.candidate!.sha, app: { id: CI }, pull_requests: [{ number: woken.submission!.pr }] } });
  assert.deepEqual(github.webhookDue(), [woken.id], 'the delivery marked the named item due');
  await processJob(engine, github);
  woken = await reload(woken); polled = await reload(polled);
  assert.ok(Date.parse(woken.observation!.at) > Date.parse(observedAt.woken), 'the item was re-observed without waiting for its poll');
  assert.equal(polled.observation!.at, observedAt.polled, 'ahead of the polled job that was due first');
  const scheduled = await jobRow(woken);
  assert.equal(scheduled.error, null);
  const pollMs = scheduled.available_at.getTime() - scheduled.now.getTime();
  assert.ok(pollMs > 60_000, `the next poll is a full interval away (${pollMs} ms)`);
  await processJob(engine, github);
  assert.ok(Date.parse((await reload(polled)).observation!.at) > Date.parse(observedAt.polled), 'the polled job runs next');

  // The poll that follows, inside the interval the webhook-driven observation scheduled, is skipped.
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour' WHERE work_id<>$1", [woken.id]);
  await store.pool.query('UPDATE jobs SET available_at=now() WHERE work_id=$1', [woken.id]);
  const requests = api.requests.length, at = (await reload(woken)).observation!.at;
  assert.equal(await processJob(engine, github), true, 'the poll was claimed');
  assert.equal(api.requests.length, requests, 'and asked GitHub nothing');
  assert.equal((await reload(woken)).observation!.at, at, 'the item was not re-observed');
  const skipped = await jobRow(woken);
  assert.match(skipped.deferred_reason ?? '', /poll skipped: a webhook refreshed this item/);
  assert.ok(skipped.available_at.getTime() - skipped.now.getTime() > 30_000, 'the job is due again when the interval ends');
});

/**
 * The 2026-09-26 workload: in a 191 s sample the top calls were GET /pulls/:n 96,
 * /commits/:sha 61, /compare/:range 57, /commits/:sha/check-runs 51, /git/ref/heads/main 47 and
 * /branches/main/protection 25, at about 5,400 billable requests an hour against a 5,000/h token.
 */
const recorded = { pulls: 96, commits: 61, compare: 57, checkRuns: 51, ref: 47, protection: 25 } as const;
const recordedPerHour = 5_400;

test('unit:github-budget-projection — replaying the recorded 2026-09-26 request mix stays under 60% of one token\'s hourly limit, and master status reports billable requests per hour against the budget by endpoint', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client();
  const start = Date.parse('2026-09-26T12:00:00Z'); let now = start;
  github.clock = () => now;
  github.noteWebhook('push', { ref: 'refs/heads/main' });
  // The fleet: twenty open pull requests; each is pushed to once in the hour, and the base branch
  // advances every ten minutes, each advance delivered as a push webhook.
  const fleet = Array.from({ length: 20 }, (_, index) => ({ pr: 500 + index, head: sha(`fleet-${index}-0`) }));
  const hour = 3_600_000, total = Object.values(recorded).reduce((sum, count) => sum + count, 0);
  // The recorded mix at the recorded rate, each call at its own even spacing through the hour.
  const calls = (Object.entries(recorded) as [keyof typeof recorded, number][]).flatMap(([endpoint, count]) => {
    const perHour = Math.round(recordedPerHour * count / total);
    return Array.from({ length: perHour }, (_, index) => ({ endpoint, at: start + Math.floor((index + 0.5) * hour / perHour), index }));
  });
  const events = [
    ...Array.from({ length: 5 }, (_, index) => ({ at: start + (index + 1) * 10 * 60_000, apply: () => { api.main = sha(`main-${index + 2}`); github.noteWebhook('push', { ref: 'refs/heads/main' }); } })),
    ...fleet.map((entry, index) => ({ at: start + index * 3 * 60_000 + 90_000, apply: () => { entry.head = sha(`fleet-${index}-1`); } })),
  ].sort((a, b) => a.at - b.at);
  calls.sort((a, b) => a.at - b.at || a.endpoint.localeCompare(b.endpoint));
  for (const call of calls) {
    while (events.length && events[0].at <= call.at) events.shift()!.apply();
    now = call.at;
    const entry = fleet[call.index % fleet.length];
    if (call.endpoint === 'pulls') await github.request(`/pulls/${entry.pr}`);
    else if (call.endpoint === 'checkRuns') await github.request(`/commits/${entry.head}/check-runs?filter=all&per_page=100&page=1`);
    else if (call.endpoint === 'commits') await github.commitTree(call.index % 2 ? entry.head : api.main);
    else if (call.endpoint === 'compare') await github.request(`/compare/${api.main}...${entry.head}`);
    else if (call.endpoint === 'ref') await github.baseBranch();
    else await github.branchProtection();
  }
  const replayed = calls.length, billed = api.requests.length;
  assert.ok(replayed >= recordedPerHour - 3 && replayed > api.limit, `the replay is the recorded hour: ${replayed} calls, over the ${api.limit}/h limit uncached`);
  assert.ok(billed < billableBudgetShare * api.limit, `the replay bills ${billed} requests, under ${billableBudgetShare * 100}% of ${api.limit}`);
  // Mutable reads are still made every time; what fell away is the immutable and shared reads.
  assert.equal(api.count(/^\/pulls\/\d+$/), calls.filter(call => call.endpoint === 'pulls').length);
  assert.ok(api.count(/^\/git\/ref\/heads\/main$/) <= Math.ceil(hour / baseRefCycleMs) + 6, 'one ref read per cycle, plus one per base push');
  assert.ok(api.count(/^\/branches\/main\/protection$/) <= Math.ceil(hour / protectionShareMs), 'protection at most every five minutes');

  // The budget as master status reports it: billable requests in the last hour, against the limit, by endpoint.
  const budget = github.budget();
  assert.equal(budget.billable.perHour, billed);
  assert.equal(budget.billable.limit, api.limit);
  assert.ok(budget.billable.share < billableBudgetShare && Math.abs(budget.billable.share - billed / api.limit) < 0.001);
  assert.equal(budget.billable.target, billableBudgetShare);
  assert.equal(budget.billable.byEndpoint.reduce((sum, entry) => sum + entry.requests, 0), billed);
  const endpoints = Object.fromEntries(budget.billable.byEndpoint.map(entry => [entry.endpoint, entry.requests]));
  assert.equal(endpoints['GET /pulls/:n'], api.count(/^\/pulls\/\d+$/));
  assert.equal(endpoints['GET /git/ref/heads/:branch'], api.count(/^\/git\/ref\/heads\/main$/));
  assert.equal(endpoints['GET /branches/:branch/protection'], api.count(/^\/branches\/main\/protection$/));
  assert.equal(endpoints['GET /compare/:range'], api.count(/^\/compare\//));
  assert.equal(endpoints['GET /commits/:sha'], api.count(/^\/commits\/[a-f0-9]{40}$/));
  const reported = observationThroughputStatus({ githubBudget: budget }, { work: [], now: new Date().toISOString() });
  assert.deepEqual(reported.budget?.billable, budget.billable, 'master status carries the billable report');
});
