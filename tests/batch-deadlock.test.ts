import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { GitHub, processJob } from '../src/github.js';
import { diagnose } from '../src/coordination.js';
import { buildMasterStatus } from '../src/master/status.js';
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
    // GitHub's push webhook for every move of main, as the route delivers it: it ends the adapter's shared base-ref read (GY-806).
    const setRef = this.refs.set.bind(this.refs);
    this.refs.set = (key: string, value: string) => { const result = setRef(key, value); if (key === 'heads/main') github.noteWebhook('push', { ref: 'refs/heads/main' }); return result; };
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
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('batch-deadlock'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
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
  let work = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/server/routes/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:queue'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  const branch = `graphyard/${work.key.toLowerCase()}-1`;
  repo.refs.set(`heads/${branch}`, head());
  repo.pulls.set(++pr, { number: pr, head: branch, user: AUTHOR, state: 'open', draft: false });
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/deadlock/${work.id}`, branch }, randomUUID());
  return engine.execute(worker, 'submit', work.id, { epoch: 1, pr }, randomUUID());
}
test('unit:no-observation-recorded — every claimed job that saves no observation records why, and the third one in a row raises an attention item naming the item and the path taken', async () => {
  await clearQueue();
  const repo = new Repo(), github = repo.adapter();
  const main = repo.commit([], 'main'); repo.refs.set('heads/main', main);
  let work = await submitted(repo, 'Starved observation', () => repo.change([main], 'feat: starved', ['src/server/routes/starved.ts']));
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
  // Master status raises it on its own, from what /api/status reports: nobody has to suspect the
  // item and run diagnose on it first.
  const raised = buildMasterStatus(snapshot, [], [], {}, {}, undefined, 'main', { starvedJobs: await store.starvedJobs() }).attentionItems.find(item => item.subject === work.key && item.kind === 'integration-job');
  assert.ok(raised, 'master status raises an attention item for the starved observation job');
  assert.match(raised!.text, new RegExp(`${work.key}'s observation job has finished 3 times in a row without saving an observation; last reschedule: Task changed while GitHub was being observed`), 'naming the item and the path taken');
  // A run that saves an observation resets the count and the attention item goes.
  work = await cycle(github, work);
  assert.equal((await jobRow(work)).unobserved, 0);
  const after = await store.workSnapshot();
  assert.equal(diagnose(await reload(work), after.work, Date.parse(after.now), after.jobs).some(entry => entry.kind === 'observation-starved'), false);
  assert.deepEqual(await store.starvedJobs(), [], 'the saved observation clears the master-status item');
});

test('unit:observation-no-save-faults — a run that saves no observation names its cause and the bounded retry policy, and the run that reaches the limit escalates once instead of counting up', async () => {
  // Imported here, so a checkout without the module fails this case rather than the whole file.
  const { observationEscalatedRetryMs, observationNoSaveLimit, observationRetryMs } = await import('../src/model/observation-save.js');
  await clearQueue();
  const repo = new Repo(), github = repo.adapter();
  const main = repo.commit([], 'main'); repo.refs.set('heads/main', main);
  let work = await submitted(repo, 'Escalated observation', () => repo.change([main], 'feat: escalated', ['src/server/routes/escalated.ts']));
  repo.approve(work.submission!.pr, repo.refs.get(`heads/${branchOf(work)}`)!);
  work = await cycle(github, work);
  assert.ok(work.observation, 'the item is observed once before every save is refused');
  const cause = 'Task changed while GitHub was being observed; retry';
  (github as any).observe = async () => { throw new ReconciliationRetry(cause, 409); };
  const streak = async (runs: number) => {
    for (let run = 1; run <= runs; run++) {
      const started = Date.now();
      work = await cycle(github, work);
      const job = await jobRow(work);
      const finishes = Math.min(run, observationNoSaveLimit);
      assert.equal(job.unobserved, finishes, `run ${run} counts up to the limit and no further`);
      assert.ok(String(job.deferred_reason).startsWith(cause), `run ${run} names the cause`);
      assert.equal(job.error, null, 'a concurrency retry is not an operator error');
      const delay = Date.parse(job.available_at) - started;
      if (finishes < observationNoSaveLimit) {
        assert.match(String(job.deferred_reason), new RegExp(`no observation saved ${finishes} of ${observationNoSaveLimit} times: retrying in ${observationRetryMs / 1000} s, escalating at ${observationNoSaveLimit}`));
        assert.ok(delay <= observationRetryMs + 5000, `below the limit the retry is the short one (${delay} ms)`);
      } else {
        assert.match(String(job.deferred_reason), new RegExp(`no observation saved ${observationNoSaveLimit} times in a row: escalated, retrying every ${observationEscalatedRetryMs / 1000} s until one saves`));
        assert.ok(delay >= observationEscalatedRetryMs - 5000, `at the limit the job stops retrying every two seconds (${delay} ms)`);
      }
    }
  };
  await streak(observationNoSaveLimit + 3);
  const escalations = await events(work, 'observation.no-save-escalated');
  assert.equal(escalations.length, 1, 'the run that reaches the limit records the fault once, not once per further run');
  assert.deepEqual({ ...escalations[0].payload.details, reason: undefined }, { cause, finishes: observationNoSaveLimit, limit: observationNoSaveLimit, retryMs: observationEscalatedRetryMs, reason: undefined });
  const snapshot = await store.workSnapshot();
  const raised = buildMasterStatus(snapshot, [], [], {}, {}, undefined, 'main', { starvedJobs: await store.starvedJobs() }).attentionItems.find(item => item.subject === work.key && item.kind === 'integration-job');
  assert.ok(raised, 'master status raises the escalated job as an observation fault');
  assert.match(raised!.text, new RegExp(`finished ${observationNoSaveLimit} times in a row without saving an observation; last reschedule: ${cause.replace(/[.;]/g, '\\$&')} \\(no observation saved ${observationNoSaveLimit} times in a row: escalated`));
  // A saved observation ends the streak; the next streak escalates again.
  (github as any).observe = repo.adapter().observe;
  work = await cycle(github, work);
  assert.equal((await jobRow(work)).unobserved, 0);
  (github as any).observe = async () => { throw new ReconciliationRetry(cause, 409); };
  await streak(observationNoSaveLimit);
  assert.equal((await events(work, 'observation.no-save-escalated')).length, 2, 'a new streak reaching the limit escalates again');
});
