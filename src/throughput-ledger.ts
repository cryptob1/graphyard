import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { throughputClaim, type ThroughputReport } from './throughput.js';

/**
 * The ledger of GY-87's throughput verification (GY-1437): every attempt to measure the claim
 * against the release serving, recorded or failed, in one file beside the measurement records.
 *
 * A measurement record says what one read found; it cannot say how long the claim has stood
 * unverified or why it cannot verify. The ledger does: each entry keeps the per-delivery list,
 * the timestamps and the command's own output, and the pursuit clock (`openedAt`) runs from the
 * first attempt that left the claim unverified until one verifies it. While the clock is inside
 * its bound the loop is carrying the work (the population accumulates as session-free deliveries
 * land); past it the claim escalates to the operator naming the exact blocker, instead of aging.
 *
 * The file is not a measurement record (its name never matches the recorder's), so retention and
 * `readThroughputMeasurement` never touch it.
 */
export const throughputLedgerFile = 'ledger.json';

/** How long session-free deliveries may take to accumulate before the operator is escalated. */
export const throughputEscalationMs = 48 * 60 * 60_000;

/** How many attempts the ledger keeps; the pursuit clock survives their retirement. */
export const throughputLedgerRetention = 60;

/** Why an attempt left the claim unverified: the exact blocker an escalation names. */
export type ThroughputBlocker = 'missing-credentials' | 'unreachable-url' | 'no-session-free-deliveries' | 'release-unconfirmed' | 'claim-missed' | 'measurement-failed';

export interface ThroughputLedgerDelivery { key: string; pr: number | null; mergedAt: string; admitted: boolean; submitToMergeMs: number | null; exclusions: string[] }

export interface ThroughputLedgerEntry {
  at: string;
  /** `loop`: the loop's post-deploy measurement; `script`: scripts/measure-throughput.mjs --record. */
  source: 'loop' | 'script';
  outcome: 'recorded' | 'failed';
  revision: string | null;
  verdict: 'verified' | 'unverified' | null;
  admitted: number | null;
  needed: number;
  window: { since: string | null; until: string | null } | null;
  /** The measurement record this attempt wrote, relative to the root. */
  file: string | null;
  deliveries: ThroughputLedgerDelivery[];
  blocker: ThroughputBlocker | null;
  detail: string;
  /** What the command printed. */
  output: string;
}

export interface ThroughputLedger {
  version: 1;
  /** When the claim last became unverified with nothing verifying it since; null while verified or never attempted. */
  openedAt: string | null;
  entries: ThroughputLedgerEntry[];
}

const empty = (): ThroughputLedger => ({ version: 1, openedAt: null, entries: [] });

export async function readThroughputLedger(directory: string): Promise<ThroughputLedger> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, throughputLedgerFile), 'utf8')) as ThroughputLedger;
    return parsed?.version === 1 && Array.isArray(parsed.entries) ? parsed : empty();
  } catch { return empty(); }
}

/** A failed attempt's blocker, read from its error: the credential, the URL, or neither. */
export function classifyThroughputFailure(message: string): ThroughputBlocker {
  if (/GRAPHYARD_TOKEN|credential|token|\((401|403)\)|ENOENT/i.test(message)) return 'missing-credentials';
  if (/GRAPHYARD_URL|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|timed? ?out|abort|\((404|5\d\d)\)/i.test(message)) return 'unreachable-url';
  return 'measurement-failed';
}

const needed = (report: ThroughputReport) => report.claim?.minimumDeliveries ?? throughputClaim.minimumDeliveries;

/** A recorded report's blocker: null when it verified. */
export function reportBlocker(report: ThroughputReport): ThroughputBlocker | null {
  if (report.verdict === 'verified') return null;
  if (report.deployed?.containsClaim !== true) return 'release-unconfirmed';
  if ((report.population?.admitted ?? 0) < needed(report)) return 'no-session-free-deliveries';
  return 'claim-missed';
}

/** The ledger entry for a recorded measurement: the per-delivery list, its timestamps and the output. */
export function recordedEntry(report: ThroughputReport, input: { source: ThroughputLedgerEntry['source']; file: string | null; output: string; at?: string }): ThroughputLedgerEntry {
  const delivery = (record: ThroughputReport['deliveries'][number]): ThroughputLedgerDelivery => ({ key: record.key, pr: record.pr ?? null, mergedAt: record.mergedAt,
    admitted: record.admitted, submitToMergeMs: record.submitToMergeMs, exclusions: record.exclusions });
  return { at: input.at ?? report.measuredAt, source: input.source, outcome: 'recorded', revision: report.deployed?.revision ?? null, verdict: report.verdict,
    admitted: report.population?.admitted ?? 0, needed: needed(report), window: { since: report.window?.since ?? null, until: report.window?.until ?? report.measuredAt },
    file: input.file, deliveries: [...(report.deliveries ?? []), ...(report.excluded ?? [])].map(delivery), blocker: reportBlocker(report), detail: report.reason, output: input.output };
}

/** The ledger entry for an attempt that could not measure at all. */
export function failedEntry(error: unknown, input: { source: ThroughputLedgerEntry['source']; revision?: string | null; needed: number; at: string; output?: string }): ThroughputLedgerEntry {
  const detail = error instanceof Error ? error.message : String(error);
  return { at: input.at, source: input.source, outcome: 'failed', revision: input.revision ?? null, verdict: null, admitted: null, needed: input.needed, window: null,
    file: null, deliveries: [], blocker: classifyThroughputFailure(detail), detail, output: input.output ?? detail };
}

/**
 * Appends one attempt and moves the pursuit clock: a verified attempt stops it, any other opens it
 * if it is not running. Written whole through a rename, so a reader never sees half a ledger.
 */
export async function appendThroughputLedger(directory: string, entry: ThroughputLedgerEntry, retention = throughputLedgerRetention): Promise<ThroughputLedger> {
  await mkdir(directory, { recursive: true });
  const ledger = await readThroughputLedger(directory);
  const next: ThroughputLedger = { version: 1, openedAt: entry.verdict === 'verified' ? null : ledger.openedAt ?? entry.at, entries: [...ledger.entries, entry].slice(-retention) };
  const temporary = join(directory, `.${throughputLedgerFile}.${randomUUID()}`);
  await writeFile(temporary, JSON.stringify(next, null, 2) + '\n');
  await rename(temporary, join(directory, throughputLedgerFile));
  return next;
}

const blockerText: Record<ThroughputBlocker, (entry: ThroughputLedgerEntry) => string> = {
  'missing-credentials': entry => `missing credentials: the measurement cannot read the control plane (${entry.detail})`,
  'unreachable-url': entry => `unreachable URL: the measurement cannot reach the control plane (${entry.detail})`,
  'no-session-free-deliveries': entry => `no session-free deliveries occurring: ${entry.admitted ?? 0} of the ${entry.needed} deliveries the claim is judged over were made with no master session running`,
  'release-unconfirmed': entry => `the serving release is not confirmed to contain the claim's merge (${entry.detail})`,
  'claim-missed': entry => `the claim missed its budgets over ${entry.admitted} session-free deliveries (${entry.detail})`,
  'measurement-failed': entry => `the measurement failed (${entry.detail})`,
};

export interface ThroughputPursuit {
  openedAt: string;
  /** When the pursuit escalates: `openedAt` plus the bound. */
  dueAt: string;
  escalated: boolean;
  blocker: ThroughputBlocker | null;
  attempts: number;
  last: ThroughputLedgerEntry;
  text: string;
}

/**
 * The standing pursuit of the claim, or null when it is verified or was never attempted. Inside
 * the bound it says the loop is carrying it and when it escalates; past it, the text names the
 * exact blocker of the newest attempt for the operator.
 */
export function throughputPursuit(ledger: ThroughputLedger, now: number, boundMs = throughputEscalationMs): ThroughputPursuit | null {
  const last = ledger.entries.at(-1);
  if (!ledger.openedAt || !last || last.verdict === 'verified') return null;
  const opened = Date.parse(ledger.openedAt), dueAt = new Date(opened + boundMs).toISOString(), escalated = now >= opened + boundMs;
  const attempts = ledger.entries.filter(entry => entry.at >= ledger.openedAt!).length;
  const hours = Math.floor((now - opened) / 3_600_000), blocker = last.blocker ?? 'measurement-failed';
  const text = escalated
    ? `the claim has stayed unverified for ${hours}h since ${ledger.openedAt}, past the ${boundMs / 3_600_000}h bound, over ${attempts} attempts; the blocker is ${blockerText[blocker](last)}`
    : `the loop re-measures the serving release as deliveries accumulate (${attempts} attempts since ${ledger.openedAt}; last: ${blockerText[blocker](last)}) and escalates the operator at ${dueAt} if it still has not verified`;
  return { openedAt: ledger.openedAt, dueAt, escalated, blocker, attempts, last, text };
}
