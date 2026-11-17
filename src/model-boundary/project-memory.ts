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
  /** GY-3399: a master lesson the master marked mechanically enforceable: the loop files an item to turn it into code. */
  enforceable: z.boolean().optional(),
  /** GY-3399: the item the loop filed for an enforceable lesson; its delivery removes the lesson. */
  filedAs: z.string().optional(),
}).strict();

/** GY-3399: a lesson the loop removed once the item that turned it into code was delivered. */
export const removedGateSchema = z.object({
  id: z.string(),
  text: z.string(),
  key: z.string(),
  at: z.string(),
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
  removedGates: z.array(removedGateSchema).max(100).optional(),
});
