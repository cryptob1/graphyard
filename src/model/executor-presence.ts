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
 *
 * Presence is heard from every executor that is alive, not only one asking for a row (GY-1288). A
 * live executor goes minutes without a claim poll inside a long handler, where it renews its claim
 * instead, and behind a fleet restart's fence (`restartExecutors`), where it sends a presence-only
 * poll (`POST /api/actions/presence`); both refresh it. Without them the loop's own self-upgrade
 * restart read as a dead fleet and filed GY-1287, GY-1286 and GY-1238 as configuration faults at
 * one instant. An executor that stands down on a moved checkout sends nothing: it claims nothing more.
 *
 * Presence also outlives the process that heard it (GY-1289). Every poll and renewal upserts its
 * executor's row in `executor_presence` — never an event row, so an idle poll still appends nothing
 * to the ledger (GY-185) — and the report reads those rows beside the in-memory registry, so a
 * control plane replaced between two polls (a deploy, a restart, another replica) reads the fleet
 * that was polling a moment before it started (GY-1288: a deploy's switchover reported a live fleet
 * dead 34s after its last durable claim). An empty fleet is judged only on evidence — a poll this
 * process heard, or durable presence older than one window — never on the process's age. An empty
 * table is no evidence (a deploy creates it empty, a restore leaves it so): it carries a marker of
 * when recording began, and proves a silent fleet only once that marker is a window old.
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
export interface LoopPresence { principal: string; intervalSeconds: number; seenAt: string; herdr?: LoopHerdr | null }
/**
 * The second header on those reads (GY-1511): the Herdr server holding the install's agents, as the
 * loop knows it — its own instance's config home and session (null for the host's default), the
 * host the loop runs on, and whether the loop last reached that server — URI-encoded JSON.
 */
export const loopHerdrHeader = 'X-Graphyard-Loop-Herdr';
export interface LoopHerdr { configHome: string | null; session: string | null; host: string | null; running: boolean | null }
export const encodeLoopHerdr = (herdr: LoopHerdr) => encodeURIComponent(JSON.stringify(herdr));
/** The Herdr server a loop read names, or null when it names none or one that does not parse. */
export function loopHerdr(header: string | string[] | undefined): LoopHerdr | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value.length > 2_000) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    const text = (field: unknown) => typeof field === 'string' && field.trim() && field.length <= 500 ? field.trim() : null;
    const configHome = text(parsed?.configHome), session = text(parsed?.session);
    return { configHome: configHome && session ? configHome : null, session: configHome && session ? session : null, host: text(parsed?.host), running: typeof parsed?.running === 'boolean' ? parsed.running : null };
  } catch { return null; }
}
/**
 * How long one read keeps the loop live: three of its cycles, never under an executor's window —
 * the rule `daemonSummary` applies to the loop's own cursor. The dispatcher beside the cycle reads
 * every few seconds, so a long cycle does not lapse it.
 */
export const loopPresenceLiveMs = (intervalSeconds: number) => Math.max(3 * intervalSeconds * 1000, executorLiveMs);

/** The loop as the control plane last saw it read, in memory beside the engine like executor presence. */
export class LoopRegistry {
  private latest: LoopPresence | null = null;
  observe(poll: { principal: string; intervalSeconds: number; herdr?: LoopHerdr | null }, now: Date) {
    this.latest = { principal: poll.principal, intervalSeconds: poll.intervalSeconds, seenAt: now.toISOString(), herdr: poll.herdr ?? this.latest?.herdr ?? null };
  }
  /** Whether this process has ever seen the loop read: once it has, a lapse means the loop stopped. */
  get observed(): boolean { return this.latest !== null; }
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

/**
 * The installation's loop as the control plane knows it: seen reading, else — only while this process
 * has never seen it read — its ledger's merge requests. A loop seen reading whose reads have lapsed has
 * stopped, and a recent merge request it left behind does not make it live.
 */
export async function reportedLoopMerger(registry: LoopRegistry, query: (text: string, values: unknown[]) => Promise<{ rows: any[] }>, now: Date): Promise<ReportedLoopMerger | null> {
  const seen = registry.live(now);
  if (seen) return { live: true, name: `the master loop (${seen.principal}, cycling every ${seen.intervalSeconds}s, last read ${seen.seenAt})` };
  if (registry.observed) return null;
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
  /** When this process first heard any executor: evidence that an empty registry means a silent fleet. */
  heardAt: string | null = null;
  /**
   * When this registry began listening (GY-1086): the fallback, for a reader with no durable presence
   * (`executorReport` without a reading), whose empty registry is unheard, not down, for one window.
   * The control plane's own reads pass the durable reading and judge on evidence instead (GY-1289).
   */
  constructor(readonly since: Date = new Date()) {}
  /** One claim poll: the executor, where it runs, what it can run, and that it asked now. */
  observe(poll: { executor: string; host: string; principal: string; kinds: NextActionKind[] }, now: Date, claimed = false) {
    const key = `${poll.principal}\0${poll.executor}`;
    this.heardAt ??= now.toISOString();
    const previous = this.seen.get(key);
    this.seen.set(key, { executor: poll.executor, host: poll.host, principal: poll.principal, kinds: [...poll.kinds], seenAt: now.toISOString(), claims: (previous?.claims ?? 0) + (claimed ? 1 : 0) });
    if (this.seen.size > retainedExecutors) for (const [stale, entry] of this.seen) { if (this.seen.size <= retainedExecutors) break; if (now.getTime() - Date.parse(entry.seenAt) > executorLiveMs) this.seen.delete(stale); }
  }
  /**
   * A renewal of a claim it holds (GY-1288): the executor is alive inside a handler and polls
   * nothing until the handler ends, which a dispatch waiting on a runtime can take minutes to do.
   * A known executor keeps the kinds it last polled with; one this process has not heard poll (a
   * restarted control plane) is known by the kind it is demonstrably running.
   */
  renewed(renewal: { executor: string; host: string; principal: string; kind: NextActionKind }, now: Date) {
    const previous = this.seen.get(`${renewal.principal}\0${renewal.executor}`);
    this.observe({ executor: renewal.executor, host: previous?.host ?? renewal.host, principal: renewal.principal, kinds: previous?.kinds ?? [renewal.kind] }, now);
    return this.seen.get(`${renewal.principal}\0${renewal.executor}`)!;
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

type Query = (text: string, values: unknown[]) => Promise<{ rows: any[] }>;
/** The engine's store query, when the engine has one (a route test may drive the routes over a stub). */
export const presenceQuery = (engine: { store?: { pool?: { query: Query } } }): Query | null => {
  const pool = engine.store?.pool;
  return pool ? (text, values) => pool.query(text, values) : null;
};
/** Rows older than this are pruned by the next write: an executor silent for a week is not a fleet member worth naming. */
export const durablePresenceRetainedMs = 7 * 24 * 3_600_000;
/**
 * The marker row's key (principal and executor both empty; a principal never is): when
 * `executor_presence` began recording. Written by the first read of a table without one and never
 * pruned, so the window an empty table must outlast starts when recording did, not when a process did.
 */
const isMarker = `principal = '' AND executor = ''`;
/** What the durable store holds: every executor's last poll or renewal, and when recording began. */
export interface DurablePresence { executors: ExecutorPresence[]; since: string }

/**
 * Record one poll or renewal durably (GY-1289): one upsert of the executor's row, never an event
 * row or a receipt, so an idle poll leaves the ledger exactly as it found it (GY-185). A renewal
 * (`renewal`) refreshes the time only, keeping the kinds and host its executor last polled with,
 * which another process may have heard. A failed write is logged, never the poll's failure: the
 * in-memory registry still heard it, and the next poll writes again.
 */
export async function recordPresence(query: Query | null, presence: { executor: string; host: string; principal: string; kinds: NextActionKind[] }, now: Date, options: { claimed?: boolean; renewal?: boolean } = {}): Promise<void> {
  if (!query) return;
  try {
    await query(`WITH pruned AS (DELETE FROM executor_presence WHERE seen_at < $7 AND NOT (${isMarker}) AND NOT (principal = $1 AND executor = $2))
INSERT INTO executor_presence(principal, executor, host, kinds, seen_at, claims) VALUES($1, $2, $3, $4::jsonb, $5, $6)
ON CONFLICT(principal, executor) DO UPDATE SET seen_at=GREATEST(executor_presence.seen_at, EXCLUDED.seen_at), claims=executor_presence.claims + EXCLUDED.claims,
  host=CASE WHEN $8 THEN executor_presence.host ELSE EXCLUDED.host END, kinds=CASE WHEN $8 THEN executor_presence.kinds ELSE EXCLUDED.kinds END`,
    [presence.principal, presence.executor, presence.host, JSON.stringify(presence.kinds), now, options.claimed ? 1 : 0, new Date(now.getTime() - durablePresenceRetainedMs), !!options.renewal]);
  } catch (error) { console.error(`[graphyard] executor presence for ${presence.executor} was not recorded durably: ${error instanceof Error ? error.message : String(error)}`); }
}

/**
 * The durable presence every process has recorded, most recently seen first, and when recording
 * began; null when it cannot be read — a reading that failed is no evidence either way, so the
 * report then judges nothing an empty fleet would have to explain. A table without its marker
 * (created by this deploy, or emptied by a restore) gets one at this read: recording begins now.
 */
export async function durablePresence(query: Query | null, now = new Date()): Promise<DurablePresence | null> {
  if (!query) return null;
  try {
    const { rows } = await query(`SELECT principal, executor, host, kinds, seen_at, claims, (${isMarker}) AS marker FROM executor_presence ORDER BY (${isMarker}) DESC, seen_at DESC LIMIT $1`, [retainedExecutors + 1]);
    const since = rows[0]?.marker ? rows[0].seen_at : (await query(`INSERT INTO executor_presence(principal, executor, host, kinds, seen_at) VALUES('', '', '', '[]'::jsonb, $1)
ON CONFLICT(principal, executor) DO UPDATE SET seen_at=executor_presence.seen_at RETURNING seen_at`, [now])).rows[0].seen_at;
    const executors = rows.filter(row => !row.marker).map(row => ({ executor: row.executor, host: row.host, principal: row.principal, kinds: row.kinds, seenAt: new Date(row.seen_at).toISOString(), claims: row.claims }));
    return { executors, since: new Date(since).toISOString() };
  } catch { return null; }
}

/**
 * The in-memory registry and the durable rows together: each executor once, as it was most recently
 * seen, serving every kind either view heard it name inside the window — a restarted process that
 * has heard only a renewal knows the one kind being run, while the durable row keeps the poll's.
 */
function mergedLive(registry: ExecutorRegistry, durable: DurablePresence | null | undefined, now: Date, liveMs: number): ExecutorPresence[] {
  const merged = new Map<string, ExecutorPresence>();
  for (const entry of [...registry.live(now, liveMs), ...(durable?.executors ?? []).filter(entry => now.getTime() - Date.parse(entry.seenAt) <= liveMs)]) {
    const key = `${entry.principal}\0${entry.executor}`, previous = merged.get(key);
    if (!previous) { merged.set(key, entry); continue; }
    const newer = Date.parse(entry.seenAt) > Date.parse(previous.seenAt) ? entry : previous;
    merged.set(key, { ...newer, kinds: [...new Set([...newer.kinds, ...entry.kinds, ...previous.kinds])], claims: Math.max(entry.claims, previous.claims) });
  }
  return [...merged.values()].sort((a, b) => Date.parse(b.seenAt) - Date.parse(a.seenAt) || a.executor.localeCompare(b.executor));
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
  /** Nothing is live and nothing yet says the fleet is silent: nothing is judged unserved until something does. */
  listening?: boolean;
}

/** The command that serves a kind: the supervised slot on a coordinator host, or the bare executor. */
export const startExecutorFor = (kind: NextActionKind) => `start an executor that serves ${kind}: systemctl --user start graphyard-executor@1 on a coordinator host that declared executors (node scripts/graphyard-executor.mjs --install --count 1 declares one), or node scripts/graphyard-executor.mjs --kinds ${kind}`;

/**
 * The pending rows nobody alive can run, judged against the executors seen inside the window. A
 * row a live executor of its kind could take is waiting its turn and is not listed, however long
 * it has waited: that is the queue's own idle report (`idleActionable`), which names a different
 * failure. A row whose kind no executor may ever run is not listed either — no fleet serves it by
 * design. Only an executor-runnable kind with no live executor at all is unserved.
 *
 * Live is the in-memory registry and the durable reading (`durablePresence`) together, so a fleet
 * polling before this process started is live on its first read (GY-1289). An empty fleet is judged
 * only on evidence that it is silent: a poll this process heard and saw lapse, or durable presence
 * older than one window (lapsed executor rows, or an empty table whose marker is a window old).
 * Without either it judges nothing, however long the process has been up. A caller with no durable
 * store (`durable` omitted) keeps the in-memory rule: one window of listening from registry birth.
 */
export function executorReport(all: Work[], registry: ExecutorRegistry, now: Date, liveMs = executorLiveMs, loop: ReportedLoopMerger | null = null, durable?: DurablePresence | null): ExecutorReport {
  const live = mergedLive(registry, durable, now, liveMs);
  const served = [...new Set(live.flatMap(entry => entry.kinds))].sort() as NextActionKind[];
  const age = now.getTime() - registry.since.getTime();
  const durableSilence = !!durable && (durable.executors.length > 0 || now.getTime() - Date.parse(durable.since) >= liveMs);
  const silenceUnproven = durable === undefined ? age >= 0 && age < liveMs : registry.heardAt === null && !durableSilence;
  const merging = loop?.live ? loop : null;
  if (!live.length && silenceUnproven) return { live, liveMs, served, unserved: [], listening: true, ...(merging ? { loop: merging } : {}) };
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
