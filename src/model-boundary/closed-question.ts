import { z } from 'zod';
import { proofSchema } from './proof.js';
const repositoryPath = z.string().min(1).max(500).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/, 'A state path is repository-relative and never climbs out of it');
export const stateSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: repositoryPath }).strict(),
  z.object({ kind: z.literal('changed-files') }).strict(),
  z.object({ kind: z.literal('criterion') }).strict(),
  z.object({ kind: z.literal('pull-request-body') }).strict(),
  z.object({ kind: z.literal('comments') }).strict(),
]);
const probability = z.number().min(0).max(1);
export const closedQuestionSchema = z.object({
  /** The criterion whose proof this answers, and the proof. */
  criterion: z.string().regex(/^AC-\d+$/),
  proof: proofSchema,
  question: z.string().trim().min(1).max(2000),
  /** The closed set of answers offered to the responder; nothing outside it is an answer. */
  criteria: z.array(z.string().trim().min(1).max(200)).min(2).max(10).refine(options => new Set(options).size === options.length, 'The answers offered must be distinct'),
  /** The offered answer that means the proof passes; every other answer is a failure. */
  pass: z.string().trim().min(1).max(200),
  state: z.array(stateSourceSchema).min(1).max(20),
  /** Overrides the responder's configured threshold for this question; never below it. */
  threshold: probability.optional(),
}).strict().refine(question => question.criteria.includes(question.pass), 'The passing answer must be one of the answers offered');
export const closedQuestionsSchema = z.array(closedQuestionSchema).max(50)
  .refine(questions => new Set(questions.map(question => question.proof)).size === questions.length, 'One closed question per proof');

/** The candidate a judgement binds, exactly as evidence binds it. */
export const closedQuestionRequestSchema = z.object({
  proof: proofSchema,
  sha: z.string().regex(/^[a-f0-9]{40}$/), baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  policyRevision: z.number().int().positive(),
}).strict();
