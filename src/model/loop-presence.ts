import { executorLiveMs } from './executor-presence.js';
import type { PaneServer } from './setup-checklist.js';

// The master loop as the control plane sees it (GY-916): which loop merges on this installation, and
// who reviews and merges there (GY-1501). Split from `executor-presence.ts`, which re-exports it.

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
/**
 * The header beside it naming who reviews and merges on this installation (GY-1501): the loop's
 * master.json `supervision`, so the dashboard's Setup checklist judges a supervised install as
 * `graphyard up` does. A read without it (an older loop) names none.
 */
export const loopSupervisionHeader = 'X-Graphyard-Loop-Supervision';
export type LoopSupervision = 'supervised' | 'autonomous';
export interface LoopPresence { principal: string; intervalSeconds: number; seenAt: string; supervision?: LoopSupervision; panes?: PaneServer | null }
/**
 * The third header (GY-1511): the pane server holding the install's agent sessions, as the loop knows
 * it — its own instance's config home and session (null for the host's default), the host the loop
 * runs on, and whether the loop last reached that server — URI-encoded JSON.
 */
export const loopPanesHeader = 'X-Graphyard-Loop-Panes';
export const encodeLoopPanes = (panes: PaneServer) => encodeURIComponent(JSON.stringify(panes));
/** The pane server a loop read names, or null when it names none or one that does not parse. */
export function loopPanes(header: string | string[] | undefined): PaneServer | null {
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
  observe(poll: { principal: string; intervalSeconds: number; supervision?: LoopSupervision | null; panes?: PaneServer | null }, now: Date) {
    const panes = poll.panes ?? this.latest?.panes ?? null;
    this.latest = { principal: poll.principal, intervalSeconds: poll.intervalSeconds, seenAt: now.toISOString(), ...(poll.supervision ? { supervision: poll.supervision } : {}), ...(panes ? { panes } : {}) };
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

/** The supervision a coordination read names, or null when it names none or another value. */
export function loopSupervision(header: string | string[] | undefined): LoopSupervision | null {
  const value = Array.isArray(header) ? header[0] : header;
  return value === 'supervised' || value === 'autonomous' ? value : null;
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
