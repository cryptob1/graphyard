import { createHash } from 'node:crypto';
import type { GitHub } from '../../src/github.js';
import type { HerdrAgent } from '../../src/master.js';
import type { Observation, Work } from '../../src/model.js';
import type { AgentReview, ReviewRequest } from '../../src/model/review.js';
import { mergeableNow, queueRef, type BaseRefresh, type GitHubMergeQueueState, type QueuePlacement, type QueueSpeculation } from '../../src/merge-queue.js';
import type { Succession } from '../../src/model/successors.js';

// The outside world of the soak test (GY-404), simulated deterministically: one clock that both the
// test process and the test Postgres read, a GitHub repository with pull requests, CI, a reviewer and
// a merge button, and a Herdr that lists the sessions the loop launches. Nothing in here decides
// anything for Graphyard: the loop and the engine act, and this world only answers them.

export const minute = 60_000, hour = 60 * minute;
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
/** A commit: on the base branch, a worker's head, or a queue tip Graphyard published; `files` is its whole tree's file list. */
export interface Commit { sha: string; tree: string; parents: string[]; files: string[]; at: number; message: string }
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
}

export class SimulatedGitHub {
  commits = new Map<string, Commit>();
  tip: string;
  prs = new Map<number, PullRequest>();
  /** Every merge GitHub performed, in order, with the time it did. */
  merges: { key: string; pr: number; sha: string; at: number; state: string; mode: 'immediate' | 'auto-merge' }[] = [];
  /** Reviewers' plans per item: the verdict each successive review of it gives. */
  verdicts = new Map<string, ('APPROVED' | 'CHANGES_REQUESTED')[]>();
  /** Reviewer profiles that are out of quota: a request dispatched to one is answered with a usage-limit verdict. */
  exhaustedProfiles = new Set<string>();
  /** Items whose GitHub merge state settles as UNSTABLE (a failing optional check), and those GitHub is slow to recompute after their required check passes. */
  unstable = new Set<string>(); slowRecompute = new Set<string>();
  /** Successions (renames and splits) recorded on the base branch. */
  successions: Succession[] = [];
  /**
   * Items whose first speculative tip hits an infrastructure flake (GY-516): its `test` run fails,
   * and the one rerun the control plane asks for passes (`rerun-passes`) or fails again (`rerun-fails`).
   */
  flaky = new Map<string, 'rerun-passes' | 'rerun-fails'>();
  /** The CI runs reported per commit, created once CI finishes on it; a rerun appends a later attempt. */
  runs = new Map<string, { name: string; result: string; id: number; attempt: number; at: number }[]>();
  /** Every rerun the control plane asked for: the item, the tip and the failed check run. */
  reruns: { key: string; sha: string; checkRunId: number; at: number }[] = [];
  /** Each item's first speculative tip, the one its flake hits. */
  private flakeTips = new Map<string, string>();
  private serial = 0;
  constructor(readonly options: WorldOptions, files: string[]) {
    const root: Commit = { sha: sha('root'), tree: sha('tree', 'root'), parents: [], files, at: clock.now(), message: 'root' };
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
  /** A commit off the base branch: a worker's head or a published tip. */
  record(commit: Commit) { this.commits.set(commit.sha, commit); return commit; }
  /** A commit onto the base branch: a merged pull request, or a change landed outside Graphyard (a file split). */
  commit(message: string, files: string[], at = clock.now(), parents = [this.tip], tree?: string) {
    const commit = this.record({ sha: sha('commit', ...parents, message), tree: tree ?? sha('tree', ...parents, message), parents, files, at, message });
    this.tip = commit.sha;
    return commit;
  }
  /** A worker pushes a head to its item's branch, opening the pull request on the first push. */
  push(key: string, branch: string, author: string, head: string, files: string[]) {
    let pr = [...this.prs.values()].find(entry => entry.branch === branch && entry.open);
    if (!pr) {
      pr = { number: this.options.firstPullRequest + this.prs.size, key, branch, author, head, base: this.tip, files, createdAt: clock.now(), open: true, merged: null, pushed: new Map(), reviews: [], graphyardCheck: new Map(),
        autoMerge: false, mergeRequestedAt: null, settledState: this.unstable.has(key) ? 'UNSTABLE' : 'CLEAN', agentRequests: [], agentReview: null };
      this.prs.set(pr.number, pr);
    }
    // A worker syncs before it pushes (graphyard sync): the head contains the base tip.
    this.record({ sha: head, tree: sha('tree', head), parents: [this.tip], files: [...new Set([...this.files, ...files])], at: clock.now(), message: `${key} head` });
    Object.assign(pr, { head, base: this.tip, files, autoMerge: false, mergeRequestedAt: null });
    pr.pushed.set(head, clock.now());
    return pr;
  }
  pr(work: Pick<Work, 'submission' | 'candidate'>) { const number = work.candidate?.pr ?? work.submission?.pr; const pr = number ? this.prs.get(number) : undefined; if (!pr) throw new Error(`No pull request #${number}`); return pr; }

  /** The CI runs that have reported on `pr`'s head by `now`: every attempt, as GitHub keeps them. */
  checks(pr: PullRequest, now: number) {
    const head = pr.head;
    if (now - pr.pushed.get(head)! < this.options.ciMs) return [];
    if (!this.runs.has(head)) {
      const flake = this.flakeTips.get(pr.key) === head && this.flaky.has(pr.key);
      this.runs.set(head, ['test', 'typecheck'].map(name => ({ name, result: flake && name === 'test' ? 'failure' : 'success', id: ++this.serial, attempt: 1, at: now })));
    }
    return this.runs.get(head)!.filter(run => run.at <= now);
  }
  /** GitHub's "rerun failed jobs": the failed run's job runs again on the same commit, reporting `ciMs` later. */
  rerun(checkRunId: number) {
    const [head, runs] = [...this.runs].find(([, entries]) => entries.some(entry => entry.id === checkRunId)) ?? [];
    const failed = runs?.find(entry => entry.id === checkRunId);
    if (!head || !runs || !failed || failed.result !== 'failure') throw new Error(`GitHub POST /actions/jobs/${checkRunId}/rerun refused: not a failed job`);
    const pr = [...this.prs.values()].find(entry => entry.head === head)!;
    const now = clock.now();
    this.reruns.push({ key: pr.key, sha: head, checkRunId, at: now });
    runs.push({ name: failed.name, result: this.flaky.get(pr.key) === 'rerun-fails' ? 'failure' : 'success', id: ++this.serial, attempt: failed.attempt + 1, at: now + this.options.ciMs });
    return { runId: 900_000 + checkRunId };
  }
  /** One minute of GitHub: CI finishes, reviewers post verdicts, reviewer Apps answer, and auto-merge lands what it may. */
  tick(now: number) {
    for (const pr of [...this.prs.values()].filter(entry => entry.open)) {
      const pushedAt = pr.pushed.get(pr.head)!;
      const ciDone = now - pushedAt >= this.options.ciMs;
      // The reviewer judges a head once CI reported on it.
      if (ciDone && now - pushedAt >= this.options.ciMs + this.options.reviewMs && !pr.reviews.some(review => review.sha === pr.head)) {
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
    return now - check.at >= (this.slowRecompute.has(pr.key) ? 6 * minute : 0) ? pr.settledState : 'BLOCKED';
  }
  private merge(pr: PullRequest, now: number, mode: 'immediate' | 'auto-merge') {
    const state = this.mergeState(pr, now);
    // A head that already contains the base tip lands its own tree, as GitHub's merge commit does.
    const head = this.commits.get(pr.head)!, landsTree = this.contains(pr.head, this.tip);
    const commit = this.commit(`Merge pull request #${pr.number} from ${pr.branch}`, [...new Set([...this.files, ...head.files])], now, [this.tip, pr.head], landsTree ? head.tree : undefined);
    pr.merged = { sha: commit.sha, at: now }; pr.open = false; pr.autoMerge = false;
    this.merges.push({ key: pr.key, pr: pr.number, sha: commit.sha, at: now, state, mode });
  }

  /** The adapter `processJob` drives, answering exactly what the real one reads from GitHub. */
  adapter(): GitHub {
    const world = this, options = this.options;
    const adapter = {
      config: { repository: options.repository, base: options.baseBranch, appId: options.appId, installationId: 1, reviewerApps: options.reviewerApps },
      reviewerAppFor: (profile: { reviewerApp?: string; runtime?: string } | null | undefined) => profile ? options.reviewerApps.find(app => app.id === profile.reviewerApp && app.runtime === profile.runtime) : undefined,
      async observe(work: Work): Promise<Observation> {
        const pr = world.pr(work), now = clock.now();
        return {
          clockOffset: { min: 0, max: 0 }, prState: pr.open ? 'open' : 'closed', draft: false, prCreatedAt: new Date(pr.createdAt).toISOString(),
          candidate: { sha: pr.head, baseSha: pr.base, pr: pr.number, branch: pr.branch, author: pr.author, createdAt: new Date(pr.createdAt).toISOString() },
          checks: world.checks(pr, now).map(run => ({ name: run.name, result: run.result, appId: options.ciAppId, id: run.id, attempt: run.attempt })),
          // GitHub's latest verdict per reviewer, and the id of every review, as the real adapter reports them.
          reviews: [...new Map(pr.reviews.map(review => [review.reviewer, { ...review }])).values()], reviewIds: pr.reviews.map(review => review.id),
          // A reviewer App's verdict is read for the request the item is bound to, never for another.
          ...(pr.agentReview && work.reviewRequest?.commentId === pr.agentReview.requestId ? { agentReview: { ...pr.agentReview } } : {}),
          merged: !!pr.merged, mergeSha: pr.merged?.sha ?? null, mergedAt: pr.merged ? new Date(pr.merged.at).toISOString() : null,
          mergeable: pr.open, conflicting: false, baseTip: world.tip, baseTree: world.tree, baseTipContained: world.contains(pr.head, world.tip),
          protected: true, files: pr.files, scopeFiles: [], at: new Date(now).toISOString(),
        };
      },
      async publishSpeculativeTip(work: Work, placement: QueuePlacement): Promise<QueueSpeculation> {
        const pr = world.pr(work), predicted = placement.predictedBase!;
        const base = { ref: queueRef(work.key), base: predicted, baseTree: world.commits.get(predicted)!.tree, predecessors: placement.predecessors, policyRevision: work.policyRevision, publishedAt: new Date(clock.now()).toISOString(), trigger: 'queue-head' as const };
        // A head that already contains its predicted base is its own tip; otherwise the base is merged in, as GitHub's /merges does.
        if (world.contains(pr.head, predicted)) return { ...base, tip: pr.head, tipTree: world.commits.get(pr.head)!.tree, reviewedHead: pr.head };
        const from = pr.head, bound = pr.base, tip = sha('tip', from, predicted), onto = world.commits.get(predicted)!;
        const changed = onto.files.filter(file => !world.commits.get(bound)!.files.includes(file));
        world.record({ sha: tip, tree: sha('tree', tip), parents: [from, predicted], files: [...new Set([...world.commits.get(from)!.files, ...onto.files])], at: clock.now(), message: `Graphyard speculative tip for ${work.key}` });
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
      async restoreBranch(): Promise<BaseRefresh> { throw new Error('No branch in this world carries another item\'s commits'); },
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
      if (args[0] === 'pr' && args[1] === 'view') { const pr = this.prs.get(Number(args[2]))!; return JSON.stringify({ headRefOid: pr.head, baseRefName: this.options.baseBranch, state: pr.open ? 'OPEN' : 'MERGED', isDraft: false }); }
      const path = args.find(arg => arg.startsWith(`repos/${repository}/`)) ?? '';
      if (path.endsWith(`/git/ref/heads/${this.options.baseBranch}`)) return JSON.stringify({ ref: `refs/heads/${this.options.baseBranch}`, object: { type: 'commit', sha: this.tip } });
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
  closed: string[] = [];
  private panes = 0;
  open(name: string, status = 'working') { const pane = `w1:p${++this.panes}`; this.agents.set(pane, { name, pane_id: pane, agent: 'claude', agent_status: status }); return pane; }
  status(pane: string, status: string) { const agent = this.agents.get(pane); if (agent) agent.agent_status = status; }
  /** A session that died: its pane is gone without anybody closing it. */
  kill(pane: string) { this.agents.delete(pane); }
  close(pane: string) { if (!this.agents.delete(pane)) throw new Error(`pane_not_found: ${pane}`); this.closed.push(pane); }
  list(): HerdrAgent[] { return [...this.agents.values()].map(agent => ({ ...agent })); }
  byName(name: string) { return [...this.agents.values()].find(agent => agent.name === name); }
}
