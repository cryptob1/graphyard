import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { GitHub, processJob } from '../src/github.js';
import { describeMergeBatches, predictQueue, queueRef } from '../src/merge-queue.js';
import { diagnose } from '../src/coordination.js';
import { CHECK_NAME, Refusal, ReconciliationRetry, type Principal, type Work } from '../src/model.js';

// GY-506: the merge-queue deadlock. Every test is named for the proof it produces.

const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const APP = 'graphyard-owner-project[bot]', REVIEWER = 'graphyard-reviewer[bot]', AUTHOR = 'implementer';

// ---- A fake GitHub with a commit graph, over the same request surface the adapter uses ---------

interface Commit { sha: string; parents: string[]; message: string; tree: string; author: { login: string; type: string } | null; files: string[] }
class Repo {
  commits = new Map<string, Commit>();
  refs = new Map<string, string>();
  pulls = new Map<number, { number: number; head: string; user: string; state: string; draft: boolean }>();
  reviews = new Map<number, any[]>();
  timeline = new Map<number, any[]>();
  failing = new Set<string>();
  conflicts = new Set<string>();
  calls: { path: string; method: string; body: any }[] = [];
  private counter = 0;
  private reviewIds = 100;
  commit(parents: string[], message: string, author: Commit['author'] = { login: AUTHOR, type: 'User' }, files: string[] = []) {
    const sha = sha40(`${(++this.counter).toString(16).padStart(6, '0')}`.padEnd(40, 'c'));
    this.commits.set(sha, { sha, parents, message, tree: `7${sha.slice(1)}`, author, files });
    return sha;
  }
  change(parents: string[], message: string, files: string[]) { return this.commit(parents, message, undefined, files); }
  changed(from: string, to: string) {
    const base = this.ancestry(from);
    return [...new Set([...this.ancestry(to)].filter(sha => !base.has(sha)).flatMap(sha => this.commits.get(sha)!.files))].sort();
  }
  ancestry(sha: string): Set<string> {
    const seen = new Set<string>(); const stack = [sha];
    while (stack.length) { const current = stack.pop()!; if (seen.has(current)) continue; seen.add(current); stack.push(...(this.commits.get(current)?.parents ?? [])); }
    return seen;
  }
  contains(ancestor: string, head: string) { return this.ancestry(head).has(ancestor); }
  approve(pr: number, sha: string) { const id = ++this.reviewIds; this.reviews.set(pr, [...(this.reviews.get(pr) ?? []), { id, user: { login: REVIEWER }, commit_id: sha, state: 'APPROVED', submitted_at: new Date().toISOString() }]); return id; }
  pull(pr: number) {
    const entry = this.pulls.get(pr)!;
    const head = this.refs.get(`heads/${entry.head}`)!, main = this.refs.get('heads/main')!;
    const mergeable = !this.conflicts.has(`${head}+${main}`) && !this.conflicts.has(`${main}+${head}`);
    return { number: pr, head: { sha: head, ref: entry.head, repo: { full_name: 'owner/project' } }, base: { sha: main, ref: 'main', repo: { full_name: 'owner/project' } },
      user: { login: entry.user, id: 7 }, state: entry.state, draft: entry.draft, merged: false, mergeable, merge_commit_sha: null, merged_at: null, created_at: '2026-09-22T08:00:00Z' };
  }
  adapter() {
    const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
    github.controlPlaneLogin = async () => APP;
    github.request = async (rawPath: string, method = 'GET', body?: unknown) => {
      this.calls.push({ path: rawPath, method, body });
      const url = new URL(rawPath, 'http://api.test'); const path = url.pathname; const page = Number(url.searchParams.get('page') ?? 1);
      if (method === 'POST' && path === '/merges') {
        const { base, head, commit_message } = body as { base: string; head: string; commit_message: string };
        const branchHead = this.refs.get(`heads/${base}`)!;
        if (this.contains(head, branchHead)) return null;
        if (this.conflicts.has(`${branchHead}+${head}`) || this.conflicts.has(`${head}+${branchHead}`)) throw new Refusal('GitHub POST /repos/owner/project/merges failed (409)', 502);
        const merged = this.commit([branchHead, head], commit_message, { login: APP, type: 'Bot' });
        this.refs.set(`heads/${base}`, merged);
        return { sha: merged };
      }
      if (method === 'PATCH' && path.startsWith('/git/refs/')) { this.refs.set(decodeURIComponent(path.slice('/git/refs/'.length)), (body as { sha: string }).sha); return { object: { sha: (body as { sha: string }).sha } }; }
      if (method === 'POST' && path === '/git/refs') { this.refs.set((body as { ref: string }).ref.replace(/^refs\//, ''), (body as { sha: string }).sha); return {}; }
      if (method !== 'GET') return { id: 12 };
      if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: this.refs.get('heads/main') } };
      if (/^\/commits\/[a-f0-9]{40}$/.test(path)) {
        const commit = this.commits.get(path.slice(9)); if (!commit) throw new Refusal(`GitHub GET ${path} failed (404)`, 502);
        return { sha: commit.sha, parents: commit.parents.map(sha => ({ sha })), commit: { tree: { sha: commit.tree }, message: commit.message, author: { email: 'noreply@github.com' } }, author: commit.author };
      }
      if (/^\/commits\/[a-f0-9]{40}\/check-runs$/.test(path)) {
        if (url.searchParams.has('check_name')) return { check_runs: [] };
        const sha = path.slice(9, 49);
        return { check_runs: page > 1 ? [] : ['test', 'typecheck'].map((name, index) => ({ id: 10 + index, name, status: 'completed', conclusion: this.failing.has(sha) ? 'failure' : 'success', app: { id: 15368 } })) };
      }
      if (path.startsWith('/compare/')) {
        const [from, to] = path.slice(9).split('...');
        return { status: from === to ? 'identical' : this.contains(from, to) ? 'ahead' : this.contains(to, from) ? 'behind' : 'diverged', files: this.changed(from, to).map(filename => ({ filename })), commits: [] };
      }
      const pull = path.match(/^\/pulls\/(\d+)(\/\w+)?$/);
      if (pull) {
        const number = Number(pull[1]);
        if (!pull[2]) return structuredClone(this.pull(number));
        if (pull[2] === '/reviews') return page > 1 ? [] : structuredClone(this.reviews.get(number) ?? []);
        if (pull[2] === '/files') return page > 1 ? [] : this.changed(this.refs.get('heads/main')!, this.refs.get(`heads/${this.pulls.get(number)!.head}`)!).map(filename => ({ filename, status: 'modified' }));
      }
      const issue = path.match(/^\/issues\/(\d+)\/timeline$/);
      if (issue) return page > 1 ? [] : structuredClone(this.timeline.get(Number(issue[1])) ?? []);
      if (path.includes('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
      if (path.startsWith('/contents/')) return null;
      throw new Error(`Unexpected request ${method} ${rawPath}`);
    };
    return github;
  }
}

// ---- Engine integration: a real Postgres, the real adapter over the fake provider --------------

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:queue'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pr = 800;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 506;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-batch-deadlock-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
  engine.principals = [operator, worker, producer];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const events = async (work: Work, kind: string) => (await store.events(work.id)).filter(event => event.kind === kind).reverse();
const branchOf = (work: Work) => work.workspaces[0].branch;
const jobRow = async (work: Work) => (await store.pool.query('SELECT available_at,locked_until,error,held_until,deferred_reason,unobserved FROM jobs WHERE work_id=$1', [work.id])).rows[0];
async function onlyJob(work: Work) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
}
/** One reconciliation of exactly this item through the real adapter. */
async function cycle(github: GitHub, work: Work) { await onlyJob(work); await processJob(engine, github); return reload(work); }
/** Leave the queue to the items this test creates: everything else live is delivered. */
async function clearQueue() { await store.pool.query("UPDATE work_items SET document=(document-'queue')||jsonb_build_object('stage','done') WHERE document->>'stage' <> 'done'"); }
async function submitted(repo: Repo, title: string, head: () => string) {
  let work = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:queue'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  const branch = `graphyard/${work.key.toLowerCase()}-1`;
  repo.refs.set(`heads/${branch}`, head());
  repo.pulls.set(++pr, { number: pr, head: branch, user: AUTHOR, state: 'open', draft: false });
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/deadlock/${work.id}`, branch }, randomUUID());
  return engine.execute(worker, 'submit', work.id, { epoch: 1, pr }, randomUUID());
}
/** Approved on its head, observed once, and proven: what enters the merge queue with no tip published yet. */
async function validated(repo: Repo, github: GitHub, work: Work) {
  const head = repo.refs.get(`heads/${branchOf(work)}`)!;
  repo.approve(work.submission!.pr, head);
  work = await cycle(github, work);
  assert.equal(work.candidate!.sha, head);
  work = await engine.execute(producer, 'evidence', work.id, { proof: 'unit:queue', sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['src/'] }, randomUUID());
  const queued = await reload(work);
  assert.ok(queued.queue, 'the approved, proven candidate entered the merge queue');
  assert.equal(queued.queue!.speculation, null, 'no tip is published for it yet');
  return queued;
}

test('unit:batch-tip-published-from-stale-state — the GY-438 state (batch testing, tip null, stale observation) with the record churning underneath: the next job saves an observation and publishes the batch tip', async () => {
  await clearQueue();
  const repo = new Repo(), github = repo.adapter();
  const main = repo.commit([], 'main'); repo.refs.set('heads/main', main);
  let head = await submitted(repo, 'Deadlock head', () => repo.change([main], 'feat: head', ['src/head.ts']));
  let behind = await submitted(repo, 'Deadlock behind', () => repo.change([main], 'feat: behind', ['src/behind.ts']));
  head = await validated(repo, github, head);
  behind = await validated(repo, github, behind);
  const headEntry = head.queue!, behindEntry = behind.queue!;
  assert.ok(headEntry.sequence < behindEntry.sequence, 'the head holds the earlier sequence');
  // The tick re-evaluates every entry, so the head's stored batch view names both members.
  await engine.reconcile();
  head = await reload(head); behind = await reload(behind);
  // The deadlock state, as GY-438 stood: the head batch is 'testing' with no published tip, and
  // the observation is over an hour old with the base branch two merges ahead of it.
  assert.deepEqual([head.queue!.batch?.state, head.queue!.batch?.tip, head.queue!.batch?.members], ['testing', null, [head.key, behind.key]]);
  const moved1 = repo.commit([main], 'Merge pull request #1 from other'); repo.refs.set('heads/main', moved1);
  const moved2 = repo.commit([moved1], 'Merge pull request #2 from other'); repo.refs.set('heads/main', moved2);
  const staleAt = new Date(Date.now() - 65 * 60_000).toISOString();
  head = await reload(head);
  head.observation!.at = staleAt;
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [head.id, JSON.stringify(head)]);
  assert.equal((await reload(head)).observation!.at, staleAt);
  // The control plane's tick keeps reconciling while the observation runs, exactly as the server's
  // two-second tick did against GY-438. Before the fix every pass re-saved every queued entry (the
  // derived batch view rewrote the document's key order), so the observation always lost the
  // revision race and its job was rescheduled without one — the deadlock. A run that still loses
  // the race records why and comes back; the queue advances on the next one.
  const observeRaw = github.observe.bind(github);
  (github as any).observe = async (work: Work, peers?: Work[]) => { const pending = observeRaw(work, peers); await engine.reconcile(); await engine.reconcile(); return pending; };
  let settled: Work | null = null;
  for (let attempt = 1; attempt <= 3 && !settled; attempt++) {
    head = await cycle(github, head);
    const job = await jobRow(head);
    if (head.observation && head.observation.at !== staleAt && head.queue?.speculation?.tip) settled = head;
    else assert.match(String(job.deferred_reason ?? job.error), /Task changed while GitHub was being observed/, `a run that saved no observation records why (attempt ${attempt})`);
  }
  (github as any).observe = observeRaw;
  assert.ok(settled, 'the queue advanced within three runs of the churning record');
  head = settled!;
  assert.equal(head.observation!.baseTip, moved2, 'the observation binds the live base branch tip');
  assert.equal(head.queue!.speculation!.base, moved2, 'the tip was built onto the predicted base the observation saw');
  const job = await jobRow(head);
  assert.equal(job.error, null, 'the clean run records no error');
  assert.equal(job.unobserved, 0, 'the run that saved an observation resets the no-observation count');
  // The record no longer churns: reconciling a queued entry is idempotent, so no pass can starve
  // the observations the way the tick did against GY-438.
  const revision = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [head.id])).rows[0].document.revision;
  await engine.reconcile(); await engine.reconcile();
  assert.equal((await store.pool.query('SELECT document FROM work_items WHERE id=$1', [head.id])).rows[0].document.revision, revision);
  // And the queue can advance: the head's published tip is observed, and the entry behind
  // publishes its own tip behind it.
  head = await cycle(github, head);
  behind = await cycle(github, behind);
  assert.ok(behind.queue!.speculation?.tip, 'the entry behind published its tip');
  assert.notEqual(behind.queue!.speculation!.tip, head.queue!.speculation!.tip);
});

test('unit:no-observation-recorded — every claimed job that saves no observation records why, and the third one in a row raises an attention item naming the item and the path taken', async () => {
  await clearQueue();
  const repo = new Repo(), github = repo.adapter();
  const main = repo.commit([], 'main'); repo.refs.set('heads/main', main);
  let work = await submitted(repo, 'Starved observation', () => repo.change([main], 'feat: starved', ['src/starved.ts']));
  const head = repo.refs.get(`heads/${branchOf(work)}`)!;
  repo.approve(work.submission!.pr, head);
  work = await cycle(github, work);
  assert.ok(work.observation, 'the item is observed once before the observation path fails');
  // The observation always loses the revision race, as it did for GY-438: the job is rescheduled
  // at the two-second retry, and the reason stands in the job record from the first reschedule —
  // a routine retry is not an operator error, but it is never silent either.
  (github as any).observe = async () => { throw new ReconciliationRetry('Task changed while GitHub was being observed; retry', 409); };
  for (let run = 1; run <= 3; run++) {
    work = await cycle(github, work);
    const job = await jobRow(work);
    assert.match(String(job.deferred_reason), /Task changed while GitHub was being observed/, `run ${run} records why no observation was saved`);
    assert.equal(job.error, null, 'a concurrency retry is not an operator error');
    assert.equal(job.held_until, null);
    assert.equal(job.unobserved, run, `run ${run} counts one more finish without an observation`);
  }
  (github as any).observe = repo.adapter().observe;
  const snapshot = await store.workSnapshot();
  const starved = diagnose(await reload(work), snapshot.work, Date.parse(snapshot.now), snapshot.jobs).find(entry => entry.kind === 'observation-starved');
  assert.ok(starved, 'the third no-observation finish raises the attention item');
  assert.match(starved!.message, new RegExp(`${work.key}'s observation job has finished 3 times in a row without saving an observation; last reschedule: Task changed while GitHub was being observed`), 'naming the item and the path taken');
  // A run that saves an observation resets the count and the attention item goes.
  work = await cycle(github, work);
  assert.equal((await jobRow(work)).unobserved, 0);
  const after = await store.workSnapshot();
  assert.equal(diagnose(await reload(work), after.work, Date.parse(after.now), after.jobs).some(entry => entry.kind === 'observation-starved'), false);
});

test('unit:stuck-batch-dissolved — a batch in testing with no published tip for over ten minutes is dissolved: its members validate singly in their existing order and the head publishes its own tip', async () => {
  await clearQueue();
  const repo = new Repo(), github = repo.adapter();
  const main = repo.commit([], 'main'); repo.refs.set('heads/main', main);
  const items: Work[] = [];
  for (const title of ['Stuck first', 'Stuck second', 'Stuck third', 'Stuck fourth']) {
    let item = await submitted(repo, title, () => repo.change([main], `feat: ${title}`, [`src/${title.slice(6).toLowerCase()}.ts`]));
    items.push(await validated(repo, github, item));
  }
  const [first, second, third, fourth] = items;
  const members = items.map(item => item.key);
  const stuck = await reload(first);
  assert.deepEqual([stuck.queue!.batch?.batch, stuck.queue!.batch?.state, stuck.queue!.batch?.tip], [1, 'testing', null], 'the head batch is testing with no published tip');
  // The batch has been wedged in that state for over ten minutes.
  stuck.queue!.batchStall = { since: new Date(Date.now() - 11 * 60_000).toISOString() };
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [stuck.id, JSON.stringify(stuck)]);
  const dissolved = await cycle(github, first);
  assert.ok(dissolved.queue!.batchDissolved, 'the stuck batch was dissolved');
  assert.deepEqual(dissolved.queue!.batchDissolved!.members, members, 'naming every member');
  const history = (dissolved.queueHistory ?? []).filter(entry => entry.event === 'dissolved');
  assert.equal(history.length, 1);
  assert.match(history[0].reason!, /sat in testing with no published tip for 11 minutes.*single-entry queue positions/);
  assert.equal((await events(dissolved, 'queue.batch-dissolved')).length, 1, 'the dissolution is recorded on the ledger');
  // From here the members are single-entry batches, in their existing order, re-predicted in turn.
  const all = await store.list();
  const views = describeMergeBatches(all, predictQueue(all, Date.now()), engine.mergeBatchSize, engine.ciAppIds);
  assert.deepEqual(members.map(key => views.get(key)!.members), members.map(key => [key]), 'each member validates alone');
  assert.deepEqual(members.map(key => views.get(key)!.batch), [1, 2, 3, 4], 'in their existing queue order');
  assert.match(views.get(first.key)!.summary, /dissolved from a stuck batch/);
  // The head then publishes its own tip, and the entries behind theirs, one at a time: each
  // publication is followed by the observation that makes the tip the next entry's predicted base.
  const published: (string | null)[] = [];
  for (const item of items) {
    await cycle(github, await reload(item));
    const after = await cycle(github, await reload(item));
    published.push(after.queue!.speculation?.tip ?? null);
    assert.ok(after.queue!.speculation?.tip, `${item.key} published its own tip`);
  }
  assert.equal(new Set(published).size, members.length, 'every member was re-predicted onto its own tip');
  // One member leaving the queue ends the dissolution: the marker goes with the delivery that
  // takes it, no live entry keeps validating singly because of it, and the surviving batch is a
  // plain one again.
  await store.pool.query("UPDATE work_items SET document=(document-'queue')||'{\"stage\":\"done\"}' WHERE id=$1", [first.id]);
  const rest = (await store.list()).filter(item => item.stage !== 'done');
  assert.ok(rest.every(item => !item.queue?.batchDissolved), 'no live entry still carries the dissolution');
  const resumed = describeMergeBatches(rest, predictQueue(rest, Date.now()), engine.mergeBatchSize, engine.ciAppIds);
  assert.doesNotMatch(resumed.get(second.key)!.summary, /dissolved from a stuck batch/, 'the surviving batch is a plain one again');
});

test('unit:batch-view-stable — a re-derived batch view equal in content keeps the stored queue entry, so reconciling a queued entry no longer rewrites its document', { timeout: 60_000 }, async () => {
  await clearQueue();
  const repo = new Repo(), github = repo.adapter();
  const main = repo.commit([], 'main'); repo.refs.set('heads/main', main);
  let work = await submitted(repo, 'Stable batch view', () => repo.change([main], 'feat: stable', ['src/stable.ts']));
  const head = repo.refs.get(`heads/${branchOf(work)}`)!;
  repo.approve(work.submission!.pr, head);
  work = await cycle(github, work);
  work = await engine.execute(producer, 'evidence', work.id, { proof: 'unit:queue', sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['src/stable.ts'] }, randomUUID());
  work = await reload(work);
  assert.ok(work.queue?.batch, 'the queued entry carries its derived batch');
  const stored = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [work.id])).rows[0].document;
  const revision = stored.revision;
  for (let pass = 0; pass < 3; pass++) await engine.reconcile();
  const after = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [work.id])).rows[0].document;
  assert.equal(after.revision, revision, 'no reconcile pass re-saved the queued entry');
  assert.deepEqual(after.queue.batch, stored.queue.batch, 'the stored batch view stands');
  // The queue ref namespace is untouched by any of this.
  assert.match(queueRef(work.key), /^refs\/graphyard\/queue\//);
});
