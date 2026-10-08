// Concern: the shadow merge gate's `run.shadowGate` settings (GY-1522) and the defaults they resolve to.
import { z } from 'zod';

/** How long one trial (build plus the affected tests) may run before it is killed and recorded as failed. */
export const defaultShadowTimeoutMinutes = 20;

/**
 * `run.shadowGate` in .graphyard/master.json: the shadow gate trial-merges every submitted head
 * onto main beside GitHub's gate and records the verdict; it writes nothing. Unset, it runs (github
 * mode is the only mode) with `defaultShadowTimeoutMinutes`.
 */
export const shadowGateSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  timeoutMinutes: z.number().int().min(1).max(240).optional(),
}).strict();
export type ShadowGateSettings = z.infer<typeof shadowGateSettingsSchema>;

/** The settings with their defaults applied. */
export const shadowGateSettings = (run: { shadowGate?: ShadowGateSettings }) => ({
  enabled: run.shadowGate?.enabled ?? true,
  timeoutMinutes: run.shadowGate?.timeoutMinutes ?? defaultShadowTimeoutMinutes,
});
