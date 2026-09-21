import { z } from 'zod';

// ---------------------------------------------------------------------------
// Provider capacity as the control plane records it (GY-89).
//
// GY-68 checks an account's quota before a launch. A session that exhausts its account while it
// works simply stops: the runtime prints its provider's limit notice and waits for a person. The
// master loop reads that notice from the session's own output, ends the attempt on the record
// with the account and the reset time, and launches the same action on another account or
// runtime. When no account of a role is left, that is one capacity escalation on the item —
// naming each account and when it resets — and the role is not launched again until the first
// of them does. Neither case is a launch failure, and neither delays an item that needs a
// different role.
// ---------------------------------------------------------------------------

export const capacityRoles = ['worker', 'reviewer', 'producer'] as const;
export type CapacityRole = typeof capacityRoles[number];

/** What a session's own output says about its provider quota. */
export interface ExhaustionSignal {
  /** The provider's notice, as the session printed it. */
  reason: string;
  /** When the provider says the quota returns; null when the notice names no time Graphyard can read. */
  resetsAt: string | null;
}

// The notices the supported runtimes print when an account has nothing left. They are matched
// against single short lines of a session that has stopped working: a worker that discusses a
// usage limit in its own prose is working, and a long paragraph is never a provider banner.
const exhaustionNotices: readonly RegExp[] = [
  /\b(?:you(?:'|’)?ve|you have) (?:hit|reached) your (?:\w+[- ]){0,3}limit\b/i,
  /\b(?:usage|weekly|daily|monthly|hourly|5[- ]hour|session|spend(?:ing)?|rate|token|request|plan) limit (?:has been |was |is )?(?:reached|exceeded|hit)\b/i,
  /\blimit reached\b.*\breset/i,
  /\bout of (?:extra )?(?:usage|credits|quota)\b/i,
  /\b(?:quota|credits?|balance) (?:has been |is |are )?(?:exceeded|exhausted|depleted|used up)\b/i,
  /\binsufficient (?:quota|credits?|balance)\b/i,
  /\bexceeded your (?:current )?(?:quota|usage|plan)\b/i,
];
export const exhaustionTailLines = 40, exhaustionNoticeMaxLength = 240;

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const unitMs: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

/**
 * The reset time a limit notice names, as an instant. Providers say it four ways: an absolute
 * timestamp, a Unix time after a separator, a wait ("try again in 3 days 4 hours"), or a wall
 * clock the account's own host reads ("resets 3pm", "resets Sep 26, 9am", "on 10/8"). A wall
 * clock is read in the host's zone, and a time of day already past means tomorrow's. Anything
 * else is unknown, and an unknown reset is recorded as unknown rather than guessed.
 */
export function parseResetTime(text: string, now: number): string | null {
  const iso = /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|UTC|[+-]\d{2}:?\d{2})?/i.exec(text);
  if (iso) {
    const zone = !iso[3] ? '' : /^(?:z|utc)$/i.test(iso[3]) ? 'Z' : iso[3];
    const parsed = Date.parse(`${iso[1]}T${iso[2]}${zone}`);
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
  const today = new Date(now);
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
    const candidate = new Date(today.getFullYear(), month, day, hours, minutes);
    // A date already behind the notice is next year's: a limit never resets in the past.
    if (candidate.getTime() <= now) candidate.setFullYear(candidate.getFullYear() + 1);
    return candidate.toISOString();
  }
  if (!clock) return null;
  const candidate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hours, minutes);
  if (candidate.getTime() <= now) candidate.setDate(candidate.getDate() + 1);
  return candidate.toISOString();
}

/**
 * Whether the tail of a stopped session's output is its provider saying the account is spent.
 * Only the last lines are read — a notice the session has long since worked past is history —
 * and the reset time is looked for on the notice and the two lines after it, where the runtimes
 * that split the sentence put it.
 */
export function detectExhaustion(output: string, now: number): ExhaustionSignal | null {
  const lines = output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').split('\n').map(line => line.replace(/[│┃|]\s*$/, '').trim()).filter(Boolean).slice(-exhaustionTailLines);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line.length > exhaustionNoticeMaxLength || !exhaustionNotices.some(notice => notice.test(line))) continue;
    const context = lines.slice(index, index + 3).join(' ');
    return { reason: line.replace(/^[^A-Za-z0-9]+/, '').slice(0, 300), resetsAt: parseResetTime(context, now) };
  }
  return null;
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

const instant = z.iso.datetime();
export const exhaustionReportSchema = z.object({
  event: z.literal('exhausted'),
  role: z.enum(capacityRoles),
  /** The worker attempt the exhausted session held; a reviewer or producer session holds none. */
  epoch: z.number().int().positive().optional(),
  /** The dispatch request a reviewer or producer session answered. */
  requestId: z.string().min(1).max(64).optional(),
  profile: z.string().min(1).max(80),
  /** The agent account (environment) the session ran on; null when the profile names none. */
  account: z.string().min(1).max(80).nullable(),
  runtime: z.string().min(1).max(40).nullable(),
  reason: z.string().trim().min(1).max(500),
  resetsAt: instant.nullable(),
  partialWork: partialWorkSchema,
}).strict().refine(report => report.role !== 'worker' || report.epoch !== undefined, 'A worker exhaustion names the attempt epoch it ends');
export type ExhaustionReport = z.infer<typeof exhaustionReportSchema>;

export const capacityAccountSchema = z.object({
  account: z.string().min(1).max(80), profile: z.string().min(1).max(80),
  resetsAt: instant.nullable(), reason: z.string().min(1).max(500),
}).strict();
export type CapacityAccount = z.infer<typeof capacityAccountSchema>;
export const capacityEscalationSchema = z.object({
  event: z.literal('escalated'), role: z.enum(capacityRoles),
  accounts: z.array(capacityAccountSchema).min(1).max(40),
}).strict();
export const capacityRestoredSchema = z.object({ event: z.literal('restored'), role: z.enum(capacityRoles), reason: z.string().trim().min(1).max(500) }).strict();
export const capacityEventSchema = z.union([exhaustionReportSchema, capacityEscalationSchema, capacityRestoredSchema]);

export interface ExhaustionRecord extends Omit<ExhaustionReport, 'event'> { at: string; owner: string | null; recordedBy: string }
export interface CapacityEscalation { role: CapacityRole; at: string; accounts: CapacityAccount[]; /** The first reset among them: when the role is tried again. Null when none is known. */ retryAt: string | null }
export interface CapacityState {
  /** Sessions of this item that ran out of provider quota mid-work, most recent last. */
  exhaustions: ExhaustionRecord[];
  /** Standing per role: every configured account is spent, and the role is not launched. */
  escalations: CapacityEscalation[];
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
export function standingCapacity(work: { capacity?: CapacityState | null }, role?: CapacityRole): CapacityEscalation[] {
  return (work.capacity?.escalations ?? []).filter(entry => !role || entry.role === role);
}
