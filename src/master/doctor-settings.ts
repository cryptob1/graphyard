// Concern: the schema of `run.doctor` in .graphyard/master.json — the pipeline doctor's schedule, models and time limit (GY-711).
import { z } from 'zod';

/**
 * `run.doctor` in .graphyard/master.json (GY-711): the pipeline doctor runs every
 * `intervalMinutes` (10 by default), headless on Pi with `model`, and a run that ends without a
 * valid report runs once more on the stronger `fallbackModel`. The registry's doctor role, when an
 * operator defines one, chooses the primary run's account and model instead. `timeoutMinutes`
 * bounds one run. An installation turns the doctor off with `enabled: false`.
 */
export const doctorSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.string().trim().min(1).max(500).optional(),
  intervalMinutes: z.number().int().min(5).max(1440).default(10),
  model: z.string().trim().min(1).max(200).default('zai/glm-5.3-flash'),
  fallbackModel: z.string().trim().min(1).max(200).default('zai/glm-5.3'),
  timeoutMinutes: z.number().int().min(1).max(60).default(20),
}).strict();
export type DoctorSettings = z.infer<typeof doctorSettingsSchema> & { command: string };
