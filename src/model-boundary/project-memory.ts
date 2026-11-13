import { z } from 'zod';
/** One thing a person or reviewer told the project that later sessions should know: an operator's answer, a research answer, a post-merge review's note. */
export const memoryNoteSchema = z.object({
  id: z.string(),
  key: z.string(),
  kind: z.string(),
  text: z.string(),
  by: z.string(),
  at: z.string(),
  /** A master lesson marked for workers (GY-3274): carried in worker prompts too. */
  forWorkers: z.boolean().optional(),
}).strict();

export const memoryChangeSchema = z.object({
  key: z.string(),
  sha: z.string(),
  baseSha: z.string().nullable().optional(),
  files: z.array(z.string()).default([]),
  mergedAt: z.string(),
}).strict();

/** One change to the product brief (GY-3274): who set it, why, and how large it was. */
export const productBriefChangeSchema = z.object({
  at: z.string(),
  by: z.string(),
  why: z.string(),
  words: z.number().int().nonnegative(),
}).strict();

/** The install's one product brief, kept in project memory (GY-3274) and mirrored to the control plane for the Product page. */
export const productBriefSchema = z.object({
  markdown: z.string(),
  updatedAt: z.string(),
  by: z.string(),
  why: z.string(),
  history: z.array(productBriefChangeSchema).default([]),
}).strict();

export const projectMemorySchema = z.object({
  version: z.literal(1).default(1),
  updatedAt: z.string(),
  notes: z.array(memoryNoteSchema).max(100).default([]),
  changes: z.array(memoryChangeSchema).max(100).default([]),
  brief: productBriefSchema.nullable().default(null),
});
