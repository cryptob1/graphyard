import { z } from 'zod';
import { humanDecisionKinds } from '../model/human-request.js';
import { shortAskIssues } from '../model/human-ask.js';
import { hostDoableAsk, hostDoableRefusal, HostDoableAsk } from '../model/park-refusal.js';
/**
 * One ready-made answer the requester offers (GY-738): a button on the card. `text` asks for the
 * operator's own words beside it (a different cap); `secret` asks for a value that is sealed to
 * the requesting host's key and never recorded in the clear.
 */
export const humanChoiceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  label: z.string().trim().min(1).max(120),
  outcome: z.enum(['provided', 'declined']),
  input: z.enum(['none', 'text', 'secret']).default('none'),
}).strict();

export const humanRequestSchema = z.object({
  epoch: z.number().int().positive(),
  kind: z.enum(humanDecisionKinds),
  /** Why the item cannot continue without the decision. */
  reason: z.string().trim().min(1).max(2000),
  /** The exact thing the human is asked for: the account to open, the priority to set, the credential to issue. */
  needed: z.string().trim().min(1).max(2000),
  /** The short note the human reads (GY-1408): one sentence naming their action, a few plain steps, one plain why. NEEDED and REASON are the agents' detail. */
  ask: z.string().trim().min(1).optional(),
  steps: z.array(z.string().trim().min(1)).min(1).optional(), why: z.string().trim().min(1).optional(),
  /** What the requester recommends (GY-1410), shown first: a choice it offers, or the safest way to get a value. `recommendationIssues` requires it and WHY. */
  recommendation: z.string().trim().min(1).max(600).optional(),
  /** The buttons the card offers, chosen by the requester; the kind's defaults when omitted. */
  choices: z.array(humanChoiceSchema).min(1).max(6).refine(choices => new Set(choices.map(choice => choice.id)).size === choices.length, 'Choice ids must be distinct').optional(),
  /** The requesting host's public key (PEM): a `secret` choice's value is sealed to it. */
  sealTo: z.string().trim().min(1).max(4000).optional(),
}).strict().refine(data => data.sealTo || !data.choices?.some(choice => choice.input === 'secret'), 'A secret choice needs sealTo, the requesting host\'s public key')
  .superRefine((data, context) => { for (const message of shortAskIssues(data)) context.addIssue({ code: 'custom', message }); });
// The park-refusal classifier (GY-1395, GY-1416, GY-1692) lives in park-refusal.ts; `parkRefusal` here refuses a criterion-rewrite question first (GY-1816).
export { hostDoableAsk, hostDoableRefusal, type HostDoableAsk };
