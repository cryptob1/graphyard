import { z } from 'zod';

// Provider capacity (GY-89/68/182): pre-launch quota checks, mid-session limit notices, fleet-wide
// holds, and per-role spent marks when every account is spent. Neither delays a different role.

/** Roles launched into session slots. */
export const capacityRoles = ['worker', 'reviewer', 'producer'] as const;
/** Headless registry roles that spend the same accounts (GY-1705); no item waits on them. */
export const headlessQuotaRoles = ['doctor', 'diagnostician'] as const;
/** Every role that can exhaust provider quota (GY-898, GY-1705). */
export const quotaRoles = [...capacityRoles, 'master', ...headlessQuotaRoles] as const;
export type CapacityRole = typeof quotaRoles[number];

/** What a session's own output says about its provider quota. */
export interface ExhaustionSignal {
  reason: string;
  /** Reset instant, or null when the notice names no time Graphyard can read. */
  resetsAt: string | null;
}

// Short-line provider banners only — not agent prose about limits.
const exhaustionNotices: readonly RegExp[] = [
  /\b(?:you(?:'|’)?ve|you have) (?:hit|reached) your (?:\w+[- ]){0,3}limit\b/i,
  /\b(?:usage|weekly|daily|monthly|hourly|5[- ]hour|session|spend(?:ing)?|rate|token|request|plan) limit (?:has been |was |is )?(?:reached|exceeded|hit|exhausted)\b/i,
  /\blimit reached\b.*\breset/i,
  /\bout of (?:extra )?(?:usage|credits|quota)\b/i,
  /\b(?:quota|credits?|balance) (?:has been |is |are )?(?:exceeded|exhausted|depleted|used up)\b/i,
  /\binsufficient (?:quota|credits?|balance)\b/i,
  /\bexceeded your (?:current )?(?:quota|usage|plan)\b/i,
];
export const exhaustionTailLines = 40, exhaustionNoticeMaxLength = 240;
/** Label words before a banner on its line (2 admits runtime labels, not agent sentences). */
export const exhaustionNoticeLabelWords = 2;

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const unitMs: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

/** Reset instant from a notice (ISO, unix, wait, or wall clock; zone in parentheses — GY-1566). */
export function parseResetTime(text: string, now: number): string | null {
  const iso = /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|UTC|[+-]\d{2}:?\d{2})?/i.exec(text);
  if (iso) {
    const zone = !iso[3] ? '' : /^(?:z|utc)$/i.test(iso[3]) ? 'Z' : iso[3];
    // A zone-less timestamp beside a named zone (`2026-10-10 22:00 (America/Los_Angeles)`) is that zone's wall clock.
    const named = zone ? null : namedZone(text);
    const wall = Date.parse(`${iso[1]}T${iso[2]}${named ? 'Z' : zone}`);
    const parsed = named ? wall - wallOffset(wall - wallOffset(wall, named), named) : wall;
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const unix = /(?:\||reset[s_ ]*(?:at)?[=: ]+)\s*(\d{10})\b/i.exec(text);
  if (unix) return new Date(Number(unix[1]) * 1000).toISOString();
  const wait = /\b(?:in|after)\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (wait) {
    let total = 0;
    for (const [, amount, unit] of wait[1].matchAll(/(\d+)\s*([dhms])/gi)) total += Number(amount) * unitMs[unit.toLowerCase()];
    if (total > 0) return new Date(now + total).toISOString();
  }
  const clause = /\b(?:resets?|renews?|available again|try again)(?:\s+(?:at|on|by))?[\s:]+(.{1,60})/i.exec(text)?.[1] ?? /\bon\s+((?:\d{1,2}\/\d{1,2}|[A-Za-z]{3,9}\.?\s+\d{1,2}).{0,20})/i.exec(text)?.[1];
  if (!clause) return null;
  const zone = namedZone(clause);
  // The wall clock of `zone` (or the host's) at `now`, and the instant a wall-clock time there names.
  const shift = (instant: number) => zone ? wallOffset(instant, zone) : 0;
  const today = new Date(now + shift(now));
  const at = (year: number, month: number, day: number, hours: number, minutes: number) => {
    if (!zone) return new Date(year, month, day, hours, minutes);
    const wall = Date.UTC(year, month, day, hours, minutes);
    return new Date(wall - shift(wall - shift(wall)));
  };
  const parts = zone ? { year: today.getUTCFullYear(), month: today.getUTCMonth(), date: today.getUTCDate() } : { year: today.getFullYear(), month: today.getMonth(), date: today.getDate() };
  const named = /\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b/.exec(clause), slashed = /\b(\d{1,2})\/(\d{1,2})\b/.exec(clause);
  const month = named && months.includes(named[1].toLowerCase()) ? months.indexOf(named[1].toLowerCase()) : slashed ? Number(slashed[1]) - 1 : null;
  const day = named && month !== null && !slashed ? Number(named[2]) : slashed ? Number(slashed[2]) : null;
  const clock = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(clause) ?? /\b(\d{1,2}):(\d{2})\b()/.exec(clause);
  let hours = 0, minutes = 0;
  if (clock) {
    hours = Number(clock[1]) % (clock[3] ? 12 : 24) + (clock[3]?.toLowerCase() === 'pm' ? 12 : 0);
    minutes = Number(clock[2] ?? 0);
  }
  if (month !== null && day !== null && month >= 0 && month < 12 && day >= 1 && day <= 31) {
    // A date already behind the notice is next year's: a limit never resets in the past.
    const candidate = at(parts.year, month, day, hours, minutes);
    return (candidate.getTime() <= now ? at(parts.year + 1, month, day, hours, minutes) : candidate).toISOString();
  }
  if (!clock) return null;
  const candidate = at(parts.year, parts.month, parts.date, hours, minutes);
  return (candidate.getTime() <= now ? at(parts.year, parts.month, parts.date + 1, hours, minutes) : candidate).toISOString();
}

/** The IANA zone a notice names in parentheses, such as `(America/Los_Angeles)`, when the runtime knows it. */
function namedZone(text: string): string | null {
  const zone = /\(\s*([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+|UTC)\s*\)/.exec(text)?.[1];
  if (!zone) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return zone; } catch { return null; }
}
/** How far `zone`'s wall clock runs ahead of UTC at `instant`, in milliseconds. */
function wallOffset(instant: number, zone: string): number {
  const fields = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(instant)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second) - Math.floor(instant / 1000) * 1000;
}

/** Runtime retry marker beside a limit notice (GY-973); agent prose never carries this. */
const retryMarker = /\[\s*retrying\b[^\]]*\]|\bretrying in \d+(?:\.\d+)?\s*(?:ms|s|m|h)?\b[^\n]*?\battempt\s*#?\d+/i;

function findExhaustion(output: string, now: number, retrying: boolean): ExhaustionSignal | null {
  // Right-aligned status text is padded out to the terminal width: a run of spaces is one gap.
  const lines = output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').split('\n').map(line => line.replace(/[│┃|]\s*$/, '').trim().replace(/\s{2,}/g, ' ')).filter(Boolean).slice(-exhaustionTailLines);
  for (let index = lines.length - 1; index >= 0; index--) {
    // The banner itself, with whatever the terminal drew in front of it removed.
    const line = lines[index].replace(/^[^A-Za-z0-9]+/, '');
    if (line.length > exhaustionNoticeMaxLength) continue;
    const at = exhaustionNotices.map(notice => notice.exec(line)?.index ?? -1).filter(offset => offset >= 0);
    if (!at.length || (line.slice(0, Math.min(...at)).match(/\S+/g) ?? []).length > exhaustionNoticeLabelWords) continue;
    const context = [line, ...lines.slice(index + 1, index + 3)].join(' ');
    if (retrying && !retryMarker.test(context)) continue;
    // The retry's own wait ("retrying in 4s") is not the provider's reset.
    return { reason: line.slice(0, 300), resetsAt: parseResetTime(context.replace(retryMarker, ' '), now) };
  }
  return null;
}

/** Tail of a stopped session: provider says the account is spent (lead-of-line, last lines only). */
export function detectExhaustion(output: string, now: number): ExhaustionSignal | null {
  return findExhaustion(output, now, false);
}
/** Working session stuck on a spent account: limit notice plus runtime retry marker (GY-1223). */
export function detectRetryingExhaustion(output: string, now: number): ExhaustionSignal | null {
  return findExhaustion(output, now, true);
}
/** Leading or status-named 429; not a 429 inside an id or echoed body (GY-1245). */
const providerStatus429 = /^(?:(?:\w+\s+)?error:?\s*)?429\b(?![\d.])|\b(?:http(?:\/[\d.]+)?|status(?:\s*code)?|code)["']?\s*[:=]?\s*["']?429\b(?![\d.])/i;
/** Provider quota/rate refusal in a headless error (GY-1092); never agent prose. */
export function providerLimit(error: string, now: number): ExhaustionSignal | null {
  const text = error.replace(/\s+/g, ' ').trim();
  if (!text || !(providerStatus429.test(text) || /\btoo many requests\b/i.test(text) || exhaustionNotices.some(notice => notice.test(text)))) return null;
  return { reason: text.slice(0, 300), resetsAt: parseResetTime(text, now) };
}

/** GY-1705 silent `done` pane (still untouched / no reader): assumed-reset hold. Idle is not this. */
export const silentPaneExhaustionReason =
  'session ended without working, without an outcome and without a readable provider limit notice; account treated as spent until an assumed reset';
export function silentPaneExhaustion(input: {
  listed: boolean; everWorking: boolean; hasOutcome: boolean; notice: ExhaustionSignal | null;
  pastStartBound: boolean; ended: boolean;
}): ExhaustionSignal | null {
  if (!input.listed || !input.ended || input.everWorking || input.hasOutcome || input.notice || !input.pastStartBound) return null;
  return { reason: silentPaneExhaustionReason, resetsAt: null };
}

/** Headless run event for limit detection (GY-1705); only string errors are limit text. */
export type LimitRunEvent = { kind: string; error?: string | boolean | null; text?: string };
export function runTimeoutLimit(events: readonly LimitRunEvent[], detail: string, now: number): ExhaustionSignal | null {
  const texts: string[] = [];
  for (const event of events) {
    if ((event.kind === 'retry' || event.kind === 'message') && typeof event.error === 'string') texts.push(event.error);
    if (event.kind === 'stderr' && event.text) texts.push(event.text);
  }
  if (detail) texts.push(detail);
  for (const text of texts) { const signal = providerLimit(text, now); if (signal) return signal; }
  return null;
}
/**
 * GY-1705: last reason + earliest reset for the round wait; hold every named account whose own
 * attempt printed a limit (a later null-account Pi fallback must not clear a registry primary).
 */
export function headlessTimeoutLimitCharge(
  attempts: readonly { result: string; detail: string; events?: readonly LimitRunEvent[] | readonly { kind: string; error?: string | null; text?: string }[]; account?: string | null }[],
  now: number,
): { limit: ExhaustionSignal; account: string | null; holds: { account: string; limit: ExhaustionSignal }[] } | null {
  const started = attempts.filter(a => a.result !== 'spawn' && a.result !== 'cancelled');
  if (!started.length || !started.every(a => a.result === 'timeout')) return null;
  const holds: { account: string; limit: ExhaustionSignal }[] = [], signals: ExhaustionSignal[] = [];
  for (const a of started) {
    const signal = runTimeoutLimit(a.events ?? [], a.detail, now);
    if (!signal) continue;
    signals.push(signal);
    if (a.account) holds.push({ account: a.account, limit: signal });
  }
  if (!signals.length) return null;
  return {
    limit: { reason: signals.at(-1)!.reason, resetsAt: signals.map(e => e.resetsAt).filter((at): at is string => !!at).sort()[0] ?? null },
    account: holds.at(-1)?.account ?? null, holds,
  };
}
/** All-timeout round with any readable limit (delegates to the charge helper). */
export function headlessTimeoutLimit(
  attempts: readonly { result: string; detail: string; events?: readonly LimitRunEvent[] | readonly { kind: string; error?: string | null; text?: string }[] }[],
  now: number,
): ExhaustionSignal | null {
  return headlessTimeoutLimitCharge(attempts, now)?.limit ?? null;
}

/** How an interrupted attempt's uncommitted work was kept, or that there was none to keep. */
export const partialWorkStates = ['committed', 'discarded', 'clean', 'not-applicable'] as const;
export const partialWorkSchema = z.object({
  state: z.enum(partialWorkStates),
  /** The commit that holds the work, on the attempt's own branch, when it was committed. */
  commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  branch: z.string().min(1).max(200).optional(),
  path: z.string().min(1).max(1000).optional(),
  detail: z.string().max(500).optional(),
}).strict();
export type PartialWork = z.infer<typeof partialWorkSchema>;
/** The marker an attempt ended by its own blocker carries in its capacity record (GY-1008). */
export const blockedAttemptMarker = 'blocked on epoch ';

const instant = z.iso.datetime();
/** Early end: `quota` (default) or `interrupted` (killed/gone without submit; GY-105). */
export const attemptEndCauses = ['quota', 'interrupted'] as const;
export const exhaustionReportSchema = z.object({
  event: z.literal('exhausted'),
  cause: z.enum(attemptEndCauses).optional(),
  role: z.enum(quotaRoles),
  /** The worker attempt the exhausted session held; no other role's session holds one. */
  epoch: z.number().int().positive().optional(),
  /**
   * What the session answered: a reviewer's or producer's dispatch request.
   */
  requestId: z.string().min(1).max(64).optional(),
  profile: z.string().min(1).max(80),
  /** The agent account (environment) the session ran on; null when the profile names none. */
  account: z.string().min(1).max(80).nullable(),
  runtime: z.string().min(1).max(40).nullable(),
  reason: z.string().trim().min(1).max(500),
  resetsAt: instant.nullable(),
  partialWork: partialWorkSchema,
  /**
   * GY-867: the loop ended this worker attempt because it blocked again after its blocker was
   * cleared. The blocker that attempt recorded ends with it, so the item is dispatched again.
   */
  endsBlocker: z.literal(true).optional(),
}).strict().refine(report => report.role !== 'worker' || report.epoch !== undefined, 'A worker exhaustion names the attempt epoch it ends')
  .refine(report => !report.endsBlocker || (report.role === 'worker' && report.cause === 'interrupted'), 'Only an interrupted worker attempt ends the blocker it recorded');
export type ExhaustionReport = z.infer<typeof exhaustionReportSchema>;

export const capacityAccountSchema = z.object({
  account: z.string().min(1).max(80), profile: z.string().min(1).max(80),
  resetsAt: instant.nullable(), reason: z.string().min(1).max(500),
}).strict();
export type CapacityAccount = z.infer<typeof capacityAccountSchema>;
export const capacitySpentSchema = z.object({
  event: z.literal('spent'), role: z.enum(quotaRoles),
  accounts: z.array(capacityAccountSchema).min(1).max(40),
}).strict();
export const capacityRestoredSchema = z.object({ event: z.literal('restored'), role: z.enum(quotaRoles), reason: z.string().trim().min(1).max(500) }).strict();
export const capacityEventSchema = z.union([exhaustionReportSchema, capacitySpentSchema, capacityRestoredSchema]);

export interface ExhaustionRecord extends Omit<ExhaustionReport, 'event'> { at: string; owner: string | null; recordedBy: string }
export interface SpentCapacity { role: CapacityRole; at: string; accounts: CapacityAccount[]; /** The first reset among them: when the role is tried again. Null when none is known. */ retryAt: string | null }
export interface CapacityState {
  /** Sessions of this item that ran out of provider quota mid-work, most recent last. */
  exhaustions: ExhaustionRecord[];
  /** Standing per role: every configured account is spent, and the role is not launched. */
  spent: SpentCapacity[];
}
export const retainedExhaustions = 20;

/** The earliest known reset among the accounts: the moment the role is worth launching again. */
export function capacityRetryAt(accounts: readonly Pick<CapacityAccount, 'resetsAt'>[]): string | null {
  const known = accounts.map(entry => entry.resetsAt ? Date.parse(entry.resetsAt) : Number.NaN).filter(Number.isFinite);
  return known.length ? new Date(Math.min(...known)).toISOString() : null;
}
/** One identity per capacity episode: the role and exactly which accounts are spent until when. */
export const capacitySignature = (role: CapacityRole, accounts: readonly CapacityAccount[]) =>
  `${role}:${[...accounts].map(entry => `${entry.profile}/${entry.account}@${entry.resetsAt ?? 'unknown'}`).sort().join(',')}`;
/** The one line `master status` and the dashboard say about a spent role. */
export function describeCapacity(role: CapacityRole, accounts: readonly CapacityAccount[]) {
  const retryAt = capacityRetryAt(accounts);
  return `${role} capacity is exhausted on every configured account (${accounts.map(entry => `${entry.account} resets ${entry.resetsAt ?? 'at an unknown time'}`).join(', ')}); `
    + `${role} launches are paused${retryAt ? ` until ${retryAt}` : ' until an account reports quota again'}, and nothing else is delayed`;
}
export function standingCapacity(work: { capacity?: CapacityState | null }, role?: CapacityRole): SpentCapacity[] {
  return (work.capacity?.spent ?? []).filter(entry => !role || entry.role === role);
}

type AttemptWork = { capacity?: CapacityState | null; pipeline?: { attempts?: readonly { epoch: number; end: string | null }[] } | null };
/** GY-1708: one epoch's exhaustion/attempt counts after mid-attempt limit (double-count shows as two rows). */
export function workerAttemptLedger(work: AttemptWork, epoch: number) {
  const exhaustions = (work.capacity?.exhaustions ?? []).filter(e => e.role === 'worker' && e.epoch === epoch);
  const attempts = (work.pipeline?.attempts ?? []).filter(e => e.epoch === epoch);
  return {
    exhaustions: exhaustions.length, attempts: attempts.length,
    released: attempts.filter(e => e.end === 'released').length,
    open: attempts.filter(e => e.end === null).length,
    preservedCommit: exhaustions.find(e => e.partialWork.state === 'committed')?.partialWork.commit ?? null,
  };
}
/** GY-1708: spent epoch ended once with partial work kept for the redispatch's next epoch. */
export function redispatchPreservesAttempt(work: AttemptWork, spentEpoch: number): { ok: boolean; detail: string } {
  const ledger = workerAttemptLedger(work, spentEpoch);
  if (ledger.exhaustions !== 1) return { ok: false, detail: `expected one exhaustion for epoch ${spentEpoch}, found ${ledger.exhaustions}` };
  if (ledger.attempts !== 1) return { ok: false, detail: `expected one attempt row for epoch ${spentEpoch}, found ${ledger.attempts}` };
  if (ledger.released !== 1 || ledger.open !== 0) return { ok: false, detail: `epoch ${spentEpoch} must be released once, not left open or double-ended` };
  const exhaustion = (work.capacity?.exhaustions ?? []).find(e => e.role === 'worker' && e.epoch === spentEpoch)!;
  if (exhaustion.partialWork.state === 'committed' && !exhaustion.partialWork.commit) return { ok: false, detail: 'committed partial work must name its commit' };
  return {
    ok: true,
    detail: exhaustion.partialWork.state === 'committed'
      ? `epoch ${spentEpoch} ended once; work kept at ${exhaustion.partialWork.commit}`
      : `epoch ${spentEpoch} ended once; partial work ${exhaustion.partialWork.state}`,
  };
}
/** GY-1708: held account is not selectable for the same role until reset (null reset = still held). */
export function accountHeldForRole(held: Record<string, { until?: string; resetsAt?: string | null }>, account: string, now: number): boolean {
  const entry = held[account];
  if (!entry) return false;
  const until = entry.until ?? entry.resetsAt;
  return !until || Date.parse(until) > now;
}
