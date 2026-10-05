import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECK_NAME, GitHub } from '../src/github.js';
import { evaluate, Refusal, type Observation, type Work } from '../src/model.js';
import { buildMasterStatus } from '../src/master.js';

// GY-97. Each test is named for the proof it produces, so acceptance evidence maps to one
// executed case per required proof: integration:deletion-by-stale-base,
// manual:gy-84-content-restored, unit:reverted-delivery-visible. The queue re-check on base
// advance (integration:revert-recheck-on-base-advance) went with the merge queue's reach
// through the engine (GY-1235): GitHub merges, so nothing is re-checked on a speculative tip.

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
  private mainTip = '';
  /** Every adapter over this repository: each move of main reaches them as GitHub's push webhook (GY-806). */
  private adapters: GitHub[] = [];
  get main() { return this.mainTip; }
  set main(tip: string) { this.mainTip = tip; for (const adapter of this.adapters) adapter.noteWebhook('push', { ref: 'refs/heads/main' }); }
  requests: string[] = [];
  /** Scratch branches the control plane merges a tip on before moving the pull request's branch (GY-1087). */
  scratch = new Map<string, string>();
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
    this.adapters.push(github);
    github.controlPlaneLogin = async () => 'graphyard-owner-project[bot]';
    github.request = async (path: string, method = 'GET', body?: any) => {
      this.requests.push(`${method} ${path}`);
      if (path === '/merges' && method === 'POST') {
        const pr = [...this.pulls.values()].find(entry => entry.head.ref === body.base), at = pr ? pr.head.sha : this.scratch.get(body.base)!;
        if (this.contains(body.head, at)) return null;
        const merged = this.merge(body.commit_message, at, body.head);
        if (merged === 'conflict') throw new Refusal('GitHub POST /merges failed (409)', 502);
        if (pr) pr.head.sha = merged; else this.scratch.set(body.base, merged);
        return { sha: merged };
      }
      if (method === 'PATCH' && path.startsWith('/git/refs/heads/')) {
        const name = decodeURIComponent(path.slice('/git/refs/heads/'.length)), pr = [...this.pulls.values()].find(entry => entry.head.ref === name);
        if (pr) pr.head.sha = body.sha; else this.scratch.set(name, body.sha);
        return { object: { sha: body.sha } };
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
      match = /^\/git\/ref\/heads\/(.+)$/.exec(route);
      if (match) { const name = decodeURIComponent(match[1]); const branch = [...this.pulls.values()].find(entry => entry.head.ref === name); return { ref: `refs/heads/${name}`, object: { type: 'commit', sha: branch ? branch.head.sha : this.main } }; }
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
  const b0 = repo.change('GY-B: add b', repo.main, { 'src/server/routes/b.ts': 'b' });
  const tip = repo.merge('Graphyard speculative tip for GY-B behind GY-A', b0, a1) as string;
  const b1 = repo.change('GY-B: carry only this item\'s changes', tip, { [`src/${a}.ts`]: null, [`tests/${a}.test.ts`]: null });
  return { repo, a1, a2, b0, b1 };
}

const item = (key: string, pr: number, plannedFiles: string[], head: string, baseSha: string, overrides: Partial<Work> = {}): Work => ({
  id: key.toLowerCase(), key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:landing'] }],
  policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles, stage: 'merge', revision: 3, policyRevision: 1, createdAt: '2026-09-20T09:00:00Z', updatedAt: '2026-09-20T09:00:00Z',
  stageEnteredAt: '2026-09-20T09:00:00Z', ready: true, epoch: 1, lease: null, workspaces: [{ host: 'machine', path: `/w/${key}`, branch: `graphyard/${key.toLowerCase()}-1`, epoch: 1, owner: 'implementer' }],
  candidate: { sha: head, baseSha, pr, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' }, submission: { epoch: 1, pr }, reworkRequested: false, scenarioRequirements: [],
  evidence: [], observation: null, blocker: null, gates: [], violations: [], ...overrides } as unknown as Work);
const buildReasons = (work: Work, all: Work[]) => evaluate(work, all.map(entry => entry.id === work.id ? work : entry), new Date(), [CI]).gates.find(gate => gate.name === 'build')!.reasons;

test('integration:deletion-by-stale-base — a deletion the merge would apply and the candidate\'s own diff does not show is refused: under a held base the branch moved past, and when the owner\'s pull request would be recorded merged with none of its content', async () => {
  // 1. Head unchanged. GY-A lands after GY-B was submitted; the bound base is held
  //    while the head is unchanged, and at that commit the files are absent, so the comparison
  //    `complete` ran still passes. Where the merge would land, they are there to be deleted.
  const held = history();
  held.repo.open(1, 'graphyard/gy-a-1', held.a2); held.repo.open(2, 'graphyard/gy-b-1', held.b1);
  const submittedBase = held.repo.main, adapter = held.repo.github();
  let candidate = item('GY-B', 2, ['src/server/routes/b.ts'], held.b1, submittedBase, { stage: 'review' });
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

  // 2. GY-93 and GY-84 as it happened. The head carries the owner's current head and none of its
  //    content, and the base never held it either: no diff against any base shows a thing, and
  //    merging would make the provider record the owner's pull request merged.
  const carried = history();
  carried.repo.open(1, 'graphyard/gy-a-1', carried.a1); carried.repo.open(2, 'graphyard/gy-b-1', carried.b1);
  const provider = carried.repo.github();
  const unlanded = item('GY-A', 1, ['src/a.ts', 'tests/'], carried.a1, carried.repo.main);
  unlanded.observation = await provider.observe(unlanded);
  const swallowing = item('GY-B', 2, ['src/server/routes/b.ts'], carried.b1, carried.repo.main);
  const seen = await provider.observe(swallowing, [unlanded, swallowing]);
  assert.deepEqual(seen.scopeFiles!.map(file => file.path), ['src/server/routes/b.ts']); assert.equal(seen.landing!.files, undefined);
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
  const intact = await whole.repo.github().observe(item('GY-B', 2, ['src/server/routes/b.ts'], whole.repo.pulls.get(2)!.head.sha, whole.repo.main), [intactOwner]);
  assert.deepEqual(intact.landing!.carried, [], 'a head that carries another candidate and holds its files as it shipped them reverts nothing');
});

// ---- A reverted delivery is visible as one ----

test('unit:reverted-delivery-visible — a merged item whose content is not on the base branch is reported as a reverted delivery, naming the item, the files missing from the base and the merge that removed them, and never as an ordinary unreconciled merge', async () => {
  // As GY-84 and GY-93: the swallowing head lands, the provider records the owner's pull request
  // merged in the same push, and main never holds a line of it.
  const { repo, a1, b1 } = history();
  repo.open(1, 'graphyard/gy-a-1', a1); repo.open(2, 'graphyard/gy-b-1', b1);
  const github = repo.github();
  const owner = item('GY-A', 1, ['src/a.ts', 'tests/'], a1, repo.main), swallowing = item('GY-B', 2, ['src/server/routes/b.ts'], b1, repo.main);
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
  assert.match(plain.attention!, /though its gates had not passed on that head/); assert.equal(plain.merged!.reverted, undefined);
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
  const gone = await later.repo.github().observe(merged, [merged, item('GY-B', 2, ['src/server/routes/b.ts'], later.b1, delivered)]);
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
    'src/daemon/state.ts': /'decision', 'scope', 'settle'/,
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
  // src/master-daemon.ts re-exports the modules under src/daemon/ (GY-177); the implementation is theirs.
  const daemonLines = readdirSync(join(root, 'src/daemon')).filter(name => name.endsWith('.ts')).reduce((total, name) => total + read(`src/daemon/${name}`).split('\n').length, 0);
  assert.ok(daemonLines > 1700, 'the master-daemon implementation is whole, not the loop it replaced');
  const daemon = await import('../src/master-daemon.js');
  for (const name of ['runCycle', 'emptyDaemonState', 'daemonActionKinds']) assert.ok(name in daemon, `src/master-daemon.ts exports ${name}`);
  assert.ok((daemon.daemonActionKinds as readonly string[]).includes('decision'), 'the loop requests routine decisions itself');

  // The proof file runs here, against this tree, with every case executed and none skipped.
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter', 'tap', 'tests/unattended-cycle.test.ts'], { cwd: root, encoding: 'utf8', timeout: 240_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } as NodeJS.ProcessEnv });
  assert.equal(run.status, 0, `tests/unattended-cycle.test.ts passes:\n${run.stdout.slice(-4000)}\n${run.stderr.slice(-2000)}`);
  // Nine cases: GY-84's restored eight, and GY-1118's review-round cap driven through the same loop.
  assert.match(run.stdout, /# pass 9\b/); assert.match(run.stdout, /# fail 0\b/); assert.match(run.stdout, /# skipped 0\b/);
});
