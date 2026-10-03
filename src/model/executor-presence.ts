import { openActions } from './actions.js';
import { executorRunnableKinds } from './action-kinds.js';
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
 * empty until the next poll, and that emptiness is judged only once a liveness window has passed.
 *
 * A pending row is *unserved* when no executor seen inside the liveness window can run its kind.
 * That is reported apart from a row waiting its turn behind other work, with how long it has
 * waited and what to start.
 *
 * Only a kind an executor may run at all is judged that way. `escalate` and `request-rework` are
 * `in-step` judgments (`action-kinds.ts`): an executor is forbidden a handler for either, and the
 * shipped one refuses the kind outright. A standing escalation is therefore never a fleet failure
 * however long it waits — it waits on the judgment it names, which master status already reports
 * with the command that answers it — and naming it here would report a healthy fleet as broken and
 * offer a start command the executor rejects.
 *
 * Nor is a pending `merge` row unserved while a live master loop merges (GY-916). Exactly one
 * component merges (GY-245): the loop acquires every merge itself and every executor refuses the
 * kind while it lives, so a merge row waits on the loop's next cycle, not on an executor, and the
 * remedy `--kinds merge` would install the very configuration the executors refuse. The loop is
 * known two ways: the master CLI on its own host detects it (`detectLoopMerger`), and the control
 * plane sees the loop itself — every coordination read the loop's cycle and dispatcher make names
 * it (`loopPresenceHeader`), so a live loop is live however long it has had nothing to merge
 * (`LoopRegistry`). Until this process has seen one such read (a restart, another replica), the
 * merge requests its ledger holds from the loop's `daemon-` instance stand in (`ledgerLoopMerger`).
 */

export interface ExecutorPresence { executor: string; host: string; principal: string; kinds: NextActionKind[]; seenAt: string; claims: number }
/**
 * How long a poll keeps an executor live. One claim lease: the shipped executor polls every five
 * seconds and a supervised slot at most every minute, so a live one is always inside it, and a
 * dead one drops out within the same bound that returns its claimed row to the queue.
 */
export const executorLiveMs = 120_000;
export const retainedExecutors = 200;

/**
 * How long a loop's merge request keeps it the installation's merger on the control plane's view
 * when this process has not seen the loop read. The fallback only: the loop requests a merge only
 * when something is mergeable, so the window spans many cycles; past it the report is the presence
 * report it always was, never a loop inferred from nothing.
 */
export const loopMergerLiveMs = 3_600_000;
/** The master loop that merges on this installation, as the report needs it: live, and named. */
export interface ReportedLoopMerger { live: boolean; name: string }

/**
 * The header on the master loop's coordination reads (`graphyard master run`): its cycle interval
 * in whole seconds. Only a coordinator's read counts; the loop is the one coordinator that sends it.
 */
export const loopPresenceHeader = 'X-Graphyard-Loop-Interval';
export interface LoopPresence { principal: string; intervalSeconds: number; seenAt: string }
/**
 * How long one read keeps the loop live: three of its cycles, never under an executor's window —
 * the rule `daemonSummary` applies to the loop's own cursor. The dispatcher beside the cycle reads
 * every few seconds, so a long cycle does not lapse it.
 */
export const loopPresenceLiveMs = (intervalSeconds: number) => Math.max(3 * intervalSeconds * 1000, executorLiveMs);

/** The loop as the control plane last saw it read, in memory beside the engine like executor presence. */
export class LoopRegistry {
  private latest: LoopPresence | null = null;
  observe(poll: { principal: string; intervalSeconds: number }, now: Date) {
    this.latest = { principal: poll.principal, intervalSeconds: poll.intervalSeconds, seenAt: now.toISOString() };
  }
  live(now: Date): LoopPresence | null {
    const latest = this.latest;
    return latest && now.getTime() - Date.parse(latest.seenAt) <= loopPresenceLiveMs(latest.intervalSeconds) ? latest : null;
  }
}
const loopRegistries = new WeakMap<object, LoopRegistry>();
export function loopRegistry(owner: object): LoopRegistry {
  let registry = loopRegistries.get(owner);
  if (!registry) { registry = new LoopRegistry(); loopRegistries.set(owner, registry); }
  return registry;
}
/** The interval a coordination read names, or null when it names none or an unsupported one (`master run` accepts 5–900). */
export function loopPresenceInterval(header: string | string[] | undefined): number | null {
  const value = Number(Array.isArray(header) ? header[0] : header);
  return Number.isInteger(value) && value >= 5 && value <= 900 ? value : null;
}

/** The installation's loop as the control plane knows it: seen reading, else its ledger's merge requests. */
export async function reportedLoopMerger(registry: LoopRegistry, query: (text: string, values: unknown[]) => Promise<{ rows: any[] }>, now: Date): Promise<ReportedLoopMerger | null> {
  const seen = registry.live(now);
  if (seen) return { live: true, name: `the master loop (${seen.principal}, cycling every ${seen.intervalSeconds}s, last read ${seen.seenAt})` };
  return ledgerLoopMerger(query, now);
}

/**
 * The control plane's own reading of the loop (GY-916): the newest merge request its ledger holds
 * from a `daemon-` merge instance — the instance only the durable loop mints (`daemonExecutor`);
 * an executor's is `executor-…` — inside the window. A range read on the `(kind, created_at)` index.
 */
export async function ledgerLoopMerger(query: (text: string, values: unknown[]) => Promise<{ rows: any[] }>, now: Date, liveMs = loopMergerLiveMs): Promise<ReportedLoopMerger | null> {
  const [latest] = (await query("SELECT payload->'details'->>'requestedBy' AS by, created_at FROM events WHERE kind='merge.enqueue.requested' AND created_at > $1 AND payload->'details'->>'requestedBy' LIKE '%#daemon-%' ORDER BY created_at DESC LIMIT 1",
    [new Date(now.getTime() - liveMs)])).rows;
  return latest ? { live: true, name: `the master loop (${String(latest.by).split('#')[0]}, last merge request ${new Date(latest.created_at).toISOString()})` } : null;
}

export class ExecutorRegistry {
  private readonly seen = new Map<string, ExecutorPresence>();
  /**
   * When this registry began listening (GY-1086). Presence is in memory, so a control plane that
   * has just started has heard from nobody yet: until one liveness window has passed, an empty
   * registry is a fleet not yet heard from, not a fleet that is down.
   */
  constructor(readonly since: Date = new Date()) {}
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
  /** The live master loop that serves `merge` on this installation, when one is known; merge rows then wait on it. */
  loop?: ReportedLoopMerger | null;
  /** Nobody has polled yet and the registry is younger than one liveness window: nothing is judged unserved until it is not. */
  listening?: boolean;
}

/** The command that serves a kind: the supervised slot on a coordinator host, or the bare executor. */
export const startExecutorFor = (kind: NextActionKind) => `start an executor that serves ${kind}: systemctl --user start graphyard-executor@1 on a coordinator host that declared executors (node scripts/graphyard-executor.mjs --install --count 1 declares one), or node scripts/graphyard-executor.mjs --kinds ${kind}`;

/**
 * The pending rows nobody alive can run, judged against the executors seen inside the window. A
 * row a live executor of its kind could take is waiting its turn and is not listed, however long
 * it has waited: that is the queue's own idle report (`idleActionable`), which names a different
 * failure. A row whose kind no executor may ever run is not listed either — no fleet serves it by
 * design. Only an executor-runnable kind with no live executor at all is unserved. A registry
 * still inside its first liveness window that nobody has polled judges nothing: every executor
 * alive before the control plane restarted is still to be heard from.
 */
export function executorReport(all: Work[], registry: ExecutorRegistry, now: Date, liveMs = executorLiveMs, loop: ReportedLoopMerger | null = null): ExecutorReport {
  const live = registry.live(now, liveMs);
  const served = [...new Set(live.flatMap(entry => entry.kinds))].sort() as NextActionKind[];
  const age = now.getTime() - registry.since.getTime();
  if (!live.length && age >= 0 && age < liveMs) return { live, liveMs, served, unserved: [], listening: true };
  const merging = loop?.live ? loop : null;
  const unserved = openActions(all, now)
    .filter(({ row }) => (executorRunnableKinds as readonly NextActionKind[]).includes(row.kind) && !served.includes(row.kind) && !(merging && row.kind === 'merge'))
    .map(({ row }) => ({ key: row.key, work: row.work, id: row.id, kind: row.kind, reason: row.reason, waitedMs: Math.max(0, now.getTime() - Date.parse(row.requestedAt)), since: row.requestedAt, start: startExecutorFor(row.kind) }))
    .sort((a, b) => b.waitedMs - a.waitedMs);
  return { live, liveMs, served, unserved, ...(merging ? { loop: merging } : {}) };
}

/** The same report with a live merging loop applied: its merge rows wait on the loop, never on an executor. */
export function withLoopMerger<R extends Pick<ExecutorReport, 'unserved'>>(report: R, loop: ReportedLoopMerger | null): R & { loop?: ReportedLoopMerger } {
  return loop?.live ? { ...report, unserved: report.unserved.filter(entry => entry.kind !== 'merge'), loop } : report;
}

/** One sentence per unserved kind, for master status and the dashboard: the kind, who waits and for how long, and what to start. */
export function describeUnserved(report: Pick<ExecutorReport, 'live' | 'unserved' | 'loop'>): { kind: NextActionKind; text: string; start: string; waitedMs: number; keys: string[] }[] {
  const kinds = new Map<NextActionKind, UnservedAction[]>();
  // A merging loop serves merge: no line may name it unserved or propose giving executors the kind.
  for (const entry of report.unserved) if (!(report.loop?.live && entry.kind === 'merge')) kinds.set(entry.kind, [...(kinds.get(entry.kind) ?? []), entry]);
  const wait = (ms: number) => ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h${Math.floor(ms % 3_600_000 / 60_000)}m` : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1000)}s`;
  return [...kinds.entries()].map(([kind, rows]) => {
    const [longest] = rows;
    const others = rows.length > 1 ? ` and ${rows.length - 1} more` : '';
    const fleet = report.live.length ? `the ${report.live.length} live executor${report.live.length === 1 ? '' : 's'} (${report.live.map(entry => entry.executor).join(', ')}) serve${report.live.length === 1 ? 's' : ''} none of it` : 'no executor is alive';
    return { kind, keys: rows.map(row => row.key), waitedMs: longest.waitedMs, start: longest.start,
      text: `Nothing can run ${kind}: ${longest.key} has waited ${wait(longest.waitedMs)}${others} for an executor that serves it, and ${fleet}. It is not queued behind other work — ${longest.start}` };
  }).sort((a, b) => b.waitedMs - a.waitedMs);
}
