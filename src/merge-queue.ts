import type { Observation, Work } from './model.js';
import { evidenceBindsCandidate, type QueueCarry, type TipMerge } from './model/carry.js';

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
 * Explicit, observed failure of a queued entry's speculative validation. Missing or pending
 * inputs keep an entry queued; only a reported adverse result removes it.
 */
export function ejectionReason(work: Work, ciAppIds: number[]): string | null {
  if (!work.queue || work.stage === 'done' || work.observation?.merged) return null;
  if (!work.submission || work.reworkRequested) return 'Implementation returned to the worker for a new attempt';
  if (work.policyRevision !== work.queue.policyRevision) return `Policy revision changed from ${work.queue.policyRevision} to ${work.policyRevision} after this entry was queued`;
  if (work.blocker) return `Queued work was blocked: ${work.blocker}`;
  if (work.violations.length) return `Queued work has an open violation: ${work.violations[0]}`;
  const candidate = work.candidate, observation = work.observation;
  if (!candidate || !observation || observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha) return null;
  const tip = candidate.sha.slice(0, 12);
  if (observation.prState === 'closed') return 'Pull request was closed without merging';
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
