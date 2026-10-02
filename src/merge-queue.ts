import type { Evidence, Observation, ScopeFile, Work } from './model.js';
import { CHECK_NAME } from './model/work.js';
import { carriedApproval, type ApprovalIdentity, type CarriedApproval, type CarriedProof, type QueueCarry, type RequiredApproval, type TipMerge } from './model/carry.js';
import { exactApproval, reviewProviderOf } from './model/review.js';
import { pathScopesOverlap } from './model/scope.js';
import { evaluateLandability, landabilityEjection, type LandabilityAudit, type LandabilityVerdict } from './model/landability.js';
import { missingAncestryReason, missingBaseAncestry } from './merge-base-ancestry.js';
import { ciCheckName } from './model/ci-refusal.js';
import { attributeDocsOverflow, docsBudgetProof, docsOverflowReason, docsTotal, type DocsWordBudget, type DocsWordCount } from './model/documentation.js';

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
  /**
   * An approval of the tip this publication replaced, read from the pull request's current reviews
   * immediately before the new tip was force-pushed (GY-519): the item's stored observation can
   * predate the approval, and republishing without reading it would drop a review of the patch
   * being republished. The carry decided at publication carries it exactly as an observed approval.
   */
  observedApproval?: ObservedApproval | null;
  /** Why the tip was built (GY-375): the queue head is the one candidate brought onto the base unasked. */
  trigger?: 'queue-head';
}
/** An approval GitHub held at one moment, as the publisher read it: the reviewer, its id and the head it approved. */
export interface ObservedApproval { reviewer: string; reviewId?: number; sha: string }
/**
 * A `head_ref_force_pushed` event on the pull request's timeline (GY-519): who pushed, when, and
 * between which commits. `byApp` is true only when GitHub named the control-plane App's own bot
 * identity as the actor — the fact that separates a republication the control plane made itself
 * from a push by anyone else.
 */
export interface HeadForcePush { at: string | null; by: string | null; byApp: boolean; before: string | null; after: string | null }
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
declare module './model/work.js' { interface Observation { conversations?: ConversationResolution; headForcePushes?: HeadForcePush[] } }

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

export interface QueueEntry {
  sequence: number; enqueuedAt: string; policyRevision: number; speculation: QueueSpeculation | null;
  /**
   * The batch this entry is validated in (GY-330), re-derived on every evaluation from the queue
   * and the control plane's batch size: the gates read it to merge on the batch's combined tip and
   * to eject only the member a bisection isolates, and status and the dashboard show it.
   */
  batch?: MergeBatchView | null;
  /**
   * The parallel tips this entry merges behind (GY-498): the window positions 1..position+1, each
   * with what it holds and what CI said about it. Present only under a parallel-tip window, and
   * only on an entry inside it; `tipValidation` reads it instead of the batch's combined tip.
   */
  tips?: TipView[] | null;
  /**
   * When the entry's head batch last sat in 'testing' with no published tip (GY-506): the timer
   * the dissolution waits on. Kept on the head member's entry, dropped when the state passes.
   */
  batchStall?: { since: string } | null;
  /**
   * The dissolved stuck batch (GY-506): its members validate as single-entry batches in their
   * existing order until one of them leaves the queue, which ends the dissolution and lets the
   * ordinary batch plan resume. Recorded on the head member's entry with the queue history.
   */
  batchDissolved?: { at: string; members: string[] } | null;
}
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
 * refusals for the tip; only the CI-pending ones (`ciPendingReason`) are the tip's validation, and
 * the caller lifts only those from the test gate.
 */
export const tipValidationPrefix = 'Merge queue is validating speculative tip ';
/**
 * With batching (GY-330), CI is required on the batch's combined tip, not on every member's own:
 * a member the batch plan merges — a combined tip holding it passed every required check — is
 * validated by that tip and its own tip's CI is not waited for, and a member still being validated
 * names the combined tip under test; a batch behind the head requires nothing until it heads the
 * queue. `[]` means nothing is required now: the test gate stands and the merge gate adds nothing.
 */
export function tipValidation(work: Pick<Work, 'key' | 'candidate' | 'policyRevision'>, queue: QueueEntry | null, testReasons: string[]): string[] | null {
  const speculation = queue?.speculation, candidate = work.candidate;
  if (!speculation || !candidate || speculation.tip !== candidate.sha || speculation.base !== candidate.baseSha || speculation.policyRevision !== work.policyRevision) return null;
  // Only a CI-pending refusal is the tip's validation (GY-332): any other test-gate refusal is the
  // candidate's own and is never relabelled as queue progress, whatever the tip's state.
  const pending = testReasons.filter(ciPendingReason);
  // Parallel tips (GY-498): the entry is validated by the window of tips it merges behind, each
  // judged on its own observation. Every tip ahead of it passed and its own tip is the only one
  // still unjudged: today's wording, naming its tip. Any earlier tip unjudged is named too, so CI
  // runs on every tip of the window at once; an earlier failing tip is the queue resolving an
  // inherited failure, which this entry waits out instead of being ejected for.
  const tips = queue?.tips;
  if (tips?.length) {
    // A tip that is not published is not being validated: the placement's own reason says the
    // predicted tip has not been published, and naming nothing here keeps that refusal standing.
    const failing = tips.find(tip => tip.ci === 'fail' && tip.tip);
    // Its own tip failed: attributed once every tip ahead passed; until then the tips ahead are
    // still being validated and name themselves, since a failure among them would be inherited.
    const ahead = tips.slice(0, -1).filter(tip => tip.ci !== 'pass' && tip.tip);
    if (failing && failing === tips.at(-1) && ahead.length) return ahead.map(tip => `${tipValidationPrefix}${tip.tip?.slice(0, 12)}: speculative tip ${failing.tip?.slice(0, 12)} of ${work.key} failed ${failing.failedCheck}, and is attributed to it only once the tips ahead pass`);
    if (failing && failing === tips.at(-1)) return pending.map(reason => `${tipValidationPrefix}${failing.tip?.slice(0, 12)}: ${reason}`);
    if (failing) return [`Waiting for speculative tip ${failing.tip?.slice(0, 12)} to resolve: Required CI check ${failing.failedCheck} failed on it and ${work.key} is not the cause; its tip holds the same change and is rebuilt once the entry that caused it leaves the queue`];
    const unjudged = tips.filter(tip => tip.ci !== 'pass' && tip.tip);
    if (!unjudged.length) return null;
    if (unjudged.length === 1 && unjudged[0] === tips.at(-1) && pending.length) return pending.map(reason => `${tipValidationPrefix}${unjudged[0].tip?.slice(0, 12)}: ${reason}`);
    return unjudged.map(tip => `${tipValidationPrefix}${tip.tip?.slice(0, 12)}: the tips ahead of ${work.key}'s are still being validated`);
  }
  const batch = queue?.batch;
  // A batch behind the head waits its turn: no CI is required of it until it heads the queue, and
  // its queue position already holds the merge. A member the plan merges is validated, and while
  // the plan merges or ejects others ahead of it, or waits for the tip it would test to be
  // published, nothing is required of it until it is replanned: its placement holds the merge.
  if (batch && (batch.state === 'waiting' || !batch.underTest?.tip)) return [];
  if (!pending.length) return null;
  const under = batch?.underTest?.tip ?? candidate.sha;
  return pending.map(reason => `${tipValidationPrefix}${under.slice(0, 12)}: ${reason}`);
}
/**
 * The one test-gate refusal the tip's own validation accounts for: a required CI check that has not
 * yet passed on the candidate (GY-332). Any other test-gate refusal is the candidate's own and
 * stays on the test gate, never relabelled as queue progress.
 */
export const ciPendingReason = (reason: string) => ciCheckName(reason) !== null;
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
    : { ...input.approval, carried: true, originalSha: input.approval.sha, reason: `approval of ${shortSha(input.approval.sha)} by ${input.approval.reviewer}${input.approval.reviewId !== undefined ? ` (review ${input.approval.reviewId})` : ''} carried to ${tip}: ${who} changed none of the ${input.reviewedFiles.length} reviewed files` };
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
  /**
   * GY-252. Whether the ejection was a speculative-merge conflict (github.ts SpeculativeConflict),
   * recorded as a typed fact rather than read back from `reason`: `{ base }` names the tip the
   * conflicting merge was attempted onto (the predicted base, null when no prediction was held),
   * null marks any other ejection. Absent only on records that predate the field, which
   * `speculativeConflict` still reads from their reason.
   */
  conflict?: { base: string | null } | null;
  /**
   * GY-878. Whether the ejection was a landability refusal: a reason the landability verdict gives
   * (landability.ts `eject`). Such an entry re-enters on the same head once the verdict is landable
   * again; null keeps any other ejection's same-head stickiness. Absent only on records that
   * predate the field, which `landabilityFamily` reads from their reason.
   */
  family?: 'landability' | null;
  /** GY-878: the verdict version and inputs behind a landability ejection, for the audit trail. */
  verdict?: LandabilityAudit;
  /**
   * GY-1095. For an ejection because a required CI check failed: the check, the failed run, the tip
   * it failed on, and the queue entry's speculation as it stood, so a passing rerun of that check on
   * the same tip lifts the ejection and the entry re-enters at its place (`ejectedCheckLift`). Null
   * or absent on any other ejection.
   */
  check?: { name: string; runId: number | null; tip: string; speculation: QueueSpeculation | null } | null;
}
export interface QueueHistoryEntry {
  at: string; event: 'enqueued' | 'predicted' | 'ejected' | 'dissolved' | 'lifted'; sequence: number; reason?: string; tip?: string;
  /** For a lifted ejection (GY-1095): the check whose rerun passed on the same tip, and that run. */
  check?: string; runId?: number | null;
  /** For a prediction: the entries the tip was published behind, and the item's own reviewed head it was built from. For a speculative-conflict ejection: the entries the conflicting merge was predicted behind (GY-321). */
  predecessors?: string[]; from?: string;
  /** For a landability ejection (GY-878): the verdict version and inputs it was refused by. */
  verdict?: LandabilityAudit;
  /** For an ejection: the ejection's typed conflict record (`QueueEjection.conflict`), so the audit trail tells a conflict from any other ejection without reading `reason` (GY-583). Absent on other events and on entries that predate the field. */
  conflict?: { base: string | null } | null;
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
  at: string | null; by: string | null;
  /** The actor was the control-plane App's own bot identity (GY-519); absent on records that predate the field. */
  byApp?: boolean;
  unread?: string;
}
/**
 * The record of an approval the control plane restored after GitHub dismissed it for a merge-base
 * change (GY-127 unchanged head, GY-519 replaced tip). `sha` is the tip the restored binding binds;
 * `originalSha` names the tip the approval was actually given on when a republication had replaced
 * it — the approval id, the approved tip and the carried-to tip are what the record must show.
 */
export interface RestoredApproval { reviewer: string; reviewId?: number; sha: string; originalSha?: string; dismissal: ReviewDismissal; at: string }
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
 * the binding one. Two shapes:
 *
 * - An approval of exactly the current head: the head the reviewer approved is the head the branch
 *   still has, so nothing the reviewer judged has changed (GY-127).
 * - An approval of a tip the control plane itself replaced (GY-519): the head sha changed, but the
 *   reviewer judged the same patch. The dismissal must be GitHub's own merge-base dismissal, and
 *   both the dismissal and the `head_ref_force_pushed` event that caused it must be the
 *   control-plane App's; the approved tip must be one the queue itself published from the same
 *   author head the current tip was built from, with the patch-id it was approved under unchanged.
 *   Anything else — the author head moved, the patch changed, a person dismissed, a person pushed —
 *   restores nothing.
 *
 * A dismissal is distinguished from a withdrawn verdict by the recorded reason and the recorded
 * verdict, never inferred from timing: the reason must be GitHub's exact merge-base message, and
 * the dismissed review must have been an approval — a dismissed change request is a change request
 * the reviewer gave and never an approval, whatever message its dismissal carried. Only a formal
 * GitHub approval from someone other than the author qualifies — the same identity rule
 * `exactApproval` applies, baseline included. The engine restores such an approval as the binding
 * one (see `Engine.observe`) so no review round and no attempt is spent on a commit the reviewer
 * already approved; the reviewer App re-posts it before the merge. `originalSha` names the tip the
 * approval was given on when a republication replaced it.
 */
export function dismissedApproval(work: Work): { reviewer: string; reviewId?: number; sha: string; originalSha?: string; dismissal: ReviewDismissal } | null {
  const candidate = work.candidate, observation = work.observation;
  if (!candidate || !observation || observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha || observation.merged) return null;
  if (!work.policy.review || reviewProviderOf(work.policy) !== 'github') return null;
  const baseline = work.formalReviewBaseline;
  for (const review of observation.reviews) {
    if (review.state !== 'DISMISSED' || review.reviewer === candidate.author) continue;
    const dismissal = reviewDismissal(review);
    if (!dismissal?.mergeBase || dismissal.verdict !== 'approved') continue;
    if (work.formalReviewResetRequired && !(baseline?.pr === candidate.pr && baseline.policyRevision === work.policyRevision && Number.isSafeInteger(review.id) && review.id! > 0 && !baseline.reviewIds.includes(review.id!))) continue;
    if (review.sha === candidate.sha) return { reviewer: review.reviewer, ...(review.id !== undefined ? { reviewId: review.id } : {}), sha: candidate.sha, dismissal };
    const replaced = appDismissed(dismissal) && replacedTipDismissal(work, review.sha, candidate.sha);
    if (replaced) return { reviewer: review.reviewer, ...(review.id !== undefined ? { reviewId: review.id } : {}), sha: candidate.sha, originalSha: review.sha, dismissal };
  }
  return null;
}
/**
 * Whether a dismissal of an approval of `approvedSha` was the control plane's own republication of
 * that tip as `candidateSha` (GY-519): the queue published the approved tip from the author head
 * the current tip is built from, the current tip's carry shows the patch-id unchanged since that
 * author head, and the App's own force-pushes lead from the approved tip to the current one.
 */
function replacedTipDismissal(work: Work, approvedSha: string, candidateSha: string): boolean {
  const speculation = work.queue?.speculation;
  if (!speculation || speculation.tip !== candidateSha || speculation.policyRevision !== work.policyRevision) return false;
  const authorHead = speculation.reviewedHead ?? speculation.merge?.from ?? null;
  if (!authorHead || speculation.carry?.ground?.rule !== 'diff unchanged') return false;
  // The approved tip was this queue's own publication from that same author head, or the author
  // head itself — either way the reviewer judged exactly the patch the current tip re-shows.
  const published = approvedSha === authorHead
    || (work.queueHistory ?? []).some(entry => entry.event === 'predicted' && entry.tip === approvedSha && entry.from === authorHead);
  if (!published) return false;
  // The App's own pushes must lead from the approved tip to the current head; one push by anyone
  // else along the way breaks the chain.
  const pushes = (work.observation?.headForcePushes ?? []).filter(entry => entry.byApp && /^[a-f0-9]{40}$/.test(entry.before ?? '') && /^[a-f0-9]{40}$/.test(entry.after ?? ''));
  const reaches = (from: string, to: string, fuel: number): boolean =>
    from === to || fuel > 0 && pushes.some(entry => entry.before === from && reaches(entry.after!, to, fuel - 1));
  return reaches(approvedSha, candidateSha, pushes.length + 1);
}
/** Whether a recorded dismissal names the control-plane App as its actor; records that predate the attribution restore nothing across a head change. */
export const appDismissed = (dismissal: ReviewDismissal): boolean => dismissal.byApp === true;
/** The restored approval that binds the current candidate, for status and the merge broker's re-post; null when none does. */
export function restoredApproval(work: Pick<Work, 'candidate' | 'queue' | 'baseRefresh' | 'policyRevision'>): RestoredApproval | null {
  const candidate = work.candidate;
  if (!candidate) return null;
  const speculation = work.queue?.speculation;
  if (speculation?.tip === candidate.sha && speculation.policyRevision === work.policyRevision && speculation.restoredApproval?.sha === candidate.sha) return speculation.restoredApproval;
  const refresh = work.baseRefresh;
  return refresh?.head === candidate.sha && refresh.policyRevision === work.policyRevision && refresh.restoredApproval?.sha === candidate.sha ? refresh.restoredApproval : null;
}
/**
 * The approval of exactly `sha` in a pull request's current reviews, as the publisher reads them
 * immediately before force-pushing a new tip over it (GY-519), under the identity rule
 * `exactApproval` applies: a formal GitHub approval by
 * someone other than the author, after the requirement-review baseline when one is set. The last
 * matching review wins, so the identity names the verdict GitHub currently holds. Null when the
 * list shows none — never a guess from an earlier head's reviews.
 */
export function approvalOfHead(reviews: unknown[], sha: string, author: string | null, pr: number, work: Pick<Work, 'formalReviewResetRequired' | 'formalReviewBaseline' | 'policyRevision'>): ObservedApproval | null {
  let found: ObservedApproval | null = null;
  for (const row of reviews as { state?: unknown; commit_id?: unknown; user?: { login?: unknown }; id?: unknown }[]) {
    if (row?.state !== 'APPROVED' || row.commit_id !== sha) continue;
    const reviewer = typeof row.user?.login === 'string' ? row.user.login : null;
    const id = Number.isSafeInteger(row.id) ? row.id as number : null;
    if (!reviewer || reviewer === author) continue;
    if (work.formalReviewResetRequired) {
      const baseline = work.formalReviewBaseline;
      if (!(baseline?.pr === pr && baseline.policyRevision === work.policyRevision && id !== null && id > 0 && !baseline.reviewIds.includes(id))) continue;
    }
    found = { reviewer, ...(id !== null ? { reviewId: id } : {}), sha };
  }
  return found;
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
 * The observation with its conflict disproved by `stale` (GY-375): it reads mergeable and not
 * conflicting, and GitHub's raw reading is kept beside that under `disproved` (GY-390).
 */
export function withDisprovedConflict<T extends Pick<Observation, 'mergeable' | 'conflicting' | 'disproved'>>(observation: T, stale: StaleMergeability): T {
  return { ...observation, mergeable: true, conflicting: false, disproved: { mergeable: observation.mergeable, conflicting: !!observation.conflicting, reading: stale.reading } };
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
  /**
   * `restored`: GitHub shows the branch at `own` merged onto the base tip read at the restore;
   * `conflict`: it holds `own`, and the merge is the worker's; `unrepairable`: no own head could be
   * found under the foreign commits; `unpublished`: GitHub does not show the branch at the commit
   * the restore produced, and `failure` says what it shows or what refused the write (GY-854).
   */
  outcome: 'restored' | 'conflict' | 'unrepairable' | 'unpublished' | null;
  /**
   * Why the restore is not recorded done, on a `conflict` or `unpublished` one (GY-854): the
   * conflict itself, or what GitHub showed (or refused) instead of the restored commit. Absent on
   * records that predate the field and on every other outcome.
   */
  failure?: string | null;
  /**
   * The stable category of `failure` (GY-854): what a repeat is judged by, never the diagnostic
   * string, whose commits move with the base tip and the produced head between attempts. Absent
   * on records that predate the field and on every other outcome.
   */
  failureKind?: RestoreFailureKind | null;
  /** How many times the restore has run for this contaminated head; absent on records that predate the count. */
  attempts?: number;
  /**
   * Set when a restore failed twice without the item's candidate changing (GY-854), whatever
   * the kinds of the two failures: the reason it stops repeating, which `master status` names.
   * Null while the first failure stands or a retry published its result.
   */
  escalated?: string | null;
}
/** What kind of refusal or shortfall a restore's `failure` records, stable across attempts. */
export type RestoreFailureKind = 'branch reset refused' | 'merge refused' | 'read-back failed' | 'read-back mismatch' | 'conflict';

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
  // a refresh that says nothing of them (GY-127). A restore that could not publish its result is
  // likewise held: its retry rebuilds the reviewed head onto the tip read afresh, and a refresh
  // of the contaminated head would only build a new tip on the foreign commits (GY-854).
  const restore = currentRestore(work)?.restore;
  if (restore && restore.contaminated === candidate.sha && (restore.performedAt === null || restore.outcome === 'unrepairable' || restore.outcome === 'unpublished')) return null;
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
 * - `files`: the head's changes since its merge base with the landing commit, each outside the
 *   planned scope judged by the three-way merge result of the head onto that commit (GY-863):
 *   a branch carrying an earlier version of a change the commit has since extended merges to
 *   exactly what the commit holds, so it is not a revert; a head that restores the merge-base
 *   version over the commit's still is. Files only the base changed are inherited by a
 *   three-way merge, not reverted. Recomputed on every observation, including unchanged heads
 *   previously refused. Present when the landing tree differs from the bound base, or a
 *   predicted base needs its own diff.
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
export const failedConclusions = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale', 'neutral']);

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
    // A failed check awaiting its one rerun (GY-516) holds this position; master status says so.
    if (current) reasons.push(...pendingCheckReruns(work).map(line => `${tipValidationPrefix}${line}`));
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
  return /^(Merge queue position \d+ of \d+: |Speculative tip on predicted base [0-9a-f]+ has not been published|Waiting for \S+ to publish its speculative tip$|Merge queue is validating speculative tip [0-9a-f]+: |Waiting for speculative tip [0-9a-f]+ to resolve: )/.test(reason) || !!predecessorWaitReason(reason);
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

/** The conclusions of a run that failed, as the failed-CI rework rule reads them. */
export const failedCheckResults: readonly string[] = ['failure', 'timed_out', 'action_required', 'cancelled', 'startup_failure'];
/** One check a candidate must pass: a policy check, or one only the base branch's protection or rulesets require. */
export interface RequiredCheck { name: string; policy: boolean; appId: number | null }
/**
 * GY-430. The checks a candidate must pass: the policy's, then every check the base branch's
 * protection or active rulesets require that the policy does not name (the observation records
 * them, never `Graphyard / merge`). GitHub refuses the merge while any of them has not passed, so a
 * failing protection-only check — PR #221's `secrets` scan — is judged exactly as a policy check is.
 */
export function requiredChecksOf(work: Pick<Work, 'policy' | 'observation'>): RequiredCheck[] {
  const names = work.policy?.checks ?? [];
  const policy = names.map(name => ({ name, policy: true, appId: null }));
  const extra = (work.observation?.requiredChecks ?? []).filter(check => check.name !== CHECK_NAME && !names.includes(check.name))
    .map(check => ({ name: check.name, policy: false, appId: check.appId }));
  return [...policy, ...extra];
}
/**
 * The newest run that counts for a required check: a policy check's from the configured CI apps,
 * as ever; a protection-only check's from the app protection binds it to. One bound to no app is
 * satisfied on GitHub by any source's run or commit status of that name; Graphyard prefers the
 * configured CI apps' runs whenever one reports it (GY-1060), so another app with checks:write can
 * neither pass it nor fail it beside CI, and reads any other source only when no CI app reports it.
 */
export function requiredCheckRun(check: RequiredCheck, checks: Observation['checks'], ciAppIds: readonly number[] | null): Observation['checks'][number] | undefined {
  const named = checks.filter(run => run.name === check.name);
  if (check.policy) return latestCheck(named.filter(run => !ciAppIds || ciAppIds.includes(run.appId)));
  if (check.appId !== null) return latestCheck(named.filter(run => run.appId === check.appId));
  const trusted = ciAppIds ? named.filter(run => ciAppIds.includes(run.appId)) : [];
  return latestCheck(trusted.length ? trusted : named);
}
/** Whether a counting run failed: a policy check by the queue's conclusions, as ever; a protection-only one by the failed-CI rework rule's (GY-430). */
export function requiredRunFailed(check: RequiredCheck, run: Observation['checks'][number] | undefined): boolean {
  return !!run && (check.policy ? failedConclusions.has(run.result) : failedCheckResults.includes(run.result));
}
/** The test gate's trusted CI apps as last recorded on the item; legacy snapshots use the engine's historical GitHub Actions default. */
export const ciAppIdsOf = (work: Pick<Work, 'gates'>): readonly number[] => work.gates.find(gate => gate.name === 'test')?.ciAppIds ?? [15368];
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
 * GY-831. The guarded merge's refusal the loop reported for one candidate: a carried approval it
 * could not re-post, or one reason repeated past the loop's bound. `rereview` cleared the carried
 * approval so the review gate asks for a fresh review of the tip; `rework` asks the approver for
 * the rework decision, since nothing the control plane holds re-binds it. `approval` names the
 * review that could not be re-posted; `carry` keeps the decision that applied to the candidate,
 * approval re-required, because the queue ejection the refusal causes drops the tip's record and
 * its carried proofs must still bind.
 */
export interface MergeRefusal {
  sha: string; baseSha: string; policyRevision: number; reason: string; since: string; at: string; by: string; action: 'rereview' | 'rework';
  approval?: { reviewer: string; reviewId?: number; originalSha: string }; carry?: QueueCarry | null;
}
/** The ejection reason of an entry the guarded merge kept refusing (GY-831); re-entry reads it back. */
export const mergeRefusalEjectionPrefix = 'The guarded merge refused candidate ';
/**
 * GY-831. The merge refusal the control plane recorded for exactly the current candidate, while it
 * still stands, worded as the queue ejection it causes: a head the guarded merge cannot land must
 * not hold every entry behind it. A `rereview` refusal stands until a fresh approval binds the
 * candidate again, and the entry may then re-enter; a `rework` one stands for the candidate's life.
 */
export function standingMergeRefusal(work: Work): string | null {
  const refusal = work.mergeRefusal, candidate = work.candidate;
  if (!refusal || !candidate || refusal.sha !== candidate.sha || refusal.baseSha !== candidate.baseSha || refusal.policyRevision !== work.policyRevision) return null;
  if (refusal.action === 'rereview' && (exactApproval(work) || carriedApproval(work))) return null;
  return `${mergeRefusalEjectionPrefix}${candidate.sha.slice(0, 12)} since ${refusal.since}: ${refusal.reason.slice(0, 600)}; ${refusal.action === 'rereview' ? 'a fresh review of it is requested' : 'it awaits a rework decision'}, and the entry leaves the queue so the next one heads it`;
}
/**
 * The first required check whose newest counted run failed on the observed current candidate and
 * is not held by its one rerun (GY-516), with that run: the check a CI ejection is made for. The
 * policy's and the base branch's other required checks alike, so ejection, the batch verdict and
 * the parallel-tip window read one answer (GY-1060).
 */
export function ejectingCheck(work: Work, ciAppIds: readonly number[] | null): { name: string; run: Observation['checks'][number] } | null {
  const candidate = work.candidate, observation = work.observation;
  if (!candidate || !observation || observation.candidate.sha !== candidate.sha) return null;
  for (const required of requiredChecksOf(work)) {
    const run = requiredCheckRun(required, observation.checks ?? [], ciAppIds);
    if (requiredRunFailed(required, run) && !holdingCheckRerun(work, candidate.sha, required.name, run)) return { name: required.name, run: run! };
  }
  return null;
}
/** The reason prefix of an ejection for `check` failing, as `ejectionReason` words it. */
export const failedCheckEjectionPrefix = (check: string) => `Required CI check ${check} did not pass on speculative tip `;
/**
 * GY-1095. The passing rerun that lifts a standing CI ejection: the ejection was made for required
 * check C failing on tip T, T is still the observed candidate, the newest counted run of C on T is a
 * rerun after the failed one and passes, and no other required check's newest run on T failed. The entry then re-enters at its
 * place, with the speculation it held, and no new candidate is needed. Null when the ejection
 * stands: another kind of ejection, a changed tip or policy, a rerun that failed again or has not
 * concluded, another failing required check, or a tip built behind an entry that left the queue
 * without landing (that tip carries its unlanded commits and is restored first).
 */
export function ejectedCheckLift(work: Work, all: Work[], ciAppIds: readonly number[]): { check: string; run: Observation['checks'][number]; tip: string; reason: string } | null {
  const ejection = work.queueEjection, candidate = work.candidate, observation = work.observation;
  const failed = ejection?.check;
  if (work.queue || !ejection || !failed || !candidate || !observation || work.stage === 'done' || observation.merged || observation.prState === 'closed') return null;
  if (ejection.sha !== candidate.sha || failed.tip !== candidate.sha || ejection.policyRevision !== work.policyRevision) return null;
  if (observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha) return null;
  const required = requiredChecksOf(work);
  const check = required.find(entry => entry.name === failed.name);
  if (!check) return null;
  const run = requiredCheckRun(check, observation.checks, ciAppIds);
  if (!requiredCheckPassed(check, run)) return null;
  // Only a rerun lifts: a run GitHub created after the failed one (check-run ids increase), or for a
  // run recorded without an id, one observed after a failed run of the check that is still retained.
  const rerun = failed.runId !== null ? run!.id !== undefined && run!.id > failed.runId
    : observation.checks.slice(0, observation.checks.indexOf(run!)).some(entry => entry.name === check.name && failedCheckResults.includes(entry.result));
  if (!rerun) return null;
  if (required.some(entry => requiredRunFailed(entry, requiredCheckRun(entry, observation.checks, ciAppIds)))) return null;
  const predicted = [...(work.queueHistory ?? [])].reverse().find(entry => entry.event === 'predicted' && entry.tip === candidate.sha);
  const departed = (predicted?.predecessors ?? []).some(key => { const item = all.find(entry => entry.key === key); return !item || (item.stage !== 'done' && !item.queue); });
  if (departed) return null;
  const tip = candidate.sha.slice(0, 12);
  return { check: check.name, run: run!, tip: candidate.sha, reason: `ejection lifted: check ${check.name} passed on rerun${run!.id !== undefined ? ` (run ${run!.id})` : ''} on speculative tip ${tip}${failed.runId !== null ? `, replacing failed run ${failed.runId}` : ''}` };
}
/**
 * Explicit, observed failure of a queued entry's speculative validation. Missing or pending
 * inputs keep an entry queued; only a reported adverse result removes it.
 */
export function ejectionReason(work: Work, ciAppIds: number[], all: Work[] = [], batch: MergeBatchView | null = null, window: TipWindowView | null = null, now: Date = new Date(), landability?: LandabilityVerdict): string | null {
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
  const refused = standingMergeRefusal(work);
  if (refused) return refused;
  const candidate = work.candidate, observation = work.observation;
  if (!candidate || !observation || observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha) return null;
  const tip = candidate.sha.slice(0, 12);
  if (observation.prState === 'closed') return 'Pull request was closed without merging';
  // Landability is one verdict (GY-878, model/landability.ts): the entry leaves the queue on
  // landability grounds only for a reason that verdict gives. Its build family carries the landing
  // guard's conclusion about the tip: a tip still built behind an entry that left without landing
  // (GY-568) whose tree shows a refused conclusion leaves for its branch restore, and otherwise
  // the base this entry would land on holding work its head would delete, revert or rewrite is an
  // observed adverse conclusion only a new head can answer. A file the observation could not
  // compare ejects nothing, and a file carried from another item's commits on this head is excused
  // exactly as the build gate excuses it (GY-871): nothing that passed build is ejected over it.
  const verdict = landability ?? evaluateLandability(work, all, now);
  const landing = landabilityEjection(verdict, 'landing');
  if (landing) return landing;
  // Observations retain every run, including superseded ones; only the newest trusted run
  // for a required check decides, exactly as the test gate does, so a successful retry
  // never leaves an entry ejected by the failure it replaced — nor one its rerun (GY-516)
  // holds. GY-430: this includes both policy checks and branch-protection required checks.
  const check = ejectingCheck(work, ciAppIds)?.name;
  // Under a parallel-tip window (GY-498) the prefix tips isolate the culprit in one round instead
  // of a bisection. Outside the window nothing is required of the entry yet, and a failure on a
  // tip it still holds is inherited from the entries ahead (the waiting batch's rule); a head that
  // is not its published tip holds no other entry and fails on its own. Inside the window, the
  // entry is ejected when its own tip is the FIRST failing one — the tip ahead of it passed, so
  // the failure is what this entry's change added. An earlier failing tip, or a published tip
  // whose prediction moved on (a predecessor landed or left; the tip is rebuilt there before it is
  // judged again), means the failure is inherited: the entry stays queued.
  // A batch member's tip holds every member ahead of it, so a failure there is not yet its own
  // (GY-330): it is ejected only when the batch plan isolates it — its tip fails on a prefix known
  // to pass, or on the base — and otherwise stays queued while the bisection runs.
  const speculation = work.queue.speculation;
  const publishedTip = speculation?.tip === candidate!.sha && speculation.base === candidate!.baseSha;
  if (check && window) {
    if (!window.tips.length) return publishedTip ? null : `Required CI check ${check} did not pass on speculative tip ${tip}`;
    const own = window.own;
    if (!own?.tip && publishedTip) return null;
    if (own && own.tip === candidate!.sha && window.firstFailure && window.firstFailure !== own) return null;
    // Its own tip failing is attributed to it only once every tip ahead is a known pass (GY-471):
    // a tip ahead still running may yet fail on the same change, and the failure is then inherited.
    if (own && own.tip === candidate!.sha && !aheadPassed(window)) return null;
    // A tip whose only failure is the docs word budget names the crossing entry, not this one (GY-574):
    // the first tip whose running total exceeds the budget belongs to the entry whose docs change
    // crossed it, and the refusal names the words over and the pages that grew. When the counts
    // name an earlier entry — one whose own tip already validated — or name nothing readable, the
    // plain reason stands and the first-failing-tip entry is ejected as any failure ejects.
    const failingDocs = own && own.tip === candidate!.sha && window.firstFailure === own
      ? (() => { const byKey = new Map(all.map(entry => [entry.key, entry])); const docs = byKey.get(own.entries.at(-1)!)?.observation?.docsBudget; return docs && own.tip && docs.sha === own.tip ? docs : undefined; })()
      : undefined;
    if (failingDocs?.onlyFailure && failingDocs.budget && docsTotal(failingDocs.pages) > failingDocs.budget.total) {
      const byKey = new Map(all.map(entry => [entry.key, entry]));
      const tipDocsOf = (view: TipView) => { const docs = byKey.get(view.entries.at(-1)!)?.observation?.docsBudget; return docs && view.tip && docs.sha === view.tip ? docs : undefined; };
      // Only a failing tip is counted, so a prefix's count is its own record or the base the next
      // tip's record carries — the commit that tip was built on is exactly what the prefix holds.
      const overflow = attributeDocsOverflow(tipDocsOf(window.tips[0])?.base,
        window.tips.map((view, index) => ({ key: view.entries.at(-1)!, count: tipDocsOf(view)?.pages ?? tipDocsOf(window.tips[index + 1])?.base })), failingDocs.budget);
      if (overflow && overflow.member === work.key) return `Required CI check ${check} did not pass on speculative tip ${tip}${rerunOutcome(work, candidate.sha, check)}: ${docsOverflowReason(overflow)}`;
    }
    const passedAhead = own && own.tip === candidate!.sha && window.firstFailure === own && window.tips.length > 1
      ? `, attributed to this entry: speculative tip ${window.tips.at(-2)!.tip?.slice(0, 12)} ahead of it passed ${check}`
      : '';
    return `Required CI check ${check} did not pass on speculative tip ${tip}${rerunOutcome(work, candidate.sha, check)}${passedAhead}`;
  }
  const planned = !!batch && speculation?.tip === candidate.sha && speculation.base === candidate.baseSha;
  const isolated = !planned || batch!.step.kind === 'eject' && batch!.step.member === work.key;
  // The batch plan's attributed ejection (GY-574) carries its own refusal, naming the words over
  // and the pages that grew, in place of the isolation clause.
  const attributed = planned && batch!.step.kind === 'eject' && batch!.step.member === work.key ? batch!.step.reason : undefined;
  if (check && attributed) return `Required CI check ${check} did not pass on speculative tip ${tip}: ${attributed}`;
  if (check && isolated) return `Required CI check ${check} did not pass on speculative tip ${tip}${rerunOutcome(work, candidate.sha, check)}${planned && batch!.size > 1 ? `, isolated by bisecting batch ${batch.batch} (${batch.members.join(', ')})` : ''}`;
  if (observation.reviews.some(review => review.sha === candidate.sha && review.state === 'CHANGES_REQUESTED')) return `Review requested changes on speculative tip ${tip}`;
  // Unresolved threads are the reviewer's inputs, not a reason to eject; only a branch that still
  // requires conversation resolution (protection drift) makes a merge GitHub cannot land.
  const threads = conversationProtectionRefusal(work);
  if (threads) return threads;
  // A proof the verdict's acceptance family still refuses, whose evidence binding this tip (exactly
  // or carried across a Graphyard-authored tip) failed or was withdrawn, is an adverse conclusion
  // about the tip, not a missing one: the entry leaves instead of holding everything behind it.
  // A trusted `manual:` proof that executed nothing (GY-868) is not one — the verdict holds the
  // entry for the attestation a criterion of this item can request (GY-875, GY-910).
  return landabilityEjection(verdict, 'proof');
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
/**
 * GY-638. Whether the restore recorded for exactly the current head found no own reviewed head
 * under the foreign commits: no restore is left to promise this head, so its gates route it to
 * rework instead of the resync whose fresh observation would only repeat the same refusal.
 */
export function unrepairableRestore(work: { candidate?: Work['candidate']; baseRefresh?: Work['baseRefresh']; policyRevision?: number }): boolean {
  const refresh = work.baseRefresh, candidate = work.candidate, restore = refresh?.restore;
  if (!restore || !candidate || refresh!.policyRevision !== work.policyRevision) return false;
  return restore.outcome === 'unrepairable' && (restore.contaminated === candidate.sha || refresh!.head === candidate.sha);
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
 * have not landed. Nothing is owed once a restore for that head is recorded, pending or performed
 * — except a restore that could not publish its result (GY-854): that one is retried once, with
 * the record of the first attempt carried so a second failure escalates, whatever its kind,
 * instead of a third attempt running. An escalated restore, or one already attempted twice, is
 * never retried by the loop.
 */
export function ejectedTipRestore(work: Work, all: Work[]): { contaminated: string; foreign: string[]; own: string | null; reason: string; previous: BranchRestore | null } | null {
  const ejection = work.queueEjection;
  if (!ejection || ejection.sha !== work.candidate?.sha) return null;
  const current = currentRestore(work);
  if (current && (current.restore!.outcome !== 'unpublished' || current.restore!.escalated || (current.restore!.attempts ?? 1) >= 2)) return null;
  const contamination = branchContamination(work, all);
  if (!contamination) return null;
  return { contaminated: contamination.head, foreign: contamination.foreign, own: contamination.own, reason: `ejected from the merge queue: ${ejection.reason}`, previous: current?.restore ?? null };
}

/**
 * GY-568. The speculative tip the current candidate is, when it was built behind predecessors of
 * which one or more has since left the merge queue without landing: `departed` names them. Such a
 * tip holds their unlanded commits by the queue's own construction, so its tree says nothing about
 * the item's change until the control plane restores the branch to the item's own reviewed head
 * (`ejectedTipRestore`) or the queue rebuilds the tip from it. Null for any other head: a worker's
 * push, a restored or refreshed head, or a tip whose predecessors are all still queued ahead or landed.
 */
export function staleSpeculativeTip(work: Pick<Work, 'id' | 'candidate' | 'queueHistory'>, all: Work[]): { tip: string; own: string | null; predecessors: string[]; departed: string[] } | null {
  const candidate = work.candidate;
  if (!candidate) return null;
  const predicted = [...(work.queueHistory ?? [])].reverse().find(entry => entry.event === 'predicted' && entry.tip === candidate.sha);
  if (!predicted?.predecessors?.length) return null;
  const departed = predicted.predecessors.filter(key => {
    const item = all.find(entry => entry.key === key);
    if (!item || item.id === work.id || item.stage === 'done' || item.observation?.merged) return false;
    // Still queued ahead of where this tip was predicted: the tip holds it as the queue intends.
    return !item.queue || item.queue.sequence > predicted.sequence;
  });
  return departed.length ? { tip: candidate.sha, own: predicted.from && predicted.from !== candidate.sha ? predicted.from : null, predecessors: predicted.predecessors, departed } : null;
}
/** The build-gate reason of a candidate waiting for its branch to be restored after a predecessor's ejection (GY-568). */
export const restoringAfterEjectionPrefix = 'Restoring after predecessor ejection: ';
/**
 * GY-568. Why the tree of this candidate is not judged yet, or null when it may be. A stale
 * speculative tip (`staleSpeculativeTip`) is refused by nothing its tree shows — no out-of-scope
 * revert, no conflict, no failed mechanical proof — and sent to no worker: it waits under this one
 * reason while the control plane restores the branch, and until GitHub is observed at the head the
 * restore produced. Only a restore that found no own head (`unrepairable`) hands the head back to
 * the gates, whose record names rework as the remedy.
 */
export function restoringAfterEjection(work: Work, all: Work[]): string | null {
  if (work.stage === 'done' || work.observation?.merged || !work.submission) return null;
  const stale = staleSpeculativeTip(work, all);
  if (!stale) return null;
  const refresh = currentRestore(work), restore = refresh?.restore;
  if (restore?.outcome === 'unrepairable') return null;
  if (restore?.outcome === 'unpublished' && restore.escalated)
    return `${restoringAfterEjectionPrefix}candidate ${stale.tip.slice(0, 12)} is a speculative tip built behind ${stale.departed.join(', ')}, which left the merge queue without landing; Graphyard's restore of the branch failed twice and stopped repeating: ${restore.failure ?? restore.escalated}. The escalation stands until what GitHub refuses is fixed or the master decides`;
  const restored = restore?.performedAt && refresh!.head && refresh!.head !== stale.tip ? refresh!.head : null;
  const own = stale.own ? `its own reviewed head ${stale.own.slice(0, 12)}` : 'its own reviewed head';
  return `${restoringAfterEjectionPrefix}candidate ${stale.tip.slice(0, 12)} is a speculative tip built behind ${stale.departed.join(', ')}, which left the merge queue without landing, so its tree holds their unlanded work; ${restored
    ? `Graphyard restored the branch to ${restored.slice(0, 12)} (${own} brought onto the base), and its gates are judged once GitHub is observed at that head`
    : `Graphyard restores the branch to ${own} brought onto the base before its tree is judged`}, and no worker is asked to change it`;
}

/**
 * The reason `advanceQueue` ejected an entry whose speculative merge conflicts, as it was worded
 * before ejections recorded `conflict` (GY-252). Read only for those legacy records.
 */
export const speculativeConflictReason = /^Speculative merge of [0-9a-f]+ into .+ conflicts/;
/**
 * Whether an ejection was a speculative-merge conflict. The typed `conflict` field decides; the
 * reason text is consulted only for a record written before the field existed, so rewording the
 * conflict message can never stop a conflict from being recognised.
 */
export function speculativeConflict(ejection: Pick<QueueEjection, 'reason' | 'conflict'>): boolean {
  return ejection.conflict === undefined ? speculativeConflictReason.test(ejection.reason) : !!ejection.conflict;
}
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
  if (!speculativeConflict(ejection) || !ejection.predecessors?.length) return null;
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
    if (!state || !candidate || item.stage === 'done' || item.observation?.merged || state.queue || state.refused || !state.requestedAt
      || state.head !== candidate.sha) return [];
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
    : !enqueueRequestCurrent(work, request) ? `${work.key}: no merge was requested for candidate ${sha?.slice(0, 12)} at policy revision ${work.policyRevision}`
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

// ---- Batching the merge queue (GY-330) -----------------------------------------------------------
// N queued entries used to cost N combined-tip CI runs, one after another. As GitHub's merge queue
// and bors do, consecutive entries are validated together: one combined tip for up to `batchSize`
// entries, merged in order when its required checks pass. Only a failing tip costs more runs, and
// then only as many as a bisection needs: the batch is split in half and the first half's combined
// tip tested, repeating until the failing entry is isolated and ejected with the failing check
// named, while every passing prefix merges. The chain of speculative tips already makes each
// prefix of the queue a commit of its own — an entry's tip holds every validated entry ahead of it
// — so a batch's combined tip is its last member's tip, and each half is a prefix tip.
// The live queue now validates under a parallel-tip window instead (GY-498, below): every entry is
// judged on its own tip and a failure is attributed by prefix, so no bisection is needed. The
// batch plan remains the reference model runMergeBatches drives and the fallback when no window is
// passed; the published batch size still widens the observation band and the wake depth.

/** Consecutive entries one combined tip validates when master config sets no `mergeQueue.batchSize`; 1 is one tip per entry. */
export const defaultMergeBatchSize = 4;
/** The largest batch size master config and the control plane accept. */
export const maxMergeBatchSize = 32;
/**
 * How long a head batch may sit in 'testing' with no published tip before it is dissolved
 * (GY-506): ten minutes past the first evaluation that found the state, so a wedged batch costs
 * the queue at most one CI-timeout's worth of waiting before its members validate singly again.
 */
export const stuckBatchMs = 10 * 60_000;
/** Canonical JSON: object keys sorted, so two views equal in content compare equal whatever key order each holds. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/**
 * Whether a re-derived batch view equals the one stored on the queue entry, content for content.
 * Postgres jsonb does not preserve object key order, and the derived view names `batch` last
 * while jsonb stores keys shortest-first: rewriting the stored entry with an equal view changed
 * the document on every evaluation, so every reconcile pass re-saved every queued entry and every
 * in-flight observation lost the revision race (GY-506). An equal view keeps the stored entry.
 */
export function sameMergeBatch(left: MergeBatchView | null | undefined, right: MergeBatchView | null | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return canonicalJson(left) === canonicalJson(right);
}
/** Whether a re-derived parallel-tip slice (GY-498) equals the stored one, content for content, as `sameMergeBatch` compares batch views. */
export function sameTips(left: TipView[] | null | undefined, right: TipView[] | null | undefined): boolean {
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}
/** The installation-ledger event recording the batch size the master published (POST /api/merge-queue). */
export const mergeBatchSizeEvent = 'merge-queue.batch-size';
/** A combined tip's verdict: every required check passed, or the first one that failed. */
export type TipVerdict = { result: 'pass' } | { result: 'fail'; check: string };
/**
 * What the queue does next for one batch: run CI on the combined tip of the base and exactly
 * `combination` (a prefix of the batch), merge `members` in order, or eject `member` for `check`.
 */
export type BatchStep =
  | { kind: 'test'; combination: string[] }
  | { kind: 'merge'; members: string[] }
  | { kind: 'eject'; member: string; check: string; reason?: string };
/**
 * The docs word counts a batch's overflow is attributed from (GY-574): the count of the batch's base
 * and of each prefix's combined tip, undefined where none was observed, and the budget the project
 * configures (undefined when its tips carry none, so nothing is attributed).
 */
export interface BatchDocs { base: DocsWordCount | undefined; count: (prefix: string[]) => DocsWordCount | undefined; budget: DocsWordBudget | undefined }
/**
 * The next step for a batch, from the verdicts on record. `verdict(prefix)` answers for the combined
 * tip of the batch's base and exactly that prefix, or undefined when it has not run; `before` is the
 * verdict of that base itself (null when not yet judged) — a pass for the head batch, whose base is the base branch, and the
 * combined tip of the batches ahead for any other. An entry that fails on a prefix known to pass
 * (or on a base known to pass) is isolated and ejected; otherwise a passing
 * prefix merges at once, the untested whole batch is tested first, and a failing prefix is halved
 * until a single entry fails on the prefix before it. A prefix of the whole batch that is known to fail is never run
 * again, which is what keeps the bisection to one run per halving.
 */
export function batchStep(members: string[], verdict: (prefix: string[]) => TipVerdict | undefined, before: TipVerdict | null = { result: 'pass' }, docs?: BatchDocs): BatchStep {
  if (!members.length) throw new Error('A batch has at least one member');
  const results = members.map((_, index) => verdict(members.slice(0, index + 1)));
  const failing = results.findIndex(result => result?.result === 'fail');
  // A tip that failed only the docs word budget needs no bisection (GY-574): the counts name the
  // entry whose docs change crossed the budget — the first prefix whose total exceeds it — and only
  // that entry is ejected; the entries ahead of it fit, and merge once their own tip passes.
  if (failing !== -1 && (results[failing] as { check: string }).check === docsBudgetProof && before?.result === 'pass' && docs?.budget) {
    const overflow = attributeDocsOverflow(docs.base, members.slice(0, failing + 1).map((key, index) => ({ key, count: docs.count(members.slice(0, index + 1)) })), docs.budget);
    if (overflow) return { kind: 'eject', member: overflow.member, check: docsBudgetProof, reason: docsOverflowReason(overflow) };
  }
  // A member whose tip fails where the prefix before it passed (or on a base known to pass) is
  // isolated: it is ejected at once, before the passing prefix merges, so the entries behind
  // rebuild without it. The first member of a batch behind the head sits on the batches ahead,
  // whose failure its tip inherits (CI runs on every published tip), so it is isolated only once
  // their combined tip passed; until then it waits for that tip to be judged.
  const prior = (index: number) => index === 0 ? before : results[index - 1];
  if (failing !== -1 && prior(failing)?.result === 'pass') return { kind: 'eject', member: members[failing], check: (results[failing] as { check: string }).check };
  if (failing === 0) return { kind: 'test', combination: members.slice(0, 1) };
  const below = failing === -1 ? members.length : failing;
  for (let index = below - 1; index >= 0; index--) if (results[index]?.result === 'pass') return { kind: 'merge', members: members.slice(0, index + 1) };
  if (failing === -1) return { kind: 'test', combination: members };
  return { kind: 'test', combination: members.slice(0, Math.floor((failing - 1) / 2) + 1) };
}
/** The batch at the head of the queue — its first `batchSize` entries — and its next step. */
export function planMergeBatch(queue: string[], batchSize: number, verdict: (prefix: string[]) => TipVerdict | undefined, docs?: BatchDocs): { members: string[]; step: BatchStep } | null {
  if (!queue.length) return null;
  const members = queue.slice(0, Math.max(1, Math.floor(batchSize)));
  return { members, step: batchStep(members, verdict, undefined, docs) };
}
/**
 * Drives a queue through its batches to the end: the reference the live plan follows step for
 * step. `runTip(merged, prefix)` runs CI on the combined tip of the base, the entries merged so far
 * and `prefix`; every run is recorded, and a combination already judged is never run again.
 */
export function runMergeBatches(queue: string[], batchSize: number, runTip: (merged: string[], prefix: string[]) => TipVerdict, docsCount?: (holds: string[]) => DocsWordCount, budget?: DocsWordBudget) {
  const pending = [...queue], merged: string[] = [], ejected: { member: string; check: string; reason?: string }[] = [], runs: string[][] = [];
  // A combined tip is named by everything it holds past the base: merging a prefix leaves the
  // tips of what stays pending exactly as they were, so their verdicts stand.
  const judged = new Map<string, TipVerdict>();
  const holds = (prefix: string[]) => [...merged, ...prefix].join(',');
  while (pending.length) {
    // A docs count is a property of the commit: every prefix's tip has one, run or not.
    const docs = docsCount && { base: docsCount([...merged]), count: (prefix: string[]) => docsCount([...merged, ...prefix]), budget };
    const step = planMergeBatch(pending, batchSize, prefix => judged.get(holds(prefix)), docs)!.step;
    if (step.kind === 'test') {
      judged.set(holds(step.combination), runTip([...merged], step.combination));
      runs.push([...merged, ...step.combination]);
    } else if (step.kind === 'merge') {
      merged.push(...pending.splice(0, step.members.length));
    } else {
      ejected.push({ member: step.member, check: step.check, ...(step.reason ? { reason: step.reason } : {}) });
      pending.splice(pending.indexOf(step.member), 1);
    }
  }
  return { merged, ejected, runs };
}
/** The verdict of an entry's own published tip, read from the observation of exactly that commit. */
export function tipVerdict(work: Work, ciAppIds: readonly number[] | null = null): TipVerdict | undefined {
  const speculation = work.queue?.speculation, candidate = work.candidate, observation = work.observation;
  if (!speculation || !candidate || speculation.tip !== candidate.sha || !observation || observation.candidate.sha !== candidate.sha) return undefined;
  // The policy's checks and the base branch's other required checks alike (GY-1060), as ejection reads them.
  const runs = judgedRequiredChecks(work, observation, ciAppIds);
  // A failure awaiting its one rerun (GY-516) is not yet a verdict: the batch waits, as for a pending run.
  const failed = ejectingCheck(work, ciAppIds)?.name;
  // A tip whose only failure is the docs word budget is judged as that proof (GY-574), so the plan
  // attributes it: the counts, not the check's name, say the lone failure was the budget's.
  const docs = observation.docsBudget;
  if (failed && docs?.sha === candidate.sha && docs.onlyFailure && docs.budget && docsTotal(docs.pages) > docs.budget.total) return { result: 'fail', check: docsBudgetProof };
  if (failed) return { result: 'fail', check: failed };
  if (runs.some(entry => requiredRunFailed(entry.check, entry.run))) return undefined;
  return runs.every(entry => requiredCheckPassed(entry.check, entry.run)) ? { result: 'pass' } : undefined;
}

// ---- Validating queue positions in parallel (GY-498) ---------------------------------------------
// One combined tip at a time capped throughput: every entry waited for its predecessor's batch to
// be judged and land, and a failure cost a bisection round per halving. As GitHub's own merge queue
// and bors do, the queue instead validates speculative tips for the first `mergeQueue.parallelTips`
// positions at once: tip k holds entries 1..k and is built on tip k-1 without waiting for tip k-1's
// CI to finish, so all the window's tips run CI concurrently. An entry whose tip and every tip
// ahead of it passed merges as soon as it heads the queue, with no CI left to wait for. When tip k
// fails, the entries before it still merge; the failure is attributed to entry k — its tip is the
// first failing one, so its change is what tip k-1 did not hold — and only the tips after k are
// rebuilt on the new prediction. The verdicts come from the published tips' own observations, so
// attribution needs no output reading: the prefix of passing tips isolates the culprit exactly as a
// bisection would, in one round instead of log-many.

/** How many queue positions are validated at once when master config sets no `mergeQueue.parallelTips`. */
export const defaultParallelTips = 4;
/** The largest parallel-tip window master config and the control plane accept (GY-498 review: beyond this, GitHub-side contention, not the queue plan, limits throughput). */
export const maxParallelTips = 16;
/** The installation-ledger event recording the parallel-tip window the master published (POST /api/merge-queue). */
export const mergeParallelTipsEvent = 'merge-queue.parallel-tips';
/** One in-flight speculative tip: what it holds, where it is published, and what CI said about it. */
export interface TipView {
  /** 1-based: this tip holds the first `position` validated entries. */
  position: number;
  /** The keys of the entries the tip holds, in queue order. */
  entries: string[];
  /** The published tip commit, or null while it is not published and bound for its entry. */
  tip: string | null;
  /** CI on the tip's required checks: `pass`, `fail`, `running` (some run reported and pending), or `none`. */
  ci: 'pass' | 'fail' | 'running' | 'none';
  /** The required check that failed, when `ci` is `fail`. */
  failedCheck?: string;
}
/** The tips one queued entry merges behind, and what the window's verdicts mean for it. */
export interface TipWindowView {
  /** The entry's 0-based place in the validated chain. */
  position: number;
  /** The tips this entry merges behind: positions 1..position+1; empty once outside the window. */
  tips: TipView[];
  /** The first tip among them whose required checks failed, or null. */
  firstFailure: TipView | null;
  /** True when every tip this entry merges behind passed: nothing is left to wait for but its turn. */
  validated: boolean;
  /** The tip view of the entry's own published tip, when it is the current candidate; null otherwise. */
  own: TipView | null;
}
/** True when every tip ahead of the entry's own passed: a failure on its own tip is then its change's. */
export const aheadPassed = (view: Pick<TipWindowView, 'tips'>) => view.tips.slice(0, -1).every(tip => tip.ci === 'pass');
/** The CI a published tip's required checks are at, read from the observation of exactly that commit. */
function tipCi(work: Work, ciAppIds: readonly number[] | null): { ci: TipView['ci']; failedCheck?: string } {
  const observation = work.observation, candidate = work.candidate;
  if (!observation || !candidate || observation.candidate.sha !== candidate.sha) return { ci: 'none' };
  // Every required check, protection-only ones included (GY-1060): the window view and attribution agree with ejection.
  const runs = judgedRequiredChecks(work, observation, ciAppIds);
  const failed = ejectingCheck(work, ciAppIds)?.name;
  if (failed) return { ci: 'fail', failedCheck: failed };
  if (runs.length > 0 && runs.every(entry => requiredCheckPassed(entry.check, entry.run))) return { ci: 'pass' };
  return { ci: runs.some(entry => !!entry.run) ? 'running' : 'none' };
}
/**
 * The parallel-tip window (GY-498) over the validated chain, per queued entry: the first
 * `parallelTips` positions' tips, and for every entry the slice of them it merges behind. Entries
 * outside the window get an empty `tips` slice: nothing is required of them until the entries
 * ahead land, exactly as a waiting batch required nothing.
 */
export function describeTipWindow(all: Work[], placements: QueuePlacement[], parallelTips: number, ciAppIds: readonly number[] | null = null): Map<string, TipWindowView> {
  const size = Math.max(1, Math.floor(parallelTips));
  const tips = tipWindowStatus(all, placements, size, ciAppIds);
  const views = new Map<string, TipWindowView>();
  for (const [index, placement] of validatedChain(placements).entries()) {
    if (index >= size) { views.set(placement.key, { position: index, tips: [], firstFailure: null, validated: false, own: null }); continue; }
    const mine = tips.slice(0, index + 1);
    views.set(placement.key, { position: index, tips: mine, firstFailure: mine.find(tip => tip.ci === 'fail') ?? null, validated: mine.every(tip => tip.ci === 'pass'), own: mine.at(-1) ?? null });
  }
  return views;
}
/** The placements the window validates, in queue order: every entry not passed over. */
const validatedChain = (placements: QueuePlacement[]) => placements.filter(placement => !placement.passedOver).sort((a, b) => a.position - b.position || a.sequence - b.sequence);
/**
 * The in-flight tips (GY-498): the window's tips with what they hold and what CI said. Master
 * status reports exactly these, and `describeTipWindow` slices them per entry for the gates, so
 * the two never diverge.
 */
export function tipWindowStatus(all: Work[], placements: QueuePlacement[], parallelTips: number, ciAppIds: readonly number[] | null = null): TipView[] {
  const size = Math.max(1, Math.floor(parallelTips)), chain = validatedChain(placements);
  const byKey = new Map(all.map(work => [work.key, work]));
  return chain.slice(0, size).map((placement, index) => {
    const work = byKey.get(placement.key);
    const published = !!placement.tip && !!work?.candidate && work.candidate.sha === placement.tip;
    return { position: index + 1, entries: chain.slice(0, index + 1).map(entry => entry.key), tip: published ? placement.tip : null,
      ...(published && work ? tipCi(work, ciAppIds) : { ci: 'none' as const }) };
  });
}
/**
 * The window as a batch view (GY-330 shape), recorded on the queue entry so the gates' existing
 * readers — the dashboard's Merge step, status rows — show the window without a second display
 * model. The summary names each in-flight tip with its position, its entries and its CI state.
 */
export function windowBatchView(key: string, view: TipWindowView, parallelTips: number): MergeBatchView {
  const unjudged = view.tips.filter(tip => tip.ci !== 'pass');
  const failing = view.firstFailure;
  // An own failing tip behind an unjudged one is not attributed yet: the entry waits on the tip ahead.
  const attributed = !!failing && failing === view.own && aheadPassed(view);
  const pendingAhead = !!failing && failing === view.own && !attributed ? unjudged.find(tip => tip !== failing) ?? null : null;
  const state: MergeBatchView['state'] = view.tips.length === 0 ? 'waiting' : attributed ? 'ejecting' : failing ? 'waiting' : unjudged.length ? 'testing' : 'merging';
  const step: BatchStep = view.tips.length === 0 ? { kind: 'test', combination: [] }
    : attributed ? { kind: 'eject', member: key, check: failing!.failedCheck! }
      : pendingAhead ? { kind: 'test', combination: pendingAhead.entries }
      : failing ? { kind: 'test', combination: failing.entries }
      : unjudged.length ? { kind: 'test', combination: unjudged.at(-1)!.entries } : { kind: 'merge', members: view.tips.at(-1)!.entries };
  const underTest = unjudged.length ? { members: unjudged.at(-1)!.entries, tip: unjudged.at(-1)!.tip } : null;
  const said = (tip: TipView) => tip.ci === 'pass' ? 'passed' : tip.ci === 'fail' ? `failed ${tip.failedCheck}` : tip.ci === 'running' ? 'running' : 'not validated';
  const summary = view.tips.length === 0 ? `outside the window of ${Math.max(1, Math.floor(parallelTips))} parallel tips; waits for the entries ahead to land`
    : `${view.tips.map(tip => `tip ${tip.position} (${tip.entries.join(', ')}) ${said(tip)}`).join('; ')}`;
  return { batch: 1, size: view.tips.length || 1, members: view.tips.at(-1)?.entries ?? [], tip: view.tips.at(-1)?.tip ?? null, underTest, state, step, summary };
}
/**
 * Merges and queue waits as master status reports them (GY-498): merges in the trailing hour, by
 * GitHub's merge time (the delivery's, else the observation's), and the median wait so far of the
 * entries queued now. Insights reports the same two figures over its window from the flow facts.
 */
export interface MergeThroughput { mergesPerHour: number; medianQueueWaitMs: number | null }
export function mergeThroughput(all: Work[], now: number): MergeThroughput {
  const hourAgo = now - 3_600_000;
  const mergedAt = (work: Work) => Date.parse(work.delivery?.mergedAt ?? (work.observation?.merged ? work.observation.mergedAt ?? '' : ''));
  const mergesPerHour = all.filter(work => { const at = mergedAt(work); return at >= hourAgo && at <= now; }).length;
  const waits = predictQueue(all, now).map(placement => placement.waitMs).sort((a, b) => a - b);
  const median = waits.length ? waits.length % 2 ? waits[(waits.length - 1) / 2] : (waits[waits.length / 2 - 1] + waits[waits.length / 2]) / 2 : null;
  return { mergesPerHour, medianQueueWaitMs: median };
}
/** What master status reports about the running queue (GY-498): the throughput Insights and the in-flight tips. */
export function mergeQueueInsights(all: Work[], now: number, parallelTips: number, ciAppIds: readonly number[] | null = null) {
  return { ...mergeThroughput(all, now), tips: tipWindowStatus(all, predictQueue(all, now), parallelTips, ciAppIds) };
}
/** One batch as master status and the dashboard show it: a substate of the Merge step, never a return to Test. */
export interface MergeBatchView {
  /** 1 for the batch at the head of the queue. */
  batch: number; size: number; members: string[];
  /** The batch's combined tip: its last member's published tip, which holds every member; null until published. */
  tip: string | null;
  /** The combination the queue is running CI on, or would run next, and that combination's tip. */
  underTest: { members: string[]; tip: string | null } | null;
  state: 'testing' | 'bisecting' | 'merging' | 'ejecting' | 'waiting';
  step: BatchStep;
  summary: string;
}
/**
 * The batches of the live queue (GY-330): the chain of validated entries in `batchSize` groups.
 * Each prefix of the chain is an entry's own tip, so a batch's combined tip is its last member's,
 * each half a bisection tests is the tip of the half's last member, and a verdict is the required
 * checks as observed on that tip. The head batch acts; the batches behind it wait their turn.
 * Entries named by a live stuck-batch dissolution (GY-506) are validated one at a time: each is
 * its own batch, in the chain's existing order, and no batch spans one of them.
 */
export function describeMergeBatches(all: Work[], placements: QueuePlacement[], batchSize: number, ciAppIds: readonly number[] | null = null): Map<string, MergeBatchView> {
  const size = Math.max(1, Math.floor(batchSize));
  const chain = placements.filter(placement => !placement.passedOver).sort((a, b) => a.position - b.position || a.sequence - b.sequence);
  const byKey = new Map(all.map(work => [work.key, work]));
  const placed = new Map(chain.map(placement => [placement.key, placement]));
  // The dissolutions on record that still hold: every member they named is still a live queued entry.
  const live = new Set(chain.map(placement => placement.key));
  const singles = new Set<string>();
  for (const work of all) {
    const dissolved = work.queue?.batchDissolved;
    if (!dissolved || !dissolved.members.every(key => live.has(key))) continue;
    for (const key of dissolved.members) if (live.has(key)) singles.add(key);
  }
  const views = new Map<string, MergeBatchView>();
  let start = 0, batch = 1;
  while (start < chain.length) {
    let width = singles.has(chain[start].key) ? 1 : Math.min(size, chain.length - start);
    if (width > 1) for (let end = start + 1; end < start + width; end++) if (singles.has(chain[end].key)) { width = end - start; break; }
    const members = chain.slice(start, start + width).map(placement => placement.key);
    const tipOf = (key: string) => placed.get(key)?.tip ?? null;
    const verdict = (prefix: string[]) => { const last = byKey.get(prefix.at(-1)!); return last && tipOf(last.key) ? tipVerdict(last, ciAppIds) : undefined; };
    // The batches ahead are this batch's base: their combined tip is the tip of the entry just before it.
    const ahead = start > 0 ? byKey.get(chain[start - 1].key) : undefined;
    const before: TipVerdict | null = start === 0 ? { result: 'pass' } : ahead && tipOf(ahead.key) ? tipVerdict(ahead, ciAppIds) ?? null : null;
    // The docs counts each member's published tip was observed with (GY-574); the first member's base is the batch's.
    // Only a failing tip is counted, so a prefix's count is its last member's record, or the base the member behind it recorded.
    const tipDocs = (key: string) => { const entry = byKey.get(key), docs = entry?.observation?.docsBudget; return docs && tipOf(key) && docs.sha === tipOf(key) ? docs : undefined; };
    const counted = (prefix: string[]) => tipDocs(prefix.at(-1)!)?.pages ?? (prefix.length < members.length ? tipDocs(members[prefix.length])?.base : undefined);
    // The budget is the one the members' tips were counted against, as their project's graphyard.json configures it.
    const budget = members.map(tipDocs).find(docs => docs?.budget)?.budget;
    const step = batchStep(members, verdict, before, { base: tipDocs(members[0])?.base, count: counted, budget });
    const head = batch === 1;
    const state: MergeBatchView['state'] = !head ? 'waiting' : step.kind === 'merge' ? 'merging' : step.kind === 'eject' ? 'ejecting' : step.combination.length === members.length ? 'testing' : 'bisecting';
    const underTest = step.kind === 'test' ? { members: step.combination, tip: tipOf(step.combination.at(-1)!) } : null;
    const tip = tipOf(members.at(-1)!);
    const named = `batch ${batch} (${members.join(', ')})${singles.has(members[0]) ? ', dissolved from a stuck batch' : ''}`;
    const summary = state === 'waiting' ? `${named} waits for batch ${batch - 1} to merge`
      : state === 'merging' ? `${named}: combined tip ${tipOf((step as { members: string[] }).members.at(-1)!)?.slice(0, 12) ?? 'unpublished'} passed; merging ${(step as { members: string[] }).members.join(', ')} in order`
      : state === 'ejecting' ? `${named}: ${(step as { member: string }).member} is ${(step as { reason?: string }).reason ? 'attributed' : 'isolated'} as failing ${(step as { check: string }).check} and is ejected; the rest stay queued`
      : state === 'bisecting' ? `${named}: the combined tip failed; bisecting on the tip of ${underTest!.members.join(', ')}${underTest!.tip ? ` (${underTest!.tip.slice(0, 12)})` : ''}`
      : `${named}: validating combined tip ${tip?.slice(0, 12) ?? '(not yet published)'}`;
    for (const key of members) views.set(key, { batch, size: members.length, members, tip, underTest, state, step, summary });
    start += width; batch++;
  }
  return views;
}
/** The batch one queued entry is in under `batchSize`, as the gates read it; null when it is in none (passed over, or not queued). */
export function queueBatch(work: Pick<Work, 'key'>, all: Work[], now: number, batchSize: number, ciAppIds: readonly number[] | null): MergeBatchView | null {
  return describeMergeBatches(all, predictQueue(all, now), batchSize, ciAppIds).get(work.key) ?? null;
}

/**
 * The queue entries a delivery or an ejection wakes: the next `depth` live entries in queue order,
 * not all of them. On 2026-09-25 each delivery woke all 30 queued entries at once; the server
 * observes one job at a time at 10-13 s each, so the new head waited behind a five-minute flood of
 * entries that could not land yet. The rest keep their own schedule (github.ts observationBand).
 */
export function nextQueueEntries<W extends { id: string; stage: string; queue?: { sequence: number } | null }>(all: readonly W[], exclude: string, depth: number): W[] {
  return all.filter(other => other.id !== exclude && other.stage !== 'done' && other.queue).sort((a, b) => a.queue!.sequence - b.queue!.sequence).slice(0, depth);
}

/**
 * GY-516. One rerun of a failed required check before it counts. A single infrastructure flake on
 * a validated tip (a database torn down under a test, a runner lost) otherwise ejects the entry and
 * costs the whole queue a review, proof and CI round for a failure that is not the change's. The
 * control plane asks GitHub to rerun the failed jobs of that workflow run once, per candidate sha
 * and check, and while the rerun is owed or running the failure holds: the entry keeps its queue
 * position and every binding on the unchanged sha. The rerun's own conclusion then decides as any
 * run does; a second failure on the same sha ejects, or returns the head to its worker, as before.
 */
declare module './model/work.js' {
  interface Work {
    /** GY-516: the reruns of failed required checks, per candidate sha and check (see `reconcileCheckReruns`). */
    checkReruns?: CheckRerun[];
  }
}
export interface CheckRerun {
  /** The candidate sha (a published tip or a head) and the required check that failed on it. */
  sha: string; check: string;
  /** The failed check run the rerun answers; its workflow run is the one GitHub reruns. */
  failedRunId: number;
  /**
   * `owed` until the control plane asks GitHub, `requested` once GitHub accepted, `refused` when it
   * did not (the failure then stands), and the rerun's conclusion once observed: `passed` or
   * `failed`. `expired` is a request whose rerun never appeared within `checkRerunVisibilityMs`.
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
   * runner-queue wait, which keeps holding the failure until the rerun concludes.
   */
  waiting?: { status: string; at: string };
  /** When the workflow run was last read for this rerun (GY-1096). */
  probedAt?: string;
  /** When GitHub was asked a second time because no rerun was found at all (GY-1096); asked once only. */
  rerequestedAt?: string;
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
/** Every required check (GY-430) with the run that counts for it on the observation. */
function judgedRequiredChecks(work: Work, observation: Observation, ciAppIds: readonly number[] | null) {
  return requiredChecksOf(work).map(check => ({ check, run: requiredCheckRun(check, observation.checks ?? [], ciAppIds) }));
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
      if (failedConclusions.has(run.result)) { const resolved = { ...entry, state: 'failed' as const, rerunId: run.id, resolvedAt: at }; transitions.push({ kind: 'check.rerun.failed', rerun: resolved }); return resolved; }
      if (entry.state === 'owed') { const started = { ...entry, state: 'requested' as const, rerunId: run.id }; transitions.push({ kind: 'check.rerun.requested', rerun: started }); return started; }
      return entry.rerunId === run.id ? entry : { ...entry, rerunId: run.id };
    }
    // An accepted rerun naming its workflow run is asked of GitHub by the integration job instead
    // (GY-1096): queued behind busy runners it is a wait, not a failure, however long it takes.
    if (entry.state === 'requested' && entry.runId !== undefined) return entry;
    if (now.getTime() - Date.parse(entry.at) >= checkRerunVisibilityMs) {
      const expired = { ...entry, state: 'expired' as const, detail: `${entry.state === 'owed' ? 'The rerun remained owed' : 'GitHub accepted the rerun'} but no new ${entry.check} run appeared within ${checkRerunVisibilityMs / 60_000} minutes`, resolvedAt: at };
      transitions.push({ kind: 'check.rerun.expired', rerun: expired }); return expired;
    }
    return entry;
  });
  for (const name of work.policy?.checks ?? []) {
    const run = latestOf(name);
    if (!run || run.id === undefined || !failedConclusions.has(run.result)) continue;
    const made = reruns.filter(entry => entry.sha === candidate.sha && entry.check === name);
    if (made.some(entry => entry.failedRunId === run.id) || made.length >= limit) continue;
    const owed: CheckRerun = { sha: candidate.sha, check: name, failedRunId: run.id, state: 'owed', at };
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
    && now.getTime() - Date.parse(entry.rerequestedAt ?? entry.at) >= checkRerunVisibilityMs
    && (!entry.probedAt || now.getTime() - Date.parse(entry.probedAt) >= checkRerunProbeMs));
}
/** The workflow run GitHub reports for a rerun (GY-1096), or null when there is none. */
export interface RerunWorkflowRun { status: string; conclusion: string | null; attempt: number | null }
/** What an accepted rerun's workflow run says of it (GY-1096). */
export type CheckRerunProbe =
  | { kind: 'waiting'; status: string }
  | { kind: 'failed'; conclusion: string }
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
  if (run.conclusion && failedConclusions.has(run.conclusion)) return { kind: 'failed', conclusion: run.conclusion };
  return { kind: 'waiting', status: 'completed' };
}
const runnerWait = (entry: CheckRerun) => entry.waiting && entry.waiting.status !== 'completed'
  ? `, waiting for a runner (its workflow run is ${entry.waiting.status.replace(/_/g, ' ')} in the runner queue)` : '';
/** What the last rerun of `check` on `sha` came to, as a clause for the failure it did not clear. */
function rerunOutcome(work: Work, sha: string, check: string): string {
  const last = checkReruns(work).filter(entry => entry.sha === sha && entry.check === check).at(-1);
  return !last ? '' : last.state === 'failed' ? ', again after one rerun of its failed jobs'
    : last.state === 'refused' ? `; its rerun was refused: ${last.detail ?? 'no reason given'}`
    : last.state === 'expired' ? `; ${last.detail}` : '';
}
/** The test gate exposes the rerun even when this candidate has never entered the queue. */
export function checkRerunStatus(work: Work, check: string): string {
  const sha = work.candidate?.sha;
  const last = checkReruns(work).filter(entry => entry.sha === sha && entry.check === check).at(-1);
  if (!last) return '';
  const state = last.state === 'owed' ? 'one rerun of its failed jobs is owed'
    : last.state === 'requested' ? `its failed jobs are rerunning${last.runId ? ` (workflow run ${last.runId})` : ''}${runnerWait(last)}`
    : last.state === 'failed' ? 'failed again after rerunning its failed jobs'
    : last.state === 'passed' ? 'passed'
    : `${last.state}: ${last.detail ?? 'no reason given'}`;
  return `; rerun: ${state}`;
}
/** The reruns on the current candidate that still hold a failure, as `<sha>: <what is awaited>` lines. */
export function pendingCheckReruns(work: Work): string[] {
  const sha = work.candidate?.sha;
  return checkReruns(work).filter(entry => entry.sha === sha && holdingRerun.has(entry.state))
    .map(entry => `${entry.sha.slice(0, 12)}: required CI check ${entry.check} failed and ${entry.state === 'owed' ? 'one rerun of its failed jobs is owed' : `its failed jobs are rerunning${entry.runId ? ` (workflow run ${entry.runId})` : ''}${runnerWait(entry)}`}; the entry keeps its position and bindings until the rerun concludes`);
}
