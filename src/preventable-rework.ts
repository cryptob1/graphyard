import type { Work } from './model/work.js';
import { mechanicalProof } from './model/dispatch.js';
import type {} from './pipeline-speed.js';

/**
 * Preventable rework (GY-115 AC-4): how many rework rounds were triggered by a criterion an
 * automatable proof could have caught, and whether a reviewer had already been spent on them.
 *
 * A *returned head* is a head of a delivered item other than the one it delivered. It was
 * *catchable* when trusted evidence recorded a unit or integration proof of the item's own
 * criteria failing on it — or passing only as unexercised — since a machine then already knew
 * what a reviewer went on to find. It *reached review* when a review request was raised for it.
 * Before mechanical verification preceded review, a catchable head was typically reviewed first;
 * after, it is returned with the criterion named and no reviewer session is consumed. The measure
 * is read from each item's own record — its evidence and its dispatch history — so the claim is
 * settled by this repository's timelines rather than asserted. Nothing here authorizes anything.
 */
export interface ReturnedHead { key: string; sha: string; criteria: string[]; proofs: string[]; reachedReview: boolean }
export interface PreventableReworkSummary {
  window: { since: string | null; until: string | null };
  /** Delivered items merged inside the window. */
  items: number;
  /** Rework rounds those items recorded (the pipeline timeline's count). */
  reworkRounds: number;
  /** Heads the items were returned from: every evaluated head but the delivered one. */
  returnedHeads: number;
  /** Returned heads a mechanical proof of the item's criteria had caught. */
  catchable: number;
  /** Of those, the heads a reviewer was asked about anyway: the judgment this item removes. */
  catchableAfterReview: number;
  /** Of those, the heads returned before any review request: the mechanical path working. */
  catchableBeforeReview: number;
  heads: ReturnedHead[];
}

const mergedAt = (item: Work) => item.stage === 'done' && item.delivery ? item.delivery.mergedAtRepository ?? item.delivery.mergedAt : null;

/** The returned heads of one delivered item, with what caught each and whether it reached review. */
export function returnedHeads(item: Work): ReturnedHead[] {
  const delivered = item.candidate?.sha;
  const reviewed = new Set([...(item.autoDispatch?.history ?? []), ...(item.autoDispatch?.review ? [item.autoDispatch.review] : [])]
    .filter(request => request.kind === 'review').map(request => request.sha));
  if (item.reviewRequest) reviewed.add(item.reviewRequest.sha);
  for (const review of item.observation?.reviews ?? []) reviewed.add(review.sha);
  const required = new Map<string, string[]>();
  for (const criterion of item.criteria ?? []) for (const proof of criterion.proofs) if (mechanicalProof(proof)) required.set(proof, [...(required.get(proof) ?? []), criterion.id]);
  const heads = new Map<string, ReturnedHead>();
  const head = (sha: string) => heads.get(sha) ?? heads.set(sha, { key: item.key, sha, criteria: [], proofs: [], reachedReview: reviewed.has(sha) }).get(sha)!;
  for (const sha of reviewed) if (sha !== delivered) head(sha);
  for (const evidence of item.evidence ?? []) {
    if (evidence.sha === delivered) continue;
    const entry = head(evidence.sha);
    const caught = evidence.trusted && !evidence.revocation && required.has(evidence.proof) && (evidence.result === 'fail' || !!evidence.unexercised);
    if (caught && !entry.proofs.includes(evidence.proof)) {
      entry.proofs.push(evidence.proof);
      for (const id of required.get(evidence.proof)!) if (!entry.criteria.includes(id)) entry.criteria.push(id);
    }
  }
  return [...heads.values()];
}

export function preventableRework(work: Work[], window: { since?: string | null; until?: string | null } = {}): PreventableReworkSummary {
  const since = window.since ? Date.parse(window.since) : -Infinity, until = window.until ? Date.parse(window.until) : Infinity;
  const items = work.filter(item => { const at = mergedAt(item); return !!at && Date.parse(at) >= since && Date.parse(at) < until; });
  const heads = items.flatMap(returnedHeads);
  const catchable = heads.filter(head => head.proofs.length);
  return {
    window: { since: window.since ?? null, until: window.until ?? null }, items: items.length,
    reworkRounds: items.reduce((sum, item) => sum + (item.pipeline?.reworkRounds ?? 0), 0),
    returnedHeads: heads.length, catchable: catchable.length,
    catchableAfterReview: catchable.filter(head => head.reachedReview).length,
    catchableBeforeReview: catchable.filter(head => !head.reachedReview).length,
    heads: catchable,
  };
}
