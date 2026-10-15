import { z } from 'zod';
import { humanDecisionLabel, requestChoices, type HumanRequest } from './human-request.js';

// GY-1815. A park whose asked state already holds — the operator did the step out of band — had no
// agent route off Needs you: only a human answers, and closing the item drops its work. A two-party
// `withdraw-park` decision closes the open request as superseded by what was observed, never as an
// answer: it may not stand in for spending, accounts or credentials, nor for a value only the
// operator can supply, so those are refused at request time and keep waiting for the human.
export const supersededByObservation = 'superseded-by-observation' as const;
// Bound to the one request it closes, so a later park on the same item is never withdrawn by it.
export const withdrawParkInput = z.object({ request: z.string().uuid() }).strict();
/** Why an agent pair may not withdraw this item's park on observation, or null when it may. */
export function withdrawParkRefusal(work: { key: string; humanRequest?: HumanRequest | null }, input: { request: string }): string | null {
  const request = work.humanRequest;
  if (!request || request.answer) return `${work.key} has no open human-only request to withdraw`;
  if (request.id !== input.request) return `${work.key}'s open request is ${request.id}, not ${input.request}; reload and request again`;
  if (request.kind !== 'goals-and-priorities') return `A ${humanDecisionLabel[request.kind]} request is the operator's to answer, never withdrawn on their behalf: graphyard answer ${work.key} ${request.id}`;
  if (request.sealTo || requestChoices(request).some(choice => choice.input === 'secret')) return `${work.key}'s request asks for a sealed value only the operator supplies; it is answered, never withdrawn on observation`;
  return null;
}
/** The request closed as superseded by observation, with who requested and approved it and why: the answer its history keeps. */
export function supersededRequest(request: HumanRequest, decision: { id: string; requestedBy: string; approvedBy: string; reason: string }, at: Date): HumanRequest {
  return { ...request, answer: { by: decision.requestedBy, at: at.toISOString(), outcome: supersededByObservation, text: `${supersededByObservation}: ${decision.reason}`.slice(0, 4000),
    waitedMs: Math.max(0, at.getTime() - Date.parse(request.at)), approvedBy: decision.approvedBy, decision: decision.id } };
}
