import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { CHECK_NAME, GitHub, processJob } from '../src/github.js';
import { evaluate, Refusal, type Observation, type Principal, type Work } from '../src/model.js';
import { buildMasterStatus } from '../src/master.js';
import { ejectionReason } from '../src/merge-queue.js';

// GY-97. Each test is named for the proof it produces, so acceptance evidence maps to one
// executed case per required proof: integration:revert-recheck-on-base-advance,
// integration:deletion-by-stale-base, manual:gy-84-content-restored, unit:reverted-delivery-visible.

// ---- A repository: commits with trees and parents, behind the request surface the adapter uses ----

type Tree = Record<string, string>;
const hash = (text: string) => createHash('sha1').update(text).digest('hex');
/** Blob identity, with the content kept so the merge below can do a real three-way merge of one file. */
const contents = new Map<string, string>();
const blob = (content: string) => { const sha = hash(`blob:${content}`); contents.set(sha, content); return sha; };
const APP = 1234, CI = 15368;

/** The line-level part of that merge: both sides changed the file, so every addition is kept and every removal applied. */
function mergeText(base: string | undefined, left: string | undefined, right: string | undefined): string | 'conflict' {
  if (!base || !left || !right) return 'conflict';
  const lines = (sha: string) => (contents.get(sha) ?? sha).split('\n');
  const [o, l, r] = [lines(base), lines(left), lines(right)];
  const removed = new Set(o.filter(line => !l.includes(line) || !r.includes(line)));
  const ordered = [...o, ...l.filter(line => !o.includes(line)), ...r.filter(line => !o.includes(line) && !l.includes(line))];
  return blob(ordered.filter(line => !removed.has(line)).join('\n'));
}

class Repository {
  commits = new Map<string, { tree: Tree; parents: string[]; message: string }>();
  pulls = new Map<number, any>();
  main = '';
  requests: string[] = [];
  commit(message: string, tree: Tree, parents: string[]) {
    const sha = hash(`commit:${message}:${JSON.stringify(tree)}:${parents.join(',')}`);
    this.commits.set(sha, { tree, parents, message });
    return sha;
  }
  /** A child of `parent` that writes (content) or deletes (null) the named paths. */
  change(message: string, parent: string, changes: Record<string, string | null>) {
    const tree = { ...this.tree(parent) };
    for (const [path, content] of Object.entries(changes)) { if (content === null) delete tree[path]; else tree[path] = blob(content); }
    return this.commit(message, tree, [parent]);
  }
  tree(sha: string) { const commit = this.commits.get(sha); assert.ok(commit, `unknown commit ${sha}`); return commit.tree; }
  ancestors(sha: string) {
    const seen = new Set<string>(), queue = [sha];
    while (queue.length) { const next = queue.pop()!; if (seen.has(next)) continue; seen.add(next); queue.push(...this.commits.get(next)!.parents); }
    return seen;
  }
  contains(base: string, head: string) { return this.ancestors(head).has(base); }
  mergeBase(a: string, b: string) {
    const ours = this.ancestors(a), common = [...this.ancestors(b)].filter(sha => ours.has(sha));
    return common.find(sha => !common.some(other => other !== sha && this.ancestors(other).has(sha)))!;
  }
  /**
   * Git's three-way merge by blob identity: a side that left a path alone takes the other side's
   * version. A file both sides changed is merged line by line — each side's added lines are kept
   * and a line either side removed is removed, which is what git does when two branches edit
   * different sections of one file. A file one side deleted and the other changed conflicts.
   */
  merge(message: string, ours: string, theirs: string): string | 'conflict' {
    const base = this.tree(this.mergeBase(ours, theirs)), left = this.tree(ours), right = this.tree(theirs), tree: Tree = {};
    for (const path of new Set([...Object.keys(base), ...Object.keys(left), ...Object.keys(right)])) {
      const [o, l, r] = [base[path], left[path], right[path]];
      const taken = l === r ? l : l === o ? r : r === o ? l : mergeText(o, l, r);
      if (taken === 'conflict') return 'conflict';
      if (taken) tree[path] = taken;
    }
    return this.commit(message, tree, [ours, theirs]);
  }
  /** The provider's file records for `from...to`: the merge base compared with `to`. */
  diff(from: string, to: string) {
    const before = this.tree(this.mergeBase(from, to)), after = this.tree(to);
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(path => before[path] !== after[path]).map(path => ({
      filename: path, status: !before[path] ? 'added' : !after[path] ? 'removed' : 'modified', sha: after[path] ?? before[path], additions: after[path] ? 3 : 0, deletions: before[path] ? 2 : 0, patch: '@@' }));
  }
  /** `git log -1 -- path` with history simplification: a commit that holds the path as one of its parents does is skipped for that parent. */
  lastTouching(sha: string, path: string): string | null {
    let at = sha;
    for (;;) {
      const { parents, tree } = this.commits.get(at)!;
      const same = parents.find((parent: string) => this.tree(parent)[path] === tree[path]);
      if (same === undefined) return parents.length || tree[path] ? at : null;
      at = same;
    }
  }
  open(number: number, branch: string, head: string) {
    this.pulls.set(number, { number, head: { sha: head, ref: branch, repo: { full_name: 'owner/project' } }, base: { sha: this.main, ref: 'main', repo: { full_name: 'owner/project' } },
      user: { login: 'implementer', id: 7 }, merged: false, mergeable: true, draft: false, state: 'open', merge_commit_sha: null, merged_at: null, created_at: '2026-09-20T10:00:00Z' });
  }
  /** Land a pull request as the provider does: a merge commit on main, and every open pull request whose head that makes reachable is recorded merged with it. */
  land(number: number, at: string) {
    const pr = this.pulls.get(number)!;
    const merged = this.merge(`Merge pull request #${number}`, this.main, pr.head.sha);
    assert.notEqual(merged, 'conflict');
    const before = this.main; this.main = merged as string;
    Object.assign(pr, { merged: true, state: 'closed', merge_commit_sha: this.main, merged_at: at, base: { ...pr.base, sha: before } });
    for (const other of this.pulls.values()) if (!other.merged && other.state === 'open' && this.contains(other.head.sha, this.main))
      Object.assign(other, { merged: true, state: 'closed', merge_commit_sha: other.head.sha, merged_at: at, base: { ...other.base, sha: before } });
    return this.main;
  }
  github() {
    const github = new GitHub({ repository: 'owner/project', base: 'main', appId: APP, installationId: 1, privateKey: 'not-used-by-the-adapter-under-test' });
    github.controlPlaneLogin = async () => 'graphyard-owner-project[bot]';
    github.request = async (path: string, method = 'GET', body?: any) => {
      this.requests.push(`${method} ${path}`);
      if (path === '/merges' && method === 'POST') {
        const pr = [...this.pulls.values()].find(entry => entry.head.ref === body.base)!;
        if (this.contains(body.head, pr.head.sha)) return null;
        const merged = this.merge(body.commit_message, pr.head.sha, body.head);
        if (merged === 'conflict') throw new Refusal('GitHub POST /merges failed (409)', 502);
        pr.head.sha = merged; return { sha: merged };
      }
      if (method !== 'GET') return { id: 12 };
      const [route, query = ''] = path.split('?'), params = new URLSearchParams(query);
      if (route === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: this.main } };
      if (route === '/commits') { const sha = this.lastTouching(params.get('sha')!, params.get('path')!); return sha ? [{ sha }] : []; }
      let match = /^\/commits\/([a-f0-9]{40})\/pulls$/.exec(route);
      if (match) return [...this.pulls.values()].filter(pr => this.contains(match![1], pr.head.sha)).map(pr => structuredClone(pr));
      match = /^\/commits\/([a-f0-9]{40})\/check-runs$/.exec(route);
      if (match) return { check_runs: ['test', 'typecheck'].map((name, index) => ({ id: index + 1, name, status: 'completed', conclusion: 'success', app: { id: CI } })) };
      match = /^\/commits\/([a-f0-9]{40})$/.exec(route);
      if (match) { const commit = this.commits.get(match[1])!; return { sha: match[1], parents: commit.parents.map(sha => ({ sha })), author: { login: 'graphyard-owner-project[bot]', type: 'Bot' }, commit: { tree: { sha: hash(`tree:${JSON.stringify(Object.entries(commit.tree).sort())}`) }, author: { email: 'bot@users.noreply.github.com' } } }; }
      match = /^\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/.exec(route);
      // The database outlives a scenario: a candidate of an earlier scenario's repository is a commit this one never heard of.
      if (match && !this.commits.has(match[1])) return { status: 'diverged', files: [] };
      if (match) return { status: match[1] === match[2] ? 'identical' : this.contains(match[1], match[2]) ? 'ahead' : 'diverged', files: params.get('page') && params.get('page') !== '1' ? [] : this.diff(match[1], match[2]) };
      match = /^\/contents\/(.+)$/.exec(route);
      if (match) { const held = this.tree(params.get('ref')!)[decodeURIComponent(match[1])]; if (!held) throw new Refusal(`GitHub GET ${path} failed (404)`, 502); return { type: 'file', sha: held }; }
      match = /^\/pulls\/(\d+)(\/files|\/reviews)?$/.exec(route);
      if (match) {
        const pr = this.pulls.get(Number(match[1]))!;
        if (!match[2]) return structuredClone(pr);
        if (params.get('page') !== '1') return [];
        if (match[2] === '/reviews') return [{ id: 40 + pr.number, user: { login: 'graphyard-reviewer[bot]' }, commit_id: pr.head.sha, state: 'APPROVED', submitted_at: '2026-09-20T10:05:00Z' }];
        // A merged pull request keeps the diff it merged with; an open one is recomputed against the moving base.
        return this.diff(pr.merged ? pr.base.sha : this.main, pr.head.sha);
      }
      if (route.endsWith('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: APP }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
      throw new Error(`Unexpected request ${method} ${path}`);
    };
    return github;
  }
}

/**
 * The history both incidents share. GY-A adds src/a.ts. GY-B's branch was once advanced to a
 * speculative tip that carried GY-A's first head, and GY-B's worker — correctly, then — dropped
 * that content in a commit of its own. GY-A has been reworked since, so GY-B's head no longer
 * carries GY-A's current head: only the old commit that added the file, and the one that deleted it.
 */
function history(a = 'a') {
  const repo = new Repository();
  repo.main = repo.commit('main', { 'src/base.ts': blob('base') }, []);
  const a1 = repo.change('GY-A: add a', repo.main, { [`src/${a}.ts`]: 'a', [`tests/${a}.test.ts`]: 'a test' });
  const a2 = repo.change('GY-A: rework', a1, { [`docs/${a}.md`]: 'a guide' });
  const b0 = repo.change('GY-B: add b', repo.main, { 'src/b.ts': 'b' });
  const tip = repo.merge('Graphyard speculative tip for GY-B behind GY-A', b0, a1) as string;
  const b1 = repo.change('GY-B: carry only this item\'s changes', tip, { [`src/${a}.ts`]: null, [`tests/${a}.test.ts`]: null });
  return { repo, a1, a2, b0, b1 };
}

/**
 * Three entries, two of which change one file. GY-A and GY-C each add a section to docs/<name>.md,
 * a file outside GY-B's planned files that GY-B never touches; git merges the two sections. With
 * `drops`, GY-B's branch also carries GY-A's added file from an older speculative tip and deletes
 * it, as history() does — the one real revert among the three.
 */
function trio(name: string, drops: boolean) {
  const repo = new Repository();
  repo.main = repo.commit('main', { 'src/base.ts': blob('base'), [`docs/${name}.md`]: blob('shared') }, []);
  const a1 = repo.change('GY-A: add a', repo.main, { [`src/${name}-a.ts`]: 'a', [`docs/${name}.md`]: 'shared\na section' });
  const c1 = repo.change('GY-C: add c', repo.main, { [`src/${name}-c.ts`]: 'c', [`docs/${name}.md`]: 'shared\nc section' });
  const b0 = repo.change('GY-B: add b', repo.main, { [`src/${name}-b.ts`]: 'b' });
  const b1 = drops ? repo.change('GY-B: carry only this item\'s changes', repo.merge('Graphyard speculative tip for GY-B behind GY-A', b0, a1) as string, { [`src/${name}-a.ts`]: null }) : b0;
  return { repo, a1, c1, b1 };
}

const item = (key: string, pr: number, plannedFiles: string[], head: string, baseSha: string, overrides: Partial<Work> = {}): Work => ({
  id: key.toLowerCase(), key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:landing'] }],
  policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles, stage: 'merge', revision: 3, policyRevision: 1, createdAt: '2026-09-20T09:00:00Z', updatedAt: '2026-09-20T09:00:00Z',
  stageEnteredAt: '2026-09-20T09:00:00Z', ready: true, epoch: 1, lease: null, workspaces: [{ host: 'machine', path: `/w/${key}`, branch: `graphyard/${key.toLowerCase()}-1`, epoch: 1, owner: 'implementer' }],
  candidate: { sha: head, baseSha, pr, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' }, submission: { epoch: 1, pr }, reworkRequested: false, scenarioRequirements: [],
  evidence: [], observation: null, blocker: null, gates: [], violations: [], ...overrides } as unknown as Work);
const buildReasons = (work: Work, all: Work[]) => evaluate(work, all.map(entry => entry.id === work.id ? work : entry), new Date(), [CI]).gates.find(gate => gate.name === 'build')!.reasons;

test('integration:deletion-by-stale-base — a deletion the merge would apply and the candidate\'s own diff does not show is refused: behind an unlanded entry, under a held base the branch moved past, and when the owner\'s pull request would be recorded merged with none of its content', async () => {
  // 1. Queued behind GY-A. The pull request's diff is taken against main, which holds no src/a.ts
  //    yet, so the file GY-B's tip deletes from its predicted base appears in that diff nowhere.
  const queued = history();
  queued.repo.open(1, 'graphyard/gy-a-1', queued.a2); queued.repo.open(2, 'graphyard/gy-b-1', queued.b1);
  const github = queued.repo.github();
  const ahead = item('GY-A', 1, ['src/a.ts', 'tests/', 'docs/'], queued.a2, queued.repo.main);
  ahead.observation = await github.observe(ahead);
  const tip = queued.repo.merge('Graphyard speculative tip for GY-B behind GY-A', queued.b1, queued.a2) as string;
  assert.equal(queued.repo.tree(tip)['src/a.ts'], undefined, 'git merges the deletion in cleanly: GY-A left the file alone since the commit GY-B deleted it from');
  queued.repo.pulls.get(2)!.head.sha = tip;
  const behind = item('GY-B', 2, ['src/b.ts'], tip, queued.a2, { queue: { sequence: 2, enqueuedAt: '2026-09-20T10:00:00Z', policyRevision: 1,
    speculation: { ref: 'refs/graphyard/queue/gy-b', tip, base: queued.a2, baseTree: 'unused'.padEnd(40, '0'), predecessors: ['GY-A'], policyRevision: 1, publishedAt: '2026-09-20T10:01:00Z' } }, queueSequence: 2 } as Partial<Work>);
  const observed = await github.observe(behind, [ahead, behind]);
  assert.deepEqual(observed.files, ['docs/a.md', 'src/b.ts'], 'the candidate\'s own diff never mentions the files it would delete');
  assert.deepEqual(buildReasons({ ...behind, observation: { ...observed, landing: undefined } }, [ahead, behind]), [], 'so the comparison with its bound base, the only one there was, passes');
  assert.equal(observed.landing!.base, queued.a2, 'a tip behind an unlanded entry lands on its predicted base');
  assert.deepEqual(observed.landing!.files!.filter(file => file.status === 'removed').map(file => [file.path, file.baseSha]), [['src/a.ts', blob('a')], ['tests/a.test.ts', blob('a test')]]);
  const refused = buildReasons({ ...behind, observation: observed }, [ahead, behind]);
  assert.match(refused[0], new RegExp(`Landing the candidate on ${queued.a2.slice(0, 12)}, the commit it would merge onto, would revert 2 files outside its planned files`));
  assert.match(refused[1], /^Landing regression: src\/a\.ts: deleted; that commit still holds it \(owned by GY-A, ahead of it and not yet landed\)$/);
  assert.match(refused[2], /^Landing regression: tests\/a\.test\.ts: deleted; that commit still holds it \(owned by GY-A/);

  // 2. Not queued, head unchanged. GY-A lands after GY-B was submitted; the bound base is held
  //    while the head is unchanged, and at that commit the files are absent, so the comparison
  //    `complete` ran still passes. Where the merge would land, they are there to be deleted.
  const held = history();
  held.repo.open(1, 'graphyard/gy-a-1', held.a2); held.repo.open(2, 'graphyard/gy-b-1', held.b1);
  const submittedBase = held.repo.main, adapter = held.repo.github();
  let candidate = item('GY-B', 2, ['src/b.ts'], held.b1, submittedBase, { stage: 'review' });
  const atSubmit = await adapter.observe(candidate);
  assert.deepEqual([atSubmit.candidate.baseSha, atSubmit.landing, buildReasons({ ...candidate, observation: atSubmit }, [candidate])], [submittedBase, { base: submittedBase }, []],
    'right when it was written: the base held none of GY-A, and the candidate lands where it is bound');
  candidate = { ...candidate, observation: atSubmit };
  const landed = held.repo.land(1, '2026-09-20T11:00:00Z');
  const owner = item('GY-A', 1, ['src/a.ts', 'tests/', 'docs/'], held.a2, submittedBase, { stage: 'done', observation: { merged: true, files: ['src/a.ts', 'tests/a.test.ts', 'docs/a.md'] } as Observation });
  const moved = await adapter.observe(candidate, [owner, candidate]);
  assert.deepEqual([moved.candidate.sha, moved.candidate.baseSha, moved.baseTip], [held.b1, submittedBase, landed], 'an unchanged head holds the base it was bound to');
  assert.deepEqual(moved.scopeFiles!.filter(file => file.status === 'removed').map(file => file.baseSha), [null, null], 'against the submitted base the deletions are of files that base never held, which passes');
  assert.deepEqual(moved.landing!.files!.filter(file => file.status === 'removed').map(file => [file.path, file.baseSha]), [['src/a.ts', blob('a')], ['tests/a.test.ts', blob('a test')]]);
  const stale = buildReasons({ ...candidate, observation: moved }, [owner, candidate]);
  assert.equal(stale.length, 3);
  assert.match(stale[1], /^Landing regression: src\/a\.ts: deleted; that commit still holds it \(shipped by GY-A\)$/);

  // 3. GY-93 and GY-84 as it happened. The head carries the owner's current head and none of its
  //    content, and the base never held it either: no diff against any base shows a thing, and
  //    merging would make the provider record the owner's pull request merged.
  const carried = history();
  carried.repo.open(1, 'graphyard/gy-a-1', carried.a1); carried.repo.open(2, 'graphyard/gy-b-1', carried.b1);
  const provider = carried.repo.github();
  const unlanded = item('GY-A', 1, ['src/a.ts', 'tests/'], carried.a1, carried.repo.main);
  unlanded.observation = await provider.observe(unlanded);
  const swallowing = item('GY-B', 2, ['src/b.ts'], carried.b1, carried.repo.main);
  const seen = await provider.observe(swallowing, [unlanded, swallowing]);
  assert.deepEqual(seen.scopeFiles!.map(file => file.path), ['src/b.ts']); assert.equal(seen.landing!.files, undefined);
  assert.deepEqual(seen.landing!.carried, [{ key: 'GY-A', pr: 1, head: carried.a1, dropped: [
    { path: 'src/a.ts', detail: 'the file is absent from this head and from the commit it would land on' }, { path: 'tests/a.test.ts', detail: 'the file is absent from this head and from the commit it would land on' }] }]);
  const swallowed = buildReasons({ ...swallowing, observation: seen }, [unlanded, swallowing]);
  assert.match(swallowed[1], /^Landing regression: src\/a\.ts: this head carries GY-A's commits but not this change .* merging it would record GY-A merged without it \(owned by GY-A, unlanded pull request #1 at /);
  // Unchanged inputs are not asked about again; a legitimate tip that carries its predecessor whole is not refused.
  const before = carried.repo.requests.length;
  const again = await provider.observe({ ...swallowing, observation: seen }, [unlanded, swallowing]);
  assert.deepEqual(again.landing, seen.landing);
  assert.equal(carried.repo.requests.slice(before).some(request => request.includes('/contents/')), false, 'the recorded answer stands while the head, the landing commit and the open candidates are unchanged');
  const whole = history();
  whole.repo.open(1, 'graphyard/gy-a-1', whole.a1); whole.repo.open(2, 'graphyard/gy-b-1', whole.repo.merge('tip', whole.b0, whole.a1) as string);
  const intactOwner = item('GY-A', 1, ['src/a.ts', 'tests/'], whole.a1, whole.repo.main);
  intactOwner.observation = await whole.repo.github().observe(intactOwner);
  const intact = await whole.repo.github().observe(item('GY-B', 2, ['src/b.ts'], whole.repo.pulls.get(2)!.head.sha, whole.repo.main), [intactOwner]);
  assert.deepEqual(intact.landing!.carried, [], 'a head that carries another candidate and holds its files as it shipped them reverts nothing');
});

// ---- The control plane: the real engine on a real database, the real adapter on the repository ----

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:landing'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_REVERT_RECHECK_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 31);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-revert-recheck-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [CI], 120, 'owner/project'); engine.controlPlaneAppId = APP;
  engine.principals = [operator, worker, coordinator, producer];
  engine.submissionObserver = null;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const reload = async (work: Work) => (await store.list()).find(entry => entry.id === work.id)!;
async function submitted(title: string, plannedFiles: string[], pr: number) {
  let work = await engine.execute(operator, 'create', null, { title, plannedFiles, criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:landing'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/recheck/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  return engine.execute(worker, 'submit', work.id, { epoch: 1, pr }, randomUUID());
}
/** One reconciliation job for exactly this item, as the control plane runs it. */
async function job(work: Work, github: GitHub) {
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
  await store.pool.query(`INSERT INTO jobs(work_id) VALUES($1) ON CONFLICT (work_id) DO NOTHING`, [work.id]);
  await store.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL,attempts=0 WHERE work_id=$1', [work.id]);
  await processJob(engine, github);
  assert.equal((await store.pool.query('SELECT error FROM jobs WHERE work_id=$1', [work.id])).rows[0]?.error ?? null, null, 'the reconciliation job ran clean');
  return reload(work);
}
const prove = async (work: Work) => engine.execute(producer, 'evidence', work.id, { proof: 'unit:landing', sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, randomUUID());

/** The guarded merge as the control plane requests it, through to GitHub's landing and the item's own reconciliation. */
async function landed(work: Work, pr: number, sha: string, github: GitHub, repo: Repository) {
  const current = await reload(work);
  await engine.requestEnqueue(coordinator, current.id, { enqueue: true, expectedRevision: current.revision, sha, baseSha: current.candidate!.baseSha, policyRevision: 1 }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  repo.land(pr, mergedAt);
  return job(current, github);
}

test('integration:revert-recheck-on-base-advance — two overlapping candidates queue, the first lands, and the second is re-checked against the base it would now land on: it is ejected naming the files and the item that owns them, and its merge is refused rather than deleting them', async () => {
  const { repo, a2, b1 } = history();
  const github = repo.github();
  github.publish = async () => {};
  let first = await submitted('Adds a', ['src/a.ts', 'tests/', 'docs/'], 1), second = await submitted('Adds b', ['src/b.ts'], 2);
  repo.open(1, first.workspaces[0].branch, a2); repo.open(2, second.workspaces[0].branch, b1);

  // Both are clean against the base they were submitted on, proved and approved, so both queue;
  // the control plane publishes the first's tip, then the second's on top of it.
  first = await job(first, github); first = await prove(first); first = await job(first, github); first = await job(first, github);
  assert.deepEqual([first.stage, first.queue?.speculation?.tip, first.gates.every(gate => gate.passed)], ['merge', a2, true]);
  second = await job(second, github);
  assert.deepEqual(second.gates.find(gate => gate.name === 'build')!.reasons, [], 'right when it was submitted: main holds none of the first item\'s files');
  second = await prove(second); second = await job(second, github);
  const tip = repo.pulls.get(2)!.head.sha;
  assert.notEqual(tip, b1); assert.deepEqual(repo.commits.get(tip)!.parents, [b1, a2], 'the second entry\'s tip is its head merged with the tip ahead of it');
  assert.deepEqual([second.queue?.speculation?.tip, second.queue?.speculation?.base, second.queue?.speculation?.predecessors], [tip, a2, [first.key]]);

  // The first lands through the guarded merge. Main now holds src/a.ts, and the second entry's
  // unchanged tip — never re-submitted, no new head — would delete it.
  const current = await reload(first);
  await engine.requestEnqueue(coordinator, current.id, { enqueue: true, expectedRevision: current.revision, sha: a2, baseSha: current.candidate!.baseSha, policyRevision: 1 }, randomUUID());
  await delay(5); const mergedAt = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString(); await delay(5);
  const main = repo.land(1, mergedAt);
  first = await job(first, github);
  assert.deepEqual([first.stage, first.delivery?.mergeSha], ['done', main]);
  assert.equal(repo.tree(main)['src/a.ts'], blob('a'));

  // The base advanced under the queued entry: it is re-checked before it can merge.
  second = await job(second, github);
  assert.equal(second.candidate!.sha, tip, 'the head never changed');
  assert.equal(second.queue, null, 'the entry left the queue');
  assert.match(second.queueEjection!.reason, new RegExp(`^Landing speculative tip ${tip.slice(0, 12)} on [a-f0-9]{12} would revert work outside its planned files: src/a\\.ts: deleted; the base branch still holds it \\(shipped by ${first.key}\\); tests/a\\.test\\.ts: deleted; the base branch still holds it \\(shipped by ${first.key}\\)$`));
  const ejected = (await store.events(second.id)).filter(event => event.kind === 'queue.ejected');
  assert.equal(ejected.length, 1); assert.equal(ejected[0].payload.details.reason, second.queueEjection!.reason);
  assert.equal(second.stage, 'build'); assert.equal(second.mergeAuthorization, null);
  assert.match(second.gates.find(gate => gate.name === 'build')!.reasons.join('\n'), new RegExp(`Out-of-scope regression: src/a\\.ts: deleted; the base branch still holds it \\(shipped by ${first.key}\\)`));
  await assert.rejects(engine.requestEnqueue(coordinator, second.id, { enqueue: true, expectedRevision: second.revision, sha: tip, baseSha: second.candidate!.baseSha, policyRevision: 1 }, randomUUID()), /Merge authorization is no longer current/, 'no merge is requested for it');
  assert.deepEqual([repo.main, repo.tree(repo.main)['src/a.ts'], repo.tree(repo.main)['tests/a.test.ts']], [main, blob('a'), blob('a test')], 'the first item\'s files are still on the base branch');
  assert.equal((await job(second, github)).queue, null, 'the same head does not re-enter; a new candidate re-enters at the back');

  // The same verdict is reached while the first entry is still ahead, from the predicted base
  // alone: nothing has to land for the entry to be refused.
  const early = history('early'), provider = early.repo.github(); provider.publish = async () => {};
  let ahead = await submitted('Adds a again', ['src/early.ts', 'tests/', 'docs/'], 3), behind = await submitted('Adds b again', ['src/b.ts'], 4);
  early.repo.open(3, ahead.workspaces[0].branch, early.a2); early.repo.open(4, behind.workspaces[0].branch, early.b1);
  ahead = await job(ahead, provider); ahead = await prove(ahead); ahead = await job(ahead, provider); ahead = await job(ahead, provider);
  behind = await job(behind, provider); behind = await prove(behind); behind = await job(behind, provider);
  assert.equal(behind.queue?.speculation?.base, early.a2);
  behind = await job(behind, provider);
  assert.equal(behind.queue, null);
  assert.match(behind.queueEjection!.reason, new RegExp(`on ${early.a2.slice(0, 12)} would revert work outside its planned files: src/early\\.ts: deleted; that commit still holds it \\(owned by ${ahead.key}, ahead of it and not yet landed\\)`));
  assert.equal((await reload(ahead)).queue?.sequence, ahead.queue!.sequence, 'the entry ahead keeps its place');
  ahead = await landed(ahead, 3, early.a2, provider, early.repo);
  assert.equal(ahead.stage, 'done', 'and lands, leaving the queue to the entries behind it');

  // Three entries, the last of them behind two that both change one file. That file is outside the
  // last entry's planned files and it never touches it, so its tip holds the two changes merged —
  // which on a predicted base is how every predecessor's file stands, and is not a revert.
  const kept = trio('kept', false), adapter = kept.repo.github();
  adapter.publish = async () => {};
  let one = await submitted('Adds kept a', ['src/kept-a.ts', 'docs/'], 5);
  let two = await submitted('Adds kept c', ['src/kept-c.ts', 'docs/'], 6);
  let three = await submitted('Adds kept b', ['src/kept-b.ts'], 7);
  kept.repo.open(5, one.workspaces[0].branch, kept.a1);
  kept.repo.open(6, two.workspaces[0].branch, kept.c1);
  kept.repo.open(7, three.workspaces[0].branch, kept.b1);
  one = await job(one, adapter); one = await prove(one); one = await job(one, adapter); one = await job(one, adapter);
  two = await job(two, adapter); two = await prove(two); two = await job(two, adapter); two = await job(two, adapter);
  assert.deepEqual([one.queue?.speculation?.tip, two.queue?.speculation?.predecessors], [kept.a1, [one.key]], 'the second entry is published behind the first');
  three = await job(three, adapter); three = await prove(three); three = await job(three, adapter);
  const behindBoth = three.queue!.speculation!.tip, secondTip = two.queue!.speculation!.tip;
  assert.deepEqual(three.queue!.speculation!.predecessors, [one.key, two.key], 'the third entry is published behind both');
  assert.equal(kept.repo.tree(behindBoth)['docs/kept.md'], kept.repo.tree(secondTip)['docs/kept.md'], 'its tip holds the file both entries ahead changed, merged, exactly as the commit it would land on holds it');
  assert.notEqual(kept.repo.tree(behindBoth)['docs/kept.md'], kept.repo.tree(kept.repo.main)['docs/kept.md'], 'and not as the base branch holds it');

  // The re-check, with both entries ahead still open and unlanded.
  const place = three.queue!.sequence;
  three = await job(three, adapter);
  assert.deepEqual(three.observation!.landing!.carried, [], 'the entries ahead are in the base it lands on, so neither is reported carried without its content');
  assert.deepEqual([three.queue?.sequence, three.queueEjection], [place, null], 'the entry keeps its place: it reverts nothing');
  assert.deepEqual(three.gates.find(gate => gate.name === 'build')!.reasons, [], 'a file two entries ahead both changed is not a file this one dropped');
  assert.match(three.gates.find(gate => gate.name === 'merge')!.reasons.join('; '), new RegExp(`^Merge queue position 3 of 3: ${two.key} is ahead`), 'it waits its turn behind them, and for fresh proof of the authored tip; it is not refused');
  assert.equal((await reload(one)).queue?.sequence, one.queue!.sequence, 'the entries ahead keep their places');
  assert.equal((await reload(two)).queue?.sequence, two.queue!.sequence);

  // The same three entries where the last one really does delete a file the first added: ejected,
  // naming that file and its owner, and not the file the two entries ahead share.
  const dropped = trio('dropped', true), provider2 = dropped.repo.github();
  const firstTip = dropped.a1, middleTip = dropped.repo.merge('Graphyard speculative tip for GY-C behind GY-A', dropped.c1, firstTip) as string;
  const lastTip = dropped.repo.merge('Graphyard speculative tip for GY-B behind GY-A, GY-C', dropped.b1, middleTip) as string;
  dropped.repo.open(8, 'graphyard/gy-a-1', firstTip); dropped.repo.open(9, 'graphyard/gy-c-1', middleTip); dropped.repo.open(10, 'graphyard/gy-b-1', lastTip);
  const owner = item('GY-A', 8, ['src/dropped-a.ts', 'docs/'], firstTip, dropped.repo.main);
  const middle = item('GY-C', 9, ['src/dropped-c.ts', 'docs/'], middleTip, firstTip);
  owner.observation = await provider2.observe(owner); middle.observation = await provider2.observe(middle);
  const last = item('GY-B', 10, ['src/dropped-b.ts'], lastTip, middleTip, { queue: { sequence: 3, enqueuedAt: '2026-09-20T10:00:00Z', policyRevision: 1,
    speculation: { ref: 'refs/graphyard/queue/gy-b', tip: lastTip, base: middleTip, baseTree: 'unused'.padEnd(40, '0'), predecessors: ['GY-A', 'GY-C'], policyRevision: 1, publishedAt: '2026-09-20T10:01:00Z' } }, queueSequence: 3 } as Partial<Work>);
  assert.equal(dropped.repo.tree(lastTip)['docs/dropped.md'], dropped.repo.tree(middleTip)['docs/dropped.md'], 'the shared file stands in this tip as it stands in the commit it would land on');
  assert.equal(dropped.repo.tree(lastTip)['src/dropped-a.ts'], undefined, 'and the file the first entry added is gone from it');
  last.observation = await provider2.observe(last, [owner, middle, last]);
  assert.deepEqual(last.observation.landing!.carried, [], 'the entries ahead are judged where the tip lands, not as candidates it carries without their content');
  const refusal = ejectionReason(last, [CI], [owner, middle, last]);
  assert.match(refusal!, new RegExp(`^Landing speculative tip ${lastTip.slice(0, 12)} on ${middleTip.slice(0, 12)} would revert work outside its planned files: src/dropped-a\\.ts: deleted; that commit still holds it \\(owned by GY-A, GY-C, ahead of it and not yet landed\\)$`), 'both entries ahead hold the file, so both are named as owners');
  assert.equal(ejectionReason({ ...last, observation: { ...last.observation, landing: undefined } } as Work, [CI], [owner, middle, last]), null, 'which only the landing check sees: the candidate\'s own diff against its base shows none of it');
});

// ---- A reverted delivery is visible as one ----

test('unit:reverted-delivery-visible — a merged item whose content is not on the base branch is reported as a reverted delivery, naming the item, the files missing from the base and the merge that removed them, and never as an ordinary unreconciled merge', async () => {
  // As GY-84 and GY-93: the swallowing head lands, the provider records the owner's pull request
  // merged in the same push, and main never holds a line of it.
  const { repo, a1, b1 } = history();
  repo.open(1, 'graphyard/gy-a-1', a1); repo.open(2, 'graphyard/gy-b-1', b1);
  const github = repo.github();
  const owner = item('GY-A', 1, ['src/a.ts', 'tests/'], a1, repo.main), swallowing = item('GY-B', 2, ['src/b.ts'], b1, repo.main);
  const main = repo.land(2, '2026-09-21T02:37:05Z');
  assert.deepEqual([repo.pulls.get(1)!.merged, repo.tree(main)['src/a.ts']], [true, undefined]);
  swallowing.observation = await github.observe(swallowing, [owner, swallowing]);
  assert.equal(swallowing.observation.revertedDelivery, undefined, 'the merge that landed its own content is an ordinary merge');
  const observed = await github.observe(owner, [owner, swallowing]);
  assert.deepEqual(observed.revertedDelivery, { base: main, files: [{ path: 'src/a.ts', detail: 'absent from the base branch' }, { path: 'tests/a.test.ts', detail: 'absent from the base branch' }],
    removedBy: { key: 'GY-B', pr: 2, mergeSha: main, commit: null } });

  const violation = 'Merge observed without a prior authorization for this candidate';
  const reverted = { ...owner, observation: observed, violations: [violation] } as Work;
  const ordinary = { ...swallowing, violations: [violation] } as Work;
  const now = '2026-09-21T03:00:00.000Z';
  const status = buildMasterStatus({ work: [reverted, ordinary], now }, [], []);
  const row = status.work.find(entry => entry.key === 'GY-A')!;
  assert.match(row.attention!, new RegExp(`^GY-A was merged on GitHub \\(${a1.slice(0, 12)} at 2026-09-21T02:37:05Z\\) and its content is not on the base branch: 2 files missing from base ${main.slice(0, 12)} — src/a\\.ts \\(absent from the base branch\\), tests/a\\.test\\.ts \\(absent from the base branch\\) — removed by merge ${main.slice(0, 12)} of GY-B, pull request #2, whose head carried this item's commits without their content\\. This is a reverted delivery, not an unreconciled merge`));
  assert.deepEqual(row.merged!.reverted, { base: main, files: observed.revertedDelivery!.files, removedBy: observed.revertedDelivery!.removedBy, partial: false });
  assert.match(row.attentionOwner!.next, /graphyard master create FILE for a follow-up item that restores src\/a\.ts, tests\/a\.test\.ts to the base branch as GY-A shipped them, naming merge [a-f0-9]{12} of GY-B/);
  assert.match(row.attentionOwner!.next, /request no merge decision for GY-A until the base branch holds its content/);
  const plain = status.work.find(entry => entry.key === 'GY-B')!;
  assert.match(plain.attention!, /without a valid merge execution/); assert.equal(plain.merged!.reverted, undefined);
  assert.deepEqual([status.counts.revertedDeliveries, status.counts.mergedUnreconciled], [1, 1], 'the two are counted apart');
  assert.ok(status.attentionItems.some(entry => entry.subject === 'GY-A' && /reverted delivery/.test(entry.text)));
  // Reported even when the merge itself was authorized: the content is gone either way.
  const authorized = buildMasterStatus({ work: [{ ...reverted, violations: [] } as Work], now }, [], []).work[0];
  assert.match(authorized.attention!, /its content is not on the base branch/);

  // Content that was on the base and a later merge deleted: the branch's own history of the path
  // names the commit, accepted because it descends from the delivery, and the merge that carried it.
  const later = history();
  later.repo.open(1, 'graphyard/gy-a-1', later.a2); later.repo.open(2, 'graphyard/gy-b-1', later.b1);
  const delivered = later.repo.land(1, '2026-09-21T01:00:00Z');
  const merged = item('GY-A', 1, ['src/a.ts', 'tests/', 'docs/'], later.a2, later.repo.pulls.get(1)!.base.sha);
  assert.equal((await later.repo.github().observe(merged, [merged])).revertedDelivery, undefined, 'a delivery the base branch holds is not reported');
  const removing = later.repo.land(2, '2026-09-21T02:00:00Z');
  assert.notEqual(removing, delivered);
  const gone = await later.repo.github().observe(merged, [merged, item('GY-B', 2, ['src/b.ts'], later.b1, delivered)]);
  assert.deepEqual([gone.revertedDelivery!.files.map(file => file.path), gone.revertedDelivery!.removedBy], [['src/a.ts', 'tests/a.test.ts'], { key: 'GY-B', pr: 2, mergeSha: removing, commit: later.b1 }]);
  // A file somebody changed afterwards is not a revert, and an unmoved branch is not asked about twice.
  const changed = later.repo.change('GY-C: edit a guide', removing, { 'docs/a.md': 'a better guide' }); later.repo.main = changed;
  const afterwards = await later.repo.github().observe({ ...merged, observation: gone }, [merged]);
  assert.deepEqual(afterwards.revertedDelivery!.files.map(file => file.path), ['src/a.ts', 'tests/a.test.ts']);
  const quiet = later.repo.github(), asked = later.repo.requests.length;
  assert.deepEqual((await quiet.observe({ ...merged, observation: afterwards }, [merged])).revertedDelivery, afterwards.revertedDelivery);
  assert.equal(later.repo.requests.slice(asked).some(request => request.includes('/contents/')), false);
});

// ---- GY-84's content is back on the base branch ----

test('manual:gy-84-content-restored — every file GY-93\'s merge took from GY-84 is present again: the master-daemon implementation, its guide and packaged unit, the review-verdict rule, and the proof file tests/unattended-cycle.test.ts, which passes', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const read = (path: string) => { assert.ok(existsSync(join(root, path)), `${path} is present`); return readFileSync(join(root, path), 'utf8'); };
  // The thirteen files f581236c carried and 034d7be lacked, each with content only GY-84 gave it.
  const restored: Record<string, RegExp> = {
    'tests/unattended-cycle.test.ts': /integration:unattended-full-cycle[\s\S]*integration:mergeable-dwell-budget[\s\S]*integration:no-actionable-silence[\s\S]*integration:dispatch-latency-budget[\s\S]*integration:loop-liveness/,
    'src/master-daemon.ts': /'decision', 'scope', 'settle'/,
    'docs/master-agent.md': /graphyard-master\.service/,
    'examples/master/graphyard-master.service': /WatchdogSec=/,
    'src/agent-review.ts': /verdict: 'changes-requested', verdictId: verdict\.id, requestId: trigger\.id/,
    'src/auto-dispatch.ts': /cursor\.lastTick = \{ at: tick\.at, launched:/, 'src/cli/master-status.ts': /loopAttention\(\{ liveness: cycling\.liveness/,
    'src/codex-review.ts': /Codex has no changes-requested state/, 'src/master.ts': /approverSessionName/, 'src/model/review.ts': /verdict\?: 'changes-requested'/,
    'tests/codex-review.test.ts': /only findings filed on the exact head for the completed, authenticated request are a changes-requested verdict/,
    'tests/review-provider.test.ts': /changes requested on another commit are not a verdict on this head/, 'tests/launch-prompt-delivery.test.ts': /approved\.agentName/,
  };
  assert.equal(Object.keys(restored).length, 13);
  for (const [path, marker] of Object.entries(restored)) assert.match(read(path), marker, `${path} holds GY-84's content`);
  assert.ok(read('tests/unattended-cycle.test.ts').split('\n').length > 1000, 'the proof file is whole');
  assert.ok(read('src/master-daemon.ts').split('\n').length > 1700, 'the master-daemon implementation is whole, not the loop it replaced');
  const daemon = await import('../src/master-daemon.js');
  for (const name of ['runCycle', 'emptyDaemonState', 'daemonActionKinds']) assert.ok(name in daemon, `src/master-daemon.ts exports ${name}`);
  assert.ok((daemon.daemonActionKinds as readonly string[]).includes('decision'), 'the loop requests routine decisions itself');

  // The proof file runs here, against this tree, with every case executed and none skipped.
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter', 'tap', 'tests/unattended-cycle.test.ts'], { cwd: root, encoding: 'utf8', timeout: 240_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } as NodeJS.ProcessEnv });
  assert.equal(run.status, 0, `tests/unattended-cycle.test.ts passes:\n${run.stdout.slice(-4000)}\n${run.stderr.slice(-2000)}`);
  assert.match(run.stdout, /# pass 8\b/); assert.match(run.stdout, /# fail 0\b/); assert.match(run.stdout, /# skipped 0\b/);
});
