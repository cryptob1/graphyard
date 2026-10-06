import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { GitHubCacheStore } from '../src/github-cache.js';
import { GitHubChargeLedger } from '../src/github-charges.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server/index.js';
import { CHECK_NAME, GitHub, baseRefCycleMs, billableBudgetShare, observationThroughputStatus, processJob, protectionShareMs } from '../src/github.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

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
    if (route === '/rules/branches/main') return [];
    if (route === '/check-runs' || /^\/check-runs\/\d+$/.test(route)) return { id: 12 };
    throw new Error(`Unexpected request ${method} ${path}`);
  }
  fetch = async (url: unknown, options: any = {}): Promise<Response> => {
    const method = options.method ?? 'GET'; const path = String(url).replace('https://api.github.com', '');
    // A GraphQL mutation (GY-1052) spends GraphQL points, which GitHub reports as their own resource.
    if (path === '/graphql') {
      this.requests.push({ method, path });
      if (/mergePullRequest/.test(String(options.body))) this.main = sha(`merged-${this.requests.length}`);
      return new Response(JSON.stringify({ data: { mergePullRequest: { pullRequest: { id: 'PR_node' } } } }), { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': String(this.resetAt), 'x-ratelimit-resource': 'graphql' } });
    }
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
    evidence: [], observation: null, blocker: null, gates: [], violations: [], escalations: [], implementers: [] } as unknown as Work;
};
const immutable = /^\/(commits\/[a-f0-9]{40}|compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40})(\?(?!per_page=1$).*)?$/;

test('unit:github-immutable-cache — a commit by SHA and a compare of two exact SHAs are fetched at most once: a second observation cycle over the same SHAs makes no request for them', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client();
  const items = Array.from({ length: 3 }, (_, index) => item(index, api));
  /** One observation cycle: every item observed, and the reads a base refresh makes of the same SHAs. */
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

test('unit:github-immutable-cache — an immutable answer still in use is kept: evicted from the hot layer, through pruning of the other kinds, or after a restart, the same commit or compare is never asked of GitHub again', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const db = await database();
  const cache = new GitHubCacheStore(db.pool, 'permanent', { flushMs: 60_000, maxRows: 1, pruneMs: Number.MAX_SAFE_INTEGER });
  const github = api.client(); await github.attachCache(cache);
  github.immutableHotEntries = 2;
  const heads = Array.from({ length: 4 }, (_, index) => sha(`permanent-${index}`));
  const paths = [...heads.map(head => `/commits/${head}`), `/compare/${heads[0]}...${heads[1]}`];
  for (const path of paths) await github.request(path);
  // Every path but the last two has left the hot layer; the answers still queued for write are served.
  for (const path of paths) assert.ok(await github.request(path), `${path} is answered`);
  assert.equal(api.requests.length, paths.length, 'no path was asked twice');
  await cache.flush();
  // Pruning bounds the other kinds on their own bound; it never removes an immutable answer for them.
  cache.put('etag', '/pulls/1', { number: 1 }, 'W/"1"'); cache.put('etag', '/pulls/2', { number: 2 }, 'W/"2"');
  await cache.flush(); await cache.prune();
  for (const path of paths) assert.ok(await cache.lookup('immutable', `/repos/${REPOSITORY}${path}`), `${path} survives pruning`);
  // Asked again from the database once the hot layer evicted it, and by a restarted adapter.
  for (const path of paths) await github.request(path);
  const restarted = api.client(); await restarted.attachCache(new GitHubCacheStore(db.pool, 'permanent'));
  restarted.immutableHotEntries = 1;
  for (const path of [...paths, ...paths]) await restarted.request(path);
  for (const path of paths) assert.equal(api.count(new RegExp(`^${path.replace(/[.]/g, '\\.')}$`)), 1, `${path} was fetched once`);
});

test('unit:github-immutable-cache — the immutable kind is bounded: answers nothing reads any more age out past their own row and byte bound, the ones still read stay, and an oversized value is never stored', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const db = await database();
  const cache = new GitHubCacheStore(db.pool, 'bounded', { flushMs: 60_000, pruneMs: Number.MAX_SAFE_INTEGER, maxImmutableRows: 3, maxValueBytes: 4096 });
  const github = api.client(); await github.attachCache(cache);
  const rows = async () => (await db.pool.query(`SELECT key FROM github_cache WHERE kind = 'immutable' AND key LIKE 'bounded:%'`)).rows.map(row => String(row.key).replace(`bounded:immutable:/repos/${REPOSITORY}`, ''));
  // A live head is read every cycle while heads that merged or were replaced are read once and never again.
  const live = `/commits/${sha('live-head')}`;
  for (let index = 0; index < 6; index++) {
    await github.request(`/commits/${sha(`retired-${index}`)}`);
    await github.request(live);
    await cache.flush(); await db.pool.query(`SELECT pg_sleep(0.01)`);
  }
  assert.equal(await cache.prune() > 0, true, 'retired answers past the bound are deleted');
  const kept = await rows();
  assert.equal(kept.length, 3, `the immutable kind holds its bound: ${kept.join(', ')}`);
  assert.ok(kept.includes(live), 'the answer still read every cycle is kept');
  assert.equal(api.count(/^\/commits\/[a-f0-9]{40}$/), 7, 'the live head was fetched once across six cycles');
  // A compare too large to store stays in the hot layer only; the table and the write queue take none of it.
  const huge = `/compare/${sha('base')}...${sha('huge')}`;
  const body = (api as any).body.bind(api);
  (api as any).body = (method: string, path: string) => path.endsWith(huge) ? { status: 'ahead', ahead_by: 1, total_commits: 1, commits: [], files: [{ filename: 'big.ts', patch: 'x'.repeat(8192) }] } : body(method, path);
  await github.request(huge); await github.request(huge); await cache.flush();
  assert.equal((await rows()).includes(huge), false, 'an oversized value is not persisted');
  assert.equal(api.count(new RegExp(`^${huge.replace(/[.]/g, '\\.')}$`)), 1, 'the hot layer still answers it');
});

test('unit:github-shared-cycle-reads — twenty items observed in one cycle make one base-ref read and at most one protection read; a new cycle, a base push or a protection event reads again', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client();
  let now = Date.parse('2026-09-26T12:00:00Z');
  github.clock = () => now;
  // No webhook has been delivered: the sharing does not wait for one.
  const items = Array.from({ length: 20 }, (_, index) => item(index, api));
  const refs = () => api.count(/^\/git\/ref\/heads\/main$/), protections = () => api.count(/^\/branches\/main\/protection$/), rules = () => api.count(/^\/rules\/branches\/main$/);
  // Half the fleet at once, as the observation workers run, and the rest one after another.
  await Promise.all(items.slice(0, 10).map(work => github.observe(work, items)));
  for (const work of items.slice(10)) { now += 500; await github.observe(work, items); }
  assert.equal(refs(), 1, 'one ref read for the whole cycle');
  assert.ok(protections() <= 1, `at most one protection read (${protections()})`);
  assert.ok(rules() <= 1, `at most one branch-rules read (${rules()})`);
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
  assert.equal(protections(), 2); assert.equal(rules(), 2);
  // A head-bound GraphQL merge moves the base branch as a REST merge does, and ends the cycle too (GY-1052).
  await github.observe(items[4], items);
  await github.enqueuePullRequest({ pullRequestId: 'PR_node', head: items[4].candidate!.sha, queue: false } as Parameters<GitHub['enqueuePullRequest']>[0], items[4].candidate!.sha, true);
  const merged = await github.observe(items[5], items);
  assert.equal(refs(), 4); assert.equal(merged.baseTip, api.main);
  now += protectionShareMs;
  await github.observe(items[3], items);
  assert.equal(protections(), 3);

  // A quiet hour with no webhook still shares: one read per cycle, protection every five minutes.
  now += 2 * 60 * 60_000;
  const quiet = { refs: refs(), protections: protections() };
  for (const work of items) { now += 500; await github.observe(work, items); }
  assert.deepEqual([refs() - quiet.refs, protections() - quiet.protections], [1, 1]);
  // A guard before a write and the final verification never take the cycle's read: they see the branch as it is now.
  const guarded = { refs: refs(), protections: protections() };
  await github.baseBranch(); await github.protection(); await github.verify(items[0], items);
  assert.deepEqual([refs() - guarded.refs, protections() - guarded.protections], [3, 3]);
});

// ---- The control plane, for the webhook-driven observation ----

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
let postgres: EmbeddedPostgres, store: Store | undefined, engine: Engine;
let http: ReturnType<typeof server>, origin = '';
const adminToken = 'o'.repeat(40);
let port = 0;
before(async () => {
  port = Number(process.env.GRAPHYARD_GITHUB_BUDGET_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 187);
  postgres = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('github-budget'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await postgres.initialise(); await postgres.start(); await postgres.createDatabase('graphyard_test');
});
const replicas: Store[] = [];
after(async () => { if (http) await new Promise(resolve => http.close(resolve)); if (store) await store.close(); for (const replica of replicas) await replica.close(); if (postgres) await postgres.stop(); });
const openStore = async () => { const opened = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await opened.init(); return opened; };
/** A second store on the shared database, as another replica holds it. */
async function replicaStore() { const opened = await openStore(); replicas.push(opened); return opened; }
async function database() { return store ??= await openStore(); }
/** One replica's engine over its own store on the shared database. */
function replicaEngine(on: Store) {
  const replica = new Engine(on, [CI], 120, REPOSITORY); replica.controlPlaneAppId = APP;
  replica.principals = [operator, worker];
  replica.submissionObserver = null;
  return replica;
}

async function serve(github: GitHub) {
  engine = replicaEngine(await database());
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
const reload = async (work: Work) => (await store!.list()).find(entry => entry.id === work.id)!;
const jobRow = async (work: Work) => (await store!.pool.query('SELECT error, available_at, deferred_reason, clock_timestamp() AS now FROM jobs WHERE work_id=$1', [work.id])).rows[0] as { error: string | null; available_at: Date; deferred_reason: string | null; now: Date };
async function deliver(event: string, payload: unknown) {
  process.env.GITHUB_WEBHOOK_SECRET ??= 'webhook-secret-for-the-test';
  const raw = JSON.stringify(payload);
  const response = await realFetch(`${origin}/api/github/webhook`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': randomUUID(), 'x-hub-signature-256': `sha256=${createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET).update(raw).digest('hex')}` } });
  assert.equal(response.status, 202, 'the delivery is accepted');
}

test('unit:webhook-driven-observation — a check_run delivery re-observes its item at once, ahead of a polled job due earlier, and the poll that follows within its interval is skipped, whichever replica receives, claims or polls', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  // Replica A receives the webhook; replica B, on the same database with its own adapter, claims the jobs.
  const github = api.client(); await serve(github);
  const other = api.client(), replica = replicaEngine(await replicaStore());
  let woken = await submitted(api, 'Named by the check run'); let polled = await submitted(api, 'Due by its poll');
  // Both are observed once; then the woken item's poll is an hour away and the other's is overdue.
  for (let index = 0; index < 2; index++) { await store!.pool.query('UPDATE jobs SET available_at=now()'); await processJob(replica, other); }
  woken = await reload(woken); polled = await reload(polled);
  assert.ok(woken.observation && polled.observation, 'both items were observed');
  await store!.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour' WHERE work_id=$1", [woken.id]);
  await store!.pool.query("UPDATE jobs SET available_at=now()-interval '1 minute' WHERE work_id=$1", [polled.id]);
  const observedAt = { woken: woken.observation!.at, polled: polled.observation!.at };

  await deliver('check_run', { action: 'completed', repository: { full_name: REPOSITORY }, check_run: { head_sha: woken.candidate!.sha, app: { id: CI }, pull_requests: [{ number: woken.submission!.pr }] } });
  assert.deepEqual(await replica.store.webhookDue(), [woken.id], 'the delivery marked the named item due, on the job every replica claims from');
  await processJob(replica, other);
  woken = await reload(woken); polled = await reload(polled);
  assert.ok(Date.parse(woken.observation!.at) > Date.parse(observedAt.woken), 'the item was re-observed without waiting for its poll');
  assert.equal(polled.observation!.at, observedAt.polled, 'ahead of the polled job that was due first');
  const scheduled = await jobRow(woken);
  assert.equal(scheduled.error, null);
  const pollMs = scheduled.available_at.getTime() - scheduled.now.getTime();
  assert.ok(pollMs > 60_000, `the next poll is a full interval away (${pollMs} ms)`);
  await processJob(replica, other);
  assert.ok(Date.parse((await reload(polled)).observation!.at) > Date.parse(observedAt.polled), 'the polled job runs next');

  // The poll that follows, inside the interval the webhook-driven observation scheduled, is skipped.
  await store!.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour' WHERE work_id<>$1", [woken.id]);
  await store!.pool.query('UPDATE jobs SET available_at=now() WHERE work_id=$1', [woken.id]);
  const requests = api.requests.length, at = (await reload(woken)).observation!.at;
  // Replica A polls: the refresh replica B recorded is on the job, so A skips it too.
  assert.equal(await processJob(engine, github), true, 'the poll was claimed');
  assert.equal(api.requests.length, requests, 'and asked GitHub nothing');
  assert.equal((await reload(woken)).observation!.at, at, 'the item was not re-observed');
  const skipped = await jobRow(woken);
  assert.match(skipped.deferred_reason ?? '', /poll skipped: a webhook refreshed this item/);
  assert.ok(skipped.available_at.getTime() - skipped.now.getTime() > 30_000, 'the job is due again when the interval ends');

  // An item that entered the merge band since the refresh is not skipped (GY-1052): the band is read
  // again at skip time, so it is observed at the merge cadence rather than at the end of the interval.
  await store!.pool.query('UPDATE jobs SET available_at=now() WHERE work_id=$1', [woken.id]);
  const asMerging = (await store!.list()).map(entry => entry.id !== woken.id ? entry : { ...entry, stage: 'merge' as const, violations: [], leadHold: undefined,
    gates: entry.gates.map(gate => ({ ...gate, passed: true })), mergeAuthorization: { sha: entry.candidate!.sha, baseSha: entry.candidate!.baseSha, policyRevision: entry.policyRevision, at: new Date().toISOString() } } as Work);
  t.mock.method(engine.store, 'fleet', async () => asMerging, { times: 1 });
  const beforeMerge = api.requests.length;
  assert.equal(await processJob(engine, github), true, 'the merge-band item was claimed');
  assert.ok(api.requests.length > beforeMerge, 'and observed, not skipped');
  assert.doesNotMatch((await jobRow(woken)).deferred_reason ?? '', /poll skipped/);

  // The band is re-read after the claim (GY-1052): an item that entered it between the pre-claim
  // snapshot and `takeJob` is observed too. The first read shows it outside the band, the second inside.
  await store!.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour' WHERE work_id<>$1", [woken.id]);
  await store!.pool.query("UPDATE jobs SET available_at=now(), refreshed_until=now()+interval '1 hour', claimed_generation=generation, webhook_at=NULL WHERE work_id=$1", [woken.id]);
  const preClaim = await store!.list();
  const merging = preClaim.map(entry => asMerging.find(other => other.id === entry.id && entry.id === woken.id) ?? entry);
  let reads = 0, itemReads = 0;
  t.mock.method(engine.store, 'fleet', async () => { reads++; return preClaim; }, { times: 1 });
  t.mock.method(engine.store, 'workItem', async (id: string) => { itemReads++; return merging.find(entry => entry.id === id); }, { times: 1 });
  const beforeRace = api.requests.length;
  assert.equal(await processJob(engine, github), true, 'the item was claimed');
  assert.deepEqual({ reads, itemReads }, { reads: 1, itemReads: 1 }, 'the claimed item, not the fleet, was read again after the claim');
  assert.ok(api.requests.length > beforeRace, 'and observed, not skipped');
  assert.doesNotMatch((await jobRow(woken)).deferred_reason ?? '', /poll skipped/);

  // A skip outside the merge band costs one read of the claimed item by its id (GY-1052): neither the
  // fleet nor anything else is read again, so an early-due poll never pays a second full fleet read.
  await store!.pool.query("UPDATE jobs SET available_at=now(), refreshed_until=now()+interval '1 hour', claimed_generation=generation, webhook_at=NULL WHERE work_id=$1", [woken.id]);
  const fleetReads = t.mock.method(engine.store, 'fleet'), itemRead = t.mock.method(engine.store, 'workItem');
  const beforeSkip = api.requests.length;
  assert.equal(await processJob(engine, github), true, 'the poll was claimed');
  assert.equal(api.requests.length, beforeSkip, 'and skipped');
  assert.match((await jobRow(woken)).deferred_reason ?? '', /poll skipped/);
  assert.deepEqual({ fleet: fleetReads.mock.callCount(), item: itemRead.mock.callCount() }, { fleet: 1, item: 1 }, 'one fleet read before the claim, one item read after it');
  fleetReads.mock.restore(); itemRead.mock.restore();

  // A worker's push to the pull-request branch names the item by its branch before its candidate names the new head.
  await deliver('push', { ref: `refs/heads/${polled.candidate!.branch}`, after: sha('pushed-head'), repository: { full_name: REPOSITORY } });
  assert.deepEqual(await replica.store.webhookDue(), [polled.id]);
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
    else if (call.endpoint === 'ref') await github.cycleBaseBranch();
    else await github.branchProtection(false, true);
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

test('unit:github-budget-projection — the billable report is the installation\'s: two replicas sharing one quota each report their combined requests, over the target where either alone is under it', async t => {
  const api = new Api();
  api.limit = 100; api.remaining = 100;
  t.mock.method(globalThis, 'fetch', api.fetch);
  const db = await database();
  const [one, two] = [api.client(), api.client()];
  const ledgers = [new GitHubChargeLedger(db.pool, 'shared-installation', { instance: 'replica-1' }), new GitHubChargeLedger(db.pool, 'shared-installation', { instance: 'replica-2' })];
  one.attachChargeLedger(ledgers[0]); two.attachChargeLedger(ledgers[1]);
  // Another installation on the same database is not this quota's spend.
  const elsewhere = new GitHubChargeLedger(db.pool, 'other-installation', { instance: 'replica-3' });
  for (let index = 0; index < 50; index++) elsewhere.charge(Date.now(), 'GET /pulls/:n', 'pulls');
  await elsewhere.close();
  for (let index = 0; index < 35; index++) { await one.request(`/pulls/${index}`); await two.request(`/pulls/${index}`); }
  await two.request('/git/ref/heads/main');
  const alone = one.budget().billable;
  assert.equal(alone.perHour, 35, 'before the ledger syncs a replica sees only its own charges');
  assert.ok(alone.share < billableBudgetShare);
  await ledgers[0].sync(); await ledgers[1].sync(); await ledgers[0].sync();
  for (const replica of [one, two]) {
    const billable = replica.budget().billable;
    assert.equal(billable.perHour, 71, 'both replicas count the installation\'s 71 requests');
    assert.equal(billable.instances, 2);
    assert.ok(billable.share > billableBudgetShare, `the combined share ${billable.share} is over the ${billableBudgetShare} target`);
    assert.deepEqual(billable.byEndpoint.map(entry => [entry.endpoint, entry.requests]), [['GET /pulls/:n', 70], ['GET /git/ref/heads/:branch', 1]]);
  }
  const reported = observationThroughputStatus({ githubBudget: one.budget() }, { work: [], now: new Date().toISOString() });
  assert.equal(reported.budget?.billable?.perHour, 71, 'master status carries the installation-wide count');
});

test('unit:github-budget-projection — a charge batch whose write fails is queued again, so a transient database failure delays the other replicas\' count instead of losing it', async () => {
  const db = await database();
  let failing = true;
  const flaky = { query: (text: string, values?: unknown[]) => failing && text.startsWith('INSERT') ? Promise.reject(new Error('connection reset')) : db.pool.query(text, values) };
  const writer = new GitHubChargeLedger(flaky as any, 'flaky-installation', { instance: 'writer' });
  const reader = new GitHubChargeLedger(db.pool, 'flaky-installation', { instance: 'reader' });
  for (let index = 0; index < 4; index++) writer.charge(Date.now(), 'GET /pulls/:n', 'pulls');
  const error = console.error; console.error = () => {};
  try { await writer.sync(); } finally { console.error = error; }
  await reader.sync();
  assert.equal(reader.fleet().rows.length, 0, 'nothing reached the ledger while the write failed');
  failing = false;
  writer.charge(Date.now(), 'GET /pulls/:n', 'pulls');
  await writer.sync(); await reader.sync();
  assert.deepEqual(reader.fleet().rows.map(row => [row.endpoint, row.requests]), [['GET /pulls/:n', 5]], 'the failed batch was written with the next one');
  await writer.close(); await reader.close();
});

test('unit:github-budget-projection — GraphQL points and App-level calls are not billed against the REST core limit (GY-1052)', async t => {
  const api = new Api();
  t.mock.method(globalThis, 'fetch', api.fetch);
  const github = api.client();
  await github.request('/pulls/1');
  await github.enqueuePullRequest({ pullRequestId: 'PR_node', head: sha('head'), queue: false } as Parameters<GitHub['enqueuePullRequest']>[0], sha('head'), true);
  const budget = github.budget();
  assert.equal(api.requests.length, 2, 'both requests were made');
  assert.deepEqual([budget.billable.perHour, budget.lastHour.requests, budget.spentInWindow], [1, 1, 1], 'only the REST read is billed');
  assert.deepEqual(budget.billable.byEndpoint.map(entry => entry.endpoint), ['GET /pulls/:n']);
});

test('unit:github-budget-projection — the charge ledger counts the minute its hour starts in, prunes every instance\'s rows past two hours, and close waits for a sync already writing (GY-1052)', async () => {
  const db = await database();
  const installation = `window-${randomUUID()}`;
  const rows = async () => (await db.pool.query('SELECT instance, minute FROM github_charges WHERE installation=$1 ORDER BY minute', [installation])).rows as { instance: string; minute: Date }[];
  const now = Date.parse('2026-09-26T10:30:30Z');
  // A restarted replica's instance id never writes again; the survivor's prune still removes its rows.
  const gone = new GitHubChargeLedger(db.pool, installation, { instance: 'restarted' });
  gone.charge(now - 150 * 60_000, 'GET /pulls/:n', 'pulls'); await gone.sync(now - 150 * 60_000); await gone.close();
  const writer = new GitHubChargeLedger(db.pool, installation, { instance: 'writer' });
  const reader = new GitHubChargeLedger(db.pool, installation, { instance: 'reader' });
  writer.charge(Date.parse('2026-09-26T09:29:50Z'), 'GET /pulls/:n', 'pulls');
  writer.charge(Date.parse('2026-09-26T09:30:45Z'), 'GET /pulls/:n', 'pulls');
  writer.charge(now, 'GET /pulls/:n', 'pulls');
  await writer.sync(now); await reader.sync(now);
  assert.deepEqual(reader.fleet(now).rows.map(row => row.requests), [2], 'the 09:30 minute is inside the hour at 10:30:30; 09:29 is not');
  assert.ok((await rows()).every(row => now - row.minute.getTime() <= 2 * 60 * 60_000), 'no row older than two hours is left, the restarted instance\'s included');
  assert.equal((await rows()).filter(row => row.instance === 'restarted').length, 0);

  // close() while a timer-started sync is writing waits for that write.
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const slow = new GitHubChargeLedger({ query: async (text: string, values?: unknown[]) => { if (text.startsWith('INSERT')) await held; return db.pool.query(text, values); } } as any, installation, { instance: 'closing' });
  slow.charge(now, 'GET /pulls/:n', 'pulls');
  const syncing = slow.sync(now);
  let closed = false; const closing = slow.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(closed, false, 'close waits for the sync already writing');
  release(); await closing; await syncing;
  assert.ok((await rows()).some(row => row.instance === 'closing'), 'the in-flight batch was written before close returned');
  await writer.close(); await reader.close();
});

test('unit:webhook-driven-observation — webhook wakes are claimed oldest delivery first, even ahead of a newer wake whose job is long overdue (GY-1052)', async () => {
  const api = new Api();
  const older = await submitted(api, 'Older webhook'), newer = await submitted(api, 'Newer webhook, long overdue');
  await store!.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour', webhook_at=NULL");
  await store!.pool.query("UPDATE jobs SET available_at=now(), webhook_at=now()-interval '10 seconds' WHERE work_id=$1", [older.id]);
  await store!.pool.query("UPDATE jobs SET available_at=now()-interval '1 day', webhook_at=now()-interval '5 seconds' WHERE work_id=$1", [newer.id]);
  const first = await store!.takeJob([], 0, 60_000);
  assert.equal(first?.work_id, older.id, 'the older delivery is claimed first');
  assert.equal(first?.webhook, true);
  const second = await store!.takeJob([], 0, 60_000);
  assert.equal(second?.work_id, newer.id);
});

test('unit:github-immutable-cache — an entry whose write-behind flush is still running answers a lookup from memory, so GitHub is not asked for it again (GY-1052)', async () => {
  const db = await database();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const cache = new GitHubCacheStore({ query: async (text: string, values?: unknown[]) => { if (text.startsWith('INSERT')) await held; return db.pool.query(text, values); } } as any, `inflight-${randomUUID()}`, { flushMs: 60_000 });
  cache.put('immutable', '/commits/abc', { sha: 'abc' });
  const flushing = cache.flush();
  assert.deepEqual(await cache.lookup('immutable', '/commits/abc'), { sha: 'abc' }, 'the batch being written is visible to lookups');
  release(); await flushing;
  assert.deepEqual(await cache.lookup('immutable', '/commits/abc'), { sha: 'abc' }, 'and the table answers once it is written');
  await cache.close();
});

test('unit:github-immutable-cache — a batch whose write fails is queued once more, then dropped if the retry fails too (GY-1052)', async () => {
  const db = await database();
  let failures = 1;
  const cache = new GitHubCacheStore({ query: async (text: string, values?: unknown[]) => {
    if (text.startsWith('INSERT') && failures-- > 0) throw new Error('connection reset');
    return db.pool.query(text, values);
  } } as any, `retry-${randomUUID()}`, { flushMs: 60_000 });
  const error = console.error; console.error = () => {};
  try {
    cache.put('immutable', '/commits/abc', { sha: 'abc' });
    await cache.flush();
    assert.deepEqual(await cache.lookup('immutable', '/commits/abc'), { sha: 'abc' }, 'the failed entry is still queued, not lost');
    await cache.flush();
    assert.deepEqual(await cache.lookup('immutable', '/commits/abc'), { sha: 'abc' }, 'the retry wrote it');
    failures = 2;
    cache.put('immutable', '/commits/def', { sha: 'def' });
    await cache.flush(); await cache.flush();
    assert.equal(await cache.lookup('immutable', '/commits/def'), undefined, 'a second failure drops the entry');
    await cache.flush();

    // close() retries a batch that fails during shutdown flush rather than dropping it (GY-1052)
    failures = 1;
    const closeScope = `close-retry-${randomUUID()}`;
    const closingCache = new GitHubCacheStore({ query: async (text: string, values?: unknown[]) => {
      if (text.startsWith('INSERT') && failures-- > 0) throw new Error('connection reset');
      return db.pool.query(text, values);
    } } as any, closeScope, { flushMs: 60_000 });
    closingCache.put('immutable', '/commits/close-retry', { sha: 'close-retry' });
    await closingCache.close();
    const reopened = new GitHubCacheStore(db.pool, closeScope);
    assert.deepEqual(await reopened.lookup('immutable', '/commits/close-retry'), { sha: 'close-retry' }, 'a chunk failing during shutdown gets its single retry before close returns');
    await reopened.close();
  } finally { console.error = error; await cache.close(); }
});
