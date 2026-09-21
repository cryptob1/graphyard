import type { Observation, ScopeFile, Work } from './model.js';
import { evidenceBindsCandidate, type QueueCarry, type TipMerge } from './model/carry.js';
import { queuedRegressions } from './regression-guard.js';

// Graphyard publishes speculative tips outside refs/heads and refs/tags: the namespace is
// owned by the App, is never a branch a worker can push, and never appears as a PR head.
export function queueRef(key: string) { return `refs/graphyard/queue/${key.toLowerCase()}`; }

export interface QueueSpeculation {
  ref: string; tip: string; base: string; baseTree: string;
  predecessors: string[]; policyRevision: number; publishedAt: string;
  /** How Graphyard produced the tip, when it replaced the head; absent when the head already contained its base. */
  merge?: TipMerge | null;
  /** Which bindings of the replaced head carried to the tip, decided when the tip was bound. */
  carry?: QueueCarry | null;
  /** The base-branch commit the bound base was last found tree-identical to: the advance that carried the binding. */
  carriedBase?: { sha: string; tree: string; at: string } | null;
}
export interface QueueEntry { sequence: number; enqueuedAt: string; policyRevision: number; speculation: QueueSpeculation | null }
export interface QueueEjection { at: string; sequence: number; reason: string; sha: string | null; policyRevision: number }
export interface QueueHistoryEntry { at: string; event: 'enqueued' | 'predicted' | 'ejected'; sequence: number; reason?: string; tip?: string }
export interface QueuePlacement {
  id: string; key: string; position: number; size: number; sequence: number; enqueuedAt: string; waitMs: number;
  predecessors: string[]; predictedBase: string | null; tip: string | null;
  /** The base-branch commit the chain of predictions rests on, as the head entry observed it. */
  base: { sha: string; tree: string | null } | null;
  /** How a current entry binds its predicted base: the exact commit, or a tree-identical advance of it. */
  binding: 'exact' | 'tree-equivalent' | null;
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
 * The refresh this candidate is waiting for, or null when it needs none. A queued entry refreshes
 * through its own speculative tip, so the queue keeps its entries; everything else in flight — a
 * candidate still in review, still running CI, still collecting proofs — is refreshed here. One
 * attempt per head, base tip and policy revision: a refresh already recorded for the same three is
 * never repeated, so neither a conflict nor a published head makes the reconciliation job spin.
 */
export function baseRefreshNeeded(work: Work): { head: string; boundBase: string; baseTip: string } | null {
  const candidate = work.candidate, observation = work.observation;
  if (!work.submission || work.reworkRequested || work.stage === 'done' || work.queue || work.blocker) return null;
  if (!candidate || !observation || observation.merged || observation.prState === 'closed' || observation.draft) return null;
  if (observation.candidate.sha !== candidate.sha) return null;
  const baseTip = observation.baseTip;
  if (observation.baseTipContained !== false || !baseTip || baseTip === candidate.baseSha) return null;
  const refresh = work.baseRefresh;
  if (refresh && refresh.from.sha === candidate.sha && refresh.base === baseTip && refresh.policyRevision === work.policyRevision) return null;
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
export interface LandingCheck {
  base: string;
  files?: ScopeFile[];
  carried?: CarriedCandidate[];
  /** The open candidates `carried` was decided against, as `KEY@head`, so an unchanged answer is not asked for again. */
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

export function predictQueue(all: Work[], now: number): QueuePlacement[] {
  const entries = queueOrder(all);
  const placements: QueuePlacement[] = [];
  for (const [position, work] of entries.entries()) {
    const entry = work.queue!, candidate = work.candidate, speculation = entry.speculation;
    // Entry 0 predicts against the observed base branch; every other entry predicts against the
    // validated tip of the entry directly ahead, which is what main will hold once it merges.
    const predictedBase = position === 0 ? observedBaseTip(work) : placements[position - 1].tip;
    const base = position === 0 ? predictedBase ? { sha: predictedBase, tree: work.observation?.baseTree ?? null } : null : placements[position - 1].base;
    const published = !!speculation && !!candidate && speculation.tip === candidate.sha
      && speculation.base === candidate.baseSha && speculation.policyRevision === work.policyRevision;
    const onPrediction = !!candidate && !!predictedBase && candidate.baseSha === predictedBase;
    // An earlier queue merge advances the base branch to a new commit whose tree is exactly the
    // validated base's tree. Re-binding to that advance needs no new commit, so the published tip,
    // the candidate, the review and every proof stay bound; the advance is recorded, not republished.
    const treeEquivalent = !onPrediction && position === 0 && published && !!work.observation?.baseTree && work.observation.baseTree === speculation!.baseTree;
    // Only a Graphyard-published tip may land. Publication is what proves the validated commit
    // already contains its predicted base, so the merge result is that commit's tested tree even
    // though the candidate branch is deliberately behind the base branch while it waits its turn.
    const current = published && (onPrediction || treeEquivalent);
    const reasons: string[] = [];
    if (position > 0) reasons.push(`Merge queue position ${position + 1} of ${entries.length}: ${entries[position - 1].key} is ahead`);
    if (!current) reasons.push(predictedBase
      ? `Speculative tip on predicted base ${predictedBase.slice(0, 12)} has not been published and validated for this candidate`
      : `Waiting for ${entries[position - 1]?.key ?? 'the queue head'} to publish its speculative tip`);
    placements.push({
      id: work.id, key: work.key, position, size: entries.length, sequence: entry.sequence, enqueuedAt: entry.enqueuedAt,
      waitMs: Math.max(0, now - Date.parse(entry.enqueuedAt)), predecessors: entries.slice(0, position).map(ahead => ahead.key),
      predictedBase, tip: current && candidate ? candidate.sha : null, base, binding: current ? treeEquivalent ? 'tree-equivalent' : 'exact' : null, current,
      publishable: !current && !!predictedBase && !!candidate, reasons,
    });
  }
  return placements;
}
/**
 * True for a merge-gate reason that only sequences a queued candidate: it is waiting its turn
 * or for its speculative tip, not refused by protection, mergeability, freshness, or a hold.
 * Kept beside the messages above so a wording change is visible here.
 */
export function queueSequencingReason(reason: string) {
  return /^(Merge queue position \d+ of \d+: |Speculative tip on predicted base [0-9a-f]+ has not been published|Waiting for \S+ to publish its speculative tip$)/.test(reason);
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
