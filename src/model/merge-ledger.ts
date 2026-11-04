import type { z } from 'zod';
import type { mergeReconciledSchema, previewVerdictSchema, trialFlakedSchema } from '../model-boundary/merge-ledger.js';
import type { Work } from './work.js';
/**
 * The merge ledger: every merge Graphyard intends, pushes, reconciles or refuses leaves an event
 * here, so main's history can be read against what the control plane meant to land. The fold
 * gives each item's latest ledger state; a reader of main's history calls a commit on
 * main that matches a state's merge commit `ledger`, and one nothing explains `unknown`.
 */
export const mergeLedgerKinds = {
  intent: 'merge.intent',
  pushed: 'merge.pushed',
  reconciled: 'merge.reconciled',
  refused: 'merge.refused',
} as const;
/**
 * GY-1528: the executor's `merge.trial` record beside the ledger. It moves no state; the fold keeps
 * the newest trial's head and per-proof counts on the state, which the control-plane acceptance
 * family reads (model/landability.ts) in place of producer evidence.
 */
export const mergeTrialKind = 'merge.trial';
/**
 * GY-2963: the trial's current step, recorded beside the ledger while the trial runs. It moves no
 * state; the fold keeps the newest step and its start instant on the state, which master status,
 * the item's pipeline and the Work page read while a merge is in flight.
 */
export const mergeTrialStepKind = 'merge.trial-step';

export type MergeReconciled = z.infer<typeof mergeReconciledSchema>;
export type MergeLedgerPreview = z.infer<typeof previewVerdictSchema>;
/** The newest trial the fold kept: the head it tried, the merge commit, each proof's counts, its build verdict and test-file count (GY-2091), and the preview's verdict (GY-1718). */
export interface MergeLedgerTrial { head: string; mergeSha: string; proofs: Record<string, { executed: number; failed: number }>;
  build?: 'pass' | 'fail'; testFiles?: number; preview?: MergeLedgerPreview | null }
/** GY-2963: the trial's newest reported step, with the instant it began. */
export interface MergeLedgerStep { step: string; at: string }
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
  /** GY-2963: the newest `merge.trial-step` of this state's intent, reset by the next intent; absent when none was folded. */
  trialStep?: MergeLedgerStep | null;
  /** GY-1834: every trial flake of the item, kept across its intents (bounded) so the flake ledger reads each after any restart. */
  flakes?: MergeLedgerFlake[];
  /** How many ledger rows folded into this state. */
  events: number;
}

declare module './work.js' { interface Work { mergeLedger?: MergeLedgerState | null } }

// ---- The trial step a merge in flight is at (GY-2963) ---------------------------------------------

/**
 * How long a merge may go without its trial advancing a step before it reads as stalled: a
 * whole trial builds and tests in far less, so a step this old means nothing is happening any
 * more. The bound the merge writer's own summary judges its flight by too.
 */
export const mergeStallMs = 30 * 60_000;

/** The step a submitted head's merge is at right now, or null when none is in flight for it. */
export interface CurrentMergeStep extends MergeLedgerStep { atMs: number; fresh: boolean }
export function currentMergeStep(work: Pick<Work, 'candidate' | 'mergeLedger'>, now: number): CurrentMergeStep | null {
  const ledger = work.mergeLedger, head = work.candidate?.sha.toLowerCase();
  if (!ledger || !head || ledger.head !== head || (ledger.state !== 'intent' && ledger.state !== 'pushed')) return null;
  const at = ledger.state === 'pushed' && ledger.pushedAt ? { step: 'push', at: ledger.pushedAt }
    : ledger.trialStep?.at && Number.isFinite(Date.parse(ledger.trialStep.at)) ? ledger.trialStep
    : ledger.intentAt && Number.isFinite(Date.parse(ledger.intentAt)) ? { step: 'queue wait', at: ledger.intentAt } : null;
  if (!at) return null;
  const atMs = Date.parse(at.at);
  return { ...at, atMs, fresh: now - atMs < mergeStallMs };
}

/** Every merge commit the folded ledger names, lower-case. */
export const ledgerMergeShas = (ledger: Readonly<Record<string, Pick<MergeLedgerState, 'mergeSha'>>>) =>
  new Set(Object.values(ledger).flatMap(state => state.mergeSha ? [state.mergeSha.toLowerCase()] : []));
