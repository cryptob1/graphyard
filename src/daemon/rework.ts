// Concern: the loop's routine rework — a head nothing can carry forward goes back to a worker at once, under the master's own identity.
import { type Work, type AgentReview, reviewProviderOf } from '../model.js';
import { baseRefreshConflict, pendingBaseRefresh } from '../model/base-refresh.js';
import { mechanicalFailure, mechanicalProof, mechanicalVerdicts, producerManualFailure, producerManualFailures } from '../model/mechanical-proofs.js';
import { unactedProducerAttempts, unexercisedFindings } from '../auto-dispatch.js';
import { mechanicalRework, type MechanicalFixRequest } from '../mechanical-findings.js';
import { reworkBriefMax } from '../master/rework-brief.js';

export interface StandingVerdict { reviewer: string; at: string; reason: string }
/**
 * What a control-plane CHANGES_REQUESTED entry tells the next worker: its BLOCKING findings, or the
 * body when it named none, cut so the rework brief still fits reworkBriefMax (GY-2946).
 */
function controlPlaneReworkDetail(review: { blocking?: string[]; body?: string }): string {
  const text = (review.blocking?.length ? review.blocking.map(finding => `BLOCKING: ${finding}`).join('\n') : review.body?.trim()) ?? '';
  if (!text) return '';
  return text.length > reworkBriefMax ? `${text.slice(0, reworkBriefMax)}…` : text;
}
/**
 * The binding `exactApproval` demands of an approval, demanded of a change request too: the verdict
 * answers the request Graphyard recorded for this candidate, base and policy revision, under the
 * provider the policy names. A verdict left over from an earlier request is not the head's.
 */
function agentVerdictBindsRequest(work: Work, agent: AgentReview): boolean {
  const candidate = work.candidate!, request = work.reviewRequest;
  return agent.provider === reviewProviderOf(work.policy) && !!request && request.commentId === agent.requestId
    && request.sha === candidate.sha && request.baseSha === candidate.baseSha && request.policyRevision === work.policyRevision;
}
/**
 * The change request standing against the exact current candidate. Observations keep one review
 * per reviewer, so a CHANGES_REQUESTED entry on the head is the reviewer's latest word on it; an
 * agent provider records `verdict: 'changes-requested'` on the head instead. `approved: false` alone
 * is never a verdict: the observers report it for a review not yet dispatched or still running.
 */
export function standingVerdict(work: Work): StandingVerdict | null {
  const candidate = work.candidate, observation = work.observation;
  if (!work.submission || work.reworkRequested || !candidate || !observation) return null;
  if (observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha) return null;
  const review = observation.reviews.find(entry => entry.sha === candidate.sha && entry.state === 'CHANGES_REQUESTED');
  if (review) {
    const detail = controlPlaneReworkDetail(review);
    return { reviewer: review.reviewer, at: review.submittedAt ?? observation.at, reason: `${review.reviewer} requested changes on ${review.sha.slice(0, 12)}${detail ? `: ${detail}` : ''}` };
  }
  const agent = observation.agentReview;
  if (agent && agent.sha === candidate.sha && !agent.approved && agent.verdict === 'changes-requested' && agentVerdictBindsRequest(work, agent))
    return { reviewer: agent.profile ?? agent.provider, at: agent.completedAt ?? observation.at, reason: `${agent.profile ?? agent.provider} requested changes on ${agent.sha.slice(0, 12)}: ${agent.reason}` };
  return null;
}

/**
 * GY-144. Rework throws away a current review and its proofs, so it is applied only on an
 * observation that still describes the item: one taken within the last two minutes, or the loop's
 * own woken observation of the submitted head (GY-1266, GY-1257). Otherwise the loop wakes one.
 */
export const reworkObservationMaxAgeMs = 120_000;
export function reworkObservationWait(work: Work, now: number, wokenAt?: string | null): string | null {
  const observation = work.observation;
  if (!observation) return `${work.key}: rework waits for an observation of the item; there is none to decide from`;
  const seen = `the last observation (taken at ${observation.at} of head ${observation.candidate.sha.slice(0, 12)})`;
  const age = now - Date.parse(observation.at);
  if (wokenAt && Date.parse(observation.at) > Date.parse(wokenAt) && observation.candidate.sha === work.candidate?.sha) return null;
  if (!(Number.isFinite(age) && age < reworkObservationMaxAgeMs)) return `${work.key}: rework waits for a fresh observation — ${seen} is a stale observation, older than two minutes, and the branch may have moved past that head`;
  return null;
}
/**
 * GY-710. A rework waiting for a fresh observation wakes the item's observation job and waits for it
 * to land; a wake that brought none within this bound is sent again.
 */
export const observationWakeRetryMs = 5 * 60_000;
export function observationWakeDue(work: Work, wokenAt: string | null | undefined, now: number): boolean {
  if (!work.submission) return false;
  const woken = wokenAt ? Date.parse(wokenAt) : Number.NaN;
  if (!Number.isFinite(woken)) return true;
  const observed = work.observation ? Date.parse(work.observation.at) : Number.NaN;
  if (Number.isFinite(observed) && observed > woken) return true;
  return now - woken >= observationWakeRetryMs;
}

/** A rework the item needs: why, and the grounds it binds (head and ground), so one head is reworked once per ground. */
export interface Rework { reason: string; binding: string }
/**
 * The rework one item needs right now, or null: a head nothing can carry forward — a base conflict,
 * a standing change request, a failed or unexercised proof, spent producers or a planned mechanical fix — goes back to a worker. Every blocking review finding reworks
 * the head once per submission, with no cap.
 */
export function neededRework(work: Work, exhausted: readonly ExhaustedProof[] = [], mechanical: readonly MechanicalFixRequest[] = []): Rework | null {
  if (work.stage === 'done' || work.reworkRequested) return null;
  const conflict = baseRefreshConflict(work);
  if (conflict) return { reason: `${work.key}: ${conflict}. Only a fresh attempt can resolve it, so the candidate returns to a worker.`, binding: `${work.candidate!.sha}:conflict` };
  const sync = syncConflict(work);
  if (sync) return { reason: `${work.key}: ${sync.reason}. Only a sync can resolve it (graphyard sync ${work.key}: merge the base, resolve, push), so the candidate returns to a worker.`, binding: sync.binding };
  const verdict = standingVerdict(work);
  if (verdict) return { reason: `${work.key}: ${verdict.reason}. The verdict stands against the current head, so the item returns to a worker for the next round.`, binding: `${work.candidate!.sha}:verdict:${verdict.reviewer}` };
  return proofRework(work) ?? exhaustedProofRework(work, exhausted) ?? mechanicalRework(work, mechanical);
}

/**
 * GY-496. A producer request the loop stopped attempting: every automatic session it launched for
 * the head's proof group ended without trusted evidence (auto-dispatch.ts `abandon`).
 */
export interface ExhaustedProof { requestId: string; work: string; sha: string; group: string | null; proofs: string[]; attempts: string[]; reason: string }
const groupName = (entry: ExhaustedProof) => `the ${entry.group ?? 'producer'} proof group${entry.proofs.length ? ` (${entry.proofs.join(', ')})` : ''}`;
const quoteAttempts = (entry: ExhaustedProof, limit = 1600) => { const text = entry.attempts.map(attempt => `"${attempt}"`).join('; '); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text || 'no attempt recorded'; };
/** The rework an item whose proof requests are spent calls for, once the attention has stood a cycle, or null. */
export function exhaustedProofRework(work: Work, exhausted: readonly ExhaustedProof[]): Rework | null {
  const candidate = work.candidate;
  if (!work.submission || work.reworkRequested || !candidate || work.stage === 'done' || work.observation?.merged) return null;
  // GY-1153: a head whose spent attempts all ended without a session acting is not reworked.
  const acted = exhausted.filter(entry => entry.work === work.key && entry.sha === candidate.sha && !unactedProducerAttempts(entry.attempts));
  if (!acted.length) return null;
  const each = Math.max(200, Math.floor(1600 / acted.length));
  return { reason: `${work.key}: the producer attempts for ${acted.map(entry => `${groupName(entry)} on ${candidate.sha.slice(0, 12)} ended without trusted evidence — ${quoteAttempts(entry, each)}`).join('. And ')}. No producer is launched for this head again, so it cannot pass its proofs; the item returns to a worker to fix what the attempts name and push a fresh head the producers are requested for.`,
    binding: `${candidate.sha}:proof-exhausted` };
}
/**
 * GY-193, GY-868. The rework a head's own proofs call for, or null: a trusted proof that failed on
 * the head, a producer-run manual proof that failed with cases executed, or evidence the producer
 * recorded as not exercising its criterion. No review judges such a head. An unexercised `manual:`
 * proof is the master's attestation to record again, never the worker's.
 */
export function proofRework(work: Work): Rework | null {
  const candidate = work.candidate;
  if (!work.submission || work.reworkRequested || !candidate || work.stage === 'done' || work.observation?.merged) return null;
  const now = new Date();
  const failed = [...mechanicalVerdicts(work, [work], now).filter(verdict => verdict.outcome === 'failed'), ...producerManualFailures(work, [work], now)];
  const unexercised = unexercisedFindings(work).filter(entry => !entry.proof.startsWith('manual:'));
  if (!failed.length && !unexercised.length) return null;
  const findings = [
    ...(failed.length ? [`a trusted proof failed: ${failed.map(verdict => mechanicalProof(verdict.proof) ? mechanicalFailure(verdict, candidate.sha) : producerManualFailure(verdict, candidate.sha)).join('; ')}`] : []),
    ...(unexercised.length ? [`the producer recorded evidence that does not exercise its criterion on ${candidate.sha.slice(0, 12)} — ${unexercised.map(entry => `${entry.proof}: "${entry.finding.length > 400 ? `${entry.finding.slice(0, 399)}…` : entry.finding}"`).join('; ')}`] : []),
  ];
  return { reason: `${work.key}: ${findings.join('. ')}. No review judges a head whose proof did not pass, so the item returns to a worker now to fix what the proof found.`,
    binding: `${candidate.sha}:proof:${[...failed.map(verdict => verdict.proof), ...unexercised.map(entry => `unexercised:${entry.proof}`)].sort().join(',')}` };
}
/**
 * The conflict with the base that only a sync round can resolve, for exactly the current head, or
 * null: GitHub computed a merge conflict for the open pull request. While the control plane's own
 * test merge of the head onto that tip is pending, it decides first.
 */
export function syncConflict(work: Work): Rework | null {
  const candidate = work.candidate, observation = work.observation;
  if (!work.submission || work.reworkRequested || !candidate || !observation || work.stage === 'done') return null;
  if (observation.candidate.sha !== candidate.sha || observation.merged || observation.prState === 'closed') return null;
  const tip = observation.baseTip ?? candidate.baseSha;
  if (observation.conflicting && !pendingBaseRefresh(work))
    return { reason: `GitHub reports that candidate ${candidate.sha.slice(0, 12)} conflicts with base branch tip ${tip.slice(0, 12)}`, binding: `${candidate.sha}:sync:${tip}` };
  return null;
}
/** Every gate green on a submitted candidate: what "mergeable" means to the cycle and its budget. */
export const mergeableCandidate = (work: Work) => work.stage === 'merge' && !!work.candidate && !work.violations.length && work.gates.every(gate => gate.passed);
/** The cursor key of one rework the loop applies: one per item and grounds. */
export const reworkKey = (work: Pick<Work, 'id'>, binding: string) => `rework:${work.id}:${binding}`;
