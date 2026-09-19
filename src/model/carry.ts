import { pathScopesOverlap } from './scope.js';
import type { Evidence } from './evidence.js';
import { reviewerProfileFor, type ReviewProvider } from './review.js';
import type { Work } from './work.js';

/**
 * Binding carry across a Graphyard-authored speculative tip.
 *
 * A review and every trusted proof bind to one exact commit. When the merge queue replaces an
 * approved, proven head H with a tip H' that Graphyard itself produced — a two-parent merge of H
 * and the commit H' will land on, authored by the control-plane App, with no conflict resolved —
 * the two commits are provably the same reviewed content plus already-validated history. Only
 * then is a binding carried, and only as far as the predecessor's changes let it: an approval is
 * carried when the predecessor touched none of the reviewed files, and a proof when its declared
 * scope is disjoint from those changes. Everything else is re-required with the reason recorded.
 * The decision is made once, at publication, from facts the control plane observed itself; it is
 * never asserted by a worker, a producer, or a reviewer.
 */

/** What Graphyard's merge produced when it published a tip, as GitHub reports the commit. */
export interface TipMerge {
  /** The head the tip replaced: the commit every carried binding was made against. */
  from: string;
  /** Parents of the tip commit; a carried tip has exactly the replaced head and its predicted base. */
  parents: string[];
  /** GitHub login of the tip commit's author, or null when GitHub reported none. */
  author: string | null;
  /** The author is the control-plane App's own bot identity. */
  authoredByApp: boolean;
  /** The merge needed a conflict resolved; Graphyard's provider merge never does, and a resolved merge is never carried. */
  conflicts: boolean;
  /** Paths changed between the replaced head's bound base and the predicted base, or null when GitHub could not list them completely. */
  baseChanges: string[] | null;
}
/** The identity behind an exact-commit approval, as the review gate accepted it. */
export interface ApprovalIdentity { provider: ReviewProvider; reviewer: string; sha: string; reviewId?: number; reviewerApp?: string }
export interface CarriedApproval extends ApprovalIdentity { carried: true; originalSha: string; reason: string }
export interface RequiredApproval { carried: false; reason: string }
export interface CarriedProof { proof: string; carried: boolean; evidenceId?: string; producer?: string; reason: string }
export interface QueueCarry {
  from: { sha: string; baseSha: string }; to: { sha: string; baseSha: string }; policyRevision: number; at: string;
  /** The queue entry whose tip is the predicted base, or the base branch itself. */
  predecessor: string;
  /** Paths the predecessor changed relative to the replaced head's bound base; null when unknown. */
  changedFiles: string[] | null;
  /** Paths the replaced head changed: what the carried review actually read. */
  reviewedFiles: string[];
  approval: CarriedApproval | RequiredApproval;
  evidence: CarriedProof[];
}
export interface CarryInput {
  from: { sha: string; baseSha: string }; to: { sha: string; baseSha: string }; policyRevision: number; at: string;
  merge: TipMerge | null | undefined;
  predecessor: { key: string | null; validated: boolean };
  reviewedFiles: string[];
  approval: ApprovalIdentity | null;
  /** Every required proof with the trusted evidence currently bound to the replaced head, if any. */
  proofs: { proof: string; evidence: Evidence | undefined }[];
  /** Name of the control-plane App identity, for the recorded reason. */
  app: string;
}

const short = (sha: string) => sha.slice(0, 12);
const list = (paths: string[]) => paths.length > 6 ? `${paths.slice(0, 6).join(', ')} and ${paths.length - 6} more` : paths.join(', ');

/** The one reason that refuses every binding at once, or null when the tip qualifies for per-binding decisions. */
export function carryRefusal(input: Pick<CarryInput, 'from' | 'to' | 'merge' | 'predecessor' | 'app'>): string | null {
  const { from, to, merge, predecessor } = input;
  if (!merge || merge.from !== from.sha) return `tip ${short(to.sha)} was not produced by Graphyard's merge of the approved head ${short(from.sha)}`;
  const expected = new Set([from.sha, to.baseSha]);
  const parents = new Set(merge.parents);
  if (parents.size !== expected.size || [...expected].some(sha => !parents.has(sha))) return `tip ${short(to.sha)} has parents ${merge.parents.map(short).join(', ') || 'none'} rather than exactly the approved head ${short(from.sha)} and its predicted base ${short(to.baseSha)}, so it carries commits Graphyard did not produce`;
  if (!merge.authoredByApp) return `tip ${short(to.sha)} was authored by ${merge.author ?? 'an unknown identity'}, not by the ${input.app} App`;
  if (merge.conflicts) return `tip ${short(to.sha)} needed conflict resolution, which is new content nobody reviewed or proved`;
  if (!predecessor.validated) return predecessor.key ? `predecessor ${predecessor.key} is not fully validated on tip ${short(to.baseSha)}` : `the predicted base ${short(to.baseSha)} is not validated`;
  if (merge.baseChanges === null) return `the files ${predecessor.key ?? 'the base branch'} changed between ${short(from.baseSha)} and ${short(to.baseSha)} could not be listed completely`;
  return null;
}

/** Decide, for one published tip, which bindings of the replaced head carry and which are re-required. */
export function decideCarry(input: CarryInput): QueueCarry {
  const { from, to, merge, predecessor } = input;
  const base = { from, to, policyRevision: input.policyRevision, at: input.at, predecessor: predecessor.key ?? 'base branch', changedFiles: merge?.baseChanges ?? null, reviewedFiles: input.reviewedFiles };
  const refusal = carryRefusal(input);
  if (refusal) {
    return { ...base, approval: { carried: false, reason: refusal }, evidence: input.proofs.map(({ proof }) => ({ proof, carried: false, reason: refusal })) };
  }
  const changed = merge!.baseChanges!;
  const who = predecessor.key ?? 'the base branch';
  const reviewedTouched = input.reviewedFiles.filter(path => changed.includes(path));
  const approval: CarriedApproval | RequiredApproval = !input.approval ? { carried: false, reason: `no approval was bound to the replaced head ${short(from.sha)}` }
    : reviewedTouched.length ? { carried: false, reason: `${who} changed reviewed files ${list(reviewedTouched)}; a fresh independent approval of ${short(to.sha)} is required` }
    : { ...input.approval, carried: true, originalSha: from.sha, reason: `approval of ${short(from.sha)} by ${input.approval.reviewer} carried to Graphyard-authored tip ${short(to.sha)}: ${who} changed none of the ${input.reviewedFiles.length} reviewed files` };
  const evidence = input.proofs.map(({ proof, evidence }): CarriedProof => {
    if (!evidence) return { proof, carried: false, reason: `no trusted evidence was bound to the replaced head ${short(from.sha)}` };
    // A predicted base that changed nothing relative to the bound base leaves the tested tree
    // untouched, so no declared scope is needed to show the proof still applies.
    if (!changed.length) return { proof, carried: true, evidenceId: evidence.id, producer: evidence.producer, reason: `evidence ${evidence.id} from ${evidence.producer} carried to ${short(to.sha)}: ${who} changed no file relative to ${short(from.baseSha)}` };
    if (!evidence.scopeFiles?.length) return { proof, carried: false, evidenceId: evidence.id, producer: evidence.producer, reason: `evidence ${evidence.id} declares no scopeFiles, so its independence from the ${changed.length} files ${who} changed cannot be shown; fresh evidence for ${short(to.sha)} is required` };
    const intersecting = changed.filter(path => evidence.scopeFiles!.some(scope => pathScopesOverlap(scope, path)));
    if (intersecting.length) return { proof, carried: false, evidenceId: evidence.id, producer: evidence.producer, reason: `${who} changed ${list(intersecting)} inside the scope of evidence ${evidence.id}; fresh evidence for ${short(to.sha)} is required` };
    return { proof, carried: true, evidenceId: evidence.id, producer: evidence.producer, reason: `evidence ${evidence.id} from ${evidence.producer} carried to ${short(to.sha)}: its scope (${list(evidence.scopeFiles)}) is disjoint from the ${changed.length} files ${who} changed` };
  });
  return { ...base, approval, evidence };
}

/** The carry decision that applies to the current candidate: the published tip it was decided for, under the current policy. */
export function currentCarry(work: Pick<Work, 'candidate' | 'queue' | 'policyRevision'>): QueueCarry | null {
  const speculation = work.queue?.speculation, carry = speculation?.carry, candidate = work.candidate;
  if (!speculation || !carry || !candidate) return null;
  return speculation.tip === candidate.sha && carry.to.sha === candidate.sha && carry.to.baseSha === candidate.baseSha && carry.policyRevision === work.policyRevision ? carry : null;
}
/** True when a trusted evidence record binds the current candidate: exactly, or carried across a Graphyard-authored tip. */
export function evidenceBindsCandidate(work: Pick<Work, 'candidate' | 'queue' | 'policyRevision'>, evidence: Pick<Evidence, 'id' | 'proof' | 'sha' | 'baseSha'>): boolean {
  const candidate = work.candidate;
  if (!candidate) return false;
  if (evidence.sha === candidate.sha && evidence.baseSha === candidate.baseSha) return true;
  const carry = currentCarry(work);
  return !!carry && evidence.sha === carry.from.sha && evidence.baseSha === carry.from.baseSha
    && carry.evidence.some(entry => entry.carried && entry.proof === evidence.proof && entry.evidenceId === evidence.id);
}
/** The approval carried onto the current candidate, when the decision carried one for the policy's provider. */
export function carriedApproval(work: Work): CarriedApproval | null {
  const carry = currentCarry(work), approval = carry?.approval;
  if (!approval?.carried || approval.provider !== (work.policy.reviewProvider ?? 'github')) return null;
  // An agent approval is an identity the policy still dispatches to; a profile removed or failed
  // over since the original review is not carried either.
  if (approval.provider === 'agent' && reviewerProfileFor(work)?.reviewerApp !== approval.reviewerApp) return null;
  return approval;
}
