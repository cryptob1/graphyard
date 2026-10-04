// Concern: GY-1177 dead-proof re-scopes — the requirements revision retiring a proof that cannot
// exercise a criterion its other proofs already prove, and the resolve of the narrowing it raises.
import { type Work, standingEscalations } from '../model.js';
import { coveredDeadProofs, deadProofDetail, mechanicalVerdicts, producerManualFailures, rescopedCriteria, retiresProof } from '../model/mechanical-proofs.js';
import { decisionBindingMax } from '../model/approval.js';
import type { RoutineDecision } from './decisions.js';

/**
 * GY-1177. The criterion re-scope a dead proof calls for, or null: a unit or integration proof the
 * producer recorded as not exercising a criterion whose other proofs already prove it on the
 * candidate with trusted, exercised evidence. No production round revives such a proof (GY-1132,
 * GY-1131 and GY-1142 reworked it for days), so the loop requests the requirements revision
 * retiring it from the criterion, judged by the independent approver like any narrowing, and the
 * engine records the requirement-weakening escalation that revision raises. A failed proof on the
 * head is the worker's first: the change itself is wrong, so rework stands and this waits. A dead
 * proof whose re-scope an approver refused (`refusedRescope`) is not asked about again: proofRework
 * returns its finding to the worker, so a refusal never leaves the item waiting on itself.
 */
export function rescopeDecision(work: Work, refusedRescope: readonly string[] = []): RoutineDecision | null {
  const candidate = work.candidate;
  if (!work.submission || work.reworkRequested || !candidate || work.stage === 'done' || work.observation?.merged) return null;
  const now = new Date();
  if (mechanicalVerdicts(work, [work], now).some(verdict => verdict.outcome === 'failed') || producerManualFailures(work, [work], now).length) return null;
  const dead = coveredDeadProofs(work, now, refusedRescope);
  if (!dead.length) return null;
  return { action: 'requirements', input: { criteria: rescopedCriteria(work, dead) },
    binding: `${candidate.sha}:rescope:${dead.map(entry => `${entry.criteria.join('+')}:${entry.proof}`).sort().join(',')}`.slice(0, decisionBindingMax),
    reason: `${work.key}: ${dead.map(entry => deadProofDetail(entry, candidate.sha)).join('; ')}. The criterion is proven, only the binding is dead, so no production round can revive it: approve retiring the proof from the criterion (a narrowing, recorded as requirement-weakening; the new policy revision has the covering proofs produced once more on this head), or refuse with the reason if the covering proofs do not assert the criterion's statement, and the finding returns to the worker as rework.`.slice(0, 2000) };
}

/** GY-1177. What the decision history says of an item's dead-proof re-scopes: see rescopeOutcomes. */
export interface RescopeOutcomes { refused: string[]; applied: { id: string } | null }
export const noRescopeOutcomes: RescopeOutcomes = { refused: [], applied: null };
type HistoryEntry = { id?: string; action: string; state: string; input?: any; reason?: string };
/** The words every re-scope reason carries, so the history tells a re-scope from any other requirements revision. */
const rescopeMark = 'only the binding is dead';
const sameCriteria = (a: readonly { id: string; text: string; proofs: readonly string[] }[], b: readonly { id: string; text: string; proofs: readonly string[] }[]) =>
  a.length === b.length && a.every(criterion => { const other = b.find(entry => entry.id === criterion.id); return !!other && other.text === criterion.text && other.proofs.length === criterion.proofs.length && other.proofs.every(proof => criterion.proofs.includes(proof)); });
/**
 * GY-1177. Read from the decision history, not the loop's watch, so a judgement stands across a
 * lost cursor or a restart. `refused`: the dead proofs on the current head whose re-scope an
 * approver refused — a refused `requirements` decision at the item's policy revision whose criteria
 * retire the proof; the control plane binds a requirements decision to its input and revision,
 * never to a head, so the refusal stands for every head until the criteria or the revision move.
 * `applied`: the re-scope the item's current criteria came from, when it is the latest applied
 * requirements revision — the narrowing whose requirement-weakening escalation rescopeResolve settles.
 */
export function rescopeOutcomes(work: Work, history: readonly HistoryEntry[]): RescopeOutcomes {
  const refused = history.filter(entry => entry.action === 'requirements' && entry.state === 'refused' && !entry.input?.answers
    && entry.input?.expectedPolicyRevision === work.policyRevision && Array.isArray(entry.input?.criteria));
  const latest = history.filter(entry => entry.action === 'requirements' && entry.state === 'applied').at(-1);
  const applied = latest?.id && latest.reason?.includes(rescopeMark) && Array.isArray(latest.input?.criteria) && sameCriteria(latest.input.criteria, work.criteria) ? { id: latest.id } : null;
  return { refused: refused.length ? coveredDeadProofs(work).map(entry => entry.proof).filter(proof => refused.some(entry => retiresProof(work, entry.input.criteria, proof))) : [], applied };
}
/** The dead proofs whose re-scope an approver refused: rescopeOutcomes' `refused`. */
export const refusedRescopes = (work: Work, history: readonly HistoryEntry[]) => rescopeOutcomes(work, history).refused;
/**
 * GY-1177. The resolve the requirement-weakening escalation an applied re-scope raised calls for,
 * or null. The engine records every narrowing as requirement-weakening, and the merge gate holds
 * until it is resolved; the narrowing was the loop's own request, already judged by the independent
 * approver, so the loop asks for its resolution too rather than leave the item at merge for a person.
 * Only the escalation the re-scope raises — it retires no criterion — is asked about.
 */
export function rescopeResolve(work: Work, rescope: RescopeOutcomes): RoutineDecision | null {
  if (!rescope.applied) return null;
  const escalation = standingEscalations(work).find(entry => entry.trigger === 'requirement-weakening' && /^Requirement revision retires no criterion and narrows proofs for /.test(entry.reason));
  return escalation ? { action: 'resolve', input: { trigger: 'requirement-weakening' }, escalation: { trigger: 'requirement-weakening', at: escalation.at }, binding: `rescope:${rescope.applied.id}:${escalation.at}`,
    reason: `${work.key}: the requirement-weakening escalation raised at ${escalation.at} (${escalation.reason}) is the narrowing of re-scope decision ${rescope.applied.id}, which the independent approver applied: it retired only proofs recorded as not exercising criteria their other proofs prove with trusted, exercised evidence. Resolving clears only this concern: it decides no gate and ships nothing.`.slice(0, 2000) } : null;
}
