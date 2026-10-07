// Concern: a close decision that went stale on a revision race, read from its item's decision history (GY-1439).
import type { Closure } from './closure.js';

/** The fields of a decision history row these rules read. */
export type CloseHistoryRow = { id: string; action: string; state: string; input?: any; requestedAt?: string; staleAt?: string; outcome?: string | null; reason?: string };
/** The fields of an item these rules read. */
type Item = { key: string; stage: string; revision?: number; closure?: Closure | null };

/**
 * How many stale settles in a row of one action on one item the loop carries before it is the
 * master's: the loop requests a stale close again up to this many times, and master status raises
 * one attention line for the series only once it is reached (GY-1439).
 */
export const staleAttentionAttempts = 3;

/**
 * The trailing run of stale settles of `action` in the item's history, oldest first: every
 * decision of that action after the last one that settled any other way. Empty when the latest
 * decision of the action is not stale.
 */
export function staleRun<T extends CloseHistoryRow>(decisions: readonly T[], action: string): T[] {
  const run: T[] = [];
  for (const decision of decisions.filter(entry => entry.action === action).reverse()) {
    if (decision.state !== 'stale') break;
    run.unshift(decision);
  }
  return run;
}

/** The latest close decision still waiting to be applied — requested, or approved with no outcome yet — or null. */
export function pendingClose<T extends CloseHistoryRow>(decisions: readonly T[]): T | null {
  const latest = decisions.filter(decision => decision.action === 'close').at(-1);
  return latest && (latest.state === 'requested' || latest.state === 'approved') ? latest : null;
}

/** The revision a stale decision was requested against and the one the server found, when the race was on the item revision. */
export function revisionRace(decision: Pick<CloseHistoryRow, 'input' | 'outcome'>): { expected: number; current: number } | null {
  const expected = decision.input?.expectedRevision, current = /Task revision changed \(now (\d+)\)/.exec(decision.outcome ?? '')?.[1];
  return typeof expected === 'number' && current !== undefined ? { expected, current: Number(current) } : null;
}

/**
 * Whether the grounds a close decision was judged on still describe the item at its current
 * revision, or why not. What a duplicate or superseded closure rests on is the item it names, and
 * an obsolete one on the item alone: a review settled, a bot round authorized or an observation
 * refreshed moves the revision without touching either. The item must still be open, and the
 * item it names must be another one the graph holds that was not itself closed (a closed answer
 * answers nothing). A commit named as the superseding change is taken as it stands.
 */
export function closeGrounds(item: Item, input: { kind?: string; ref?: string | null } | undefined, work: readonly Item[]): string | null {
  if (item.stage === 'done') return `${item.key} is no longer open`;
  const ref = input?.ref ?? null;
  if (!ref || input?.kind === 'obsolete' || !/^[A-Z][A-Z0-9]*-\d+$/.test(ref)) return null;
  if (ref === item.key) return `${item.key} cannot be closed as a ${input?.kind} of itself`;
  const named = work.find(entry => entry.key === ref);
  if (!named) return `${ref}, which the closure names, is not an item the graph holds`;
  if (named.stage === 'done' && named.closure) return `${ref}, which the closure names, was itself closed (${named.closure!.kind}${named.closure!.ref ? ` of ${named.closure!.ref}` : ''})`;
  return null;
}

/**
 * The stale close the loop requests again itself, or why it does not: the item's latest close
 * settled stale on a race of the item revision it pinned (a triage closure binds its judgement,
 * not the revision, and is not one), fewer than `staleAttentionAttempts` settled so in a row, and
 * its grounds still hold at the item's current revision (`closeGrounds`). `input` is the closure
 * the stale decision carried, without the revision it pinned: the request binds the current one.
 */
export function convergibleClose<T extends CloseHistoryRow>(item: Item, decisions: readonly T[], work: readonly Item[]):
  { decision: T; run: T[]; race: { expected: number; current: number }; input: { kind: string; ref?: string | null } } | { decision: T; run: T[]; refused: string } | null {
  const run = staleRun(decisions, 'close'), decision = run.at(-1);
  if (!decision || decision.input?.triageAt !== undefined) return null;
  const race = revisionRace(decision);
  if (!race) return { decision, run, refused: `it settled stale on something other than the item revision (${decision.outcome ?? 'no reason recorded'})` };
  if (run.length >= staleAttentionAttempts) return { decision, run, refused: `${run.length} close requests in a row settled stale` };
  const grounds = closeGrounds(item, decision.input, work);
  if (grounds) return { decision, run, refused: `its grounds no longer hold: ${grounds}` };
  const input = { ...decision.input } as { kind: string; ref?: string | null; expectedRevision?: number };
  delete input.expectedRevision;
  return { decision, run, race, input };
}

/** The key of the one named wait a series of stale settles of `action` on an item records (GY-1439). */
export const staleWaitKey = (work: { id: string }, action: string) => `wait:decision-stale:${work.id}:${action}`;
