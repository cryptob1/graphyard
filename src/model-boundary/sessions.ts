import { z } from 'zod';
import { sessionKinds, sessionStates, observedSessionStates } from '../model/sessions.js';
const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/);
export const sessionHandleSchema = z.object({
  id: line(120), kind: z.enum(sessionKinds),
  /**
   * Whose session this is, when a launcher records the handle of a session it started under
   * another credential. The session named here is the one that may later fill in the tab and
   * transcript only it knows, and the one that may end the handle; everybody else is refused.
   */
  principal: line(200).optional(),
  epoch: z.number().int().positive().optional(),
  runtime: line(80), host: line(200),
  agentName: line(120).optional(), role: line(120).optional(),
  head: z.string().trim().regex(/^[0-9a-f]{7,64}$/, 'A session is bound to a commit by its full or abbreviated SHA').optional(),
  initialHead: z.string().regex(/^[0-9a-f]{7,64}$/).optional(),
  runtimeStartedAt: z.string().datetime().optional(),
  workTree: z.object({ head: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(), dirty: z.string().max(64).nullable(), at: z.string().datetime() }).optional(),
  workspace: line(120).optional(), tab: line(120).optional(), pane: line(120).optional(),
  attach: z.string().trim().min(1).max(500).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
  transcript: z.string().trim().min(1).max(1000).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
  subject: z.string().trim().min(1).max(300),
  state: z.enum(sessionStates).default('running'),
  outcome: z.string().trim().min(1).max(500).optional(),
  // The loop's observation (GY-172), written by the report `observeSessions` computes.
  observed: z.enum(observedSessionStates).optional(), observedAt: z.string().datetime().optional(), missedReports: z.number().int().min(0).max(1000).optional(),
  // The launch attempt writing this handle (GY-172): a running handle another attempt holds is refused
  // unless this attempt's runtime started and it supersedes the one recorded (`engine.ts`).
  launch: z.string().trim().regex(/^[0-9a-f]{8,64}$/, 'A launch token is hexadecimal').optional(), supersede: z.boolean().optional(),
}).strict();
