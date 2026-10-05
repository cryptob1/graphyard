import type { Observation, ScopeFile, Work } from './model.js';
import { CHECK_NAME, LANDABLE_CHECK } from './model/work.js';
import type { QueueCarry, TipMerge } from './model/carry.js';
import { reviewProviderOf } from './model/review.js';
import type { BaseBreak } from './master/base-break-refresh.js';
import type { DocsSync } from './model/docs-sync.js';

/** The shas that are an item's own: its head, and the reviewed head a base refresh replaced. */
export function ownHeads(work: Pick<Work, 'candidate' | 'baseRefresh'>): string[] {
  const shas = [work.candidate?.sha, work.baseRefresh?.from.sha];
  return [...new Set(shas.filter((sha): sha is string => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha)))];
}
/** The scratch branch a base refresh test-merges on before it trusts GitHub's conflict reading (GY-375); deleted after each check. */
export function mergeCheckBranch(key: string) { return `graphyard-merge-check/${key.toLowerCase()}`; }

/**
 * One unresolved review thread on a candidate's pull request: who opened it (the author of its
 * first comment, and whether GitHub reports that author as a bot), and the path and line it is
 * anchored to. `line` is null for a thread on a file rather than a line; `outdated` threads sit on
 * code the head has since changed. `id` is the thread's GraphQL node id — what
 * `scripts/resolve-thread.mjs` takes — so whoever may resolve it can do so without a raw GraphQL
 * read to rediscover it.
 */
export interface ReviewThread { id?: string; author: string; bot?: boolean; path: string; line: number | null; outdated: boolean; url?: string }
/**
 * Review conversations as a gate input. `required` is the managed branch's
 * `required_conversation_resolution`, which Graphyard's desired protection no longer sets: the
 * review gate is the configured reviewer's verdict on the exact head, and unresolved threads are
 * that reviewer's inputs, not merge blockers (the reviewer reads them itself at launch).
 * `unresolved` is read only while `required` is set — the one case GitHub itself refuses a merge
 * over them — so the observation spends no GraphQL read otherwise. Absent on observations recorded
 * before threads were observed.
 */
export interface ConversationResolution { required: boolean; unresolved: ReviewThread[] }
declare module './model/work.js' { interface Observation { conversations?: ConversationResolution } }

/** `author on path:line`, the way every refusal and attention line names a thread. */
export const describeThread = (thread: ReviewThread) => `${thread.author} on ${thread.path}${thread.line === null ? '' : `:${thread.line}`}${thread.outdated ? ' (outdated)' : ''}`;
/** A thread opened by an automatic reviewer (a GitHub App or other bot account), not a person. */
export const botThread = (thread: ReviewThread) => thread.bot === true || /\[bot\]$/i.test(thread.author);
/** The unresolved threads observed on the current candidate's head: none unless the observation is of that head and it is unmerged. */
export function openThreads(work: Pick<Work, 'candidate' | 'observation'>): ReviewThread[] {
  const observation = work.observation, candidate = work.candidate;
  if (!candidate || !observation?.conversations || observation.candidate?.sha !== candidate.sha || observation.merged) return [];
  return observation.conversations.unresolved;
}
/**
 * The unresolved threads GitHub itself would refuse the merge over: only where the managed
 * branch's protection still requires conversation resolution — protection drift from what
 * `graphyard master protection --apply` writes. Graphyard's own gate never refuses on a thread.
 */
export function blockingThreads(work: Pick<Work, 'candidate' | 'observation'>): ReviewThread[] {
  return work.observation?.conversations?.required ? openThreads(work) : [];
}
/** How long after an approval of the current head the loop's thread resolution is waited for. */
export const threadResolutionGraceMs = 300_000;
/**
 * Whether unresolved threads still wait on the current head's review rather than on a worker: a
 * reviewed item's review session for this head is still running, no reviewer has yet approved or
 * refused this head (the reviewer answers every listed thread with one or the other; a refusal is a
 * standing verdict), or it approved within the grace the loop takes to resolve the threads it named.
 */
export function threadsAwaitReview(work: Work, observedAt: number): boolean {
  if (!work.policy.review || !work.candidate) return false;
  const sha = work.candidate.sha, observation = work.observation;
  if (work.sessions?.some(session => session.kind === 'review' && session.state === 'running' && session.head === sha)) return true;
  const judged = (observation?.reviews ?? []).filter(review => review.sha === sha && (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED'));
  const agent = observation?.agentReview?.sha === sha && (observation.agentReview.approved || observation.agentReview.verdict === 'changes-requested') ? observation.agentReview : null;
  if (!judged.length && !agent) return true;
  const approvedAt = Math.max(...judged.filter(review => review.state === 'APPROVED').map(review => Date.parse(review.submittedAt ?? '')).filter(Number.isFinite),
    ...(agent?.approved ? [Date.parse(agent.completedAt ?? '')].filter(Number.isFinite) : []));
  return Number.isFinite(approvedAt) && !(observedAt - approvedAt >= threadResolutionGraceMs);
}
/**
 * The merge refusal for protection drift, or null: the branch still requires conversation
 * resolution and threads are open, so GitHub would refuse the merge whatever Graphyard's gate says.
 * The remedy is the desired protection, not rework: the reviewer's verdict is the review gate.
 */
export function conversationProtectionRefusal(work: Pick<Work, 'candidate' | 'observation'>): string | null {
  const threads = blockingThreads(work);
  if (!threads.length) return null;
  return `Branch protection still requires conversation resolution, which Graphyard's review gate does not use: GitHub refuses the merge of ${work.candidate!.sha.slice(0, 12)} while ${threads.length} thread${threads.length === 1 ? '' : 's'} stay${threads.length === 1 ? 's' : ''} open (${threads.map(describeThread).join('; ')}). graphyard master protection --apply removes the requirement; the reviewer's approval of the head is the review gate`;
}
/**
 * `master status` for candidates' review threads: each row lists its open threads under
 * `reviewThreads` for the record. They are the reviewer's inputs, not merge blockers, so a row is
 * demoted from `mergeable` and given attention only for protection drift — a branch that still
 * requires conversation resolution — whose remedy is `graphyard master protection --apply`. The
 * row's attention and its attention item are rewritten together, so both say the same thing.
 */
export function nameUnresolvedThreads<S extends { work: { key: string; mergeable: boolean; attention: string | null; attentionOwner: unknown }[]; attentionItems: { subject: string; text: string }[]; counts: { attention: number; mergeable: number } }, O extends object>(status: S, work: Work[], owner: (role: 'master', next: string, approvedBy: 'approver' | null) => O): Omit<S, 'work'> & { work: (S['work'][number] & { reviewThreads: ReviewThread[] })[] } {
  const rewritten = new Map<string, { previous: string | null; item: S['attentionItems'][number] }>();
  const rows = status.work.map(row => {
    const item = work.find(candidate => candidate.key === row.key);
    const threads = item ? openThreads(item) : [];
    const text = item ? conversationProtectionRefusal(item) : null;
    if (!text) return { ...row, reviewThreads: threads };
    const attentionOwner = owner('master', 'graphyard master protection --apply: the desired protection does not require conversation resolution; the reviewer\'s verdict on the head is the review gate', null);
    rewritten.set(row.key, { previous: row.attention, item: { subject: row.key, text, ...attentionOwner } as S['attentionItems'][number] });
    return { ...row, mergeable: false, reviewThreads: threads, attention: text, attentionOwner };
  });
  const attentionItems = status.attentionItems.map(entry => {
    const rewrite = rewritten.get(entry.subject);
    return rewrite && entry.text === rewrite.previous ? rewrite.item : entry;
  });
  for (const [key, rewrite] of rewritten) if (!attentionItems.some(entry => entry.subject === key && entry.text === rewrite.item.text)) attentionItems.push(rewrite.item);
  const raised = [...rewritten.values()].filter(rewrite => !rewrite.previous).length;
  const demoted = status.work.filter(row => row.mergeable && rewritten.has(row.key)).length;
  return { ...status, work: rows, attentionItems, counts: { ...status.counts, attention: status.counts.attention + raised, mergeable: status.counts.mergeable - demoted } };
}

/** The carry decisions on record that moved bindings onto `sha`, under the current policy: a base refresh's. */
export function onto(work: Pick<Work, 'baseRefresh' | 'policyRevision'>, sha: string): QueueCarry[] {
  const carry = work.baseRefresh?.carry;
  return carry && carry.to.sha === sha && carry.policyRevision === work.policyRevision ? [carry] : [];
}
/**
 * GitHub's own account of why it dismissed a review, read from the pull request timeline and
 * recorded beside the review it withdrew. Two dismissals look alike on the review list and mean
 * opposite things: a reviewer (or a person with the power to) withdrawing a verdict, and GitHub
 * itself withdrawing an approval because the pull request's merge base moved, as the control
 * plane's own base refresh does to the branch it brings onto a new base. `mergeBase` is the
 * second kind, recognised from GitHub's exact message (`The merge-base changed after approval.`),
 * never from a message that merely mentions the merge base: a person dismissing a verdict with
 * "merge base moved, will re-review after rebase" withdrew it, and GitHub did not. The verdict
 * that was dismissed is recorded too (`verdict`, from the timeline's `dismissed_review.state`),
 * because GitHub lists a dismissed change request with the same `DISMISSED` state as a dismissed
 * approval, and only a dismissed *approval* is one the reviewer ever gave.
 */
export interface ReviewDismissal {
  /** GitHub's dismissal message, or null when the timeline could not be read (`unread` says why). */
  reason: string | null;
  /** The message is exactly GitHub's merge-base dismissal: GitHub withdrew the review, nobody did. */
  mergeBase: boolean;
  /** The verdict the dismissed review carried, as the timeline reports it; null when unread or unnamed. */
  verdict: 'approved' | 'changes_requested' | 'commented' | null;
  /** The commit GitHub attributed the dismissal to, when it named one. */
  commit: string | null;
  at: string | null; by: string | null;
  unread?: string;
}
/**
 * The record of an approval the control plane restored after GitHub dismissed it for a merge-base
 * change of an unchanged head (GY-127). `sha` is the head the restored binding binds.
 */
export interface RestoredApproval { reviewer: string; reviewId?: number; sha: string; dismissal: ReviewDismissal; at: string }
/** GitHub's own dismissal message when `dismiss_stale_reviews` fires on a merge-base change, and nothing looser. */
export const mergeBaseDismissalPattern = /^\s*the merge-base changed after approval\.?\s*$/i;
/** The verdict a timeline `review_dismissed` event names, when it is one GitHub reports. */
export function dismissedVerdict(state: unknown): ReviewDismissal['verdict'] {
  return state === 'approved' || state === 'changes_requested' || state === 'commented' ? state : null;
}
/** The dismissal recorded on a review, when the observation carried one. */
export function reviewDismissal(review: Observation['reviews'][number]): ReviewDismissal | null {
  const dismissal = (review as { dismissal?: ReviewDismissal }).dismissal;
  return review.state === 'DISMISSED' && dismissal && typeof dismissal === 'object' ? dismissal : null;
}
/**
 * An approval GitHub dismissed with its merge-base reason that the control plane can restore as
 * the binding one: an approval of exactly the current head, so nothing the reviewer judged has
 * changed (GY-127).
 *
 * A dismissal is distinguished from a withdrawn verdict by the recorded reason and the recorded
 * verdict, never inferred from timing: the reason must be GitHub's exact merge-base message, and
 * the dismissed review must have been an approval — a dismissed change request is a change request
 * the reviewer gave and never an approval, whatever message its dismissal carried. Only a formal
 * GitHub approval from someone other than the author qualifies — the same identity rule
 * `exactApproval` applies, baseline included. The engine restores such an approval as the binding
 * one (see `Engine.observe`) so no review round and no attempt is spent on a commit the reviewer
 * already approved.
 */
export function dismissedApproval(work: Work): { reviewer: string; reviewId?: number; sha: string; dismissal: ReviewDismissal } | null {
  const candidate = work.candidate, observation = work.observation;
  if (!candidate || !observation || observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha || observation.merged) return null;
  if (!work.policy.review || reviewProviderOf(work.policy) !== 'github') return null;
  const baseline = work.formalReviewBaseline;
  for (const review of observation.reviews) {
    if (review.state !== 'DISMISSED' || review.reviewer === candidate.author || review.sha !== candidate.sha) continue;
    const dismissal = reviewDismissal(review);
    if (!dismissal?.mergeBase || dismissal.verdict !== 'approved') continue;
    if (work.formalReviewResetRequired && !(baseline?.pr === candidate.pr && baseline.policyRevision === work.policyRevision && Number.isSafeInteger(review.id) && review.id! > 0 && !baseline.reviewIds.includes(review.id!))) continue;
    return { reviewer: review.reviewer, ...(review.id !== undefined ? { reviewId: review.id } : {}), sha: candidate.sha, dismissal };
  }
  return null;
}
/** The restored approval that binds the current candidate, for status; null when none does. */
export function restoredApproval(work: Pick<Work, 'candidate' | 'baseRefresh' | 'policyRevision'>): RestoredApproval | null {
  const candidate = work.candidate, refresh = work.baseRefresh;
  if (!candidate) return null;
  return refresh?.head === candidate.sha && refresh.policyRevision === work.policyRevision && refresh.restoredApproval?.sha === candidate.sha ? refresh.restoredApproval : null;
}

/**
 * Bringing an in-flight candidate onto a base branch that moved under it.
 *
 * A merge used to invalidate every other open candidate at once: the base tip they were bound to
 * was no longer the branch head, so their approvals and proofs stopped applying and no review
 * could be requested for a head that did not contain the tip. The only way out was a rework round
 * per item for what is almost always a clean fast-forward. Graphyard does both halves itself now.
 * While a candidate's head is unchanged it keeps the base it was bound to (see `heldBase`): the
 * tree it was reviewed and proved on did not change because somebody else merged. Then the control
 * plane merges the new base into the candidate's own pull-request branch and decides binding carry
 * from GitHub's account of the commit it produced (model/carry.ts). A conflict is the one case
 * that still belongs to the worker.
 */
export interface BaseRefresh {
  /** The head the refresh acted on and the base it was bound to when it did. */
  from: { sha: string; baseSha: string };
  /** The base-branch tip the candidate was brought onto, and that commit's tree. */
  base: string; baseTree: string;
  policyRevision: number; at: string;
  /** The republished head, or null when the merge conflicted and nothing was pushed. */
  head: string | null;
  /** Why the base could not be merged into the candidate, named for the worker; null on success. */
  conflict: string | null;
  /**
   * With a confirmed conflict (GY-566): the paths both the head and the base changed since their
   * merge base, which hold every conflicted path; null when GitHub could not list either side.
   * The loop routes a conflict confined to docs pages to a docs-sync session (model/docs-sync.ts).
   */
  conflictPaths?: string[] | null;
  /** Set when the head is a docs-sync of `from` onto `base` (GY-566): what the carry was decided from. */
  docsSync?: DocsSync | null;
  /** How Graphyard produced the head, as GitHub reports the commit; null when nothing was merged. */
  merge?: TipMerge | null;
  /** Which bindings of the replaced head carried onto it, decided once when the refresh was bound. */
  carry?: QueueCarry | null;
  /** An approval GitHub dismissed for a merge-base change on this very head, restored as the binding approval. */
  restoredApproval?: RestoredApproval | null;
  /**
   * What made the control plane touch the branch (GY-375): a conflict its own test merge confirmed,
   * a coordinator's request, a docs sync or a base repair. Absent on records that predate the rule.
   */
  trigger?: RefreshTrigger;
  /**
   * GitHub reported the head conflicting with `base`, and the control plane's own test merge of
   * the two was clean (GY-375): nothing was written, and the reading is recorded here instead of a
   * refresh. `head` is then the unchanged candidate, and whatever the record carried onto it stays.
   */
  stale?: StaleMergeability | null;
  /** The coordinator's request this refresh answered (GY-528), when it was one; see `BaseRefreshRequest`. */
  requested?: { by: string; at: string; reason: string } | null;
  /** The base-branch breakage a `base breakage` refresh answered (GY-793): the failing tests, the base that broke them and the tip that fixed them. */
  baseBreak?: BaseBreak | null;
  /**
   * With a conflict (GY-1200): when a conflict was first recorded for this same head and policy
   * revision. A refresh onto each new base tip rewrites `at`, so on a base that moves often `at`
   * alone would keep restarting the bound an unhandled conflict is counted against (faults.ts
   * baseConflictInMotion). Absent on records that predate the rule, which read as `at`.
   */
  conflictSince?: string | null;
}
/**
 * GY-1200. When the conflict a refresh records was first found on this head: the earlier record's
 * own first conflict when it conflicted on the same head and policy revision, else the refresh's own time.
 */
export function conflictSince(previous: Pick<BaseRefresh, 'from' | 'policyRevision' | 'at' | 'conflict' | 'conflictSince'> | null | undefined, refresh: Pick<BaseRefresh, 'from' | 'policyRevision' | 'at' | 'conflict'>): string | null {
  if (!refresh.conflict) return null;
  const same = !!previous?.conflict && previous.from.sha === refresh.from.sha && previous.policyRevision === refresh.policyRevision;
  return same ? previous!.conflictSince ?? previous!.at : refresh.at;
}
/**
 * The coordinator's request that a base tip be merged into this head although GitHub reports no
 * conflict (GY-528): the head carries a base failure the base has since repaired, and a CI rerun
 * reuses the merge commit the failure was built on. Kept beside `baseRefresh`, not in it, so an
 * approval an earlier refresh carried onto the head still binds until this one runs.
 */
export interface BaseRefreshRequest { head: string; base: string; policyRevision: number; by: string; at: string; reason: string }
/**
 * Why a branch was written by the control plane rather than by its worker (GY-375, GY-528), or, for
 * `base breakage` (GY-793), why a candidate whose required check failed only on tests the base
 * branch broke and has since fixed was brought onto the fixed tip.
 */
export type RefreshTrigger = 'conflict confirmed' | 'docs sync' | 'base failure repaired' | 'base breakage';
/**
 * A GitHub `mergeable: false` the control plane's own test merge showed to be clean (GY-375).
 * GitHub recomputes mergeability lazily after the base moves and can report a clean head
 * conflicting for a while; acting on that reading refreshed clean candidates and dropped their
 * review and proofs. The reading is recorded for exactly this head, base tip and policy revision,
 * and every observation of the same pair is stored with the conflict disproved (`disprovedConflict`),
 * so nothing refreshes, holds or reworks the candidate for it.
 */
export interface StaleMergeability { head: string; base: string; policyRevision: number; at: string; reading: string }
/** The stale reading recorded for exactly the current head and observed base tip, or null. */
export function staleMergeability(work: Pick<Work, 'candidate' | 'observation' | 'baseRefresh' | 'policyRevision'>): StaleMergeability | null {
  const observation = work.observation;
  return observation && work.candidate?.sha === observation.candidate.sha ? disprovedConflict(work, observation) : null;
}
/** The stale reading that disproves this observation's conflict: recorded for its head, base tip and the current policy. */
export function disprovedConflict(work: Pick<Work, 'baseRefresh' | 'policyRevision'>, observation: Pick<Observation, 'candidate' | 'baseTip'>): StaleMergeability | null {
  const stale = work.baseRefresh?.stale;
  return stale && stale.head === observation.candidate.sha && stale.base === observation.baseTip && stale.policyRevision === work.policyRevision ? stale : null;
}
/**
 * The observation with its conflict disproved by `stale` (GY-375): it reads mergeable and not
 * conflicting, and GitHub's raw reading is kept beside that under `disproved` (GY-390).
 */
export function withDisprovedConflict<T extends Pick<Observation, 'mergeable' | 'conflicting' | 'disproved'>>(observation: T, stale: StaleMergeability): T {
  return { ...observation, mergeable: true, conflicting: false, disproved: { mergeable: observation.mergeable, conflicting: !!observation.conflicting, reading: stale.reading } };
}

/**
 * The base a candidate stays bound to while Graphyard has not yet brought it onto a moved branch
 * head. Held only for the exact head the candidate was observed at, only while no refresh of that
 * head onto that tip has reported a conflict, and never for an attempt that is being reworked: a
 * conflict gives the binding up, which is what makes AC-2's invalidation the same as it ever was.
 * The caller verifies that the held commit is still an ancestor of the branch head; a rewind of
 * the managed branch is not an advance and carries nothing.
 */
export function heldBase(work: Pick<Work, 'candidate' | 'baseRefresh' | 'policyRevision' | 'reworkRequested'>, head: string, baseTip: string): string | null {
  const candidate = work.candidate;
  if (!candidate || candidate.sha !== head || candidate.baseSha === baseTip || work.reworkRequested) return null;
  const refresh = work.baseRefresh;
  const conflicted = !!refresh?.conflict && refresh.from.sha === head && refresh.base === baseTip && refresh.policyRevision === work.policyRevision;
  return conflicted ? null : candidate.baseSha;
}

/**
 * The refresh this candidate is waiting for, or null when it needs none (GY-292).
 *
 * Main moves on every merge, and a refresh republishes the head: CI runs again, and whatever the
 * base touched of the review or the proofs is required afresh. Refreshing every open candidate on
 * every merge therefore sent items that had already passed review back to Test several times an
 * hour, never converging. So the combined result is built only where it is needed: for a
 * candidate GitHub reports conflicting with the new base, whose refresh records the conflict and returns it to its
 * worker. GitHub's reading alone is not trusted for that (GY-375): the refresh first test-merges
 * the head onto the new tip on a scratch branch, and a merge that is clean records the reading as
 * stale (`staleMergeability`), writes nothing to the candidate's branch, and later observations of
 * the same head and tip are stored with the conflict disproved. A candidate that merges cleanly keeps its head, its CI, its review and its proofs, bound
 * to the base it was built on (`heldBase`), and its stage; one whose mergeability GitHub has not
 * computed yet waits for the next observation. One attempt per head, base tip and policy revision:
 * a refresh already recorded for the same three is never repeated, so neither a conflict nor a
 * published head makes the reconciliation job spin.
 */
export function baseRefreshNeeded(work: Work): { head: string; boundBase: string; baseTip: string } | null {
  const candidate = work.candidate, observation = work.observation;
  if (!work.submission || work.reworkRequested || work.stage === 'done' || work.blocker) return null;
  if (!candidate || !observation || observation.merged || observation.prState === 'closed' || observation.draft) return null;
  if (observation.candidate.sha !== candidate.sha) return null;
  const baseTip = observation.baseTip;
  if (observation.baseTipContained !== false || !baseTip || baseTip === candidate.baseSha) return null;
  if (observation.conflicting !== true) return null;
  const refresh = work.baseRefresh;
  if (refresh && refresh.from.sha === candidate.sha && refresh.base === baseTip && refresh.policyRevision === work.policyRevision) return null;
  return { head: candidate.sha, boundBase: candidate.baseSha, baseTip };
}

/**
 * The base refresh the coordinator requested for exactly the current head, not yet run (GY-528),
 * or null. It runs whether or not GitHub reports a conflict: the head carries
 * a base failure the base has since repaired, and only the repaired base merged in clears it.
 */
export function requestedBaseRefresh(work: Work): BaseRefreshRequest | null {
  const request = work.baseRefreshRequest, refresh = work.baseRefresh, candidate = work.candidate, observation = work.observation;
  if (!request || !candidate || !observation) return null;
  if (!work.submission || work.reworkRequested || work.stage === 'done' || observation.merged || observation.prState === 'closed' || observation.draft) return null;
  if (observation.candidate.sha !== candidate.sha || request.head !== candidate.sha || request.policyRevision !== work.policyRevision) return null;
  // Answered already: a refresh of this head since the request is recorded, merged or conflicting.
  if (refresh && refresh.from.sha === candidate.sha && refresh.policyRevision === work.policyRevision && Date.parse(refresh.at) >= Date.parse(request.at)) return null;
  // The base tip observed now is the one merged in: a base that moved on again since the request
  // still holds the repair, and merging an older tip would leave the head behind it anyway.
  return observation.baseTip && observation.baseTipContained === false ? request : null;
}

/** The unresolved conflict a base refresh reported for exactly this candidate and branch head, or null. */
export function baseRefreshConflict(work: Pick<Work, 'candidate' | 'observation' | 'baseRefresh' | 'policyRevision'>): string | null {
  const refresh = work.baseRefresh, candidate = work.candidate, observation = work.observation;
  if (!refresh?.conflict || !candidate || !observation) return null;
  return refresh.from.sha === candidate.sha && refresh.base === observation.baseTip && refresh.policyRevision === work.policyRevision ? refresh.conflict : null;
}

/**
 * The base tip the control plane is bringing this candidate onto, when that is the only thing it
 * waits for. `master status` reads it to keep such an item out of the attention list: nobody is
 * waiting on a person, a review round, or a proof round for it.
 */
export function pendingBaseRefresh(work: Work): { baseTip: string; boundBase: string } | null {
  if (baseRefreshConflict(work)) return null;
  const needed = baseRefreshNeeded(work);
  return needed ? { baseTip: needed.baseTip, boundBase: needed.boundBase } : null;
}

/** The carry decision a base refresh made for exactly the current candidate, for status and diagnose. */
export function currentBaseRefreshCarry(work: Pick<Work, 'candidate' | 'baseRefresh' | 'policyRevision'>): QueueCarry | null {
  const refresh = work.baseRefresh, candidate = work.candidate, carry = refresh?.carry;
  if (!refresh || !carry || !candidate || refresh.head !== candidate.sha) return null;
  return carry.to.sha === candidate.sha && carry.to.baseSha === candidate.baseSha && carry.policyRevision === work.policyRevision ? carry : null;
}

/**
 * What landing a candidate would do to the base branch, judged where it lands (GY-97).
 *
 * The regression guard compares a candidate with the base it is bound to, and a binding is held
 * on purpose while a head is unchanged: the base moving under it is neither a new head nor a new
 * submission. So a head that was clean when it was submitted could later delete what somebody else
 * shipped in the meantime, and nothing looked again before the merge applied it. Every observation
 * of an open candidate therefore records this check as well, against the commit the merge would
 * actually land on, the live base-branch tip:
 *
 * - `files`: the head's changes since its merge base with the landing commit, each outside the
 *   planned scope judged by the three-way merge result of the head onto that commit (GY-863):
 *   a branch carrying an earlier version of a change the commit has since extended merges to
 *   exactly what the commit holds, so it is not a revert; a head that restores the merge-base
 *   version over the commit's still is. Files only the base changed are inherited by a
 *   three-way merge, not reverted. Recomputed on every observation, including unchanged heads
 *   previously refused. Present when the landing tree differs from the bound base.
 * - `carried`: other items' unlanded candidates whose commits this head has in its history, while
 *   its tree holds their files as the landing commit does. Merging such a head makes the provider
 *   record the other pull request merged with none of its content on the base branch, and no diff
 *   against any base shows it: that is how GY-93's merge took GY-84's delivery with it.
 */
export interface CarriedCandidate {
  key: string; pr: number; head: string;
  /** The owning item's files this head does not hold, each with how it holds them instead. */
  dropped: { path: string; detail: string }[];
  /** The lookup budget ran out before every file was compared; never a pass, never an ejection. */
  unverified?: boolean;
}
/** Another item whose unlanded commits this head's history carries; see `LandingCheck.foreign`. */
export interface ForeignCandidate { key: string; pr: number; head: string }
export interface LandingCheck {
  base: string;
  files?: ScopeFile[];
  carried?: CarriedCandidate[];
  /**
   * Every open candidate whose head is in this head's history (GY-127).
   * `carried` above lists the ones whose content this head also drops; this lists them all, since
   * a branch that holds a neighbour's unlanded commits at all can neither be kept nor landed.
   */
  foreign?: ForeignCandidate[];
  /** The open candidates `carried` and `foreign` were decided against, as `KEY@heads`, so an unchanged answer is not asked for again. */
  examined?: string[];
}
/**
 * A merged pull request whose content the base branch does not hold: each file stands on the base
 * tip as it stood before the merge (or is absent), and `removedBy` is the merge that did it.
 */
export interface RevertedDelivery {
  base: string;
  files: { path: string; detail: string }[];
  removedBy: { key: string | null; pr: number; mergeSha: string | null; commit: string | null } | null;
  /** The lookup budget ran out: more files may be missing than are listed. */
  partial?: boolean;
}

// Pending, queued, or missing is not failure. Only a reported adverse conclusion fails a check.
export const failedConclusions = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale', 'neutral']);

// Observations retain every immutable check run for delivery analytics. Gates and the
// merge-queue ejection rule use only the newest trusted run for a required name; GitHub
// check-run IDs are immutable and increase as the provider creates retries. Array
// position is a fallback for legacy observations that predate run identity capture.
// GY-1109: a cancelled run never supersedes a run that was not cancelled. GitHub cancels a run a
// concurrency group replaced ("Canceling since a higher priority waiting request exists") or one a
// person stopped: it reports nothing about the commit, so the newest run that was not cancelled
// decides, and a check with only cancelled runs is read as its newest cancelled run.
export function latestCheck(checks: Observation['checks']): Observation['checks'][number] | undefined {
  const decisive = checks.filter(check => check.result !== 'cancelled');
  return newestCheck(decisive.length ? decisive : checks);
}
/** Whether `run` is an adverse conclusion about its commit: a failed conclusion GitHub did not reach by cancelling the run (GY-1109). */
export const failedRun = (run: { result: string } | undefined) => !!run && run.result !== 'cancelled' && failedConclusions.has(run.result);
function newestCheck(checks: Observation['checks']): Observation['checks'][number] | undefined {
  return checks.reduce<Observation['checks'][number] | undefined>((latest, check) => {
    if (!latest) return check;
    if (check.id !== undefined && latest.id !== undefined) return check.id > latest.id ? check : latest;
    if (check.id !== undefined) return check;
    if (latest.id !== undefined) return latest;
    return check;
  }, undefined);
}

/** The conclusions of a run that failed, as the failed-CI rework rule reads them. */
export const failedCheckResults: readonly string[] = ['failure', 'timed_out', 'action_required', 'cancelled', 'startup_failure'];
/** One check a candidate must pass: a policy check, or one only the base branch's protection or rulesets require. */
export interface RequiredCheck { name: string; policy: boolean; appId: number | null }
/**
 * GY-430. The checks a candidate must pass: the policy's, then every check the base branch's
 * protection or active rulesets require that the policy does not name (the observation records
 * them, never `Graphyard / merge` or `graphyard/landable`: Graphyard publishes both, and a verdict
 * waiting on its own check would refuse forever, GY-887). GitHub refuses the merge while any of them has not passed, so a
 * failing protection-only check — PR #221's `secrets` scan — is judged exactly as a policy check is.
 */
export function requiredChecksOf(work: Pick<Work, 'policy' | 'observation'>): RequiredCheck[] {
  const names = work.policy?.checks ?? [];
  const policy = names.map(name => ({ name, policy: true, appId: null }));
  const extra = (work.observation?.requiredChecks ?? []).filter(check => check.name !== CHECK_NAME && check.name !== LANDABLE_CHECK && !names.includes(check.name))
    .map(check => ({ name: check.name, policy: false, appId: check.appId }));
  return [...policy, ...extra];
}
/**
 * The newest run that counts for a required check: a policy check's from the configured CI apps,
 * as ever; a protection-only check's from the app protection binds it to. One bound to no app is
 * satisfied on GitHub by any source's run or commit status of that name; Graphyard prefers the
 * configured CI apps' runs whenever one reports it (GY-1060), so another app with checks:write can
 * neither pass it nor fail it beside CI, then the commit status, so a stray run of another app
 * cannot hide the status that answers a classic context, and reads another app's run only last.
 */
export function requiredCheckRun(check: RequiredCheck, checks: Observation['checks'], ciAppIds: readonly number[] | null): Observation['checks'][number] | undefined {
  const named = checks.filter(run => run.name === check.name);
  if (check.policy) return latestCheck(named.filter(run => !ciAppIds || ciAppIds.includes(run.appId)));
  if (check.appId !== null) return latestCheck(named.filter(run => run.appId === check.appId));
  const trusted = ciAppIds ? named.filter(run => ciAppIds.includes(run.appId)) : [];
  const statuses = named.filter(run => run.source === 'status');
  return latestCheck(trusted.length ? trusted : statuses.length ? statuses : named);
}
/** Whether a counting run failed: a policy check by the queue's conclusions, as ever; a protection-only one by the failed-CI rework rule's (GY-430). */
export function requiredRunFailed(check: RequiredCheck, run: Observation['checks'][number] | undefined): boolean {
  return !!run && run.result !== 'cancelled' && (check.policy ? failedConclusions.has(run.result) : failedCheckResults.includes(run.result));
}
/** The test gate's trusted CI apps as last recorded on the item; legacy snapshots use the engine's historical GitHub Actions default. */
export const ciAppIdsOf = (work: Pick<Work, 'gates'>): readonly number[] => work.gates?.find(gate => gate.name === 'test')?.ciAppIds ?? [15368];
/** Whether a run satisfies its required check: success, or for a protection-only check any conclusion GitHub accepts (neutral, skipped). */
export function requiredCheckPassed(check: RequiredCheck, run: Observation['checks'][number] | undefined): boolean {
  return !!run && (run.result === 'success' || !check.policy && ['neutral', 'skipped'].includes(run.result));
}

declare module './model/work.js' {
  interface Gate {
    /** The server's trusted CI Apps, recorded on the test gate for downstream decisions. */
    ciAppIds?: number[];
  }
}

/**
 * Select exactly the run the test gate uses, including its configured App trust boundary.
 * Legacy snapshots without that metadata use the engine's historical GitHub Actions default;
 * the next gate evaluation records the installation's actual configuration, including [].
 */
export function requiredCheck(work: Pick<Work, 'candidate' | 'observation' | 'gates'>, name: string, ciAppIds: readonly number[] = ciAppIdsOf(work)) {
  const observation = work.observation, candidate = work.candidate;
  if (!candidate || !observation || observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha) return undefined;
  return latestCheck(observation.checks.filter(run => run.name === name && ciAppIds.includes(run.appId)));
}

/**
 * The violation an observed, unauthorized merge records when a two-party reconciliation of it was
 * refused; the engine writes it as `<prefix><decision id> refused: <reasons>`, and master status
 * reads it (GY-94).
 */
export const reconciliationRefusalPrefix = 'Reconciliation by decision ';
/**
 * The violation an observed merge records when the record before the merge cutoff did not show
 * every gate passing for the merged head (GY-1235). The wording predates GitHub delivery and is
 * kept so violations already on the ledger still match.
 */
export const unauthorizedMergeViolation = 'Merge observed without a prior authorization for this candidate';
/** True for an item held at the merge stage by an observed merge its gates did not pass (GY-92). */
export const mergedWithoutAuthorization = (work: Work) => work.stage !== 'done' && !!work.observation?.merged && work.violations.includes(unauthorizedMergeViolation);
export function refusedReconciliation(work: Pick<Work, 'violations'>): { decision: string; violation: string } | null {
  const violation = work.violations.find(entry => entry.startsWith(reconciliationRefusalPrefix));
  return violation ? { decision: violation.slice(reconciliationRefusalPrefix.length).split(' ')[0], violation } : null;
}
/**
 * GY-831. The guarded merge's refusal the loop reported for one candidate: a carried approval it
 * could not re-post, or one reason repeated past the loop's bound. `rereview` cleared the carried
 * approval so the review gate asks for a fresh review of the tip; `rework` asks the approver for
 * the rework decision, since nothing the control plane holds re-binds it. `approval` names the
 * review that could not be re-posted; `carry` keeps the decision that applied to the candidate,
 * approval re-required, so its carried proofs still bind.
 */
export interface MergeRefusal {
  sha: string; baseSha: string; policyRevision: number; reason: string; since: string; at: string; by: string; action: 'rereview' | 'rework';
  approval?: { reviewer: string; reviewId?: number; originalSha: string }; carry?: QueueCarry | null;
}
// ---- GitHub executes merges (GY-258) -------------------------------------------------------------
// Graphyard gates a merge; GitHub performs it. When every gate passes for a candidate and the
// coordinator asked for the merge, the control plane's App publishes `Graphyard / merge` success on
// that exact head and puts the pull request in GitHub's merge queue (or enables auto-merge where the
// base branch has no queue). When authorization is withdrawn it publishes failure and takes the pull
// request out again, so GitHub never merges a head Graphyard has not authorized. The delivery is
// recorded from the merged observation, exactly as before; no Graphyard code calls the merge endpoint.

/** How GitHub holds a pull request for merging: in the merge queue, under auto-merge, or not at all. */
export type GitHubMergeMode = 'queued' | 'auto-merge' | 'none';
/** The pull request's merge-queue state as GitHub reported it on one read. */
export interface GitHubMergeQueueState {
  /** The pull request's GraphQL node id, what the enqueue and dequeue mutations take. */
  pullRequestId: string;
  /** The head GitHub holds for the pull request right now. */
  head: string;
  /** Whether the base branch has a merge queue; without one Graphyard enables auto-merge, or merges a pull request GitHub reports mergeable now, head-bound. */
  queue: boolean;
  /** GitHub's MergeStateStatus for the pull request (CLEAN, BLOCKED, …); CLEAN, UNSTABLE or HAS_HOOKS without a queue is merged at once, head-bound. */
  mergeStateStatus?: string | null;
  mode: GitHubMergeMode;
  /** GitHub's MergeQueueEntryState (QUEUED, AWAITING_CHECKS, MERGEABLE, UNMERGEABLE, LOCKED), or null. */
  entryState: string | null;
  position: number | null;
  /** The merge group commit GitHub builds for the entry; the required check must pass on it too. */
  groupHead: string | null;
  at: string;
  /** GitHub's latest refusal of the control plane's enqueue or dequeue for this head, recorded as `merge.enqueue.refused`; cleared once a request succeeds. */
  refused?: { reason: string; head: string; mode: GitHubMergeMode; at: string } | null;
  /** When the coordinator's current merge request for this candidate was recorded, or null; how long a merge has been pending (GY-344). */
  requestedAt?: string | null;
}
declare module './model/work.js' { interface Observation { githubQueue?: GitHubMergeQueueState | null } }

/** A coordinator's request that GitHub merge exactly this candidate, as `merge-acquire` recorded it before GY-1235. */
export interface MergeEnqueueRequest { sha: string; baseSha: string; policyRevision: number; requestedBy: string; at: string }

/**
 * Whether GitHub may merge the item right now: every gate passes for its current candidate and
 * nothing stands against it. Every passing gate is the authorization — GitHub's branch protection
 * decides the merge, and no separate authorization, execution or observation age is consulted.
 */
export function mergeAuthorized(work: Work): boolean {
  return work.stage === 'merge' && !!work.candidate && !work.observation?.merged
    && work.gates.every(gate => gate.passed) && !work.violations.length && !work.leadHold;
}
/** Whether the coordinator's enqueue request binds the current candidate and policy. */
export function enqueueRequestCurrent(work: Work, request: Pick<MergeEnqueueRequest, 'sha' | 'baseSha' | 'policyRevision'> | null | undefined): boolean {
  return !!request && !!work.candidate && request.sha === work.candidate.sha && request.baseSha === work.candidate.baseSha && request.policyRevision === work.policyRevision;
}
export type MergeQueueAction =
  | { kind: 'enqueue'; reason: string; mergeNow?: boolean }
  | { kind: 'dequeue'; reason: string }
  | { kind: 'hold'; reason: string };
/**
 * What the control plane does with GitHub's queue for one item, decided from the record and one
 * read of GitHub. Enqueue only an authorized, requested candidate whose head GitHub still holds;
 * dequeue anything GitHub holds for merging that is not exactly that. Everything else holds.
 */
/**
 * The merge states in which GitHub merges the pull request at once and so refuses to enable
 * auto-merge on it ("Pull request is in clean status"). UNSTABLE is one (GY-344): only checks
 * branch protection does not require are failing or cancelled, and GitHub still enforces every
 * required check on the head-bound merge. BEHIND, BLOCKED, DIRTY and UNKNOWN are not.
 */
export const mergeableStates = ['CLEAN', 'UNSTABLE', 'HAS_HOOKS'] as const;
/** Whether GitHub merges the pull request at once (CLEAN, UNSTABLE, HAS_HOOKS). */
export const mergeableNow = (state: Pick<GitHubMergeQueueState, 'mergeStateStatus'>) => (mergeableStates as readonly (string | null | undefined)[]).includes(state.mergeStateStatus);
/** GitHub's refusal of auto-merge on a pull request already in one of those states ("Pull request is in unstable status"). */
export const alreadyMergeableRefusal = /\b(clean|unstable|has_hooks) status\b/i;
/** How long a merge may stay pending on a head GitHub reports mergeable before master status names it (GY-344). */
export const mergeStallMs = 5 * 60_000;
/**
 * Merge requests pending past `mergeStallMs` on a head GitHub reports mergeable, with no refusal
 * recorded: GitHub was asked to merge something it says it can merge and nothing happened, which is
 * a new unmerged state the control plane does not handle yet. Only a base branch without a merge
 * queue is judged: a queued entry waits on its merge group, which GitHub reports on its own.
 */
export function mergeStalls(work: Work[], now: number): { key: string; pr: number; head: string; mergeStateStatus: string; requestedAt: string; ageMs: number; text: string; next: string }[] {
  return work.flatMap(item => {
    const state = item.observation?.githubQueue, candidate = item.candidate;
    if (!state || !candidate || item.stage === 'done' || item.observation?.merged || state.queue || !state.requestedAt
      || state.head !== candidate.sha) return [];
    const unanswered = blockedPastProbe(item, state, now);
    if (unanswered) return [unanswered];
    if (state.refused) return [];
    const blocked = blockedMergeStall(item, state, now);
    if (blocked) return [blocked];
    if (!mergeableNow(state)) return [];
    const ageMs = now - Date.parse(state.requestedAt);
    if (ageMs <= mergeStallMs) return [];
    const status = state.mergeStateStatus!;
    return [{ key: item.key, pr: candidate.pr, head: state.head, mergeStateStatus: status, requestedAt: state.requestedAt, ageMs,
      text: `merge-stalled: ${item.key} pull request #${candidate.pr} at ${state.head.slice(0, 12)} has been requested for merge for ${Math.floor(ageMs / 60_000)} minutes (since ${state.requestedAt}) while GitHub reports mergeStateStatus ${status}, and no refusal is recorded: GitHub was asked to merge a pull request it reports mergeable and has not`,
      next: `graphyard master create files the control-plane defect for merge state ${status} on ${item.key}; gh pr view ${candidate.pr} shows what GitHub is waiting on` }];
  });
}
/** How long an authorized head may stay BLOCKED with every gate passing before master status raises it (GY-1112). */
export const blockedAuthorizedStallMs = 30 * 60_000;
/**
 * GY-1112. A head GitHub reports BLOCKED with every gate passing, its merge requested more than
 * `blockedAuthorizedStallMs` ago: the blocked-auto-merge probe has asked GitHub to merge it, and
 * either GitHub refused (its message is the last answer) or it accepted and still has not merged.
 * On 2026-10-02 GY-794 headed a 17-entry queue so for over 40 minutes with nothing raised.
 */
export function blockedPastProbe(item: Work, state: GitHubMergeQueueState, now: number) {
  const candidate = item.candidate!;
  if (!state.requestedAt || state.queue || state.head !== candidate.sha || item.observation?.merged || state.mergeStateStatus !== 'BLOCKED' || !mergeAuthorized(item)) return null;
  const ageMs = now - Date.parse(state.requestedAt!);
  if (!(ageMs > blockedAuthorizedStallMs)) return null;
  const answer = state.refused && state.refused.head === state.head ? `GitHub's last answer (${state.refused.at}): ${state.refused.reason}`
    : 'GitHub\'s last answer: no refusal recorded; it accepted the request and has not merged';
  return { key: item.key, pr: candidate.pr, head: state.head, mergeStateStatus: 'BLOCKED', requestedAt: state.requestedAt!, ageMs,
    text: `merge-blocked: ${item.key} pull request #${candidate.pr} at ${state.head.slice(0, 12)} has been BLOCKED with every gate passing for ${Math.floor(ageMs / 60_000)} minutes (merge requested ${state.requestedAt}); ${answer}`,
    next: `gh pr view ${candidate.pr} shows the rule GitHub enforces; graphyard master create files the defect if no rule explains it` };
}
/** How long a merge may stay pending under auto-merge on a head GitHub reports BLOCKED before master status names why (GY-430). */
export const blockedMergeStallMs = 10 * 60_000;
/**
 * GY-430. A merge pending under auto-merge for more than `blockedMergeStallMs` on a head GitHub
 * reports BLOCKED, named with what blocks it: a required check that failed or has not passed, or a
 * missing approving review. On 2026-09-25 PR #221 sat so for over ten minutes behind a failed
 * `secrets` scan while master status said only "merge waiting".
 */
function blockedMergeStall(item: Work, state: GitHubMergeQueueState, now: number) {
  const candidate = item.candidate!, observation = item.observation!;
  if (state.mode !== 'auto-merge' || state.mergeStateStatus !== 'BLOCKED') return null;
  const ageMs = now - Date.parse(state.requestedAt!);
  if (!(ageMs > blockedMergeStallMs)) return null;
  const runs = observation.candidate.sha === candidate.sha ? observation.checks : [];
  const judged = requiredChecksOf(item).map(check => ({ check, run: requiredCheckRun(check, runs, ciAppIdsOf(item)) }));
  const failed = judged.filter(entry => !!entry.run && failedCheckResults.includes(entry.run.result)).map(entry => entry.check.name);
  const missing = judged.filter(entry => !requiredCheckPassed(entry.check, entry.run) && !failed.includes(entry.check.name)).map(entry => entry.check.name);
  const approved = observation.reviews.some(review => review.sha === candidate.sha && review.state === 'APPROVED') || observation.agentReview?.sha === candidate.sha && observation.agentReview.approved;
  const plural = (names: string[]) => names.length === 1 ? '' : 's';
  const reasons = [
    ...(failed.length ? [`required check${plural(failed)} ${failed.join(', ')} failed`] : []),
    ...(missing.length ? [`required check${plural(missing)} ${missing.join(', ')} ha${missing.length === 1 ? 's' : 've'} not passed`] : []),
    ...(!failed.length && !missing.length && !approved ? ['a required approving review is missing'] : []),
  ];
  const why = reasons.join('; ') || 'GitHub names no failing required check or missing review Graphyard observed';
  return { key: item.key, pr: candidate.pr, head: state.head, mergeStateStatus: 'BLOCKED', requestedAt: state.requestedAt!, ageMs,
    text: `merge-stalled: ${item.key} pull request #${candidate.pr} at ${state.head.slice(0, 12)} has been set to auto-merge for ${Math.floor(ageMs / 60_000)} minutes (since ${state.requestedAt}) while GitHub reports mergeStateStatus BLOCKED: ${why}`,
    next: failed.length ? `the failed-CI rework rule returns ${item.key} to a worker; gh pr checks ${candidate.pr} shows the failing run` : `gh pr view ${candidate.pr} shows what GitHub is waiting on` };
}
/**
 * How long auto-merge may wait on an authorized head GitHub reports BLOCKED before the control plane
 * asks GitHub to merge that head at once: GitHub never says why auto-merge does not fire, but a
 * head-bound merge either lands or is refused with the rule that blocks it, recorded as the reason.
 */
export const blockedAutoMergeProbeMs = 10 * 60_000;
export function mergeQueueAction(work: Work, state: GitHubMergeQueueState, request: MergeEnqueueRequest | null, now = Date.now()): MergeQueueAction {
  const held = state.mode !== 'none';
  const sha = work.candidate?.sha;
  const withdrawn = !mergeAuthorized(work) ? `${work.key} is no longer authorized to merge: ${[...work.gates.flatMap(gate => gate.reasons), ...work.violations].join('; ') || 'no all-gates authorization binds the current candidate'}`
    : state.head !== sha ? `${work.key}: GitHub holds head ${state.head.slice(0, 12)}, not the authorized candidate ${sha?.slice(0, 12)}`
      : null;
  if (withdrawn) return held ? { kind: 'dequeue', reason: withdrawn } : { kind: 'hold', reason: withdrawn };
  const waitedMs = request ? now - Date.parse(request.at) : 0;
  if (state.mode === 'auto-merge' && state.mergeStateStatus === 'BLOCKED' && waitedMs > blockedAutoMergeProbeMs)
    return { kind: 'enqueue', mergeNow: true, reason: `${work.key}: auto-merge has waited ${Math.floor(waitedMs / 60_000)} minutes at ${sha!.slice(0, 12)} while GitHub reports it BLOCKED with every gate passing; asking GitHub to merge that head now, so it merges or names the rule that blocks it` };
  if (held) return { kind: 'hold', reason: `${work.key} is ${state.mode === 'queued' ? `in GitHub's merge queue${state.entryState ? ` (${state.entryState.toLowerCase()}${state.position !== null ? `, position ${state.position}` : ''})` : ''}` : 'set to auto-merge'} at ${sha!.slice(0, 12)}; GitHub performs the merge` };
  return { kind: 'enqueue', reason: `${work.key}: every gate passes for ${sha!.slice(0, 12)} and the merge was requested; ${state.queue ? 'adding it to GitHub\'s merge queue' : mergeableNow(state) ? 'merging it now, bound to that head (GitHub reports it mergeable and the base branch has no merge queue)' : 'enabling auto-merge (the base branch has no merge queue)'}` };
}
/** The line `master status` shows for an item's place in GitHub's merge queue, from its observation. */
export function describeGitHubQueue(work: Pick<Work, 'observation'>): string | null {
  const state = work.observation?.githubQueue;
  if (!state) return null;
  if (state.mode === 'none') return 'not in GitHub\'s merge queue';
  if (state.mode === 'auto-merge') return `auto-merge enabled at ${state.head.slice(0, 12)}`;
  return `in GitHub's merge queue${state.position !== null ? ` at position ${state.position}` : ''}${state.entryState ? ` (${state.entryState.toLowerCase()})` : ''}${state.groupHead ? `, merge group ${state.groupHead.slice(0, 12)}` : ''}`;
}


/**
 * GY-516. One rerun of a failed required check before it counts. A single infrastructure flake (a
 * database torn down under a test, a runner lost) otherwise returns the head to its worker and
 * costs a review, proof and CI round for a failure that is not the change's. The
 * control plane asks GitHub to rerun the failed jobs of that workflow run once, per candidate sha
 * and check, and while the rerun is owed or running the failure holds: the candidate keeps every
 * binding on the unchanged sha. The rerun's own conclusion then decides as any run does; a second
 * failure on the same sha returns the head to its worker, as before.
 */
declare module './model/work.js' {
  interface Work {
    /** GY-516: the reruns of failed required checks, per candidate sha and check (see `reconcileCheckReruns`). */
    checkReruns?: CheckRerun[];
  }
}
export interface CheckRerun {
  /** The candidate sha and the required check that failed on it. */
  sha: string; check: string;
  /** The failed check run the rerun answers; its workflow run is the one GitHub reruns. */
  failedRunId: number;
  /**
   * `owed` until the control plane asks GitHub, `requested` once GitHub accepted, `refused` when it
   * did not (the failure then stands), and the rerun's conclusion once observed: `passed` or
   * `failed`. `expired` is a request whose rerun never appeared within `checkRerunVisibilityMs`.
   * An owed rerun whose workflow run is still running its other jobs stays `owed`, with `waiting`
   * naming the run's status, and is asked of GitHub once the run completes (GY-1329).
   */
  state: 'owed' | 'requested' | 'refused' | 'passed' | 'failed' | 'expired';
  at: string;
  /** The workflow run GitHub reruns, once asked. */
  runId?: number;
  /** The check run of the rerun, once observed. */
  rerunId?: number;
  /** The workflow run's attempt the rerun was requested from; GitHub's rerun is a later attempt (GY-1096). */
  attempt?: number;
  /**
   * GY-1096: what GitHub last said of the rerun's workflow run once no new check run had appeared
   * within `checkRerunVisibilityMs`: still `queued`, `waiting`, `in_progress` and the like is a
   * runner-queue wait, which keeps holding the failure until the rerun concludes. On an `owed`
   * rerun (GY-1329) it is the unfinished run the rerun waits on before GitHub is asked.
   */
  waiting?: { status: string; at: string };
  /** When the workflow run was last read for this rerun (GY-1096). */
  probedAt?: string;
  /** When GitHub was asked a second time because no rerun was found at all (GY-1096); asked once only. */
  rerequestedAt?: string;
  /** GY-1109: the run this rerun answers was cancelled by GitHub, not failed; such reruns have their own allowance. */
  cancelled?: boolean;
  detail?: string;
  resolvedAt?: string;
}
/** The installation-ledger event recording the rerun count the master published (POST /api/merge-queue). */
export const rerunFailedChecksEvent = 'merge-queue.rerun-failed-checks';
/**
 * An owed rerun with no new check run after this long no longer holds the failure. An accepted one
 * is then asked of GitHub instead (GY-1096): a workflow run still queued or in progress is a wait,
 * and a rerun not found at all is requested once more before it counts.
 */
export const checkRerunVisibilityMs = 15 * 60_000;
/** How often an accepted rerun past `checkRerunVisibilityMs` with no check run has its workflow run read again. */
export const checkRerunProbeMs = 5 * 60_000;
/** An accepted rerun whose workflow run GitHub fails to return for this long no longer holds the failure. */
export const checkRerunUnreadableMs = 2 * checkRerunVisibilityMs;
/** GY-1109: reruns of a cancelled run per candidate sha and check; past it the check stays pending, never failed. */
export const cancelledRerunLimit = 3;
/** Rerun records kept on an item; older ones remain on the ledger. */
export const checkRerunLimit = 20;
const holdingRerun = new Set<CheckRerun['state']>(['owed', 'requested']);

export function checkReruns(work: Pick<Work, 'checkReruns'>): CheckRerun[] {
  return work.checkReruns ?? [];
}
/** The rerun holding `run`, the failed latest run of `check` on `sha`: owed or requested for exactly that run. */
export function holdingCheckRerun(work: Pick<Work, 'checkReruns'>, sha: string, check: string, run: Observation['checks'][number] | undefined): CheckRerun | null {
  if (!run || run.id === undefined || !failedConclusions.has(run.result)) return null;
  return checkReruns(work).find(entry => entry.sha === sha && entry.check === check && entry.failedRunId === run.id && holdingRerun.has(entry.state)) ?? null;
}
/**
 * Whether `check`'s newest run on the observed current candidate failed and is held by its one
 * owed or requested rerun: the loop's decisions and the test gate's next action then wait for the
 * rerun instead of returning the head to its worker, which would cost the bindings the rerun keeps.
 */
export function checkRerunHeld(work: Pick<Work, 'checkReruns' | 'candidate' | 'observation' | 'gates' | 'policy'>, check: string): boolean {
  const observation = work.observation, sha = work.candidate?.sha;
  if (!observation || !sha || observation.candidate.sha !== sha) return false;
  // A protection-only check's run is the one the test gate reads for it (GY-1060), not a policy check's trusted-app run.
  const required = requiredChecksOf(work).find(entry => entry.name === check);
  return !!holdingCheckRerun(work, sha, check, required && !required.policy ? requiredCheckRun(required, observation.checks, ciAppIdsOf(work)) : requiredCheck(work, check));
}
/** A transition of a rerun record, as the engine writes it to the item's ledger. */
export interface CheckRerunTransition { kind: 'check.rerun.owed' | 'check.rerun.passed' | 'check.rerun.failed' | 'check.rerun.expired' | 'check.rerun.requested'; rerun: CheckRerun }
/** The newest trusted run of `check` on the observed candidate. */
function latestTrusted(observation: Observation, check: string, ciAppIds: readonly number[]) {
  return latestCheck((observation.checks ?? []).filter(entry => entry.name === check && ciAppIds.includes(entry.appId)));
}
/**
 * Brings the rerun records up to the observation just taken, before the gates read it: a rerun
 * whose own run concluded is resolved with that conclusion, one that never appeared expires, and
 * each required check whose newest run failed on the current candidate is owed one rerun while
 * fewer than `limit` were made for that sha and check (0 disables). Pure: the engine records the
 * transitions, and the GitHub request is made outside the transaction (`owedCheckReruns`).
 */
export function reconcileCheckReruns(work: Work, ciAppIds: readonly number[], limit: number, now: Date): { reruns: CheckRerun[]; transitions: CheckRerunTransition[] } {
  const observation = work.observation, candidate = work.candidate, at = now.toISOString();
  const transitions: CheckRerunTransition[] = [];
  let reruns = checkReruns(work);
  if (!observation || !candidate || observation.candidate.sha !== candidate.sha || observation.merged) return { reruns, transitions };
  const latestOf = (name: string) => latestTrusted(observation, name, ciAppIds);
  reruns = reruns.map(entry => {
    if (entry.sha !== candidate.sha || !holdingRerun.has(entry.state)) return entry;
    const run = latestOf(entry.check);
    if (run && run.id !== undefined && run.id !== entry.failedRunId) {
      // GitHub's rerun is a new check run on the same sha: its conclusion is the rerun's outcome.
      if (run.result === 'success') { const resolved = { ...entry, state: 'passed' as const, rerunId: run.id, resolvedAt: at }; transitions.push({ kind: 'check.rerun.passed', rerun: resolved }); return resolved; }
      // GY-1109: a run GitHub cancelled is no verdict on the commit (only a check whose runs were all
      // cancelled reads one as newest): the rerun ends without failing, and the cancelled run is
      // itself owed a rerun below, so the check is run again instead of counted as failed.
      if (run.result === 'cancelled') { const ended = { ...entry, state: 'expired' as const, rerunId: run.id, detail: `GitHub cancelled ${entry.check} run ${run.id} instead of concluding it`, resolvedAt: at }; transitions.push({ kind: 'check.rerun.expired', rerun: ended }); return ended; }
      if (failedConclusions.has(run.result)) { const resolved = { ...entry, state: 'failed' as const, rerunId: run.id, resolvedAt: at }; transitions.push({ kind: 'check.rerun.failed', rerun: resolved }); return resolved; }
      if (entry.state === 'owed') { const started = { ...entry, state: 'requested' as const, rerunId: run.id }; transitions.push({ kind: 'check.rerun.requested', rerun: started }); return started; }
      return entry.rerunId === run.id ? entry : { ...entry, rerunId: run.id };
    }
    // An accepted rerun naming its workflow run is asked of GitHub by the integration job instead
    // (GY-1096): queued behind busy runners it is a wait, not a failure, however long it takes.
    if (entry.state === 'requested' && entry.runId !== undefined) return entry;
    // An owed rerun waiting on its unfinished workflow run (GY-1329) is held while that run is read;
    // its bound runs from the last read, so it lapses only once GitHub stops being asked.
    const since = entry.state === 'owed' && entry.waiting ? entry.probedAt ?? entry.waiting.at : entry.at;
    if (now.getTime() - Date.parse(since) >= checkRerunVisibilityMs) {
      const expired = { ...entry, state: 'expired' as const, detail: `${entry.state === 'owed' ? 'The rerun remained owed' : 'GitHub accepted the rerun'} but no new ${entry.check} run appeared within ${checkRerunVisibilityMs / 60_000} minutes`, resolvedAt: at };
      transitions.push({ kind: 'check.rerun.expired', rerun: expired }); return expired;
    }
    return entry;
  });
  for (const name of work.policy?.checks ?? []) {
    const run = latestOf(name);
    if (!run || run.id === undefined || !failedConclusions.has(run.result)) continue;
    const made = reruns.filter(entry => entry.sha === candidate.sha && entry.check === name);
    if (made.some(entry => entry.failedRunId === run.id)) continue;
    // A cancelled run is not a failure, so it does not spend the failure's rerun allowance (GY-1109):
    // it is rerun on its own small allowance (none when reruns are disabled), and past that the check stays pending, never failed.
    const cancelled = run.result === 'cancelled';
    if (cancelled ? limit <= 0 || made.filter(entry => entry.cancelled).length >= cancelledRerunLimit : made.filter(entry => !entry.cancelled).length >= limit) continue;
    const owed: CheckRerun = { sha: candidate.sha, check: name, failedRunId: run.id, state: 'owed', at, ...(cancelled ? { cancelled: true } : {}) };
    reruns = [...reruns, owed];
    transitions.push({ kind: 'check.rerun.owed', rerun: owed });
  }
  return { reruns: reruns.slice(-checkRerunLimit), transitions };
}
/** The reruns the control plane still has to ask GitHub for: owed, on the current candidate, whose failed run is still the newest. */
export function owedCheckReruns(work: Work, ciAppIds: readonly number[]): CheckRerun[] {
  const observation = work.observation, candidate = work.candidate;
  if (!observation || !candidate || observation.candidate.sha !== candidate.sha || observation.merged) return [];
  return checkReruns(work).filter(entry => entry.sha === candidate.sha && entry.state === 'owed'
    && latestTrusted(observation, entry.check, ciAppIds)?.id === entry.failedRunId);
}
/** What asking GitHub for an owed rerun came to (GY-1329): accepted, refused, or held until its workflow run completes. */
export type OwedRerunOutcome =
  | { state: 'requested'; runId: number; attempt?: number }
  | { state: 'waiting'; runId: number; attempt?: number; status: string }
  | { state: 'refused'; detail?: string };
/**
 * The owed rerun `entry` after `outcome`, at `at`. `requested` and `refused` are recorded as they
 * always were; `waiting` keeps the entry owed, unresolved, naming the unfinished run's status and
 * when it was read, so the next observation asks again and requests the rerun once the run completes.
 * A rerun requested after a wait is timed from the request, as an unwaited one is.
 */
export function owedRerunAfter(entry: CheckRerun, outcome: OwedRerunOutcome, at: string): CheckRerun {
  if (outcome.state === 'waiting') return { ...entry, runId: outcome.runId, ...(outcome.attempt !== undefined ? { attempt: outcome.attempt } : {}), probedAt: at,
    waiting: entry.waiting?.status === outcome.status ? entry.waiting : { status: outcome.status, at } };
  const { waiting, probedAt, ...rest } = entry;
  const waited = waiting ? { at } : {};
  if (outcome.state === 'requested') return { ...rest, ...waited, state: 'requested', runId: outcome.runId, ...(outcome.attempt !== undefined ? { attempt: outcome.attempt } : {}) };
  return { ...rest, state: 'refused', ...(outcome.detail ? { detail: outcome.detail } : {}), resolvedAt: at };
}
/**
 * GY-1096: the accepted reruns on the current candidate whose new check run has not appeared within
 * `checkRerunVisibilityMs` of the request, and whose workflow run is due to be read again: the
 * integration job asks GitHub whether the run is queued, running, concluded or missing.
 */
export function dueCheckRerunProbes(work: Work, ciAppIds: readonly number[], now: Date): CheckRerun[] {
  const observation = work.observation, candidate = work.candidate;
  if (!observation || !candidate || observation.candidate.sha !== candidate.sha || observation.merged) return [];
  return checkReruns(work).filter(entry => entry.sha === candidate.sha && entry.state === 'requested' && entry.runId !== undefined
    && latestTrusted(observation, entry.check, ciAppIds)?.id === entry.failedRunId
    && now.getTime() - Date.parse(entry.detail?.match(/cancelled:\d+:(\S+)/)?.[1] ?? entry.rerequestedAt ?? entry.at) >= checkRerunVisibilityMs
    && (!entry.probedAt || now.getTime() - Date.parse(entry.probedAt) >= checkRerunProbeMs));
}
/** The workflow run GitHub reports for a rerun (GY-1096), or null when there is none. */
export interface RerunWorkflowRun { status: string; conclusion: string | null; attempt: number | null }
/** What an accepted rerun's workflow run says of it (GY-1096). */
export type CheckRerunProbe =
  | { kind: 'waiting'; status: string }
  | { kind: 'failed'; conclusion: string }
  | { kind: 'cancelled'; attempt?: number }
  | { kind: 'missing' };
/**
 * Classifies the workflow run read for an accepted rerun with no new check run: a run not yet
 * completed is a runner-queue wait; a later attempt that concluded failing is the rerun failing;
 * one that concluded otherwise holds until its check run is observed; no run, or no attempt after
 * the one the rerun was requested from, is a rerun GitHub accepted but never created.
 */
export function classifyRerunRun(entry: Pick<CheckRerun, 'attempt'>, run: RerunWorkflowRun | null): CheckRerunProbe {
  if (!run) return { kind: 'missing' };
  if (run.status !== 'completed') return { kind: 'waiting', status: run.status };
  const later = entry.attempt !== undefined && run.attempt !== null && run.attempt > entry.attempt;
  if (!later) return { kind: 'missing' };
  // GY-1109: a later attempt GitHub cancelled did not conclude the rerun; it keeps the hold and is rerun again.
  if (run.conclusion === 'cancelled') return { kind: 'cancelled', ...(run.attempt !== null ? { attempt: run.attempt } : {}) };
  if (run.conclusion && failedConclusions.has(run.conclusion)) return { kind: 'failed', conclusion: run.conclusion };
  return { kind: 'waiting', status: 'completed' };
}
const runnerWait = (entry: CheckRerun) => entry.waiting && entry.waiting.status !== 'completed'
  ? `, waiting for a runner (its workflow run is ${entry.waiting.status.replace(/_/g, ' ')} in the runner queue)` : '';
/** The rerun of `check` on the current candidate, as a clause the test gate's refusal carries. */
export function checkRerunStatus(work: Work, check: string): string {
  const sha = work.candidate?.sha;
  const last = checkReruns(work).filter(entry => entry.sha === sha && entry.check === check).at(-1);
  if (!last) return '';
  const state = last.state === 'owed' ? `one rerun of its failed jobs is owed${last.waiting ? `, once its workflow run${last.runId ? ` ${last.runId}` : ''} completes (now ${last.waiting.status.replace(/_/g, ' ')})` : ''}`
    : last.state === 'requested' ? `its failed jobs are rerunning${last.runId ? ` (workflow run ${last.runId})` : ''}${runnerWait(last)}`
    : last.state === 'failed' ? 'failed again after rerunning its failed jobs'
    : last.state === 'passed' ? 'passed'
    : `${last.state}: ${last.detail ?? 'no reason given'}`;
  return `; rerun: ${state}`;
}
