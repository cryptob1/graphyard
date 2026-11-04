// Concern: the merge writer's serial queue (GY-1524), pure over the work and its folded ledger so the board reads the order the writer merges in.
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

/** One queued control-plane candidate, oldest submission first. */
export interface QueuedMerge { key: string; id: string; head: string; submittedAt: string; waitingMs: number }
export interface MergeQueue {
  /** The candidate the writer merges next, or null: nothing is due, or an open intent blocks the queue. */
  next: Work | null;
  /** Every candidate due a merge, oldest first (`next` leading it), or none while an open intent blocks the queue: what a batch takes from (GY-2088). */
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
const mergesFirst = (item: Pick<Work, 'title'>) => isHotfix(item) || isBaseRepair(item);
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
 * The control-plane candidates owed a merge, hotfixes and base-failure repairs first then the oldest item (by `createdAt`, ties by submission) first: submitted (a candidate the
 * control plane observed itself, GY-1523), not done, not returned to a worker, with the `build`
 * and `review` gates passed as the control plane served them: its review gate fails a sensitive delta until its
 * approval, and passes a normal one reviewed after merge (GY-1525). A head the writer's own
 * trial already refused (`trial failed`, GY-1524 AC-3) waits for its rework rather than a second
 * trial; one refused `base moved N times` is queued again. An item whose ledger holds an open intent
 * or an unreconciled push blocks the whole queue: `reconcileIntents` settles it before any new merge,
 * so never more than one merge is in flight.
 */
export function mergeQueue(work: readonly Work[], ledger: Readonly<Record<string, MergeLedgerState>>, now: number): MergeQueue {
  const blocking = Object.values(ledger).find(open);
  const owed = work.filter(item => {
    const candidate = item.candidate;
    if (item.stage === 'done' || !item.submission || !candidate || item.observation?.source !== 'control-plane' || item.reworkRequested || item.observation?.merged) return false;
    if (!gate(item, 'build')) return false;
    // The served review gate is the control plane's verdict under the deployment's policy, never this process's
    // own reading of graphyard.json, which an unapplied edit or an older checkout makes diverge (GY-1843).
    if (!gate(item, 'review')) return false;
    const state = ledger[item.key];
    if (trialRefusalHeld(candidate, state)) return false;
    if (state && state.head === candidate.sha.toLowerCase() && state.state === 'reconciled') return false;
    // GY-1834: a head held for a base failure waits `baseFailureHoldMs` before it is trialled again on whatever the tip then is.
    if (state && state.head === candidate.sha.toLowerCase() && state.state === 'refused' && state.refusal?.reason.startsWith(baseFailurePrefix) && state.intentAt && now - Date.parse(state.intentAt) < baseFailureHoldMs) return false;
    return true;
  // The oldest item first, by when it was filed, not by its latest submission: lead time runs from release, so a head
  // redone after a refusal goes ahead of newer work instead of rejoining at the back.
  }).sort((a, b) => Number(mergesFirst(b)) - Number(mergesFirst(a)) || createdAtOf(a) - createdAtOf(b) || submittedAtOf(a) - submittedAtOf(b) || a.key.localeCompare(b.key));
  const queue = owed.map(item => { const at = submittedAtOf(item); return { key: item.key, id: item.id, head: item.candidate!.sha.toLowerCase(), submittedAt: new Date(at).toISOString(), waitingMs: Math.max(0, now - at) }; });
  return { next: blocking ? null : owed[0] ?? null, due: blocking ? [] : owed, queue, blockedBy: blocking?.key ?? null };
}
/** The oldest-submitted candidate due a merge (hotfixes and base-failure repairs first), or null while nothing is due or an open intent blocks the queue (AC-1). */
export const nextToMerge = (work: readonly Work[], ledger: Readonly<Record<string, MergeLedgerState>>, now: number) => mergeQueue(work, ledger, now).next;
