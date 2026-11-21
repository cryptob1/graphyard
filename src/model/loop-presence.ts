import type { PaneServer } from './setup-checklist.js';

// The master loop as the control plane sees it (GY-916): which loop merges on this installation,
// who reviews and merges there (GY-1501), and the pane server holding its sessions (GY-1511).

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
export interface LoopPresence { principal: string; intervalSeconds: number; seenAt: string; supervision?: LoopSupervision; alerts?: number | false; checkoutTrust?: string; workerGrowth?: string; stepFailure?: string; fetchRefusal?: string; stallAlarm?: string; cpu?: LoopCpu; hosts?: LoopHost[]; sessions?: LoopSession[] }
/** The host's CPU as the loop last read it (GY-3348): 'some avg60' from /proc/pressure/cpu, the steal percent from /proc/stat and the hottest sensor (GY-3373), with GY-3416's launches-waiting word. */
export interface LoopCpu { avg60: number | null; steal: number | null; celsius?: number | null; testBudget?: number | null; trialCap?: { now: number; full: number } | null; waiting?: boolean | null }
/** One live agent session as the loop last read its cgroup (GY-3438): its use, its fair share, and since when it has used far more than its share of a saturated machine. */
export interface LoopSession { session: string; cpu: number | null; cpuShare: number; memory: number; memoryShare: number; overSince: string | null }
/** One host as the loop last read it (GY-3407): this machine (`local`) or an added one; `away` while it does not answer. */
export interface LoopHost { host: string; local?: boolean; at?: string; away: boolean; update?: boolean; reason?: string; cores: number | null; celsius: number | null; steal: number | null; runs: number | null }
/**
 * How long one read keeps the loop live: three of its cycles, never under two minutes —
 * the rule `daemonSummary` applies to the loop's own cursor. The dispatcher beside the cycle reads
 * every few seconds, so a long cycle does not lapse it.
 */
export const loopPresenceLiveMs = (intervalSeconds: number) => Math.max(3 * intervalSeconds * 1000, 120_000);

/** The loop as the control plane last saw it read, in memory beside the engine. */
export class LoopRegistry {
  private latest: LoopPresence | null = null;
  observe(poll: { principal: string; intervalSeconds: number; supervision?: LoopSupervision | null; alerts?: number | false | null; checkoutTrust?: string | null; workerGrowth?: string | null; stepFailure?: string | null; fetchRefusal?: string | null; stallAlarm?: string | null; cpu?: LoopCpu | null; hosts?: LoopHost[] | null; sessions?: LoopSession[] | null }, now: Date) {
    this.latest = { principal: poll.principal, intervalSeconds: poll.intervalSeconds, seenAt: now.toISOString(), ...(poll.supervision ? { supervision: poll.supervision } : {}), ...(poll.alerts === null || poll.alerts === undefined ? {} : { alerts: poll.alerts }), ...(poll.checkoutTrust ? { checkoutTrust: poll.checkoutTrust } : {}), ...(poll.workerGrowth ? { workerGrowth: poll.workerGrowth } : {}), ...(poll.stepFailure ? { stepFailure: poll.stepFailure } : {}), ...(poll.fetchRefusal ? { fetchRefusal: poll.fetchRefusal } : {}), ...(poll.stallAlarm ? { stallAlarm: poll.stallAlarm } : {}), ...(poll.cpu ? { cpu: poll.cpu } : {}), ...(poll.hosts?.length ? { hosts: poll.hosts } : {}), ...(poll.sessions?.length ? { sessions: poll.sessions } : {}) };
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
 * The header beside it (GY-3101) naming whether the loop alerts the operator directly when queued
 * work can neither start nor merge (`run.alertUrl` set): its stall window in minutes, or `off`. The
 * control plane keeps it beside the loop's presence for /api/status, so the dashboard says whether
 * alerts are on, after how long, or off.
 */
export const loopAlertsHeader = 'X-Graphyard-Loop-Alerts';
/** The loop's alert window in minutes, false when it names alerting off, or null when it names neither (an older loop). */
export function loopAlerts(header: string | string[] | undefined): number | false | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === 'off') return false;
  const minutes = Number(value);
  return value && Number.isInteger(minutes) && minutes > 0 ? minutes : null;
}

/**
 * The header on the loop's coordination reads naming the standing checkout-trust refusal (GY-3225):
 * the one attention line the loop raised — the checkout carries repository Claude configuration no
 * registered Claude account trusts — URI-encoded, or `off` while none stands. The control plane
 * keeps the latest beside the loop's presence for /api/status, so the Setup checklist shows it as
 * one item while it stands.
 */
export const loopCheckoutTrustHeader = 'X-Graphyard-Loop-Checkout-Trust';
export const encodeLoopCheckoutTrust = (text: string) => encodeURIComponent(text);
/** The standing checkout-trust refusal a loop read names, or null when it names none, `off`, or one that does not parse. */
export function loopCheckoutTrust(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value === 'off' || value.length > 4_000) return null;
  try {
    const text = decodeURIComponent(value);
    return text.trim() && !/[\r\n]/.test(text) ? text.slice(0, 2_000) : null;
  } catch { return null; }
}
/**
 * The header beside it naming the loop's standing worker-pool growth failure (GY-3299): the cause and
 * the capacity it leaves, URI-encoded, or `off` while growth works. /api/status serves it as
 * `setup.workerGrowth` and the dashboard's Needs you shows it until the loop grows the pool.
 */
export const loopWorkerGrowthHeader = 'X-Graphyard-Loop-Worker-Growth';
export const loopWorkerGrowth = loopCheckoutTrust;

/**
 * The header on the loop's coordination reads naming the standing repeated step failure
 * (GY-3293): a cycle step that failed the same way ten consecutive cycles, its line naming the
 * step and the error, URI-encoded, or `off` while none stands. The control plane keeps the latest
 * beside the loop's presence for /api/status, so the Setup checklist raises it as one Needs you
 * item while it stands — an alert that needs no master session.
 */
export const loopStepFailureHeader = 'X-Graphyard-Loop-Step-Failure';
export const encodeLoopStepFailure = encodeLoopCheckoutTrust;
/** The standing repeated step-failure line a loop read names, or null when it names none, `off`, or one that does not parse. */
export const loopStepFailure = loopCheckoutTrust;
/**
 * The header on the loop's coordination reads naming the standing fetch refusal (GY-3336): the
 * remote refuses the base branch's fetch and the loop backs off, URI-encoded, or `off` while none
 * stands. /api/status serves it as `setup.fetchRefusal` and the Setup checklist shows it as one
 * item while it stands, quoting the remote's refusal and the fix.
 */
export const loopFetchRefusalHeader = 'X-Graphyard-Loop-Fetch-Refusal';
export const loopFetchRefusal = loopCheckoutTrust;
/** GY-3432: the stall alarm the loop raised, URI-encoded, or `off`; /api/status serves it as `setup.stallAlarm` for the Master page. */
export const loopStallAlarmHeader = 'X-Graphyard-Loop-Stall-Alarm';
export const loopStallAlarm = loopCheckoutTrust;

/**
 * The header on the loop's coordination reads naming the host's CPU (GY-3348): 'some avg60' from
 * /proc/pressure/cpu and the steal percent from /proc/stat, URI-encoded JSON, or `off` where the
 * pressure file is missing (not Linux). The control plane keeps the latest beside the loop's
 * presence for /api/status, so the Workers page shows the two figures beside the sessions they
 * explain — a host at 94 percent pressure is why nothing new is launching.
 */
export const loopCpuHeader = 'X-Graphyard-Loop-Cpu';
export const encodeLoopCpu = (cpu: LoopCpu) => encodeURIComponent(JSON.stringify(cpu));
/** The host CPU a loop read names, or null when it names none, `off`, or one that does not parse. */
export function loopCpu(header: string | string[] | undefined): LoopCpu | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value.length > 500) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as { avg60?: unknown; steal?: unknown; celsius?: unknown; testBudget?: unknown; trialCap?: { now?: unknown; full?: unknown } | null; waiting?: unknown };
    const figure = (raw: unknown, max: number) => { const value = raw === null || raw === undefined ? NaN : Number(raw); return Number.isFinite(value) && value >= 0 ? Math.min(value, max) : null; };
    const avg60 = figure(parsed.avg60, 100), celsius = figure(parsed.celsius, 200);
    // GY-3401: the test budget a new session gets and the trial cap now and in full.
    const testBudget = figure(parsed.testBudget, 1024), now = figure(parsed.trialCap?.now, 1024), full = figure(parsed.trialCap?.full, 1024);
    return avg60 === null && celsius === null ? null
      : { avg60, steal: figure(parsed.steal, 100), celsius, testBudget, trialCap: now === null || full === null ? null : { now: Math.floor(now), full: Math.floor(full) }, waiting: parsed.waiting === true ? true : null };
  } catch { return null; }
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
 * from a `daemon-` merge instance — the instance only the durable loop mints (`daemonExecutor`),
 * inside the window. A range read on the `(kind, created_at)` index.
 */
export async function ledgerLoopMerger(query: (text: string, values: unknown[]) => Promise<{ rows: any[] }>, now: Date, liveMs = loopMergerLiveMs): Promise<ReportedLoopMerger | null> {
  const [latest] = (await query("SELECT payload->'details'->>'requestedBy' AS by, created_at FROM events WHERE kind='merge.enqueue.requested' AND created_at > $1 AND payload->'details'->>'requestedBy' LIKE '%#daemon-%' ORDER BY created_at DESC LIMIT 1",
    [new Date(now.getTime() - liveMs)])).rows;
  return latest ? { live: true, name: `the master loop (${String(latest.by).split('#')[0]}, last merge request ${new Date(latest.created_at).toISOString()})` } : null;
}

/**
 * The header on the loop's coordination reads naming the pane server that holds the install's agent
 * sessions (GY-1511), as the loop knows it — its own instance's config home and session (null for the
 * host's default), the host the loop runs on, and whether the loop last reached that server —
 * URI-encoded JSON. The control plane keeps the latest beside the loop's presence for /api/status.
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
    return { configHome: configHome && session ? configHome : null, session: configHome && session ? session : null, host: text(parsed?.host), running: typeof parsed?.running === 'boolean' ? parsed.running : null, master: text(parsed?.master) };
  } catch { return null; }
}
/** The pane server the loop last named, kept per engine like the loop's presence; a read naming none keeps the last. */
export class LoopPanesRegistry {
  latest: PaneServer | null = null;
  observe(panes: PaneServer | null) { if (panes) this.latest = panes; }
}
const loopPanesRegistries = new WeakMap<object, LoopPanesRegistry>();
export function loopPanesRegistry(owner: object): LoopPanesRegistry {
  let registry = loopPanesRegistries.get(owner);
  if (!registry) { registry = new LoopPanesRegistry(); loopPanesRegistries.set(owner, registry); }
  return registry;
}

/**
 * The header on the loop's coordination reads naming every host it reads (GY-3407): this machine
 * and each added one with cores, temperature, steal and runs now, or away (`update` when only its shim is too old, GY-3517), with when each was read, URI-encoded JSON, or
 * `off` before the first reading. /api/status serves the latest as `hosts` for the Workers page.
 */
export const loopHostsHeader = 'X-Graphyard-Loop-Hosts';
export const encodeLoopHosts = (hosts: LoopHost[]) => encodeURIComponent(JSON.stringify(hosts.map(({ host, local, at, away, update, reason, cores, celsius, steal, runs }) => ({ host, ...(local ? { local } : {}), ...(at ? { at } : {}), away, ...(away && update ? { update } : {}), ...(away && reason ? { reason: reason.slice(0, 300) } : {}), cores, celsius, steal, runs }))));
/** The hosts a loop read names, or null when it names none or they do not parse. */
export function loopHosts(header: string | string[] | undefined): LoopHost[] | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value === 'off' || value.length > 8000) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as unknown;
    if (!Array.isArray(parsed)) return null;
    const figure = (raw: unknown) => typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
    return parsed.filter(entry => typeof entry?.host === 'string').slice(0, 50)
      .map(entry => ({ host: String(entry.host).slice(0, 300), ...(entry.local === true ? { local: true } : {}), ...(typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at)) ? { at: entry.at.slice(0, 40) } : {}), away: entry.away === true, ...(entry.update === true ? { update: true } : {}), ...(typeof entry.reason === 'string' && entry.reason ? { reason: entry.reason.slice(0, 300) } : {}), cores: figure(entry.cores), celsius: figure(entry.celsius), steal: figure(entry.steal), runs: figure(entry.runs) }));
  } catch { return null; }
}

/**
 * GY-3438: the header naming every live agent session's use beside its fair share, as the loop last
 * read each scope's cgroup, URI-encoded JSON, or `off` with none. /api/status serves the latest as
 * `sessions` for the Workers page.
 */
export const loopSessionsHeader = 'X-Graphyard-Loop-Sessions';
export const encodeLoopSessions = (sessions: readonly { unit: string; name?: string; cpu: number | null; cpuShare: number; memory: number; memoryShare: number; overSince: string | null }[]) =>
  encodeURIComponent(JSON.stringify(sessions.slice(0, 30).map(({ unit, name, cpu, cpuShare, memory, memoryShare, overSince }) => ({ session: (name ?? unit).slice(0, 120), cpu: cpu === null ? null : Number(cpu.toFixed(2)), cpuShare: Number(cpuShare.toFixed(2)), memory, memoryShare, overSince }))));
/** The sessions a loop read names, or null when it names none or they do not parse. */
export function loopSessions(header: string | string[] | undefined): LoopSession[] | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value === 'off' || value.length > 8000) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as unknown;
    if (!Array.isArray(parsed)) return null;
    const figure = (raw: unknown) => typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
    return parsed.filter(entry => typeof entry?.session === 'string').slice(0, 50)
      .map(entry => ({ session: String(entry.session).slice(0, 120), cpu: figure(entry.cpu), cpuShare: figure(entry.cpuShare) ?? 0, memory: figure(entry.memory) ?? 0, memoryShare: figure(entry.memoryShare) ?? 0,
        overSince: typeof entry.overSince === 'string' && Number.isFinite(Date.parse(entry.overSince)) ? entry.overSince : null }));
  } catch { return null; }
}
