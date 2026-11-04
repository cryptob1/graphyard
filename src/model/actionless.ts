import { observationWindowHold, type Work } from '../model.js';
import { mergeWriterRefusal } from './gates.js';
import { currentMergeStep, type MergeLedgerState } from './merge-ledger.js';
import { mergeQueue } from './merge-queue.js';
import { plainReason } from './plain-status.js';

/**
 * Open items the control plane names no action for, for the dashboard.
 *
 * The decision itself is `src/model/next-action.ts`: `actionAccount` says whether an item has an
 * action and, when it has none, which nothing it is. The dashboard cannot call it — that module
 * reaches `node:crypto` through the dispatch record, and nothing in the browser bundle may — so
 * this reads the answer the control plane already wrote onto the item (`work.nextAction`) and
 * classifies the remainder from the item's own record: a dependency is another
 * item's to move, a live lease is a session already moving it, and anything else is an item
 * holding a failing gate with nobody told, which is what the page is here to show.
 *
 * `tests/action-totality.test.ts` asserts this agrees with `stalledItems` over a battery of
 * states, so the two readings cannot drift into disagreeing about what is stuck.
 */

/** A refusal that belongs to another item: that item's action is what moves this one. */
export const deferredRefusal = (reason: string) => /^Dependency .+ is unfinished$/.test(reason);

export interface ActionlessCard {
  item: Work;
  /** The gate that refuses, and what it says is missing, in plain words. */
  gate: string | null; missing: string;
  /** How long the item has held that gate. */
  heldSince: string;
  /** Set when another item or a live session is what moves this one; null when nothing is. */
  movedBy: string | null;
}

/**
 * Every open item with no computed action, newest wait last. `movedBy` separates the healthy
 * waits — a dependency, the session already building it — from the
 * items nothing is moving, which are the ones the page names.
 */
export function actionlessCards(work: Work[], now: number): ActionlessCard[] {
  const queued = mergeQueuePositions(work, now);
  // `null` is the control plane having computed an action and found none; `undefined` is an item
  // it has not computed one for at all — an unevaluated snapshot, never a stalled item — and the
  // difference is the whole signal, so nothing here treats the two as the same absence.
  return work.filter(item => item.ready && item.stage !== 'done' && item.nextAction === null)
    .map(item => {
      const failing = item.gates.find(gate => !gate.passed);
      const reasons = failing?.reasons ?? [];
      const refusal = reasons.find(reason => !deferredRefusal(reason)) ?? reasons[0];
      const live = !!item.lease && Date.parse(item.lease.expiresAt) > now;
      // The same order the control plane decides in: a gate refusing without saying why is
      // nobody's to move, then the session already doing what the build gate waits for, then the
      // item a deferred refusal points at. Anything else has nothing moving it.
      const window = observationWindowHold(item, new Date(now));
      // GY-2963: the merge writer's own trial is what a merge-writer refusal waits on, and while its
      // steps advance the item is moving, never stalled — the fault the Work page read as a hang.
      const step = currentMergeStep(item, now);
      const movedBy = refusal === undefined ? (!failing && item.candidate ? 'the next reading of its pull request' : null)
        : live && failing!.name === 'build' ? item.lease!.owner
          : window ? `its observation window, which closes at ${window.notBefore}`
          : deferredRefusal(refusal) ? refusal.match(/^Dependency (\S+)|: (\S+) is ahead$|^Waiting for (\S+)/)?.slice(1).find(Boolean) ?? 'another item'
            : step?.fresh && mergeWriterRefusal(failing!.name, refusal) ? `the merge writer's trial (${step.step})`
            : queued.has(item.id) && mergeWriterRefusal(failing!.name, refusal) ? queuedSentence(queued.get(item.id)!) : null;
      const missing = refusal === undefined ? failing ? `Its ${failing.name} step reports a problem without saying what it is`
          : 'Nothing has been checked about it yet'
          : step && !step.fresh && mergeWriterRefusal(failing!.name, refusal)
            ? `${plainReason(refusal, failing!.name).text}; its trial last ran ${step.step}`
            : plainReason(refusal, failing!.name).text;
      return { item, gate: failing?.name ?? null, heldSince: item.stageEnteredAt, movedBy, missing };
    })
    .sort((a, b) => Date.parse(a.heldSince) - Date.parse(b.heldSince));
}

/** The items nothing is moving: no action, no other item to wait for, nobody building them. */
export const stalledCards = (work: Work[], now: number) => actionlessCards(work, now).filter(card => !card.movedBy);

/** A head waiting its turn in the merge writer's serial queue behind a trial: its 1-based place among the waiting heads, and the flight ahead. */
export interface QueuedBehind { position: number; of: number; ahead: string; step: string }
/**
 * The heads the merge writer's queue holds behind the merge in flight (`mergeQueue` over the
 * items' folded ledgers), by item id. A stalled flight keeps its waiting heads queued; the
 * flight itself reports the stall.
 */
export function mergeQueuePositions(work: Work[], now: number): Map<string, QueuedBehind> {
  const ledger: Record<string, MergeLedgerState> = Object.fromEntries(work.flatMap(item => item.mergeLedger ? [[item.key, item.mergeLedger]] : []));
  const queue = mergeQueue(work, ledger, now);
  const flight = queue.blockedBy ? work.find(item => item.key === queue.blockedBy) : undefined;
  const step = flight && currentMergeStep(flight, now);
  if (!flight || !step) return new Map();
  const waiting = queue.queue.filter(entry => entry.key !== flight.key);
  return new Map(waiting.map((entry, index) => [entry.id, { position: index + 1, of: waiting.length, ahead: flight.key, step: step.step }]));
}
/** The plain sentence for a queued head. */
export const queuedSentence = (queued: QueuedBehind) => `In the merge queue: ${queued.position} of ${queued.of}, behind ${queued.ahead} (${queued.step})`;
