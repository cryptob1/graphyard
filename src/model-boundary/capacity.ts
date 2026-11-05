import { z } from 'zod';
import { partialWorkStates, attemptEndCauses, quotaRoles } from '../model/capacity.js';
export const partialWorkSchema = z.object({
  state: z.enum(partialWorkStates),
  /** The commit that holds the work, on the attempt's own branch, when it was committed. */
  commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  branch: z.string().min(1).max(200).optional(),
  path: z.string().min(1).max(1000).optional(),
  detail: z.string().max(500).optional(),
}).strict();

const instant = z.iso.datetime();
export const exhaustionReportSchema = z.object({
  event: z.literal('exhausted'),
  cause: z.enum(attemptEndCauses).optional(),
  role: z.enum(quotaRoles),
  /** The worker attempt the exhausted session held; no other role's session holds one. */
  epoch: z.number().int().positive().optional(),
  /**
   * What the session answered: a reviewer's or producer's dispatch request.
   */
  requestId: z.string().min(1).max(64).optional(),
  profile: z.string().min(1).max(80),
  /** The agent account (environment) the session ran on; null when the profile names none. */
  account: z.string().min(1).max(80).nullable(),
  runtime: z.string().min(1).max(40).nullable(),
  reason: z.string().trim().min(1).max(500),
  resetsAt: instant.nullable(),
  partialWork: partialWorkSchema,
  /**
   * GY-867: the loop ended this worker attempt because it blocked again after its blocker was
   * cleared. The blocker that attempt recorded ends with it, so the item is dispatched again.
   */
  endsBlocker: z.literal(true).optional(),
}).strict().refine(report => report.role !== 'worker' || report.epoch !== undefined, 'A worker exhaustion names the attempt epoch it ends')
  .refine(report => !report.endsBlocker || (report.role === 'worker' && report.cause === 'interrupted'), 'Only an interrupted worker attempt ends the blocker it recorded');

export const capacityAccountSchema = z.object({
  account: z.string().min(1).max(80), profile: z.string().min(1).max(80),
  resetsAt: instant.nullable(), reason: z.string().min(1).max(500),
}).strict();
export const capacitySpentSchema = z.object({
  event: z.literal('spent'), role: z.enum(quotaRoles),
  accounts: z.array(capacityAccountSchema).min(1).max(40),
}).strict();
export const capacityRestoredSchema = z.object({ event: z.literal('restored'), role: z.enum(quotaRoles), reason: z.string().trim().min(1).max(500) }).strict();
export const capacityEventSchema = z.union([exhaustionReportSchema, capacitySpentSchema, capacityRestoredSchema]);
