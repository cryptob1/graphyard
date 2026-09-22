import { openActions } from './actions.js';
import type { NextActionKind } from './next-action.js';
import type { Work } from './work.js';

/**
 * Which executors are alive, and which pending actions none of them serves (GY-105).
 *
 * An executor is stateless and invisible between claims: the queue records who holds a row, never
 * who is polling for one. So when every executor is dead the queue looks exactly as it does when
 * every executor is busy — rows pending, nothing claimed — and an action nobody can claim shows as
 * "waiting for an executor" indefinitely. Presence is the missing observation: every claim poll
 * names the executor, its host and the kinds it can run, and the control plane keeps the last time
 * each one asked. It is kept in memory beside the engine, not in the ledger — a poll that claims
 * nothing writes nothing, and presence is only ever a statement about now: after a restart it is
 * empty until the next poll, which is the truth.
 *
 * A pending row is *unserved* when no executor seen inside the liveness window can run its kind.
 * That is reported apart from a row waiting its turn behind other work, with how long it has
 * waited and what to start.
 */

export interface ExecutorPresence { executor: string; host: string; principal: string; kinds: NextActionKind[]; seenAt: string; claims: number }
/**
 * How long a poll keeps an executor live. One claim lease: the shipped executor polls every five
 * seconds and a supervised slot at most every minute, so a live one is always inside it, and a
 * dead one drops out within the same bound that returns its claimed row to the queue.
 */
export const executorLiveMs = 120_000;
export const retainedExecutors = 200;

export class ExecutorRegistry {
  private readonly seen = new Map<string, ExecutorPresence>();
  /** One claim poll: the executor, where it runs, what it can run, and that it asked now. */
  observe(poll: { executor: string; host: string; principal: string; kinds: NextActionKind[] }, now: Date, claimed = false) {
    const key = `${poll.principal}\0${poll.executor}`;
    const previous = this.seen.get(key);
    this.seen.set(key, { executor: poll.executor, host: poll.host, principal: poll.principal, kinds: [...poll.kinds], seenAt: now.toISOString(), claims: (previous?.claims ?? 0) + (claimed ? 1 : 0) });
    if (this.seen.size > retainedExecutors) for (const [stale, entry] of this.seen) { if (this.seen.size <= retainedExecutors) break; if (now.getTime() - Date.parse(entry.seenAt) > executorLiveMs) this.seen.delete(stale); }
  }
  /** Every executor that polled inside the liveness window, most recently seen first. */
  live(now: Date, liveMs = executorLiveMs): ExecutorPresence[] {
    return [...this.seen.values()].filter(entry => now.getTime() - Date.parse(entry.seenAt) <= liveMs).sort((a, b) => Date.parse(b.seenAt) - Date.parse(a.seenAt) || a.executor.localeCompare(b.executor));
  }
}

/** The registry that belongs to one engine, created on first use; tests running several engines in one process never share one. */
const registries = new WeakMap<object, ExecutorRegistry>();
export function executorRegistry(owner: object): ExecutorRegistry {
  let registry = registries.get(owner);
  if (!registry) { registry = new ExecutorRegistry(); registries.set(owner, registry); }
  return registry;
}

export interface UnservedAction {
  key: string; work: string; id: string; kind: NextActionKind; reason: string;
  /** How long the row has been open with nobody able to take it, and since when. */
  waitedMs: number; since: string;
  /** What to start: the executor command that would serve this kind. */
  start: string;
}
export interface ExecutorReport {
  /** The executors seen inside the liveness window, and the window itself. */
  live: ExecutorPresence[]; liveMs: number;
  /** Every kind some live executor serves. */
  served: NextActionKind[];
  /** Pending rows no live executor can claim, longest wait first. */
  unserved: UnservedAction[];
}

/** The command that serves a kind: the supervised slot on a coordinator host, or the bare executor. */
export const startExecutorFor = (kind: NextActionKind) => `start an executor that serves ${kind}: systemctl --user start graphyard-executor@1 on a coordinator host that declared executors (node scripts/graphyard-executor.mjs --install --count 1 declares one), or node scripts/graphyard-executor.mjs --kinds ${kind}`;

/**
 * The pending rows nobody alive can run, judged against the executors seen inside the window. A
 * row a live executor of its kind could take is waiting its turn and is not listed, however long
 * it has waited: that is the queue's own idle report (`idleActionable`), which names a different
 * failure. Only a kind with no live executor at all is unserved.
 */
export function executorReport(all: Work[], registry: ExecutorRegistry, now: Date, liveMs = executorLiveMs): ExecutorReport {
  const live = registry.live(now, liveMs);
  const served = [...new Set(live.flatMap(entry => entry.kinds))].sort() as NextActionKind[];
  const unserved = openActions(all, now)
    .filter(({ row }) => !served.includes(row.kind))
    .map(({ row }) => ({ key: row.key, work: row.work, id: row.id, kind: row.kind, reason: row.reason, waitedMs: Math.max(0, now.getTime() - Date.parse(row.requestedAt)), since: row.requestedAt, start: startExecutorFor(row.kind) }))
    .sort((a, b) => b.waitedMs - a.waitedMs);
  return { live, liveMs, served, unserved };
}

/** One sentence per unserved kind, for master status and the dashboard: the kind, who waits and for how long, and what to start. */
export function describeUnserved(report: Pick<ExecutorReport, 'live' | 'unserved'>): { kind: NextActionKind; text: string; start: string; waitedMs: number; keys: string[] }[] {
  const kinds = new Map<NextActionKind, UnservedAction[]>();
  for (const entry of report.unserved) kinds.set(entry.kind, [...(kinds.get(entry.kind) ?? []), entry]);
  const wait = (ms: number) => ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h${Math.floor(ms % 3_600_000 / 60_000)}m` : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1000)}s`;
  return [...kinds.entries()].map(([kind, rows]) => {
    const [longest] = rows;
    const others = rows.length > 1 ? ` and ${rows.length - 1} more` : '';
    const fleet = report.live.length ? `the ${report.live.length} live executor${report.live.length === 1 ? '' : 's'} (${report.live.map(entry => entry.executor).join(', ')}) serve${report.live.length === 1 ? 's' : ''} none of it` : 'no executor is alive';
    return { kind, keys: rows.map(row => row.key), waitedMs: longest.waitedMs, start: longest.start,
      text: `Nothing can run ${kind}: ${longest.key} has waited ${wait(longest.waitedMs)}${others} for an executor that serves it, and ${fleet}. It is not queued behind other work — ${longest.start}` };
  }).sort((a, b) => b.waitedMs - a.waitedMs);
}
