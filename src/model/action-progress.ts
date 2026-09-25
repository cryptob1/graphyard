import type { Work } from './work.js';
import type { NextActionKind } from './next-action.js';
import type { ActionRecord, ActionRow } from './actions.js';

/**
 * What the rows say about themselves.
 *
 * `actions.ts` holds the durable rows and the transitions that move them; this is the reading of
 * one: which state it is in, how long a failed attempt waits, whether its attempts are making any
 * progress at all, and what the whole queue holds for a reader. Everything here is pure over a row
 * and the clock, and nothing here writes one — `settleAction` asks it what the failure it just
 * recorded means, and `master status`, the executor API and the dashboard ask it what to show.
 *
 * It is a module of its own because the judgment is the part that grew: a failed row used to back
 * off on its attempt count and nothing else, and saying whether a row is retrying or stalled —
 * which decides both the backoff and every count a reader sees — is a concern beside the rows
 * rather than a detail of writing one. Its only dependency on `actions.ts` is the shape of a row.
 */

/**
 * How long a completed action holds its situation before the row is offered again. An action's
 * effect is not instant — a launched session has to claim, a provider call has to be observed —
 * and re-running it inside that window would double the effect. After it, a situation that still
 * stands is a situation the action did not fix, and another attempt is owed.
 */
export const actionSettleMs = 10 * 60_000;
/** A failed attempt backs off on a widening interval, never below the first step or above the last. */
export const actionRetryMinMs = 30_000, actionRetryMaxMs = 10 * 60_000;
/** A row nobody has claimed for longer than this is idle while it is actionable; see `idleActionable`. */
export const actionIdleMs = 5 * 60_000;
/**
 * How many consecutive failures with an unchanged reason make a row a stall rather than a retry.
 *
 * One value decides all of it: the classification on the row, what the queue snapshot counts, what
 * `master status` names and what the dashboard puts on the item's card. Two failures are a fault
 * that may be transient; a third identical one is a condition that is not going to change by being
 * asked again, whatever produced it.
 */
export const actionStallThreshold = 3;
/**
 * How long a stalled row first waits between attempts, whatever its attempt count.
 *
 * A widening backoff on the attempt count is the right answer to a fault that may be load: each
 * attempt costs something and the next one may succeed. Attempts made before a row stalled say
 * nothing about the condition it now keeps meeting, so backoff earned against them must not
 * outlive it: a row that stalls starts again from this recheck instead of waiting out a ceiling
 * computed from attempts that could not have succeeded.
 */
export const actionStallRecheckMs = 60_000;
/**
 * The longest a stalled row waits between attempts (GY-185).
 *
 * A fixed one-minute recheck assumed the condition would clear. One that never did — a delivered
 * item's merge refused for want of an authorization, a dispatch refused because delivered work is
 * immutable — was attempted about every two minutes for days: 2112 attempts on one row, each saving
 * a whole document under the coordination lock. So the recheck grows with the unchanged run itself:
 * each further failure for the same reason doubles it, up to this ceiling. A condition that clears
 * soon is still answered soon, and one that does not costs a shrinking share of the lock.
 */
export const actionStallMaxMs = 30 * 60_000;
/** The wait after `failures` consecutive failures for one unchanged reason: the recheck at the threshold, doubling per failure after it. */
export const actionStallDelay = (failures: number) =>
  Math.min(actionStallRecheckMs * 2 ** Math.max(0, failures - actionStallThreshold), actionStallMaxMs);

export const actionRetryDelay = (attempts: number) => Math.min(actionRetryMinMs * 2 ** Math.max(0, attempts - 1), actionRetryMaxMs);

/**
 * The longest a row can go from its first failure to being classified as stalled: the backoffs
 * between the failures the threshold needs. A stall is therefore visible well inside the
 * `actionIdleMs` bound the fleet applies to a row nobody is acting on — a row that is being
 * attempted and getting nowhere reaches somebody no later than one that is not attempted at all.
 */
export const actionStallLatencyMs = Array.from({ length: actionStallThreshold - 1 }, (_unused, index) => actionRetryDelay(index + 1))
  .reduce((total, delay) => total + delay, 0);

/**
 * Why a row is making no progress: the classification a row carries once its recent attempts all
 * failed for one unchanged reason. `actionStall` derives it; nothing else decides it.
 */
export interface ActionStall {
  /** The reason every one of those attempts gave, unchanged. */
  reason: string;
  /**
   * Consecutive failures sharing that reason, as far back as the row's retained history goes, and
   * the attempts the row has made in all.
   */
  failures: number; attempts: number;
  /** When that unchanged run of failures began. */
  since: string;
}

/**
 * Whether this row is stalling rather than retrying, from its own history.
 *
 * An action that fails is retried, and a retry is a reasonable bet only while something about the
 * attempt can change. A row whose last `actionStallThreshold` failures gave one identical reason
 * is not waiting out a transient fault: it is re-running an impossibility, and every further
 * attempt will produce the same line. The control plane already holds every fact needed to say so
 * — the attempt count, each attempt's reason, and when the row was requested — so this is a
 * reading of the record and not a new source of truth. A reason that changes between attempts
 * ends the run: something moved, and the widening backoff is the right answer again.
 */
export function actionStall(row: ActionRow): ActionStall | null {
  const failures: ActionRecord[] = [];
  for (const entry of [...row.history].reverse()) {
    if (entry.event === 'failed') { failures.push(entry); continue; }
    // A claim or a reclaim sits between two attempts and says nothing about either. Anything else
    // — a completion, a reopening, a fresh request — is progress, and ends the run of failures.
    if (entry.event === 'claimed' || entry.event === 'reclaimed') continue;
    break;
  }
  const run: ActionRecord[] = [];
  for (const entry of failures) { if (run.length && entry.reason !== run[0].reason) break; run.push(entry); }
  if (run.length < actionStallThreshold) return null;
  return { reason: run[0].reason, failures: run.length, attempts: row.attempts, since: run[run.length - 1].at };
}

/**
 * When a failed row is offered again.
 *
 * Two situations, two schedules. A row whose failures keep changing is meeting faults that may
 * pass, and each attempt costs something, so it backs off on the attempt count. A row that keeps
 * failing for the same reason is stalled: its wait restarts from `actionStallRecheckMs`, whatever
 * attempts it made before, and doubles with each further identical failure up to
 * `actionStallMaxMs` (`actionStallDelay`). A condition that clears soon is claimed within a minute
 * or two; one that stands is attempted less and less often, never on a steady beat.
 */
export const actionRetryAt = (row: ActionRow, now: Date) => {
  const stall = actionStall(row);
  return new Date(now.getTime() + (stall ? actionStallDelay(stall.failures) : actionRetryDelay(row.attempts))).toISOString();
};

/**
 * The refusals `launchProducer` (src/producer.ts) gives a request it will never launch again,
 * whatever time passes: one of its sessions did not fail or expire ("one session per request"), or
 * it has had `sessionRetryLimit` sessions ("no further automatic attempt"). Both begin with the
 * request id (`Request <id> ...`), and an executor settles its row failed with that message.
 */
export const producerLaunchStops = ['; one session per request', '; no further automatic attempt'] as const;

/**
 * Why no executor may launch a producer request again, read from the durable action rows rather
 * than from any host's producer ledger: an attempt of the request's dispatch row — open or retired
 * — was refused by the launcher with a stop (`producerLaunchStops`). The ledger that refusal comes
 * from is local to the host whose executor claimed the row, and an executor on another host sees
 * none of its sessions and would launch the request afresh; so once one executor has recorded the
 * stop, the request's dispatch is no longer offered to any executor (`proofStep`) and the proof
 * is left to the attestation the stop names. Null while no attempt was so refused.
 */
export function producerLaunchStop(work: Pick<Work, 'actionQueue'>, requestId: string): ActionRecord | null {
  const prefix = `Request ${requestId} `;
  const rows = [...(work.actionQueue?.actions ?? []), ...(work.actionQueue?.history ?? [])]
    .filter(row => row.kind === 'dispatch' && row.inputs.kind === 'dispatch' && row.inputs.target === 'proof');
  for (const row of rows) for (const entry of row.history)
    if (entry.event === 'failed' && entry.reason.startsWith(prefix) && producerLaunchStops.some(stop => entry.reason.includes(stop))) return entry;
  return null;
}

/** Whether an executor still holds this row: a claim that has not expired on the reading clock. */
export const claimLive = (row: ActionRow, now: Date) => !!row.claim && Date.parse(row.claim.expiresAt) > now.getTime();
export const settling = (row: ActionRow, now: Date) => row.state === 'done' && !!row.resolvedAt && now.getTime() - Date.parse(row.resolvedAt) < actionSettleMs;
export const waitingToRetry = (row: ActionRow, now: Date) => !!row.retryAt && Date.parse(row.retryAt) > now.getTime();
/** A row an executor may take now: open, out of backoff, and not inside a completed action's settle window. */
export const claimable = (row: ActionRow, now: Date) => !settling(row, now) && !waitingToRetry(row, now) && (row.state === 'pending' || !claimLive(row, now));

/** One row as a reader sees it: what it is for, how long it has waited, and what it last did. */
export interface QueueEntry {
  key: string; work: string; id: string; kind: NextActionKind; reason: string;
  /** How long since the row was requested, and what its attempts have come to. */
  waitedMs: number; attempts: number; lastFailure: string | null;
  /** When the row is offered again, while it is inside a failure backoff; null when it is not. */
  retryAt: string | null;
  /** Why the row is making no progress, once its failures stopped changing; null when they have not. */
  stall: ActionStall | null;
}
export interface QueueSnapshot {
  /**
   * Every open row on the queue — `pending + claimed + settling + backingOff` — so the count a
   * reader sees accounts for every row that is owed, whether or not it can be claimed this instant.
   * A row inside a backoff used to be counted by none of the four and listed by none of the lists,
   * which is how three reviews nobody could launch read as a fleet with nothing to do.
   */
  open: number;
  pending: number; claimed: number; settling: number;
  /** Open rows waiting out a failure backoff: not claimable this instant, still owed. */
  backingOff: number;
  completed: number;
  byKind: Record<string, number>;
  /** Rows nobody is running and nothing is holding back, oldest first, with how long they have waited. */
  waiting: QueueEntry[];
  /** Rows inside a failure backoff, longest wait first, each with the instant it is offered again. */
  backoff: QueueEntry[];
  /**
   * Every row that is stalling rather than retrying (`actionStall`), longest wait first, whatever
   * else it is doing — being attempted again, or waiting out its recheck. Not a fifth bucket: a
   * stalled row is already counted once above, and this names which of them are getting nowhere.
   */
  stalled: QueueEntry[];
  /** The longest an open row has gone unclaimed; null when nothing is open. */
  oldestPendingMs: number | null;
  executors: { executor: string; host: string; actions: number }[];
}

/** What the queue holds right now, for master status and the dashboard. */
export function queueSnapshot(all: Work[], now: Date): QueueSnapshot {
  const rows = all.flatMap(work => (work.actionQueue?.actions ?? []).map(row => ({ work, row })));
  const byKind: Record<string, number> = {};
  for (const { row } of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
  const view = (row: ActionRow): QueueEntry => ({ key: row.key, work: row.work, id: row.id, kind: row.kind, reason: row.reason,
    waitedMs: Math.max(0, now.getTime() - Date.parse(row.requestedAt)), attempts: row.attempts,
    lastFailure: row.result === 'failed' ? row.resolution ?? null : null,
    retryAt: waitingToRetry(row, now) ? row.retryAt ?? null : null, stall: actionStall(row) });
  const longestFirst = (a: QueueEntry, b: QueueEntry) => b.waitedMs - a.waitedMs;
  const waiting = rows.filter(({ row }) => claimable(row, now)).map(({ row }) => view(row)).sort(longestFirst);
  const backoff = rows.filter(({ row }) => waitingToRetry(row, now)).map(({ row }) => view(row)).sort(longestFirst);
  const stalled = rows.filter(({ row }) => !!actionStall(row)).map(({ row }) => view(row)).sort(longestFirst);
  const executors = new Map<string, { executor: string; host: string; actions: number }>();
  for (const { row } of rows) {
    if (!claimLive(row, now)) continue;
    const key = `${row.claim!.executor}@${row.claim!.host}`;
    const entry = executors.get(key) ?? { executor: row.claim!.executor, host: row.claim!.host, actions: 0 };
    entry.actions += 1; executors.set(key, entry);
  }
  return {
    open: rows.length,
    pending: waiting.length,
    claimed: rows.filter(({ row }) => claimLive(row, now)).length,
    settling: rows.filter(({ row }) => settling(row, now)).length,
    backingOff: backoff.length,
    completed: all.reduce((total, work) => total + (work.actionQueue?.history ?? []).filter(row => row.result === 'done').length, 0)
      + rows.filter(({ row }) => row.state === 'done').length,
    byKind, waiting, backoff, stalled, oldestPendingMs: waiting.length ? waiting[0].waitedMs : null,
    executors: [...executors.values()].sort((a, b) => a.executor.localeCompare(b.executor)),
  };
}

/**
 * Items that have something to do and nobody doing it, for longer than the bound.
 *
 * This is the measurement the inversion is for: under a master session an item sat idle whenever
 * the loop had no step for its situation. With the control plane naming the action, an idle item
 * is always an unclaimed row, and this reports exactly those.
 */
export function idleActionable(all: Work[], now: Date, thresholdMs = actionIdleMs) {
  return queueSnapshot(all, now).waiting.filter(entry => entry.waitedMs > thresholdMs);
}

/**
 * The rows of one item that are stalling rather than retrying, with how long each has been open.
 *
 * Its own reading is what the dashboard needs: a card is drawn from one work document, and a
 * stall is a fact about that item, not about the fleet. `queueSnapshot(...).stalled` is the same
 * classification across every item.
 */
export function stalledActions(work: Work, now: Date) {
  return (work.actionQueue?.actions ?? []).flatMap(row => {
    const stall = actionStall(row);
    return stall ? [{ id: row.id, kind: row.kind, stall, retryAt: row.retryAt ?? null, openMs: Math.max(0, now.getTime() - Date.parse(row.requestedAt)) }] : [];
  }).sort((a, b) => b.openMs - a.openMs);
}
