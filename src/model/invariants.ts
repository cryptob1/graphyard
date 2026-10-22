import { z } from 'zod';


/**
 * Each invariant's threshold, in master config under `invariants` (every field optional; these are
 * the defaults). A violation is a reading past its threshold.
 */
export const invariantThresholdsSchema = z.object({
  /** Retired (GY-2875): the follow-up and triage invariants; a config written before keeps parsing. */
  followUpsPerParent: z.unknown().optional(), untriagedBacklogHours: z.unknown().optional(), untriagedBacklogMax: z.unknown().optional(),
  /** No agent session open more than this long after its item is delivered or its decision settled. */
  sessionAfterSettleMinutes: z.number().int().min(1).max(1440).default(30),
  /** No candidate base-refreshed more than this many times without a head change of its own. */
  refreshesWithoutHeadChange: z.number().int().min(1).max(100).default(3),
  /** No item in the merge stage with a mergeable pull request for longer than this without a recorded refusal. */
  mergeableWithoutRefusalMinutes: z.number().int().min(1).max(1440).default(10),
  /** Retired (GY-2876): the cycle-p90 invariant; a config written before keeps parsing. */
  cycleP90Seconds: z.unknown().optional(), cycleWindowMinutes: z.unknown().optional(),
}).strict();
export type InvariantThresholds = z.infer<typeof invariantThresholdsSchema>;
export const invariantDefaults: InvariantThresholds = invariantThresholdsSchema.parse({});

