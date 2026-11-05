import { z } from 'zod';
/** One thing a person or reviewer told the project that later sessions should know: an operator's answer, a research answer, a post-merge review's note. */
export const memoryNoteSchema = z.object({
  id: z.string(),
  key: z.string(),
  kind: z.string(),
  text: z.string(),
  by: z.string(),
  at: z.string(),
}).strict();

export const memoryChangeSchema = z.object({
  key: z.string(),
  sha: z.string(),
  baseSha: z.string().nullable().optional(),
  files: z.array(z.string()).default([]),
  mergedAt: z.string(),
}).strict();

export const projectMemorySchema = z.object({
  version: z.literal(1).default(1),
  updatedAt: z.string(),
  notes: z.array(memoryNoteSchema).max(100).default([]),
  changes: z.array(memoryChangeSchema).max(100).default([]),
});
