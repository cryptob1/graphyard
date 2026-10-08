// Concern: the loop's per-item latency clock and the delivery sample it completes (GY-1499).
import { z } from 'zod';

/**
 * What the loop itself observed about one item's passage, so latency is measured against what the
 * loop acted on rather than reconstructed from a ledger afterwards. One entry per open item,
 * dropped once its delivery has been sampled.
 */
export const itemClockSchema = z.object({
  key: z.string().max(40), epoch: z.number().int().min(0),
  /** First cycle that saw the item claimable — released, unclaimed, and not already submitted. */
  readyAt: z.string().nullable().default(null),
  claimedAt: z.string().nullable().default(null),
  /** The current epoch's first lease renewal (`lastAssignment.startedAt`): the agent session starting. */
  startedAt: z.string().nullable().default(null),
  /** First candidate head of the current attempt: the worker's first push. */
  pushedAt: z.string().nullable().default(null),
  approvedAt: z.string().nullable().default(null),
  /** First cycle that saw every gate green: when the candidate became mergeable. */
  mergeableAt: z.string().nullable().default(null),
}).strict();
export type ItemClock = z.infer<typeof itemClockSchema>;

/**
 * One measured passage. A delivery fills the merge figures; a rework request fills its own.
 * Ready→first push splits at the session start into launch overhead (claim→start) and the agent's
 * own working time (start→first push), each null when either of its endpoints is unknown.
 */
export const latencySampleSchema = z.object({
  work: z.string().max(40), at: z.string(),
  readyToClaimMs: z.number().int().min(0).nullable().default(null),
  readyToPushMs: z.number().int().min(0).nullable().default(null),
  claimToStartMs: z.number().int().min(0).nullable().default(null),
  startToPushMs: z.number().int().min(0).nullable().default(null),
  approvalToMergeMs: z.number().int().min(0).nullable().default(null),
  mergeableToMergeMs: z.number().int().min(0).nullable().default(null),
  verdictToReworkMs: z.number().int().min(0).nullable().default(null),
}).strict();
export type LatencySample = z.infer<typeof latencySampleSchema>;
