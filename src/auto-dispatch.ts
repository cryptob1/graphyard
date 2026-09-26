import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { childRunner, type ChildRun } from './child-runner.js';
import { Timings, timedCall, timedRun, serverCallName, describeTimings, timingsSchema, withTimings, type TimingReport } from './master/timings.js';
import type { Work } from './model.js';
import { observeSessions, registeredLaunch, reportedHandle, type SessionReportEntry } from './model/session-state.js';
import { runtimeSessionOf, sessionClosureBoundMs, sessionLiveness, sessionRole, sessionVanishGraceMs, supersededSession, type LivenessOptions, type SessionHandle, type SessionHandleInput, type SessionKind, type RuntimeSession } from './model/sessions.js';
import { runtimeEndedStates } from './harness.js';
import type { DispatchRequest } from './model/dispatch.js';
import { actionRenewIntervalMs, type ActionRow } from './model/actions.js';
import { nextActionKinds, type NextActionKind } from './model/next-action.js';
import { agentOwner, assertOutsideWorktrees, inspectProducerCredentials, listHerdrAgents, profileAccount, profileSessions, readCredentialFile, readEnvironmentLog, recordObservedExhaustion, herdrErrorCode, selectionKey, sessionAgentName, SessionStartError, sessionWords, type StartBounds, type AttentionItem, type ConfigReload, type EnvironmentLog, type HerdrAgent, type MasterConfig, type ObservedExhaustion, type ProducerProfile, type ReviewerProfile } from './master.js';
import { detectExhaustion, type ExhaustionSignal } from './model/capacity.js';
import { capacityRefusal } from './fleet.js';
import { launchReview, reconcileReviews, reviewVerdictReminderMs, unpostedVerdict, type ReviewRecord } from './reviewer.js';
import { answeredByPendingSession, independentProducerProfiles, launchProducer, reconcileProducers, requestAttemptLimit, sessionRetry, type ProducerRecord } from './producer.js';
import { currentEvidence } from './model/evidence.js';
import { judgeHostMemory, memoryDeferral, readHostMemory, type HostMemoryReading } from './master-resources.js';
export { hostMemoryHold } from './master-resources.js';

/**
 * The launch side of automatic dispatch at submit. The control plane records what each exact
 * head still needs (model/dispatch.ts); this loop reads those requests every few seconds and
 * launches the configured reviewer profile and one producer session per proof group for them,
 * within the 30-second bound and without a keystroke. It launches at most one session per
 * request id — the reviewer and producer ledgers say which requests already have one — so a
 * restart, a second tick, or a re-read snapshot never doubles a session. A head change is the
 * control plane's cancellation: the ledgers close the sessions for the old head on the next
 * tick, and the new head's requests launch afresh unless a carried binding covers them. The
 * master handles findings, reworks and merges; it never launches these by hand.
 *
 * A session that started and then failed or expired does not strand its request until the head
 * changes: the request is launched again as its next attempt after a widening wait (producer.ts
 * `sessionRetry`), up to a bound, and master status reports the attempts and the next one.
 *
 * Each reviewer and producer profile runs as many sessions at once as its `concurrency` declares
 * (GY-107; master.ts profileSessions): a launch takes the first profile with a slot left, a request
 * with none waits and the tick says which limit it waits on. The limit is read from the live
 * configuration on every tick, so raising it starts more sessions on the next tick and lowering it
 * launches nothing new until the running sessions drain — none is stopped.
 *
 * This interval is also what reconciles session liveness (GY-113; model/sessions.ts). A session
 * recorded as running is otherwise believed until something ends it, and a session that died reports
 * nothing — so every tick sweeps the graph's running handles against what the runtime reports,
 * closes the ones that vanished, ended, were superseded by a head or a candidate moving on, or hold
 * a slot a newer session already holds, and counts a role slot as taken only while the reconciled
 * record says a live session has it. Closing finished sessions is therefore no longer a duty
 * anybody performs by hand.
 */

/**
 * Every string the cursor holds is bounded where it is composed, never only checked at persist
 * time (GY-120): a reason the dispatcher composed and then could not persist failed the whole
 * tick, and with it every launch for every item, until the string happened to change. The caps
 * nest — a stored failure reason leaves room for the wait sentence that wraps it, and that
 * sentence is bounded again before it becomes a tick reason — so a reason at its cap still
 * yields a valid tick. `bounded` marks every cut with an ellipsis rather than hiding it.
 */
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
export const dispatchFailureSchema = z.object({
  kind: z.enum(['review', 'producer']), work: z.string().min(1).max(40), sha: z.string().min(1).max(40),
  attempts: z.number().int().min(1).max(1000), reason: z.string().max(cursorTextLimit), at: z.string(), nextAt: z.string(),
}).strict();
export type DispatchFailure = z.infer<typeof dispatchFailureSchema>;
/**
 * A request the loop has stopped attempting (GY-193): every automatic session it launched for the
 * request ended without answering it. Kept until the request resolves, and raised as one attention
 * item naming the request and every attempt.
 */
export const abandonedRequestSchema = z.object({
  kind: z.enum(['review', 'producer']), work: z.string().min(1).max(40), sha: z.string().min(1).max(40), at: z.string(),
  reason: z.string().max(cursorTextLimit), attempts: z.array(z.string().max(cursorTextLimit)).max(30),
}).strict();
export type AbandonedRequest = z.infer<typeof abandonedRequestSchema>;
const capacityHoldSchema = z.object({ at: z.string(), recheckAt: z.string(), reason: z.string().max(capacityReasonLimit) }).strict();
/**
 * A tick that failed, and — when it composed state it could not persist — the field that failed
 * and the request and item it was composed for, so `master status` attributes the failure to a
 * request rather than to the dispatcher as a whole.
 */
export const tickFailureSchema = z.object({ at: z.string(), reason: z.string().max(cursorTextLimit),
  field: z.string().max(200).optional(), kind: z.enum(['review', 'producer']).optional(), request: z.string().max(64).optional(), work: z.string().max(40).optional() }).strict();
export type TickFailure = z.infer<typeof tickFailureSchema>;
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
    closed: z.number().int().min(0).default(0), closeFailures: z.array(z.string().max(cursorTextLimit)).max(20).default([]),
    reasons: z.array(z.string().max(cursorTextLimit)).max(20).default([]),
    /** Where the tick's time went (GY-377): its steps and its slowest external calls. Absent on older ticks. */
    timings: timingsSchema.optional() }).strict().nullable().default(null),
  /**
   * A role none of whose accounts can launch (GY-89): why, and when its accounts are read again.
   * That is capacity, not a refusal, so it never counts toward a request's failure limit — a
   * request that waited out a week-long reset launches the moment an account returns.
   */
  capacity: z.object({ review: capacityHoldSchema.optional(), producer: capacityHoldSchema.optional() }).strict().default({}),
  /**
   * The session handles the runtime had stopped reporting when the last tick swept, each carrying
   * when it was first missed (GY-113). Absence is only evidence that a session is gone once it
   * persists, so the grace is counted from here rather than from one short listing, and carrying
   * it on the cursor keeps that judgment across a restart of the loop.
   */
  sessionMisses: z.record(z.string(), z.string()).default({}),
  /**
   * What launches last observed about each agent account and the launches that skipped an account,
   * with the reason. Read from the environment log beside the cursor, which every launcher writes;
   * never persisted in the cursor itself.
   */
  accounts: z.object({ environments: z.record(z.string(), z.any()), skipped: z.array(z.any()) }).optional(),
  /**
   * Each awaited bot reviewer as the last read of its repository activity found it (GY-349): one
   * whose latest word since its last review is a usage-limit notice is exhausted, and no reviewer
   * launch waits for it. Kept across ticks, so a failed read leaves the last judgment standing.
   */
  botReviewers: z.array(z.object({ login: z.string().max(100), state: z.enum(['available', 'exhausted']), since: z.string().nullable(), checkedAt: z.string() }).strict()).max(10).default([]),
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

/**
 * The producer's finding that a proof on this head does not exercise its criterion (GY-135): the
 * pass also held with the change removed. Such evidence is the worker's to fix, so the request is
 * never launched again for the head and the loop requests the rework instead (GY-193 AC-3).
 */
export function unexercisedFindings(work: Work, sha: string | undefined = work.candidate?.sha, proofs?: readonly string[]): { proof: string; finding: string }[] {
  if (!sha) return [];
  const findings = new Map<string, string>();
  for (const entry of work.evidence ?? []) {
    if (!entry.unexercised || entry.sha !== sha || entry.policyRevision !== work.policyRevision || (proofs && !proofs.includes(entry.proof))) continue;
    findings.set(entry.proof, entry.unexercised);
  }
  // A trusted pass recorded since answers the finding: the proof is proven on this head after all.
  return [...findings].filter(([proof]) => !(sha === work.candidate?.sha && currentEvidence(work, proof)?.result === 'pass')).map(([proof, finding]) => ({ proof, finding }));
}
/** A session record as the dispatcher reads it from either ledger. */
type DispatchedSession = { requestId?: string; state: string; requestedAt: string; closedAt?: string; resolution?: string; profile?: string; attempt?: number; acknowledgedAt?: string; verdict?: { state: string } };
const requestSessions = (records: DispatchedSession[], requestId: string) => records.filter(record => record.requestId === requestId);
/** Every attempt a request had, as the attention item names them. */
export const describeAttempts = (records: DispatchedSession[], requestId: string) => requestSessions(records, requestId).slice(-30)
  .map((record, index) => bounded(`attempt ${record.attempt ?? index + 1}${record.profile ? ` on ${record.profile}` : ''}: ${record.state}${record.resolution ? ` — ${record.resolution}` : ''}`, 300));
/**
 * The profiles a relaunch tries, freshest first: a profile no attempt of this request ran on, then
 * the ones earlier attempts ran on, and the profile of the session that just settled last. A
 * relaunch on the account that just ended without an answer is the one least likely to answer.
 */
export function preferFreshProfiles<P extends { name: string }>(profiles: P[], records: DispatchedSession[], requestId: string): P[] {
  const used = requestSessions(records, requestId).map(record => record.profile);
  if (!used.length) return profiles;
  const rank = (profile: P) => used.lastIndexOf(profile.name);
  return profiles.map((profile, index) => ({ profile, index })).sort((a, b) => rank(a.profile) - rank(b.profile) || a.index - b.index).map(entry => entry.profile);
}
/** How long a role with no account left is not launched before its accounts are read again. */
export const capacityRecheckMs = 60_000;
/** How many missing session handles the cursor remembers between ticks; a file, not a database. */
export const sessionMissLimit = 500;
/**
 * A tick whose snapshot read fails is retried on its own short backoff rather than a whole
 * interval later, never faster than the first step and never slower than the interval. The read
 * itself is bounded so a hung request cannot hold the loop past the dispatch bound.
 */
export const dispatchReadTimeoutMs = 8_000, tickRetryMinMs = 1_000;
export const tickRetryDelay = (failures: number, intervalMs: number, minMs = tickRetryMinMs) => Math.min(minMs * 2 ** Math.max(0, failures - 1), Math.max(minMs, intervalMs));
/**
 * The bound on the next snapshot read. A fixed bound below what the server needs under load would
 * leave dispatch blind for good, each retry timing out as the last did; so every consecutive failure
 * doubles it, never past the interval (or the base bound, when that is already longer).
 */
export const tickReadTimeout = (failures: number, intervalMs: number, baseMs = dispatchReadTimeoutMs) => Math.min(baseMs * 2 ** Math.max(0, failures), Math.max(baseMs, intervalMs));

export function emptyDispatchCursor(config: MasterConfig): DispatchCursor {
  return dispatchCursorSchema.parse({ version: 1, url: config.url, repository: config.repository });
}
/** Beside the daemon cursor, outside every worktree. */
export function dispatchCursorPath(config: MasterConfig) {
  const file = config.credentialFile;
  return resolve(dirname(file), `${basename(file).replace(/\.token$/, '')}.dispatch.json`);
}
/**
 * A cursor that fails its own schema is repaired, not fatal (GY-120): a string past its cap is
 * truncated in place, ellipsis-marked like every other bound, and the repair is reported with
 * the path that failed, so a defect of this class degrades one reason string rather than every
 * launch. Anything else the schema refuses is still refused, naming its path.
 */
export interface CursorRepair { path: string; detail: string }
export type RepairListener = (repair: CursorRepair) => void;
/** A schema path as `master status` and the loop log name it: `lastTick.reasons[1]`, `failures.<request>.reason`. */
export const cursorPath = (path: readonly PropertyKey[]) => path.reduce<string>((text, segment) => typeof segment === 'number' ? `${text}[${segment}]` : text ? `${text}.${String(segment)}` : String(segment), '');
export function repairDispatchCursor(value: unknown, onRepair?: RepairListener): DispatchCursor {
  for (let pass = 0; ; pass++) {
    const parsed = dispatchCursorSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    const first = parsed.error.issues[0];
    const oversized = parsed.error.issues.filter(issue => issue.code === 'too_big' && (issue as { origin?: string }).origin === 'string' && typeof (issue as { maximum?: unknown }).maximum === 'number');
    if (!oversized.length || pass >= 3) throw new Error(`Master dispatch cursor is invalid at ${cursorPath(first.path)}: ${first.message}`);
    for (const issue of oversized) {
      const holder = issue.path.slice(0, -1).reduce<any>((node, segment) => node?.[segment as string | number], value), key = issue.path.at(-1) as string | number;
      const limit = (issue as { maximum: number }).maximum;
      if (typeof holder?.[key] !== 'string') throw new Error(`Master dispatch cursor is invalid at ${cursorPath(issue.path)}: ${issue.message}`);
      const length = holder[key].length;
      holder[key] = bounded(holder[key], limit);
      onRepair?.({ path: cursorPath(issue.path), detail: `${length} characters exceeded its cap of ${limit} and it was truncated` });
    }
  }
}
/** The loop's own line for a repair, written once per path (see `dispatchEffects`). */
export const repairLine = (stage: 'loading' | 'persisting', repair: CursorRepair) => `[graphyard-dispatch] repaired the dispatch cursor while ${stage} it: ${repair.path} — ${repair.detail}`;
export async function readDispatchCursor(root: string, config: MasterConfig, onRepair: RepairListener = repair => console.error(repairLine('loading', repair))): Promise<DispatchCursor> {
  const file = dispatchCursorPath(config);
  await assertOutsideWorktrees(root, dirname(file), 'Master dispatch cursor directory');
  let raw: string;
  const withAccounts = async (cursor: DispatchCursor): Promise<DispatchCursor> => {
    const log: EnvironmentLog = await readEnvironmentLog(config);
    return Object.keys(log.environments).length || log.skipped.length ? { ...cursor, accounts: { environments: log.environments, skipped: log.skipped } } : cursor;
  };
  try { raw = await readFile(file, 'utf8'); }
  catch (error: any) { if (error.code === 'ENOENT') return withAccounts(emptyDispatchCursor(config)); throw error; }
  const cursor = repairDispatchCursor(JSON.parse(raw), onRepair);
  if (cursor.url !== config.url || cursor.repository.toLowerCase() !== config.repository.toLowerCase()) throw new Error('Master dispatch cursor belongs to another Graphyard server or repository; remove it before running the loop');
  return withAccounts(cursor);
}
export async function writeDispatchCursor(config: MasterConfig, cursor: DispatchCursor, onRepair?: RepairListener) {
  const file = dispatchCursorPath(config), temporary = `${file}.${randomUUID()}.tmp`;
  const { accounts: _accounts, ...persisted } = cursor;
  // The repair truncates the live cursor's own strings (the nested objects are shared), so a
  // string repaired once is not composed past its cap again by the tick that reads it back.
  await writeFile(temporary, JSON.stringify(repairDispatchCursor(persisted, onRepair), null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file); await chmod(file, 0o600);
}

/** The reviewer profile that answers automatic requests: the configured one, else the only one. */
export function selectReviewerProfile(config: MasterConfig): { profile: ReviewerProfile | null; reason: string | null } {
  if (!config.reviewer) return { profile: null, reason: 'no reviewer identity is registered; run master reviewer setup or master reviewer bind' };
  if (config.run.reviewerProfile) {
    const profile = config.reviewers.find(item => item.name === config.run.reviewerProfile) ?? null;
    return profile ? { profile, reason: null } : { profile: null, reason: `run.reviewerProfile names ${config.run.reviewerProfile}, which is not a configured reviewer profile` };
  }
  if (config.reviewers.length === 1) return { profile: config.reviewers[0], reason: null };
  return { profile: null, reason: config.reviewers.length ? 'more than one reviewer profile is configured; set run.reviewerProfile in .graphyard/master.json to the one automatic dispatch launches' : 'no reviewer profile is configured; add one with master reviewer add' };
}

/** The automatic bot reviewers a reviewer launch waits for when `run.awaitReviewers` is unset, and for how long. */
export const defaultAwaitReviewers = { logins: ['chatgpt-codex-connector[bot]'], minutes: 8 };
/**
 * A bot reviewer's notice that its provider's quota is spent (GY-349), as the Codex connector words
 * it on each new head ('You have reached your Codex usage limits for code reviews').
 */
export const botLimitNotice = /reached your [\w .-]{0,40}usage limits?|usage limits? (?:has|have) been reached/i;
/** One review or issue comment an awaited bot reviewer posted on the repository. */
export interface BotActivity { login: string; kind: 'review' | 'comment'; at: string; body?: string }
export interface BotReviewerState { login: string; state: 'available' | 'exhausted'; since: string | null }
/**
 * Whether each awaited bot reviewer can answer (GY-349). A bot whose latest activity is a
 * usage-limit notice is exhausted since the first notice after its last review, and stays so until
 * it next posts a review on any head: only a review shows its quota is back. `held` is the last
 * judgment: an exhausted bot whose notice has aged out of the read stays exhausted since it.
 */
export function botReviewerStates(awaited: readonly string[], activity: readonly BotActivity[], held: readonly BotReviewerState[] = []): BotReviewerState[] {
  return awaited.map(login => {
    const mine = activity.filter(entry => entry.login.toLowerCase() === login.toLowerCase() && Number.isFinite(Date.parse(entry.at)));
    const reviewed = Math.max(-Infinity, ...mine.filter(entry => entry.kind === 'review').map(entry => Date.parse(entry.at)));
    const kept = held.filter(bot => bot.login.toLowerCase() === login.toLowerCase() && bot.state === 'exhausted' && bot.since).map(bot => Date.parse(bot.since!));
    const notices = [...mine.filter(entry => entry.kind === 'comment' && botLimitNotice.test(entry.body ?? '')).map(entry => Date.parse(entry.at)), ...kept].filter(time => Number.isFinite(time) && time > reviewed);
    return notices.length ? { login, state: 'exhausted' as const, since: new Date(Math.min(...notices)).toISOString() } : { login, state: 'available' as const, since: null };
  });
}
/** How many of the most recently updated pull requests one bot-activity read looks in for a review since a limit notice. */
export const botReviewPullLimit = 30;
/** The status line for one awaited bot reviewer. */
export const botReviewerLine = (bot: { login: string; state: string; since: string | null }) => bot.state === 'exhausted' ? `${bot.login}: exhausted since ${bot.since}` : `${bot.login}: available`;
/**
 * How long one tick waits on the bot-review reads, all started together, before treating the
 * unanswered ones as failed reads (which launch). Well inside the 30-second launch bound, so a slow
 * or hung GitHub read never holds producers, or any other item's review, past it.
 */
export const botReviewReadTimeoutMs = 5_000;

export interface DispatchEffects {
  snapshot: () => Promise<{ work: Work[]; now: string }>;
  /** Herdr's agent list, or null when Herdr could not be read; read asynchronously, never blocking the loop beside it. */
  agents: () => HerdrAgent[] | null | Promise<HerdrAgent[] | null>;
  credentials: (profiles: ProducerProfile[]) => Promise<Record<string, { available: boolean; reason: string | null }>>;
  reconcileReviews: (work: Work[], agents: HerdrAgent[] | null) => Promise<{ reviews: ReviewRecord[]; threads?: string[] }>;
  reconcileProducers: (work: Work[], agents: HerdrAgent[] | null) => Promise<{ producers: ProducerRecord[] }>;
  launchReview: (work: Work, request: DispatchRequest, profile: ReviewerProfile, agents: HerdrAgent[], observedAt: string) => Promise<unknown>;
  launchProducer: (work: Work, request: DispatchRequest, profile: ProducerProfile, agents: HerdrAgent[], observedAt: string) => Promise<unknown>;
  /**
   * The GitHub logins that have reviewed the request's head, read with the loop's own access outside
   * every coordination transaction. Used to hold a reviewer launch until the configured automatic
   * bot reviewers have spoken (`run.awaitReviewers`); a dispatcher wired without it never waits.
   */
  headReviewers?: (work: Work, request: DispatchRequest) => Promise<string[]>;
  /**
   * The awaited bot reviewers' recent reviews and issue comments on the repository (GY-349), read
   * once per tick while a launch would wait on them; a bot whose latest word is a usage-limit
   * notice is not waited for. A dispatcher wired without it waits on every awaited bot.
   */
  botActivity?: (logins: string[], requests: DispatchRequest[], held: BotReviewerState[]) => Promise<BotActivity[]>;
  /**
   * Records a launched reviewer or producer session's durable handle on the item. Without it a
   * launched session is visible only in this host's own ledger, which is the relaying the handle
   * exists to end; a dispatcher wired without it still launches, it simply records nothing.
   */
  recordSession?: (work: Work, handle: SessionHandleInput) => Promise<unknown>;
  /**
   * A session that exited within seconds of its launch on its provider's limit notice (GY-120) is
   * failed over exactly as one exhausted mid-session is (master-daemon.ts): the account its
   * launcher selected is held until the notice's reset, the exhaustion is recorded on the item,
   * and the request launches again on the profile's next account. A dispatcher wired without
   * `holdAccount` records the exit as the refusal it was.
   */
  selectedAccount?: (role: 'reviewer' | 'producer', profile: string) => Promise<{ environment: string | null; kind: string | null } | null>;
  holdAccount?: (account: string, observed: Omit<ObservedExhaustion, 'until'>) => Promise<{ until?: string } | void>;
  reportCapacity?: (work: Work, event: Record<string, unknown>) => Promise<unknown>;
  /** This host's memory (GY-612): below its floor, no reviewer or producer is launched and each request waits with the reason. */
  hostMemory?: () => Promise<HostMemoryReading | null>;
  /**
   * Ends one session record the liveness sweep found settled. A dispatcher wired without it still
   * launches and still judges liveness — it simply leaves the record standing, which is the state
   * GY-113 exists to end, so the shipped `dispatchEffects` always wires it.
   */
  endSession?: (closure: SessionClosure) => Promise<unknown>;
  persist: (cursor: DispatchCursor) => Promise<void>;
}

/**
 * A launched session Herdr cannot find within seconds of its launch. The launcher types the
 * launch into the pane and reads it until the runtime is ready (master.ts, `awaitRuntimeStart`):
 * `herdr agent get` answers `agent_not_found` while the runtime is not there, which says nothing
 * about why, and `herdr pane read` shows what the runtime printed. A runtime that printed its
 * provider's limit notice and exited leaves the notice under its banner, and the banner alone
 * would hold the launcher's start bound to its ceiling before the refusal. The dispatcher watches
 * each launch's reads of its own pane (GY-120): a provider limit notice on the pane is account
 * exhaustion — the launch is refused at the next pause between the launcher's polls, the account
 * is held and the request launches on the profile's next account exactly as a mid-session
 * exhaustion does — and any other refusal is the launcher's own, which names the case it saw and
 * the pane's last words rather than the CLI's JSON error.
 */
export interface InstantExit { pane: string; words: string; notice: ExhaustionSignal }
export class InstantExitError extends Error {
  constructor(readonly instantExit: InstantExit, override readonly cause: unknown) {
    super(`the session exited within seconds of its launch on its provider's limit notice: ${instantExit.notice.reason}`);
  }
}
/** How many times one profile launches again on its next account within a single tick after such exits. */
export const instantExitRelaunchLimit = 4;
export interface InstantExitWatch {
  /** The launcher's Herdr calls, with each read of the pane it typed the launch into remembered. */
  run: ChildRun;
  /** The launcher's pause between polls of that pane: a pane already showing the notice is refused here, never waited out. */
  start: StartBounds;
  /** A refusal the launcher raised at its bound, classified from the pane's last read; any other error as it came. */
  classify: (error: unknown) => unknown;
}
/**
 * One watch per launch: it remembers the pane `pane run` typed the launch into and that pane's
 * last screen, and touches nothing else the launcher runs. The screen is read from the launcher's
 * own `pane read`, so the pane is read no more often than the launcher reads it and never after
 * the launcher closed it.
 */
export function watchInstantExit(run: ChildRun, now: () => number = Date.now): InstantExitWatch {
  let pane: string | null = null, screen: string | null = null, missing: unknown = null;
  const exit = () => { const notice = pane && screen !== null ? detectExhaustion(screen, now()) : null; return notice ? new InstantExitError({ pane: pane!, words: sessionWords(screen), notice }, missing) : null; };
  return {
    run: (command, args, options) => {
      const herdr = command === 'herdr';
      if (herdr && args[0] === 'pane' && args[1] === 'run') { pane = args[2] ?? null; screen = null; missing = null; }
      const read = (result: string) => { if (herdr && pane && args[0] === 'pane' && args[1] === 'read' && args[2] === pane) screen = String(result); return result; };
      const refused = (error: unknown): never => { if (herdr && pane && args[0] === 'agent' && args[1] === 'get' && args[2] === pane && herdrErrorCode(error) === 'agent_not_found') missing = error; throw error; };
      // The runner's answer is passed on as it came: a test's table answers at once, the process's
      // bounded runner (GY-125) answers on the event loop, and the watch notes the read either way.
      let result: Promise<string> | string;
      try { result = run(command, args, options); } catch (error) { return refused(error); }
      return typeof result === 'string' ? read(result) : result.then(read, refused);
    },
    // A pane already showing the notice is refused before the pause; otherwise the pause is a timer
    // the launcher awaits, never a blocking sleep, so the cycle's reads beside it are served.
    start: { wait: ms => { const exited = exit(); if (exited) throw exited; return new Promise<void>(resolve => setTimeout(resolve, ms)); } },
    classify: error => error instanceof SessionStartError && error.pane === pane && error.startCase !== 'blocked' ? exit() ?? error : error,
  };
}

/**
 * The handle a launched reviewer or producer session gets on the item: the pane its launcher just
 * reported, the runtime and workspace this loop launched it into, and the command that attaches to
 * that exact pane. `id` is the dispatch request the session answers, so a relaunch updates the
 * handle rather than adding one.
 *
 * What the launcher cannot know — the tab the runtime opened under its own control, and the
 * transcript the agent writes — the session records for itself against
 * `POST /api/work/GY-N/session`, which is the only party that has them. A handle with no pane
 * carries no attach command rather than one that cannot work.
 *
 * It also records what liveness reconciliation needs of it (GY-113): the runtime's own name for the
 * session, so the handle can be matched against the runtime's listing even after its pane is gone;
 * the slot it occupies, which is its kind and, for a producer session, the one proof group it runs;
 * and the exact head it is bound to, so a session for a head the item has moved past is recognised
 * as superseded rather than left running against a candidate nobody is waiting for.
 */
export function launchedSessionHandle(kind: 'review' | 'proof', request: DispatchRequest, subject: string, host: string, launched: { pane?: string | null; agentName?: string | null } | undefined, runtime: string, workspace?: string, principal?: string): SessionHandleInput {
  return {
    id: request.id, kind, runtime, host,
    role: kind === 'proof' && request.group ? `proof:${request.group}` : kind, head: request.sha,
    ...(launched?.agentName ? { agentName: launched.agentName } : {}),
    // Whose session it is, when the launcher knows: a producer session runs under its own
    // credential, and naming it here is what lets that session — and nobody else — fill in the
    // tab and transcript the launcher cannot see.
    ...(principal ? { principal } : {}),
    ...(workspace ? { workspace } : {}),
    ...(launched?.pane ? { pane: launched.pane, attach: `herdr pane attach ${launched.pane}${workspace ? ` --workspace ${workspace}` : ''}` } : {}),
    subject: subject.slice(0, 300), state: 'running',
  };
}

/**
 * The liveness sweep this loop runs every tick (GY-113). The rules it applies are the model's —
 * `sessionLiveness` for what the runtime says, `supersededSession` for what the item says — and
 * the sweep over the graph, the closure it records and the write-back live here with the interval
 * that runs them. It is pure over the snapshot: the caller writes each closure back through the
 * coordinator mutation, so one sweep answers a status reader and this loop alike.
 */
export type ClosureCause = 'vanished' | 'ended' | 'superseded' | 'duplicate';
export interface SessionClosure { workId: string; key: string; id: string; kind: SessionKind; role: string; runtime: string; host: string; subject: string; cause: ClosureCause; outcome: string;
  /** The session report entry that closed it, when the runtime's observation did rather than the item. */
  report?: SessionReportEntry }
/** How one handle is named between ticks: the item it sits on, and its own id. */
export const sessionHandleKey = (workId: string, id: string) => `${workId}\u0000${id}`;
/** Whose vocabulary a reported state is judged by, whose runtime answers for a handle, and how long a handle the runtime has stopped reporting is left alone. */
export type ReconcileOptions = LivenessOptions & { graceMs?: number;
  /** This host: a handle another host launched is not judged against this host's runtime listing. */
  hostId?: string | null;
  /** When each handle the runtime had stopped reporting was first missed, as the previous sweep left it. */
  missing?: Record<string, string> };
export interface SessionSweep {
  /** Every running handle on the graph that is over, with the outcome it is closed with. */
  closures: SessionClosure[];
  /**
   * The handles this runtime did not report, each carrying when it was first missed — the next
   * sweep's `missing`. A vanished handle is closed only once the runtime has failed to report it
   * for the whole grace, so a single listing that comes back short closes nothing; an entry
   * survives its closure, so a write-back that failed is retried on the next tick rather than
   * starting the grace again.
   */
  missing: Record<string, string>;
}
export function reconcileSessionLiveness(all: Work[], runtime: RuntimeSession[] | null, now: Date, options: ReconcileOptions = {}): SessionSweep {
  const states = options.states ?? runtimeEndedStates, graceMs = options.graceMs ?? sessionVanishGraceMs;
  const previous = options.missing ?? {}, missing: Record<string, string> = {};
  const closures: SessionClosure[] = [];
  for (const work of all) {
    const running = (work.sessions ?? []).filter(handle => handle.state === 'running');
    const closed = new Set<string>();
    const close = (handle: SessionHandle, cause: ClosureCause, outcome: string) => {
      closed.add(handle.id);
      closures.push({ workId: work.id, key: work.key, id: handle.id, kind: handle.kind, role: sessionRole(handle), runtime: handle.runtime, host: handle.host, subject: handle.subject, cause, outcome: outcome.slice(0, 500) });
    };
    for (const handle of running) {
      // The item first: a session bound to a head that merged, was superseded or went back to a
      // worker is over whether or not its runtime still lists it, and why it is over is what is
      // worth recording — the runtime would only ever say it vanished.
      const superseded = supersededSession(work, handle, now);
      if (superseded) { close(handle, 'superseded', `superseded: ${superseded}`); continue; }
      const liveness = sessionLiveness(handle, runtime, states, options.hostId);
      if (liveness !== 'vanished' && liveness !== 'ended') continue;
      const since = Date.parse(handle.updatedAt), idleMs = Number.isFinite(since) ? now.getTime() - since : 0;
      const where = handle.pane ? `pane ${handle.pane}` : `session ${handle.agentName}`;
      if (liveness === 'ended') {
        // The runtime says so itself, in its own vocabulary; the grace still covers a handle
        // recorded moments ago against a stale listing.
        if (idleMs < graceMs) continue;
        close(handle, 'ended', `the ${handle.runtime} runtime on ${handle.host} reports ${where} as ${runtimeSessionOf(handle, runtime ?? [])?.agent_status ?? 'ended'}, so the session is over`);
        continue;
      }
      // Absence is weaker evidence than a reported state, so it must persist: the runtime has to
      // have failed to report the session for the whole grace, counted from the first sweep that
      // missed it, and the handle has to be older than the grace too — a session recorded at
      // launch appears in its runtime's inventory a moment later. One short listing closes nothing.
      const key = sessionHandleKey(work.id, handle.id);
      const first = Date.parse(previous[key] ?? '');
      const firstMissedAt = Number.isFinite(first) ? Math.min(first, now.getTime()) : now.getTime();
      missing[key] = new Date(firstMissedAt).toISOString();
      const missingMs = now.getTime() - firstMissedAt;
      if (idleMs < graceMs || missingMs < graceMs) continue;
      close(handle, 'vanished', `vanished: the ${handle.runtime} runtime on ${handle.host} has not reported ${where} for ${Math.round(missingMs / 1000)}s, ${Math.round(idleMs / 1000)}s after its last observed activity at ${handle.updatedAt}`);
    }
    // One slot, one live session: a second review or proof session for the same role and head
    // supersedes the ones before it, so a relaunch under a fresh id never leaves two standing. An
    // implementation session is not collapsed here any more than it is superseded above — its
    // lease is what says which attempt may still act, and two handles under one epoch are the
    // worker's own record of its sessions.
    const slots = new Map<string, SessionHandle[]>();
    for (const handle of running) {
      if (closed.has(handle.id) || !handle.head || (handle.kind !== 'review' && handle.kind !== 'proof')) continue;
      const slot = `${sessionRole(handle)}\u0000${handle.head}`;
      slots.set(slot, [...slots.get(slot) ?? [], handle]);
    }
    for (const [, slot] of slots) {
      if (slot.length < 2) continue;
      const newest = slot.reduce((latest, handle) => Date.parse(handle.startedAt) >= Date.parse(latest.startedAt) ? handle : latest);
      for (const handle of slot) if (handle !== newest)
        close(handle, 'duplicate', `superseded: session ${newest.id} holds the same role (${sessionRole(handle)}) on head ${handle.head!.slice(0, 12)}, and one item holds one live session per role and head`);
    }
  }
  return { closures, missing };
}
/** What a closure is written back as: the handle's own identity, ended, carrying why — and, for one the session report closed, the observation that closed it. */
export function closureHandle(closure: SessionClosure): SessionHandleInput {
  return { id: closure.id, kind: closure.kind, runtime: closure.runtime, host: closure.host, subject: closure.subject, state: 'finished', outcome: closure.outcome,
    ...(closure.report ? reportedHandle(closure.report) : {}) };
}
/**
 * A record the session report closed, as a closure: `ended` when the runtime reports the session
 * over or its pane holds no agent, and `vanished` — the report's `lost` — when it was absent from
 * consecutive reports.
 */
export function reportClosure(entry: SessionReportEntry): SessionClosure {
  return { workId: entry.workId, key: entry.key, id: entry.id, kind: entry.kind, role: entry.role, runtime: entry.runtime, host: entry.host, subject: entry.subject,
    cause: entry.closed === 'lost' ? 'vanished' : 'ended', outcome: (entry.outcome ?? '').slice(0, 500), report: entry };
}

/**
 * Herdr's listing as the session report reads it. Herdr names the agent it detects in each pane
 * and leaves the field out for a pane with none — a shell, where an agent that exited leaves its
 * named pane behind, still reported `idle`. That absence is the fact the report needs (a dead
 * worker otherwise stays "Builds code" for as long as its pane stays open), so it is made explicit.
 */
export const herdrSessionListing = (agents: HerdrAgent[]): HerdrAgent[] => agents.map(entry => ({ ...entry, agent: entry.agent || null }));

export interface DispatchLaunch { kind: 'review' | 'producer'; work: string; requestId: string; sha: string; profile: string; group?: string; proofs?: string[]; failover?: string[]; relaunched?: boolean; reason?: string }
export interface DispatchWait { kind: 'review' | 'producer'; work: string; requestId: string; sha: string; reason: string; group?: string }
export interface DispatchTick { at: string; launched: DispatchLaunch[]; refused: (DispatchFailure & { requestId: string })[]; waiting: DispatchWait[]; skipped: number;
  /** Session records this tick reconciled against the runtime, and the ones whose closure could not be written back. */
  closed: SessionClosure[]; closeFailures: { work: string; id: string; reason: string }[];
  /** The session report (GY-172): how many sessions this tick observed, how many records it wrote, and the writes that failed. */
  sessions?: { observed: number; written: number; failures: { work: string; id: string; reason: string }[] };
  /** Review threads this tick resolved on an approval's word, and the ones it named but could not resolve. */
  threads?: string[];
  /** Where the tick's time went: every step it ran and its slowest external calls (GY-377). */
  timings?: TimingReport }

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const retryDelay = (attempts: number) => Math.min(dispatchRetryMinMs * 2 ** Math.max(0, attempts - 1), dispatchRetryMaxMs);

/**
 * Launch on the first profile that can: a profile none of whose agent accounts is logged in with
 * quota left is skipped for the next, with its reason kept for the tick, and a session whose runtime
 * never accepted its prompt (the launcher closed it) is launched once more before the request is
 * refused. A session that exited at launch on its provider's limit notice is handed to
 * `exhaustedAtLaunch`, which holds the account, and the same profile launches again on its next
 * account; a profile with no account left then fails over through `selectAccount`'s refusal like
 * any other. Any other refusal stops at the profile that raised it.
 */
async function launchWithFailover<P extends { name: string }>(profiles: P[], launch: (profile: P) => Promise<unknown>, exhaustedAtLaunch?: (profile: P, exit: InstantExit) => Promise<string>) {
  const failover: string[] = [];
  // Whether every profile so far was passed over for spent quota alone. A logged-out account or an
  // unconfigured environment also fails over, but it is a fault a master can fix now, so it must
  // not turn the role's launches into a wait for a provider reset (GY-89).
  let capacity = true;
  // The registry's refusal when a profile was passed over because its role is at its concurrency
  // limit (GY-205), and whether every other pass-over was a wait too (spent quota, no free slot).
  let full: string | null = null, waiting = true;
  for (const profile of profiles) {
    let dropped = false, exits = 0;
    for (;;) {
      try { return { profile, failover, relaunched: dropped, result: await launch(profile) }; }
      catch (error: any) {
        if (error?.promptDropped && !dropped) { dropped = true; continue; }
        if (error?.instantExit?.notice && exhaustedAtLaunch && exits < instantExitRelaunchLimit) { exits++; failover.push(await exhaustedAtLaunch(profile, error.instantExit)); continue; }
        if (error?.accountsExhausted) {
          failover.push(`${profile.name}: ${message(error)}`); capacity &&= !!error.capacityExhausted;
          const refusal = capacityRefusal(error);
          if (refusal) full ??= refusal; else waiting &&= !!error.capacityExhausted;
          break;
        }
        throw error;
      }
    }
  }
  // `accountsExhausted` still means only that every profile was passed over; `capacityExhausted`
  // means the role has no quota left, which is the one case that waits rather than refuses; and
  // `roleAtCapacity` means the registry had no free slot for the role, which waits for one to free.
  throw Object.assign(new Error(failover.join('; ') || 'no profile could launch'), { accountsExhausted: failover.length > 0, capacityExhausted: failover.length > 0 && capacity, ...(full && waiting ? { roleAtCapacity: full } : {}) });
}

/**
 * One tick: settle the sessions the ledgers hold against the snapshot, then launch a session for
 * every open request that has none. Each launch is recorded by the launcher's own ledger before
 * the tick moves on, so a kill between two launches leaves nothing to repeat.
 */
export async function runDispatchTick(config: MasterConfig, cursor: DispatchCursor, effects: DispatchEffects, now: () => number = Date.now, readTimeoutMs = dispatchReadTimeoutMs, botReadTimeoutMs = botReviewReadTimeoutMs): Promise<DispatchTick> {
  // Every step of the tick is timed, and its external calls are recorded against it rather than
  // against the cycle running beside it in the same process (GY-377).
  const timings = new Timings(now);
  const tick = await withTimings(timings, () => dispatchTick(config, cursor, effects, now, readTimeoutMs, botReadTimeoutMs, timings));
  tick.timings = timings.report();
  return tick;
}

async function dispatchTick(config: MasterConfig, cursor: DispatchCursor, effects: DispatchEffects, now: () => number, readTimeoutMs: number, botReadTimeoutMs: number, timings: Timings): Promise<DispatchTick> {
  const snapshot = await timings.step('snapshot', () => boundedRead(effects.snapshot, readTimeoutMs));
  const observedAt = snapshot.now;
  const clock = Number.isFinite(Date.parse(observedAt)) ? Date.parse(observedAt) : now();
  const tick: DispatchTick = { at: new Date(clock).toISOString(), launched: [], refused: [], waiting: [], skipped: 0, closed: [], closeFailures: [] };
  const herdr = await timings.step('herdr', () => effects.agents());
  const { reviews, threads } = await timings.step('reconcile reviews', () => effects.reconcileReviews(snapshot.work, herdr));
  if (threads?.length) tick.threads = threads;
  const { producers } = await timings.step('reconcile producers', () => effects.reconcileProducers(snapshot.work, herdr));
  // Session liveness, swept on this same bounded interval (GY-113): a session that died reports
  // nothing, so nothing but a sweep ever contradicts a record that says it is running. The judgment
  // is made before anything launches, because the slot check below reads it.
  // The item's own facts first — a review or proof session bound to something the item moved past,
  // or a second session in one slot. The runtime is not consulted here: what the runtime says is
  // the session report below, the one observation every reader shares (GY-172).
  const sweep = reconcileSessionLiveness(snapshot.work, null, new Date(clock), { states: runtimeEndedStates, hostId: config.hostId });
  const superseded = new Set(sweep.closures.map(closure => sessionHandleKey(closure.workId, closure.id)));
  const report = observeSessions(snapshot.work, herdr, new Date(clock), { states: runtimeEndedStates, hostId: config.hostId, settled: superseded, firstMissed: cursor.sessionMisses });
  const closures = [...sweep.closures, ...report.entries.filter(entry => entry.closed).map(reportClosure)];
  // What the runtime did not report this tick, for the closing reason to say how long. The map
  // holds only handles currently missing, so it is bounded by the graph's live sessions; the
  // ceiling is there because the cursor is a file, not a database.
  // A tick that could not read the runtime reported nothing, so it leaves them as they were.
  if (herdr) cursor.sessionMisses = Object.fromEntries(Object.entries(report.missing).slice(0, sessionMissLimit));
  const byId = new Map(snapshot.work.map(item => [item.id, item]));
  const sessions = tick.sessions = { observed: report.entries.length, written: 0, failures: [] as { work: string; id: string; reason: string }[] };
  await timings.step('sessions', async () => {
    for (const entry of report.entries.filter(entry => !entry.closed && entry.changed)) {
      const item = byId.get(entry.workId);
      // A delivered item takes the observation too (engine.ts): a session that outlives the delivery
      // is still one every reader shows, so its record is kept as fresh as any other.
      if (!item || !effects.recordSession) continue;
      // The observation is the record every reader shows; one that could not be written is
      // retried by the next tick's report, which finds the stored record still behind.
      try { await effects.recordSession(item, reportedHandle(entry)); sessions.written++; }
      catch (error) { sessions.failures.push({ work: entry.key, id: entry.id, reason: bounded(message(error), closureFailureReasonLimit) }); }
    }
    for (const closure of closures) {
      // A closure that cannot be written back still stands as a judgment — the session is over
      // whichever way the record went — so the slot is freed either way and the tick says what failed.
      try { await effects.endSession?.(closure); tick.closed.push(closure); }
      catch (error) { tick.closeFailures.push({ work: closure.key, id: closure.id, reason: bounded(message(error), closureFailureReasonLimit) }); }
    }
  });
  const settledHandles = new Set(closures.map(closure => sessionHandleKey(closure.workId, closure.id)));
  // Herdr unreadable: nothing is launched, because a launch needs the agent inventory to count
  // each profile's sessions against its limit; the requests wait and the tick says so.
  const agents = herdr ?? [];
  const credentials = await timings.step('credentials', () => effects.credentials(config.producers));
  // A host below its memory floor launches nothing new (GY-612): every request that would launch
  // waits with the reason, and launches on the first tick after memory recovers.
  const memory = effects.hostMemory ? await timings.step('memory', () => effects.hostMemory!().catch(() => null)) : null;
  const memoryHold = memory ? judgeHostMemory(null, memory, clock, config.hostId) : null;
  const memoryDeferred = memoryHold?.state.low ? memoryDeferral(memoryHold.state) : null;
  // The sessions this tick has started join the inventory at once, so two requests in one tick
  // never both take a profile's last slot. A launcher that does not report its session name is
  // counted under the name it would have chosen for the request.
  const started: { name: string }[] = [];
  const inventory = () => [...agents, ...started];
  const launchedName = (profile: { agentName: string; concurrency?: number }, request: DispatchRequest, result: unknown) =>
    typeof (result as { agentName?: unknown })?.agentName === 'string' ? (result as { agentName: string }).agentName : sessionAgentName(profile, { id: request.id, requestId: request.id });
  // Registration (GY-172 AC-2): the recorder every launch below registers through, and the
  // coordinates a launcher's result carries once its runtime has started.
  const record = (item: Work) => effects.recordSession ? (handle: SessionHandleInput) => effects.recordSession!(item, handle) : undefined;
  const coordinates = (profile: { agentName: string; concurrency?: number }, request: DispatchRequest, result: unknown) => ({ pane: (result as { pane?: string | null } | undefined)?.pane ?? null, agentName: launchedName(profile, request, result) });
  const attachTo = (pane: string) => `herdr pane attach ${pane}${config.herdrWorkspace ? ` --workspace ${config.herdrWorkspace}` : ''}`;
  /**
   * The slots recorded sessions still hold. A handle is the durable record of a live session, so a
   * session this host has not listed yet — or one another host launched — holds its profile's slot
   * as surely as a listed pane does, and the record outlives a restart of this loop. A session the
   * sweep above judged over holds nothing: that is what makes a name busy only while a live session
   * has it, rather than until somebody ends the record by hand (GY-113 AC-2).
   */
  const held = () => snapshot.work.flatMap(item => (item.sessions ?? [])
    .filter(handle => handle.state === 'running' && !!handle.agentName && !settledHandles.has(sessionHandleKey(item.id, handle.id)))
    .map(handle => ({ name: handle.agentName! })));
  // The launchers still see the runtime's own inventory unfiltered: a name the runtime lists at all
  // cannot be taken again, whatever state it is in, and that check is theirs to make.
  const room = (profile: ReviewerProfile | ProducerProfile, records: { profile: string; agentName: string; state: string }[]) => profileSessions(profile, [...inventory(), ...held()], records);
  const atLimit = (profile: ReviewerProfile | ProducerProfile, records: { profile: string; agentName: string; state: string }[]) => { const sessions = room(profile, records); return `${profile.name}: at its concurrency limit (${sessions.running.length} running, limit ${sessions.limit})`; };
  const wait = (kind: 'review' | 'producer', item: Work, request: DispatchRequest, reason: string) => tick.waiting.push({ kind, work: item.key, requestId: request.id, sha: request.sha, reason, ...(request.group ? { group: request.group } : {}) });
  const refuse = (kind: 'review' | 'producer', item: Work, request: DispatchRequest, error: unknown) => {
    const previous = cursor.failures[request.id];
    const attempts = (previous?.attempts ?? 0) + 1;
    // Bounded below the cursor's cap: the wait sentence that wraps it on later ticks must fit too.
    const failure: DispatchFailure = { kind, work: item.key, sha: request.sha, attempts, reason: bounded(message(error), dispatchFailureReasonLimit), at: new Date(now()).toISOString(), nextAt: new Date(now() + retryDelay(attempts)).toISOString() };
    cursor.failures[request.id] = failure;
    // A refusal is the role answering with something other than spent quota, so any hold the
    // previous tick armed is stale: withdraw it rather than let the summary keep reporting a
    // provider reset beside the failure a master can fix now.
    delete cursor.capacity[kind];
    tick.refused.push({ ...failure, requestId: request.id });
  };
  // A role out of capacity is not launched again until its accounts are due to be read, and the
  // wait is never a failure: nothing is counted, and the request launches when an account returns.
  const spent = (kind: 'review' | 'producer') => { const hold = cursor.capacity[kind]; return hold && Date.parse(hold.recheckAt) > now() ? hold : null; };
  const capacityWait = (kind: 'review' | 'producer') => `${kind === 'review' ? 'reviewer' : 'producer'} capacity is exhausted (${cursor.capacity[kind]!.reason}); launches are paused and its accounts are read again at ${cursor.capacity[kind]!.recheckAt}`;
  const outOfCapacity = (kind: 'review' | 'producer', item: Work, request: DispatchRequest, error: unknown) => {
    // A role at its registry concurrency limit waits for a slot (GY-205), as an approver does: the
    // refusal is not counted against the request and arms no quota hold, so the launch is made again
    // on the first tick after the registry ends a session of the role.
    const full = capacityRefusal(error);
    if (full) { delete cursor.failures[request.id]; wait(kind, item, request, `waits for a ${kind === 'review' ? 'reviewer' : 'producer'} slot, launched on the first tick one frees: ${full}`); return true; }
    if (!(error as { capacityExhausted?: boolean })?.capacityExhausted) return false;
    cursor.capacity[kind] = { at: cursor.capacity[kind]?.at ?? new Date(now()).toISOString(), recheckAt: new Date(now() + capacityRecheckMs).toISOString(), reason: bounded(message(error), capacityReasonLimit) };
    delete cursor.failures[request.id];
    wait(kind, item, request, capacityWait(kind));
    return true;
  };
  // The tick's reasons, in the order they are stored, each with the request it was composed for:
  // a persist that fails on one of them is attributed to that request rather than to the tick.
  const composed = () => {
    const reasons = new Map<string, DispatchWait>();
    for (const entry of tick.waiting) { const reason = bounded(`${entry.kind} for ${entry.work} ${entry.sha.slice(0, 12)}: ${entry.reason}`, cursorTextLimit); if (!reasons.has(reason)) reasons.set(reason, entry); }
    return [...reasons.entries()].slice(0, 20);
  };
  // One write at a time: a deferred reviewer launches beside the producer pass, and two writes of
  // the cursor racing each other could land the older state last.
  let persisting: Promise<unknown> = Promise.resolve();
  const persist = () => {
    const write = persisting.then(async () => { try { await effects.persist(cursor); } catch (error) { throw attributePersistFailure(error, cursor, composed().map(([, entry]) => entry)); } });
    persisting = write.catch(() => { /* the caller that wrote it sees the failure */ });
    return write;
  };
  // The failover for a session that exited at launch on its provider's limit notice: the account
  // the launcher selected is held until the reset the notice named, the exhaustion goes on the
  // item's record as a mid-session one would, and the caller launches the profile's next account.
  const exhaustedAtLaunch = (kind: 'review' | 'producer', item: Work, request: DispatchRequest) => async (profile: { name: string; kind?: string }, exit: InstantExit): Promise<string> => {
    const role = kind === 'review' ? 'reviewer' : 'producer', notice = exit.notice!;
    const selected = await effects.selectedAccount?.(role, profile.name).catch(() => null) ?? null;
    const account = selected?.environment ?? null;
    const held = await effects.holdAccount!(account ?? profileAccount(profile.name), { at: new Date(now()).toISOString(), resetsAt: notice.resetsAt, reason: notice.reason, role, profile: profile.name, work: item.key });
    await effects.reportCapacity?.(item, { event: 'exhausted', role, requestId: request.id, profile: profile.name, account, runtime: selected?.kind ?? profile.kind ?? null, reason: notice.reason, resetsAt: notice.resetsAt,
      partialWork: { state: 'not-applicable', detail: 'the session exited at launch on the provider limit notice: it read nothing and edited nothing' } }).catch(() => { /* the hold stands; a record the control plane refused is not a failed failover */ });
    return `${profile.name}: ${account ?? `${profile.name}'s own account`} exited at launch on its provider's limit notice (${notice.reason}); held ${notice.resetsAt ? `until it resets ${notice.resetsAt}` : held && 'until' in held && held.until ? `until ${held.until}` : 'for its reset'}`;
  };
  const retryable = (request: DispatchRequest) => { const failure = cursor.failures[request.id]; return !failure || failure.attempts < dispatchFailureLimit && Date.parse(failure.nextAt) <= now(); };
  // A request whose automatic sessions all ended unanswered is left to the master, once, naming
  // every attempt; the wait says no further attempt follows, and status raises the attention item.
  const abandon = (kind: 'review' | 'producer', item: Work, request: DispatchRequest, records: DispatchedSession[], why: string) => {
    if (!cursor.abandoned[request.id]) cursor.abandoned[request.id] = { kind, work: item.key, sha: request.sha, at: new Date(now()).toISOString(), reason: bounded(why, dispatchFailureReasonLimit), attempts: describeAttempts(records, request.id) };
    wait(kind, item, request, `${why}; no further automatic attempt, raised as attention for the master`);
  };
  // Whether the request already has its session, waits to relaunch one that ended, or may launch now.
  const session = (kind: 'review' | 'producer', item: Work, request: DispatchRequest, records: DispatchedSession[]) => {
    const retry = sessionRetry(records, request.id, now());
    const role = kind === 'review' ? 'reviewer' : 'producer';
    if (retry.settled) {
      if (!retry.last || retry.last.state === 'pending') { tick.skipped++; return false; }
      // A session that settled while its request still stands for the same head answered nothing
      // the gates accept (GY-193): the next attempt launches on this tick, on another profile first,
      // up to the dispatch failure limit. Only a verdict the control plane may not have read yet is
      // waited on first, since a second verdict on one request is withheld together with the first.
      const last = requestSessions(records, request.id).at(-1)!;
      const settledAt = Date.parse(last.closedAt ?? last.requestedAt);
      const settled = `${role} session attempt ${retry.attempts} ${last.state} without satisfying the request: ${last.resolution ?? 'no reason recorded'}`;
      if (kind === 'review' && last.verdict && last.verdict.state !== 'DISMISSED' && now() - settledAt < verdictIngestGraceMs) {
        tick.skipped++;
        wait(kind, item, request, `${role} session attempt ${retry.attempts} posted ${last.verdict.state}; the control plane is given until ${new Date(settledAt + verdictIngestGraceMs).toISOString()} to read it before another attempt`);
        return false;
      }
      if (retry.attempts >= dispatchFailureLimit) { tick.skipped++; abandon(kind, item, request, records, `${settled}, after ${retry.attempts} sessions`); return false; }
      return true;
    }
    if (retry.launch) return true;
    const last = `${role} session attempt ${retry.attempts} ${retry.last!.state}: ${retry.last!.resolution ?? 'no reason recorded'}`;
    if (retry.exhausted) { abandon(kind, item, request, records, `${last}; ${retry.attempts} sessions failed or expired`); return false; }
    // A reviewer that judged the head and was reminded to post, and still posted nothing within the
    // bound, is relaunched now (GY-193 AC-2): the wait was the reminder's, already served.
    const ended = requestSessions(records, request.id).at(-1);
    if (kind === 'review' && ended?.acknowledgedAt && !ended.verdict && unpostedVerdict.test(ended.resolution ?? '')) return true;
    wait(kind, item, request, `${last}; attempt ${retry.attempts + 1} of ${retry.limit} at ${retry.nextAt}`);
    return false;
  };
  // A reviewer launched before the repository's automatic bot reviewers have spoken approves a head
  // whose bot findings arrive minutes later as unresolved threads, and each costs a rework round.
  // The launch waits for them, up to `awaitReviewersMinutes` from the request, then goes ahead: a
  // bot with nothing to say posts no review at all. A failed read does not hold the launch: the
  // review goes ahead as it did before the wait existed, rather than stalling on GitHub.
  // The reads start together, before any launch, and share one deadline: however many items wait
  // and however slowly GitHub answers, the tick is held at most `botReadTimeoutMs` in all, and an
  // unanswered read is a failed one.
  const awaited = config.run.awaitReviewers ?? defaultAwaitReviewers.logins, minutes = config.run.awaitReviewersMinutes ?? defaultAwaitReviewers.minutes;
  const waitUntil = (review: DispatchRequest) => Date.parse(review.requestedAt) + minutes * 60_000;
  const botReads = new Map<string, Promise<string[] | null>>();
  // A bot that has announced its quota is spent posts no review until it returns (GY-349): its
  // activity is read once, beside the head reads and under the same deadline, and a launch does
  // not wait for an exhausted bot. A failed read keeps the last judgment the cursor holds.
  let botStates: Promise<BotReviewerState[]> = Promise.resolve(cursor.botReviewers);
  // The launch reasons of reviews that skipped an exhausted bot's wait, by request id.
  const skippedWaits = new Map<string, string>();
  if (awaited.length && minutes > 0 && effects.headReviewers) {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), botReadTimeoutMs); timer.unref?.(); });
    const waiting: DispatchRequest[] = [];
    for (const item of snapshot.work.filter(work => work.stage !== 'done' && work.autoDispatch)) {
      const review = item.autoDispatch!.review;
      if (review?.state !== 'requested' || review.provider !== 'github' || !(now() < waitUntil(review))) continue;
      const read = effects.headReviewers(item, review).then(logins => logins.map(login => login.toLowerCase()), () => null);
      botReads.set(review.id, Promise.race([read, deadline]));
      waiting.push(review);
    }
    if (waiting.length && effects.botActivity) {
      const held = cursor.botReviewers.map(({ login, state, since }) => ({ login, state, since }));
      const activity = Promise.race([effects.botActivity([...awaited], waiting, held).catch(() => null), deadline]);
      botStates = activity.then(entries => {
        if (entries) cursor.botReviewers = botReviewerStates(awaited, entries, held).slice(0, 10).map(bot => ({ ...bot, checkedAt: new Date(now()).toISOString() }));
        return cursor.botReviewers;
      });
    }
    const reads = [...botReads.values(), botStates];
    if (botReads.size) void Promise.allSettled(reads).then(() => clearTimeout(timer)); else clearTimeout(timer);
  }
  const awaitingBotReview = async (item: Work, review: DispatchRequest) => {
    const read = botReads.get(review.id);
    if (!read) return false;
    const until = waitUntil(review);
    if (now() >= until) return false;
    const seen = await read;
    if (!seen) return false;
    const exhausted = new Map((await botStates).filter(bot => bot.state === 'exhausted').map(bot => [bot.login.toLowerCase(), bot]));
    const missing = awaited.filter(login => !seen.includes(login.toLowerCase()));
    const skipped = missing.filter(login => exhausted.has(login.toLowerCase())).map(login => `skipped: ${login} exhausted since ${exhausted.get(login.toLowerCase())!.since}`).join('; ');
    const waitingOn = missing.filter(login => !exhausted.has(login.toLowerCase()));
    if (!waitingOn.length) { if (skipped) skippedWaits.set(review.id, `awaited-reviewer wait ${skipped}`); return false; }
    wait('review', item, review, `review of ${item.key} at ${review.sha.slice(0, 12)} waits up to ${minutes} min (until ${new Date(until).toISOString()}) for ${waitingOn.join(', ')}'s review of the head, so its findings are judged in the same round${skipped ? `; ${skipped}` : ''}`);
    return true;
  };
  // A reviewer with a bot read is decided the moment that read settles, beside the producer pass
  // rather than in it: the wait on that read is the reviewer's alone, so no producer request, on
  // its item or a later one, is held behind it, and a read that settles at once launches its
  // reviewer without waiting behind the producer starts ahead of it in the pass. Reviewer launches
  // take turns with each other, so two of them never both count the same free reviewer slot, and
  // with a producer launch only over an agent name both profiles use.
  let reviewTurn: Promise<unknown> = Promise.resolve();
  // A reviewer launching beside the producer pass must still never take a Herdr name a producer
  // launch is taking: both read the tick's inventory, and a name joins it only once its launch
  // returns. A launch holds the agent name of the one profile it is launching on until that name is
  // in the inventory, and takes a failover profile's name only when failover reaches it, so a launch
  // never waits on a name it would not have used.
  const nameTurns = new Map<string, Promise<unknown>>();
  const reserveName = <T>(name: string, launch: () => Promise<T>): Promise<T> => {
    const turn = (nameTurns.get(name) ?? Promise.resolve()).then(launch);
    nameTurns.set(name, turn.catch(() => { /* the launcher sees the failure */ }));
    return turn;
  };
  // Launch over `profiles` in order, each in its own name's turn. Room is read again once the name
  // is this launch's: the launch it waited on may have just taken the last slot of that name, and a
  // profile left without room is passed over like one without quota. A launch every profile of which
  // lost its room meanwhile is a capacity wait (null), not a failure.
  const launchInTurns = async <P extends ReviewerProfile | ProducerProfile>(request: DispatchRequest, profiles: P[], hasRoom: (profile: P) => boolean, launch: (profile: P) => Promise<unknown>, exhausted?: (profile: P, exit: InstantExit) => Promise<string>) => {
    let passed = 0;
    try {
      return await launchWithFailover(profiles, profile => reserveName(profile.agentName, async () => {
        if (!hasRoom(profile)) { passed++; throw Object.assign(new Error(`${profile.agentName} has no free slot`), { accountsExhausted: true, capacityExhausted: true }); }
        const result = await launch(profile);
        started.push({ name: launchedName(profile, request, result) });
        return result;
      }), exhausted);
    } catch (error) {
      if (passed === profiles.length && (error as { accountsExhausted?: boolean })?.accountsExhausted) return null;
      throw error;
    }
  };
  const inReviewTurn = (item: Work, review: DispatchRequest) => {
    const turn = reviewTurn.then(() => dispatchReview(item, review));
    reviewTurn = turn.catch(() => { /* the caller of this turn sees the failure */ });
    return turn;
  };
  const dispatchReview = async (item: Work, review: DispatchRequest) => {
    if (!session('review', item, review, reviews)) { /* settled, or waiting to relaunch */ }
    else if (!herdr) wait('review', item, review, 'Herdr session inventory is unavailable');
    else if (memoryDeferred) wait('review', item, review, memoryDeferred);
    else if (spent('review')) wait('review', item, review, capacityWait('review'));
    else if (!retryable(review)) wait('review', item, review, `launch refused ${cursor.failures[review.id].attempts} time(s): ${cursor.failures[review.id].reason}; ${cursor.failures[review.id].attempts >= dispatchFailureLimit ? 'no further automatic attempt, launch it with master review once the cause is fixed' : `next attempt at ${cursor.failures[review.id].nextAt}`}`);
    else {
      const { profile, reason } = selectReviewerProfile(config);
      // The selected profile answers; the other reviewer profiles are its failover when none of
      // its accounts can launch. A profile with no slot left is passed over for one with room,
      // and a request no profile has room for waits on the limit it names.
      const candidates = profile ? [profile, ...config.reviewers.filter(other => other.name !== profile.name)] : [];
      const withRoom = () => preferFreshProfiles(candidates.filter(candidate => room(candidate, reviews).free > 0), reviews, review.id);
      const busy = () => wait('review', item, review, `every reviewer profile is busy: ${candidates.map(candidate => atLimit(candidate, reviews)).join('; ')}; raise concurrency in .graphyard/master.json or add a reviewer profile`);
      if (!profile) wait('review', item, review, reason!);
      else if (!withRoom().length) busy();
      else if (await awaitingBotReview(item, review)) { /* waiting on an automatic bot reviewer, bounded */ }
      else {
        try {
          // The session is registered before its runtime starts and its coordinates written once it
          // has (GY-172), where every Graphyard reader looks — so watching this reviewer never means
          // reading this host's local ledger, and the session report observes it from the start.
          const launched = await launchInTurns(review, withRoom(), candidate => room(candidate, reviews).free > 0, candidate => registeredLaunch(record(item),
            launchedSessionHandle('review', review, `${item.key}: review ${review.sha.slice(0, 12)} (PR #${review.pr})`, config.hostId, undefined, candidate.kind, config.herdrWorkspace),
            () => effects.launchReview(item, review, candidate, inventory(), observedAt), result => coordinates(candidate, review, result), attachTo), effects.holdAccount ? exhaustedAtLaunch('review', item, review) : undefined);
          if (!launched) busy();
          else {
            delete cursor.failures[review.id]; delete cursor.capacity.review;
            tick.launched.push({ kind: 'review', work: item.key, requestId: review.id, sha: review.sha, profile: launched.profile.name, ...(launched.failover.length ? { failover: launched.failover } : {}), ...(launched.relaunched ? { relaunched: true } : {}), ...(skippedWaits.has(review.id) ? { reason: skippedWaits.get(review.id) } : {}) });
          }
        } catch (error) { if (!outOfCapacity('review', item, review, error)) refuse('review', item, review, error); }
        await persist();
      }
    }
  };
  // Settled into a value, so a failure is rethrown once the pass ends and never left unhandled; a
  // pass that fails still waits for these reviewers, so none is left launching into the next tick.
  const deferred = snapshot.work.filter(work => work.stage !== 'done' && botReads.has(work.autoDispatch?.review?.id ?? ''))
    .map(item => botReads.get(item.autoDispatch!.review!.id)!.then(() => inReviewTurn(item, item.autoDispatch!.review!)).then(() => null, (error: unknown) => ({ error })));
  // Producer launches that could not take the same profile run at once (GY-377), so the pass is
  // bounded by the profiles' capacity and not by the sum of every launch's duration. Requests that
  // could take the same profile keep the pass's order: each waits for the earlier ones on any agent
  // name it could launch under, failover included, and then reads its room as a serial pass would.
  const producerLaunches: Promise<{ error: unknown } | null>[] = [];
  const producerTurns = new Map<string, Promise<unknown>>();
  const afterEarlier = (names: string[], launch: () => Promise<void>) => {
    const earlier = [...new Set(names)].map(name => producerTurns.get(name)).filter(Boolean);
    const turn = Promise.allSettled(earlier).then(launch);
    for (const name of names) producerTurns.set(name, turn.catch(() => { /* the launch reports its own failure */ }));
    return turn;
  };
  let outcomes: ({ error: unknown } | null)[] = [];
  await timings.step('launches', async () => {
    try {
      for (const item of snapshot.work.filter(work => work.stage !== 'done' && work.autoDispatch)) {
        const review = item.autoDispatch!.review;
        if (review?.state === 'requested' && review.provider === 'github' && !botReads.has(review.id)) await inReviewTurn(item, review);
        for (const request of item.autoDispatch!.producers.filter(entry => entry.state === 'requested')) {
          // Evidence recorded as not exercising its criterion goes back to the worker as a rework the
          // loop requests (master-daemon.ts); no producer is launched for the head again (GY-193 AC-3).
          const unexercised = unexercisedFindings(item, request.sha, request.proofs);
          if (unexercised.length) { tick.skipped++; wait('producer', item, request, `evidence does not exercise its criterion (${unexercised.map(entry => entry.proof).join(', ')}); the head returns to its worker through a rework decision, and no producer is launched for it again`); continue; }
          if (!session('producer', item, request, producers)) continue;
          if (!herdr) { wait('producer', item, request, 'Herdr session inventory is unavailable'); continue; }
          if (memoryDeferred) { wait('producer', item, request, memoryDeferred); continue; }
          if (spent('producer')) { wait('producer', item, request, capacityWait('producer')); continue; }
          if (!retryable(request)) { wait('producer', item, request, `launch refused ${cursor.failures[request.id].attempts} time(s): ${cursor.failures[request.id].reason}; ${cursor.failures[request.id].attempts >= dispatchFailureLimit ? 'no further automatic attempt' : `next attempt at ${cursor.failures[request.id].nextAt}`}`); continue; }
          // Independence is per item, never per process: a profile whose principal held an assignment
          // on this item is skipped for this item however many slots it has, and the launcher selects
          // among the rest up to each one's concurrency.
          const independent = independentProducerProfiles(item, config.producers);
          const available = independent.filter(profile => credentials[profile.name]?.available !== false);
          const usable = () => preferFreshProfiles(available.filter(profile => room(profile, producers).free > 0), producers, request.id);
          const busy = () => wait('producer', item, request, !config.producers.length ? 'no producer profile is configured; add one with master producer add'
            : !independent.length ? `every producer principal (${config.producers.map(profile => profile.principal).join(', ')}) has held an assignment on ${item.key}; its evidence would not be trusted`
            : `every independent producer profile is busy or unavailable (${independent.map(profile => credentials[profile.name]?.available === false ? `${profile.name}: ${credentials[profile.name].reason}` : atLimit(profile, producers)).join('; ')}); raise concurrency in .graphyard/master.json or add a producer profile`);
          if (!available.some(profile => room(profile, producers).free > 0)) { busy(); continue; }
          producerLaunches.push(afterEarlier(available.map(profile => profile.agentName), async () => {
            if (!usable().length) { busy(); return; }
            try {
              const launched = await launchInTurns(request, usable(), profile => room(profile, producers).free > 0, candidate => registeredLaunch(record(item),
                launchedSessionHandle('proof', request, `${item.key}: ${request.group} proofs on ${request.sha.slice(0, 12)} (${(request.proofs ?? []).join(', ')})`, config.hostId, undefined, candidate.kind, config.herdrWorkspace, candidate.principal),
                () => effects.launchProducer(item, request, candidate, inventory(), observedAt), result => coordinates(candidate, request, result), attachTo), effects.holdAccount ? exhaustedAtLaunch('producer', item, request) : undefined);
              if (!launched) busy();
              else {
                delete cursor.failures[request.id]; delete cursor.capacity.producer;
                tick.launched.push({ kind: 'producer', work: item.key, requestId: request.id, sha: request.sha, profile: launched.profile.name, group: request.group, proofs: request.proofs, ...(launched.failover.length ? { failover: launched.failover } : {}), ...(launched.relaunched ? { relaunched: true } : {}) });
              }
            } catch (error) {
              // An executor's session already answering this head is waited on, not refused (GY-415).
              const pending = answeredByPendingSession(error, request);
              if (pending) wait('producer', item, request, `producer session ${pending.agentName} is already pending on ${request.sha.slice(0, 12)} for the ${request.group} proofs`);
              else if (!outOfCapacity('producer', item, request, error)) refuse('producer', item, request, error);
            }
            await persist();
          }).then(() => null, (error: unknown) => ({ error })));
        }
      }
    } finally { outcomes = await Promise.all([...deferred, ...producerLaunches]); }
  });
  for (const outcome of outcomes) if (outcome) throw outcome.error;
  // A failure for a request the control plane resolved is history the cursor need not keep.
  const live = new Set(snapshot.work.flatMap(work => [...(work.autoDispatch?.review ? [work.autoDispatch.review.id] : []), ...(work.autoDispatch?.producers ?? []).map(request => request.id)]));
  for (const id of Object.keys(cursor.failures)) if (!live.has(id)) delete cursor.failures[id];
  for (const id of Object.keys(cursor.abandoned)) if (!live.has(id)) delete cursor.abandoned[id];
  cursor.ticks += 1; cursor.lastTickAt = cursor.lastSuccessAt = new Date(now()).toISOString(); cursor.consecutiveFailures = 0;
  cursor.lastTick = { at: tick.at, launched: tick.launched.length, refused: tick.refused.length, waiting: tick.waiting.length, settled: tick.skipped,
    closed: tick.closed.length, closeFailures: closeFailureReasons(tick.closeFailures),
    // A launch that skipped an exhausted bot's wait says so beside the waits (GY-349).
    reasons: [...composed().map(([reason]) => reason), ...tick.launched.filter(launch => launch.reason).map(launch => bounded(`${launch.kind} for ${launch.work} ${launch.sha.slice(0, 12)}: launched; ${launch.reason}`, cursorTextLimit))].slice(0, 20), timings: timings.report() };
  await persist();
  return tick;
}

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

async function boundedRead<T>(read: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`work snapshot read timed out after ${timeoutMs}ms`)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

/** Tick until stopped. Runs beside the daemon in `master run`; the signal is the daemon's stop. */
export async function runAutoDispatch(config: MasterConfig, cursor: DispatchCursor, effects: DispatchEffects, options: { intervalMs: number | (() => number); once?: boolean; signal?: AbortSignal; now?: () => number; log?: (line: string) => void; readTimeoutMs?: number; retryMinMs?: number;
  /** Re-reads .graphyard/master.json before each tick, so a changed profile or run setting applies without a restart. */
  reload?: () => Promise<ConfigReload> }) {
  const now = options.now ?? Date.now, log = options.log ?? (line => console.error(line));
  const ticks: DispatchTick[] = [];
  let refused: string | null = null, waiting = '', closeFailed = '';
  do {
    if (options.signal?.aborted) break;
    const interval = typeof options.intervalMs === 'function' ? options.intervalMs() : options.intervalMs;
    let wait = interval;
    // A tick that ran to its end and failed only to persist has already reset the streak and
    // stamped its success; both are restored from here, so a persist that keeps failing counts
    // as the consecutive failures it is rather than as one failure forever.
    const streak = cursor.consecutiveFailures, lastSuccessAt = cursor.lastSuccessAt;
    try {
      if (options.reload) {
        const reload = await options.reload();
        config = reload.config;
        if (reload.changed.length) log(`[graphyard-dispatch] adopted master.json changes: ${reload.changed.join(', ')}`);
        if (reload.refused && reload.refused !== refused) log(`[graphyard-dispatch] ${reload.refused}`);
        refused = reload.refused;
      }
      const tick = await runDispatchTick(config, cursor, effects, now, tickReadTimeout(cursor.consecutiveFailures, interval, options.readTimeoutMs));
      ticks.push(tick);
      // A tick that outgrew its interval says where its time went (GY-377): its slowest steps and call.
      if (tick.timings && tick.timings.totalMs > interval) log(`[graphyard-dispatch] tick took ${tick.timings.totalMs}ms against its ${interval}ms interval; ${describeTimings(tick.timings)}`);
      for (const launch of tick.launched) log(`[graphyard-dispatch] launched ${launch.kind} for ${launch.work} ${launch.sha.slice(0, 12)} on ${launch.profile}${launch.group ? ` (${launch.group}: ${launch.proofs?.join(', ')})` : ''}${launch.failover?.length ? ` after skipping ${launch.failover.join('; ')}` : ''}${launch.relaunched ? ' (relaunched after a dropped prompt)' : ''}${launch.reason ? `; ${launch.reason}` : ''}`);
      for (const refusal of tick.refused) log(`[graphyard-dispatch] ${refusal.kind} launch for ${refusal.work} refused (attempt ${refusal.attempts}): ${refusal.reason}`);
      for (const event of tick.threads ?? []) log(`[graphyard-dispatch] ${event}`);
      for (const closure of tick.closed) log(`[graphyard-dispatch] closed ${closure.role} session ${closure.id} on ${closure.key}: ${closure.outcome}`);
      // A closure that cannot be written back is retried every tick, so it is logged when it
      // starts and when it changes rather than once per tick for as long as it lasts; `master
      // status` carries the standing list under `dispatch.sessionReconcile.failures`.
      const failures = tick.closeFailures.map(failure => `${failure.work} session ${failure.id}: ${failure.reason}`).join(' | ');
      if (failures && failures !== closeFailed) log(`[graphyard-dispatch] could not close ${tick.closeFailures.length} session record(s): ${failures}`);
      closeFailed = failures;
      // A tick that launched nothing says why, once per distinct set of reasons: a request waiting
      // on a busy profile or a backoff is the dispatcher working, and silence would hide both.
      const reasons = (cursor.lastTick?.reasons ?? []).join(' | ');
      if (!tick.launched.length && !tick.refused.length && reasons && reasons !== waiting) log(`[graphyard-dispatch] ${tick.waiting.length} request(s) waiting: ${reasons}`);
      waiting = reasons;
    } catch (error) {
      // A failed tick launched nothing it has not already recorded, so it is retried promptly;
      // the cursor keeps the streak so master status can say how long dispatch has been blind,
      // and the request, item and field a persist failure was composed for, so it can say why.
      const failure = (error as { persistFailure?: PersistFailure })?.persistFailure;
      cursor.consecutiveFailures = streak + 1; cursor.lastSuccessAt = lastSuccessAt;
      cursor.lastFailure = { at: new Date(now()).toISOString(), reason: bounded(message(error), cursorTextLimit),
        ...(failure?.field ? { field: bounded(failure.field, 200) } : {}), ...(failure?.request ? { kind: failure.kind, request: failure.request, work: failure.work } : {}) };
      wait = tickRetryDelay(cursor.consecutiveFailures, interval, options.retryMinMs);
      await effects.persist(cursor).catch(() => {});
      log(`[graphyard-dispatch] tick failed (${cursor.consecutiveFailures} in a row, retrying in ${wait}ms): ${message(error)}`);
    }
    if (options.once || options.signal?.aborted) break;
    try { await delay(wait, undefined, { signal: options.signal }); } catch { /* woken to stop */ }
  } while (!options.signal?.aborted);
  return { ticks };
}

/** Effects bound to the real coordinator process; `config` may be a live source the loop reloads. */
export function dispatchEffects(root: string, config: MasterConfig | (() => MasterConfig), deps: { snapshot: () => Promise<{ work: Work[]; now: string }>; mutate?: (path: string, body: unknown, requestId?: string) => Promise<any>; run?: ChildRun; log?: (line: string) => void; now?: () => number }): DispatchEffects {
  // The dispatcher's own bounded asynchronous runner (GY-125): a `herdr agent start` that takes
  // its whole thirty seconds is awaited here, and the cycle's snapshot read beside it is served.
  // Its children and server calls are timed against the tick that made them (GY-377).
  const run = timedRun(deps.run ?? childRunner({ timeoutMs: 90_000 }));
  const current = typeof config === 'function' ? config : () => config;
  const headReviewerReads = new Map<string, { at: number; logins: string[] }>(), headReviewerInFlight = new Map<string, Promise<string[]>>();
  let botActivityRead: { key: string; at: number; activity: Promise<BotActivity[]> } | null = null;
  const log = deps.log ?? (line => console.error(line));
  // A repair is logged once per path: the same over-long string would otherwise be reported on
  // every tick that persists it, when one line naming the path is what a reader needs.
  const repaired = new Set<string>();
  const onRepair: RepairListener = repair => { if (repaired.has(repair.path)) return; repaired.add(repair.path); log(repairLine('persisting', repair)); };
  // The coordinator mutation this loop records handles with. It is built from the same
  // configuration the loop already runs on — the credential the dispatcher authenticates every
  // launch decision with — so a dispatcher records what it launched wherever it runs, rather than
  // only where a caller remembered to pass one. A caller with a mutation of its own passes it.
  const post = deps.mutate ?? (async (path: string, body: unknown, requestId: string = randomUUID()) => {
    const token = await readCredentialFile(current().credentialFile);
    const response = await fetch(`${current().url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': requestId }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : JSON.stringify(result));
    return result;
  });
  const mutate = (path: string, body: unknown, requestId?: string) => timedCall('server', serverCallName('POST', path), () => post(path, body, requestId));
  return {
    snapshot: () => timedCall('server', 'GET work-snapshot', deps.snapshot),
    agents: () => listHerdrAgents(run).then(herdrSessionListing).catch(() => null),
    credentials: profiles => inspectProducerCredentials(root, profiles),
    reconcileReviews: (work, agents) => reconcileReviews(root, current(), { run, work, agents }),
    reconcileProducers: (work, agents) => reconcileProducers(root, current(), work, agents, { run }),
    hostMemory: readHostMemory,
    // Each launch's reads of its own pane are watched: a runtime that exited on its provider's
    // limit notice is failed over below rather than counted as a refusal.
    launchReview: (work, request, profile, agents, observedAt) => { const watch = watchInstantExit(run, deps.now); return launchReview(root, work, profile.name, agents, observedAt, { run: watch.run, start: watch.start, requestId: request.id }).catch(error => { throw watch.classify(error); }); },
    launchProducer: (work, request, profile, agents, observedAt) => { const watch = watchInstantExit(run, deps.now); return launchProducer(root, work, request, profile, agents, observedAt, { run: watch.run, start: watch.start }).catch(error => { throw watch.classify(error); }); },
    // Who has reviewed the head: one read per head at most every 30 seconds, however often the
    // dispatcher ticks, since it is asked on every tick while a launch waits on a bot reviewer.
    // A read still in flight is shared rather than started again: a tick that gave up on it at its
    // deadline does not leave one more hung `gh` behind on every later tick.
    headReviewers: (_work, request) => {
      const key = `${request.pr}:${request.sha}`, cached = headReviewerReads.get(key), at = (deps.now ?? Date.now)();
      if (cached && at - cached.at < 30_000) return Promise.resolve(cached.logins);
      const pending = headReviewerInFlight.get(key);
      if (pending) return pending;
      const read = (async () => {
        const output = String(await run('gh', ['api', '--paginate', `repos/${current().repository}/pulls/${request.pr}/reviews?per_page=100`, '--jq', '.[] | [.user.login, .commit_id] | @tsv']));
        const logins = [...new Set(output.split('\n').map(line => line.split('\t')).filter(([login, sha]) => login && sha === request.sha).map(([login]) => login))];
        headReviewerReads.set(key, { at, logins });
        for (const [entry, value] of headReviewerReads) if (at - value.at > 3_600_000) headReviewerReads.delete(entry);
        return logins;
      })().finally(() => headReviewerInFlight.delete(key));
      headReviewerInFlight.set(key, read);
      return read;
    },
    // The awaited bots' latest words (GY-349): the repository's newest issue comments, where a bot
    // posts its usage-limit notice, and its reviews on any pull request since its latest notice, so
    // a review on a head nobody is waiting on still ends the exhaustion. Those are read from the
    // waiting pull requests and every pull request updated since that notice (a review updates
    // it), at most `botReviewPullLimit` of the most recently updated. One read a minute at most,
    // shared while in flight; only the awaited logins' entries are kept.
    botActivity: (logins, requests, held = []) => {
      const repository = current().repository, waiting = [...new Set(requests.map(request => request.pr))].sort((a, b) => a - b);
      const at = (deps.now ?? Date.now)(), key = `${logins.join(',')}|${waiting.join(',')}|${held.map(bot => `${bot.login}:${bot.since}`).join(',')}`;
      if (botActivityRead && botActivityRead.key === key && at - botActivityRead.at < 60_000) return botActivityRead.activity;
      const wanted = new Set(logins.map(login => login.toLowerCase()));
      const lines = (output: unknown) => String(output).split('\n').map(line => line.split('\t'));
      const rows = (output: unknown) => lines(output).filter(([login, time]) => login && time && wanted.has(login.toLowerCase()));
      const activity = (async () => {
        const comments = rows(await run('gh', ['api', `repos/${repository}/issues/comments?sort=created&direction=desc&per_page=100`, '--jq', '.[] | [.user.login, .created_at, ((.body // "") | .[0:300] | gsub("[\\t\\n\\r]"; " "))] | @tsv']))
          .map(([login, time, body]): BotActivity => ({ login, kind: 'comment', at: time, body }));
        // Each bot's latest notice, or the one the last judgment still holds when it aged out of the
        // comment read; the earliest of them bounds which pull requests' reviews can end one.
        const latest = [...wanted].map(login => Math.max(-Infinity,
          ...comments.filter(entry => entry.login.toLowerCase() === login && botLimitNotice.test(entry.body ?? '')).map(entry => Date.parse(entry.at)),
          ...held.filter(bot => bot.login.toLowerCase() === login && bot.state === 'exhausted' && bot.since).map(bot => Date.parse(bot.since!)))).filter(Number.isFinite);
        const cutoff = latest.length ? Math.min(...latest) : null;
        const updated = cutoff === null ? [] : lines(await run('gh', ['api', `repos/${repository}/pulls?state=all&sort=updated&direction=desc&per_page=${botReviewPullLimit}`, '--jq', '.[] | [.number, .updated_at] | @tsv']))
          .filter(([pr, time]) => pr && Date.parse(time) >= cutoff).map(([pr]) => Number(pr)).filter(Number.isSafeInteger);
        const prs = [...new Set([...waiting, ...updated])];
        const reviews = (await Promise.all(prs.map(pr => run('gh', ['api', '--paginate', `repos/${repository}/pulls/${pr}/reviews?per_page=100`, '--jq', '.[] | [.user.login, .submitted_at] | @tsv']))))
          .flatMap(output => rows(output).map(([login, time]): BotActivity => ({ login, kind: 'review', at: time })));
        return [...comments, ...reviews];
      })();
      botActivityRead = { key, at, activity };
      activity.catch(() => { if (botActivityRead?.activity === activity) botActivityRead = null; });
      return activity;
    },
    // The handle goes where every Graphyard reader already looks, so watching a reviewer or
    // producer session the loop launched never means reading this host's own ledger.
    recordSession: (work: Work, handle: SessionHandleInput) => mutate(`work/${work.id}/session`, handle, randomUUID()),
    // And ends one when the sweep finds it over. The same coordinator mutation: a record that says
    // running is what holds the role slot, so closing it is as much this loop's job as opening it.
    endSession: (closure: SessionClosure) => mutate(`work/${closure.workId}/session`, closureHandle(closure), randomUUID()),
    // The same three moves the coordination loop makes for a session exhausted mid-work.
    selectedAccount: async (role, profile) => (await readEnvironmentLog(current())).selected?.[selectionKey(role, profile)] ?? null,
    holdAccount: (account, observed) => recordObservedExhaustion(current(), account, observed, deps.now?.()),
    reportCapacity: (work, event) => mutate(`work/${work.id}/capacity`, event),
    persist: cursor => writeDispatchCursor(current(), cursor, onRepair),
  };
}

/** The compact dispatcher view `master status` joins onto the per-candidate requests. */
export function dispatchSummary(cursor: DispatchCursor, now: number, intervalMs: number, awaited: readonly string[] = []) {
  const lastTickAt = cursor.lastTickAt ? Date.parse(cursor.lastTickAt) : Number.NaN;
  const lagMs = Number.isFinite(lastTickAt) ? now - lastTickAt : null;
  return { running: lagMs !== null && lagMs < Math.max(3 * intervalMs, 60_000), ticks: cursor.ticks, lastTickAt: cursor.lastTickAt, lagMs, intervalMs,
    // The liveness sweep runs on this interval too, so its bound is reported beside it.
    sessionReconcile: { intervalMs, graceMs: sessionVanishGraceMs, boundMs: sessionClosureBoundMs, closed: cursor.lastTick?.closed ?? 0,
      // Handles the runtime did not report on the last sweep: each is inside its grace, and closes on the sweep after it passes.
      missing: Object.keys(cursor.sessionMisses).length, failures: cursor.lastTick?.closeFailures ?? [] },
    lastSuccessAt: cursor.lastSuccessAt, consecutiveFailures: cursor.consecutiveFailures, lastFailure: cursor.lastFailure, lastTick: cursor.lastTick ?? null,
    failures: Object.entries(cursor.failures).map(([requestId, failure]) => ({ requestId, ...failure })),
    // Requests the loop has stopped attempting because every session it launched ended unanswered.
    abandoned: Object.entries(cursor.abandoned).map(([requestId, entry]) => ({ requestId, ...entry })),
    // A role with no account left, as one entry per role rather than a failure per request.
    capacity: Object.entries(cursor.capacity ?? {}).map(([kind, hold]) => ({ role: kind === 'review' ? 'reviewer' : 'producer', ...hold })),
    // Each awaited bot reviewer, available or exhausted since its usage-limit notice (GY-349); a bot
    // no read has judged yet is available, since nothing it said says otherwise.
    botReviewers: awaited.map(login => cursor.botReviewers.find(bot => bot.login.toLowerCase() === login.toLowerCase()) ?? { login, state: 'available' as const, since: null, checkedAt: null })
      .map(bot => ({ ...bot, line: botReviewerLine(bot) })),
    // Each agent account as the last launch check saw it, and the launches that skipped one and why.
    accounts: cursor.accounts ? {
      environments: Object.values(cursor.accounts.environments).map((health: any) => ({ environment: health.name, kind: health.kind, loggedIn: health.loggedIn, quota: health.quota, healthy: health.healthy, reason: health.reason, usage: health.usage, login: health.login, checkedAt: health.checkedAt })),
      skipped: cursor.accounts.skipped.slice(-20),
    } : { environments: [], skipped: [] } };
}

/**
 * The dispatcher's own health, as `master status` raises it before every request it launches
 * (GY-120). A tick that fails launches nothing for any item, and a dispatcher that kept failing
 * the same tick looked like one that was running: the tick count moved, the cursor was fresh, and
 * every request simply stayed `waiting`. Three failures in a row raise one attention item that
 * says no reviewer or producer is being launched and why — the request, item and field a persist
 * failure was composed for, when that is the cause — and a cursor that cannot be read at all
 * raises the same. Addressed to the master, with what fixes each.
 */
export const dispatchFailureAttentionThreshold = 3;
export function dispatchFailureAttention(dispatch: { consecutiveFailures?: number; lastSuccessAt?: string | null; lastFailure?: TickFailure | null; error?: string; abandoned?: (AbandonedRequest & { requestId: string })[] }): AttentionItem[] {
  return [...tickFailureAttention(dispatch), ...(dispatch.abandoned ?? []).map(abandonedAttention)];
}
/**
 * One attention item per request the loop has stopped attempting (GY-193): the request, the head,
 * and every session it launched with how each ended, addressed to the master.
 */
export function abandonedAttention(entry: AbandonedRequest & { requestId: string }): AttentionItem {
  const role = entry.kind === 'review' ? 'reviewer' : 'producer';
  return { subject: entry.work, text: bounded(`${entry.work}'s ${role} request ${entry.requestId} on ${entry.sha.slice(0, 12)} still stands after ${entry.attempts.length} automatic session${entry.attempts.length === 1 ? '' : 's'}, none of which answered it, so the loop has stopped attempting it (${entry.reason}): ${entry.attempts.join('; ')}`, 2000),
    ...agentOwner('master', entry.kind === 'review' ? `Fix what the attempts name, then graphyard master review ${entry.work}` : `Fix what the attempts name (a producer profile or its credential), or return the head to its worker with graphyard master decide ${entry.work} rework REASON`) };
}
function tickFailureAttention(dispatch: { consecutiveFailures?: number; lastSuccessAt?: string | null; lastFailure?: TickFailure | null; error?: string }): AttentionItem[] {
  if (dispatch.error) return [{ subject: 'dispatch', text: `The dispatch cursor cannot be read, so whether any reviewer or producer is being launched is unknown: ${dispatch.error}`,
    ...agentOwner('master', 'graphyard master restart re-reads the dispatch cursor beside the coordinator credential and repairs an over-long string in it; a cursor for another server or repository is removed by hand first') }];
  const failures = dispatch.consecutiveFailures ?? 0, failure = dispatch.lastFailure;
  if (failures < dispatchFailureAttentionThreshold || !failure) return [];
  const persisted = failure.field ? ` The tick could not persist ${failure.field}${failure.request ? `, composed for the ${failure.kind} request ${failure.request} on ${failure.work}` : ''}.` : '';
  return [{ subject: 'dispatch', text: `The dispatcher has failed ${failures} ticks in a row (last at ${failure.at}; last successful tick ${dispatch.lastSuccessAt ?? 'none since it started'}), so no reviewer or producer session is being launched for any item: ${failure.reason}${persisted}`,
    ...agentOwner('master', failure.field
      ? 'graphyard master restart re-reads and repairs the dispatch cursor; a tick that still cannot persist names the field above, and the request it was composed for is the one to look at'
      : 'Fix what the reason names — the control plane URL and coordinator credential in .graphyard/master.json, or Herdr — then graphyard master restart if the loop does not recover on its own') }];
}

/**
 * The stateless executor.
 *
 * Automatic dispatch above launches sessions for the requests one candidate raises. This runs the
 * whole inverted loop: the control plane computes a typed action per item and keeps a durable,
 * leased row for it (model/next-action.ts, model/actions.ts); an executor claims one row, runs it,
 * and reports the result. It holds nothing between claims — no cursor, no snapshot, no idea that
 * other executors exist — so any number of them on any number of hosts drive the same queue
 * without coordinating, and one that dies loses only its claim.
 *
 * An executor claims only the kinds it has a handler for. That is what makes AGENTS.md's rule
 * mechanical rather than aspirational: configure no `escalate` handler and the loop still runs a
 * full ready-to-delivered cycle, with every language model invoked inside the sessions the
 * mechanical actions start rather than anywhere in the loop itself.
 */
export interface ExecutorIdentity { id: string; host: string }
export type ExecutorHandler = (action: ActionRow, identity: ExecutorIdentity) => Promise<string> | string;
export interface ExecutorEffects {
  /** Ask the control plane for one row this executor can run; null when the queue has nothing for it. */
  claim: (request: { host: string; executor: string; kinds: NextActionKind[]; leaseSeconds?: number }) => Promise<{ action: ActionRow | null; open?: number }>;
  settle: (action: ActionRow, result: 'done' | 'failed', reason: string) => Promise<unknown>;
  /**
   * Say the handler is still running, so the claim holds for another lease. An executor wired
   * without it can still run every kind — it is simply bounded by one claim lease, and a handler
   * that outlives that is taken from it by the next executor.
   */
  renew?: (action: ActionRow) => Promise<unknown>;
  /** One handler per action kind this executor can run. A kind with no handler is never claimed. */
  handlers: Partial<Record<NextActionKind, ExecutorHandler>>;
  /**
   * Why no session may be launched on this host now (GY-612: its memory is below the floor), or
   * null. While it names a reason the executor claims no launching kind, so the row waits in the
   * queue without a failure or a backoff and is claimed on the first poll after memory recovers.
   */
  launchHold?: () => Promise<string | null>;
}
/** The kinds whose handler starts a session on this host. */
export const launchingKinds: readonly NextActionKind[] = ['dispatch', 'request-review'];
export interface ExecutorStep { at: string; executor: string; host: string; action: ActionRow | null; result: 'done' | 'failed' | 'idle'; kind: NextActionKind | null; work: string | null; reason: string }

/**
 * How often a free worker session asks the control plane for its next assignment.
 *
 * The pull model's latency is the wait for the next poll plus the time the pull itself takes, so
 * this interval is the bound on ready-to-claim. Thirty seconds keeps p90 inside the two-minute
 * target with room to spare, and costs one cheap request per idle worker per half minute — no
 * central runtime-health tracking, no dispatcher deciding which session is free, and no session
 * sitting idle because the thing that would have dispatched it is not running.
 */
export const workerPullIntervalMs = 30_000;

export interface PulledAssignment { at: string; assigned: Work | null; offered: number; refused: { key: string; reason: string }[]; waitedMs: number; polls: number }
/**
 * The worker side of the pull model: ask for the next assignment, and keep asking until there is
 * one or the caller stops.
 *
 * A free session runs this instead of waiting to be dispatched into. It holds no state between
 * polls, registers nothing, and is invisible to the control plane until it claims — which is what
 * removes central runtime-health tracking: nothing has to know this session exists, or is alive,
 * for it to be given work. The wait for the next assignment is one poll interval plus the time
 * the claim itself takes, so the published interval is the bound on ready-to-claim.
 */
export async function runWorkerPull(pull: () => Promise<{ assigned: Work | null; offered?: number; refused?: { key: string; reason: string }[] }>, options: { intervalMs?: number; signal?: AbortSignal; once?: boolean; now?: () => number; maxPolls?: number; log?: (line: string) => void } = {}): Promise<PulledAssignment> {
  const intervalMs = options.intervalMs ?? workerPullIntervalMs, now = options.now ?? Date.now, log = options.log ?? (() => {});
  const startedAt = now();
  let polls = 0, last: { assigned: Work | null; offered?: number; refused?: { key: string; reason: string }[] } = { assigned: null };
  const done = (): PulledAssignment => ({ at: new Date(now()).toISOString(), assigned: last.assigned ?? null, offered: last.offered ?? 0, refused: last.refused ?? [], waitedMs: Math.max(0, now() - startedAt), polls });
  while (!options.signal?.aborted) {
    polls++;
    last = await pull();
    if (last.assigned) { log(`[graphyard-worker] claimed ${last.assigned.key} after ${polls} poll(s)`); return done(); }
    if (options.once || (options.maxPolls !== undefined && polls >= options.maxPolls)) return done();
    try { await delay(intervalMs, undefined, { signal: options.signal }); } catch { /* woken to stop */ }
  }
  return done();
}

/** The kinds an executor can claim: exactly the ones it has a handler for, in a stable order. */
export const executorKinds = (handlers: ExecutorEffects['handlers']): NextActionKind[] => nextActionKinds.filter(kind => !!handlers[kind]);

/**
 * One claim-run-settle step. A handler that throws settles the row as failed with the reason, so
 * the next executor sees what this one could not do rather than an action that silently stalls;
 * the row backs off and is offered again.
 */
export async function runExecutorTick(identity: ExecutorIdentity, effects: ExecutorEffects, now: () => number = Date.now, options: { renewIntervalMs?: number } = {}): Promise<ExecutorStep> {
  const kinds = executorKinds(effects.handlers);
  const step = (action: ActionRow | null, result: ExecutorStep['result'], reason: string): ExecutorStep =>
    ({ at: new Date(now()).toISOString(), executor: identity.id, host: identity.host, action, result, kind: action?.kind ?? null, work: action?.key ?? null, reason });
  if (!kinds.length) return step(null, 'idle', 'this executor has no handler for any action kind');
  const hold = kinds.some(kind => launchingKinds.includes(kind)) && effects.launchHold ? await effects.launchHold().catch(() => null) : null;
  const claimable = hold ? kinds.filter(kind => !launchingKinds.includes(kind)) : kinds;
  if (!claimable.length) return step(null, 'idle', `claims nothing: ${hold}`);
  const claimed = await effects.claim({ host: identity.host, executor: identity.id, kinds: claimable });
  const action = claimed.action;
  if (!action) return step(null, 'idle', hold ? `the queue has no action this executor can run without launching a session, and it launches none: ${hold}` : 'the queue has no action this executor can run');
  // The handlers are not bounded by the claim lease: a dispatch prepares a worktree and waits on
  // a runtime, and a guarded merge chains provider calls that each have their own timeout. While
  // one runs, this says so at the renewal interval, so the row is never offered to a second
  // executor mid-flight. A renewal that fails is not a failure of the action — if the claim is
  // really gone the settlement refuses, which is where that is decided.
  const holding = effects.renew ? setInterval(() => { void effects.renew!(action).catch(() => {}); }, options.renewIntervalMs ?? actionRenewIntervalMs) : null;
  holding?.unref?.();
  try {
    const reason = (await effects.handlers[action.kind]!(action, identity)) || `${action.kind} completed`;
    if (holding) clearInterval(holding);
    await effects.settle(action, 'done', reason.slice(0, 2000));
    return step(action, 'done', reason);
  } catch (error) {
    const reason = message(error).slice(0, 2000);
    await effects.settle(action, 'failed', reason).catch(() => {});
    return step(action, 'failed', reason);
  } finally { if (holding) clearInterval(holding); }
}

/**
 * Claim and run until stopped. An executor that finds nothing waits the idle interval; one that
 * ran an action tries again immediately, so a queue that fills up is drained as fast as the
 * handlers allow rather than one row per interval.
 */
export async function runExecutor(identity: ExecutorIdentity, effects: ExecutorEffects, options: { intervalMs: number; once?: boolean; signal?: AbortSignal; now?: () => number; log?: (line: string) => void; maxSteps?: number; renewIntervalMs?: number }) {
  const now = options.now ?? Date.now, log = options.log ?? (() => {});
  const steps: ExecutorStep[] = [];
  do {
    if (options.signal?.aborted) break;
    let step: ExecutorStep;
    try { step = await runExecutorTick(identity, effects, now, { renewIntervalMs: options.renewIntervalMs }); }
    catch (error) {
      step = { at: new Date(now()).toISOString(), executor: identity.id, host: identity.host, action: null, result: 'failed', kind: null, work: null, reason: message(error).slice(0, 2000) };
    }
    steps.push(step);
    if (step.action) log(`[graphyard-executor] ${identity.id} ${step.result} ${step.kind} for ${step.work}: ${step.reason}`);
    if (options.once || options.signal?.aborted || (options.maxSteps !== undefined && steps.length >= options.maxSteps)) break;
    // Only a completed action earns an immediate retry. An empty queue and a step that failed —
    // including a claim the control plane could not answer — both wait, so a broken executor
    // polls at its interval rather than spinning against the error.
    if (step.result !== 'done') { try { await delay(options.intervalMs, undefined, { signal: options.signal }); } catch { /* woken to stop */ } }
  } while (!options.signal?.aborted);
  return { steps };
}

/** Executor effects bound to a control plane over HTTP; the only state is the credential. */
export function executorEffects(config: { url: string; token: string; fetcher?: typeof fetch; requestId?: () => string }, handlers: ExecutorEffects['handlers']): ExecutorEffects {
  const fetcher = config.fetcher ?? fetch;
  const requestId = config.requestId ?? (() => randomUUID());
  const post = async (path: string, body: unknown) => {
    const response = await fetcher(`${config.url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': requestId() }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : JSON.stringify(result));
    return result;
  };
  return {
    claim: request => post('actions/claim', request),
    // The settlement names the executor the claim was recorded under, not the credential's own
    // principal: several executors may run behind one coordinator credential, and a settlement
    // under the wrong identity is refused after the handler has already run — which is the one
    // way a leased queue can still execute an action twice.
    settle: (action, result, reason) => post(`actions/${action.id}/settle`, { result, reason, ...(action.claim?.executor ? { executor: action.claim.executor } : {}) }),
    // The same claim, named the same way: a renewal from any other executor or credential is
    // refused, so holding a row is as bounded as claiming one.
    renew: action => post(`actions/${action.id}/renew`, { ...(action.claim?.executor ? { executor: action.claim.executor } : {}) }),
    handlers,
  };
}
