import { z } from 'zod';
import { requestChoices, type HumanRequest } from './human-request.js';
import { demand } from './refusal.js';

// ---------------------------------------------------------------------------
// The human's answer to a parked request (GY-89, GY-738): what it may carry and what it records.
// ---------------------------------------------------------------------------

export const humanAnswerSchema = z.object({
  request: z.string().uuid(),
  /** `provided`: the thing asked for now exists, so the item resumes. `declined`: it will not, and the item stays parked with the answer as its blocker. A choice sets it. */
  outcome: z.enum(['provided', 'declined']).default('provided'),
  /** Free words, for a request answered without a choice. */
  answer: z.string().trim().min(1).max(4000).optional(),
  /** The id of the button pressed, and the operator's optional note beside it. */
  choice: z.string().min(1).max(40).optional(),
  note: z.string().trim().max(4000).optional(),
  /** A `secret` choice's value: sealed before anything is written, never stored as given. */
  secret: z.string().min(1).max(8000).optional(),
}).strict().refine(data => data.answer || data.choice, 'Give a choice or an answer');
export type HumanAnswerInput = z.infer<typeof humanAnswerSchema>;
/**
 * What an answer records: the outcome, the words the next worker reads, and the choice pressed.
 * A choice that asks for words needs them; a secret goes only to a secret choice.
 */
export function resolveHumanAnswer(request: Pick<HumanRequest, 'kind' | 'choices' | 'sealTo'>, data: HumanAnswerInput) {
  if (!data.choice) {
    demand(!data.secret, 'A secret is sent only with the choice that asks for it', 422);
    return { outcome: data.outcome, text: data.answer!, choice: null, note: null, secret: false };
  }
  const choice = requestChoices(request).find(entry => entry.id === data.choice);
  demand(choice, `No choice ${data.choice} on this request; reload before answering`, 422);
  const note = data.note || data.answer || null;
  demand(choice!.input !== 'text' || note, `${choice!.label} needs your words in the note`, 422);
  demand(choice!.input === 'secret' ? !!data.secret : !data.secret, choice!.input === 'secret' ? `${choice!.label} needs the value to seal` : 'A secret is sent only with the choice that asks for it', 422);
  return { outcome: choice!.outcome, text: note ? `${choice!.label}: ${note}` : choice!.label, choice: { id: choice!.id, label: choice!.label }, note, secret: choice!.input === 'secret' };
}

/** `withdrawn`: nobody answered; the item was closed and the question no longer stands (model/closure.ts). */
export interface HumanAnswer {
  by: string; at: string; outcome: 'provided' | 'declined' | 'withdrawn'; text: string; waitedMs: number;
  /** The button pressed and the note beside it (GY-738); absent on a free-text answer. */
  choice?: { id: string; label: string } | null; note?: string | null;
  /** A secret choice's value, sealed to the requesting host's key (server/waits.ts `sealToHost`). */
  sealed?: string | null;
}
