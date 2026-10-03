import type { Work } from './work.js';
import type { NextActionInputs } from './action-kinds.js';
import { openProducerRequest, producerGroupDecisions } from './dispatch.js';
import { mechanicalProof, unexercisedRework } from './mechanical-proofs.js';
import { producerLaunchStop } from './action-progress.js';

const short = (sha: string | null | undefined) => sha ? sha.slice(0, 12) : 'none';

/**
 * What the proof groups of the head call for, read from the decision `reconcileAutoDispatch`
 * makes (`producerGroupDecisions`), so the planner never names a producer the reconciler will not
 * request (GY-188):
 *
 * - `dispatch` — a group the reconciler requests, holding its open request. Nothing else is a
 *   proof dispatch, so every one an executor claims has a request to launch against.
 * - `failed` — trusted evidence failed for a group, or all a mechanical group has left is proofs recorded as not exercising
 *   their criterion (GY-817): this head can never pass, so the step is a new head (or the operator, for a manual proof).
 * - `wait` — a group is left to prove but no request is open for it: the reconciler opens one on
 *   the next reading, or no request may stand for the head yet. Nobody's action, never a dispatch.
 * - `stopped` — every group left to prove holds a request whose launch an executor was refused for
 *   good (`producerLaunchStop`): no executor launches it again, so the step is the attestation.
 * - null — every proof left is one no producer session may run.
 */
export type ProofStep =
  | { step: 'dispatch'; inputs: NextActionInputs }
  | { step: 'failed'; detail: string; mechanical: boolean }
  | { step: 'wait'; detail: string }
  | { step: 'stopped'; detail: string };

export function proofStep(work: Work, all: Work[], now: Date): ProofStep | null {
  if (!work.candidate) return null;
  const candidate = work.candidate;
  const decisions = producerGroupDecisions(work, all, now);
  const failed = decisions.find(decision => decision.state === 'failed');
  const detail = failed?.reason ?? unexercisedRework(work, decisions);
  if (detail) return { step: 'failed', detail, mechanical: !failed || failed.failed.every(entry => mechanicalProof(entry.proof)) };
  let stopped: string | null = null;
  for (const decision of decisions.filter(entry => entry.state === 'request')) {
    const request = openProducerRequest(work, decision.group);
    if (!request) continue;
    // A request an executor's launcher has refused for good is never offered again, to any
    // executor on any host (`producerLaunchStop`); its proofs are left to the attestation.
    const stop = producerLaunchStop(work, request.id);
    if (stop) {
      const remedy = decision.unproven.every(proof => proof.startsWith('manual:')) ? `only a two-party attestation (master decide ${work.key} attest) satisfies them now` : 'a new head or the operator answers them now';
      stopped ??= `${decision.group} proofs ${decision.unproven.join(', ')} on ${short(candidate.sha)} get no further producer launch from any executor — ${stop.reason}; ${remedy}`;
      continue;
    }
    return { step: 'dispatch', inputs: { kind: 'dispatch', target: 'proof', group: decision.group, proofs: decision.unproven, requestId: request.id, pr: candidate.pr, sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: work.policyRevision } };
  }
  if (stopped) return { step: 'stopped', detail: stopped };
  const pending = decisions.find(decision => decision.state === 'request' || decision.state === 'ineligible');
  if (!pending) return null;
  return { step: 'wait', detail: pending.state === 'ineligible' ? `${pending.group} proofs ${pending.unproven.join(', ')} wait: ${pending.reason}`
    : `no ${pending.group} producer request is open yet for ${short(candidate.sha)} (${pending.unproven.join(', ')}); the control plane's reconciliation opens it` };
}
