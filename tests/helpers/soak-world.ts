import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, RunEvent, RunOptions, RunResult, Runner } from '../../src/runner/types.js';
import { RerunPending, landingCheck, scopeLookupBudget, type GitHub, type LandingGitHub } from '../../src/github.js';
import type { HerdrAgent } from '../../src/master.js';
import type { Observation, Work } from '../../src/model.js';
import type { AgentReview, ReviewRequest } from '../../src/model/review.js';
import { landableCheckCurrent, landableCheckRun, type LandableCheckRun } from '../../src/landable-check.js';
import { heldBase, mergeableNow, requestedBaseRefresh, type BaseRefresh, type GitHubMergeQueueState, type LandingCheck } from '../../src/merge-queue.js';
import type { Succession } from '../../src/model/successors.js';
import type { BaseCheck } from '../../src/model/base-failure.js';
import { failedTestsAnnotation, readBaseBreak, type BaseBreak } from '../../src/master/base-break-refresh.js';
import { botCommitSubjectPattern, parseClassifiedFindings } from '../../src/mechanical-findings.js';
import { blockingFindings } from '../../src/review-cap.js';

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
/**
 * The test the briefly broken base branch fails (GY-793): CI names it in the failed-tests
 * annotation of the candidate pushed against the broken commit, of that commit's own run, and of
 * the candidate's rerun, and the tip that fixed the branch does not name it.
 */
export const brokenBaseTest = 'tests/soak/base-branch.test.ts › the suite the base branch broke';
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
 * A commit: on the base branch, a worker's head, or a merge Graphyard made onto it; `files` is its
 * whole tree's file list, `contents` the content identity of every path it holds. A base-branch
 * commit also names the files it `changed` against its first parent, and whether the required suite
 * fails on it (`broken`, GY-793).
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
   * holds those pages as real prose (so the loop's headroom count reads real text) and runs the
   * project's `unit:docs-word-budget` check on every head, failing it when the head's total is over
   * the budget.
   */
  docs?: { budget: { total: number; perPage: number }; pages: Record<string, number> };
  /** GY-1250: the adapter answers the main guard's reads and writes (GitHub delivery's guard runs in `processJob`). */
  mainGuard?: boolean;
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
   * Items whose head conflicts with the base branch in a docs page once the base changed that page
   * after the head was pushed (GY-566), until a docs-sync merges the base in: the page each conflicts in.
   */
  docsConflicts = new Map<string, string>();
  /**
   * Items GitHub keeps BLOCKED for `blockedMergeMs` after their required check passed (GY-430): a
   * branch-protection condition Graphyard does not gate on, such as a review GitHub still requires.
   */
  blockedMerge = new Set<string>();
  /** Successions (renames and splits) recorded on the base branch. */
  successions: Succession[] = [];
  /**
   * A required-check failure on the base branch (GY-528): a commit landed outside Graphyard that
   * fails one `test` test in every tree containing it, until a later commit repairs it. A head is
   * failing while it contains the breaking commit and not the repair, so a rerun of its job fails
   * again and only the repaired base merged in clears it.
   */
  baseFailure = { test: 'soak:time-bomb — a fixed date held against the clock', broken: null as string | null, repaired: null as string | null };
  /**
   * GY-793: the base-branch commits that broke the required suite while they stood at the tip of a
   * briefly broken main. CI reports the head pushed against one as failing `test` on the suite the
   * commit broke, naming it in the failed-tests annotation the base-breakage judgement reads, and
   * the run fails again on the rerun — the candidate is not the failure's author, its base was.
   */
  baseBreaks = new Set<string>();
  /** The annotations CI published per check-run id: the failed-tests record GY-793's judgement parses. */
  annotations = new Map<number, { message?: string | null }[]>();
  /**
   * Items whose first pushed head hits an infrastructure flake (GY-516): its `test` run fails,
   * and the one rerun the control plane asks for passes (`rerun-passes`) or fails again (`rerun-fails`).
   */
  flaky = new Map<string, 'rerun-passes' | 'rerun-fails'>();
  /**
   * GY-1329: items whose flake's workflow run keeps running its other jobs for this long after the
   * failed `test` check reported. GitHub refuses (403) to rerun a run that has not completed, so an
   * owed rerun must wait for it: every read of the run while it runs is kept in `runReads`.
   */
  unfinishedRunMs = new Map<string, number>();
  runReads: { key: string; checkRunId: number; status: string; at: number }[] = [];
  /** The rerun POSTs GitHub refused because the workflow run had not completed (GY-1329). */
  refusedReruns: { key: string; checkRunId: number; at: number }[] = [];
  /** The CI runs reported per commit, created once CI finishes on it; a rerun appends a later attempt. */
  runs = new Map<string, { name: string; result: string; id: number; attempt: number; at: number; tests: string[] }[]>();
  /** Every rerun the control plane asked for: the item, the tip and the failed check run. */
  reruns: { key: string; sha: string; checkRunId: number; at: number }[] = [];
  /** The failed base-failure jobs rerun (GY-528), each with who asked: the loop's remedy step, or the engine's own first check-rerun (GY-516). */
  baseReruns: { jobId: number; by: 'loop' | 'engine' }[] = [];
  /** The `graphyard/landable` runs the control plane published per head (GY-887), with how often each was written. */
  landable = new Map<string, { id: number; body: LandableCheckRun; writes: number }[]>();
  /** Every GitHub request publishing the landability verdict cost: the head's run listing, the pull request read before a success, and each write. */
  landableRequests: { key: string; head: string; kind: 'list' | 'pull' | 'post' | 'patch'; at: number }[] = [];
  /** Each item's first pushed head, the one its flake hits. */
  private flakeTips = new Map<string, string>();
  /**
   * GY-839. Heads whose compares GitHub answers without a usable merge base while they are listed
   * here, so the landing check keeps the two-way endpoint diff and the base's own new changes read
   * as reverts — the reading this item fixes, staged as a fault the simulated day must recover from.
   */
  staleMergeBase = new Set<string>();
  /**
   * GY-971. Items whose reviewer reads only heads a person or a worker pushed, as a reviewer asked for
   * a review does: a Graphyard-authored tip or base refresh carries its approval and is not read again.
   */
  carriedOnly = new Set<string>();
  /**
   * GY-971. The body of a review, when the day writes one: an approval's nits classified mechanical
   * are counted onto its observed review, except on a head that is the bot round's own commit.
   */
  reviewBody: ((key: string, review: { id: number; sha: string; state: string; reviewer: string }) => string) | null = null;
  /**
   * GY-1389. The body of a change request, when the day writes one: the real adapter reads it, and
   * its BLOCKING: findings from the whole body, for a head past the review-round cap (GY-1118).
   */
  changeRequestBody: ((key: string, review: { id: number; sha: string; state: string; reviewer: string }) => string | null) | null = null;
  /** How many times the landing check ran in the loop, the bases it judged, and the two compare kinds it asked; and every head answered blind (GY-839). */
  landingChecks = 0; landingBases = new Set<string>(); ancestorCompares = 0; blindCompares = 0; blindHeads = new Set<string>();
  /**
   * GY-1250. Items whose next merge breaks main's `test` check, though each pull request passed CI
   * alone (the parallel-merge fault the main guard answers), and those whose revert's own `test`
   * fails too, so the guard must give it up after one attempt.
   */
  breaksMain = new Set<string>(); revertFails = new Set<string>();
  /** Each merge that broke main, and the commits that clear it: its revert's inverse commit, or a fix made on main by hand. */
  broken: { key: string; mergeSha: string; clearedBy: Set<string> }[] = [];
  /** The revert pull requests the main guard opened, numbered apart from the items' own. */
  reverts = new Map<number, { key: string; mergeSha: string; head: string; inverse: string; open: boolean; merged: { sha: string; at: number } | null; closed: string | null; closedAt: number | null; at: number; approvals: string[] }>();
  /** Every GitHub request the main guard made, with the simulated minute it made it in. */
  guardRequests: { kind: 'history' | 'checks' | 'open' | 'pull' | 'merge-diff' | 'revert-diff' | 'approve' | 'merge' | 'close'; at: number; sha?: string; pr?: number }[] = [];
  /** CI's runs on base-branch and revert commits, reported `ciMs` after the commit. */
  private commitRuns = new Map<string, { name: string; result: string; id: number }[]>();
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
   * owns (its planned scope, plus paths the base lacks) taken from `own`. A base refresh merges
   * the base into the item's head, so the result must hold the base's current
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
   * split). It changed `changed` (default: the files added or removed). `contents` overrides the
   * merged content, as a hand edit's tree really holds it.
   */
  /** An approval's mechanical-nit count as the real adapter observes it (src/github.ts), when the day writes review bodies. */
  /** A change request's body and BLOCKING: findings as the real adapter observes them (GY-1118), when the day writes one. */
  changeRequest(key: string, review: { id: number; sha: string; state: string; reviewer: string }): { body?: string; blocking?: string[] } {
    const body = review.state === 'CHANGES_REQUESTED' ? this.changeRequestBody?.(key, review) : null;
    return body ? { body, blocking: blockingFindings(body) } : {};
  }
  mechanicalNits(key: string, review: { id: number; sha: string; state: string; reviewer: string }): { mechanical?: number } {
    if (!this.reviewBody || review.state !== 'APPROVED' || botCommitSubjectPattern.test(this.commits.get(review.sha)?.message ?? '')) return {};
    const count = parseClassifiedFindings(this.reviewBody(key, review)).filter(finding => finding.classification === 'mechanical').length;
    return count ? { mechanical: count } : {};
  }
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
    // GY-1291: the main guard compares a revert's diff with its merge's, so in its world a pull
    // request changes the content of each file it plans (prose pages keep their real text).
    if (this.options.mainGuard) for (const path of files) if (path !== grow?.page && !(this.options.docs && path in this.options.docs.pages)) contents.set(path, sha('content', path, head));
    this.record({ sha: head, tree: sha('tree', head), parents: [this.tip], files: [...new Set([...this.files, ...files])], at: clock.now(), message: `${key} head` }, contents);
    Object.assign(pr, { head, base: this.tip, files, autoMerge: false, mergeRequestedAt: null });
    pr.pushed.set(head, clock.now());
    if (!this.flakeTips.has(key)) this.flakeTips.set(key, head);
    return pr;
  }
  /** Whether `commit`'s tree carries the base failure: it contains the breaking commit and not the repair. */
  failing(commit: string) {
    const { broken, repaired } = this.baseFailure;
    return !!broken && this.contains(commit, broken) && !(repaired && this.contains(commit, repaired));
  }
  /** The failing test names the log of check run `id` reports: the base failure's test for a run the base failure failed (GY-528); none for a flake or a passed run, whose log names no failing test. */
  failedTests(id: number) {
    const found = [...this.runs.values()].flat().find(entry => entry.id === id);
    if (!found) throw new Error(`No check run ${id}`);
    return found.result === 'failure' ? [...found.tests] : [];
  }
  /** The base branch head's latest run of `check`: pending until `ciMs` after the tip landed; failed while the tip carries the base failure (GY-528). */
  baseCheck(check: string): BaseCheck {
    const tip = this.tip, commit = this.commits.get(tip)!, jobId = Number.parseInt(tip.slice(0, 7), 16);
    if (clock.now() - commit.at < this.options.ciMs) return { check, baseSha: tip, state: 'pending', jobId: null, url: null, tests: null };
    // GY-1332: in the main guard's world main's `test` is red too while it holds a merge that broke it.
    const guardRed = check === 'test' && !!this.options.mainGuard && this.commitChecks(tip, clock.now()).some(run => run.name === 'test' && run.result === 'failure');
    const failed = check === 'test' && this.failing(tip);
    return { check, baseSha: tip, state: failed || guardRed ? 'failed' : 'passed', jobId, url: null, tests: failed ? [this.baseFailure.test] : guardRed ? null : [] };
  }
  /** Whether this pull request's head conflicts with the base tip: a docs conflict the base has moved past. */
  conflicting(pr: PullRequest) { return pr.open && this.docsConflicts.has(pr.key) && !this.contains(pr.head, this.tip); }
  /**
   * A docs-sync session merges base tip `base` into the reviewed head, resolving the docs page both
   * changed, and pushes the merge to the item's branch (a plain push: it refuses a branch that moved).
   */
  docsSync(key: string, head: string, base: string) {
    const pr = [...this.prs.values()].find(entry => entry.key === key && entry.open);
    if (!pr || pr.head !== head) return null;
    // The session merges the base in, as GitHub's merge commit holds it: the base's content with the
    // pull request's own changes taken from its head — never the head's stale copy of a path the
    // base changed since, which the landing check would read as a change outside the plan.
    const onto = this.commits.get(base)!, own = this.commits.get(head)!, contents = new Map(onto.contents);
    for (const [path, blob] of own.contents) if (pr.files.includes(path) || !contents.has(path)) contents.set(path, blob);
    const merged = this.record({ sha: sha('docs-sync', head, base), tree: sha('tree', 'docs-sync', head, base), parents: [head, base],
      files: [...new Set([...own.files, ...onto.files])], at: clock.now(), message: `Graphyard docs-sync of ${key} onto ${base.slice(0, 12)}` }, contents);
    Object.assign(pr, { head: merged.sha, base, autoMerge: false, mergeRequestedAt: null });
    pr.pushed.set(merged.sha, clock.now());
    this.docsConflicts.delete(key);
    return merged;
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
    if (!params.get('per_page')) { if (blind) { this.blindCompares += 1; this.blindHeads.add(to); } if (truth === from && from !== to) this.ancestorCompares += 1; }
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
    const pr = this.pr(work);
    const holding = this.contains(pr.head, this.tip) ? null : heldBase(work, pr.head, this.tip);
    const bound = holding && this.contains(this.tip, holding) ? holding : this.tip;
    const landing = await landingCheck(this.port(), work, pr.head, this.prFiles(pr), bound, { tip: this.tip, tree: this.tree }, peers, { remaining: scopeLookupBudget });
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

  /** The CI runs that have reported on `pr`'s head by `now`: every attempt, as GitHub keeps them. A `test` run fails when the head hits the item's flake (GY-516) or carries the base branch's failing test (GY-528); the flake decides the log's failing tests, so a flake goes down the rerun path, not the base-failure one. */
  checks(pr: PullRequest, now: number) {
    const head = pr.head;
    if (now - pr.pushed.get(head)! < this.options.ciMs) return [];
    if (!this.runs.has(head)) {
      const flake = this.flakeTips.get(pr.key) === head && this.flaky.has(pr.key);
      // GY-793: CI tests the head merged with the base it was pushed against, so a head whose base
      // commit broke the suite fails `test` on it and names it, whatever the head itself changed.
      const brokenBase = this.baseBreaks.has(pr.base);
      // `secrets` is required by the base branch's protection alone (GY-1060), bound to no app, as
      // PR #221's scan was: every gate, verdict and window view of the day reads it beside the policy's.
      // A base-failure run (GY-528) names its failing test in its log; a flake's and a breakage's name none there.
      const bombed = (name: string) => name === 'test' && !flake && !brokenBase && this.failing(head);
      const runs = ['test', 'typecheck', protectionOnlyCheck].map(name => {
        const run = { name, result: name === 'test' && (flake || brokenBase || bombed(name)) ? 'failure' : 'success', id: ++this.serial, attempt: 1, at: now, tests: bombed(name) ? [this.baseFailure.test] : [] as string[] };
        if (name === 'test' && brokenBase) this.annotations.set(run.id, [{ message: failedTestsAnnotation([brokenBaseTest]) }]);
        return run;
      });
      // The project's own documentation budget check (GY-574): the budget is the project's own
      // rule, counted over the pages its configuration names (here docs/ and README.md, as the
      // committed graphyard.json does), and this project's CI fails the check when that total is
      // over the budget.
      if (this.options.docs) {
        const commit = this.commits.get(head)!;
        const total = [...commit.contents].filter(([path]) => path === 'README.md' || /^docs\/.+\.md$/.test(path))
          .reduce((sum, [, text]) => sum + text.split(/\s+/).filter(Boolean).length, 0);
        runs.push({ name: 'unit:docs-word-budget', result: total > this.options.docs.budget.total ? 'failure' : 'success', id: ++this.serial, attempt: 1, at: now, tests: [] });
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
  /** GitHub's "rerun failed jobs": the failed run's job runs again on the same commit, reporting `ciMs` later. A rerun of a base-failure job fails again (GY-528): the merge commit it reuses still carries the breaking change, and only the repaired base merged in clears it. A documentation-budget breach is not a flake either: the rerun judges the commit's pages again (GY-574). */
  rerun(checkRunId: number, by: 'loop' | 'engine' = 'engine') {
    const [head, runs] = [...this.runs].find(([, entries]) => entries.some(entry => entry.id === checkRunId)) ?? [];
    const failed = runs?.find(entry => entry.id === checkRunId);
    if (!head || !runs || !failed || failed.result !== 'failure') throw new Error(`GitHub POST /actions/jobs/${checkRunId}/rerun refused: not a failed job`);
    const pr = [...this.prs.values()].find(entry => entry.head === head)!;
    const now = clock.now();
    if (this.runStatus(checkRunId, now) !== 'completed') {
      this.refusedReruns.push({ key: pr.key, checkRunId, at: now });
      throw new Error(`GitHub POST /actions/runs/${900_000 + checkRunId}/rerun-failed-jobs failed (403) "This workflow run is not completed": the App permission preflight found no missing permission`);
    }
    const base = failed.tests.length > 0;
    if (base) this.baseReruns.push({ jobId: checkRunId, by });
    else this.reruns.push({ key: pr.key, sha: head, checkRunId, at: now });
    // The rerun runs on the same commit, so a base-branch breakage fails it again (GY-793): only
    // the flake whose rerun passes, or a run whose cause the head itself holds, comes back green.
    const brokenBase = this.baseBreaks.has(pr.base) && failed.name === 'test';
    const breached = failed.name === 'unit:docs-word-budget' && this.options.docs
      ? [...(this.commits.get(head)?.contents ?? [])].filter(([path]) => path === 'README.md' || /^docs\/.+\.md$/.test(path))
          .reduce((sum, [, text]) => sum + text.split(/\s+/).filter(Boolean).length, 0) > this.options.docs.budget.total
      : undefined;
    const again = breached ?? (base || brokenBase || this.flaky.get(pr.key) === 'rerun-fails');
    const rerun = { name: failed.name, result: again ? 'failure' : 'success', id: ++this.serial, attempt: failed.attempt + 1, at: now + this.options.ciMs, tests: again && base ? [this.baseFailure.test] : [] as string[] };
    if (brokenBase) this.annotations.set(rerun.id, [{ message: failedTestsAnnotation([brokenBaseTest]) }]);
    runs.push(rerun);
    return { runId: 900_000 + checkRunId };
  }
  /** The status of the workflow run behind check run `checkRunId` (GY-1329): `in_progress` while an `unfinishedRunMs` item's first attempt still runs its other jobs. */
  runStatus(checkRunId: number, now: number) {
    const [head, runs] = [...this.runs].find(([, entries]) => entries.some(entry => entry.id === checkRunId)) ?? [];
    const run = runs?.find(entry => entry.id === checkRunId);
    const key = head && [...this.prs.values()].find(entry => entry.head === head)?.key;
    const unfinished = key ? this.unfinishedRunMs.get(key) : undefined;
    return run && unfinished !== undefined && run.attempt === 1 && now < run.at + unfinished ? 'in_progress' : 'completed';
  }
  /** GitHub's "rerun failed jobs" as the adapter asks it: the run is read first, and an unfinished one is named instead (GY-1329); the probe paths' `runRead` skips the read. */
  rerunFailedJobs(checkRunId: number, options: { runRead?: boolean } = {}) {
    if (!options.runRead) {
      const now = clock.now(), status = this.runStatus(checkRunId, now);
      const head = [...this.runs].find(([, entries]) => entries.some(entry => entry.id === checkRunId))?.[0];
      const key = [...this.prs.values()].find(entry => entry.head === head)?.key ?? '';
      this.runReads.push({ key, checkRunId, status, at: now });
      if (status !== 'completed') throw new RerunPending(900_000 + checkRunId, status, 1);
    }
    return this.rerun(checkRunId);
  }
  /** The latest completed run of one check on one commit, as the base-breakage judgement reads the base's and the tip's own runs (GY-793). */
  checkRun(commit: string, name: string): { id: number; conclusion: string | null } | null {
    const pr = [...this.prs.values()].find(entry => entry.head === commit);
    if (pr) {
      const latest = this.checks(pr, clock.now()).filter(run => run.name === name).at(-1);
      return latest ? { id: latest.id, conclusion: latest.result } : null;
    }
    const latest = this.commitChecks(commit, clock.now()).filter(run => run.name === name).at(-1);
    // A broken base commit's failed run names the test it broke, as CI publishes it on every run.
    if (latest && latest.result === 'failure' && this.commits.get(commit)?.broken) this.annotations.set(latest.id, [{ message: failedTestsAnnotation([brokenBaseTest]) }]);
    return latest ? { id: latest.id, conclusion: latest.result } : null;
  }
  /** One minute of GitHub: CI finishes, reviewers post verdicts, reviewer Apps answer, and auto-merge lands what it may. */
  tick(now: number) {
    for (const pr of [...this.prs.values()].filter(entry => entry.open)) {
      const pushedAt = pr.pushed.get(pr.head)!;
      const ciDone = now - pushedAt >= this.options.ciMs;
      // The reviewer judges a head once CI reported on it; an item in `carriedOnly` is not asked
      // again for a Graphyard-authored base refresh, whose approval carries.
      const graphyardHead = this.carriedOnly.has(pr.key) && /^Graphyard /.test(this.commits.get(pr.head)?.message ?? '');
      if (ciDone && !graphyardHead && now - pushedAt >= this.options.ciMs + this.options.reviewMs && !pr.reviews.some(review => review.sha === pr.head)) {
        const plan = this.verdicts.get(pr.key) ?? [];
        const state = plan.shift() ?? 'APPROVED';
        this.verdicts.set(pr.key, plan);
        pr.reviews.push({ reviewer: 'reviewer', sha: pr.head, state, id: ++this.serial, submittedAt: new Date(now).toISOString() });
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
    return now - check.at >= (this.blockedMerge.has(pr.key) ? blockedMergeMs : this.slowRecompute.has(pr.key) ? 6 * minute : 0) ? pr.settledState : 'BLOCKED';
  }
  /** A merge somebody made on GitHub by hand, outside Graphyard: nothing asked for it. */
  mergeOutside(pr: PullRequest, now: number) { this.merge(pr, now, 'outside'); return pr.merged!; }
  private merge(pr: PullRequest, now: number, mode: 'immediate' | 'auto-merge' | 'outside') {
    const state = this.mergeState(pr, now);
    // A head that already contains the base tip lands its own tree, as GitHub's merge commit does.
    const head = this.commits.get(pr.head)!, landsTree = this.contains(pr.head, this.tip);
    // The merge commit holds the base's content with the pull request's changes taken from its
    // head — what GitHub's merge of those two commits really holds — so a page the pull request
    // grew is grown on the base branch after it lands (GY-574's documentation counts read it).
    const firstParent = this.commits.get(this.tip)!.contents ?? new Map<string, string>();
    const contents = new Map(firstParent);
    for (const [path, blob] of head.contents) if (pr.files.includes(path) || !contents.has(path)) contents.set(path, blob);
    const commit = this.record({ sha: sha('commit', ...[this.tip, pr.head], `Merge pull request #${pr.number} from ${pr.branch}`), tree: landsTree ? head.tree : sha('tree', this.tip, pr.head, `Merge pull request #${pr.number} from ${pr.branch}`), parents: [this.tip, pr.head], files: [...new Set([...this.files, ...head.files])], at: now, message: `Merge pull request #${pr.number} from ${pr.branch}`, changed: pr.files, broken: !!this.commits.get(this.tip)!.broken }, contents);
    this.tip = commit.sha;
    pr.merged = { sha: commit.sha, at: now }; pr.open = false; pr.autoMerge = false;
    this.merges.push({ key: pr.key, pr: pr.number, sha: commit.sha, at: now, state, mode });
    // GY-1250: only the item's first merge breaks main; its rework round's merge does not.
    if (this.breaksMain.delete(pr.key)) this.broken.push({ key: pr.key, mergeSha: commit.sha, clearedBy: new Set() });
  }

  // ---- GY-1250: CI on main and the main guard's revert pull requests. ----
  /** CI's runs on a base-branch or revert commit by `now`: `test` fails while it holds a merge that broke main and nothing that clears it. */
  commitChecks(commit: string, now: number) {
    const at = this.commits.get(commit)?.at;
    if (at === undefined || now - at < this.options.ciMs) return [];
    if (!this.commitRuns.has(commit)) {
      // GY-793: a base-branch commit that itself broke the suite (`broken`) fails `test` too.
      const red = !!this.commits.get(commit)!.broken || this.broken.some(entry => this.contains(commit, entry.mergeSha) && ![...entry.clearedBy].some(clear => this.contains(commit, clear)));
      this.commitRuns.set(commit, ['test', 'typecheck', protectionOnlyCheck].map(name => ({ name, result: name === 'test' && red ? 'failure' : 'success', id: ++this.serial })));
    }
    return this.commitRuns.get(commit)!;
  }
  /** Main's first-parent history, newest first, as the commits listing pages it. */
  mainHistory(limit: number) {
    const history: { sha: string; parent: string | null }[] = [];
    for (let at: string | undefined = this.tip; at && history.length < limit; at = this.commits.get(at)!.parents[0]) history.push({ sha: at, parent: this.commits.get(at)!.parents[0] ?? null });
    return history;
  }
  /** The contents of `onto` with exactly `mergeSha`'s change undone: each path it changed back to its first parent's blob, or gone if it added it. */
  private inverseOnto(mergeSha: string, onto: string) {
    const merge = this.commits.get(mergeSha)!, parent = this.commits.get(merge.parents[0])!, contents = new Map(this.commits.get(onto)!.contents);
    for (const path of merge.changed ?? []) {
      const blob = parent.contents.get(path);
      if (blob === undefined) contents.delete(path); else contents.set(path, blob);
    }
    return contents;
  }
  /** The files `to` changes against `from`, as GitHub's compare and pull request files list them: one line per blob. */
  fileChanges(from: string, to: string) {
    const before = this.commits.get(from)!.contents, after = this.commits.get(to)!.contents;
    return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(filename => {
      const old = before.get(filename), now = after.get(filename);
      if (old === now) return [];
      const status = old === undefined ? 'added' : now === undefined ? 'removed' : 'modified';
      const patch = old === undefined ? `@@ -0,0 +1 @@\n+${now}` : now === undefined ? `@@ -1 +0,0 @@\n-${old}` : `@@ -1 +1 @@\n-${old}\n+${now}`;
      return [{ filename, status, previousFilename: null, patch }];
    });
  }
  /** The revert of exactly `mergeSha` opened as a pull request onto main's tip: the merge's inverse, merged with the tip. */
  openRevert(key: string, mergeSha: string) {
    const merge = this.commits.get(mergeSha)!, parent = this.commits.get(merge.parents[0])!, now = clock.now();
    const inverse = this.record({ sha: sha('inverse', mergeSha), tree: parent.tree, parents: [mergeSha], files: parent.files, at: now, message: `Revert ${mergeSha.slice(0, 12)}` }, new Map(parent.contents));
    // A revert whose own checks fail does not clear the merge: its head stays red.
    const entry = this.broken.find(item => item.mergeSha === mergeSha);
    if (entry && !this.revertFails.has(key)) entry.clearedBy.add(inverse.sha);
    const contents = this.inverseOnto(mergeSha, this.tip);
    const head = this.record({ sha: sha('revert-head', this.tip, inverse.sha), tree: sha('tree', 'revert', this.tip, inverse.sha), parents: [this.tip, inverse.sha], files: [...contents.keys()], at: now, message: `Revert ${key}'s merge` }, contents);
    const number = 90_000 + this.reverts.size;
    this.reverts.set(number, { key, mergeSha, head: head.sha, inverse: inverse.sha, open: true, merged: null, closed: null, closedAt: null, at: now, approvals: [] });
    return { pr: number, head: head.sha };
  }
  /** The revert approver App approves the revert at `head` (GY-1291): someone other than the App that pushed it. */
  approveRevertPull(number: number, head: string) {
    const revert = this.reverts.get(number)!;
    if (!revert.open || revert.head !== head) throw new Error(`Revert pull request #${number} is not open at ${head.slice(0, 12)}`);
    revert.approvals.push(head);
  }
  /**
   * The App merges the revert at `head`: its change lands on main's tip. Branch protection requires
   * an approval of that head from someone other than its last pusher, the App (GY-1291).
   */
  mergeRevertPull(number: number, head: string) {
    const revert = this.reverts.get(number)!;
    if (!revert.open || revert.head !== head) throw new Error(`Revert pull request #${number} is not open at ${head.slice(0, 12)}`);
    if (!revert.approvals.includes(head)) throw new Error('New changes require approval from someone other than the last pusher.');
    const now = clock.now(), message = `Merge pull request #${number} from graphyard-revert/main-${revert.mergeSha.slice(0, 12)}`;
    const changed = this.commits.get(revert.mergeSha)!.changed ?? [];
    const contents = this.inverseOnto(revert.mergeSha, this.tip);
    const commit = this.record({ sha: sha('commit', this.tip, head, message), tree: sha('tree', this.tip, head, message), parents: [this.tip, head], files: [...contents.keys()], at: now, message, changed }, contents);
    this.tip = commit.sha;
    revert.merged = { sha: commit.sha, at: now }; revert.open = false;
    return commit.sha;
  }
  /** A fix somebody lands on main by hand for a merge whose revert could not merge: main is green from it on. */
  fixForward(mergeSha: string) {
    const commit = this.commit(`Fix main forward after ${mergeSha.slice(0, 12)}`, this.files, clock.now(), [this.tip], undefined, { changed: [] });
    this.broken.find(entry => entry.mergeSha === mergeSha)?.clearedBy.add(commit.sha);
    return commit;
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
        // GY-793: the same base-breakage judgement the production observer runs, over this
        // repository's own runs and annotations — read only for an open head the tip has moved
        // past, so a candidate whose required check failed only on tests the base broke and the
        // tip fixed is recorded for the refresh that answers it.
        const baseBreak = pr.merged || !pr.open || world.contains(pr.head, world.tip) ? null : await readBaseBreak(
          { required: work.policy.checks, checks, head: pr.head, built: pr.base, tip: world.tip, at: new Date(now).toISOString() },
          { checkRun: (commit, name) => Promise.resolve(world.checkRun(commit, name)), annotations: runId => Promise.resolve(world.annotations.get(runId) ?? []) });
        return {
          clockOffset: { min: 0, max: 0 }, prState: pr.open ? 'open' : 'closed', draft: false, prCreatedAt: new Date(pr.createdAt).toISOString(),
          candidate: { sha: pr.head, baseSha: pr.base, pr: pr.number, branch: pr.branch, author: pr.author, createdAt: new Date(pr.createdAt).toISOString() },
          checks,
          // GitHub's latest verdict per reviewer, and the id of every review, as the real adapter reports them.
          reviews: [...new Map(pr.reviews.map(review => [review.reviewer, { ...review, ...world.mechanicalNits(pr.key, review), ...world.changeRequest(pr.key, review) }])).values()], reviewIds: pr.reviews.map(review => review.id),
          // A reviewer App's verdict is read for the request the item is bound to, never for another.
          ...(pr.agentReview && work.reviewRequest?.commentId === pr.agentReview.requestId ? { agentReview: { ...pr.agentReview } } : {}),
          merged: !!pr.merged, mergeSha: pr.merged?.sha ?? null, mergedAt: pr.merged ? new Date(pr.merged.at).toISOString() : null,
          mergeable: pr.open && !world.conflicting(pr), conflicting: world.conflicting(pr), baseTip: world.tip, baseTree: world.tree, baseTipContained: world.contains(pr.head, world.tip),
          protected: true, requiredChecks: [{ name: 'test', appId: options.ciAppId }, { name: 'typecheck', appId: options.ciAppId }, { name: protectionOnlyCheck, appId: null }, { name: statusContext, appId: null }], files: pr.files, scopeFiles: [], ...(landing ? { landing } : {}), at: new Date(now).toISOString(),
          ...(baseBreak ? { baseBreak } : {}),
        };
      },
      async baseBranch() { return { tip: world.tip, tree: world.tree }; },
      async refreshCandidateBase(work: Work): Promise<BaseRefresh> {
        const pr = world.pr(work), at = new Date(clock.now()).toISOString();
        // The coordinator asked for the repaired base to be merged in (GY-528): this App merges the tip into the branch.
        const requested = requestedBaseRefresh(work);
        if (requested) {
          const from = pr.head, bound = pr.base, tip = world.tip, merged = sha('refresh', from, tip), onto = world.commits.get(tip)!;
          const changed = onto.files.filter(file => !world.commits.get(bound)!.files.includes(file));
          world.record({ sha: merged, tree: sha('tree', merged), parents: [from, tip], files: [...new Set([...world.commits.get(from)!.files, ...onto.files])], at: clock.now(), message: `Graphyard base refresh for ${work.key}` }, world.mergedContents(from, tip, work.plannedFiles ?? []));
          pr.head = merged; pr.base = tip; pr.pushed.set(merged, clock.now());
          return { from: { sha: from, baseSha: bound }, base: tip, baseTree: onto.tree, policyRevision: work.policyRevision, at, head: merged, conflict: null, carry: null, trigger: 'base failure repaired',
            requested: { by: requested.by, at: requested.at, reason: requested.reason },
            merge: { from, parents: [from, tip], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: changed, diff: { reviewed: sha('patch', from), tip: sha('patch', from) } } } as BaseRefresh;
        }
        // Only a docs conflict is real in this world; any other GitHub reading of one is stale, as GY-375 found.
        if (world.conflicting(pr)) return { from: { sha: pr.head, baseSha: pr.base }, base: world.tip, baseTree: world.tree, policyRevision: work.policyRevision, at, head: null, merge: null, carry: null, trigger: 'conflict confirmed',
          conflict: `Candidate ${pr.head.slice(0, 12)} cannot be brought onto base branch tip ${world.tip.slice(0, 12)} without resolving a conflict in ${world.docsConflicts.get(pr.key)}`, conflictPaths: [world.docsConflicts.get(pr.key)!] };
        return { from: { sha: pr.head, baseSha: pr.base }, base: world.tip, baseTree: world.tree, policyRevision: work.policyRevision, at, head: pr.head, conflict: null, merge: null, carry: null,
          stale: { head: pr.head, base: world.tip, policyRevision: work.policyRevision, at, reading: `GitHub reported ${pr.head.slice(0, 12)} conflicting, but a test merge is clean` } } as BaseRefresh;
      },
      // GY-793: brings a candidate held only by a base-branch breakage onto the tip that fixed it —
      // the same merge of the tip into the candidate's own branch GitHub's merge API makes for any
      // base refresh, recorded with trigger `base breakage` and the breakage it answered, so the
      // engine decides the carry exactly as for any refresh. A moved tip or pull request refuses.
      async refreshOntoFixedBase(work: Work, found: BaseBreak, beforeWrite: () => Promise<void> = async () => {}): Promise<BaseRefresh> {
        const pr = world.pr(work), at = new Date(clock.now()).toISOString();
        if (!work.candidate || work.candidate.sha !== found.head) throw new Error('A candidate held by a base-branch breakage is required');
        if (pr.head !== work.candidate.sha || pr.base !== work.candidate.baseSha || !pr.open || pr.merged) throw new Error('Pull request changed before the base refresh; retry');
        if (world.tip !== found.fixedBy) throw new Error(`Base branch ${options.baseBranch} moved before the base refresh; retry`);
        await beforeWrite();
        const from = pr.head, onto = world.commits.get(world.tip)!, bound = work.candidate.baseSha;
        const merged = world.record({ sha: sha('base-refresh', from, world.tip), tree: sha('tree', 'base-refresh', from, world.tip), parents: [from, world.tip],
          files: [...new Set([...world.commits.get(from)!.files, ...onto.files])], at: clock.now(),
          message: `Graphyard base refresh for ${work.key} onto ${options.baseBranch}: its failing tests were broken on ${found.builtOn.slice(0, 12)} and fixed by ${found.fixedBy.slice(0, 12)}` },
          world.mergedContents(from, world.tip, work.plannedFiles ?? []));
        pr.head = merged.sha; pr.base = world.tip; pr.pushed.set(merged.sha, clock.now());
        return { from: { sha: found.head, baseSha: bound }, base: world.tip, baseTree: world.tree, policyRevision: work.policyRevision, at, head: merged.sha, conflict: null, carry: null,
          trigger: 'base breakage', baseBreak: found,
          merge: { from, parents: [from, world.tip], author: 'graphyard[bot]', authoredByApp: true, conflicts: false,
            baseChanges: onto.files.filter(file => !world.commits.get(bound)!.files.includes(file)), diff: { reviewed: sha('patch', from), tip: sha('patch', from) } } } as BaseRefresh;
      },
      // A docs-sync head, as the real adapter describes it: a two-parent merge of the reviewed head and
      // the base tip, whose change outside docs/ keeps its patch-id (the session resolved prose only).
      async docsSyncRefresh(work: Work, adoption: { from: { sha: string; baseSha: string }; base: string; head: string; to: { sha: string; baseSha: string }; paths: string[] | null }): Promise<BaseRefresh> {
        const { from, base, head, to } = adoption, commit = world.commits.get(head)!;
        const baseChanges = world.commits.get(base)!.files.filter(file => !world.commits.get(from.baseSha)!.files.includes(file));
        return { from, base, baseTree: world.commits.get(base)!.tree, policyRevision: work.policyRevision, at: new Date(clock.now()).toISOString(), head, conflict: null, carry: null, trigger: 'docs sync',
          merge: { from: from.sha, parents: commit.parents, author: 'docs-sync-account', authoredByApp: false, conflicts: true, baseChanges },
          docsSync: { paths: adoption.paths, to, reviewed: sha('patch', from.sha), synced: sha('patch', from.sha) } };
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
      async rerunFailedJobs(checkRunId: number, options?: { runRead?: boolean }) { return world.rerunFailedJobs(checkRunId, options); },
      // GY-1250: the main guard's surface, each call one GitHub request the soak counts.
      ...(options.mainGuard ? {
        async mainHistory(limit = 100) { world.guardRequests.push({ kind: 'history', at: clock.now() }); return world.mainHistory(limit); },
        async commitChecks(commit: string) {
          world.guardRequests.push({ kind: 'checks', at: clock.now(), sha: commit });
          return world.commitChecks(commit, clock.now()).map(run => ({ name: run.name, result: run.result, appId: options.ciAppId, id: run.id }));
        },
        async openMainRevert(work: Work, mergeSha: string) { world.guardRequests.push({ kind: 'open', at: clock.now() }); return world.openRevert(work.key, mergeSha); },
        async revertPull(number: number) {
          world.guardRequests.push({ kind: 'pull', at: clock.now() });
          const revert = world.reverts.get(number)!;
          return { merged: !!revert.merged, mergeSha: revert.merged?.sha ?? null, open: revert.open, mergeable: true, head: revert.head };
        },
        async mergeChanges(mergeSha: string) { world.guardRequests.push({ kind: 'merge-diff', at: clock.now(), sha: mergeSha }); return world.fileChanges(world.commits.get(mergeSha)!.parents[0], mergeSha); },
        async revertChanges(number: number) {
          world.guardRequests.push({ kind: 'revert-diff', at: clock.now(), pr: number });
          const head = world.commits.get(world.reverts.get(number)!.head)!;
          return world.fileChanges(head.parents[0], head.sha);
        },
        async approveRevert(number: number, head: string) { world.guardRequests.push({ kind: 'approve', at: clock.now(), pr: number, sha: head }); world.approveRevertPull(number, head); return 'approved' as const; },
        async mergeRevert(_work: Work, revert: { pr: number; head: string }) { world.guardRequests.push({ kind: 'merge', at: clock.now() }); return world.mergeRevertPull(revert.pr, revert.head); },
        async closeRevert(number: number, reason: string) {
          world.guardRequests.push({ kind: 'close', at: clock.now() });
          const revert = world.reverts.get(number)!;
          revert.open = false; revert.closed = reason; revert.closedAt = clock.now();
        },
      } : {}),
    };
    return adapter as unknown as GitHub;
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
