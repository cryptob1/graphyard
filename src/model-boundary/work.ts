import { z } from 'zod';
import { draftCriteriaSchema, policySchema, resourcesSchema } from './policy.js';
import { sliceIds, stages, systemDrivenDefault } from '../model/work.js';
import { proofSchema } from './proof.js';
import { closedQuestionsSchema } from './closed-question.js';
/**
 * GY-1698: a post-deploy follow-up whose criterion is a rolling-window reading — an intervention
 * rate below a threshold per N days, a hold for N consecutive days — can produce nothing before
 * the window has run: GY-1689, filed at 03:36Z for a 03:11Z merge, was released at 06:39Z and
 * spent two worker attempts, a review and two approver sessions on a reading the intervention
 * report itself projected no earlier than 2026-10-17T14:31Z. The product computes that instant
 * already; the follow-up now carries it, as one fact in one place: `notBefore` is the earliest
 * instant the reading can exist, taken from the report's projection for the pattern
 * (`intervention-report`) or from the delivered item's merge time plus the window the criterion
 * states (`criterion-window`), whichever is later. A master release before it stays operator
 * intent — the item may be released — but `nextAction` holds the dispatch on the instant and the
 * loop dispatches it once the instant passes, without a master session.
 */
export const observationWindowSchema = z.object({
  notBefore: z.string().datetime({ offset: true }),
  basis: z.enum(['intervention-report', 'criterion-window', 'worker-reading', 'operator-hold']),
  detail: z.string().max(2000),
}).strict();
export const createSchema = z.object({
  owner: z.string().trim().min(1).max(200).nullable().optional(),
  title: z.string().min(1).max(200), description: z.string().max(20000).default(''),
  /** One plain sentence a person can read first on the item page (GY-2011); optional on master create, set from a plan item's `plain` at release. */
  summary: z.string().trim().min(1).max(400).optional(),
  type: z.enum(['feature', 'bug', 'chore']).default('feature'),
  priority: z.number().int().min(0).max(4).default(2),
  dependencies: z.array(z.string().uuid()).max(50).default([]),
  criteria: draftCriteriaSchema(50).default([]),
  policy: policySchema.default({ checks: ['test', 'typecheck'], review: true }),
  exclusiveResources: resourcesSchema.optional(),
  plannedFiles: z.array(z.string().trim().min(1).max(500)).max(200).optional(),
  slice: z.enum(sliceIds).optional(),
  // Manual proofs a launched producer session may run on the item's behalf. Unit and
  // integration proofs are always producer-runnable; every other manual proof stays with
  // the human operator. See model/dispatch.ts.
  producerProofs: z.array(proofSchema).max(50).optional().refine(proofs => !proofs || proofs.every(proof => proof.startsWith('manual:')), 'producerProofs names only manual: proofs; unit and integration proofs are producer-runnable already')
    .refine(proofs => !proofs || new Set(proofs).size === proofs.length, 'producerProofs must be unique'),
  // Proofs a criterion declares answerable as a closed question: Graphyard asks the configured
  // responder against the bound candidate state instead of launching a producer session, and
  // records the answer as evidence. See model/closed-question.ts.
  closedQuestions: closedQuestionsSchema.optional(),
  // A yard repair (GY-3102): a fix for Graphyard's own fault takes its own route past the release cap, the dispatch order and the merge queue.
  yardRepair: z.boolean().optional(),
  // Retired (GY-2875): where Graphyard itself opened an item; one filed with it keeps parsing.
  origin: z.unknown().optional(),
  // A system-driven item moves only through the loop: the master CLI refuses the hand actions the
  // loop owns for it (src/cli/hand-actions.ts). New items take the shipped default; an item
  // created before the field existed carries none and is not system-driven.
  systemDriven: z.preprocess(value => value === undefined ? systemDrivenDefault : value, z.boolean().optional()),
  // The earliest instant the observation this item owes can exist (GY-1698): a post-deploy
  // follow-up for a windowed reading carries it; released, the item is not dispatched before it.
  observationWindow: observationWindowSchema.optional(),
}).strict();
/**
 * The shape of a stored Work document (src/model/work.ts `Work`): the created intent plus the
 * fields every stored item carries. Optional bookkeeping fields pass through unchecked; the test
 * fixture builder (tests/helpers/work-fixture.ts) is held to it.
 */
const gateSchema = z.object({ name: z.string(), passed: z.boolean(), reasons: z.array(z.string()) }).strict();
export const storedWorkSchema = createSchema.extend({
  id: z.string().min(1), key: z.string().min(1), stage: z.enum(stages),
  revision: z.number().int().min(0), policyRevision: z.number().int().min(0), epoch: z.number().int().min(0),
  createdAt: z.string(), updatedAt: z.string(), stageEnteredAt: z.string(), ready: z.boolean(),
  lease: z.object({ owner: z.string(), epoch: z.number().int(), expiresAt: z.string() }).strict().nullable(),
  workspaces: z.array(z.object({ host: z.string(), path: z.string(), branch: z.string(), epoch: z.number().int(), owner: z.string() }).strict()),
  candidate: z.object({ sha: z.string(), baseSha: z.string(), pr: z.number().int(), branch: z.string(), author: z.string(), createdAt: z.string().optional() }).strict().nullable(),
  submission: z.object({ epoch: z.number().int(), pr: z.number().int() }).strict().nullable(),
  reworkRequested: z.boolean(), scenarioRequirements: z.array(z.unknown()), evidence: z.array(z.unknown()),
  observation: z.record(z.string(), z.unknown()).nullable(), blocker: z.string().nullable(),
  gates: z.array(gateSchema), violations: z.array(z.string()),
}).passthrough();
