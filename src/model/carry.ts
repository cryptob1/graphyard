import { pathScopesOverlap } from './scope.js';
import type { Evidence } from './evidence.js';
import { exactApproval, reviewerProfileFor, type ReviewProvider } from './review.js';
import type { Work } from './work.js';

/**
 * Binding carry across a Graphyard-authored speculative tip.
 *
 * A review and every trusted proof bind to one exact commit. When the merge queue replaces an
 * approved, proven head H with a tip H' that Graphyard itself produced — a two-parent merge of H
 * and the commit H' will land on, authored by the control-plane App, with no conflict resolved —
 * the two commits are provably the same reviewed content plus already-validated history. Only
 * then is a binding carried. The review judges whether the change is right and the proofs what it
 * does; the combined tip's CI, which always runs again, judges whether the combination works. So
 * the first ground is the change's own diff (GY-330): when the tip's diff against its merge base
 * has the same patch-id as the replaced head's diff against its own, the change nobody changed
 * keeps its approval and every proof, even where the base edited another hunk of a reviewed file.
 * Where that is not shown — the diff changed, or a side of it could not be read completely — a
 * binding carries only as far as the predecessor's changes let it: an approval when the
 * predecessor touched none of the reviewed files, and a proof when its declared scope is disjoint
 * from those changes. Everything else is re-required with the reason recorded. The decision is
 * made once, at publication, from facts the control plane observed itself; it is never asserted by
 * a worker, a producer, or a reviewer.
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
  /**
   * The candidate's own diff on each side of the merge, as patch-ids (GY-330): `reviewed` from
   * GitHub's compare of the replaced head against its merge base with the bound base, `tip` from
   * the compare of the tip against its merge base with the predicted base. A side is null when
   * GitHub could not list it completely (a truncated list, or a file with neither a textual patch
   * nor a blob SHA);
   * absent on records that predate the rule.
   */
  diff?: { reviewed: string | null; tip: string | null } | null;
}
/**
 * What a carry decision rested on (GY-330): `diff unchanged` — the tip's own diff has the reviewed
 * diff's patch-id, so every binding carried; `diff changed` — it has another, so each binding was
 * decided by the files rule; `files` — no patch-id could be compared, so the files rule decided.
 */
export interface CarryGround { rule: 'diff unchanged' | 'diff changed' | 'files'; patchId: string | null; tipPatchId: string | null }
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
  /** The ground the decision rested on; absent on decisions recorded before GY-330. */
  ground?: CarryGround;
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
/** The identity a carried approval names, in the reason every status view shows: who, which review, and the commit it was given on. */
const approvedBy = (approval: ApprovalIdentity) => `approval of ${short(approval.sha)} by ${approval.reviewer}${approval.reviewId !== undefined ? ` (review ${approval.reviewId})` : ''}`;
/** The candidate's diff is shown unchanged across the merge: both patch-ids known and equal. */
export function diffUnchanged(merge: Pick<TipMerge, 'diff'> | null | undefined): boolean {
  const diff = merge?.diff;
  return !!diff?.reviewed && diff.reviewed === diff.tip;
}
/** How a decision's ground reads in status: `diff unchanged (patch-id 1a2b3c4d5e6f)`. */
export function describeGround(ground: CarryGround | null | undefined): string | null {
  if (!ground) return null;
  if (ground.rule === 'diff unchanged') return `diff unchanged (patch-id ${ground.patchId!.slice(0, 12)})`;
  if (ground.rule === 'diff changed') return `diff changed (patch-id ${ground.patchId!.slice(0, 12)} became ${ground.tipPatchId!.slice(0, 12)}); files rule`;
  return 'files rule (the diff could not be compared)';
}
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
  // An unchanged diff decides every binding on its own; the base's file list is needed only without it.
  if (merge.baseChanges === null && !diffUnchanged(merge)) return `the files ${predecessor.key ?? 'the base branch'} changed between ${short(from.baseSha)} and ${short(to.baseSha)} could not be listed completely`;
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
  const who = predecessor.key ?? 'the base branch';
  const diff = merge!.diff ?? null;
  // The change's own diff is what the review read and what the proofs exercised; the base moving
  // around it is answered by the combined tip's CI. The same patch-id on both sides carries all.
  if (diffUnchanged(merge)) {
    const id = short(diff!.reviewed!);
    const ground: CarryGround = { rule: 'diff unchanged', patchId: diff!.reviewed, tipPatchId: diff!.tip };
    const approval: CarriedApproval | RequiredApproval = !input.approval ? { carried: false, reason: `no approval was bound to the replaced head ${short(from.sha)}` }
      : { ...input.approval, carried: true, originalSha: input.approval.sha, reason: `${approvedBy(input.approval)} carried to Graphyard-authored tip ${short(to.sha)}: diff unchanged (patch-id ${id}) across ${who}'s changes` };
    const evidence = input.proofs.map(({ proof, evidence }): CarriedProof => !evidence ? { proof, carried: false, reason: `no trusted evidence was bound to the replaced head ${short(from.sha)}` }
      : { proof, carried: true, evidenceId: evidence.id, producer: evidence.producer, reason: `evidence ${evidence.id} from ${evidence.producer} carried to ${short(to.sha)}: diff unchanged (patch-id ${id}) across ${who}'s changes` });
    return { ...base, approval, evidence, ground };
  }
  const ground: CarryGround = diff?.reviewed && diff.tip ? { rule: 'diff changed', patchId: diff.reviewed, tipPatchId: diff.tip } : { rule: 'files', patchId: diff?.reviewed ?? null, tipPatchId: diff?.tip ?? null };
  const changed = merge!.baseChanges!;
  const reviewedTouched = input.reviewedFiles.filter(path => changed.includes(path));
  const approval: CarriedApproval | RequiredApproval = !input.approval ? { carried: false, reason: `no approval was bound to the replaced head ${short(from.sha)}` }
    : reviewedTouched.length ? { carried: false, reason: `${who} changed reviewed files ${list(reviewedTouched)}; a fresh independent approval of ${short(to.sha)} is required` }
    : { ...input.approval, carried: true, originalSha: input.approval.sha, reason: `${approvedBy(input.approval)} carried to Graphyard-authored tip ${short(to.sha)}: ${who} changed none of the ${input.reviewedFiles.length} reviewed files` };
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
  // A changed diff names both patch-ids on what it re-required, so the record says why.
  const changedDiff = ground.rule === 'diff changed' ? `; the candidate's own diff changed (patch-id ${short(ground.patchId!)} became ${short(ground.tipPatchId!)})` : '';
  const note = <T extends { carried: boolean; reason: string }>(entry: T): T => entry.carried || !changedDiff ? entry : { ...entry, reason: `${entry.reason}${changedDiff}` };
  return { ...base, approval: note(approval), evidence: evidence.map(note), ground };
}

export type CarryBearer = Pick<Work, 'candidate' | 'queue' | 'baseRefresh' | 'policyRevision'>;
/**
 * The carry decision that applies to the current candidate, under the current policy: the one
 * decided for the published merge-queue tip the candidate is, or the one decided when the control
 * plane brought the candidate onto a moved base branch. Both are Graphyard-authored merges of the
 * same reviewed head, decided by the same rule; a queued tip is the later of the two, so it wins.
 */
export function currentCarry(work: CarryBearer): QueueCarry | null {
  const candidate = work.candidate;
  if (!candidate) return null;
  const applies = (carry: QueueCarry | null | undefined) => carry && carry.to.sha === candidate.sha
    && carry.to.baseSha === candidate.baseSha && carry.policyRevision === work.policyRevision ? carry : null;
  const speculation = work.queue?.speculation;
  if (speculation?.tip === candidate.sha) { const carried = applies(speculation.carry); if (carried) return carried; }
  const refresh = work.baseRefresh;
  return refresh?.head === candidate.sha ? applies(refresh.carry) : null;
}
/**
 * True when a trusted evidence record binds the current candidate: exactly, or carried across a
 * Graphyard-authored commit. The decision names the exact record it carried, which is what lets a
 * record carried more than once — across a base refresh and then across the queue's own tip —
 * still be the one the latest decision names.
 */
export function evidenceBindsCandidate(work: CarryBearer, evidence: Pick<Evidence, 'id' | 'proof' | 'sha' | 'baseSha'>): boolean {
  const candidate = work.candidate;
  if (!candidate) return false;
  if (evidence.sha === candidate.sha && evidence.baseSha === candidate.baseSha) return true;
  const carry = currentCarry(work);
  return !!carry && carry.evidence.some(entry => entry.carried && entry.proof === evidence.proof && entry.evidenceId === evidence.id);
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
/**
 * The identity behind the approval the review gate currently accepts: the exact one, or the one
 * already carried onto this candidate. A second Graphyard-authored commit over the same reviewed
 * head decides from this, so a candidate the control plane refreshed and then queued does not lose
 * its review to the queue's own tip. The identity keeps the commit it actually approved.
 */
export function bindingApproval(work: Work): ApprovalIdentity | null {
  const exact = exactApproval(work);
  if (exact) return exact;
  const carried = carriedApproval(work);
  if (!carried) return null;
  const { carried: _carried, originalSha, reason: _reason, ...identity } = carried;
  return { ...identity, sha: originalSha };
}
