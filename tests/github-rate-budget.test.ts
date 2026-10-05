import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server/index.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CHECK_NAME, GitHub, comparePage, mergePathReserve, observationBand, observationCadence, observationCadenceMs, processJob, reserveDecision, steadyStateInterval, steadyStateShare } from '../src/github.js';
import { evaluate, type Principal, type Work } from '../src/model.js';
import { exhaustionAttention, githubBudgetAttention, pauseAttention, webhookAttention } from '../src/cli/github-budget-attention.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { baseChangeFiles, baseMoveWakes } from '../src/observation-priority.js';
import { simulateObservationScheduler } from '../src/observation-simulation.js';
import { baseMoveSubjects, webhookSubjects } from '../src/server/routes/github.js';

// GY-117. Each test is named for the proof it produces: unit:github-budget-tracked,
// integration:observation-cadence-by-state, integration:merge-path-reserve-held,
// unit:unchanged-candidate-observation-cost, integration:rate-limit-pause-single-incident,
// manual:github-budget-docs-review, unit:steady-state-spend-bounded,
// integration:webhook-liveness-visible.
// GY-1231: unit:base-move-wakes-only-affected-items, unit:merge-burst-request-budget.
// GY-1272: manual:fault-class-resources (the GitHub App budget spent at 06:36:13Z on 5 October 2026).

// ---- GitHub's REST surface at the fetch level: ETags, rate-limit headers, and a refusal mode ----

const APP = 1234, CI = 15368, REPOSITORY = 'owner/project';
/** The real fetch, for the control plane's own HTTP surface while the provider is mocked. */
const realFetch = globalThis.fetch;
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const etagOf = (body: string) => `"${createHash('sha1').update(body).digest('hex')}"`;

/**
 * The provider as the client sees it. Every GET answers with an ETag and honours If-None-Match
 * with a 304 that costs nothing, exactly as GitHub does; every charged request decrements the
 * budget it reports in the headers. `refuse` turns every request into the 403 GitHub answers
 * with once the budget is gone.
 */
class Api {
  main = sha('main-1');
  pulls = new Map<number, { head: string; cut?: string; branch: string; approved: boolean; checks: 'success' | 'in_progress' }>();
  /** The files a pull request changes, where a scenario names them (GY-1231); every other one changes one route file. */
  files = new Map<number, string[]>();
  /** GitHub's `mergeable_state` of a pull request, where a scenario names it (GY-1231); every other one is clean. */
  states = new Map<number, string>();
  limit = 5000; remaining = 5000; resetAt = Math.ceil(Date.now() / 1000) + 3000;
  refuse = false;
  requests: { method: string; path: string; status: number }[] = [];
  open(pr: number, branch: string, options: { approved?: boolean; checks?: 'success' | 'in_progress' } = {}) {
    this.pulls.set(pr, { head: sha(`head-${pr}-${this.main}`), cut: this.main, branch, approved: options.approved ?? true, checks: options.checks ?? 'success' });
    return this.pulls.get(pr)!;
  }
  /**
   * The base tips main has moved past, oldest first, where a scenario moves main along one line
   * (GY-1272): a head then contains every tip up to the one it was cut from, and main contains them all.
   */
  history: string[] = [];
  /** The candidate contains the base tip when its head was cut from it; two heads never contain each other. */
  private contains(base: string, head: string) {
    if (base === head) return true;
    if (!this.history.length) return base === this.main && [...this.pulls.values()].some(pr => pr.head === head);
    const line = [...this.history, this.main], cut = head === this.main ? this.main : [...this.pulls.values()].find(pr => pr.head === head)?.cut;
    return cut !== undefined && line.includes(base) && line.indexOf(base) <= line.indexOf(cut);
  }
  private body(method: string, path: string): unknown {
    if (method !== 'GET') return { id: 12 };
    const [route, query = ''] = path.replace(`/repos/${REPOSITORY}`, '').split('?'); const params = new URLSearchParams(query);
    if (route === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: this.main } };
    let match = /^\/pulls\/(\d+)$/.exec(route);
    if (match) {
      const pr = this.pulls.get(Number(match[1]))!;
      return { number: Number(match[1]), state: 'open', draft: false, merged: false, mergeable: true, mergeable_state: this.states.get(Number(match[1])) ?? 'clean', merge_commit_sha: null, merged_at: null, created_at: '2026-09-21T10:00:00Z', user: { login: 'implementer', id: 7 },
        head: { sha: pr.head, ref: pr.branch, repo: { full_name: REPOSITORY } }, base: { sha: this.main, ref: 'main', repo: { full_name: REPOSITORY } } };
    }
    match = /^\/pulls\/(\d+)\/reviews$/.exec(route);
    if (match) return params.get('page') !== '1' ? [] : this.pulls.get(Number(match[1]))!.approved ? [{ id: 40 + Number(match[1]), user: { login: 'independent-reviewer' }, commit_id: this.pulls.get(Number(match[1]))!.head, state: 'APPROVED', submitted_at: '2026-09-21T10:05:00Z' }] : [];
    match = /^\/pulls\/(\d+)\/files$/.exec(route);
    // GY-883: a public API path keeps the item in the high lane, whose full path still demands the proof the cadence bands presuppose.
    if (match) return params.get('page') !== '1' ? [] : (this.files.get(Number(match[1])) ?? ['src/server/routes/feature.ts']).map(filename => ({ filename, status: 'modified', sha: sha(`blob-${match![1]}-${filename}`), additions: 3, deletions: 1, patch: '@@' }));
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
    if (route.endsWith('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: APP }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    throw new Error(`Unexpected request ${method} ${path}`);
  }
  private headers(extra: Record<string, string> = {}) {
    return { 'x-ratelimit-limit': String(this.limit), 'x-ratelimit-remaining': String(Math.max(0, this.remaining)), 'x-ratelimit-used': String(this.limit - this.remaining), 'x-ratelimit-reset': String(this.resetAt), 'x-ratelimit-resource': 'core', ...extra };
  }
  fetch = async (url: unknown, options: any = {}): Promise<Response> => {
    const method = options.method ?? 'GET'; const path = String(url).replace('https://api.github.com', '');
    if (this.refuse) { this.requests.push({ method, path, status: 403 }); return new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: this.headers({ 'x-ratelimit-remaining': '0' }) }); }
    // A queue tip for a head cut from the base tip is the head itself: the merge is a no-op (204) and the ref is written.
    if (method === 'POST' && path.endsWith('/merges')) { this.remaining--; this.requests.push({ method, path, status: 204 }); return new Response(null, { status: 204, headers: this.headers() }); }
    const text = JSON.stringify(this.body(method, path)); const etag = etagOf(`${path}:${text}`);
    if (method === 'GET' && options.headers?.['If-None-Match'] === etag) { this.requests.push({ method, path, status: 304 }); return new Response(null, { status: 304, headers: this.headers({ etag }) }); }
    this.remaining--; this.requests.push({ method, path, status: 200 });
    return new Response(text, { status: 200, headers: this.headers({ etag, 'content-type': 'application/json' }) });
  };
  /** A client already authenticated against this provider, with its check publication kept in the provider too. */
  client() {
    const github = new GitHub({ repository: REPOSITORY, base: 'main', appId: APP, installationId: 2, privateKey: 'not-used' });
    Object.assign(github, { token: 'fixture-token', expires: Date.now() + 3_600_000 });
    github.controlPlaneLogin = async () => 'graphyard-owner-project[bot]';
    return github;
  }
  charged = () => this.requests.filter(request => request.status === 200 || request.status === 204).length;
}

// ---- Hand-built work items, for the unit cases that need no database ----

const item = (key: string, pr: number, head: string, baseSha: string, overrides: Partial<Work> = {}): Work => ({
  id: key.toLowerCase(), key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['manual:budget'] }],
  policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/'], stage: 'build', revision: 3, policyRevision: 1, createdAt: '2026-09-21T09:00:00Z', updatedAt: '2026-09-21T09:00:00Z',
  stageEnteredAt: '2026-09-21T09:00:00Z', ready: true, epoch: 1, lease: null, workspaces: [{ host: 'machine', path: `/w/${key}`, branch: `graphyard/${key.toLowerCase()}-1`, epoch: 1, owner: 'implementer' }],
  candidate: { sha: head, baseSha, pr, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' }, submission: { epoch: 1, pr }, reworkRequested: false, scenarioRequirements: [],
  evidence: [], observation: null, blocker: null, gates: [], violations: [], escalations: [], implementers: [], ...overrides } as unknown as Work);
/** The item as the control plane would hold it after this observation: gates and stage re-evaluated. */
const evaluated = (work: Work, all: Work[], observation: Work['observation']) => {
  const next = { ...work, observation };
  return { ...next, ...evaluate(next, all.map(entry => entry.id === work.id ? next : entry), new Date(), [CI]) } as Work;
};

test('unit:github-budget-tracked — the budget is read from every response, the spend rate over the last ten minutes projects the exhaustion, and master status names that time when it lands before the reset', async t => {
  const api = new Api(); api.open(1, 'graphyard/gy-a-1');
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client();
  // A budget going down: 100 requests remain, and every uncached read takes one.
  // The reset is a minute past the projected exhaustion: at exactly forty minutes, the time the
  // twenty reads take moved the projection past a reset read at whole-second precision (a flake).
  api.limit = 5000; api.remaining = 100; api.resetAt = Math.ceil(Date.now() / 1000) + 2460;
  for (let index = 0; index < 20; index++) await github.request(`/compare/${sha(`x${index}`)}...${sha(`y${index}`)}?per_page=1`);
  const budget = github.budget();
  assert.deepEqual([budget.limit, budget.remaining, budget.used], [5000, 80, 4920], 'the last response is the reading');
  assert.equal(budget.resetAt, new Date(api.resetAt * 1000).toISOString());
  assert.equal(budget.spentInWindow, 20); assert.equal(budget.perMinute, 2, 'twenty charged requests over a ten-minute window');
  const projected = Date.parse(budget.projectedExhaustionAt!);
  assert.ok(Math.abs(projected - (Date.now() + 40 * 60_000)) < 5_000, `80 remaining at 2/min is exhausted in 40 minutes, not ${budget.projectedExhaustionAt}`);
  assert.equal(budget.exhaustsBeforeReset, true, 'forty minutes is before the reset in forty-one');
  assert.deepEqual(budget.lastHour, { requests: 20, byKind: [{ kind: 'compare', requests: 20 }] });
  const attention = exhaustionAttention({ githubBudget: budget });
  assert.equal(attention.length, 1);
  assert.match(attention[0].text, new RegExp(`exhausted at ${budget.projectedExhaustionAt!.replace(/[.]/g, '[.]')}, before it resets at ${budget.resetAt!.replace(/[.]/g, '[.]')}`));
  assert.equal(attention[0].subject, 'github'); assert.equal(attention[0].role, 'master');
  // A conditional read GitHub answers with 304 is a request made, never budget spent.
  const { requests, uncached } = await github.measured(() => github.request(`/compare/${sha('x0')}...${sha('y0')}?per_page=1`));
  assert.deepEqual([requests, uncached, github.budget().spentInWindow], [1, 0, 20]);
  // Descending readings with the reset far away: the rate does not reach zero first, so nothing is raised.
  api.resetAt = Math.ceil(Date.now() / 1000) + 60; api.remaining = 4000;
  await github.request(`/compare/${sha('p')}...${sha('q')}?per_page=1`);
  assert.equal(github.budget().exhaustsBeforeReset, false); assert.deepEqual(exhaustionAttention({ githubBudget: github.budget() }), []);
});

test('unit:unchanged-candidate-observation-cost — observing the same unchanged candidate twice costs no uncached request the second time, and the mean cost per observation is reported', async t => {
  const api = new Api(); const pr = api.open(7, 'graphyard/gy-c-1');
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client();
  const work = item('GY-C', 7, pr.head, api.main);
  const first = await github.measured(() => github.observe(work, [work]));
  assert.ok(first.requests >= 8 && first.uncached >= first.requests - 1, `a first observation is uncached reads, bar the confirming re-read of the pull request (${first.requests}, ${first.uncached})`);
  github.recordObservation(work.id, { ...first, band: 'active', cadenceMs: observationCadenceMs.active });
  const observed = evaluated(work, [work], first.value);
  const second = await github.measured(() => github.observe(observed, [observed]));
  assert.ok(second.requests <= first.requests, `no more reads are made (${second.requests} of ${first.requests})`);
  assert.ok(second.uncached <= 2, `an unchanged candidate costs at most two uncached requests; it cost ${second.uncached}`);
  assert.equal(api.charged(), first.uncached, 'GitHub charged nothing for the second observation');
  github.recordObservation(work.id, { ...second, band: 'steady', cadenceMs: observationCadenceMs.steady });
  const budget = github.budget();
  assert.equal(budget.observations.count, 2);
  assert.equal(budget.observations.meanRequests, Math.round((first.requests + second.requests) / 2 * 100) / 100);
  assert.equal(budget.observations.meanUncached, Math.round((first.uncached + second.uncached) / 2 * 100) / 100);
  assert.deepEqual(budget.observations.jobs.map(job => [job.work, job.requests, job.uncached, job.band]), [[work.id, second.requests, second.uncached, 'steady']], 'the cost is recorded against the job that made it');
  // A moved head is a changed candidate and is read afresh.
  api.pulls.get(7)!.head = sha('head-7-pushed');
  const third = await github.measured(() => github.observe(observed, [observed]));
  assert.ok(third.uncached > 2, 'a push is paid for');
});

test('unit:steady-state-spend-bounded — twenty unchanged candidates polled for one simulated hour spend under the steady-state share of the hourly limit, and none is polled more often than every two minutes', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client();
  // Ten await review; ten were approved and sent back for rework, whose next action is a worker's dispatch.
  const candidates = Array.from({ length: 20 }, (_, index) => { const pr = api.open(100 + index, `graphyard/gy-${index}-1`, { approved: index >= 10 }); return item(`GY-${index}`, 100 + index, pr.head, api.main, { reworkRequested: index >= 10 }); });
  // The premise: every candidate has been observed once already and nothing has changed since.
  let all: Work[] = [];
  for (const candidate of candidates) all.push(evaluated(candidate, candidates, await github.observe(candidate, candidates)));
  // Observed once more with every peer observed, since the landing check reads each open peer.
  for (const candidate of [...all]) { const observation = await github.observe(candidate, all); all = all.map(entry => entry.id === candidate.id ? evaluated(candidate, all, observation) : entry); }
  assert.deepEqual(all.map(candidate => observationBand(candidate, all, new Date()).band),
    [...Array(10).fill('active'), ...Array(10).fill('idle')],
    'the fleet includes candidates waiting on GitHub and unchanged candidates whose next action is a dispatch');
  github.noteFleet(all.length);
  const limit = api.limit;
  api.requests = [];
  // One simulated hour on the schedule the control plane uses: each candidate is observed when
  // its cadence says so, and the cadence after an unchanged observation is the steady one,
  // bounded by the fleet. Real observations against the provider count every request made.
  const hour = 3600_000; let clock = 0;
  const due = new Map(all.map(candidate => [candidate.id, 0]));
  const intervals: number[] = [];
  while (true) {
    const next = Math.min(...due.values()); if (next >= hour) break; clock = next;
    for (const candidate of all) {
      if (due.get(candidate.id) !== clock) continue;
      const measured = await github.measured(() => github.observe(candidate, all));
      const observed = evaluated(candidate, all, measured.value);
      all = all.map(entry => entry.id === candidate.id ? observed : entry);
      const cadence = observationCadence(observed, all, new Date(), candidate.observation, github.steadyStateMs());
      github.recordObservation(candidate.id, { requests: measured.requests, uncached: measured.uncached, band: cadence.band, cadenceMs: cadence.ms });
      assert.equal(cadence.band, Number(candidate.key.slice(3)) < 10 ? 'steady' : 'idle', `${candidate.key} came back unchanged in its state-derived band`);
      intervals.push(cadence.ms); due.set(candidate.id, clock + cadence.ms);
    }
  }
  const total = api.requests.length, charged = api.charged();
  if (process.env.GRAPHYARD_BUDGET_DEBUG) console.log('steady-state hour', { total, charged, observations: intervals.length, intervals: [...new Set(intervals)], meanRequests: github.budget().observations.meanRequests });
  assert.ok(intervals.every(ms => ms >= 120_000), `every steady-state interval is at least two minutes (${Math.min(...intervals)})`);
  assert.ok(github.budget().observations.jobs.filter(job => job.band === 'idle').every(job => job.cadenceMs >= Math.max(300_000, github.steadyStateMs())),
    'unchanged idle candidates keep their five-minute floor and are stretched by the fleet bound');
  assert.ok(total < limit * steadyStateShare, `${total} requests in the simulated hour exceed the ${steadyStateShare * 100}% share (${limit * steadyStateShare}) of the hourly limit`);
  assert.equal(charged, 0, 'and none of them was charged: every read was a conditional read GitHub answered from its ETag');
  const budget = github.budget();
  assert.deepEqual([budget.steadyStateShare, budget.steadyStateBudget, budget.steadyState.openCandidates], [0.4, 2000, 20]);
  assert.equal(budget.steadyState.intervalMs, steadyStateInterval(20, budget.observations.meanRequests, limit));
  assert.ok(budget.cadence.steady <= budget.steadyState.intervalMs);
  // The bound itself: a bigger fleet or a costlier observation stretches the interval, never below the floor.
  assert.equal(steadyStateInterval(1, 10, 5000), 120_000, 'one cheap candidate polls at the floor');
  assert.equal(steadyStateInterval(20, 10, 5000), 400_000, 'twenty candidates at ten requests: a round of 200, four more rounds fit under 2000');
  assert.equal(steadyStateInterval(200, 10, 5000), 3600_000, 'a fleet whose one round is the whole share polls once an hour');
});

test('manual:github-budget-docs-review — the operations reference states the request budget, the schedule by state, the merge-path reserve, what a pause means for gates, and how an operator reads the budget', async () => {
  const reference = await readFile(new URL('../docs/operations-reference.md', import.meta.url), 'utf8');
  assert.match(reference, /^## GitHub request budget$/m);
  for (const heading of ['### The live budget', '### Observation cadence by state', '### The merge-path reserve', '### What an observation costs', '### What a pause means for gates', '### Reading the budget', '### Webhook liveness']) assert.ok(reference.includes(heading), `the reference keeps ${heading}`);
  assert.match(reference, /x-ratelimit-remaining/); assert.match(reference, /projectedExhaustionAt/);
  for (const band of ['merge', 'active', 'steady', 'idle']) assert.match(reference, new RegExp(`^\\| \`${band}\` \\|`, 'm'), `the schedule table has a ${band} row`);
  assert.match(reference, /\*\*500 requests\*\* by default, `GRAPHYARD_GITHUB_RESERVE`/);
  assert.match(reference, /\*\*at most 40%\*\* \(`steadyStateShare`\)/);
  assert.match(reference, /gates read the last observation until it lifts/);
  assert.doesNotMatch(reference, /observation over two minutes old/, 'no gate refuses on observation age (GY-1235)');
  assert.match(reference, /`graphyard status` \(or `GET \/api\/status`\) → `githubBudget`/);
  assert.match(reference, /settings\/apps\/APP-SLUG/);
  const operations = await readFile(new URL('../docs/operations.md', import.meta.url), 'utf8');
  assert.match(operations, /operations-reference\.md#github-request-budget/);
  assert.equal(mergePathReserve, 500, 'the documented default is the code\'s default');
});

// ---- The control plane on a real database, the real adapter on the provider ----

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:budget'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let http: ReturnType<typeof server>, origin = '';
const adminToken = 'o'.repeat(40);
let port = 0, databases = 0;
before(async () => {
  port = Number(process.env.GRAPHYARD_RATE_BUDGET_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 117);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('rate-budget'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start();
});
after(async () => { if (http) await new Promise(resolve => http.close(resolve)); if (store) await store.close(); if (database) await database.stop(); });

/**
 * A fresh control plane for each scenario — its own database, engine and HTTP surface bound to
 * one provider client — so a queue one scenario leaves behind never orders the next.
 */
async function serve(github: GitHub) {
  if (http) await new Promise(resolve => http.close(resolve));
  if (store) await store.close();
  const name = `graphyard_test_${++databases}`;
  await database.createDatabase(name);
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/${name}`); await store.init();
  engine = new Engine(store, [CI], 120, REPOSITORY); engine.controlPlaneAppId = APP;
  engine.principals = [operator, worker, producer];
  engine.submissionObserver = null;
  http = server(engine, [{ id: 'operator', role: 'admin', token: adminToken }], github);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
}
const status = async () => (await realFetch(`${origin}/api/status`, { headers: { Authorization: `Bearer ${adminToken}` } })).json();
/**
 * One signed webhook delivery, as GitHub sends it. A delivery wakes only the pull request it
 * names; one naming none is a push to the base branch, which wakes every job.
 */
async function webhook(work?: Work, commits?: { added: string[]; removed: string[]; modified: string[] }[]) {
  process.env.GITHUB_WEBHOOK_SECRET ??= 'webhook-secret-for-the-test';
  const raw = JSON.stringify(work ? { action: 'synchronize', repository: { full_name: REPOSITORY }, pull_request: { number: work.submission!.pr } }
    : { repository: { full_name: REPOSITORY }, ref: 'refs/heads/main', after: sha(`push-${randomUUID()}`), ...(commits ? { commits } : {}) });
  const response = await realFetch(`${origin}/api/github/webhook`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': `sha256=${createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET).update(raw).digest('hex')}` } });
  assert.equal(response.status, 202, 'the delivery is accepted');
}

const reload = async (work: Work) => (await store.list()).find(entry => entry.id === work.id)!;
let prNumber = 200;
async function submitted(api: Api, title: string, options: { approved?: boolean; checks?: 'success' | 'in_progress'; proofs?: string[] } = {}) {
  const pr = ++prNumber;
  let work = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: options.proofs ?? ['unit:budget'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/budget/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  api.open(pr, `graphyard/${work.key.toLowerCase()}-1`, { approved: options.approved, checks: options.checks });
  return engine.execute(worker, 'submit', work.id, { epoch: 1, pr }, randomUUID());
}
/** Make exactly this item's job the next due one; every other job waits an hour. */
async function due(work: Work) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('INSERT INTO jobs(work_id) VALUES($1) ON CONFLICT (work_id) DO NOTHING', [work.id]);
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL,attempts=0,error=NULL WHERE work_id=$1', [work.id]);
}
/** One reconciliation job for exactly this item, as the control plane runs it. */
async function job(work: Work, github: GitHub) {
  await due(work);
  await processJob(engine, github);
  assert.equal((await jobRow(work)).error, null, 'the reconciliation job ran clean');
  return reload(work);
}
const jobRow = async (work: Work) => (await store.pool.query('SELECT error, available_at, clock_timestamp() AS now FROM jobs WHERE work_id=$1', [work.id])).rows[0] as { error: string | null; available_at: Date; now: Date };
const scheduledInMs = async (work: Work) => { const row = await jobRow(work); return row.available_at.getTime() - row.now.getTime(); };
const prove = async (work: Work) => engine.execute(producer, 'evidence', work.id, { proof: 'unit:budget', sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, randomUUID());

test('integration:observation-cadence-by-state — a merge-gate candidate is observed every 20 seconds, an item whose next action is a dispatch no more often than every five minutes, everything else between, from the item state alone; and a webhook wake observes the slow one at once', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client(); await serve(github);
  // Three items in three states: approved and green (merge gate: GitHub's to merge, GY-1235), sent
  // back for rework (the next action is a worker's dispatch, which nothing on GitHub can move), and
  // awaiting review (GitHub can still deliver it).
  let merging = await submitted(api, 'At the merge gate'); merging = await job(merging, github); merging = await job(merging, github);
  const mergeMs = await scheduledInMs(merging);
  let idle = await submitted(api, 'Sent back for rework');
  idle = await engine.execute(operator, 'rework', idle.id, { reason: 'Address a review finding', previousWorkerStopped: true }, randomUUID());
  idle = await job(idle, github);
  const idleMs = await scheduledInMs(idle);
  let active = await submitted(api, 'Awaiting review', { approved: false, proofs: ['manual:budget'] }); active = await job(active, github);
  const activeMs = await scheduledInMs(active);
  const all = await store.list(); const now = new Date();
  assert.equal(merging.stage, 'merge'); assert.ok(merging.gates.every(gate => gate.name === 'merge' || gate.passed));
  assert.deepEqual([observationBand(merging, all, now).band, observationBand(idle, all, now).band, observationBand(active, all, now).band], ['merge', 'idle', 'active']);
  assert.equal(idle.nextAction?.kind, 'dispatch'); assert.equal(active.nextAction?.kind, 'request-review');
  // The schedule each earned, as the job table held it right after its observation.
  assert.ok(mergeMs <= 20_000 && mergeMs > 15_000, `merge-gate candidate observed again within 20s (${mergeMs})`);
  assert.ok(idleMs >= 295_000 && idleMs <= 300_000, `a dispatch-bound item waits five minutes (${idleMs})`);
  assert.ok(activeMs > 20_000 && activeMs <= 300_000, `everything else waits for the five-minute backstop a webhook naming it cuts short (${activeMs})`);
  assert.deepEqual(github.budget().cadence, { merge: 20_000, active: 60_000, steady: 120_000, idle: 300_000 });
  for (const [work, band] of [[merging, 'merge'], [idle, 'idle'], [active, 'active']] as const) assert.equal(github.budget().observations.jobs.find(entry => entry.work === work.id)?.band, band);
  // An unchanged active candidate settles to the steady-state interval; a change puts it back.
  active = await job(active, github);
  assert.equal(github.budget().observations.jobs.find(entry => entry.work === active.id)?.band, 'steady');
  assert.ok(await scheduledInMs(active) >= 120_000 - 1000);
  api.pulls.get(active.submission!.pr)!.approved = true;
  active = await job(active, github);
  assert.equal(github.budget().observations.jobs.find(entry => entry.work === active.id)?.band, 'merge', 'approved: every gate passes and GitHub may merge it, so it joins the merge band');
  // A webhook wake observes the slow-cadence item immediately, whatever its schedule said.
  const before = idle.observation!.at;
  await webhook(idle);
  const woken = (await store.pool.query('SELECT work_id FROM jobs WHERE available_at<=now()')).rows.map(row => row.work_id);
  assert.ok(woken.includes(idle.id), 'the delivery made the idle job due');
  for (let index = 0; index < woken.length; index++) await processJob(engine, github);
  idle = await reload(idle);
  assert.ok(Date.parse(idle.observation!.at) > Date.parse(before), 'the idle item was observed on the wake');
  assert.ok(await scheduledInMs(idle) >= 295_000, 'and returns to its five-minute cadence');
});

test('integration:merge-path-reserve-held — below the reserve a merge-gate candidate is still observed, a build-stage candidate is deferred past the reset with a reason naming the reserve, a webhook wake is still served, and once the reset has passed the deferred candidate is observed without one', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client(); await serve(github);
  let merging = await submitted(api, 'Landing under a low budget'); merging = await job(merging, github); merging = await prove(merging); merging = await job(merging, github); merging = await job(merging, github);
  assert.equal(merging.stage, 'merge');
  // Awaiting review: a candidate GitHub cannot merge yet, so it never joins the merge path.
  let building = await submitted(api, 'Just submitted under a low budget', { approved: false });
  assert.equal(building.stage, 'build'); assert.equal(building.observation, null);
  // The budget falls below the reserve; the next response says so, and the client reads it.
  api.remaining = 120; api.resetAt = Math.ceil(Date.now() / 1000) + 1800;
  const observedBefore = merging.observation!.at;
  merging = await job(merging, github);
  assert.ok(Date.parse(merging.observation!.at) > Date.parse(observedBefore), 'the merge-gate candidate is observed');
  const budget = github.budget();
  assert.ok(budget.remaining! < mergePathReserve && budget.belowReserve, `the client read the budget below the reserve (${budget.remaining})`);
  assert.equal(reserveDecision('merge', budget, false, new Date()), null, 'a merge-gate candidate never yields');
  building = await job(building, github);
  assert.equal(building.observation, null, 'the build-stage candidate was not observed');
  const deferral = github.budget().deferrals.find(entry => entry.work === building.id)!;
  assert.ok(deferral, 'the deferral is recorded against the item');
  assert.match(deferral.reason, new RegExp(`below the ${mergePathReserve}-request merge-path reserve \\(\\d+ remaining, reset ${budget.resetAt!.replace(/[.]/g, '[.]')}\\)`));
  assert.match(deferral.reason, /rescheduled to .* rather than spent, so the merge path, webhook wakes and merge verification keep the reserve/);
  const row = await jobRow(building);
  assert.equal(row.error, null, 'a deferral is a decision, not a failure');
  assert.ok(row.available_at.getTime() >= api.resetAt * 1000, 'the job is rescheduled past the reset');
  assert.equal(deferral.until, new Date(api.resetAt * 1000 + 2000).toISOString());
  // Merge-gate observation keeps going below the reserve, and verification reads the exact head.
  merging = await job(merging, github);
  assert.ok(github.budget().remaining! < mergePathReserve);
  const verification = await github.verify(merging, await store.list());
  assert.equal(verification.candidate.sha, merging.candidate!.sha, 'merge verification is answered below the reserve');
  // A webhook wake is served whatever is left: the deferred candidate is observed on the delivery.
  await webhook(building);
  const woken = (await store.pool.query('SELECT work_id FROM jobs WHERE available_at<=now()')).rows.map(row => row.work_id);
  assert.ok(woken.includes(building.id), 'the delivery lifted the deferral');
  for (let index = 0; index < woken.length; index++) await processJob(engine, github);
  building = await reload(building);
  assert.ok(building.observation, 'the woken build-stage candidate was observed below the reserve');
  assert.equal(github.budget().deferrals.find(entry => entry.work === building.id), undefined, 'and its deferral is cleared');
  assert.deepEqual((await status()).githubBudget.reserve, mergePathReserve, '/api/status reports the reserve');
  // The reserve is decided only against a count still in force: a reading whose reset has passed,
  // or that reports none, is unknown and never defers, because only a spent request refreshes it.
  assert.equal(reserveDecision('active', { ...budget, resetAt: new Date(Date.now() - 1000).toISOString() }, false, new Date()), null, 'a reading past its reset never defers');
  assert.equal(reserveDecision('active', { ...budget, resetAt: null }, false, new Date()), null, 'a reading without a reset never defers');
  // The woken observation read the budget still below the reserve, so the next scheduled one is deferred again.
  building = await job(building, github);
  assert.equal(github.budget().deferrals.find(entry => entry.work === building.id)?.until, new Date(api.resetAt * 1000 + 2000).toISOString(), 'the build-stage candidate is deferred past the reset again');
  const deferredAt = building.observation!.at; const chargedBeforeReset = api.charged(); const expiredReset = budget.resetAt!;
  // The clock passes the reset with no delivery. GitHub has replenished the budget, which only a
  // spent request can read: the reading from before the reset is unknown now, not below the reserve.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.setTime(api.resetAt * 1000 + 3000);
  api.remaining = api.limit; api.resetAt = Math.ceil(Date.now() / 1000) + 3600;
  const expired = github.budget();
  assert.equal(expired.remaining, null, 'the count from before the reset is not reported as what is left');
  assert.equal(expired.belowReserve, false); assert.equal(expired.resetAt, null); assert.equal(expired.exhaustsBeforeReset, false);
  assert.equal(expired.expiredResetAt, expiredReset, 'the reading that expired names its reset');
  assert.equal(reserveDecision('active', expired, false, new Date()), null, 'an expired reading never defers');
  building = await job(building, github);
  assert.ok(Date.parse(building.observation!.at) > Date.parse(deferredAt), 'the deferred build-stage candidate is observed once the reset has passed, with no webhook');
  assert.ok(api.charged() > chargedBeforeReset, 'the observation was spent, which is what reads the fresh headers');
  const refreshed = github.budget();
  assert.equal(refreshed.expiredResetAt, null); assert.equal(refreshed.resetAt, new Date(api.resetAt * 1000).toISOString(), 'the fresh reset is read from the response');
  assert.equal(refreshed.belowReserve, false); assert.ok(refreshed.remaining! > mergePathReserve, `the replenished budget is read (${refreshed.remaining})`);
  assert.equal(refreshed.deferrals.find(entry => entry.work === building.id), undefined, 'and the deferral is cleared');
  t.mock.timers.reset();
});

test('integration:rate-limit-pause-single-incident — twenty jobs refused for rate limiting are one attention item stating the pause, until when, what spent the budget and that gates read stale, while each job keeps its error in the ledger; and once the pause lifts every job observes again without a wake', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client(); await serve(github);
  const items: Work[] = [];
  for (let index = 0; index < 20; index++) { let work = await submitted(api, `Paused ${index}`); work = await job(work, github); items.push(work); }
  assert.ok(items.every(work => work.observation), 'all twenty were observed while the budget lasted');
  await webhook();
  // GraphQL spends its own point budget, not the REST core allowance the hour counts (GY-1052).
  const spent = api.charged() - api.requests.filter(request => request.path === '/graphql' && request.status === 200).length;
  // GitHub refuses: every job that runs into it records the refusal, once.
  api.refuse = true; api.resetAt = Math.ceil(Date.now() / 1000) + 900;
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL,error=NULL');
  for (let index = 0; index < 20; index++) await processJob(engine, github);
  const rows = (await store.pool.query('SELECT work_id, error, available_at, clock_timestamp() AS now FROM jobs WHERE error IS NOT NULL')).rows;
  assert.equal(rows.length, 20, 'every job keeps its own refusal in the ledger');
  for (const row of rows) { assert.match(row.error, /rate limited; requests paused until|requests paused until/); assert.ok(row.available_at.getTime() - row.now.getTime() > 600_000, 'and waits for the pause to lift rather than retrying into it'); }
  assert.equal(api.requests.filter(request => request.status === 403).length, 1, 'one refusal paused the client; the other nineteen jobs spent nothing');
  const report = await status();
  assert.ok(report.githubBudget.paused, '/api/status reports the pause');
  assert.equal(report.githubBudget.paused.until, new Date(api.resetAt * 1000).toISOString());
  assert.equal(report.githubBudget.lastHour.requests, spent, 'what exhausted the budget is the hour\'s charged requests');
  assert.equal(report.jobs.length, 20);
  const attention = githubBudgetAttention(report);
  assert.equal(attention.length, 1, `one attention item over twenty paused jobs, not ${attention.length}`);
  const [incident] = attention;
  assert.equal(incident.subject, 'github');
  assert.match(incident.text, new RegExp(`^GitHub requests are paused until ${report.githubBudget.paused.until.replace(/[.]/g, '[.]')} \\(since `));
  assert.match(incident.text, /GitHub answered 403 for GET \/repos\/owner\/project\/pulls\/\d+ with 0 requests remaining/);
  assert.match(incident.text, new RegExp(`What exhausted the budget: ${spent} requests in the last hour \\((pulls|check-runs|pull-reviews|pull-files|protection|git-refs|commits|compare|check-publication)[^)]*\\) of an hourly limit of 5000`));
  assert.match(incident.text, /Every gate reads stale until the pause lifts/);
  assert.match(incident.text, /20 integration jobs recorded the refusal in the ledger/);
  assert.equal(incident.role, 'control plane'); assert.match(incident.next, /observation resumes at/);
  assert.deepEqual(pauseAttention(report).length, 1); assert.deepEqual(exhaustionAttention(report), [], 'a pause is not also raised as an exhaustion ahead');
  assert.equal(report.githubBudget.remaining, 0, 'the refusal reported zero remaining'); assert.equal(report.githubBudget.resetAt, report.githubBudget.paused.until);
  // The pause lifts with no delivery. The refusal's reading (zero remaining, this reset) expired
  // with the reset, so the jobs that come back after `paused.until` observe rather than being held
  // below the reserve on the count from before the pause; the first spent request reads the fresh budget.
  api.refuse = false;
  const observedBefore = new Map(items.map(work => [work.id, work.observation!.at]));
  const refusalsOnTheWire = api.requests.filter(request => request.status === 403).length;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.setTime(Date.parse(report.githubBudget.paused.until) + 2000);
  api.remaining = api.limit; api.resetAt = Math.ceil(Date.now() / 1000) + 3600;
  const lifted = github.budget();
  assert.equal(lifted.paused, null, 'the pause has lifted');
  assert.equal(lifted.remaining, null); assert.equal(lifted.belowReserve, false);
  assert.equal(lifted.expiredResetAt, report.githubBudget.paused.until, 'the refusal\'s reading expired with the reset');
  assert.deepEqual(githubBudgetAttention({ ...report, githubBudget: lifted }), [], 'nothing is raised once the pause lifts');
  // The jobs come back at the pause's end, as their schedule says; nothing woke them.
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL');
  for (let index = 0; index < 20; index++) await processJob(engine, github);
  const resumed = (await store.pool.query('SELECT work_id, error FROM jobs')).rows;
  assert.equal(resumed.length, 20); assert.ok(resumed.every(row => row.error === null), `every job ran clean once the pause lifted: ${JSON.stringify(resumed.filter(row => row.error))}`);
  for (const work of items) { const current = await reload(work); assert.ok(Date.parse(current.observation!.at) > Date.parse(observedBefore.get(work.id)!), `${work.key} was observed after the pause without a wake`); }
  assert.equal(api.requests.filter(request => request.status === 403).length, refusalsOnTheWire, 'nothing ran into the refusal again');
  assert.deepEqual(github.budget().deferrals, [], 'nothing was held below the reserve on the count from before the pause');
  assert.equal(github.budget().belowReserve, false); assert.equal(github.budget().expiredResetAt, null, 'the fresh reading is in force');
  t.mock.timers.reset();
});

test('integration:webhook-liveness-visible — status reports the last delivery and the count in the last hour, and master status raises one item naming the App webhook settings page when nothing has arrived for an hour while pull requests are open', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client(); await serve(github);
  for (let index = 0; index < 3; index++) { const work = await submitted(api, `Open ${index}`); await job(work, github); }
  const before = await status();
  assert.deepEqual([before.webhooks.lastDeliveryAt, before.webhooks.lastHour, before.webhooks.settingsUrl, before.webhooks.openPullRequests], [null, 0, 'https://github.com/settings/apps', 3]);
  const silent = webhookAttention(before, Date.now());
  assert.equal(silent.length, 1);
  assert.match(silent[0].text, new RegExp(`^No GitHub webhook delivery has arrived since the control plane started while ${before.webhooks.openPullRequests} pull requests are open`));
  assert.match(silent[0].next, /https:\/\/github\.com\/settings\/apps \(URL https:\/\/YOUR-HOST\/api\/github\/webhook/);
  assert.match(silent[0].next, /deliveries listed under https:\/\/github\.com\/settings\/apps\/advanced/);
  // The slug the preflight learned names the App's own page.
  Object.assign(github, { preflightState: { app: 'graphyard-owner-project', verifiedAt: new Date().toISOString() } });
  assert.equal(github.webhookSettingsUrl(), 'https://github.com/settings/apps/graphyard-owner-project');
  // A delivery arrives: it is the last one, it counts for the hour, and the item clears.
  await webhook(); await webhook();
  const after = await status();
  assert.equal(after.webhooks.lastHour, 2); assert.ok(Date.now() - Date.parse(after.webhooks.lastDeliveryAt) < 10_000);
  assert.deepEqual(webhookAttention(after, Date.now()), []);
  // An hour of silence with pull requests open raises it again, naming the last delivery.
  const stale = webhookAttention(after, Date.now() + 3_600_000 + 60_000);
  assert.equal(stale.length, 1); assert.match(stale[0].text, new RegExp(`for 1h1m \\(last at ${after.webhooks.lastDeliveryAt.replace(/[.]/g, '[.]')}\\)`));
  // With nothing open there is nothing to wake, so silence is not a fault.
  assert.deepEqual(webhookAttention({ ...after, webhooks: { ...after.webhooks, openPullRequests: 0 } }, Date.now() + 7_200_000), []);
  assert.equal(githubBudgetAttention(after, Date.now()).length, 0, 'nothing else is raised on a healthy budget');
});

test('unit:base-move-wakes-only-affected-items — a merge touching one file wakes exactly the open items whose pull requests touch it, or whose mergeability GitHub has not settled; every other job keeps its schedule', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client(); await serve(github);
  // Ten open items, each observed once: two change src/a.ts, eight change files of their own.
  const items: Work[] = [];
  for (let index = 0; index < 10; index++) {
    api.files.set(prNumber + 1, index < 2 ? ['src/a.ts', `src/own-${index}.ts`] : [`src/own-${index}.ts`]);
    items.push(await job(await submitted(api, `Open ${index}`), github));
  }
  assert.ok(items.every(work => work.observation?.mergeableState === 'clean'), 'every reading records GitHub\'s merge state, here CLEAN');
  // Every job is scheduled an hour out, then main moves by one change to src/a.ts.
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour',webhook_at=NULL");
  await webhook(undefined, [{ added: [], removed: [], modified: ['src/a.ts'] }]);
  const woken = async () => (await store.pool.query('SELECT work_id FROM jobs WHERE available_at <= now()')).rows.map(row => String(row.work_id)).sort();
  assert.deepEqual(await woken(), items.slice(0, 2).map(work => work.id).sort(), 'exactly the two items touching src/a.ts are woken');
  // GitHub now reports two items that touch no base file BLOCKED (awaiting review) and BEHIND: neither is CLEAN or UNSTABLE, so a base move wakes both.
  api.states.set(items[2].submission!.pr, 'blocked'); api.states.set(items[3].submission!.pr, 'behind');
  items[2] = await job(items[2], github); items[3] = await job(items[3], github);
  assert.deepEqual([items[2].observation?.mergeableState, items[3].observation?.mergeableState], ['blocked', 'behind']);
  api.states.set(items[4].submission!.pr, 'unstable'); items[4] = await job(items[4], github);
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour',webhook_at=NULL");
  await webhook(undefined, [{ added: [], removed: [], modified: ['src/a.ts'] }]);
  assert.deepEqual(await woken(), items.slice(0, 4).map(work => work.id).sort(), 'the two touching src/a.ts, and the BLOCKED and BEHIND ones; the UNSTABLE and CLEAN ones keep their schedule');
  // A push whose files the payload cannot name (none listed, forced, or truncated at 20 commits) wakes every job, as before.
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour',webhook_at=NULL");
  await webhook();
  assert.equal((await woken()).length, 10, 'a base push with unknown files wakes every item');
  assert.equal(baseChangeFiles({ forced: true, commits: [{ added: [], removed: [], modified: ['x'] }] }), null);
  assert.equal(baseChangeFiles({ commits: Array.from({ length: 20 }, () => ({ added: [], removed: [], modified: ['x'] })) }), null);
  assert.deepEqual(baseChangeFiles({ commits: [{ added: ['n.ts'], removed: ['o.ts'], modified: ['m.ts'] }, { added: [], removed: [], modified: ['m.ts'] }] }), ['n.ts', 'o.ts', 'm.ts']);

  // The selection itself: an item whose last reading is BLOCKED, BEHIND, conflicting (DIRTY), still
  // computing (UNKNOWN), recorded no state, or is missing, is woken whatever its files; a CLEAN or
  // UNSTABLE one only when its files overlap.
  const fleet = await store.list();
  const [dirty, unknown, stateless, unread] = [fleet[5], fleet[6], fleet[7], fleet[8]];
  const states = fleet.map(work => work.id === dirty.id ? { ...work, observation: { ...work.observation!, mergeable: false, conflicting: true, mergeableState: 'dirty' } }
    : work.id === unknown.id ? { ...work, observation: { ...work.observation!, mergeable: false, mergeabilityUnknown: true, mergeableState: 'unknown' } }
      : work.id === stateless.id ? { ...work, observation: { ...work.observation!, mergeableState: undefined } }
        : work.id === unread.id ? { ...work, observation: null } : work) as Work[];
  const unsettled = [items[2].id, items[3].id, dirty.id, unknown.id, stateless.id, unread.id];
  assert.deepEqual(baseMoveWakes(states, ['src/a.ts']).sort(), [items[0].id, items[1].id, ...unsettled].sort());
  assert.deepEqual(baseMoveWakes(states, []).sort(), unsettled.sort());
  assert.equal(baseMoveWakes(states, null).length, 10);
  // The route's subjects: the woken items' pull requests, never `all`; a queue ref still wakes every job.
  const push = { ref: 'refs/heads/main', after: sha('m'), commits: [{ added: [], removed: [], modified: ['src/a.ts'] }] };
  const subjects = baseMoveSubjects(webhookSubjects(push, 'main'), fleet, baseChangeFiles(push));
  assert.deepEqual([subjects.all, subjects.prs.sort()], [false, items.slice(0, 4).map(work => work.submission!.pr).sort()]);
  assert.equal(webhookSubjects({ ref: 'refs/graphyard/queue/GY-1', after: sha('q') }, 'main').all, true);
});

test('unit:merge-burst-request-budget — ten merges in ten minutes over 80 open items spend at most 1500 charged GitHub requests, with each reading costed by the real client against a provider that answers conditional reads with free 304s', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client();
  // 80 open candidates: candidate i changes one of twenty areas, so each area is shared by four.
  // Half of them await their independent review, which GitHub reports BLOCKED: a base move wakes them all.
  const blocked = (index: number) => index % 2 === 0;
  const candidates = Array.from({ length: 80 }, (_, index) => {
    const pr = api.open(400 + index, `graphyard/gy-m${index}-1`, { approved: !blocked(index) }); api.files.set(400 + index, [`src/area-${index % 20}.ts`, `src/own-${index}.ts`]);
    if (blocked(index)) api.states.set(400 + index, 'blocked');
    return item(`GY-M${index}`, 400 + index, pr.head, api.main);
  });
  // What one reading costs, measured with the real client over the whole fleet: the first, an unchanged one, and the first after main moved.
  let all: Work[] = [];
  const first: number[] = [];
  for (const candidate of candidates) { const measured = await github.measured(() => github.observe(candidate, candidates)); first.push(measured.uncached); all.push(evaluated(candidate, candidates, measured.value)); }
  const read = async () => { const costs: number[] = []; for (const candidate of [...all]) { const measured = await github.measured(() => github.observe(candidate, all)); costs.push(measured.uncached); all = all.map(entry => entry.id === candidate.id ? evaluated(candidate, all, measured.value) : entry); } return costs; };
  await read();
  const unchanged = await read();
  // Main moves, and its push webhook ends the client's shared read of the base ref, as in production.
  api.main = sha('main-2'); github.noteWebhook('push', { ref: 'refs/heads/main' });
  const moved = await read();
  // Each reading is charged the worst any candidate paid for it: the bound holds for the costliest readings.
  // The first reading after the move also paid the cycle's shared base reads, which every later one is
  // served: those are charged once per move, and each base-moved reading the worst of the rest.
  const max = (costs: number[]) => Math.max(...costs), mean = (costs: number[]) => costs.reduce((sum, cost) => sum + cost, 0) / costs.length;
  const requestCost = { unchanged: max(unchanged), changed: max(first), baseMoved: max(moved.slice(1)), baseMoveShared: moved[0] - Math.min(...moved.slice(1)) };
  // Its compares of the new tip are one charged read since GY-1272: every question about one pair shares a page.
  assert.ok(requestCost.baseMoved >= 2, `a base-moved reading pays at least its pull request and its compare of the new tip (${requestCost.baseMoved})`);
  assert.ok(mean(unchanged) <= 2 && mean(moved) > mean(unchanged), `a base move is paid for, and an unchanged reading mostly is not (${mean(unchanged)}, ${mean(moved)})`);
  // Four candidates GitHub last read as conflicting: a base move may settle them, so every merge wakes them.
  all = all.map((work, index) => index % 20 === 7 ? { ...work, observation: { ...work.observation!, mergeable: false, conflicting: true } } : work) as Work[];
  // Ten merges a minute apart, each changing one area; ten minutes of the default workers.
  const options = { all, workers: 8, steadyMs: steadyStateInterval(80, null, 5000), jobMs: 13_000, durationMs: 10 * 60_000, changedShare: 0.1, requestCost,
    baseMoves: Array.from({ length: 10 }, (_, index) => ({ atMs: 30_000 + index * 60_000, files: [`src/area-${index * 2}.ts`] })) };
  const run = simulateObservationScheduler(options);
  if (process.env.GRAPHYARD_BUDGET_DEBUG) console.log('merge burst', { requestCost, requests: run.requests, claims: run.claims, woken: run.woken.map(keys => keys.length) });
  assert.equal(all.filter(work => work.observation?.mergeableState === 'blocked').length, 40, 'forty readings record GitHub\'s BLOCKED');
  // Each merge wakes the forty BLOCKED candidates (its area's four among them, every even area being blocked) and the four conflicting ones.
  assert.ok(run.woken.every(keys => keys.length === 44), `each merge wakes 44 of 80 (${run.woken.map(keys => keys.length)})`);
  assert.ok(run.requests <= 1500, `ten merges over 80 open items spent ${run.requests} charged requests, over 1500`);
  // The simulation discriminates: over a fleet GitHub reads CLEAN (none awaiting review or conflicting) a
  // merge wakes only its area's four, and waking every open item on each merge, as before GY-1231, spends
  // far more. With half the fleet BLOCKED, as above, the woken readings already fill the workers.
  const everything = options.baseMoves.map(move => ({ ...move, files: null }));
  const clean = all.map(work => ({ ...work, observation: { ...work.observation!, mergeable: true, conflicting: false, mergeableState: 'clean' } })) as Work[];
  const cleanRun = simulateObservationScheduler({ ...options, all: clean }), cleanBefore = simulateObservationScheduler({ ...options, all: clean, baseMoves: everything });
  if (process.env.GRAPHYARD_BUDGET_DEBUG) console.log('clean', cleanRun.requests, cleanBefore.requests);
  assert.ok(cleanBefore.woken.every(keys => keys.length === 80), 'a base push whose files are unknown wakes all 80');
  assert.ok(cleanRun.woken.every(keys => keys.length === 4) && cleanRun.requests * 2 < cleanBefore.requests, `over a CLEAN fleet a merge wakes its area's four, spending ${cleanRun.requests} against ${cleanBefore.requests}`);
});

/**
 * GY-1272. Six of the seven resources faults were one event: the plane's GitHub App budget at its
 * bound at 06:36:13Z on 5 October 2026 (the resource itself, and installation, GY-711, GY-1052,
 * GY-1241 and GY-1245 held by it). The plane's own usage lines for that hour put `GET /compare/:range`
 * at up to 211 of 286 requests a minute through the merge burst. The base asked GitHub one SHA pair
 * under three queries on every base move: `contains` with `?per_page=1`, the landing diff bare and
 * `historySince` with `?per_page=100&page=1`, each charged on its own. The candidate reads every
 * question about a pair from one page (`comparePage`).
 */
const pairs = ['ancestry', 'history', 'files'] as const;
/** The client with each compare it reads labelled by the question asked: the base asked each under its own query. */
function labelledCompares(github: GitHub) {
  const asking = new AsyncLocalStorage<typeof pairs[number]>(), reads: string[] = [];
  for (const [method, label] of [['contains', 'ancestry'], ['historySince', 'history']] as const) {
    const own = github[method].bind(github) as (a: string, b: string) => Promise<any>;
    (github as any)[method] = (a: string, b: string) => asking.run(label, () => own(a, b));
  }
  const request = github.request.bind(github);
  github.request = (path: string, method?: string, body?: unknown) => {
    const pair = /^\/compare\/([a-f0-9]{40}\.\.\.[a-f0-9]{40})/.exec(path);
    if (pair) reads.push(`${pair[1]}|${asking.getStore() ?? 'files'}`);
    return request(path, method, body);
  };
  // What the base would have been charged for the compares read so far: once per pair and question (its ancestry, immutable
  // and history caches each kept their own), where the candidate is charged once per pair.
  const charged = () => ({ base: new Set(reads).size, candidate: new Set(reads.map(read => read.split('|')[0])).size });
  return { charged };
}

test('manual:fault-class-resources — GY-1272: every question about one SHA pair is one charged compare; the base charged one per query', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client();
  const [from, to] = [api.main, sha('head-pair')];
  // REPRODUCE against base: its three readers of one pair asked it under three queries, three charged requests.
  for (const query of ['?per_page=1', '', comparePage]) await github.request(`/compare/${from}...${to}${query}`);
  assert.equal(api.charged(), 3, 'the base\'s reads of one pair are three charged compares');
  // CANDIDATE: ancestry, the commit list, the file lists and the patch-ids of a pair are one charged compare.
  // A head cut from main: GitHub reports it ahead, so no listing asks the reverse compare.
  const [other, tip] = [api.main, api.open(9, 'graphyard/gy-pair-1').head];
  const before = api.charged();
  await github.contains(other, tip);
  await github.historySince(other, tip);
  await github.changedFiles(other, tip);
  await github.diffPatchId(other, tip);
  await github.sideFiles(other, tip);
  await github.nonDocsPatchId(other, tip);
  assert.equal(api.charged() - before, 1, 'one charged compare for every question about the pair');
  assert.deepEqual(api.requests.slice(-1).map(request => request.path), [`/repos/${REPOSITORY}/compare/${other}...${tip}${comparePage}`]);
});

test('manual:fault-class-resources — GY-1272: the 5 October merge burst replayed spends the App budget on the base and stays under its warning floor on the candidate', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client();
  const { charged } = labelledCompares(github);
  // The fleet of unit:merge-burst-request-budget: 80 open candidates, half awaiting review (BLOCKED), over twenty areas.
  // The other half are approved with CI still running: an approved, green candidate is GitHub's to merge (GY-1235) and
  // leaves the fleet within the burst, so the ones still open through the hour are those GitHub cannot merge yet.
  const blocked = (index: number) => index % 2 === 0;
  const candidates = Array.from({ length: 80 }, (_, index) => {
    const pr = api.open(600 + index, `graphyard/gy-b${index}-1`, { approved: !blocked(index), checks: blocked(index) ? 'success' : 'in_progress' }); api.files.set(600 + index, [`src/area-${index % 20}.ts`, `src/own-${index}.ts`]);
    if (blocked(index)) api.states.set(600 + index, 'blocked');
    return item(`GY-B${index}`, 600 + index, pr.head, api.main);
  });
  let all: Work[] = [];
  for (const candidate of candidates) all.push(evaluated(candidate, candidates, await github.observe(candidate, candidates)));
  /** One reading of every open candidate, each costed on the candidate and as the base would have been charged for it. */
  const read = async () => {
    const costs: { candidate: number; base: number }[] = [];
    for (const candidate of [...all]) {
      const [spent, compares] = [api.charged(), charged()];
      const value = await github.observe(candidate, all);
      const now = charged(), cost = api.charged() - spent;
      costs.push({ candidate: cost, base: cost + (now.base - compares.base) - (now.candidate - compares.candidate) });
      all = all.map(entry => entry.id === candidate.id ? evaluated(candidate, all, value) : entry);
    }
    return costs;
  };
  await read();
  const unchanged = await read();
  // Main moves along one line, as a merge moves it: every candidate is held on the base it was cut from, so its landing is checked.
  api.history.push(api.main); api.main = sha('main-burst'); github.noteWebhook('push', { ref: 'refs/heads/main' });
  const moved = await read();
  assert.ok(all.every(work => work.observation!.candidate.baseSha === api.history[0] && work.observation!.landing?.base === api.main), 'each candidate is held on its base and its landing is checked on the new tip');
  const cost = (side: 'candidate' | 'base') => ({ unchanged: Math.max(...unchanged.map(entry => entry[side])), changed: 8,
    baseMoved: Math.max(...moved.slice(1).map(entry => entry[side])), baseMoveShared: moved[0][side] - Math.min(...moved.slice(1).map(entry => entry[side])) });
  const [base, candidate] = [cost('base'), cost('candidate')];
  assert.equal(base.baseMoved - candidate.baseMoved, 2, `the base asked the new tip about each head three times, the candidate once (${base.baseMoved} against ${candidate.baseMoved})`);
  // One hour of the burst: a merge every two minutes over the 80, the default eight workers.
  const burst = (requestCost: typeof base) => simulateObservationScheduler({ all, workers: 8, steadyMs: steadyStateInterval(80, null, 5000), jobMs: 13_000, durationMs: 60 * 60_000, changedShare: 0.1, requestCost,
    baseMoves: Array.from({ length: 30 }, (_, index) => ({ atMs: 30_000 + index * 2 * 60_000, files: [`src/area-${(index * 2) % 20}.ts`] })) }).requests;
  const [spentOnBase, spentOnCandidate] = [burst(base), burst(candidate)];
  if (process.env.GRAPHYARD_BUDGET_DEBUG) console.log('GY-1272 burst', { base, candidate, spentOnBase, spentOnCandidate });
  // REPRODUCE against base: the hour spends the whole budget, so the client pauses and every subject it holds waits.
  assert.ok(spentOnBase > api.limit, `the base spends ${spentOnBase} of ${api.limit} requests in the hour`);
  // CANDIDATE: the same hour stays under the budget's 500-request warning floor.
  assert.ok(spentOnCandidate < api.limit - 500, `the candidate spends ${spentOnCandidate} of ${api.limit} requests in the hour`);
});
