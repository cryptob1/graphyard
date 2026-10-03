import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, RunEvent, RunOptions, RunResult, Runner } from '../../src/runner/types.js';
import { GitHub, landingCheck, scopeLookupBudget, type LandingGitHub } from '../../src/github.js';
import type { HerdrAgent } from '../../src/master.js';
import { Refusal, type Observation, type ScopeFile, type Work } from '../../src/model.js';
import type { AgentReview, ReviewRequest } from '../../src/model/review.js';
import { landableCheckCurrent, landableCheckRun, type LandableCheckRun } from '../../src/landable-check.js';
import { heldBase, mergeableNow, queueRef, type BaseRefresh, type GitHubMergeQueueState, type LandingCheck, type QueuePlacement, type QueueSpeculation } from '../../src/merge-queue.js';
import type { Succession } from '../../src/model/successors.js';
import { revertRefusal, type OptimisticMerge, type OptimisticRevert } from '../../src/optimistic-merge.js';

// The outside world of the soak test (GY-404), simulated deterministically: one clock that both the
// test process and the test Postgres read, a GitHub repository with pull requests, CI, a reviewer and
// a merge button, and a Herdr that lists the sessions the loop launches. Nothing in here decides
// anything for Graphyard: the loop and the engine act, and this world only answers them.

export const minute = 60_000, hour = 60 * minute;
/** The check the simulated base branch's protection requires that the policy does not name (GY-1060). */
export const protectionOnlyCheck = 'secrets';
/** A classic protection context answered by a commit status, not a check run (GY-1060): app 0, `source: 'status'`, as the real adapter reads it. */
export const statusContext = 'ci/legacy';
/** How long GitHub reports a `blockedMerge` item BLOCKED after its required check passed: past master status's ten-minute bound (GY-430). */
export const blockedMergeMs = 14 * minute;
export const sha = (...seed: (string | number)[]) => createHash('sha1').update(seed.join('\0')).digest('hex');
const uuid = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;

// ---------------------------------------------------------------------------
// The clock. The test process's Date and the database's now()/clock_timestamp() both read real time
// plus one offset, so the loop, the engine and every timestamp they write agree, and advancing the
// offset is a simulated hour passing in a millisecond.
// ---------------------------------------------------------------------------
const RealDate = Date;
let offsetMs = 0;
class SimulatedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length) super(...(args as [string]));
    else super(RealDate.now() + offsetMs);
  }
  static now() { return RealDate.now() + offsetMs; }
}
export const clock = {
  /** Start the simulation at `start`: every later reading is real time plus the offset to it. */
  install(start: number) { offsetMs = start - RealDate.now(); (globalThis as { Date: DateConstructor }).Date = SimulatedDate as unknown as DateConstructor; },
  uninstall() { (globalThis as { Date: DateConstructor }).Date = RealDate; offsetMs = 0; },
  now: () => RealDate.now() + offsetMs,
  advance(ms: number) { offsetMs += ms; },
  get offsetMs() { return offsetMs; },
};
/**
 * The database's clock functions, shadowed in `public` (searched before pg_catalog on this database)
 * by the same offset, which the test writes to `simulated_clock` whenever it advances.
 */
export const clockSql = [
  'CREATE TABLE simulated_clock (offset_ms double precision NOT NULL)',
  'INSERT INTO simulated_clock VALUES (0)',
  ...['now', 'transaction_timestamp', 'statement_timestamp', 'clock_timestamp'].map(name =>
    `CREATE FUNCTION public.${name}() RETURNS timestamptz LANGUAGE sql ${name === 'clock_timestamp' ? 'VOLATILE' : 'STABLE'} AS $$ SELECT pg_catalog.${name}() + make_interval(secs => (SELECT offset_ms FROM public.simulated_clock) / 1000.0) $$`),
];

// ---------------------------------------------------------------------------
// GitHub.
// ---------------------------------------------------------------------------
/**
 * A commit: on the base branch, a worker's head, or a queue tip Graphyard published; `files` is its
 * whole tree's file list, `contents` the content identity of every path it holds. A base-branch
 * commit also names the files it `changed` against its first parent, and whether the required suite
 * fails on it (`broken`: it holds a head that breaks main).
 */
export interface Commit { sha: string; tree: string; parents: string[]; files: string[]; contents: Map<string, string>; at: number; message: string; changed?: string[]; broken?: boolean }
export interface PullRequest {
  number: number; key: string; branch: string; author: string; head: string;
  /** The base-branch commit the head contains (its merge base with the base branch). */
  base: string; files: string[]; createdAt: number; open: boolean;
  merged: { sha: string; at: number } | null;
  /** When each head was pushed; CI reports on it `ciMs` later. */
  pushed: Map<string, number>;
  reviews: { reviewer: string; sha: string; state: string; id: number; submittedAt: string }[];
  /** The Graphyard / merge check the control plane published per head. */
  graphyardCheck: Map<string, { conclusion: 'success' | 'failure'; at: number }>;
  autoMerge: boolean; mergeRequestedAt: number | null;
  /** The MergeStateStatus GitHub reports once it has recomputed after a passing check: CLEAN, or UNSTABLE for a failing optional check. */
  settledState: 'CLEAN' | 'UNSTABLE';
  agentRequests: ReviewRequest[]; agentReview: AgentReview | null;
}

export interface WorldOptions {
  repository: string; baseBranch: string; appId: number; ciAppId: number;
  reviewerApps: { id: string; runtime: string; appId: number; botUserId: number }[];
  ciMs: number; reviewMs: number;
  /** The first pull request number: a second world on the same control plane numbers its own. */
  firstPullRequest: number;
  /**
   * The project's documentation word budget (GY-574), when it keeps one: the pages it counts with
   * their base word counts, and the budget its committed graphyard.json configures. Set, the world
   * holds those pages as real prose (so the word counter reads real text), runs the project's
   * `unit:docs-word-budget` check on every head — a page over the per-page cap fails it, a total
   * over the budget warns and passes, as the product rule goes — and answers the tree and blob
   * reads the real word counter makes.
   */
  docs?: { budget: { total: number; perPage: number }; pages: Record<string, number> };
}

export class SimulatedGitHub {
  commits = new Map<string, Commit>();
  tip: string;
  prs = new Map<number, PullRequest>();
  /** Every merge GitHub performed, in order, with the time it did. */
  merges: { key: string; pr: number; sha: string; at: number; state: string; mode: 'immediate' | 'auto-merge' | 'outside' }[] = [];
  /** Every landed peer an observation reported, as `observed KEY -> landed KEY` (GY-756). */
  landedReports: string[] = [];
  /** Reviewers' plans per item: the verdict each successive review of it gives. */
  verdicts = new Map<string, ('APPROVED' | 'CHANGES_REQUESTED')[]>();
  /** Reviewer profiles that are out of quota: a request dispatched to one is answered with a usage-limit verdict. */
  exhaustedProfiles = new Set<string>();
  /** Items whose GitHub merge state settles as UNSTABLE (a failing optional check), and those GitHub is slow to recompute after their required check passes. */
  unstable = new Set<string>(); slowRecompute = new Set<string>();
  /**
   * Items GitHub keeps BLOCKED for `blockedMergeMs` after their required check passed (GY-430): a
   * branch-protection condition Graphyard does not gate on, such as a review GitHub still requires.
   */
  blockedMerge = new Set<string>();
  /** Successions (renames and splits) recorded on the base branch. */
  successions: Succession[] = [];
  /** Heads that break the required suite on the base branch once merged (GY-500): every base commit holding one fails until it is reverted. */
  breaking = new Set<string>();
  /** The revert pull requests the main guard opened, and the base commit each landed as. */
  reverts: { pr: number; key: string; head: string; files: string[]; merged: string | null; openedAt: number; mergedAt: number | null }[] = [];
  /** GitHub reads the main guard and the observation make for optimistic merges, per simulated minute. */
  reads = { commitChecks: new Map<number, number>(), baseChanges: 0 };
  /**
   * Items whose first speculative tip hits an infrastructure flake (GY-516): its `test` run fails,
   * and the one rerun the control plane asks for passes (`rerun-passes`) or fails again (`rerun-fails`).
   */
  flaky = new Map<string, 'rerun-passes' | 'rerun-fails'>();
  /** The CI runs reported per commit, created once CI finishes on it; a rerun appends a later attempt. */
  runs = new Map<string, { name: string; result: string; id: number; attempt: number; at: number }[]>();
  /** Every rerun the control plane asked for: the item, the tip and the failed check run. */
  reruns: { key: string; sha: string; checkRunId: number; at: number }[] = [];
  /** The `graphyard/landable` runs the control plane published per head (GY-887), with how often each was written. */
  landable = new Map<string, { id: number; body: LandableCheckRun; writes: number }[]>();
  /** Every GitHub request publishing the landability verdict cost: the head's run listing, the pull request read before a success, and each write. */
  landableRequests: { key: string; head: string; kind: 'list' | 'pull' | 'post' | 'patch'; at: number }[] = [];
  /** Each item's first speculative tip, the one its flake hits. */
  private flakeTips = new Map<string, string>();
  /**
   * GY-839. Heads whose compares GitHub answers without a usable merge base while they are listed
   * here, so the landing check keeps the two-way endpoint diff and the base's own new changes read
   * as reverts — the reading this item fixes, staged as a fault the simulated day must recover from.
   */
  staleMergeBase = new Set<string>();
  /**
   * GY-831. Heads for which `gh pr view` answers a head other than the record's, so every guarded
   * merge attempt for them refuses with one unchanged message. A rework round's new head is never
   * listed, so the fault holds only the candidate it was staged for.
   */
  stuckHeads = new Set<string>();
  /**
   * GY-854. Items whose branch restores GitHub refuses once listed here: the restore's branch reset
   * and its merge are each answered 403, as GitHub answers a protected branch update, so a restore
   * the loop owes the item can never publish. Tip publications are left alone: the fault is the
   * restore's, and a tip the queue owes before the ejection is not what it exercises.
   */
  refusedBranches = new Set<string>();
  /** GY-854. Items GitHub takes this long to compute mergeable once their check passed, so they stay queued, unlanded. */
  slowMergeable = new Map<string, number>();
  /** Every write a branch restore made or was refused, per item, in order (GY-854). */
  restoreWrites: { key: string; write: 'reset' | 'merge'; refused: boolean; at: number }[] = [];
  /** GY-831. Items whose reviewer verdict is posted by the bound reviewer App identity itself. */
  botReviewers = new Set<string>();
  /** GY-1084. Heads whose own diff also rewrites files outside the item's planned files, as GitHub's compare reports them. */
  strays = new Map<string, ScopeFile[]>();
  /** How many times the landing check ran in the loop, the bases it judged, and the two compare kinds it asked. */
  landingChecks = 0; landingBases = new Set<string>(); ancestorCompares = 0; blindCompares = 0;
  private serial = 0;
  constructor(readonly options: WorldOptions, files: string[]) {
    const paths = [...files];
    const contents = new Map<string, string>();
    if (options.docs) {
      // The budgeted documentation is real prose, so the word counter counts words, and the
      // committed configuration beside it names the budget the project keeps (GY-574).
      const prose = (words: number) => Array.from({ length: words }, (_, index) => `w${index}`).join(' ');
      for (const [page, words] of Object.entries(options.docs.pages)) { paths.push(page); contents.set(page, prose(words)); }
      paths.push('graphyard.json');
      contents.set('graphyard.json', JSON.stringify({ documentation: { paths: ['docs/', 'README.md'], changelog: null, wordBudget: { total: options.docs.budget.total, perPage: options.docs.budget.perPage } } }));
    }
    const root: Commit = { sha: sha('root'), tree: sha('tree', 'root'), parents: [], files: paths, contents: new Map([...paths.map(path => [path, sha('content', path, 'root')] as const), ...contents]), at: clock.now(), message: 'root' };
    this.commits.set(root.sha, root); this.tip = root.sha;
  }
  get tree() { return this.commits.get(this.tip)!.tree; }
  get files() { return this.commits.get(this.tip)!.files; }
  /** Whether `ancestor` is `commit` or reachable from it. */
  contains(commit: string, ancestor: string) {
    const seen = new Set<string>(), queue = [commit];
    while (queue.length) { const at = queue.pop()!; if (at === ancestor) return true; if (seen.has(at)) continue; seen.add(at); queue.push(...(this.commits.get(at)?.parents ?? [])); }
    return false;
  }
  /**
   * A commit off the base branch: a worker's head or a published tip. Content identity is inherited from the first parent and changed only where the file list changes, so a path's blob is stable until its content actually changes — as GitHub's blob ids are. `contents` overrides the inheritance, the way a merge commit's tree is really built.
   */
  record(commit: Omit<Commit, 'contents'>, contents?: Map<string, string>) {
    const inherited = contents ?? (() => {
      const first = commit.parents[0] ? this.commits.get(commit.parents[0])?.contents : undefined;
      const contents = first ? new Map(first) : new Map<string, string>();
      const had = first ? new Set(first.keys()) : new Set<string>();
      for (const path of commit.files) if (!had.has(path)) contents.set(path, sha('content', path, commit.sha));
      for (const path of [...contents.keys()]) if (!commit.files.includes(path)) contents.delete(path);
      return contents;
    })();
    const stored = { ...commit, contents: inherited };
    this.commits.set(stored.sha, stored);
    return stored;
  }
  /**
   * What merging `own` with `base` produces: the base's tree, with the paths `own` actually
   * owns (its planned scope, plus paths the base lacks) taken from `own`. A tip or a branch
   * restore merges the base into the item's head, so the result must hold the base's current
   * content for every path the item never touched — a stale copy there reads as a revert.
   */
  mergedContents(ownSha: string, baseSha: string, planned: readonly string[]): Map<string, string> {
    const own = this.commits.get(ownSha)!, base = this.commits.get(baseSha)!, contents = new Map(base.contents);
    for (const [path, blob] of own.contents) if (planned.includes(path) || !base.contents.has(path)) contents.set(path, blob);
    for (const path of [...contents.keys()]) if (!own.files.includes(path) && !base.files.includes(path)) contents.delete(path);
    return contents;
  }
  /**
   * A commit onto the base branch: a merged pull request, or a change landed outside Graphyard (a file
   * split). It changed `changed` (default: the files added or removed) and fails the required suite
   * when `broken` (default: as its first parent does). `contents` overrides the merged content, as a
   * hand edit's tree really holds it.
   */
  commit(message: string, files: string[], at = clock.now(), parents = [this.tip], tree?: string, change: { changed?: string[]; broken?: boolean } = {}, contents?: Map<string, string>) {
    const parent = this.commits.get(parents[0]), before = new Set(parent?.files ?? []), after = new Set(files);
    const changed = change.changed ?? [...files.filter(path => !before.has(path)), ...[...before].filter(path => !after.has(path))];
    const commit = this.record({ sha: sha('commit', ...parents, message), tree: tree ?? sha('tree', ...parents, message), parents, files, at, message, changed, broken: change.broken ?? !!parent?.broken }, contents);
    this.tip = commit.sha;
    return commit;
  }
  /** A worker pushes a head to its item's branch, opening the pull request on the first push. `grow` is the head's documentation edit (GY-574): `words` more words on `page`. */
  push(key: string, branch: string, author: string, head: string, files: string[], grow?: { page: string; words: number }) {
    let pr = [...this.prs.values()].find(entry => entry.branch === branch && entry.open);
    if (!pr) {
      pr = { number: this.options.firstPullRequest + this.prs.size, key, branch, author, head, base: this.tip, files, createdAt: clock.now(), open: true, merged: null, pushed: new Map(), reviews: [], graphyardCheck: new Map(),
        autoMerge: false, mergeRequestedAt: null, settledState: this.unstable.has(key) ? 'UNSTABLE' : 'CLEAN', agentRequests: [], agentReview: null };
      this.prs.set(pr.number, pr);
    }
    // A worker syncs before it pushes (graphyard sync): the head contains the base tip.
    const parent = this.commits.get(this.tip)!;
    const contents = new Map(parent.contents);
    if (grow) {
      const prose = (words: number) => Array.from({ length: words }, (_, index) => `g${index}`).join(' ');
      const text = contents.get(grow.page);
      contents.set(grow.page, text === undefined ? prose(grow.words) : `${text} ${prose(grow.words)}`);
    }
    for (const path of [...new Set([...this.files, ...files])]) if (!contents.has(path)) contents.set(path, sha('content', path, head));
    this.record({ sha: head, tree: sha('tree', head), parents: [this.tip], files: [...new Set([...this.files, ...files])], at: clock.now(), message: `${key} head` }, contents);
    Object.assign(pr, { head, base: this.tip, files, autoMerge: false, mergeRequestedAt: null });
    pr.pushed.set(head, clock.now());
    return pr;
  }
  pr(work: Pick<Work, 'submission' | 'candidate'>) { const number = work.candidate?.pr ?? work.submission?.pr; const pr = number ? this.prs.get(number) : undefined; if (!pr) throw new Error(`No pull request #${number}`); return pr; }

  // The reads the production landing check makes of GitHub, answered from this repository's commit
  // graph. Nothing here decides anything: the shared `landingCheck` (src/github.ts) judges.

  /** The commits `head` holds that `base` does not, breadth first: the compare endpoint's commit list. */
  between(from: string, to: string): string[] {
    const seen = new Set<string>(), out: string[] = [], queue = [to];
    while (queue.length) { const at = queue.shift()!; if (at === from || seen.has(at) || !this.commits.has(at)) continue; seen.add(at); out.push(at); queue.push(...this.commits.get(at)!.parents); }
    return out;
  }
  /** The most recent commit both sides hold: this graph's merge base. */
  mergeBase(a: string, b: string): string {
    const ancestors = (start: string) => { const seen = new Set<string>(), queue = [start]; while (queue.length) { const at = queue.pop()!; if (seen.has(at)) continue; seen.add(at); queue.push(...(this.commits.get(at)?.parents ?? [])); } return seen; };
    const left = ancestors(a), right = ancestors(b);
    const common = [...left].filter(commit => right.has(commit)).map(commit => this.commits.get(commit)!);
    if (!common.length) throw new Error(`no common ancestor of ${a.slice(0, 12)} and ${b.slice(0, 12)}`);
    return common.sort((x, y) => y.at - x.at)[0].sha;
  }
  /** Blob identity of a path at a commit, or null when that commit holds no file there. */
  blobAt(path: string, ref: string): string | null {
    return this.commits.get(ref)?.contents.get(path) ?? null;
  }
  /** The endpoint diff GitHub's compare answers: every path the two trees disagree on, two-way — the listing that also shows the base's own new changes in reverse. */
  private diff(from: string, to: string) {
    const before = new Set(this.commits.get(from)!.files), after = new Set(this.commits.get(to)!.files);
    return [...new Set([...before, ...after])].filter(path => before.has(path) !== after.has(path) || this.blobAt(path, from) !== this.blobAt(path, to)).sort()
      .map(path => ({ filename: path, status: !after.has(path) ? 'removed' : !before.has(path) ? 'added' : 'modified', sha: this.blobAt(path, to), additions: 1, deletions: 1, patch: '@@ -1 +1 @@' }));
  }
  /** GitHub's compare answer, as the landing check and its ancestry helpers read it. A head in `staleMergeBase` gets no usable merge base, which keeps the two-way listing in play. */
  compare(from: string, to: string, query = '') {
    const params = new URLSearchParams(query), perPage = Number(params.get('per_page') ?? 30), page = Number(params.get('page') ?? 1);
    const truth = this.mergeBase(from, to), blind = this.staleMergeBase.has(to) && truth !== from;
    if (!params.get('per_page')) { if (blind) this.blindCompares += 1; if (truth === from && from !== to) this.ancestorCompares += 1; }
    const commits = this.between(from, to);
    return {
      status: from === to ? 'identical' : this.contains(to, from) ? 'ahead' : this.contains(from, to) ? 'behind' : 'diverged',
      ahead_by: commits.length, total_commits: commits.length,
      merge_base_commit: { sha: blind ? from : truth },
      files: this.diff(from, to),
      commits: commits.slice((page - 1) * perPage, page * perPage).map(commit => ({ sha: commit })),
    };
  }
  /** A pull request's file list as GitHub's files endpoint answers it: the head's changes since its merge base with the pull request's base. */
  prFiles(pr: PullRequest) { return this.diff(this.mergeBase(pr.base, pr.head), pr.head); }
  /** The pull request as `GET /pulls/:number` answers what the landing check's `landedOn` reads of it, its head included. */
  pull(pr: number) {
    const record = this.prs.get(pr);
    return record ? { merged: !!record.merged, merge_commit_sha: record.merged?.sha ?? null, head: { sha: record.head }, state: record.open ? 'open' : 'closed' } : null;
  }
  /**
   * The production landing check over this repository, exactly as the real observer computes it
   * for an open candidate: the commit it would land on, the head's changes since its merge base
   * with that commit, and the open peers the landing commit does not hold. The world counts the
   * runs and the bases so the soak can assert the changed path was exercised.
   */
  async landing(work: Work, peers: Work[] | undefined): Promise<LandingCheck> {
    const pr = this.pr(work), speculation = work.queue?.speculation;
    const speculative = speculation && speculation.tip === pr.head && speculation.policyRevision === work.policyRevision ? speculation.base : null;
    const holding = speculative || this.contains(pr.head, this.tip) ? null : heldBase(work, pr.head, this.tip);
    const bound = speculative ?? (holding && this.contains(this.tip, holding) ? holding : this.tip);
    const landing = await landingCheck(this.port(), work, pr.head, this.prFiles(pr), bound, speculative, { tip: this.tip, tree: this.tree }, peers, { remaining: scopeLookupBudget });
    this.landingChecks += 1; this.landingBases.add(landing.base);
    return landing;
  }
  /** The landing check's view of this repository, as `LandingGitHub` spells it. The production `contains(base, head)` asks whether `head` contains `base`, which this graph spells `contains(head, base)`. */
  private port(): LandingGitHub {
    const world = this;
    return {
      compare: async (from, to, query = '') => world.compare(from, to, query),
      pull: async pr => world.pull(pr),
      blobAt: (path, ref) => Promise.resolve(world.blobAt(path, ref)),
      contains: (base, head) => Promise.resolve(world.contains(head, base)),
      historySince: (base, head) => Promise.resolve(new Set(world.between(base, head))),
    };
  }

  /** The CI runs that have reported on `pr`'s head by `now`: every attempt, as GitHub keeps them. */
  checks(pr: PullRequest, now: number) {
    const head = pr.head;
    if (now - pr.pushed.get(head)! < this.options.ciMs) return [];
    if (!this.runs.has(head)) {
      const flake = this.flakeTips.get(pr.key) === head && this.flaky.has(pr.key);
      // `secrets` is required by the base branch's protection alone (GY-1060), bound to no app, as
      // PR #221's scan was: every gate, verdict and window view of the day reads it beside the policy's.
      const runs = ['test', 'typecheck', protectionOnlyCheck].map(name => ({ name, result: flake && name === 'test' ? 'failure' : 'success', id: ++this.serial, attempt: 1, at: now }));
      // The project's own documentation budget check (GY-574): the budget is the project's own
      // rule, counted over the pages its configuration names (here docs/ and README.md, as the
      // committed graphyard.json does), and this project's CI fails the check when that total is
      // over the budget. Each queued entry passes alone; the combination on a tip is what
      // overflows — the fault the queue's attribution answers.
      if (this.options.docs) {
        const commit = this.commits.get(head)!;
        const total = [...commit.contents].filter(([path]) => path === 'README.md' || /^docs\/.+\.md$/.test(path))
          .reduce((sum, [, text]) => sum + text.split(/\s+/).filter(Boolean).length, 0);
        runs.push({ name: 'unit:docs-word-budget', result: total > this.options.docs.budget.total ? 'failure' : 'success', id: ++this.serial, attempt: 1, at: now });
      }
      this.runs.set(head, runs);
    }
    return this.runs.get(head)!.filter(run => run.at <= now);
  }
  /** Heads whose CI finished and whose check_run webhook was already delivered (GY-806). */
  private announced = new Set<string>();
  /** The check_run webhooks GitHub sends by `now`: one per open pull request head whose CI has finished, delivered once. */
  completedChecks(now: number): { pr: number; sha: string }[] {
    const deliveries: { pr: number; sha: string }[] = [];
    for (const pr of this.prs.values()) {
      if (!pr.open || pr.merged || this.announced.has(pr.head) || now - (pr.pushed.get(pr.head) ?? now) < this.options.ciMs) continue;
      this.announced.add(pr.head); deliveries.push({ pr: pr.number, sha: pr.head });
    }
    return deliveries;
  }
  /** GitHub's "rerun failed jobs": the failed run's job runs again on the same commit, reporting `ciMs` later. A documentation-budget breach is not a flake: the rerun judges the commit's pages again (GY-574). */
  rerun(checkRunId: number) {
    const [head, runs] = [...this.runs].find(([, entries]) => entries.some(entry => entry.id === checkRunId)) ?? [];
    const failed = runs?.find(entry => entry.id === checkRunId);
    if (!head || !runs || !failed || failed.result !== 'failure') throw new Error(`GitHub POST /actions/jobs/${checkRunId}/rerun refused: not a failed job`);
    const pr = [...this.prs.values()].find(entry => entry.head === head)!;
    const now = clock.now();
    this.reruns.push({ key: pr.key, sha: head, checkRunId, at: now });
    const breached = failed.name === 'unit:docs-word-budget' && this.options.docs
      ? [...(this.commits.get(head)?.contents ?? [])].filter(([path]) => path === 'README.md' || /^docs\/.+\.md$/.test(path))
          .reduce((sum, [, text]) => sum + text.split(/\s+/).filter(Boolean).length, 0) > this.options.docs.budget.total
      : undefined;
    runs.push({ name: failed.name, result: breached !== undefined ? (breached ? 'failure' : 'success') : this.flaky.get(pr.key) === 'rerun-fails' ? 'failure' : 'success', id: ++this.serial, attempt: failed.attempt + 1, at: now + this.options.ciMs });
    return { runId: 900_000 + checkRunId };
  }
  /** One minute of GitHub: CI finishes, reviewers post verdicts, reviewer Apps answer, and auto-merge lands what it may. */
  tick(now: number) {
    for (const pr of [...this.prs.values()].filter(entry => entry.open)) {
      const pushedAt = pr.pushed.get(pr.head)!;
      const ciDone = now - pushedAt >= this.options.ciMs;
      // The reviewer judges a head once CI reported on it. An item in `botReviewers` is judged by
      // the bound reviewer App identity, whose approval a Graphyard-authored tip carries.
      if (ciDone && now - pushedAt >= this.options.ciMs + this.options.reviewMs && !pr.reviews.some(review => review.sha === pr.head)) {
        const plan = this.verdicts.get(pr.key) ?? [];
        const state = plan.shift() ?? 'APPROVED';
        this.verdicts.set(pr.key, plan);
        pr.reviews.push({ reviewer: this.botReviewers.has(pr.key) ? 'graphyard-reviewer[bot]' : 'reviewer', sha: pr.head, state, id: ++this.serial, submittedAt: new Date(now).toISOString() });
      }
      // A reviewer App answers the request it was dispatched: an exhausted profile with its usage-limit verdict.
      const request = pr.agentRequests.at(-1);
      if (request && request.sha === pr.head && (!pr.agentReview || pr.agentReview.requestId !== request.commentId) && now - Date.parse(request.createdAt) >= this.options.reviewMs) {
        const exhausted = this.exhaustedProfiles.has(request.profile!);
        pr.agentReview = { provider: 'agent', sha: request.sha, approved: !exhausted, reason: exhausted ? `${request.profile} reported verdict:usage-limit` : `${request.profile} approved this commit`,
          requestId: request.commentId, profile: request.profile, reviewerApp: request.reviewerApp, verdictId: ++this.serial, completedAt: new Date(now).toISOString(),
          ...(exhausted ? { exhausted: true, exhaustion: 'usage-limit' as const } : {}) };
      }
      // Auto-merge lands a pull request once its required check passed on the head and GitHub has recomputed its state.
      if (pr.autoMerge && this.mergeState(pr, now) !== 'BLOCKED') this.merge(pr, now, 'auto-merge');
    }
  }
  /** GitHub's MergeStateStatus: BLOCKED until the required check passed on the head and GitHub recomputed, then CLEAN or UNSTABLE. */
  mergeState(pr: PullRequest, now: number) {
    const check = pr.graphyardCheck.get(pr.head);
    if (check?.conclusion !== 'success') return 'BLOCKED';
    return now - check.at >= (this.blockedMerge.has(pr.key) ? blockedMergeMs : this.slowMergeable.get(pr.key) ?? (this.slowRecompute.has(pr.key) ? 6 * minute : 0)) ? pr.settledState : 'BLOCKED';
  }
  /** A merge somebody made on GitHub by hand, outside Graphyard's queue: nothing asked for it. */
  mergeOutside(pr: PullRequest, now: number) { this.merge(pr, now, 'outside'); return pr.merged!; }
  private merge(pr: PullRequest, now: number, mode: 'immediate' | 'auto-merge' | 'outside') {
    const state = this.mergeState(pr, now);
    // A head that already contains the base tip lands its own tree, as GitHub's merge commit does.
    const head = this.commits.get(pr.head)!, landsTree = this.contains(pr.head, this.tip);
    // The merge breaks main when it lands a breaking head, itself or inside a speculative tip built on it; a revert restores what it broke.
    const broken = !!this.commits.get(this.tip)!.broken || this.breaking.has(pr.head) || head.parents.some(parent => this.breaking.has(parent));
    // The merge commit holds the base's content with the pull request's changes taken from its
    // head — what GitHub's merge of those two commits really holds — so a page the pull request
    // grew is grown on the base branch after it lands (GY-574's documentation counts read it).
    const firstParent = this.commits.get(this.tip)!.contents ?? new Map<string, string>();
    const contents = new Map(firstParent);
    for (const [path, blob] of head.contents) if (pr.files.includes(path) || !contents.has(path)) contents.set(path, blob);
    const commit = this.record({ sha: sha('commit', ...[this.tip, pr.head], `Merge pull request #${pr.number} from ${pr.branch}`), tree: landsTree ? head.tree : sha('tree', this.tip, pr.head, `Merge pull request #${pr.number} from ${pr.branch}`), parents: [this.tip, pr.head], files: [...new Set([...this.files, ...head.files])], at: now, message: `Merge pull request #${pr.number} from ${pr.branch}`, changed: pr.files, broken }, contents);
    this.tip = commit.sha;
    pr.merged = { sha: commit.sha, at: now }; pr.open = false; pr.autoMerge = false;
    this.merges.push({ key: pr.key, pr: pr.number, sha: commit.sha, at: now, state, mode });
  }

  /** The files the base branch changed from `base` to `tip`, along first parents; null when `base` is not on that line (the real adapter's incomplete compare). */
  baseChangesSince(base: string, tip = this.tip): string[] | null {
    this.reads.baseChanges++;
    const changed = new Set<string>();
    for (let at: string | undefined = tip; at; at = this.commits.get(at)?.parents[0]) {
      if (at === base) return [...changed].sort();
      for (const path of this.commits.get(at)?.changed ?? []) changed.add(path);
    }
    return null;
  }
  /** The required suite on a base-branch commit, as CI's push run reports it `ciMs` after the commit landed. */
  commitChecks(commit: string, now: number) {
    const minuteOf = Math.floor(now / minute);
    this.reads.commitChecks.set(minuteOf, (this.reads.commitChecks.get(minuteOf) ?? 0) + 1);
    const found = this.commits.get(commit);
    if (!found || now - found.at < this.options.ciMs) return [];
    return ['test', 'typecheck'].map((name, index) => ({ name, result: name === 'test' && found.broken ? 'failure' : 'success', appId: this.options.ciAppId, id: Number.parseInt(commit.slice(0, 8), 16) * 2 + index }));
  }

  /** The distinct docs trees and blobs the real word counter has read (GY-574): the cache bounds the soak asserts. */
  docsReads = { trees: new Set<string>(), blobs: new Set<string>() };
  private docsCounter?: GitHub;
  /**
   * The docs word counts production observes for a failing published tip (GY-574), computed by the
   * real `GitHub.tipDocs` over this world: the counter's HTTP reads are answered from the simulated
   * commits, so the identical code the production observer runs judges the simulated tips.
   */
  async tipDocs(work: Work, head: string, base: string, checks: { id?: number; name: string; status: string; conclusion: string | null }[]) {
    if (!this.options.docs) return undefined;
    const counter = this.docsCounter ??= Object.create(GitHub.prototype) as GitHub;
    for (const field of ['docsTrees', 'docsBudgets', 'docsCounts', 'docsBlobWords'] as const) (counter as unknown as Record<string, unknown>)[field] ??= new Map();
    (counter as unknown as { request: (path: string) => Promise<unknown> }).request = this.docsPort();
    return await GitHub.prototype.tipDocs.call(counter, work, head, base, checks);
  }
  /** The tree and blob reads the word counter makes, answered from the simulated commits and counted. */
  private docsPort() {
    const world = this;
    const blobSha = (text: string) => createHash('sha1').update(text).digest('hex');
    const commitOf = (ref: string) => world.commits.get(ref) ?? [...world.commits.values()].find(entry => entry.tree === ref);
    return async (path: string): Promise<unknown> => {
      const tree = /\/git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(path);
      if (tree) {
        world.docsReads.trees.add(tree[1]);
        const commit = commitOf(tree[1]);
        if (!commit) throw new Error(`No commit or tree ${tree[1].slice(0, 12)}`);
        return { truncated: false, tree: commit.files.map(file => ({ path: file, type: 'blob', sha: blobSha(commit.contents.get(file) ?? file) })) };
      }
      const blob = /\/git\/blobs\/([0-9a-f]{40})$/.exec(path);
      if (blob) {
        world.docsReads.blobs.add(blob[1]);
        for (const commit of world.commits.values()) for (const text of commit.contents.values()) if (blobSha(text) === blob[1]) return { encoding: 'base64', content: Buffer.from(text).toString('base64') };
        throw new Error(`No blob ${blob[1].slice(0, 12)}`);
      }
      throw new Error(`Unexpected ${path}`);
    };
  }

  /** The adapter `processJob` drives, answering exactly what the real one reads from GitHub. */
  adapter(): GitHub {
    const world = this, options = this.options;
    const adapter = {
      config: { repository: options.repository, base: options.baseBranch, appId: options.appId, installationId: 1, reviewerApps: options.reviewerApps },
      reviewerAppFor: (profile: { reviewerApp?: string; runtime?: string } | null | undefined) => profile ? options.reviewerApps.find(app => app.id === profile.reviewerApp && app.runtime === profile.runtime) : undefined,
      async observe(work: Work, peers?: Work[]): Promise<Observation> {
        const pr = world.pr(work), now = clock.now();
        // The landing judgement runs where production runs it, over the same simulated repository:
        // every observation of an open candidate recomputes what landing on the live base would
        // revert, from the head's merge base with that commit, so a stale refusal clears on an
        // unchanged head (GY-839).
        const landing = pr.open && !pr.merged ? await world.landing(work, peers) : undefined;
        // Every landed peer the landing check reported (GY-756), as `observed KEY -> landed KEY`.
        world.landedReports.push(...(landing?.landed ?? []).map(entry => `${work.key} -> ${entry.key}`));
        const runs = world.checks(pr, now);
        // The status context reports with CI, as the real adapter reads it: a commit status of app 0.
        const checks: Observation['checks'] = [...runs.map(run => ({ name: run.name, result: run.result, appId: options.ciAppId, id: run.id, attempt: run.attempt })),
          ...(runs.length ? [{ name: statusContext, result: 'success', appId: 0, source: 'status' as const }] : [])];
        // A failing published tip carries its docs counts, observed exactly as production observes
        // them (GY-574): the real word counter over this world's trees and blobs.
        const speculation = work.queue?.speculation;
        const published = !!speculation && speculation.tip === pr.head && speculation.policyRevision === work.policyRevision;
        const docsBudget = published && pr.open && !pr.merged
          ? await world.tipDocs(work, pr.head, speculation!.base, checks.filter(run => !run.source).map(run => ({ id: run.id, name: run.name, status: 'completed', conclusion: run.result })))
          : undefined;
        return {
          clockOffset: { min: 0, max: 0 }, prState: pr.open ? 'open' : 'closed', draft: false, prCreatedAt: new Date(pr.createdAt).toISOString(),
          candidate: { sha: pr.head, baseSha: pr.base, pr: pr.number, branch: pr.branch, author: pr.author, createdAt: new Date(pr.createdAt).toISOString() },
          checks,
          // GitHub's latest verdict per reviewer, and the id of every review, as the real adapter reports them.
          reviews: [...new Map(pr.reviews.map(review => [review.reviewer, { ...review }])).values()], reviewIds: pr.reviews.map(review => review.id),
          // A reviewer App's verdict is read for the request the item is bound to, never for another.
          ...(pr.agentReview && work.reviewRequest?.commentId === pr.agentReview.requestId ? { agentReview: { ...pr.agentReview } } : {}),
          merged: !!pr.merged, mergeSha: pr.merged?.sha ?? null, mergedAt: pr.merged ? new Date(pr.merged.at).toISOString() : null,
          mergeable: pr.open, conflicting: false, baseTip: world.tip, baseTree: world.tree, baseTipContained: world.contains(pr.head, world.tip),
          protected: true, requiredChecks: [{ name: 'test', appId: options.ciAppId }, { name: 'typecheck', appId: options.ciAppId }, { name: protectionOnlyCheck, appId: null }, { name: statusContext, appId: null }], files: pr.files, scopeFiles: world.strays.get(pr.head) ?? [], ...(landing ? { landing } : {}), at: new Date(now).toISOString(),
          // What the base changed since the bound base, which an optimistic merge (GY-500) needs disjoint from the head's files.
          ...(pr.open ? { baseChanges: world.baseChangesSince(pr.base) } : {}),
          // The failing published tip's docs counts (GY-574), from which its overflow is attributed.
          ...(docsBudget ? { docsBudget } : {}),
        };
      },
      // The main guard (GY-500): CI's verdict on base-branch commits, and the revert pull requests it opens and lands head-bound.
      async baseBranch() { return { tip: world.tip, tree: world.tree }; },
      async commitChecks(commit: string) { return world.commitChecks(commit, clock.now()); },
      async openRevert(work: Work, merge: OptimisticMerge): Promise<{ pr: number; head: string } | { refusal: string }> {
        const refusal = revertRefusal(merge, world.baseChangesSince(merge.mergeSha));
        if (refusal) return { refusal };
        const open = world.reverts.find(entry => entry.key === work.key && !entry.merged);
        if (open) return { pr: open.pr, head: open.head };
        const head = world.record({ sha: sha('revert', merge.mergeSha), tree: sha('tree', 'revert', merge.mergeSha), parents: [world.tip], files: world.files, at: clock.now(), message: `Revert optimistic merge of ${work.key}` });
        const pr = 90_000 + options.firstPullRequest + world.reverts.length;
        world.reverts.push({ pr, key: work.key, head: head.sha, files: merge.lane.files, merged: null, openedAt: clock.now(), mergedAt: null });
        return { pr, head: head.sha };
      },
      async mergeRevert(_work: Work, revert: Pick<OptimisticRevert, 'pr' | 'head'>): Promise<string | null> {
        const entry = world.reverts.find(candidate => candidate.pr === revert.pr && candidate.head === revert.head);
        if (!entry) throw new Error(`No revert pull request #${revert.pr} at ${revert.head}`);
        if (entry.merged) return entry.merged;
        // The revert restores the culprit's files: the base branch holds no breaking change after it.
        entry.merged = world.commit(`Merge pull request #${entry.pr} from graphyard-revert/${entry.key.toLowerCase()}`, world.files, clock.now(), [world.tip, entry.head], undefined, { changed: entry.files, broken: false }).sha;
        entry.mergedAt = clock.now();
        return entry.merged;
      },
      async publishSpeculativeTip(work: Work, placement: QueuePlacement): Promise<QueueSpeculation> {
        const pr = world.pr(work), predicted = placement.predictedBase!;
        const base = { ref: queueRef(work.key), base: predicted, baseTree: world.commits.get(predicted)!.tree, predecessors: placement.predecessors, policyRevision: work.policyRevision, publishedAt: new Date(clock.now()).toISOString(), trigger: 'queue-head' as const };
        // A republication resets the branch to the item's own reviewed head first (GY-568), so a
        // rebuilt tip never carries an entry that left the queue unlanded.
        const speculation = work.queue?.speculation;
        const reviewedHead = (speculation && speculation.tip === pr.head ? speculation.reviewedHead : undefined) ?? pr.head;
        // A reviewed head that already contains its predicted base is the tip itself; otherwise the base is merged in, as GitHub's /merges does.
        if (world.contains(reviewedHead, predicted)) return { ...base, tip: reviewedHead, tipTree: world.commits.get(reviewedHead)!.tree, reviewedHead };
        const from = reviewedHead, bound = pr.base, tip = sha('tip', from, predicted), onto = world.commits.get(predicted)!;
        const changed = onto.files.filter(file => !world.commits.get(bound)!.files.includes(file));
        world.record({ sha: tip, tree: sha('tree', tip), parents: [from, predicted], files: [...new Set([...world.commits.get(from)!.files, ...onto.files])], at: clock.now(), message: `Graphyard speculative tip for ${work.key}` },
          world.mergedContents(from, predicted, work.plannedFiles ?? []));
        pr.head = tip; pr.base = predicted; pr.pushed.set(tip, clock.now());
        if (!world.flakeTips.has(work.key)) world.flakeTips.set(work.key, tip);
        return { ...base, tip, tipTree: sha('tree', tip), reviewedHead: from,
          merge: { from, parents: [from, predicted], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: changed, diff: { reviewed: sha('patch', from), tip: sha('patch', from) } } };
      },
      async refreshCandidateBase(work: Work): Promise<BaseRefresh> {
        // No candidate in this world conflicts: a GitHub reading that says so is stale, as GY-375 found.
        const pr = world.pr(work), at = new Date(clock.now()).toISOString();
        return { from: { sha: pr.head, baseSha: pr.base }, base: world.tip, baseTree: world.tree, policyRevision: work.policyRevision, at, head: pr.head, conflict: null, merge: null, carry: null,
          stale: { head: pr.head, base: world.tip, policyRevision: work.policyRevision, at, reading: `GitHub reported ${pr.head.slice(0, 12)} conflicting, but a test merge is clean` } } as BaseRefresh;
      },
      // Restores a branch that carries another item's unlanded commits (GY-127): back to the item's
      // own reviewed head, then the base branch merged onto it. The production restore runs over this
      // repository, so what it records — published, refused, retried or escalated (GY-854) — is
      // decided where production decides it; the world only answers its reads and writes.
      async restoreBranch(work: Work, restore: Parameters<GitHub['restoreBranch']>[1]): Promise<BaseRefresh> {
        const pr = world.pr(work), base = world.options.baseBranch;
        const write = (kind: 'reset' | 'merge') => {
          const refused = world.refusedBranches.has(work.key);
          world.restoreWrites.push({ key: work.key, write: kind, refused, at: clock.now() });
          if (refused) throw new Refusal(`GitHub ${kind === 'reset' ? 'PATCH /git/refs/heads/' + pr.branch : 'POST /merges'} failed (403): Protected branch update failed for refs/heads/${pr.branch}`, 502);
        };
        let built: { sha: string; base: string } | null = null;
        const provider: GitHub = Object.assign(Object.create(GitHub.prototype), {
          config: { repository: world.options.repository, base },
          request: async (path: string) => {
            if (path === `/pulls/${pr.number}`) return { number: pr.number, head: { sha: pr.head, ref: pr.branch }, base: { ref: base }, state: pr.open ? 'open' : 'closed', draft: false };
            throw new Error(`The simulated restore asked GitHub for ${path}`);
          },
          baseBranch: async () => ({ tip: world.tip, tree: world.tree }),
          ownReviewedHead: async () => pr.head,
          refHead: async () => pr.head,
          describeMerge: async () => null,
          // The restored commit is built off the branch (GY-1087), so the branch's one write is the move to it.
          updateBranch: async (_branch: string, head: string) => {
            write('reset'); pr.head = head; pr.pushed.set(head, clock.now());
            if (built?.sha === head) pr.base = built.base;
          },
          mergeOnScratch: async (_key: string, own: string, tip: string, message: string) => {
            const onto = world.commits.get(tip)!;
            built = { sha: sha('restore', own, tip), base: tip };
            return world.record({ sha: sha('restore', own, tip), tree: sha('tree', 'restore', own, tip), parents: [own, tip], files: [...new Set([...world.commits.get(own)!.files, ...onto.files])], at: clock.now(), message },
              world.mergedContents(own, tip, work.plannedFiles ?? [])).sha;
          },
        });
        return provider.restoreBranch(work, restore);
      },
      async requestAgentReview(work: Work, profile: { name: string; reviewerApp: string; runtime: string }): Promise<ReviewRequest> {
        const pr = world.pr(work), request: ReviewRequest = { commentId: ++world.serial, sha: pr.head, baseSha: pr.base, policyRevision: work.policyRevision, body: `review ${profile.name}`, createdAt: new Date(clock.now()).toISOString(),
          provider: 'agent', profile: profile.name, reviewerApp: profile.reviewerApp, marker: uuid(sha('marker', world.serial)) };
        pr.agentRequests.push(request);
        return request;
      },
      async requestCodex(): Promise<ReviewRequest> { throw new Error('No item in this world asks for a Codex review'); },
      async publish(work: Work) {
        if (!work.candidate) return;
        const pr = world.pr(work), passed = work.gates.every(gate => gate.passed) && !work.violations.length;
        if (pr.head !== work.candidate.sha) return;
        const previous = pr.graphyardCheck.get(pr.head);
        if (previous?.conclusion !== (passed ? 'success' : 'failure')) pr.graphyardCheck.set(pr.head, { conclusion: passed ? 'success' : 'failure', at: clock.now() });
      },
      // As GitHub.publishLandable: a success is written only while the pull request still has that
      // head, and a run that already says the same is not written again.
      async publishLandable(work: Work, all: Work[], beforeWrite: (success: boolean) => Promise<void> = async () => {}) {
        const body = landableCheckRun(work, all, new Date(clock.now()));
        if (!body) return;
        const request = (kind: 'list' | 'pull' | 'post' | 'patch') => world.landableRequests.push({ key: work.key, head: body.head_sha, kind, at: clock.now() });
        const success = body.conclusion === 'success';
        if (success) {
          request('pull');
          if (world.pr(work).head !== body.head_sha) return;
        }
        request('list');
        const runs = world.landable.get(body.head_sha) ?? [];
        const existing = runs.at(-1);
        if (landableCheckCurrent(existing?.body, body)) return;
        await beforeWrite(success);
        request(existing ? 'patch' : 'post');
        if (existing) { existing.body = body; existing.writes++; }
        else world.landable.set(body.head_sha, [...runs, { id: ++world.serial, body, writes: 1 }]);
      },
      async mergeQueueState(number: number): Promise<GitHubMergeQueueState> {
        const pr = world.prs.get(number)!;
        return { pullRequestId: `PR_${number}`, head: pr.head, queue: false, mergeStateStatus: world.mergeState(pr, clock.now()), mode: pr.autoMerge ? 'auto-merge' : 'none', entryState: null, position: null, groupHead: null, at: new Date(clock.now()).toISOString() };
      },
      async enqueuePullRequest(state: GitHubMergeQueueState, head: string) {
        const pr = world.prs.get(Number(state.pullRequestId.slice(3)))!;
        if (pr.head !== head) throw new Error(`Head ${head.slice(0, 12)} is not the pull request's head`);
        pr.mergeRequestedAt ??= clock.now();
        // A pull request GitHub reports mergeable now is merged at once, head-bound; anything else is set to auto-merge.
        if (mergeableNow(state)) world.merge(pr, clock.now(), 'immediate');
        else pr.autoMerge = true;
      },
      async dequeuePullRequest(state: GitHubMergeQueueState) { const pr = world.prs.get(Number(state.pullRequestId.slice(3)))!; pr.autoMerge = false; },
      async publishGroupCheck() {},
      async rerunFailedJobs(checkRunId: number) { return world.rerun(checkRunId); },
    };
    return adapter as unknown as GitHub;
  }

  /** `gh` as the guarded merge reads it: the pull request, the base ref and its commits. */
  gh(repository: string) {
    return async (command: string, args: string[]) => {
      if (command !== 'gh') throw new Error(`Unexpected command ${command}`);
      if (args[0] === 'pr' && args[1] === 'view') {
        const pr = this.prs.get(Number(args[2]))!;
        return JSON.stringify({ headRefOid: this.stuckHeads.has(pr.head) ? sha('stuck', pr.head) : pr.head, baseRefName: this.options.baseBranch, state: pr.open ? 'OPEN' : 'MERGED', isDraft: false });
      }
      const path = args.find(arg => arg.startsWith(`repos/${repository}/`)) ?? '';
      if (path.endsWith(`/git/ref/heads/${this.options.baseBranch}`)) return JSON.stringify({ ref: `refs/heads/${this.options.baseBranch}`, object: { type: 'commit', sha: this.tip } });
      const reviews = /\/pulls\/(\d+)\/reviews$/.exec(path);
      if (reviews) {
        const pr = this.prs.get(Number(reviews[1]))!;
        return JSON.stringify(pr.reviews.map(review => ({ id: review.id, user: { login: review.reviewer }, commit_id: review.sha, state: review.state })));
      }
      const commit = /\/commits\/([0-9a-f]{40})$/.exec(path)?.[1];
      if (commit) return JSON.stringify({ sha: commit, commit: { tree: { sha: this.commits.get(commit)?.tree ?? sha('tree', commit) } } });
      throw new Error(`Unexpected gh call: ${args.join(' ')}`);
    };
  }
}

// ---------------------------------------------------------------------------
// Herdr: the sessions the loop launched, as its listing shows them.
// ---------------------------------------------------------------------------
export class SimulatedHerdr {
  agents = new Map<string, HerdrAgent>();
  /** Panes whose runtime has exited: the bare shells GY-842 reclaims, with the worktree they sit in. */
  shells = new Map<string, string | undefined>();
  closed: string[] = [];
  /** When each close was made, on the simulated clock: the drain, pass by pass. */
  closedAt = new Map<string, number>();
  private panes = 0;
  constructor(now: () => number = () => Date.now()) { this.now = now; }
  private now: () => number;
  open(name: string, status = 'working', cwd?: string) { const pane = `w1:p${++this.panes}`; this.agents.set(pane, { name, pane_id: pane, agent: 'claude', agent_status: status, cwd }); return pane; }
  /** A pane with no agent in it that no session of this day's launched: the backlog a previous day left. */
  shell(pane: string, cwd?: string) { this.shells.set(pane, cwd); }
  status(pane: string, status: string) { const agent = this.agents.get(pane); if (agent) agent.agent_status = status; }
  /** A runtime that died: its pane is left behind as a bare shell in the worktree it ran in. */
  kill(pane: string) { const agent = this.agents.get(pane); this.shells.set(pane, agent?.cwd); this.agents.delete(pane); }
  close(pane: string) {
    if (!this.agents.has(pane) && !this.shells.has(pane)) throw Object.assign(new Error(`Herdr refused the operation: pane_not_found`), { herdrCode: 'pane_not_found' });
    this.agents.delete(pane); this.shells.delete(pane); this.closed.push(pane); this.closedAt.set(pane, this.now());
  }
  /** The agent inventory: every session with its agent, and every bare shell with none. */
  list(): HerdrAgent[] {
    const named = [...this.agents.values()].map(agent => ({ ...agent }));
    const bare = [...this.shells.keys()].map(pane => ({ pane_id: pane, agent: null as string | null, agent_status: 'unknown', cwd: this.shells.get(pane) }));
    return [...named, ...bare];
  }
  /** The pane inventory (`herdr pane list`): every pane, with or without an agent in it. */
  paneList(): { pane_id: string }[] { return [...new Set([...this.agents.keys(), ...this.shells.keys()])].map(pane_id => ({ pane_id })); }
  byName(name: string) { return [...this.agents.values()].find(agent => agent.name === name); }
}

// ---------------------------------------------------------------------------
// Pi: headless runs (GY-453), detached from the loop that started them. A run's process lives here,
// in the world, not in the loop: the loop's restart (`detachRuns`) leaves it running, and the loop
// that follows adopts it from its directory under the real run registry on disk. The world ends a
// run with a submission, or kills it from outside so it ends without one: lost.
// ---------------------------------------------------------------------------
interface SimulatedRunProcess { state: 'live' | 'submitted' | 'killed' | 'cancelled'; payload: unknown; detail: string; wake: Set<() => void> }
export class SimulatedPi implements Runner {
  readonly name = 'pi';
  processes = new Map<string, SimulatedRunProcess>();
  started: string[] = [];
  start<T>(_prompt: string, options: RunOptions<T>): Run<T> {
    const directory = join(options.runs!, randomUUID());
    mkdirSync(directory, { recursive: true });
    this.processes.set(directory, { state: 'live', payload: null, detail: '', wake: new Set() });
    this.started.push(directory);
    return this.adopt(directory, options);
  }
  adopt<T>(directory: string, options: Pick<RunOptions<T>, 'tool' | 'validate'>): Run<T> {
    const child = this.processes.get(directory)!, events: RunEvent[] = [], listeners = new Set<(event: RunEvent) => void>();
    let resolve!: (result: RunResult<T>) => void, detached = false;
    const result = new Promise<RunResult<T>>(done => { resolve = done; });
    const settle = () => {
      if (detached || child.state === 'live') return;
      child.wake.delete(settle);
      if (child.state === 'submitted') { const payload = options.validate(child.payload); resolve({ ok: true, tool: options.tool, payload, payloads: [payload] }); }
      else resolve({ ok: false, failure: { reason: child.state === 'killed' ? 'lost' : 'cancelled', detail: child.detail }, payloads: [] });
    };
    child.wake.add(settle); settle();
    return { id: directory, directory, events,
      onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      cancel: reason => this.end(directory, 'cancelled', null, reason ?? 'cancelled'),
      detach: () => { detached = true; child.wake.delete(settle); },
      result: () => result };
  }
  private end(directory: string, state: SimulatedRunProcess['state'], payload: unknown, detail: string) {
    const child = this.processes.get(directory);
    if (!child || child.state !== 'live') return;
    Object.assign(child, { state, payload, detail });
    for (const wake of [...child.wake]) wake();
  }
  /** The agent submits through its Graphyard tool and exits. */
  submit(directory: string, payload: unknown) { this.end(directory, 'submitted', payload, ''); }
  /** Killed from outside (OOM, a host reboot): gone, recording no exit. */
  kill(directory: string) { this.end(directory, 'killed', null, 'the run\'s process is gone and recorded no exit'); }
  live() { return [...this.processes.values()].filter(child => child.state === 'live').length; }
}
