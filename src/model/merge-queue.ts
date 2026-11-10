// Concern: the merge writer's queue (GY-1524), pure over the work and its folded ledger: it only orders which head starts its trial next (GY-3120), so the board reads that order.
import type { Work } from './work.js';
import type { MergeLedgerState } from './merge-ledger.js';
import { trialFailurePrefix } from './rework-ground.js';

/**
 * GY-1834: the refusal of a head whose every failing test file fails on the base tip too. It grounds
 * no rework (it does not start `trialFailurePrefix`) and leaves the head queued, held
 * `baseFailureHoldMs`; the loop's base-failure step files the fix item from it.
 */
export const baseFailurePrefix = 'base failure';
export const baseFailureHoldMs = 30 * 60_000;

/**
 * When the item's current head was handed in. The pipeline timeline's resubmission or submission
 * when the snapshot carries it; the loop's coordination view drops that timeline, so there the
 * moment this very head was first observed (`headObserved`, set when the candidate changed) stands
 * in, then the candidate's creation, then the stage entry.
 */
export function submittedAtOf(item: Pick<Work, 'stageEnteredAt' | 'candidate' | 'headObserved'>): number {
  const pipeline = (item as { pipeline?: { submittedAt?: string | null; resubmittedAt?: string | null } }).pipeline;
  const observed = item.headObserved && item.candidate && item.headObserved.sha.toLowerCase() === item.candidate.sha.toLowerCase() ? item.headObserved.at : null;
  for (const at of [pipeline?.resubmittedAt, pipeline?.submittedAt, observed, item.candidate?.createdAt, item.stageEnteredAt]) if (at && Number.isFinite(Date.parse(at))) return Date.parse(at);
  return 0;
}

/**
 * GY-3229: how a trial that could not write a read-only file system names itself; the control plane
 * records that reason as the item's blocker, and the queue holds the head while the blocker stands.
 */
export const readOnlyTrialBlocker = 'Read-only file system';

/** One queued control-plane candidate, highest priority first, oldest on ties. */
export interface QueuedMerge { key: string; id: string; head: string; submittedAt: string; waitingMs: number }
export interface MergeQueue {
  /** The candidate the writer merges next, or null: nothing is due, or an open intent blocks the queue. */
  next: Work | null;
  /** Every candidate due a merge, highest priority then oldest first (`next` leading it), or none while an open intent blocks the queue: the writer starts the first `parallel` of them (GY-3120). */
  due: Work[];
  queue: QueuedMerge[];
  /** The item whose open intent (or unreconciled push) holds the queue until it is reconciled; null when none does. */
  blockedBy: string | null;
}
export const open = (state: MergeLedgerState) => state.state === 'intent' || state.state === 'pushed';
export const gate = (item: Work, name: string) => item.gates.find(entry => entry.name === name)?.passed === true;

const createdAtOf = (item: Pick<Work, 'createdAt'>) => Date.parse(item.createdAt) || 0;
/** A hotfix (an item titled `Hotfix: …`) is merged before every other queued head, so a fix to a bottleneck never waits out the queue. */
export const isHotfix = (item: Pick<Work, 'title'>) => /^hotfix:/i.test(item.title ?? '');
/** The item the loop's base-failure step files for a failing base test (`baseFailureItem`'s title): it unblocks every held head, so it goes first too. */
export const isBaseRepair = (item: Pick<Work, 'title'>) => /^base branch \S+ fails .+ test: /i.test(item.title ?? '');
const mergesFirst = (item: Pick<Work, 'title' | 'yardRepair'>) => isHotfix(item) || isBaseRepair(item) || !!item.yardRepair;
/**
 * The trial-failure refusal the item's own record holds for its exact candidate head, or null: the
 * one fact that takes a head out of the queue (`mergeQueue`'s `trial failed` drop, GY-1524 AC-3)
 * and the ground of the rework releasing the head requires. The queue and the writer's rework debt
 * read the same record, so a head the queue drops is always a head whose rework is asked for
 * (requestPendingReworks re-derives the debt from here, GY-2166: the settlement that first owed a
 * refusal's rework lives only in memory, and the restart that kept the ledger lost it).
 */
export function trialRefusalHeld(candidate: Work['candidate'], state: MergeLedgerState | null | undefined): { reason: string } | null {
  const head = candidate?.sha.toLowerCase();
  return state && head && state.state === 'refused' && state.head === head
    && state.refusal?.kind === 'merge' && state.refusal.reason.startsWith(trialFailurePrefix)
    ? { reason: state.refusal.reason } : null;
}
/**
 * GY-3164: the settle of a flight whose trial passed while the review gate had not. It grounds no
 * rework (it does not start `trialFailurePrefix`) and holds nothing: the fold keeps the passing
 * trial on the refused state, the head is owed nothing while its review gate has not passed, and
 * once it passes the next flight lands the head reusing that kept result — no second trial. A new
 * head carries a different `head`, so the same marker on it never applies.
 */
export const trialAheadOfReviewPrefix = 'trial passed ahead of review';
export const trialAheadOfReviewReason = (key: string) => `${trialAheadOfReviewPrefix}: ${key}'s review gate has not passed for this head; the trial that passed is kept and the head lands once the same head is approved`;
/**
 * The trial this head already passed ahead of its review, kept on its ledger (the settle's refusal
 * marker plus the fold's kept trial for the same head), or null. Only a flight that found no
 * failure records the marker, so a kept trial is a passing one.
 */
export function keptTrialAheadOfReview(candidate: Work['candidate'], state: MergeLedgerState | null | undefined): boolean {
  const head = candidate?.sha.toLowerCase();
  return !!head && !!state && state.state === 'refused' && state.head === head
    && state.refusal?.kind === 'merge' && state.refusal.reason.startsWith(trialAheadOfReviewPrefix)
    && state.trial?.head.toLowerCase() === head;
}
/**
 * Whether the item is owed a merge at its current head — the queue's own `due` test: submitted (a
 * candidate the control plane observed itself, GY-1523), not done, not returned to a worker, with
 * the `build` gate passed as the control plane served it (GY-3164: the trial runs beside review,
 * so the review gate no longer holds a head out of the queue; the landing still requires it).
 * A head the writer's own trial already refused (`trial failed`, GY-1524 AC-3) waits for its rework
 * rather than a second trial; one refused for another cause (a push rejected on an unmoved tip, a
 * hold) is queued again. A head whose trial already passed ahead of review
 * (`keptTrialAheadOfReview`) is owed its landing only once its review gate passes, and lands
 * reusing the kept result. A head held for a base failure waits `baseFailureHoldMs` before it is
 * trialled again on whatever the tip then is (GY-1834). The served gates are the control plane's
 * verdict under the deployment's policy, never this process's own reading of graphyard.json,
 * which an unapplied edit or an older checkout makes diverge (GY-1843).
 */
export function awaitsMerge(item: Work, ledger: Readonly<Record<string, MergeLedgerState>>, now: number): boolean {
  const candidate = item.candidate;
  if (item.stage === 'done' || !item.submission || !candidate || item.observation?.source !== 'control-plane' || item.reworkRequested || item.observation?.merged) return false;
  if (!gate(item, 'build') || item.blocker?.startsWith(readOnlyTrialBlocker)) return false;
  const state = ledger[item.key];
  // GY-3164: the trial already passed; only the review gate still stands between the head and its landing.
  if (keptTrialAheadOfReview(candidate, state)) return gate(item, 'review');
  if (trialRefusalHeld(candidate, state)) return false;
  if (state && state.head === candidate.sha.toLowerCase() && state.state === 'reconciled') return false;
  if (state && state.head === candidate.sha.toLowerCase() && state.state === 'refused' && state.refusal?.reason.startsWith(baseFailurePrefix) && state.intentAt && now - Date.parse(state.intentAt) < baseFailureHoldMs) return false;
  return true;
}

/**
 * The control-plane candidates owed a merge, hotfixes and base-failure repairs first, then by priority (0 first, GY-3098), then the oldest item (by `createdAt`, ties by submission) first.
 * An item whose ledger holds an open intent or an unreconciled push blocks the whole queue:
 * `reconcileIntents` settles it before any new flight starts.
 */
export function mergeQueue(work: readonly Work[], ledger: Readonly<Record<string, MergeLedgerState>>, now: number): MergeQueue {
  const blocking = Object.values(ledger).find(open);
  // The order dispatch releases in (GY-3098): highest priority first, then the oldest item, by when it was filed, not by its latest
  // submission: lead time runs from release, so a head redone after a refusal goes ahead of newer work instead of rejoining at the back.
  const owed = work.filter(item => awaitsMerge(item, ledger, now))
    .sort((a, b) => Number(mergesFirst(b)) - Number(mergesFirst(a)) || a.priority - b.priority || createdAtOf(a) - createdAtOf(b) || submittedAtOf(a) - submittedAtOf(b) || a.key.localeCompare(b.key));
  const queue = owed.map(item => { const at = submittedAtOf(item); return { key: item.key, id: item.id, head: item.candidate!.sha.toLowerCase(), submittedAt: new Date(at).toISOString(), waitingMs: Math.max(0, now - at) }; });
  return { next: blocking ? null : owed[0] ?? null, due: blocking ? [] : owed, queue, blockedBy: blocking?.key ?? null };
}
/** The oldest-submitted candidate due a merge (hotfixes and base-failure repairs first), or null while nothing is due or an open intent blocks the queue (AC-1). */
export const nextToMerge = (work: readonly Work[], ledger: Readonly<Record<string, MergeLedgerState>>, now: number) => mergeQueue(work, ledger, now).next;
