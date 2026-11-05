import { z } from 'zod';
import { agentRequestTypes, humanDecisions } from '../model/agent-requests.js';
export const agentRequestSchema = z.object({
  type: z.enum(agentRequestTypes),
  reason: z.string().trim().min(1).max(2000),
  epoch: z.number().int().positive().optional(),
  humanDecision: z.enum(humanDecisions).optional(),
  /** Whether recording this ends the attempt. A note is a record, not a hand-off, so it defaults off. */
  release: z.boolean().optional(),
  /** Resolve an open request instead of raising one. */
  resolve: z.string().min(1).max(64).optional(),
}).strict();
