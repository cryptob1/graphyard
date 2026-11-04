// Durable serve-revert outcomes, folded beside the merge state.
import { z } from 'zod';
import type { MergeLedgerEvent, MergeLedgerState } from '../model/merge-ledger.js';

export const mergeServeRevertKind = 'merge.serve-revert';
const sha = z.string().trim().regex(/^[0-9a-f]{40}$/i).transform(value => value.toLowerCase());
const instant = z.string().refine(value => Number.isFinite(Date.parse(value)), 'an ISO 8601 instant');

export const mergeServeRevertSchema = z.object({
  serve: sha, mergeSha: sha, at: instant,
  outcome: z.enum(['reverted', 'refused']),
  revertSha: sha.nullable(), reason: z.string().max(2000).nullable(),
  reland: z.string().max(100).nullable(),
  failingCase: z.string().max(500), failingStep: z.string().max(2000).nullable(), failingReason: z.string().max(2000).nullable(),
}).strict();
export type MergeServeRevert = z.infer<typeof mergeServeRevertSchema>;

/** Keep outcomes across later merge intents; a re-land update replaces its earlier receipt. */
export function foldServeReverts(states: Record<string, MergeLedgerState>, events: readonly MergeLedgerEvent[]) {
  const byMerge = new Map(Object.values(states).map(state => [state.mergeSha, state.key]));
  for (const event of events) {
    if (event.kind !== mergeServeRevertKind) continue;
    const parsed = mergeServeRevertSchema.safeParse(event.payload);
    if (!parsed.success) continue;
    const revert = parsed.data;
    const key = event.work ?? byMerge.get(revert.mergeSha);
    const state = key ? states[key] : null;
    if (!state) continue;
    state.serveReverts = [...(state.serveReverts ?? []).filter(entry => entry.serve !== revert.serve || entry.mergeSha !== revert.mergeSha), revert];
    state.events++;
  }
  return states;
}
