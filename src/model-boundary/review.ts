import { z } from 'zod';
const identifier = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
// A runtime label is descriptive provenance (which agent produced the review), never authority.
const runtimeName = z.string().trim().regex(/^[a-z0-9][a-z0-9.+_-]{0,39}$/);
export const reviewerProfileSchema = z.object({
  name: identifier, runtime: runtimeName, reviewerApp: identifier,
  mention: z.string().regex(/^@[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/).optional(),
  timeoutSeconds: z.number().int().min(60).max(86_400).default(1800),
}).strict();
