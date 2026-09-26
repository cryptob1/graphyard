import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { GitHub, processJob } from '../src/github.js';
import { baseRefreshConflict, branchContamination, currentRestore, decideIdentityCarry, dismissedApproval, ejectedTipRestore, pendingBaseRefresh, pendingRestore, restoredApproval, reviewDismissal, tipReplacesHead, type IdentityCarryInput } from '../src/merge-queue.js';
import { CHECK_NAME, Refusal, carriedApproval, exactApproval, type Evidence, type Principal, type Work } from '../src/model.js';
import { branchReport, buildMasterStatus, masterConfigSchema, repostCarriedApproval, runAutonomyCommand, type MasterConfig } from '../src/master.js';
import { readMasterGuide } from './helpers/master-guide.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Each test is named for the proof it produces, so acceptance evidence maps to one executed
// case per required proof (GY-127).

const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const APP = 'graphyard-owner-project[bot]', REVIEWER = 'graphyard-reviewer[bot]', AUTHOR = 'implementer';
const mergeBaseMessage = 'The merge-base changed after approval.';

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
  /**
   * What GitHub's dismissal says when a push stales the approvals on a branch: nothing, as a
   * stale-review dismissal names the commit and no reason. A test that models GitHub wording the
   * dismissal of a publication that changed the merge base sets its exact message here.
   */
  pushDismissal: string | null = null;
  private counter = 0;
  private reviewIds = 100;
  /** A commit and the paths it changes itself; a merge changes none of its own. */
  commit(parents: string[], message: string, author: Commit['author'] = { login: AUTHOR, type: 'User' }, files: string[] = []) {
    const sha = sha40(`${(++this.counter).toString(16).padStart(6, '0')}`.padEnd(40, 'c'));
    this.commits.set(sha, { sha, parents, message, tree: `7${sha.slice(1)}`, author, files });
    return sha;
  }
  /** A worker's commit changing `files`. */
  change(parents: string[], message: string, files: string[]) { return this.commit(parents, message, undefined, files); }
  /** What GitHub's three-dot comparison lists: every path the commits `to` has and `from` lacks changed. */
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
  /** Commits a branch holds that the base branch does not: what a reviewer would read as "this branch". */
  unlanded(branch: string) { return [...this.ancestry(this.refs.get(`heads/${branch}`)!)].filter(sha => !this.ancestry(this.refs.get('heads/main')!).has(sha)); }
  review(pr: number, sha: string, state: 'APPROVED' | 'CHANGES_REQUESTED') { const id = ++this.reviewIds; this.reviews.set(pr, [...(this.reviews.get(pr) ?? []), { id, user: { login: REVIEWER }, commit_id: sha, state, submitted_at: new Date().toISOString() }]); return id; }
  approve(pr: number, sha: string) { return this.review(pr, sha, 'APPROVED'); }
  requestChanges(pr: number, sha: string) { return this.review(pr, sha, 'CHANGES_REQUESTED'); }
  /**
   * Dismissing every live verdict of a pull request, with the message given and the commit it is
   * attributed to. The review list then shows `DISMISSED` whatever the verdict was, as GitHub's
   * does; only the timeline event keeps the dismissed verdict (`dismissed_review.state`).
   */
  dismiss(pr: number, message: string | null, commit: string | null, by = 'owner', verdicts: string[] = ['APPROVED', 'CHANGES_REQUESTED']) {
    for (const review of this.reviews.get(pr) ?? []) {
      if (!verdicts.includes(review.state)) continue;
      const state = review.state.toLowerCase();
      review.state = 'DISMISSED';
      this.timeline.set(pr, [...(this.timeline.get(pr) ?? []), { event: 'review_dismissed', actor: { login: by }, created_at: new Date().toISOString(),
        dismissed_review: { state, review_id: review.id, dismissal_message: message, ...(commit ? { dismissal_commit_id: commit } : {}) } }]);
    }
  }
  pull(pr: number) {
    const entry = this.pulls.get(pr)!;
    // GitHub computes mergeability against the base branch head: a pair declared conflicting is reported so.
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
        // A push to a pull-request branch stales every approval on it, as dismiss_stale_reviews does.
        for (const [number, pull] of this.pulls) if (pull.head === base) this.dismiss(number, this.pushDismissal, merged);
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
      if (path.startsWith('/contents/')) throw new Refusal(`GitHub GET ${path} failed (404)`, 502);
      throw new Error(`Unexpected request ${method} ${rawPath}`);
    };
    return github;
  }
}

// ---- Engine integration: a real Postgres, the real adapter over the fake provider --------------

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:queue'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pr = 700;
before(async () => {
  const port = Number(process.env.GRAPHYARD_QUEUE_TIP_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 33);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('queue-tip'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
  engine.principals = [operator, worker, coordinator, producer];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const events = async (work: Work, kind: string) => (await store.events(work.id)).filter(event => event.kind === kind).reverse();
const gate = (work: Work, name: string) => work.gates.find(entry => entry.name === name)!;
const branchOf = (work: Work) => work.workspaces[0].branch;
async function onlyJob(work: Work) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
}
/** One reconciliation of exactly this item through the real adapter. */
async function cycle(github: GitHub, work: Work) { await onlyJob(work); await processJob(engine, github); return reload(work); }
/** A claimed item whose pull request head is `head` on the fake provider, submitted. */
async function submitted(repo: Repo, title: string, head: (work: Work) => string) {
  let work = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:queue'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  const branch = `graphyard/${work.key.toLowerCase()}-1`;
  repo.refs.set(`heads/${branch}`, head(work));
  repo.pulls.set(++pr, { number: pr, head: branch, user: AUTHOR, state: 'open', draft: false });
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/tip/${work.id}`, branch }, randomUUID());
  return engine.execute(worker, 'submit', work.id, { epoch: 1, pr }, randomUUID());
}
/** Approved by the reviewer App on its head and proven on it: what enters the merge queue. */
async function validated(repo: Repo, github: GitHub, work: Work) {
  const head = repo.refs.get(`heads/${branchOf(work)}`)!;
  repo.approve(work.submission!.pr, head);
  work = await cycle(github, work);
  assert.equal(work.candidate!.sha, head);
  return proven(work);
}
/**
 * The mechanical proof passing on the observed candidate. A review is requested only once a head's
 * mechanical proofs pass (GY-115), so a scenario that expects a fresh review proves the head first.
 */
function proven(work: Work) {
  return engine.execute(producer, 'evidence', work.id, { proof: 'unit:queue', sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['src/queue.ts'] }, randomUUID());
}
async function clearQueue() { await store.pool.query("UPDATE work_items SET document=(document-'queue')||'{\"stage\":\"done\"}' WHERE document->>'stage'<>'done'"); }
const dismissedReview = (work: Work) => work.observation!.reviews.find(review => review.state === 'DISMISSED')!;

test('integration:tip-publication-keeps-approval — publishing a tip that changes the merge base costs no approval: the review gate passes on the carried binding, no review is requested, and the reviewer App re-posts it', async () => {
  // The identity carry as a rule: a tip that is the reviewed head itself carries by the same
  // per-file decision as a Graphyard-authored merge, on the base changes GitHub listed.
  {
    const A = sha40('a1'), B = sha40('b1'), P = sha40('c1'), at = '2026-09-22T08:00:00.000Z';
    const record = (id: string, overrides: Partial<Evidence> = {}): Evidence => ({ id, proof: 'unit:queue', sha: A, baseSha: B, policyRevision: 1, producer: 'ci-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at, ...overrides });
    const same = (overrides: Partial<IdentityCarryInput> = {}): IdentityCarryInput => ({ from: { sha: A, baseSha: B }, to: { sha: A, baseSha: P }, policyRevision: 1, at, baseChanges: ['src/other.ts', 'docs/other.md'], predecessor: { key: null, validated: true },
      reviewedFiles: ['src/queue.ts', 'tests/queue.test.ts'], approval: { provider: 'github', reviewer: REVIEWER, sha: A, reviewId: 900 },
      proofs: [{ proof: 'unit:queue', evidence: record('ev-unit', { scopeFiles: ['src/queue.ts', 'tests/'] }) }, { proof: 'integration:docs', evidence: record('ev-docs', { scopeFiles: ['docs/'] }) }, { proof: 'manual:unscoped', evidence: record('ev-manual') }, { proof: 'e2e:missing', evidence: undefined }], ...overrides });
    const states = (carry: ReturnType<typeof decideIdentityCarry>) => [carry.approval.carried, ...carry.evidence.map(entry => entry.carried)];
    const carry = decideIdentityCarry(same());
    assert.deepEqual([carry.from, carry.to, carry.predecessor, carry.changedFiles], [{ sha: A, baseSha: B }, { sha: A, baseSha: P }, 'base branch', ['src/other.ts', 'docs/other.md']]);
    assert.deepEqual({ ...carry.approval, reason: undefined }, { carried: true, provider: 'github', reviewer: REVIEWER, sha: A, reviewId: 900, originalSha: A, reason: undefined });
    assert.match(carry.approval.reason, /carried to tip a1ffffffffff, the reviewed head itself republished unchanged onto predicted base c1ffffffffff: the base branch changed none of the 2 reviewed files/);
    assert.deepEqual(carry.evidence.map(entry => [entry.proof, entry.carried, entry.evidenceId]), [['unit:queue', true, 'ev-unit'], ['integration:docs', false, 'ev-docs'], ['manual:unscoped', false, 'ev-manual'], ['e2e:missing', false, undefined]]);
    assert.deepEqual(states(decideIdentityCarry(same({ baseChanges: [] }))), [true, true, true, true, false], 'a predicted base that changed nothing carries every proof');
    const touched = decideIdentityCarry(same({ baseChanges: ['src/queue.ts'] }));
    assert.equal(touched.approval.carried, false); assert.match(touched.approval.reason, /the base branch changed reviewed files src\/queue\.ts; a fresh independent approval/);
    assert.deepEqual(touched.evidence.map(entry => entry.carried), [false, true, false, false]);
    for (const [overrides, pattern] of [[{ baseChanges: null }, /could not be listed completely/], [{ baseChanges: undefined }, /could not be listed completely/], [{ predecessor: { key: 'GY-1', validated: false } }, /predecessor GY-1 is not fully validated/], [{ to: { sha: sha40('d1'), baseSha: P } }, /was not produced by Graphyard's merge of the approved head/]] as [Partial<IdentityCarryInput>, RegExp][]) {
      const refused = decideIdentityCarry(same(overrides));
      assert.deepEqual(states(refused), [false, false, false, false, false], pattern.source); assert.match(refused.approval.reason, pattern);
    }
  }
  await clearQueue();
  const repo = new Repo(), github = repo.adapter();
  // GitHub words the dismissal of a publication that changed the merge base with its merge-base
  // reason; the record, not that wording, is what passes the gate (asserted below).
  repo.pushDismissal = mergeBaseMessage;
  const main = repo.commit([], 'main'); repo.refs.set('heads/main', main);
  let work = await submitted(repo, 'Keeps approval', () => repo.commit([main], 'feat: queue'));
  const head = repo.refs.get(`heads/${branchOf(work)}`)!;
  work = await validated(repo, github, work);
  assert.ok(work.queue, 'the approved, proven candidate entered the merge queue');
  // Somebody else lands: the base branch moves under the queued head, so its merge base will change.
  const moved = repo.commit([main], 'Merge pull request #1 from other'); repo.refs.set('heads/main', moved);
  work = await cycle(github, work);
  const tip = repo.refs.get(`heads/${branchOf(work)}`)!;
  assert.notEqual(tip, head, 'the tip was published onto the branch');
  assert.deepEqual(repo.commits.get(tip)!.parents, [head, moved], 'the tip is the reviewed head merged onto the new base');
  assert.equal(work.queue!.speculation!.tip, tip); assert.equal(work.queue!.speculation!.reviewedHead, head);
  assert.equal(repo.reviews.get(work.submission!.pr)![0].state, 'DISMISSED', 'GitHub dismissed the approval on the publication');
  work = await cycle(github, work);
  assert.equal(work.candidate!.sha, tip);
  const review = dismissedReview(work);
  assert.deepEqual([review.sha, reviewDismissal(review)!.mergeBase, reviewDismissal(review)!.reason], [head, true, mergeBaseMessage], 'the observation records the dismissal reason and the head it applied to');
  assert.ok(gate(work, 'review').passed, gate(work, 'review').reasons.join('; '));
  const carried = carriedApproval(work)!;
  assert.deepEqual([carried.reviewer, carried.originalSha], [REVIEWER, head], 'the carried identity keeps the commit it approved');
  assert.equal(restoredApproval(work), null, 'the carried record passes the gate; no dismissal needed restoring');
  assert.equal(work.autoDispatch!.review, null, 'no review request is open for the tip');
  assert.equal((await events(work, 'dispatch.requested')).filter(event => event.payload.details.kind === 'review').length, 0, 'no review was ever requested');
  assert.equal(work.stage, 'merge', work.gates.flatMap(entry => entry.reasons).join('; '));
  // The merge broker re-posts the carried approval through the reviewer App, bound to the tip.
  const posted: any[] = [];
  const fetcher = (async (_url: string, init: any) => { const body = JSON.parse(init.body); posted.push(body); return new Response(JSON.stringify({ id: 999, state: 'APPROVED', commit_id: body.commit_id, user: { login: REVIEWER } })); }) as unknown as typeof fetch;
  const config = { repository: 'owner/project', reviewer: { slug: 'graphyard-reviewer', appId: 77, installationId: 78, credentialFile: '/nonexistent/reviewer.json', boundAt: '2026-09-22T00:00:00.000Z' } } as MasterConfig;
  const result = await repostCarriedApproval(config, work, carried, { run: () => JSON.stringify(repo.reviews.get(work.submission!.pr)), mint: async () => ({ token: 'reviewer-token' }), fetcher });
  assert.deepEqual([result.posted, result.reviewId, posted[0].commit_id, posted[0].event], [true, 999, tip, 'APPROVE']);

  // A rebuilt tip that is the reviewed head itself keeps its approval too: two entries, the head
  // ejected, the base unmoved, so the survivor's reviewed head already contains its new predicted
  // base and is republished with no commit produced. GitHub's push dismissal on the earlier
  // publication carries no merge-base wording here, as a stale-review dismissal does not, so the
  // record alone — the identity carry — is what passes the gate.
  await clearQueue();
  const graph = new Repo(), provider = graph.adapter();
  const root = graph.commit([], 'main'); graph.refs.set('heads/main', root);
  let ejected = await submitted(graph, 'Ejected head', () => graph.change([root], 'feat: ejected', ['src/ejected.ts']));
  let survivor = await submitted(graph, 'Survivor', () => graph.change([root], 'feat: survivor', ['src/survivor.ts']));
  const heads = { ejected: graph.refs.get(`heads/${branchOf(ejected)}`)!, survivor: graph.refs.get(`heads/${branchOf(survivor)}`)! };
  ejected = await validated(graph, provider, ejected); survivor = await validated(graph, provider, survivor);
  ejected = await cycle(provider, ejected); ejected = await cycle(provider, ejected);
  survivor = await cycle(provider, survivor); survivor = await cycle(provider, survivor);
  const behind = survivor.queue!.speculation!.tip;
  assert.deepEqual(graph.commits.get(behind)!.parents, [heads.survivor, heads.ejected]);
  assert.equal(survivor.candidate!.sha, behind);
  assert.deepEqual(survivor.observation!.files, ['src/ejected.ts', 'src/survivor.ts'], 'GitHub lists the tip\'s files against the base branch, the unlanded entry ahead included');
  const pushed = reviewDismissal(dismissedReview(survivor))!;
  assert.deepEqual([pushed.mergeBase, pushed.reason, pushed.commit], [false, null, behind], 'the push dismissal names the commit and no merge-base reason');
  assert.ok(gate(survivor, 'review').passed && carriedApproval(survivor)?.originalSha === heads.survivor, gate(survivor, 'review').reasons.join('; '));
  assert.equal(restoredApproval(survivor), null);
  const requested = async (item: Work) => (await events(item, 'dispatch.requested')).filter(event => event.payload.details.kind === 'review').length;
  assert.equal(await requested(survivor), 0);
  // The head fails its validation and is ejected; the base has not moved.
  graph.failing.add(heads.ejected);
  ejected = await cycle(provider, ejected);
  assert.equal(ejected.queue, null);
  survivor = await cycle(provider, survivor);
  const identity = survivor.queue!.speculation!;
  assert.equal(tipReplacesHead(survivor), heads.survivor, 'until the tip is observed, the replaced head is what the record still names');
  assert.equal(survivor.autoDispatch!.review, null, 'nothing is requested for the replaced head meanwhile');
  assert.deepEqual([identity.tip, identity.reviewedHead, identity.merge, identity.base, identity.predecessors, identity.baseChanges], [heads.survivor, heads.survivor, null, root, [], ['src/ejected.ts']], 'the rebuilt tip is the reviewed head itself, with no commit produced; the ejected entry\'s files are what changed');
  assert.deepEqual(identity.carry!.reviewedFiles, ['src/survivor.ts'], 'the carry is decided on the reviewed head\'s own files, not the replaced tip\'s pull-request files');
  assert.equal(graph.refs.get(`heads/${branchOf(survivor)}`), heads.survivor, 'the branch was moved back to the reviewed head');
  assert.deepEqual([identity.carry!.from.sha, identity.carry!.to, identity.carry!.approval.carried, identity.carry!.evidence.map(entry => entry.carried)], [heads.survivor, { sha: heads.survivor, baseSha: root }, true, [true]]);
  assert.match(identity.carry!.approval.reason, /carried to tip [0-9a-f]{12}, the reviewed head itself republished unchanged/);
  survivor = await cycle(provider, survivor);
  assert.equal(survivor.candidate!.sha, heads.survivor);
  assert.ok(gate(survivor, 'review').passed, gate(survivor, 'review').reasons.join('; '));
  assert.ok(gate(survivor, 'acceptance').passed, gate(survivor, 'acceptance').reasons.join('; '));
  const kept = carriedApproval(survivor)!;
  assert.deepEqual([kept.reviewer, kept.originalSha, kept.sha], [REVIEWER, heads.survivor, heads.survivor]);
  assert.equal(restoredApproval(survivor), null);
  assert.equal(survivor.autoDispatch!.review, null, 'no review request is open for the rebuilt tip');
  assert.equal(await requested(survivor), 0, 'no review was requested for a publication that changed nothing reviewed');
  assert.equal(survivor.stage, 'merge', survivor.gates.flatMap(entry => entry.reasons).join('; '));
  // The reviewer App re-posts the approval on the commit it was given on.
  posted.length = 0;
  const reposted = await repostCarriedApproval(config, survivor, kept, { run: () => JSON.stringify(graph.reviews.get(survivor.submission!.pr)), mint: async () => ({ token: 'reviewer-token' }), fetcher });
  assert.deepEqual([reposted.posted, posted[0].commit_id, posted[0].event], [true, heads.survivor, 'APPROVE']);
  assert.match(posted[0].body, /restored this identity's approval of [0-9a-f]{40} \(review \d+\) to the commit it was given on/);

  // The per-file rule still refuses: an entry ahead that changed a file the survivor's review read
  // costs the approval, and a review is requested for the tip.
  await clearQueue();
  const shared = new Repo(), sharedProvider = shared.adapter();
  const sharedRoot = shared.commit([], 'main'); shared.refs.set('heads/main', sharedRoot);
  let leader = await submitted(shared, 'Touches shared', () => shared.change([sharedRoot], 'feat: leader', ['src/shared.ts']));
  let follower = await submitted(shared, 'Reads shared', () => shared.change([sharedRoot], 'feat: follower', ['src/shared.ts', 'src/follower.ts']));
  leader = await validated(shared, sharedProvider, leader); follower = await validated(shared, sharedProvider, follower);
  leader = await cycle(sharedProvider, leader); leader = await cycle(sharedProvider, leader);
  follower = await cycle(sharedProvider, follower);
  const refused = follower.queue!.speculation!.carry!;
  assert.deepEqual([refused.changedFiles, refused.reviewedFiles, refused.approval.carried], [['src/shared.ts'], ['src/follower.ts', 'src/shared.ts'], false]);
  assert.match(refused.approval.reason, /changed reviewed files src\/shared\.ts; a fresh independent approval/);
  follower = await cycle(sharedProvider, follower);
  assert.equal(follower.autoDispatch!.review?.state, 'requested', 'the tip is reviewed afresh');

  // The walk to the reviewed head trusts no commit message. A worker commit X that carries the tip
  // message over F is the worker's own head: the tip is built from X, whose approval carries.
  // One GitHub attributes to the App — the author address is the App's — is stepped past, so the
  // tip is built from F; the approval was given on X, never on F, and does not carry.
  for (const attributed of [false, true]) {
    await clearQueue();
    const forged = new Repo(), forgedProvider = forged.adapter();
    const forgedRoot = forged.commit([], 'main'); forged.refs.set('heads/main', forgedRoot);
    let hidden = '';
    let item = await submitted(forged, attributed ? 'Forged App tip' : 'Worker tip message', work => {
      hidden = forged.change([forgedRoot], 'feat: content nobody should land', ['src/hidden.ts']);
      return forged.commit([hidden], `Graphyard speculative tip for ${work.key} behind main`, attributed ? { login: APP, type: 'Bot' } : undefined, ['src/hidden.ts']);
    });
    const approvedHead = forged.refs.get(`heads/${branchOf(item)}`)!;
    item = await validated(forged, forgedProvider, item);
    const landed = forged.commit([forgedRoot], 'Merge pull request #4 from elsewhere', undefined, ['docs/elsewhere.md']); forged.refs.set('heads/main', landed);
    item = await cycle(forgedProvider, item);
    const speculation = item.queue!.speculation!;
    assert.equal(speculation.reviewedHead, attributed ? hidden : approvedHead);
    assert.deepEqual(forged.commits.get(speculation.tip)!.parents, [attributed ? hidden : approvedHead, landed]);
    assert.equal(speculation.carry!.approval.carried, !attributed, speculation.carry!.approval.reason);
    if (attributed) {
      assert.match(speculation.carry!.approval.reason, new RegExp(`approval by ${REVIEWER.replace(/[[\]]/g, '\\$&')} was given on ${approvedHead.slice(0, 12)}, not on the reviewed head ${hidden.slice(0, 12)}`));
      assert.deepEqual(speculation.carry!.evidence.map(entry => entry.carried), [false], 'evidence proved on X does not carry onto F either');
      item = await cycle(forgedProvider, item);
      assert.equal(item.candidate!.sha, speculation.tip);
      item = await proven(item);
      assert.equal(gate(item, 'review').passed, false);
      assert.equal(item.autoDispatch!.review?.state, 'requested', 'a fresh review is requested for the tip');
    }
  }
});

test('unit:merge-base-dismissal-classified — a merge-base dismissal on an unchanged head is restored, not treated as a change request, spends no attempt, and master status names it', async () => {
  await clearQueue();
  const repo = new Repo(), github = repo.adapter();
  const main = repo.commit([], 'main'); repo.refs.set('heads/main', main);
  let work = await submitted(repo, 'Dismissal classified', () => repo.commit([main], 'feat: queue'));
  const head = repo.refs.get(`heads/${branchOf(work)}`)!;
  const reviewId = repo.approve(work.submission!.pr, head);
  work = await cycle(github, work);
  assert.ok(exactApproval(work) && gate(work, 'review').passed);
  const requestsBefore = (await events(work, 'dispatch.requested')).length, history = work.autoDispatch!.history.length;
  // GitHub recomputes the merge base and dismisses the approval; the head has not changed.
  repo.dismiss(work.submission!.pr, mergeBaseMessage, null, 'owner');
  work = await cycle(github, work);
  assert.equal(work.candidate!.sha, head, 'the head is unchanged');
  const review = dismissedReview(work), dismissal = reviewDismissal(review)!;
  assert.deepEqual([review.sha, review.id, dismissal.reason, dismissal.mergeBase, dismissal.verdict, dismissal.by], [head, reviewId, mergeBaseMessage, true, 'approved', 'owner']);
  assert.equal(exactApproval(work), null, 'the exact approval is gone from GitHub');
  assert.ok(gate(work, 'review').passed, gate(work, 'review').reasons.join('; '));
  assert.equal(gate(work, 'review').reasons.includes('Outstanding change requests must be resolved through a new review'), false, 'a dismissal is not a change request');
  assert.equal(work.reworkRequested, false); assert.equal(work.pipeline?.reworkRounds ?? 0, 0);
  assert.equal(work.autoDispatch!.review, null, 'no review request was opened');
  assert.equal(work.autoDispatch!.history.length, history, 'no request was resolved or added: the attempt budget is untouched');
  assert.equal((await events(work, 'dispatch.requested')).length, requestsBefore);
  const restored = restoredApproval(work)!;
  assert.deepEqual([restored.reviewer, restored.reviewId, restored.sha, restored.dismissal.reason], [REVIEWER, reviewId, head, mergeBaseMessage]);
  assert.deepEqual(carriedApproval(work) && [carriedApproval(work)!.originalSha, carriedApproval(work)!.sha], [head, head]);
  const ledger = await events(work, 'review.restored');
  assert.equal(ledger.length, 1); assert.equal(ledger[0].payload.details.sha, head);
  const status = buildMasterStatus({ work: [work], now: new Date().toISOString() }, [], []);
  const row = status.work[0];
  assert.match(row.restoredApproval!.line, /dismissed by GitHub for a merge-base change while the head was unchanged .*restored it as the binding approval, requested no review, spent no attempt/);
  assert.equal(status.counts.restoredApprovals, 1);
  assert.match(branchReport(status.work).restoredApprovals[0].line, new RegExp(`^${work.key}: ${REVIEWER.replace(/[[\]]/g, '\\$&')}'s approval of ${head.slice(0, 12)}`));
  // The same observation twice restores nothing twice.
  work = await cycle(github, work);
  assert.equal((await events(work, 'review.restored')).length, 1);

  // A reviewer withdrawing the verdict is the other kind of dismissal: nothing is restored, and the head is reviewed afresh.
  let withdrawn = await submitted(repo, 'Verdict withdrawn', () => repo.commit([main], 'feat: other'));
  const other = repo.refs.get(`heads/${branchOf(withdrawn)}`)!;
  repo.approve(withdrawn.submission!.pr, other);
  withdrawn = await proven(await cycle(github, withdrawn));
  assert.ok(gate(withdrawn, 'review').passed);
  repo.dismiss(withdrawn.submission!.pr, 'Please re-check the migration before this lands.', null, 'alice');
  withdrawn = await cycle(github, withdrawn);
  assert.deepEqual([reviewDismissal(dismissedReview(withdrawn))!.mergeBase, reviewDismissal(dismissedReview(withdrawn))!.verdict], [false, 'approved']);
  assert.equal(dismissedApproval(withdrawn), null);
  assert.equal(gate(withdrawn, 'review').passed, false);
  assert.equal(withdrawn.autoDispatch!.review?.state, 'requested', 'a withdrawn verdict is answered by a fresh review');
  assert.equal(restoredApproval(withdrawn), null);
  assert.equal(buildMasterStatus({ work: [withdrawn], now: new Date().toISOString() }, [], []).work[0].restoredApproval, null);

  // A person withdrawing an approval with a message that merely mentions the merge base is still
  // a person withdrawing it: only GitHub's exact message is GitHub's dismissal, and nothing is restored.
  let mentioned = await submitted(repo, 'Merge base mentioned', () => repo.commit([main], 'feat: mentioned'));
  repo.approve(mentioned.submission!.pr, repo.refs.get(`heads/${branchOf(mentioned)}`)!);
  mentioned = await proven(await cycle(github, mentioned));
  assert.ok(gate(mentioned, 'review').passed);
  repo.dismiss(mentioned.submission!.pr, 'merge base moved, will re-review after rebase', null, 'alice');
  mentioned = await cycle(github, mentioned);
  assert.deepEqual([reviewDismissal(dismissedReview(mentioned))!.mergeBase, reviewDismissal(dismissedReview(mentioned))!.verdict], [false, 'approved']);
  assert.equal(dismissedApproval(mentioned), null);
  assert.equal(gate(mentioned, 'review').passed, false);
  assert.equal(restoredApproval(mentioned), null);
  assert.equal(mentioned.autoDispatch!.review?.state, 'requested');
  assert.equal((await events(mentioned, 'review.restored')).length, 0);

  // A dismissed change request is not an approval, whatever message dismissed it: GitHub lists it
  // as DISMISSED like a dismissed approval, but the verdict the reviewer gave asked for changes, so
  // even GitHub's own merge-base message restores nothing and the head is reviewed afresh.
  let changes = await submitted(repo, 'Change request dismissed', () => repo.commit([main], 'feat: changes'));
  const changesHead = repo.refs.get(`heads/${branchOf(changes)}`)!;
  const changesId = repo.requestChanges(changes.submission!.pr, changesHead);
  changes = await proven(await cycle(github, changes));
  assert.equal(gate(changes, 'review').passed, false);
  assert.ok(gate(changes, 'review').reasons.includes('Outstanding change requests must be resolved through a new review'));
  repo.dismiss(changes.submission!.pr, mergeBaseMessage, null, 'owner');
  changes = await cycle(github, changes);
  assert.equal(changes.candidate!.sha, changesHead, 'the head is unchanged');
  const changesReview = dismissedReview(changes), changesDismissal = reviewDismissal(changesReview)!;
  assert.deepEqual([changesReview.id, changesDismissal.reason, changesDismissal.mergeBase, changesDismissal.verdict], [changesId, mergeBaseMessage, true, 'changes_requested']);
  assert.equal(dismissedApproval(changes), null, 'a dismissed change request is never restored as an approval');
  assert.equal(exactApproval(changes), null); assert.equal(carriedApproval(changes), null);
  assert.equal(gate(changes, 'review').passed, false);
  assert.equal(restoredApproval(changes), null);
  assert.equal((await events(changes, 'review.restored')).length, 0);
  assert.equal(buildMasterStatus({ work: [changes], now: new Date().toISOString() }, [], []).work[0].restoredApproval, null);
  assert.equal(changes.autoDispatch!.review?.state, 'requested', 'the head is reviewed afresh');

  // A dismissal whose timeline event names no verdict restores nothing either: without the
  // dismissed verdict on the record, nobody can say an approval was ever given.
  let unnamed = await submitted(repo, 'Verdict unnamed', () => repo.commit([main], 'feat: unnamed'));
  repo.approve(unnamed.submission!.pr, repo.refs.get(`heads/${branchOf(unnamed)}`)!);
  unnamed = await cycle(github, unnamed);
  repo.dismiss(unnamed.submission!.pr, mergeBaseMessage, null, 'owner');
  for (const event of repo.timeline.get(unnamed.submission!.pr)!) delete event.dismissed_review.state;
  unnamed = await cycle(github, unnamed);
  assert.deepEqual([reviewDismissal(dismissedReview(unnamed))!.mergeBase, reviewDismissal(dismissedReview(unnamed))!.verdict], [true, null]);
  assert.equal(dismissedApproval(unnamed), null);
  assert.equal(gate(unnamed, 'review').passed, false);
  assert.equal(restoredApproval(unnamed), null);

  // A merge-base dismissal on a head whose base refresh conflicted leaves that record as it is
  // and restores nothing: the conflict the worker owes stays named, the refresh is not retried
  // for it, and no review is asked for a head that does not contain the base tip.
  let conflicted = await submitted(repo, 'Refresh conflicted', () => repo.commit([main], 'feat: conflicted'));
  const conflictedHead = repo.refs.get(`heads/${branchOf(conflicted)}`)!;
  repo.approve(conflicted.submission!.pr, conflictedHead);
  conflicted = await cycle(github, conflicted);
  assert.ok(gate(conflicted, 'review').passed);
  const advanced = repo.commit([main], 'Merge pull request #4 from elsewhere'); repo.refs.set('heads/main', advanced);
  repo.conflicts.add(`${conflictedHead}+${advanced}`);
  conflicted = await cycle(github, conflicted);
  assert.match(baseRefreshConflict(conflicted)!, /cannot be brought onto|conflict/i);
  const merges = () => repo.calls.filter(call => call.method === 'POST' && call.path === '/merges').length, mergesBefore = merges();
  repo.dismiss(conflicted.submission!.pr, mergeBaseMessage, null, 'owner');
  conflicted = await cycle(github, conflicted);
  assert.equal(conflicted.candidate!.sha, conflictedHead);
  assert.deepEqual([reviewDismissal(dismissedReview(conflicted))!.mergeBase, restoredApproval(conflicted), carriedApproval(conflicted)], [true, null, null]);
  assert.ok(baseRefreshConflict(conflicted), 'the conflict record survives the dismissal');
  assert.equal(conflicted.baseRefresh!.head, null); assert.equal(pendingBaseRefresh(conflicted), null);
  assert.equal(merges(), mergesBefore, 'the refresh is not retried for a conflict already recorded');
  assert.equal((await events(conflicted, 'base.conflict')).length, 1);
  assert.equal((await events(conflicted, 'review.restored')).length, 0);
  assert.equal(conflicted.autoDispatch!.review, null, 'no review is asked for a head that does not contain the base tip');

  // A timeline GitHub will not serve leaves the dismissal recorded as unread, and restores nothing.
  const request = github.request.bind(github);
  github.request = async (path, method, body) => { if (path.includes('/timeline')) throw new Refusal('GitHub GET /issues/timeline failed (403)', 502); return request(path, method, body); };
  let unread = await submitted(repo, 'Timeline unread', () => repo.commit([main], 'feat: third'));
  repo.approve(unread.submission!.pr, repo.refs.get(`heads/${branchOf(unread)}`)!);
  unread = await cycle(github, unread);
  repo.dismiss(unread.submission!.pr, mergeBaseMessage, null);
  unread = await cycle(github, unread);
  const unreadDismissal = reviewDismissal(dismissedReview(unread))!;
  assert.deepEqual([unreadDismissal.reason, unreadDismissal.mergeBase], [null, false]); assert.match(unreadDismissal.unread!, /timeline failed \(403\)/);
  assert.equal(gate(unread, 'review').passed, false);
});

test('integration:ejection-leaves-no-foreign-commits — three queued candidates, the middle one ejected: every remaining branch holds only its own commits and its predicted base, and the ejected branch is its own reviewed head on the base', async () => {
  await clearQueue();
  const repo = new Repo(), github = repo.adapter();
  const main = repo.commit([], 'main'); repo.refs.set('heads/main', main);
  let first = await submitted(repo, 'Queue head', () => repo.change([main], 'feat: first', ['src/first.ts']));
  let second = await submitted(repo, 'Queue middle', () => repo.change([main], 'feat: second', ['src/second.ts']));
  let third = await submitted(repo, 'Queue tail', () => repo.change([main], 'feat: third', ['src/third.ts']));
  const own = { first: repo.refs.get(`heads/${branchOf(first)}`)!, second: repo.refs.get(`heads/${branchOf(second)}`)!, third: repo.refs.get(`heads/${branchOf(third)}`)! };
  first = await validated(repo, github, first); second = await validated(repo, github, second); third = await validated(repo, github, third);
  // Head first: each entry publishes its tip behind the one ahead, then observes it.
  first = await cycle(github, first); first = await cycle(github, first);
  second = await cycle(github, second); second = await cycle(github, second);
  third = await cycle(github, third); third = await cycle(github, third);
  assert.equal(first.queue!.speculation!.tip, own.first, 'the head already contains the base: its own head is the tip');
  const tipSecond = second.queue!.speculation!.tip, tipThird = third.queue!.speculation!.tip;
  assert.deepEqual(repo.commits.get(tipSecond)!.parents, [own.second, own.first]);
  assert.deepEqual(repo.commits.get(tipThird)!.parents, [own.third, tipSecond]);
  assert.deepEqual([second.queue!.speculation!.reviewedHead, third.queue!.speculation!.reviewedHead], [own.second, own.third]);
  assert.ok(repo.unlanded(branchOf(third)).includes(own.second), 'while the middle entry is queued, the tail\'s tip holds it by construction');
  assert.deepEqual(third.observation!.files, ['src/first.ts', 'src/second.ts', 'src/third.ts'], 'the tail\'s tip lists every unlanded entry ahead against the base branch');
  assert.ok([first, second, third].every(item => item.stage === 'merge' || item.gates.filter(entry => entry.name !== 'merge').every(entry => entry.passed)), 'every tip validates');
  // The middle entry's speculative validation fails: it is ejected, and its branch is restored on the same reconciliation.
  repo.failing.add(tipSecond);
  second = await cycle(github, second);
  assert.equal(second.queue, null); assert.match(second.queueEjection!.reason, /Required CI check test did not pass on speculative tip/);
  assert.equal(second.queueEjection!.sha, tipSecond);
  const restore = second.baseRefresh!;
  assert.deepEqual([restore.restore!.cause, restore.restore!.outcome, restore.restore!.own, restore.restore!.foreign, restore.head], ['ejection', 'restored', own.second, [first.key], own.second]);
  assert.equal(repo.refs.get(`heads/${branchOf(second)}`), own.second, 'the ejected branch is its own reviewed head, which already contains the base');
  assert.equal((await events(second, 'branch.restored')).length, 1);
  assert.equal(ejectedTipRestore(await reload(second), await store.list()), null, 'nothing more is owed');
  // The tail rebuilds its tip from its own reviewed head behind the new predecessor, never over the old tip.
  third = await cycle(github, third);
  const rebuilt = third.queue!.speculation!.tip;
  assert.notEqual(rebuilt, tipThird);
  assert.deepEqual(repo.commits.get(rebuilt)!.parents, [own.third, own.first], 'the new tip is the reviewed head merged onto the predicted base');
  assert.deepEqual(third.queue!.speculation!.predecessors, [first.key]);
  const rebuiltCarry = third.queue!.speculation!.carry!;
  assert.equal(rebuiltCarry.approval.carried, true, rebuiltCarry.approval.reason);
  assert.deepEqual([rebuiltCarry.reviewedFiles, rebuiltCarry.changedFiles], [['src/third.ts'], ['src/second.ts']], 'decided on the tail\'s own files against what the ejection changed');
  third = await cycle(github, third);
  assert.equal(third.candidate!.sha, rebuilt); assert.ok(gate(third, 'review').passed && gate(third, 'acceptance').passed, third.gates.flatMap(entry => entry.reasons).join('; '));
  // Every remaining branch: its own commits, its predicted base's history, nothing of the ejected item.
  const predictedBase = (item: Work) => item.queue?.speculation?.base ?? main;
  for (const [item, ownHead] of [[first, own.first], [third, own.third]] as const) {
    const allowed = new Set([ownHead, item.queue!.speculation!.tip, ...repo.ancestry(predictedBase(item))]);
    const foreign = repo.unlanded(branchOf(item)).filter(sha => !allowed.has(sha));
    assert.deepEqual(foreign, [], `${item.key} carries commits that are neither its own nor its predicted base: ${foreign.join(', ')}`);
    assert.equal(repo.unlanded(branchOf(item)).some(sha => sha === own.second || sha === tipSecond), false, `${item.key} carries nothing of the ejected entry`);
  }
  assert.deepEqual(repo.unlanded(branchOf(second)), [own.second]);
  // The observation names no foreign commits on any branch. The restored head is the reviewed head
  // itself, but nothing carries across a restore, and GitHub's push dismissal on the ejected tip's
  // publication named no merge-base reason: the head is reviewed afresh, on the proofs already bound to it.
  second = await cycle(github, second);
  assert.deepEqual([first, second, third].map(item => item.observation!.landing?.foreign ?? []), [[], [], []]);
  assert.equal(second.candidate!.sha, own.second);
  assert.equal(second.queue, null);
  assert.equal(second.autoDispatch!.review?.state, 'requested', 'the restored head is reviewed afresh');
  assert.ok(gate(second, 'acceptance').passed, gate(second, 'acceptance').reasons.join('; '));
  // Approved again, it re-enters at the back with its own head.
  repo.approve(second.submission!.pr, own.second);
  second = await cycle(github, second);
  assert.ok(second.queue && second.queue.sequence > third.queue!.sequence, 're-entry starts a new sequence at the back');
});

test('integration:contaminated-branch-repaired — a branch already carrying another item\'s unlanded commits is detected, named with the remedy, and repaired on the coordinator\'s request to a submittable head', async () => {
  await clearQueue();
  const repo = new Repo(), github = repo.adapter();
  const main = repo.commit([], 'main'); repo.refs.set('heads/main', main);
  // Another item's unlanded candidate, and a branch whose head is a tip published behind it before the rule existed.
  let foreign = await submitted(repo, 'Foreign candidate', () => repo.commit([main], 'feat: foreign'));
  foreign = await cycle(github, foreign);
  const foreignHead = foreign.candidate!.sha;
  let ownHead = '';
  let work = await submitted(repo, 'Contaminated branch', item => {
    ownHead = repo.commit([main], 'feat: mine');
    return repo.commit([ownHead, foreignHead], `Graphyard speculative tip for ${item.key} behind ${foreign.key}`, { login: APP, type: 'Bot' });
  });
  const contaminated = repo.refs.get(`heads/${branchOf(work)}`)!;
  work = await cycle(github, work);
  assert.deepEqual(work.observation!.landing!.foreign, [{ key: foreign.key, pr: foreign.submission!.pr, head: foreignHead }], 'the observation names the item whose commits the head carries');
  const detected = branchContamination(work, await store.list())!;
  assert.deepEqual([detected.head, detected.foreign, detected.source], [contaminated, [foreign.key], ['observation']]);
  const named = await events(work, 'branch.contaminated');
  assert.equal(named.length, 1); assert.deepEqual(named[0].payload.details.foreign, [foreign.key]);
  assert.equal(ejectedTipRestore(work, await store.list()), null, 'no ejection owes a restore for a head the queue never published');
  const before = buildMasterStatus({ work: [work, foreign], now: new Date().toISOString() }, [], []);
  const row = before.work.find(entry => entry.key === work.key)!;
  assert.deepEqual([row.contamination!.head, row.contamination!.foreign, row.contamination!.restore], [contaminated, [foreign.key], null]);
  assert.match(row.attention!, new RegExp(`carries the unlanded commits of ${foreign.key} .*graphyard master repair ${work.key} REASON restores it to its own reviewed head merged onto the base`));
  assert.match(row.attentionOwner!.next, new RegExp(`graphyard master repair ${work.key} REASON`));
  assert.equal(before.counts.contaminatedBranches, 1);
  assert.match(branchReport(before.work).contaminated[0].line, new RegExp(`^${work.key}: head ${contaminated.slice(0, 12)} carries ${foreign.key}`));
  // The base moves meanwhile, so the repair has something to bring the reviewed head onto.
  const moved = repo.commit([main], 'Merge pull request #2 from elsewhere'); repo.refs.set('heads/main', moved);
  // The repair is the coordinator's request, recorded on the item; nobody else may make it and nothing is repaired twice.
  await assert.rejects(engine.execute(worker, 'repair', work.id, { reason: 'worker asks' }, randomUUID()), /Coordinator permission required/);
  await assert.rejects(engine.execute(coordinator, 'repair', foreign.id, { reason: 'clean branch' }, randomUUID()), /carries no other item's unlanded commits; there is nothing to repair/);
  work = await engine.execute(coordinator, 'repair', work.id, { reason: 'The branch carries a tip published behind the foreign item' }, randomUUID());
  assert.deepEqual([pendingRestore(work)!.cause, pendingRestore(work)!.requested!.by, pendingRestore(work)!.contaminated], ['repair', 'master', contaminated]);
  await assert.rejects(engine.execute(coordinator, 'repair', work.id, { reason: 'again' }, randomUUID()), /already requested/);
  // A merge-base dismissal landing on the head meanwhile restores nothing and leaves the pending repair, which it must not replace.
  repo.approve(work.submission!.pr, contaminated);
  repo.dismiss(work.submission!.pr, mergeBaseMessage, null, 'owner');
  assert.match(buildMasterStatus({ work: [await reload(work), foreign], now: new Date().toISOString() }, [], []).work.find(entry => entry.key === work.key)!.attention!, /A restore is requested \(repair\) and runs on the next reconciliation/);
  // `master repair` is that request: it posts the command with the coordinator credential and refuses a clean branch.
  const root = await temporaryDirectory('master'), credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(48, 'x'), { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: 'http://control-plane.test', credentialFile, cliPath: '/opt/graphyard/cli', repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master' });
  const requests: { url: string; init: any }[] = [];
  const stale = { ...work, baseRefresh: null } as Work;
  const deps = { coordinator: async () => ({ work: [stale, foreign] }), readSecret: async () => '', agents: () => [], daemonLock: async () => null,
    fetcher: (async (url: string, init: any) => { requests.push({ url, init }); return new Response(JSON.stringify({ key: work.key }), { status: 200 }); }) as unknown as typeof fetch };
  await runAutonomyCommand(root, config, 'repair', [work.key, 'The', 'branch', 'carries', 'a', 'foreign', 'tip'], deps);
  assert.equal(requests[0].url, `http://control-plane.test/api/work/${work.id}/repair`);
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${'coordinator-token-'.padEnd(48, 'x')}`);
  assert.deepEqual(JSON.parse(requests[0].init.body), { reason: 'The branch carries a foreign tip' });
  await assert.rejects(runAutonomyCommand(root, config, 'repair', [foreign.key, 'clean'], deps), /carries no other item's unlanded commits/);
  // The reconciliation job runs the restore: the branch is reset to the reviewed head under the tip and merged onto the base.
  work = await cycle(github, work);
  const performed = currentRestore(work)!;
  assert.deepEqual([performed.restore!.outcome, performed.restore!.own, performed.restore!.cause, performed.restore!.requested!.reason], ['restored', ownHead, 'repair', 'The branch carries a tip published behind the foreign item']);
  assert.equal((await events(work, 'review.restored')).length, 0, 'the dismissal on the contaminated head restored nothing and did not drop the requested repair');
  const repaired = repo.refs.get(`heads/${branchOf(work)}`)!;
  assert.equal(performed.head, repaired);
  assert.deepEqual(repo.commits.get(repaired)!.parents, [ownHead, moved], 'the restored head is the item\'s own reviewed head merged onto the base');
  assert.match(repo.commits.get(repaired)!.message, new RegExp(`^Graphyard branch restore for ${work.key} onto main$`));
  assert.equal(repo.calls.filter(call => call.method === 'PATCH' && call.path === `/git/refs/heads/${encodeURIComponent(branchOf(work)).replace(/%2F/g, '/')}`).length, 1, 'one branch move, by the control plane');
  assert.equal((await events(work, 'branch.restored')).length, 1);
  assert.equal(repo.unlanded(branchOf(work)).includes(foreignHead), false, 'nothing of the foreign item remains');
  // The restored head is submittable: observed as the candidate, free of foreign commits, past the build gate.
  work = await cycle(github, work);
  assert.equal(work.candidate!.sha, repaired);
  assert.deepEqual(work.observation!.landing!.foreign, []);
  assert.equal(branchContamination(work, await store.list()), null);
  assert.ok(gate(work, 'build').passed, gate(work, 'build').reasons.join('; '));
  assert.equal(work.observation!.baseTipContained, true);
  const afterRow = buildMasterStatus({ work: [work, foreign], now: new Date().toISOString() }, [], []).work.find(entry => entry.key === work.key)!;
  assert.equal(afterRow.attention, null); assert.equal(afterRow.contamination!.restore!.outcome, 'restored');
  assert.match(branchReport([afterRow]).contaminated[0].line, /restored to own reviewed head .* merged onto the base as/);

  // A head a worker committed on top of a contaminated tip has nothing the control plane can move: it says so, and the remedy is rework.
  let stuck = await submitted(repo, 'Worker on top', item => repo.commit([repo.commit([repo.commit([main], 'feat: stuck'), foreignHead], `Graphyard speculative tip for ${item.key} behind ${foreign.key}`, { login: APP, type: 'Bot' })], 'fix: on top of the tip'));
  stuck = await cycle(github, stuck);
  stuck = await engine.execute(coordinator, 'repair', stuck.id, { reason: 'try' }, randomUUID());
  const stuckHead = stuck.candidate!.sha;
  stuck = await cycle(github, stuck);
  assert.deepEqual([currentRestore(stuck)!.restore!.outcome, currentRestore(stuck)!.restore!.own, repo.refs.get(`heads/${branchOf(stuck)}`)], ['unrepairable', null, stuckHead]);
  assert.equal((await events(stuck, 'branch.unrepairable')).length, 1);
  const stuckRow = buildMasterStatus({ work: [stuck, foreign], now: new Date().toISOString() }, [], []).work.find(entry => entry.key === stuck.key)!;
  assert.match(stuckRow.attention!, /A restore found no own reviewed head under it/);
  assert.match(stuckRow.attentionOwner!.next, new RegExp(`graphyard master decide ${stuck.key} rework REASON`));
  await assert.rejects(engine.execute(coordinator, 'repair', stuck.id, { reason: 'again' }, randomUUID()), /was found unrepairable/);
  // A base branch that moves afterwards does not refresh an unrepairable head: the record that names the remedy stays.
  const movedAgain = repo.commit([moved], 'Merge pull request #3 from elsewhere'); repo.refs.set('heads/main', movedAgain);
  stuck = await cycle(github, stuck);
  assert.deepEqual([stuck.candidate!.sha, pendingBaseRefresh(stuck), currentRestore(stuck)!.restore!.outcome], [stuckHead, null, 'unrepairable']);
  assert.equal((await events(stuck, 'base.refreshed')).length, 0);
  assert.match(buildMasterStatus({ work: [stuck, foreign], now: new Date().toISOString() }, [], []).work.find(entry => entry.key === stuck.key)!.attentionOwner!.next, new RegExp(`graphyard master decide ${stuck.key} rework REASON`));
});

test('manual:queue-tip-protection-docs-review — docs/ states how speculative tips interact with branch protection, why an approval must survive a publication, what a merge-base dismissal means, and how a contaminated branch is repaired', async () => {
  const guide = await readMasterGuide();
  assert.match(guide, /### Speculative tips and branch protection/);
  assert.match(guide, /\*\*An approval must survive a tip publication\.\*\*/);
  assert.match(guide, /\*\*A merge-base dismissal is not a reviewer withdrawing a verdict\.\*\*/);
  assert.match(guide, /The merge-base changed after approval/);
  assert.match(guide, /\*\*A branch must never keep another item's unlanded commits\.\*\*/);
  assert.match(guide, /#### A contaminated branch/);
  assert.match(guide, /master repair GY-42/);
  assert.match(guide, /\| `master repair GY-N REASON` \|/);
  assert.match(guide, /observation\.reviews\[\]\.dismissal/);
  assert.match(guide, /baseRefresh\.restore/);
});
