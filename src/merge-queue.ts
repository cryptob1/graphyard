import type { Work } from './model.js';

// Graphyard publishes speculative tips outside refs/heads and refs/tags: the namespace is
// owned by the App, is never a branch a worker can push, and never appears as a PR head.
export function queueRef(key: string) { return `refs/graphyard/queue/${key.toLowerCase()}`; }

export interface QueueSpeculation {
  ref: string; tip: string; base: string; baseTree: string;
  predecessors: string[]; policyRevision: number; publishedAt: string;
}
export interface QueueEntry { sequence: number; enqueuedAt: string; policyRevision: number; speculation: QueueSpeculation | null }
export interface QueueEjection { at: string; sequence: number; reason: string; sha: string | null; policyRevision: number }
export interface QueueHistoryEntry { at: string; event: 'enqueued' | 'predicted' | 'ejected'; sequence: number; reason?: string; tip?: string }
export interface QueuePlacement {
  id: string; key: string; position: number; size: number; sequence: number; enqueuedAt: string; waitMs: number;
  predecessors: string[]; predictedBase: string | null; tip: string | null;
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
    const published = !!speculation && !!candidate && speculation.tip === candidate.sha
      && speculation.base === candidate.baseSha && speculation.policyRevision === work.policyRevision;
    // An earlier queue merge advances the base branch without changing the validated tree.
    // Re-binding to that advance needs no new commit, so no proof or review is invalidated.
    const treeEquivalent = position === 0 && published && !!work.observation?.baseTree && work.observation.baseTree === speculation!.baseTree;
    const onPrediction = !!candidate && !!predictedBase && candidate.baseSha === predictedBase;
    const current = position === 0 ? onPrediction || treeEquivalent : onPrediction && published;
    const reasons: string[] = [];
    if (position > 0) reasons.push(`Merge queue position ${position + 1} of ${entries.length}: ${entries[position - 1].key} is ahead`);
    if (!current) reasons.push(predictedBase
      ? `Speculative tip on predicted base ${predictedBase.slice(0, 12)} has not been published and validated for this candidate`
      : `Waiting for ${entries[position - 1]?.key ?? 'the queue head'} to publish its speculative tip`);
    placements.push({
      id: work.id, key: work.key, position, size: entries.length, sequence: entry.sequence, enqueuedAt: entry.enqueuedAt,
      waitMs: Math.max(0, now - Date.parse(entry.enqueuedAt)), predecessors: entries.slice(0, position).map(ahead => ahead.key),
      predictedBase, tip: current && candidate ? candidate.sha : null, current,
      publishable: !current && !!predictedBase && !!candidate, reasons,
    });
  }
  return placements;
}
export function queuePlacement(work: Work, all: Work[], now: number) {
  return predictQueue(all, now).find(placement => placement.id === work.id) ?? null;
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
  const check = work.policy.checks.find(name => observation.checks.some(run => run.name === name && ciAppIds.includes(run.appId) && failedConclusions.has(run.result)));
  if (check) return `Required CI check ${check} did not pass on speculative tip ${tip}`;
  if (observation.reviews.some(review => review.sha === candidate.sha && review.state === 'CHANGES_REQUESTED')) return `Review requested changes on speculative tip ${tip}`;
  const proof = work.evidence.find(item => item.trusted && item.result === 'fail' && item.sha === candidate.sha
    && item.baseSha === candidate.baseSha && item.policyRevision === work.policyRevision);
  if (proof) return `Proof ${proof.proof} failed on speculative tip ${tip}`;
  return null;
}
