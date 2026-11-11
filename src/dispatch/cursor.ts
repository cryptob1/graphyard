import { loopStateClient, migrateLoopFile } from '../loop-state.js';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { readEnvironmentLog, type EnvironmentLog } from '../master/environments.js';
import { type MasterConfig } from '../master/profiles.js';
import { reviewVerdictReminderMs } from '../reviewer.js';
import { requestAttemptLimit } from '../producer.js';
/**
 * Every string the cursor holds is bounded where it is composed, never only checked at persist
 * time (GY-120): a reason the dispatcher composed and then could not persist failed the whole
 * tick, and with it every launch for every item, until the string happened to change. The caps
 * nest — a stored failure reason leaves room for the wait sentence that wraps it, and that
 * sentence is bounded again before it becomes a tick reason — so a reason at its cap still
 * yields a valid tick. `bounded` marks every cut with an ellipsis rather than hiding it.
 */
export const launchWaitLimit = 50;
export const cursorTextLimit = 500, capacityReasonLimit = 1000, dispatchFailureReasonLimit = 300, closureFailureReasonLimit = 300;
export const ellipsis = '…';
export const bounded = (text: string, limit: number) => text.length > limit ? `${text.slice(0, Math.max(0, limit - ellipsis.length))}${ellipsis}` : text;
/**
 * The closure failures a tick stores, as the sentences the cursor holds. The sentence wraps a
 * reason already bounded below the cap, and is bounded again so a reason at its own cap cannot
 * push the stored string past `cursorTextLimit` and refuse the whole tick's persist.
 */
export const closeFailureReasons = (failures: { work: string; id: string; reason: string }[]) =>
  failures.slice(0, 20).map(failure => bounded(`${failure.work} session ${failure.id}: ${failure.reason}`, cursorTextLimit));
export interface DispatchLaunch { kind: 'review' | 'producer'; work: string; requestId: string; sha: string; profile: string; group?: string; proofs?: string[]; failover?: string[]; relaunched?: boolean; reason?: string }
export interface DispatchWait { kind: 'review' | 'producer'; work: string; requestId: string; sha: string; reason: string; group?: string; requestedAt?: string; answeredAt?: string }
/** The highest refusal count a stored failure may carry: the ceiling the probes are clamped to and the schema enforces, kept one constant so they cannot drift apart. */
export const dispatchAttemptCeiling = 1000;
export const dispatchFailureSchema = z.object({
  kind: z.enum(['review', 'producer']), work: z.string().min(1), sha: z.string().min(1),
  attempts: z.number().int().min(1).max(dispatchAttemptCeiling), reason: z.string(), at: z.string(), nextAt: z.string(),
}).strict();
export type DispatchFailure = z.infer<typeof dispatchFailureSchema>;
/**
 * A request the loop has stopped attempting (GY-193): every automatic session it launched for the
 * request ended without answering it. Kept until the request resolves, and raised as one attention
 * item naming the request and every attempt.
 */
export const abandonedRequestSchema = z.object({
  kind: z.enum(['review', 'producer']), work: z.string().min(1), sha: z.string().min(1), at: z.string(),
  reason: z.string(), attempts: z.array(z.string()).max(30),
  /** Producer only (GY-496): the proof group and proofs the request stood for, which the attention and the rework name. */
  group: z.string().min(1).optional(), proofs: z.array(z.string().min(1)).max(50).optional(),
}).strict();
const capacityHoldSchema = z.object({ at: z.string(), recheckAt: z.string(), reason: z.string() }).strict();
export const profileBackoffSchema = z.object({ role: z.enum(['reviewer', 'producer']), profile: z.string().min(1), path: z.string(), cause: z.string(),
  failures: z.number().int().min(1).max(dispatchAttemptCeiling), at: z.string(), until: z.string().nullable() }).strict();
/** GY-3235: how many launches in a row must fail the same sandbox probe before a profile is skipped, and for how long. */
export const probeBackoffFailures = 2, probeBackoffMs = 30 * 60_000;
/** The profiles skipped at `now`, as master status names them. */
export const backedOffProfiles = (cursor: Pick<DispatchCursor, 'profileBackoff'>, now: number) =>
  Object.values(cursor.profileBackoff).filter(entry => entry.until && Date.parse(entry.until) > now).map(({ role, profile, cause, until }) => ({ role, profile, cause, until: until! }));
/**
 * A tick that failed, and — when it composed state it could not persist — the field that failed
 * and the request and item it was composed for, so `master status` attributes the failure to a
 * request rather than to the dispatcher as a whole.
 */
export const tickFailureSchema = z.object({ at: z.string(), reason: z.string(),
  field: z.string().optional(), kind: z.enum(['review', 'producer']).optional(), request: z.string().optional(), work: z.string().optional() }).strict();
export const dispatchCursorSchema = z.object({
  version: z.literal(1), url: z.string(), repository: z.string(),
  ticks: z.number().int().min(0).default(0),
  lastTickAt: z.string().nullable().default(null),
  /** The last tick that read the snapshot and ran to the end, and how many ticks have failed since. */
  lastSuccessAt: z.string().nullable().default(null),
  consecutiveFailures: z.number().int().min(0).default(0),
  lastFailure: tickFailureSchema.nullable().default(null),
  /** Launches that refused, by request id, with the widening retry time; cleared by the launch that succeeds. */
  failures: z.record(z.string(), dispatchFailureSchema).default({}),
  /** Requests whose automatic sessions all ended unanswered, up to the limit; cleared when the request resolves. */
  abandoned: z.record(z.string(), abandonedRequestSchema).default({}),
  /**
   * Both halves of the last tick: what it could launch and what it did. A dispatcher that is
   * ticking but launching nothing looks identical to a stopped one from the tick count alone,
   * so the counts and the reasons nothing launched are kept for `master status`.
   */
  lastTick: z.object({ at: z.string(), launched: z.number().int().min(0), refused: z.number().int().min(0), waiting: z.number().int().min(0), settled: z.number().int().min(0),
    /** Session records this tick closed against the runtime, and the closures it could not write back. */
    closed: z.number().int().min(0).default(0), closeFailures: z.array(z.string()).max(20).default([]),
    reasons: z.array(z.string()).max(20).default([]),
    /** Each request the tick left waiting, by request id, with why (GY-710): what `master status` ages against the request's own time. */
    waits: z.array(z.object({ kind: z.enum(['review', 'producer']), work: z.string().min(1), requestId: z.string().min(1), sha: z.string().min(1),
      reason: z.string(), group: z.string().optional(),
      /** When the reviewer's verdict on the request settled (GY-1429): a request already answered waits from then, not from its request. */
      answeredAt: z.string().optional() }).strict()).max(launchWaitLimit).default([]),
    /** Retired (GY-2876): the tick's step and call timings; a cursor written before still parses. */
    timings: z.unknown().optional() }).strict().nullable().default(null),
  /**
   * A role none of whose accounts can launch (GY-89): why, and when its accounts are read again.
   * That is capacity, not a refusal, so it never counts toward a request's failure limit — a
   * request that waited out a week-long reset launches the moment an account returns.
   */
  capacity: z.object({ review: capacityHoldSchema.optional(), producer: capacityHoldSchema.optional() }).strict().default({}),
  /**
   * GY-3235: a profile whose launch failed its sandbox probe, by `role:profile`, with the cause and
   * how many launches in a row failed on the same path. Twice in a row skips it for that role until
   * `until`, in favour of the next profile; a launch that starts clears it.
   */
  profileBackoff: z.record(z.string(), profileBackoffSchema).default({}),
  /**
   * The session handles the runtime had stopped reporting when the last tick swept, each carrying
   * when it was first missed (GY-113). Absence is only evidence that a session is gone once it
   * persists, so the grace is counted from here rather than from one short listing, and carrying
   * it on the cursor keeps that judgment across a restart of the loop.
   */
  sessionMisses: z.record(z.string(), z.string()).default({}),
  /**
   * The registry sessions this host's tick found unbacked by Herdr, each carrying when it was first
   * missed (GY-2945). One a restarted loop no longer tracks among its handles is judged here, so
   * the second consecutive miss survives a restart of the loop, as the handle misses do.
   */
  registryMisses: z.record(z.string(), z.string()).default({}),
  /**
   * What launches last observed about each agent account and the launches that skipped an account,
   * with the reason. Read from the environment log beside the cursor, which every launcher writes;
   * never persisted in the cursor itself.
   */
  accounts: z.object({ environments: z.record(z.string(), z.any()), skipped: z.array(z.any()) }).optional(),
}).strict();
export type DispatchCursor = z.infer<typeof dispatchCursorSchema>;

/**
 * A refused launch retries on a widening interval, never more often than this and never later than this.
 * The failure limit also bounds how many sessions one request gets in all, however each ended (GY-193).
 */
export const dispatchRetryMinMs = 30_000, dispatchRetryMaxMs = 600_000, dispatchFailureLimit = requestAttemptLimit;
/**
 * GY-193. A reviewer that judged the head but did not post is reminded once to post (reviewer.ts
 * reconcileReviews) and relaunched when no verdict follows within this bound. A session that settled
 * on a verdict the control plane has not read yet is given this long before the request, still
 * standing, is attempted again: a second verdict on the same request is otherwise withheld with the first.
 */
export const reviewerReminderBoundMs = reviewVerdictReminderMs, verdictIngestGraceMs = 5 * 60_000;
/** How often the dispatcher wakes one item's observation for an answered review request (GY-1429). */
export const observationWakeIntervalMs = 60_000;
/** How long a role with no account left is not launched before its accounts are read again. */
export const capacityRecheckMs = 60_000;
/** How many missing session handles the cursor remembers between ticks between ticks. */
export const sessionMissLimit = 500;
/**
 * A tick whose snapshot read fails is retried on its own short backoff rather than a whole
 * interval later, never faster than the first step and never slower than the interval. The read
 * itself is bounded so a hung request cannot hold the loop past the dispatch bound.
 */
export const dispatchReadTimeoutMs = 8_000, tickRetryMinMs = 1_000;

export function emptyDispatchCursor(config: MasterConfig): DispatchCursor {
  return dispatchCursorSchema.parse({ version: 1, url: config.url, repository: config.repository });
}
/** Beside the daemon cursor, outside every worktree. */
export function dispatchCursorPath(config: MasterConfig) {
  const file = config.credentialFile;
  return resolve(dirname(file), `${basename(file).replace(/\.token$/, '')}.dispatch.json`);
}
/** A schema path for a failed dispatch persistence operation. */
export const cursorPath = (path: readonly PropertyKey[]) => path.reduce<string>((text, segment) => typeof segment === 'number' ? `${text}[${segment}]` : text ? `${text}.${String(segment)}` : String(segment), '');
export async function readDispatchCursor(root: string, config: MasterConfig): Promise<DispatchCursor> {
  const client = await loopStateClient(config);
  await migrateLoopFile(client, 'dispatch', dispatchCursorPath(config), value => {
    const { botReviewers: _retired, ...stored } = value as Record<string, unknown>;
    return [dispatchCursorSchema.parse(stored)];
  });
  const stored = (await client.read('dispatch'))[0];
  const cursor = stored ? dispatchCursorSchema.parse(stored) : emptyDispatchCursor(config);
  if (cursor.url !== config.url || cursor.repository.toLowerCase() !== config.repository.toLowerCase()) throw new Error('Master dispatch cursor belongs to another Graphyard server or repository');
  const log: EnvironmentLog = await readEnvironmentLog(config);
  return Object.keys(log.environments).length || log.skipped.length ? { ...cursor, accounts: { environments: log.environments, skipped: log.skipped } } : cursor;
}
export async function writeDispatchCursor(config: MasterConfig, cursor: DispatchCursor) {
  const { accounts: _accounts, ...persisted } = cursor;
  await (await loopStateClient(config)).write('dispatch', [dispatchCursorSchema.parse(persisted)]);
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** What a tick failure records about state it could not persist, for `master status` and the attention it raises. */
export interface PersistFailure { field: string | null; kind?: 'review' | 'producer'; request?: string; work?: string }
/**
 * A persist that failed, attributed. A schema refusal names the path it refused; the request and
 * item that path was composed for come from the cursor (a recorded refusal) or from the tick's
 * own wait list (a tick reason). Anything else — the file, the disk — is the write's own message.
 */
export function attributePersistFailure(error: unknown, cursor: DispatchCursor, reasons: Pick<DispatchWait, 'kind' | 'requestId' | 'work'>[]): Error & { persistFailure: PersistFailure } {
  const issue = (error as { issues?: { path: PropertyKey[]; message: string }[] })?.issues?.[0];
  const failure: PersistFailure = { field: issue ? cursorPath(issue.path) : null };
  const path = issue?.path ?? [];
  if (path[0] === 'failures' && typeof path[1] === 'string' && cursor.failures[path[1]]) Object.assign(failure, { kind: cursor.failures[path[1]].kind, request: path[1], work: cursor.failures[path[1]].work });
  else if (path[0] === 'lastTick' && path[1] === 'reasons' && typeof path[2] === 'number' && reasons[path[2]]) Object.assign(failure, { kind: reasons[path[2]].kind, request: reasons[path[2]].requestId, work: reasons[path[2]].work });
  const composed = failure.request ? `, composed for the ${failure.kind} request ${failure.request} on ${failure.work}` : '';
  return Object.assign(new Error(`the dispatch cursor could not be persisted: ${issue ? `${failure.field} ${issue.message}${composed}` : message(error)}`), { persistFailure: failure, cause: error });
}
/** The waits a tick keeps (GY-710): one per request, its last reason, reviews first and the longest waiting first, bounded for the cursor. */
export function tickWaits(waiting: DispatchWait[]) {
  const byRequest = new Map<string, DispatchWait>();
  for (const entry of waiting) byRequest.set(entry.requestId, entry);
  // Past the bound the most recent requests drop, so the longest waits still raise attention.
  const requested = (entry: DispatchWait) => { const at = Date.parse(entry.requestedAt ?? ''); return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER; };
  return [...byRequest.values()].sort((a, b) => (a.kind === 'review' ? 0 : 1) - (b.kind === 'review' ? 0 : 1) || requested(a) - requested(b)).slice(0, launchWaitLimit)
    .map(({ kind, work, requestId, sha, reason, group, answeredAt }) => ({ kind, work: work.slice(0, 40), requestId: requestId.slice(0, 64), sha: sha.slice(0, 40), reason: bounded(reason, cursorTextLimit), ...(group ? { group: group.slice(0, 40) } : {}), ...(answeredAt ? { answeredAt: answeredAt.slice(0, 40) } : {}) }));
}
