import type { Work } from './model.js';
import { baseRefreshConflict, ciAppIdsOf, requiredCheckRun, requiredChecksOf, requiredRunFailed } from './merge-queue.js';

/**
 * GY-1386. A rework the item's own record already called for is a round of the pipeline, not an
 * intervention.
 *
 * Interventions count the times the product needed somebody to step in. A rework round answering
 * a ground the loop's own rule acts on by itself (`neededDecision` in daemon/decisions.ts) — the
 * candidate conflicts with the base, a required check failed on it, a reviewer requested changes
 * on it, the guarded merge refused it for rework, a trusted proof failed on it — needs nobody: the
 * loop requests that rework itself, situated on the head and its grounds, and the risk lane or the
 * approver agent applies it. Between 2026-09-30 and 2026-10-07 the report filed 493 rework
 * interventions at the build stage: 377 the loop requested under its own situated binding and 109
 * a master session requested on a ground the record already showed. Only a
 * rework whose grounds the record does not show is somebody's judgement: an ejection that left no
 * owed round, a restore of files outside plannedFiles, an answer to a refusal.
 */

/** The work-document fields the grounds are read from: the projection the intervention ledger reads for a `rework` row. */
export const reworkGroundFields = ['candidate', 'observation', 'baseRefresh', 'policyRevision', 'policy', 'gates', 'mergeRefusal'] as const;
export type ReworkGroundsWork = Partial<Pick<Work, typeof reworkGroundFields[number]>>;

/**
 * The grounds of the loop's own rework rule a decision binding names, situated on the head it
 * names (`${sha}:${ground}…`, as `neededDecision`, `mechanicalRework` and `researchRework` write it).
 */
const situatedBinding = /^([0-9a-f]{40}):(conflict|sync|verdict|ci|proof|proof-exhausted|merge-refused|threads|mechanical|research)(?::|$)/;

/**
 * The routine ground a rework answered, or null when the record shows none. `work` is the item's
 * document as the rework row left it (a rework keeps the candidate and its observation), and
 * `binding` the situated binding of the decision that requested it, when one did.
 */
export function routineReworkGround(work: ReworkGroundsWork | null | undefined, binding?: string | null): string | null {
  const candidate = work?.candidate ?? null;
  const bound = typeof binding === 'string' ? situatedBinding.exec(binding) : null;
  if (bound && candidate?.sha === bound[1]) return bound[2];
  const observation = work?.observation;
  if (!work || !candidate || !observation) return null;
  if (work.policyRevision !== undefined && baseRefreshConflict(work as Pick<Work, 'candidate' | 'observation' | 'baseRefresh' | 'policyRevision'>)) return 'conflict';
  if (work.mergeRefusal?.action === 'rework' && work.mergeRefusal.sha === candidate.sha) return 'merge-refused';
  // What GitHub reports for exactly this head: a conflict with the base, a failed required check, a change request.
  if (observation.candidate?.sha !== candidate.sha) return null;
  if (observation.conflicting === true && !observation.merged) return 'sync';
  const ciAppIds = ciAppIdsOf(work as Pick<Work, 'gates'>);
  if (requiredChecksOf(work as Pick<Work, 'policy' | 'observation'>).some(check => requiredRunFailed(check, requiredCheckRun(check, observation.checks ?? [], ciAppIds)))) return 'ci';
  if ((observation.reviews ?? []).some(review => review.sha === candidate.sha && review.state === 'CHANGES_REQUESTED')) return 'verdict';
  const agent = observation.agentReview;
  if (agent && agent.sha === candidate.sha && !agent.approved && agent.verdict === 'changes-requested') return 'verdict';
  return null;
}
