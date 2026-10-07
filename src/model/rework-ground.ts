import type { Work } from './work.js';
import type { Decision } from './approval.js';
import { mechanicalVerdicts, producerManualFailures } from './mechanical-proofs.js';

/** The ledger's approver of a rework the control plane applied itself: by its risk lane (GY-883) or on its recorded ground. */
export const laneApprover = 'graphyard-risk-lane';

/**
 * GY-1394. The ground on which a rework of the current head needs no approver decision, or null.
 *
 * A rework decision asks an independent approver to confirm that the head cannot progress and
 * that returning it to a worker weakens nothing. In the week to 2026-10-07, 25 rework decisions
 * at the acceptance stage waited on that approver (or a master by hand) although the record had
 * already decided the question: a trusted producer's proof had failed on the exact head (17), an
 * approver had refused the head's attestation (3), GitHub reported the head conflicting with its
 * base (2), or the producers were spent (3, already applied by the risk lane). An approver can only
 * re-read what the record shows, so the control plane reads it itself:
 *
 * - a trusted proof (mechanical, or a producer-run manual proof that executed cases) failed on
 *   the current candidate — the producer is the independent judge, and no gate passes such a head;
 * - an approver refused the attestation of a manual proof bound to the current candidate, base and
 *   policy revision — that refusal is the independent judgement, and it stands for the head
 *   (GY-141), so the proof can never pass on it;
 * - GitHub reports the current candidate conflicting with its base — only a new head moves it.
 *
 * Every other rework, in particular one resting only on the requester's own judgement, still
 * waits for its approver on a high-lane item (GY-883).
 */
/** The decision fields the ground reads. */
export type GroundDecision = Pick<Decision, 'id' | 'action' | 'input' | 'refusal'> & { state: string };
export function reworkGround(work: Work, decisions: readonly GroundDecision[], now = new Date()): string | null {
  const candidate = work.candidate;
  if (!candidate || !work.submission || work.stage === 'done' || work.observation?.merged) return null;
  const head = candidate.sha.slice(0, 12);
  const failed = [...mechanicalVerdicts(work, [work], now).filter(verdict => verdict.outcome === 'failed'), ...producerManualFailures(work, [work], now)];
  if (failed.length) return `a trusted proof failed on candidate ${head} (${[...new Set(failed.map(verdict => verdict.proof))].sort().join(', ')})`;
  const refused = refusedAttestation(work, decisions);
  if (refused) return `${refused.refusal?.approver ?? 'an approver'} refused the attestation of ${refused.input.proof} on candidate ${head} (decision ${refused.id})`;
  const observation = work.observation;
  if (observation?.conflicting && observation.candidate.sha === candidate.sha && observation.prState !== 'closed')
    return `GitHub reports candidate ${head} conflicting with its base`;
  return null;
}

/** The refused attestation bound to exactly the current candidate, base and policy revision, or null. */
export function refusedAttestation<T extends GroundDecision>(work: Pick<Work, 'candidate' | 'policyRevision'>, decisions: readonly T[]): T | null {
  const candidate = work.candidate;
  if (!candidate) return null;
  return decisions.find(decision => decision.action === 'attest' && decision.state === 'refused' && decision.input?.result === 'pass'
    && decision.input?.sha === candidate.sha && decision.input?.baseSha === candidate.baseSha && decision.input?.policyRevision === work.policyRevision) ?? null;
}
