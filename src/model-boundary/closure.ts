import { z } from 'zod';
import { closureKinds } from '../model/closure.js';
/** A close that names no kind (GY-1923: a case settling its change with only a reason) is `obsolete`, the one kind that names no other item or commit. */
export const closeSchema = z.object({
  kind: z.enum(closureKinds).default('obsolete'),
  reason: z.string().trim().min(1).max(2000),
  ref: z.string().trim().min(1).max(200).nullable().optional(),
}).strict().superRefine((data, context) => {
  if (data.kind === 'obsolete' && data.ref) context.addIssue({ code: 'custom', message: 'An obsolete closure names no other item or commit', path: ['ref'] });
  if (data.kind !== 'obsolete' && !data.ref) context.addIssue({ code: 'custom', message: `A ${data.kind} closure names the ${data.kind === 'duplicate' ? 'item it duplicates' : data.kind === 'delivered-observation' ? 'release its reading was taken on' : 'commit or item that superseded it'}`, path: ['ref'] });
});
