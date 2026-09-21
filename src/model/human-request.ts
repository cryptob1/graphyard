import { z } from 'zod';

// ---------------------------------------------------------------------------
// Decisions only a human may make, as typed state (GY-89).
//
// Agents decide everything except three things: goals and priorities, spending money or opening
// third-party accounts, and issuing credentials to people. An attempt that reaches one of those
// used to say so in a free-text blocker and keep its lease, so the item sat owned by a session
// that could not act until a master session read the prose. It now records a typed request — which
// of the three decisions, why, and the exact thing needed — and that one transaction ends the
// attempt's lease and parks the item. Nothing else waits: the rest of the graph keeps moving, the
// request is listed for the human with how long it has waited and how to answer it, and the
// answer itself returns the item to the loop, which dispatches it without a master session.
// ---------------------------------------------------------------------------

export const humanDecisionKinds = ['goals-and-priorities', 'money-or-accounts', 'credentials-for-people'] as const;
export type HumanDecisionKind = typeof humanDecisionKinds[number];
/** Each kind is one of the three decisions the operator keeps (master.ts `humanOnlyDecisions`), in the same words. */
export const humanDecisionLabel = {
  'goals-and-priorities': 'goals and priorities',
  'money-or-accounts': 'spending money or opening third-party accounts',
  'credentials-for-people': 'issuing credentials to people',
} as const satisfies Record<HumanDecisionKind, string>;

export const humanRequestSchema = z.object({
  epoch: z.number().int().positive(),
  kind: z.enum(humanDecisionKinds),
  /** Why the item cannot continue without the decision. */
  reason: z.string().trim().min(1).max(2000),
  /** The exact thing the human is asked for: the account to open, the priority to set, the credential to issue. */
  needed: z.string().trim().min(1).max(2000),
}).strict();
export const humanAnswerSchema = z.object({
  request: z.string().uuid(),
  /** `provided`: the thing asked for now exists, so the item resumes. `declined`: it will not, and the item stays parked with the answer as its blocker. */
  outcome: z.enum(['provided', 'declined']).default('provided'),
  answer: z.string().trim().min(1).max(4000),
}).strict();

export interface HumanAnswer { by: string; at: string; outcome: 'provided' | 'declined'; text: string; waitedMs: number }
export interface HumanRequest {
  id: string; kind: HumanDecisionKind; reason: string; needed: string;
  requestedBy: string; epoch: number; at: string;
  answer?: HumanAnswer | null;
}
export const retainedHumanRequests = 20;

/** The blocker a parked item carries, and the prefix the answer clears it by. */
export const humanRequestBlocker = 'Waiting on a human-only decision';
export const describeHumanRequest = (request: Pick<HumanRequest, 'kind' | 'needed'>) => `${humanRequestBlocker} (${humanDecisionLabel[request.kind]}): ${request.needed}`;
export const parkedOnHuman = (work: { humanRequest?: HumanRequest | null }) => !!work.humanRequest && !work.humanRequest.answer;

/** How to answer, exactly as the list and `master status` print it. */
export const answerCommand = (key: string, request: Pick<HumanRequest, 'id'>) => `graphyard answer ${key} ${request.id} ANSWER`;
export const declineCommand = (key: string, request: Pick<HumanRequest, 'id'>) => `graphyard answer ${key} ${request.id} --decline REASON`;

export interface HumanRequestRow {
  work: string; id: string; title: string; request: HumanRequest;
  waitedMs: number; decision: string;
  answer: { cli: string; decline: string; dashboard: string; api: string };
}
/** Every open human-only request, longest wait first: the human-facing list. */
export function openHumanRequests(work: readonly { id: string; key: string; title: string; stage: string; humanRequest?: HumanRequest | null }[], now: number): HumanRequestRow[] {
  return work.filter(item => item.stage !== 'done' && parkedOnHuman(item)).map(item => {
    const request = item.humanRequest!;
    return {
      work: item.key, id: item.id, title: item.title, request,
      waitedMs: Math.max(0, now - Date.parse(request.at)), decision: humanDecisionLabel[request.kind],
      answer: { cli: answerCommand(item.key, request), decline: declineCommand(item.key, request), dashboard: 'Work → Needs you → Answer', api: `POST /api/work/${item.key}/answer {"request":"${request.id}","answer":"…"}` },
    };
  }).sort((a, b) => b.waitedMs - a.waitedMs);
}
