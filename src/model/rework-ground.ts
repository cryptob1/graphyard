import type { Work } from './work.js';
import type { Decision } from './approval.js';
import { mechanicalVerdicts, producerManualFailures } from './mechanical-proofs.js';
import { pendingBaseRefresh } from '../merge-queue.js';

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
export function reworkGround(work: Work, decisions: readonly GroundDecision[], now = new Date()): string | null {
  const candidate = work.candidate;
  if (!candidate || !work.submission || work.stage === 'done' || work.observation?.merged) return null;
  const head = candidate.sha.slice(0, 12);
  const failed = [...mechanicalVerdicts(work, [work], now).filter(verdict => verdict.outcome === 'failed'), ...producerManualFailures(work, [work], now)];
  if (failed.length) return `a trusted proof failed on candidate ${head} (${[...new Set(failed.map(verdict => verdict.proof))].sort().join(', ')})`;
  const refused = refusedAttestation(work, decisions);
  if (refused) return `${refused.refusal?.approver ?? 'an approver'} refused the attestation of ${refused.input.proof} on candidate ${head} (decision ${refused.id})`;
  const observation = work.observation;
  // A conflict reading is not trusted while the control plane's own test merge onto the moved base
  // is pending: GitHub can report a clean head conflicting until it decides (`syncConflict`).
  if (observation?.conflicting && observation.candidate.sha === candidate.sha && observation.prState !== 'closed' && !pendingBaseRefresh(work))
    return `GitHub reports candidate ${head} conflicting with its base`;
  return null;
}

/** The decision fields the ground reads. */
export type GroundDecision = Pick<Decision, 'id' | 'action' | 'input' | 'refusal'> & { state: string };

/** The refused attestation bound to exactly the current candidate, base and policy revision, or null. */
export function refusedAttestation<T extends GroundDecision>(work: Pick<Work, 'candidate' | 'policyRevision'>, decisions: readonly T[]): T | null {
  const candidate = work.candidate;
  if (!candidate) return null;
  return decisions.find(decision => decision.action === 'attest' && decision.state === 'refused' && decision.input?.result === 'pass'
    && decision.input?.sha === candidate.sha && decision.input?.baseSha === candidate.baseSha && decision.input?.policyRevision === work.policyRevision) ?? null;
}

/** GY-1394. An attest decision's refusal and the head it bound, as the loop's approval watch keeps it. */
export interface AttestationRefusal { approver: string; reason: string; at: string; proof: string; sha: string; baseSha: string; policyRevision: number }
/** A refused attestation and the decision it refused, as the loop reads it from its watches. */
export interface RefusedAttestation { decision: string; refusal: AttestationRefusal }
const bound = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * The refusal an approver recorded on an attest decision, as the watch keeps it, or null. Only an
 * attestation of a pass bound to a head counts: the refusal judges exactly that head.
 */
export function refusedAttestationWatch(judged: { action?: string; state: string; input?: any; refusal?: { approver: string; reason: string; at?: string } | null } | null | undefined): AttestationRefusal | null {
  const input = judged?.input;
  if (!judged || judged.state !== 'refused' || judged.action !== 'attest' || input?.result !== 'pass' || typeof input.sha !== 'string' || typeof input.baseSha !== 'string' || typeof input.policyRevision !== 'number') return null;
  return { approver: judged.refusal?.approver ?? 'its approver', reason: bound(judged.refusal?.reason ?? 'no reason recorded', 1200), at: judged.refusal?.at ?? new Date().toISOString(),
    proof: String(input.proof).slice(0, 200), sha: input.sha, baseSha: input.baseSha, policyRevision: input.policyRevision };
}

/**
 * The rework a refused attestation of exactly the current head calls for, or null. The approver
 * judged the head and found the manual proof does not hold on it; the refusal stands for that head
 * (GY-141), so nothing but a new head can pass the proof. Before this the refusal was escalated,
 * and a master turned it into a rework by hand that a second approver then judged (GY-1098 on
 * 2026-10-03, twice). The server applies it with no approver: the refusal is its ground.
 */
export function refusedAttestationRework(work: Work, refused: readonly RefusedAttestation[]): { reason: string; binding: string } | null {
  const candidate = work.candidate;
  if (!work.submission || work.reworkRequested || !candidate || work.stage === 'done' || work.observation?.merged) return null;
  const entry = refused.find(({ refusal }) => refusal.sha === candidate.sha && refusal.baseSha === candidate.baseSha && refusal.policyRevision === work.policyRevision);
  if (!entry) return null;
  return { reason: `${work.key}: ${entry.refusal.approver} refused the attestation of ${entry.refusal.proof} on candidate ${candidate.sha.slice(0, 12)} (decision ${entry.decision}): "${bound(entry.refusal.reason, 1200)}". The refusal stands for this head, so the item returns to a worker to fix what it names and push a new head, whose attestation is requested afresh.`,
    binding: `${candidate.sha}:attest-refused:${entry.decision}` };
}
