import type { Evidence, Observation, ScopeFile, Work } from './model.js';
import { evidenceBindsCandidate, type ApprovalIdentity, type CarriedApproval, type CarriedProof, type QueueCarry, type RequiredApproval, type TipMerge } from './model/carry.js';
import { reviewProviderOf } from './model/review.js';
import { pathScopesOverlap } from './model/scope.js';
import { queuedRegressions } from './regression-guard.js';
import { missingAncestryReason, missingBaseAncestry } from './merge-base-ancestry.js';

// Graphyard publishes speculative tips outside refs/heads and refs/tags: the namespace is
// owned by the App, is never a branch a worker can push, and never appears as a PR head.
export function queueRef(key: string) { return `refs/graphyard/queue/${key.toLowerCase()}`; }
/** The scratch branch a base refresh test-merges on before it trusts GitHub's conflict reading (GY-375); deleted after each check. */
export function mergeCheckBranch(key: string) { return `graphyard-merge-check/${key.toLowerCase()}`; }

export interface QueueSpeculation {
  ref: string; tip: string; base: string; baseTree: string;
  /** The published tip's own tree: what the entry behind this one is predicted to land on (GY-100). */
  tipTree?: string;
  predecessors: string[]; policyRevision: number; publishedAt: string;
  /** How Graphyard produced the tip, when it replaced the head; absent when the head already contained its base. */
  merge?: TipMerge | null;
  /**
   * For a tip that is the reviewed head itself, republished over an earlier tip because the head
   * already contained its new predicted base (GY-127): the paths that changed between the
   * replaced tip's bound base and the predicted base, as GitHub listed them, or null when it could
   * not list them completely. The identity carry (`decideIdentityCarry`) is decided on this list.
   */
  baseChanges?: string[] | null;
  /** Which bindings of the replaced head carried to the tip, decided when the tip was bound. */
  carry?: QueueCarry | null;
  /** The base-branch commit the bound base was last found tree-identical to: the advance that carried the binding. */
  carriedBase?: { sha: string; tree: string; at: string } | null;
  /**
   * The item's own reviewed head the tip was built from: the last head a worker pushed, or the
   * control plane brought onto the base branch — never an earlier speculative tip. Every tip is
   * a merge of exactly this commit and its predicted base (GY-127), so a tip rebuilt behind a
   * different predecessor carries nothing of the one it was built behind before. Equals `tip`
   * when the head already contained its predicted base; absent on records that predate the rule.
   */
  reviewedHead?: string;
  /** An approval GitHub dismissed for a merge-base change on this very tip, restored as the binding approval; see `restoredApproval`. */
  restoredApproval?: RestoredApproval | null;
  /** Why the tip was built (GY-375): the queue head is the one candidate brought onto the base unasked. */
  trigger?: 'queue-head';
}
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

export interface QueueEntry { sequence: number; enqueuedAt: string; policyRevision: number; speculation: QueueSpeculation | null }
/** The published tip that replaces a queued entry's head on the next observation, or null when the head is the tip. */
export function tipReplacesHead(work: Pick<Work, 'candidate' | 'queue' | 'policyRevision'>): string | null {
  const speculation = work.queue?.speculation, candidate = work.candidate;
  return speculation && candidate && speculation.tip !== candidate.sha && speculation.policyRevision === work.policyRevision ? speculation.tip : null;
}
/**
 * The CI a queued entry is still running on its own published speculative tip, worded for the
 * merge gate, or null when the candidate is not such a tip (GY-292).
 *
 * The entry reached the queue with every gate passing on its own reviewed head; the tip merges
 * that head onto the base (or the entry ahead) and CI runs again on the combined result. That run
 * is the merge step validating what will land, not the change going back to Test: its checks are
 * named here, and the test gate, which judges the candidate's own change, stands. A check that
 * failed on the tip is an adverse conclusion that ejects the entry (`ejectionReason`), after
 * which this returns null and the test gate refuses it as ever. `testReasons` are the test gate's
 * refusals for the tip.
 */
export const tipValidationPrefix = 'Merge queue is validating speculative tip ';
export function tipValidation(work: Pick<Work, 'candidate' | 'policyRevision'>, queue: QueueEntry | null, testReasons: string[]): string[] | null {
  const speculation = queue?.speculation, candidate = work.candidate;
  if (!testReasons.length || !speculation || !candidate || speculation.tip !== candidate.sha || speculation.base !== candidate.baseSha || speculation.policyRevision !== work.policyRevision) return null;
  return testReasons.map(reason => `${tipValidationPrefix}${candidate.sha.slice(0, 12)}: ${reason}`);
}
/** The carry decisions on record that moved bindings onto `sha`, under the current policy: a base refresh's, or a tip's. */
export function onto(work: Pick<Work, 'queue' | 'baseRefresh' | 'policyRevision'>, sha: string): QueueCarry[] {
  return [work.queue?.speculation?.carry, work.baseRefresh?.carry].filter((carry): carry is QueueCarry => !!carry && carry.to.sha === sha && carry.policyRevision === work.policyRevision);
}
/**
 * The files the review of `sha` read (GY-127): the pull request's files while `sha` is the head
 * GitHub listed them for, and otherwise what the recorded decision that carried bindings from or
 * onto it said they were. Never a later tip's pull-request files: GitHub lists those against the
 * base branch, so a tip built behind an unlanded entry lists that entry's files as well. Only a
 * decision that carried the approval is read: one that refused it may have been refused for not
 * knowing the files at all. Null when nothing on record names them.
 */
export function reviewedFilesOf(work: Pick<Work, 'candidate' | 'observation' | 'queue' | 'baseRefresh' | 'policyRevision'>, sha: string): string[] | null {
  const observation = work.observation;
  if (observation && observation.candidate.sha === sha && work.candidate?.sha === sha && observation.candidate.baseSha === work.candidate.baseSha) return observation.files;
  const recorded = [work.queue?.speculation?.carry, work.baseRefresh?.carry].find(carry => !!carry && carry.policyRevision === work.policyRevision && carry.approval.carried && (carry.from.sha === sha || carry.to.sha === sha));
  return recorded ? recorded.reviewedFiles : null;
}
export interface IdentityCarryInput {
  from: { sha: string; baseSha: string }; to: { sha: string; baseSha: string }; policyRevision: number; at: string;
  /** `QueueSpeculation.baseChanges`: what the predicted base changed relative to the replaced tip's bound base, or null/absent when unlisted. */
  baseChanges: string[] | null | undefined;
  predecessor: { key: string | null; validated: boolean };
  reviewedFiles: string[];
  approval: ApprovalIdentity | null;
  proofs: { proof: string; evidence: Evidence | undefined }[];
}
const shortSha = (sha: string) => sha.slice(0, 12);
const listPaths = (paths: string[]) => paths.length > 6 ? `${paths.slice(0, 6).join(', ')} and ${paths.length - 6} more` : paths.join(', ');
/**
 * The carry decision for a tip that is the reviewed head itself (GY-127). When the reviewed head
 * already contains its new predicted base — the entry ahead was ejected and the base branch did
 * not move — the queue republishes that head as the tip and produces no commit, so the rule in
 * model/carry.ts, which admits only a Graphyard-authored two-parent merge, has nothing to check
 * about parents or author: the tip is provably the reviewed content. The per-binding rule is the
 * same one: the approval carries when the predicted base changed none of the reviewed files, and
 * each proof when its declared scope is disjoint from that change, decided on the files GitHub
 * listed between the replaced tip's bound base and the predicted base. What GitHub said when it
 * dismissed the approval on the earlier publication plays no part. An unvalidated predecessor or
 * an unlisted change refuses every binding, exactly as the merge rule does.
 */
export function decideIdentityCarry(input: IdentityCarryInput): QueueCarry {
  const { from, to, predecessor } = input;
  const who = predecessor.key ?? 'the base branch';
  const base = { from, to, policyRevision: input.policyRevision, at: input.at, predecessor: predecessor.key ?? 'base branch', changedFiles: input.baseChanges ?? null, reviewedFiles: input.reviewedFiles };
  const refuse = (reason: string): QueueCarry => ({ ...base, approval: { carried: false, reason }, evidence: input.proofs.map(({ proof }) => ({ proof, carried: false, reason })) });
  if (to.sha !== from.sha) return refuse(`tip ${shortSha(to.sha)} was not produced by Graphyard's merge of the approved head ${shortSha(from.sha)}`);
  if (!predecessor.validated) return refuse(predecessor.key ? `predecessor ${predecessor.key} is not fully validated on tip ${shortSha(to.baseSha)}` : `the predicted base ${shortSha(to.baseSha)} is not validated`);
  const changed = input.baseChanges;
  if (!changed) return refuse(`the files ${who} changed between ${shortSha(from.baseSha)} and ${shortSha(to.baseSha)} could not be listed completely`);
  const tip = `tip ${shortSha(to.sha)}, the reviewed head itself republished unchanged onto predicted base ${shortSha(to.baseSha)}`;
  const reviewedTouched = input.reviewedFiles.filter(path => changed.includes(path));
  const approval: CarriedApproval | RequiredApproval = !input.approval ? { carried: false, reason: `no approval was bound to the reviewed head ${shortSha(from.sha)}` }
    : reviewedTouched.length ? { carried: false, reason: `${who} changed reviewed files ${listPaths(reviewedTouched)}; a fresh independent approval of ${shortSha(to.sha)} is required` }
    : { ...input.approval, carried: true, originalSha: input.approval.sha, reason: `approval of ${shortSha(from.sha)} by ${input.approval.reviewer} carried to ${tip}: ${who} changed none of the ${input.reviewedFiles.length} reviewed files` };
  const evidence = input.proofs.map(({ proof, evidence }): CarriedProof => {
    if (!evidence) return { proof, carried: false, reason: `no trusted evidence was bound to the reviewed head ${shortSha(from.sha)}` };
    if (!changed.length) return { proof, carried: true, evidenceId: evidence.id, producer: evidence.producer, reason: `evidence ${evidence.id} from ${evidence.producer} carried to ${tip}: ${who} changed no file relative to ${shortSha(from.baseSha)}` };
    if (!evidence.scopeFiles?.length) return { proof, carried: false, evidenceId: evidence.id, producer: evidence.producer, reason: `evidence ${evidence.id} declares no scopeFiles, so its independence from the ${changed.length} files ${who} changed cannot be shown; fresh evidence for ${shortSha(to.sha)} is required` };
    const intersecting = changed.filter(path => evidence.scopeFiles!.some(scope => pathScopesOverlap(scope, path)));
    if (intersecting.length) return { proof, carried: false, evidenceId: evidence.id, producer: evidence.producer, reason: `${who} changed ${listPaths(intersecting)} inside the scope of evidence ${evidence.id}; fresh evidence for ${shortSha(to.sha)} is required` };
    return { proof, carried: true, evidenceId: evidence.id, producer: evidence.producer, reason: `evidence ${evidence.id} from ${evidence.producer} carried to ${tip}: its scope (${listPaths(evidence.scopeFiles)}) is disjoint from the ${changed.length} files ${who} changed` };
  });
  return { ...base, approval, evidence };
}
export interface QueueEjection {
  at: string; sequence: number; reason: string; sha: string | null; policyRevision: number;
  /**
   * For a speculative-merge conflict (GY-321): the keys of the entries the prediction held, the
   * predecessors the conflicting tip was built behind, or [] when the merge was onto the base
   * branch tip itself. Absent on other ejections and on records that predate the rule.
   */
  predecessors?: string[];
}
export interface QueueHistoryEntry {
  at: string; event: 'enqueued' | 'predicted' | 'ejected'; sequence: number; reason?: string; tip?: string;
  /** For a prediction: the entries the tip was published behind, and the item's own reviewed head it was built from. For a speculative-conflict ejection: the entries the conflicting merge was predicted behind (GY-321). */
  predecessors?: string[]; from?: string;
}

/**
 * GitHub's own account of why it dismissed a review, read from the pull request timeline and
 * recorded beside the review it withdrew. Two dismissals look alike on the review list and mean
 * opposite things: a reviewer (or a person with the power to) withdrawing a verdict, and GitHub
 * itself withdrawing an approval because the pull request's merge base moved — which is what
 * every push to the base branch does to a branch that carries a queued predecessor, and what the
 * control plane's own tip publication does to the branch it publishes on. `mergeBase` is the
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
  at: string | null; by: string | null; unread?: string;
}
/** The record of an approval the control plane restored after GitHub dismissed it for a merge-base change on an unchanged head. */
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
 * An approval of exactly the current head that GitHub dismissed with its merge-base reason: the
 * head the reviewer approved is the head the branch still has, so nothing the reviewer judged has
 * changed. It is distinguished from a withdrawn verdict by the recorded reason and the recorded
 * verdict, never inferred from timing: the reason must be GitHub's exact merge-base message, and
 * the dismissed review must have been an approval — a dismissed change request is a change
 * request the reviewer gave and never an approval, whatever message its dismissal carried. Only a
 * formal GitHub approval from someone other than the author qualifies — the same identity rule
 * `exactApproval` applies, baseline included. The engine restores such an
 * approval as the binding one (see `Engine.observe`) so no review round and no attempt is spent on
 * a commit the reviewer already approved; the reviewer App re-posts it before the merge.
 */
export function dismissedApproval(work: Work): { reviewer: string; reviewId?: number; sha: string; dismissal: ReviewDismissal } | null {
  const candidate = work.candidate, observation = work.observation;
  if (!candidate || !observation || observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha || observation.merged) return null;
  if (!work.policy.review || reviewProviderOf(work.policy) !== 'github') return null;
  const baseline = work.formalReviewBaseline;
  for (const review of observation.reviews) {
    if (review.state !== 'DISMISSED' || review.sha !== candidate.sha || review.reviewer === candidate.author) continue;
    const dismissal = reviewDismissal(review);
    if (!dismissal?.mergeBase || dismissal.verdict !== 'approved') continue;
    if (work.formalReviewResetRequired && !(baseline?.pr === candidate.pr && baseline.policyRevision === work.policyRevision && Number.isSafeInteger(review.id) && review.id! > 0 && !baseline.reviewIds.includes(review.id!))) continue;
    return { reviewer: review.reviewer, ...(review.id !== undefined ? { reviewId: review.id } : {}), sha: candidate.sha, dismissal };
  }
  return null;
}
/** The restored approval that binds the current candidate, for status and the merge broker's re-post; null when none does. */
export function restoredApproval(work: Pick<Work, 'candidate' | 'queue' | 'baseRefresh' | 'policyRevision'>): RestoredApproval | null {
  const candidate = work.candidate;
  if (!candidate) return null;
  const speculation = work.queue?.speculation;
  if (speculation?.tip === candidate.sha && speculation.policyRevision === work.policyRevision && speculation.restoredApproval?.sha === candidate.sha) return speculation.restoredApproval;
  const refresh = work.baseRefresh;
  return refresh?.head === candidate.sha && refresh.policyRevision === work.policyRevision && refresh.restoredApproval?.sha === candidate.sha ? refresh.restoredApproval : null;
}
export interface QueuePlacement {
  /**
   * `position` is the entry's place in the chain of validated entries it is predicted on, not its
   * index in the queue (GY-196): an entry that fell out of validation is predicted on the same
   * chain as the validated entry behind it, so both can hold the same position, and position 0 is
   * the chain's head only for a validated entry. An entry that fell back out of validation at the
   * merge stage (rework, violation) at position 0 is observed at the head cadence (github.ts) and
   * no more: it cannot merge, and the validated head beside it lands first. `sequence` alone
   * orders the physical queue: select the entries behind one by a greater sequence, never by
   * slicing the placements at `position`.
   */
  id: string; key: string; position: number; size: number; sequence: number; enqueuedAt: string; waitMs: number;
  predecessors: string[]; predictedBase: string | null; tip: string | null;
  /** Entries ahead by sequence that are not validated (see `validatedQueueEntry`): passed over, never predicted on (GY-196). */
  skipped?: string[];
  /**
   * Set only on an entry that is not validated itself: the validated entries behind it by sequence,
   * which pass over it and may land first until it is revalidated (GY-196). `size` counts the
   * validated entries, and this one too while it is passed over.
   */
  passedOver?: string[];
  /** The base-branch commit the chain of predictions rests on, as the head entry observed it. */
  base: { sha: string; tree: string | null } | null;
  /** How a current entry binds its predicted base: the exact commit, or a tree-identical advance of it. */
  binding: 'exact' | 'tree-equivalent' | null;
  /** The tree a current entry's tip lands, for the entry behind it to bind its prediction by (GY-100); null when unpublished or recorded before tips carried their tree. */
  tipTree?: string | null;
  current: boolean; publishable: boolean; reasons: string[];
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
 * from GitHub's account of the commit it produced, exactly as the merge queue does for a
 * speculative tip. A conflict is the one case that still belongs to the worker.
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
  /** How Graphyard produced the head, as GitHub reports the commit; null when nothing was merged. */
  merge?: TipMerge | null;
  /** Which bindings of the replaced head carried onto it, decided once when the refresh was bound. */
  carry?: QueueCarry | null;
  /**
   * Set when this record is a branch restore rather than a refresh (GY-127): the branch was found
   * carrying another item's unlanded commits and was reset to the item's own reviewed head, then
   * brought onto the base. `head` is null while a requested repair has not run yet.
   */
  restore?: BranchRestore | null;
  /** An approval GitHub dismissed for a merge-base change on this very head, restored as the binding approval. */
  restoredApproval?: RestoredApproval | null;
  /**
   * What made the control plane touch the branch (GY-375): a conflict its own test merge confirmed,
   * or a branch restore (an ejection's, or a repair the coordinator requested). Absent on records
   * that predate the rule.
   */
  trigger?: RefreshTrigger;
  /**
   * GitHub reported the head conflicting with `base`, and the control plane's own test merge of
   * the two was clean (GY-375): nothing was written, and the reading is recorded here instead of a
   * refresh. `head` is then the unchanged candidate, and whatever the record carried onto it stays.
   */
  stale?: StaleMergeability | null;
}
/** Why a branch was written by the control plane rather than by its worker (GY-375). */
export type RefreshTrigger = 'conflict confirmed' | 'ejection restore' | 'repair';
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
 * A branch that carried another item's unlanded commits, and what the control plane did about it.
 *
 * A speculative tip is a merge of the item's own reviewed head and the tip of the entry ahead of
 * it, published on the pull-request branch so the checks, the review and every proof bind one
 * commit. While the entry is queued that is the queue's own construction. Once the entry leaves
 * the queue — ejected, or behind an entry that was — the branch still carries the predecessor's
 * commits: kept, the head is refused as an out-of-scope regression; landed, it would record the
 * predecessor's pull request merged without its content. No head a worker may push can pass, and
 * workers may not force-push. So the control plane restores the branch itself: reset to the
 * item's own reviewed head (`own`), then merged onto the base branch exactly as a base refresh
 * would. An ejection runs the restore on its own; a branch found contaminated any other way is
 * repaired on the coordinator's request (`graphyard master repair GY-N`, the `repair` command).
 */
export interface BranchRestore {
  /** The head found carrying another item's unlanded commits. */
  contaminated: string;
  /** The items whose unlanded commits it carried, as the record and the observation named them. */
  foreign: string[];
  /** The item's own reviewed head the branch was reset to; null when none could be determined. */
  own: string | null;
  cause: 'ejection' | 'repair';
  /** The coordinator's request, for a repair; null for the restore an ejection runs on its own. */
  requested: { by: string; at: string; reason: string } | null;
  reason: string;
  performedAt: string | null;
  /** `restored`: the branch holds `own` merged onto the base; `conflict`: it holds `own`, and the merge is the worker's; `unrepairable`: no own head could be found under the foreign commits. */
  outcome: 'restored' | 'conflict' | 'unrepairable' | null;
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
 * hour, never converging. So, as merge queues do, the combined result is built only where it is
 * needed: for the merge-queue head, whose speculative tip merges its own reviewed head onto the
 * base just before it lands (`predictQueue`, `advanceQueue`), and here for a candidate GitHub
 * reports conflicting with the new base, whose refresh records the conflict and returns it to its
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
  if (!work.submission || work.reworkRequested || work.stage === 'done' || work.queue || work.blocker) return null;
  if (!candidate || !observation || observation.merged || observation.prState === 'closed' || observation.draft) return null;
  if (observation.candidate.sha !== candidate.sha) return null;
  const baseTip = observation.baseTip;
  if (observation.baseTipContained !== false || !baseTip || baseTip === candidate.baseSha) return null;
  if (observation.conflicting !== true) return null;
  const refresh = work.baseRefresh;
  if (refresh && refresh.from.sha === candidate.sha && refresh.base === baseTip && refresh.policyRevision === work.policyRevision) return null;
  // A head found carrying another item's unlanded commits is not brought onto a moved base: a
  // repair requested for it runs first and replaces it, and a head found unrepairable would only
  // carry the foreign commits along, with the record that names the remedy (rework) replaced by
  // a refresh that says nothing of them (GY-127).
  const restore = currentRestore(work)?.restore;
  if (restore && restore.contaminated === candidate.sha && (restore.performedAt === null || restore.outcome === 'unrepairable')) return null;
  return { head: candidate.sha, boundBase: candidate.baseSha, baseTip };
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
 * actually land on — the live base-branch tip, or the predicted base of a tip published behind
 * entries that have not landed yet:
 *
 * - `files`: every out-of-scope file of the pull request's diff, which the provider recomputes
 *   against the moving base, compared with that commit. Present only when it differs by tree from
 *   the bound base, where `scopeFiles` already is this comparison.
 * - `carried`: other items' unlanded candidates whose commits this head has in its history — a
 *   speculative tip pushed onto its branch leaves them there — while its tree holds their files as
 *   the landing commit does. Merging such a head makes the provider record the other pull request
 *   merged with none of its content on the base branch, and no diff against any base shows it:
 *   that is how GY-93's merge took GY-84's delivery with it. The entries a predicted base is
 *   published behind are excluded, since that base holds them: their files standing in the tip as
 *   they stand there is how every queued tip holds its predecessors, and anything it really takes
 *   from them is a change against the base it lands on, which `files` above compares.
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
   * Every open candidate — apart from the entries a predicted base is published behind — whose
   * head, or whose own reviewed head under a tip of its own, is in this head's history (GY-127).
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

export const queueHistoryLimit = 40;
// Pending, queued, or missing is not failure. Only a reported adverse conclusion ejects.
const failedConclusions = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale', 'neutral']);

/** Deterministic service order: enqueue sequence, then key. Position is never bought or bypassed. */
export function queueOrder(all: Work[]) {
  return all.filter(work => !!work.queue && work.stage !== 'done')
    .sort((a, b) => a.queue!.sequence - b.queue!.sequence || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
export function nextQueueSequence(all: Work[]) {
  return Math.max(0, ...all.map(work => work.queueSequence ?? 0)) + 1;
}
/** The real base-branch tip GitHub reported, independent of any speculative binding. */
export function observedBaseTip(work: Work) {
  return work.observation?.baseTip ?? work.candidate?.baseSha ?? null;
}

/**
 * The published speculation a queued candidate keeps when its predicted base moved only to a
 * commit with the validated base's own tree — an entry ahead republishing a tree-identical tip,
 * or a queue merge advancing the base branch. Merging such a prediction would replace the head
 * with a tree-identical commit, and a tip push dismisses the approval and every verdict bound to
 * the head it replaces: a review round for content nobody changed. So nothing is republished
 * (GY-100); the advance is recorded on the speculation as `carriedBase` and `predictQueue` binds
 * the tip to the prediction through it. Null whenever a merge really has to happen: no published
 * tip for this exact candidate and policy, or a prediction whose tree differs from the validated
 * base's, which is content the tip does not hold.
 */
export function treeIdenticalPrediction(work: Pick<Work, 'candidate' | 'queue' | 'policyRevision'>, predictedBase: string, predictedBaseTree: string): QueueSpeculation | null {
  const speculation = work.queue?.speculation, candidate = work.candidate;
  if (!speculation || !candidate || speculation.tip !== candidate.sha || speculation.base !== candidate.baseSha || speculation.policyRevision !== work.policyRevision) return null;
  return speculation.base !== predictedBase && !!speculation.baseTree && speculation.baseTree === predictedBaseTree ? speculation : null;
}
/**
 * The carry decision a speculation being bound keeps without deciding again, or undefined when
 * the tip replaces the candidate's head and the carry must be decided for it. A tip that already
 * is the candidate — the same published tip re-bound to a tree-identical prediction (see
 * treeIdenticalPrediction) — keeps the decision recorded when it first replaced the reviewed
 * head: that decision is what binds the carried approval and every carried proof to the tip, and
 * nothing about the tip changed. A tip the record does not already hold carries nothing.
 */
export function keptTipCarry(work: Pick<Work, 'candidate' | 'queue'>, speculation: QueueSpeculation): QueueCarry | null | undefined {
  const candidate = work.candidate, recorded = work.queue?.speculation;
  if (!candidate) return null;
  if (speculation.tip !== candidate.sha) return undefined;
  return recorded && recorded.tip === speculation.tip && recorded.base === speculation.base && recorded.policyRevision === speculation.policyRevision ? recorded.carry ?? null : null;
}

/**
 * Whether a queued entry is a predecessor the entries behind it are predicted on (GY-196). An entry
 * stays one while its tip is being validated by the control plane's own rounds — CI and the proofs
 * it requests run on every freshly published tip, and the entries behind it validate in parallel
 * on that tip. It stops being one when it fell back out of validation: its tip needs an approval
 * afresh (a republication or base refresh the approval did not carry across, a review requested
 * anew), a rework was requested, or it has an open violation. Such an entry keeps its sequence, but
 * nothing behind it is built on, bound to, or ejected for a tip that may never land: the entries
 * behind it are predicted on the base branch plus the predecessors ahead only, and their tips are
 * rebuilt there. It is predicted on that same chain itself, and counts again once it is approved.
 * An entry GitHub already merged is not passed over: its content is on the base branch, and it
 * holds its place until its reconciliation exits it (see `unpublishableEntry`).
 */
const validatingStages: readonly Work['stage'][] = ['test', 'acceptance', 'merge'];
export function validatedQueueEntry(work: Pick<Work, 'queue' | 'stage' | 'violations' | 'reworkRequested' | 'observation'>): boolean {
  if (!work.queue) return false;
  if (work.observation?.merged) return true;
  return validatingStages.includes(work.stage) && !work.reworkRequested && !work.violations.length;
}
export function predictQueue(all: Work[], now: number): QueuePlacement[] {
  const entries = queueOrder(all);
  const placements: QueuePlacement[] = [];
  const validated = entries.map(validatedQueueEntry), validatedCount = validated.filter(Boolean).length;
  for (const [index, work] of entries.entries()) {
    const entry = work.queue!, candidate = work.candidate, speculation = entry.speculation;
    // The entries ahead that this one is predicted on: the validated ones only (GY-196). Its
    // position is its place in that chain, so an entry behind only unvalidated ones is the head.
    const ahead = entries.slice(0, index).filter((_, at) => validated[at]);
    const skipped = entries.slice(0, index).filter((_, at) => !validated[at]).map(item => item.key);
    const passedOver = validated[index] ? null : entries.slice(index + 1).filter((_, at) => validated[index + 1 + at]).map(item => item.key);
    const position = ahead.length;
    const previous = position === 0 ? null : placements.find(placement => placement.id === ahead[position - 1].id)!;
    // The chain's head predicts against the observed base branch; every other entry predicts
    // against the validated tip of the validated entry directly ahead, which is what main will
    // hold once it merges.
    const predictedBase = !previous ? observedBaseTip(work) : previous.tip;
    const base = !previous ? predictedBase ? { sha: predictedBase, tree: work.observation?.baseTree ?? null } : null : previous.base;
    const published = !!speculation && !!candidate && speculation.tip === candidate.sha
      && speculation.base === candidate.baseSha && speculation.policyRevision === work.policyRevision;
    const onPrediction = !!candidate && !!predictedBase && candidate.baseSha === predictedBase;
    // An earlier queue merge advances the base branch, or an entry ahead republishes its own tip,
    // to a commit whose tree is exactly the validated base's tree. Re-binding to that advance
    // needs no new commit, so the published tip, the candidate, the review and every proof stay
    // bound; the advance is recorded, not republished. This is the same judgement at every
    // position (GY-100): a tip push replaces the head, and GitHub dismisses its approval with it,
    // so an entry whose prediction moved only in sha must not be republished either.
    const predictedBaseTree = !previous ? work.observation?.baseTree ?? null : previous.tipTree ?? null;
    // The queue head lands on the base branch tip itself, and GitHub dismisses the approval of a
    // head that does not contain that exact commit, whatever its tree (GY-145): no carry for it.
    const unancestored = position === 0 && !onPrediction && published && predictedBase === work.observation?.baseTip ? missingBaseAncestry(work) : null;
    const treeEquivalent = !unancestored && !onPrediction && published && !!predictedBaseTree && predictedBaseTree === speculation!.baseTree;
    // The same tree identity as the publisher itself found it, when it declined to republish and
    // recorded the advance on the speculation instead (see treeIdenticalPrediction). Read for a
    // tip published before tips carried their own tree, where the prediction's tree is unknown here.
    const carriedToPrediction = !unancestored && !onPrediction && published && !!predictedBase
      && speculation!.carriedBase?.sha === predictedBase && speculation!.carriedBase!.tree === speculation!.baseTree;
    // Only a Graphyard-published tip may land. Publication is what proves the validated commit
    // already contains its predicted base, so the merge result is that commit's tested tree even
    // though the candidate branch is deliberately behind the base branch while it waits its turn.
    const current = published && (onPrediction || treeEquivalent || carriedToPrediction);
    const reasons: string[] = [];
    // The chain this entry is counted in: the validated entries, and itself while passed over. A
    // passed-over entry says so, naming the validated entries behind it that may land before it.
    const size = validatedCount + (passedOver ? 1 : 0);
    const passed = passedOver?.length ? `passed over until revalidated, so ${passedOver.join(', ')} behind may merge first` : null;
    if (position > 0 || passed) reasons.push(`Merge queue position ${position + 1} of ${size}: ${[position > 0 ? `${ahead[position - 1].key} is ahead` : null, passed].filter(Boolean).join('; ')}`);
    if (!current) reasons.push(predictedBase
      ? unancestored ? `Speculative tip on predicted base ${predictedBase.slice(0, 12)} has not been published onto that exact commit: ${missingAncestryReason(unancestored)}`
      : `Speculative tip on predicted base ${predictedBase.slice(0, 12)} has not been published and validated for this candidate`
      : `Waiting for ${ahead[position - 1]?.key ?? 'the queue head'} to publish its speculative tip`);
    placements.push({
      id: work.id, key: work.key, position, size, sequence: entry.sequence, enqueuedAt: entry.enqueuedAt,
      waitMs: Math.max(0, now - Date.parse(entry.enqueuedAt)), predecessors: ahead.map(item => item.key), skipped, ...(passedOver ? { passedOver } : {}),
      predictedBase, tip: current && candidate ? candidate.sha : null, base, binding: current ? treeEquivalent || carriedToPrediction ? 'tree-equivalent' : 'exact' : null,
      tipTree: current && candidate ? speculation!.tipTree ?? null : null, current,
      publishable: !current && !!predictedBase && !!candidate, reasons,
    });
  }
  return placements;
}
/**
 * True for a merge-gate reason that only sequences a queued candidate: it is waiting its turn,
 * for its speculative tip, or for CI on that tip (`tipValidation`), not refused by protection, mergeability, freshness, or a hold.
 * Kept beside the messages above so a wording change is visible here.
 */
export function queueSequencingReason(reason: string) {
  return /^(Merge queue position \d+ of \d+: |Speculative tip on predicted base [0-9a-f]+ has not been published|Waiting for \S+ to publish its speculative tip$|Merge queue is validating speculative tip [0-9a-f]+: )/.test(reason) || !!predecessorWaitReason(reason);
}
export function queuePlacement(work: Work, all: Work[], now: number) {
  return predictQueue(all, now).find(placement => placement.id === work.id) ?? null;
}

// Observations retain every immutable check run for delivery analytics. Gates and the
// merge-queue ejection rule use only the newest trusted run for a required name; GitHub
// check-run IDs are immutable and increase as the provider creates retries. Array
// position is a fallback for legacy observations that predate run identity capture.
export function latestCheck(checks: Observation['checks']): Observation['checks'][number] | undefined {
  return checks.reduce<Observation['checks'][number] | undefined>((latest, check) => {
    if (!latest) return check;
    if (check.id !== undefined && latest.id !== undefined) return check.id > latest.id ? check : latest;
    if (check.id !== undefined) return check;
    if (latest.id !== undefined) return latest;
    return check;
  }, undefined);
}

/**
 * The violation an observed, unauthorized merge records when a two-party reconciliation of it was
 * refused; the engine writes it as `<prefix><decision id> refused: <reasons>`. Read here because
 * that refusal is the one exit a merged queue entry has (GY-94), and by master status.
 */
export const reconciliationRefusalPrefix = 'Reconciliation by decision ';
export function refusedReconciliation(work: Pick<Work, 'violations'>): { decision: string; violation: string } | null {
  const violation = work.violations.find(entry => entry.startsWith(reconciliationRefusalPrefix));
  return violation ? { decision: violation.slice(reconciliationRefusalPrefix.length).split(' ')[0], violation } : null;
}
/**
 * A queue entry whose pull request GitHub already merged while no execution authorized it can
 * never publish a speculative tip: the branch is closed, `bindSpeculativeTip` refuses a merged
 * candidate, and every entry behind it waits for a tip that will never come. It is not a
 * validation failure, so it never ejects on its own; it leaves when the item is delivered, or
 * when the two-party merge decision that could have reconciled it is refused — the recorded
 * refusal is the exit, and it delivers nothing.
 */
export function unpublishableEntry(work: Work): { sequence: number; mergeSha: string | null; refusal: { decision: string; violation: string } | null } | null {
  if (!work.queue || work.stage === 'done' || !work.observation?.merged) return null;
  return { sequence: work.queue.sequence, mergeSha: work.observation.mergeSha ?? null, refusal: refusedReconciliation(work) };
}
/**
 * Explicit, observed failure of a queued entry's speculative validation. Missing or pending
 * inputs keep an entry queued; only a reported adverse result removes it.
 */
export function ejectionReason(work: Work, ciAppIds: number[], all: Work[] = []): string | null {
  if (!work.queue || work.stage === 'done') return null;
  // A merged entry waits for its reconciliation, which delivers it and drops it from the order.
  // A refused reconciliation is a reported adverse conclusion about the entry itself (GY-94).
  if (work.observation?.merged) {
    const refusal = refusedReconciliation(work);
    return refusal ? `Pull request was merged without a valid merge execution and can never publish a speculative tip; reconciliation by decision ${refusal.decision} was refused, so the entry leaves the queue undelivered` : null;
  }
  if (!work.submission || work.reworkRequested) return 'Implementation returned to the worker for a new attempt';
  if (work.policyRevision !== work.queue.policyRevision) return `Policy revision changed from ${work.queue.policyRevision} to ${work.policyRevision} after this entry was queued`;
  if (work.blocker) return `Queued work was blocked: ${work.blocker}`;
  if (work.violations.length) return `Queued work has an open violation: ${work.violations[0]}`;
  const candidate = work.candidate, observation = work.observation;
  if (!candidate || !observation || observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha) return null;
  const tip = candidate.sha.slice(0, 12);
  if (observation.prState === 'closed') return 'Pull request was closed without merging';
  // The base this entry would land on holds work its head would delete, revert or rewrite: an
  // observed adverse conclusion about the tip, which only a new head can answer. It names every
  // file and the item that owns it; a file the observation could not compare ejects nothing.
  const regressions = queuedRegressions(work, observation, all);
  if (regressions.length) return `Landing speculative tip ${tip} on ${regressions[0].base.slice(0, 12)} would revert work outside its planned files: ${regressions.map(entry => entry.text).join('; ')}`;
  // Observations retain every run, including superseded ones; only the newest trusted run
  // for a required check decides, exactly as the test gate does, so a successful retry
  // never leaves an entry ejected by the failure it replaced.
  const check = work.policy.checks.find(name => {
    const run = latestCheck(observation.checks.filter(entry => entry.name === name && ciAppIds.includes(entry.appId)));
    return !!run && failedConclusions.has(run.result);
  });
  if (check) return `Required CI check ${check} did not pass on speculative tip ${tip}`;
  if (observation.reviews.some(review => review.sha === candidate.sha && review.state === 'CHANGES_REQUESTED')) return `Review requested changes on speculative tip ${tip}`;
  // Unresolved threads are the reviewer's inputs, not a reason to eject; only a branch that still
  // requires conversation resolution (protection drift) makes a merge GitHub cannot land.
  const threads = conversationProtectionRefusal(work);
  if (threads) return threads;
  // Evidence binds the tip exactly or carried across a Graphyard-authored tip; either way a
  // failure or a withdrawal of it is an adverse conclusion about this tip.
  const proof = work.evidence.find(item => item.trusted && item.result === 'fail' && evidenceBindsCandidate(work, item) && item.policyRevision === work.policyRevision);
  if (proof) return `Proof ${proof.proof} failed on speculative tip ${tip}`;
  // A withdrawn proof is an explicit adverse conclusion, not a missing one: the entry leaves the
  // queue instead of holding its position while everything behind it waits.
  const revoked = work.evidence.find(item => item.trusted && !!item.revocation && evidenceBindsCandidate(work, item) && item.policyRevision === work.policyRevision);
  if (revoked) return `Proof ${revoked.proof} was revoked on speculative tip ${tip}: ${revoked.revocation!.reason}`;
  return null;
}

/** The shas that are an item's own: its head, and the reviewed head under any tip or restore of it. */
export function ownHeads(work: Pick<Work, 'candidate' | 'queue' | 'baseRefresh'>): string[] {
  const shas = [work.candidate?.sha, work.queue?.speculation?.reviewedHead, work.baseRefresh?.restore?.own, work.baseRefresh?.from.sha];
  return [...new Set(shas.filter((sha): sha is string => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha)))];
}
/** The restore recorded for exactly the current head, pending or performed, or null. */
export function currentRestore(work: Pick<Work, 'candidate' | 'baseRefresh' | 'policyRevision'>): BaseRefresh | null {
  const refresh = work.baseRefresh, candidate = work.candidate;
  if (!refresh?.restore || !candidate || refresh.policyRevision !== work.policyRevision) return null;
  // Pending: the contaminated head is still the candidate. Performed: the candidate is what the restore produced.
  return refresh.restore.contaminated === candidate.sha || refresh.head === candidate.sha ? refresh : null;
}
/** A repair the coordinator requested for the current head that has not run yet. */
export function pendingRestore(work: Work): BranchRestore | null {
  const refresh = currentRestore(work);
  return refresh && refresh.head === null && !refresh.restore!.performedAt && refresh.restore!.contaminated === work.candidate!.sha ? refresh.restore! : null;
}
export interface Contamination {
  head: string;
  /** The items whose unlanded commits the head carries. */
  foreign: string[];
  /** `ejection`: the head is a tip the queue ejected, built behind entries that have not landed; `observation`: GitHub shows another open candidate in its history. */
  source: ('ejection' | 'observation')[];
  /** The item's own reviewed head under it, when the record names one. */
  own: string | null;
}
/**
 * Whether the current head carries another item's unlanded commits, from the record and from the
 * observation together. The record answers for a tip the queue ejected: it was built behind the
 * entries the prediction named, and any of them not yet delivered is unlanded content on this
 * branch. The observation answers for everything else: the landing check names every open
 * candidate found in the head's history. A live queue entry is never contaminated by this rule —
 * its tip holds its predecessors by construction and is rebuilt from its own head when they change.
 */
export function branchContamination(work: Work, all: Work[]): Contamination | null {
  const candidate = work.candidate, observation = work.observation;
  if (work.queue || !candidate || !observation || observation.candidate.sha !== candidate.sha || observation.merged || observation.prState === 'closed' || work.stage === 'done') return null;
  const source: Contamination['source'] = [];
  const predicted = [...(work.queueHistory ?? [])].reverse().find(entry => entry.event === 'predicted' && entry.tip === candidate.sha);
  const ejected = work.queueEjection?.sha === candidate.sha ? predicted : undefined;
  const unlanded = (ejected?.predecessors ?? []).filter(key => all.find(item => item.key === key)?.stage !== 'done');
  if (unlanded.length) source.push('ejection');
  const observed = (observation.landing?.foreign ?? []).map(entry => entry.key);
  if (observed.length) source.push('observation');
  if (!source.length) return null;
  return { head: candidate.sha, foreign: [...new Set([...unlanded, ...observed])], source, own: ejected?.from ?? null };
}
/**
 * The restore an ejection owes: the ejected tip is still the branch head and carries entries that
 * have not landed. Nothing is owed once a restore for that head is recorded, pending or performed.
 */
export function ejectedTipRestore(work: Work, all: Work[]): { contaminated: string; foreign: string[]; own: string | null; reason: string } | null {
  const ejection = work.queueEjection;
  if (!ejection || ejection.sha !== work.candidate?.sha || currentRestore(work)) return null;
  const contamination = branchContamination(work, all);
  if (!contamination) return null;
  return { contaminated: contamination.head, foreign: contamination.foreign, own: contamination.own, reason: `ejected from the merge queue: ${ejection.reason}` };
}

/** The reason `advanceQueue` ejects an entry whose speculative merge conflicts (github.ts SpeculativeConflict). */
export const speculativeConflictReason = /^Speculative merge of [0-9a-f]+ into .+ conflicts/;
/**
 * GY-321. The predecessors a speculative-merge conflict of exactly the current head was found
 * behind, or null when the ejection is anything else: another reason, another head or policy, or a
 * merge onto the base branch tip itself ([] recorded, or a record that predates the rule). Such a
 * conflict is with work that has not landed, which no sync with the base can resolve: GitHub's
 * merge queue and bors re-test the entry once the conflicting one resolves, and so does this one.
 */
export function predecessorConflict(work: Pick<Work, 'candidate' | 'queue' | 'queueEjection' | 'policyRevision'>): string[] | null {
  const ejection = work.queueEjection, candidate = work.candidate;
  if (work.queue || !ejection || !candidate || ejection.sha !== candidate.sha || ejection.policyRevision !== work.policyRevision) return null;
  if (!speculativeConflictReason.test(ejection.reason) || !ejection.predecessors?.length) return null;
  return ejection.predecessors;
}
/**
 * The predecessors a predecessor-conflict ejection still waits for: those named in it that are
 * still queued ahead of where the entry stood. One that landed, or left the queue (and any that
 * re-entered since, now behind it), no longer holds the conflict; once any has, the prediction the
 * entry conflicted with is gone and the same head re-enters at the back. Null when the ejection
 * is not a predecessor conflict; [] when it no longer waits.
 */
export function predecessorWait(work: Work, all: Work[]): string[] | null {
  const named = predecessorConflict(work);
  if (!named) return null;
  const sequence = work.queueEjection!.sequence;
  const queued = named.filter(key => {
    const item = all.find(entry => entry.key === key);
    return !!item && item.stage !== 'done' && !item.observation?.merged && !!item.queue && item.queue.sequence < sequence;
  });
  return queued.length === named.length ? queued : [];
}
/** The merge-gate reason for an entry that waits on its predecessors (see `predecessorWait`). */
export function predecessorWaitText(work: Work, waiting: string[]) {
  return `Waiting for ${waiting.join(', ')} to land or leave the merge queue: candidate ${work.candidate!.sha.slice(0, 12)} was ejected because its speculative merge behind ${waiting.length === 1 ? 'it' : 'them'} conflicts (${work.queueEjection!.reason}); no sync with the base resolves that, so the same head re-enters at the back of the queue once ${waiting.length === 1 ? 'it has' : 'any of them has'} landed or left`;
}
/** The predecessors a merge-gate reason names as waited on, or null for any other reason. */
export function predecessorWaitReason(reason: string): string[] | null {
  const match = reason.match(/^Waiting for (\S+(?:, \S+)*) to land or leave the merge queue: /);
  return match ? match[1].split(', ') : null;
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
  /** GitHub's MergeStateStatus for the pull request (CLEAN, BLOCKED, …); CLEAN or HAS_HOOKS without a queue is merged at once, head-bound. */
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
}
declare module './model/work.js' { interface Observation { githubQueue?: GitHubMergeQueueState | null } }

/** The coordinator's request that GitHub merge exactly this candidate: what `merge-acquire` with `enqueue` records. */
export interface MergeEnqueueRequest { sha: string; baseSha: string; policyRevision: number; requestedBy: string; at: string }

/**
 * Whether the item is authorized to merge right now: every gate passes, nothing stands against it,
 * and the recorded all-gates authorization binds exactly the current candidate at the current policy.
 * The same judgement the check publication makes, read from the record as it stands.
 */
export function mergeAuthorized(work: Work): boolean {
  const authorization = work.mergeAuthorization, candidate = work.candidate;
  return work.stage === 'merge' && !!candidate && !!authorization && !work.observation?.merged
    && work.gates.every(gate => gate.passed) && !work.violations.length && !work.leadHold
    && authorization.sha === candidate.sha && authorization.baseSha === candidate.baseSha && authorization.policyRevision === work.policyRevision;
}
/** Whether the coordinator's enqueue request binds the current candidate and policy. */
export function enqueueRequestCurrent(work: Work, request: Pick<MergeEnqueueRequest, 'sha' | 'baseSha' | 'policyRevision'> | null | undefined): boolean {
  return !!request && !!work.candidate && request.sha === work.candidate.sha && request.baseSha === work.candidate.baseSha && request.policyRevision === work.policyRevision;
}
export type MergeQueueAction =
  | { kind: 'enqueue'; reason: string }
  | { kind: 'dequeue'; reason: string }
  | { kind: 'hold'; reason: string };
/**
 * What the control plane does with GitHub's queue for one item, decided from the record and one
 * read of GitHub. Enqueue only an authorized, requested candidate whose head GitHub still holds;
 * dequeue anything GitHub holds for merging that is not exactly that. Everything else holds.
 */
/** Whether GitHub merges the pull request at once (CLEAN, HAS_HOOKS) and so refuses to enable auto-merge on it ("Pull request is in clean status"). */
export const mergeableNow = (state: Pick<GitHubMergeQueueState, 'mergeStateStatus'>) => state.mergeStateStatus === 'CLEAN' || state.mergeStateStatus === 'HAS_HOOKS';
export function mergeQueueAction(work: Work, state: GitHubMergeQueueState, request: MergeEnqueueRequest | null): MergeQueueAction {
  const held = state.mode !== 'none';
  const sha = work.candidate?.sha;
  const withdrawn = !mergeAuthorized(work) ? `${work.key} is no longer authorized to merge: ${[...work.gates.flatMap(gate => gate.reasons), ...work.violations].join('; ') || 'no all-gates authorization binds the current candidate'}`
    : !enqueueRequestCurrent(work, request) ? `${work.key}: no merge was requested for candidate ${sha?.slice(0, 12)} at policy revision ${work.policyRevision}`
      : state.head !== sha ? `${work.key}: GitHub holds head ${state.head.slice(0, 12)}, not the authorized candidate ${sha?.slice(0, 12)}`
        : null;
  if (withdrawn) return held ? { kind: 'dequeue', reason: withdrawn } : { kind: 'hold', reason: withdrawn };
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
