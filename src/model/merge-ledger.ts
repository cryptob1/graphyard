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
/**
 * GY-1528: the executor's `merge.trial` record beside the ledger. It moves no state; the fold keeps
 * the newest trial's head and per-proof counts on the state, which the control-plane acceptance
 * family reads (model/landability.ts) in place of producer evidence.
 */
export const mergeTrialKind = 'merge.trial';

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
const proofCounts = z.record(z.string().max(200), z.object({ executed: z.number().int().min(0), failed: z.number().int().min(0) }).passthrough());
/** GY-1718: the preview of a passing trial (merge-writer/preview.ts) — its result, each required and uat case's verdict, the failing ones named. */
export const previewVerdictSchema = z.object({
  result: z.enum(['pass', 'fail', 'timeout', 'error']), mergeSha: sha, detail: z.string().max(1000), durationMs: z.number().int().min(0),
  cases: z.array(z.object({ case: z.string().min(1).max(200), verdict: z.enum(['passed', 'failed', 'flaky', 'unrun']), required: z.boolean(), reason: z.string().max(500).optional() }).strict()).max(500),
  failed: z.array(z.string().min(1).max(200)).max(500),
}).strict();
export type MergeLedgerPreview = z.infer<typeof previewVerdictSchema>;
/** `merge.trial`: the trial of `head` on `mergeSha`, with each `unit:`/`integration:` proof's executed and failed cases, its build verdict and test-file count (GY-2091), and its preview when it had one. */
export const mergeTrialSchema = z.object({ head: sha, mergeSha: sha, proofs: proofCounts, build: z.enum(['pass', 'fail']).optional(),
  tests: z.object({ files: z.number().int().min(0) }).passthrough().optional() }).passthrough();
/** The newest trial the fold kept: the head it tried, the merge commit, each proof's counts, its build verdict and test-file count (GY-2091), and the preview's verdict (GY-1718). */
export interface MergeLedgerTrial { head: string; mergeSha: string; proofs: Record<string, { executed: number; failed: number }>;
  build?: 'pass' | 'fail'; testFiles?: number; preview?: MergeLedgerPreview | null }
/**
 * GY-1834: a trial's flake — the failing test files that passed on their immediate rerun of the same
 * merge commit, and the failing cases the rerun did not repeat, none of them the item's proofs.
 */
export const trialFlakedSchema = z.object({ files: z.array(z.string().max(500)).max(100), tests: z.array(z.string().max(500)).max(100), at: instant }).strict();
export type TrialFlaked = z.infer<typeof trialFlakedSchema>;
/** A trial flake as the fold keeps it: the head and merge commit it flaked on. */
export interface MergeLedgerFlake extends TrialFlaked { head: string; mergeSha: string }
/** How many trial flakes an item's state keeps, newest last, across its intents. */
export const mergeLedgerFlakeLimit = 20;

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
  /** The newest `merge.trial` of this state's intent (GY-1528); absent when none was folded. */
  trial?: MergeLedgerTrial | null;
  /** GY-1834: every trial flake of the item, kept across its intents (bounded) so the flake ledger reads each after any restart. */
  flakes?: MergeLedgerFlake[];
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
      states[intent.key] = { key: intent.key, state: 'intent', head: intent.head, baseTip: intent.baseTip, mergeSha: intent.mergeSha, risk: intent.risk, intentAt: intent.at, pushedAt: null, observedTip: null, refusal: null, events: (previous?.events ?? 0) + 1,
        ...(previous?.flakes?.length ? { flakes: previous.flakes } : {}) };
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
    } else if (event.kind === mergeTrialKind) {
      // A trial moves no state and counts no event: it is kept beside the state it tried.
      const trial = parsed(mergeTrialSchema, event.payload);
      const state = trial && find(event, byHead, trial.head);
      if (!trial || !state) continue;
      const preview = previewVerdictSchema.safeParse((event.payload as { preview?: unknown }).preview);
      state.trial = { head: trial.head, mergeSha: trial.mergeSha, proofs: Object.fromEntries(Object.entries(trial.proofs).map(([proof, counts]) => [proof, { executed: counts.executed, failed: counts.failed }])),
        ...(trial.build ? { build: trial.build } : {}), ...(trial.tests ? { testFiles: trial.tests.files } : {}), ...(preview.success ? { preview: preview.data } : {}) };
      const flaked = trialFlakedSchema.safeParse((event.payload as { flaked?: unknown }).flaked);
      if (flaked.success) state.flakes = [...(state.flakes ?? []).filter(flake => flake.mergeSha !== trial.mergeSha), { head: trial.head, mergeSha: trial.mergeSha, ...flaked.data }].slice(-mergeLedgerFlakeLimit);
    }
  }
  return states;
}

/** Every merge commit the folded ledger names, lower-case. */
export const ledgerMergeShas = (ledger: Readonly<Record<string, Pick<MergeLedgerState, 'mergeSha'>>>) =>
  new Set(Object.values(ledger).flatMap(state => state.mergeSha ? [state.mergeSha.toLowerCase()] : []));
