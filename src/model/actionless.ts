import type { Work } from '../model.js';
import { plainReason } from './plain-status.js';

/**
 * Open items the control plane names no action for, for the dashboard.
 *
 * The decision itself is `src/model/next-action.ts`: `actionAccount` says whether an item has an
 * action and, when it has none, which nothing it is. The dashboard cannot call it — that module
 * reaches `node:crypto` through the dispatch record, and nothing in the browser bundle may — so
 * this reads the answer the control plane already wrote onto the item (`work.nextAction`) and
 * classifies the remainder from the item's own record: a dependency or a queue turn is another
 * item's to move, a live lease is a session already moving it, and anything else is an item
 * holding a failing gate with nobody told, which is what the page is here to show.
 *
 * `tests/action-totality.test.ts` asserts this agrees with `stalledItems` over a battery of
 * states, so the two readings cannot drift into disagreeing about what is stuck.
 */

/** A refusal that belongs to another item: that item's action is what moves this one. */
export const deferredRefusal = (reason: string) =>
  /^Dependency .+ is unfinished$/.test(reason)
  || /^Merge queue position \d+ of \d+: \S+ is ahead$/.test(reason)
  || /^Speculative tip on predicted base [0-9a-f]+ has not been published/.test(reason)
  || /^Waiting for \S+ to publish its speculative tip$/.test(reason);

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
 * waits — a dependency, a turn in the merge queue, the session already building it — from the
 * items nothing is moving, which are the ones the page names.
 */
export function actionlessCards(work: Work[], now: number): ActionlessCard[] {
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
      const movedBy = refusal === undefined ? (!failing && item.candidate ? 'the next reading of its pull request' : null)
        : live && failing!.name === 'build' ? item.lease!.owner
          : deferredRefusal(refusal) ? refusal.match(/^Dependency (\S+)|: (\S+) is ahead$|^Waiting for (\S+)/)?.slice(1).find(Boolean) ?? 'another item'
            : null;
      return { item, gate: failing?.name ?? null, heldSince: item.stageEnteredAt, movedBy,
        missing: refusal === undefined ? failing ? `Its ${failing.name} step reports a problem without saying what it is`
          : 'Nothing has been checked about it yet'
          : plainReason(refusal, failing!.name).text };
    })
    .sort((a, b) => Date.parse(a.heldSince) - Date.parse(b.heldSince));
}

/** The items nothing is moving: no action, no other item to wait for, nobody building them. */
export const stalledCards = (work: Work[], now: number) => actionlessCards(work, now).filter(card => !card.movedBy);
