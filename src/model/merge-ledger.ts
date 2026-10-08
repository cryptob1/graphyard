// Concern: the merge ledger (GY-1519) — the events a merge leaves on the ledger and their fold per item.
import { z } from 'zod';

/**
 * The merge ledger: every merge Graphyard intends, pushes, reconciles or refuses leaves an event
 * here, so main's history can be read against what the control plane meant to land. The fold
 * gives each item's latest ledger state; the main watch (daemon/main-watch.ts) calls a commit on
 * main that matches a state's merge commit `ledger`, and one nothing explains `unknown`.
 */
export const mergeLedgerKinds = {
  intent: 'merge.intent',
  pushed: 'merge.pushed',
  reconciled: 'merge.reconciled',
  refused: 'merge.refused',
} as const;
export type MergeLedgerKind = typeof mergeLedgerKinds[keyof typeof mergeLedgerKinds];

const sha = z.string().trim().regex(/^[0-9a-f]{40}$/i).transform(value => value.toLowerCase());
const instant = z.string().refine(value => Number.isFinite(Date.parse(value)), 'an ISO 8601 instant');

/** `merge.intent`: the control plane means to land `head` of `key` on `baseTip` as `mergeSha`, in `risk` lane, at `at`. */
export const mergeIntentSchema = z.object({ key: z.string().min(1).max(100), head: sha, baseTip: sha, mergeSha: sha, risk: z.string().min(1).max(40), at: instant }).strict();
/** `merge.pushed`: the merge commit reached the base branch. */
export const mergePushedSchema = z.object({ mergeSha: sha, pushedAt: instant }).strict();
/** `merge.reconciled`: the base branch was observed holding the merge commit, at `observedTip`. */
export const mergeReconciledSchema = z.object({ mergeSha: sha, observedTip: sha }).strict();
/** `merge.refused`: a merge or a revert of `head` was refused, with why. */
export const mergeRefusedSchema = z.object({ head: sha, reason: z.string().min(1).max(2000), kind: z.enum(['merge', 'revert']) }).strict();

export type MergeIntent = z.infer<typeof mergeIntentSchema>;
export type MergePushed = z.infer<typeof mergePushedSchema>;
export type MergeReconciled = z.infer<typeof mergeReconciledSchema>;
export type MergeRefused = z.infer<typeof mergeRefusedSchema>;

/** One ledger row as the fold reads it: its kind and payload, and the item key it was written under when it was. */
export interface MergeLedgerEvent { kind: string; payload: unknown; work?: string | null; at?: string | null; seq?: string | number | null }

/** Where an item's merge stands on the ledger: its newest event, and what the earlier ones established. */
export interface MergeLedgerState {
  key: string;
  state: 'intent' | 'pushed' | 'reconciled' | 'refused';
  head: string | null;
  baseTip: string | null;
  mergeSha: string | null;
  risk: string | null;
  intentAt: string | null;
  pushedAt: string | null;
  observedTip: string | null;
  refusal: { kind: 'merge' | 'revert'; reason: string } | null;
  /** How many ledger rows folded into this state. */
  events: number;
}

declare module './work.js' { interface Work { mergeLedger?: MergeLedgerState | null } }

const parsed = <T>(schema: z.ZodType<T>, payload: unknown): T | null => { const result = schema.safeParse(payload); return result.success ? result.data : null; };
/** A `merge.reconciled` row the delivery path wrote before the ledger (engine.ts): its merge commit sits under `details`. */
const legacyReconciled = (payload: unknown): MergeReconciled | null => {
  const details = (payload as { details?: { mergeSha?: unknown } } | null)?.details;
  const mergeSha = parsed(sha, details?.mergeSha);
  return mergeSha ? { mergeSha, observedTip: mergeSha } : null;
};

/**
 * Fold the ledger, oldest first, into each item's latest state. An intent opens the item's state
 * under its key; a push or a reconciliation finds its item by merge commit, a refusal by head —
 * or, when the row was written under an item (`work`), by that key. A row that names no open
 * state, or whose payload does not parse, folds into nothing: the ledger is append-only and
 * the fold never throws on what an older release wrote.
 */
export function foldMergeLedger(events: readonly MergeLedgerEvent[]): Record<string, MergeLedgerState> {
  const states: Record<string, MergeLedgerState> = {};
  const byMerge = new Map<string, string>(), byHead = new Map<string, string>();
  const find = (event: MergeLedgerEvent, index: Map<string, string>, lookup: string | null) => {
    const key = (event.work && states[event.work]) ? event.work : lookup ? index.get(lookup) ?? null : null;
    return key ? states[key] : null;
  };
  for (const event of events) {
    if (event.kind === mergeLedgerKinds.intent) {
      const intent = parsed(mergeIntentSchema, event.payload);
      if (!intent) continue;
      const previous = states[intent.key];
      states[intent.key] = { key: intent.key, state: 'intent', head: intent.head, baseTip: intent.baseTip, mergeSha: intent.mergeSha, risk: intent.risk, intentAt: intent.at, pushedAt: null, observedTip: null, refusal: null, events: (previous?.events ?? 0) + 1 };
      byMerge.set(intent.mergeSha, intent.key); byHead.set(intent.head, intent.key);
    } else if (event.kind === mergeLedgerKinds.pushed) {
      const pushed = parsed(mergePushedSchema, event.payload);
      const state = pushed && find(event, byMerge, pushed.mergeSha);
      if (!pushed || !state) continue;
      Object.assign(state, { state: 'pushed', mergeSha: pushed.mergeSha, pushedAt: pushed.pushedAt, events: state.events + 1 });
      byMerge.set(pushed.mergeSha, state.key);
    } else if (event.kind === mergeLedgerKinds.reconciled) {
      const reconciled = parsed(mergeReconciledSchema, event.payload) ?? legacyReconciled(event.payload);
      const state = reconciled && find(event, byMerge, reconciled.mergeSha);
      if (!reconciled || !state) continue;
      Object.assign(state, { state: 'reconciled', mergeSha: reconciled.mergeSha, observedTip: reconciled.observedTip, events: state.events + 1 });
      byMerge.set(reconciled.mergeSha, state.key);
    } else if (event.kind === mergeLedgerKinds.refused) {
      const refused = parsed(mergeRefusedSchema, event.payload);
      const state = refused && find(event, byHead, refused.head);
      if (!refused || !state) continue;
      Object.assign(state, { state: 'refused', head: refused.head, refusal: { kind: refused.kind, reason: refused.reason }, events: state.events + 1 });
    }
  }
  return states;
}

/** Every merge commit the folded ledger names, lower-case. */
export const ledgerMergeShas = (ledger: Readonly<Record<string, Pick<MergeLedgerState, 'mergeSha'>>>) =>
  new Set(Object.values(ledger).flatMap(state => state.mergeSha ? [state.mergeSha.toLowerCase()] : []));
