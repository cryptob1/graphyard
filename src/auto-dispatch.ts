import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Work } from './model.js';
import type { SessionHandleInput } from './model/sessions.js';
import type { DispatchRequest } from './model/dispatch.js';
import { actionRenewIntervalMs, type ActionRow } from './model/actions.js';
import { nextActionKinds, type NextActionKind } from './model/next-action.js';
import { agentOwner, assertOutsideWorktrees, herdrErrorCode, inspectProducerCredentials, listHerdrAgents, profileAccount, profileSessions, readCredentialFile, readEnvironmentLog, recordObservedExhaustion, selectionKey, sessionAgentName, sessionWords, type AttentionItem, type ConfigReload, type EnvironmentLog, type HerdrAgent, type MasterConfig, type ObservedExhaustion, type ProducerProfile, type ReviewerProfile } from './master.js';
import { detectExhaustion, type ExhaustionSignal } from './model/capacity.js';
import { launchReview, reconcileReviews, type ReviewRecord } from './reviewer.js';
import { independentProducerProfiles, launchProducer, reconcileProducers, sessionRetry, type ProducerRecord } from './producer.js';

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
 */

/**
 * Every string the cursor holds is bounded where it is composed, never only checked at persist
 * time (GY-120): a reason the dispatcher composed and then could not persist failed the whole
 * tick, and with it every launch for every item, until the string happened to change. The caps
 * nest — a stored failure reason leaves room for the wait sentence that wraps it, and that
 * sentence is bounded again before it becomes a tick reason — so a reason at its cap still
 * yields a valid tick. `bounded` marks every cut with an ellipsis rather than hiding it.
 */
export const cursorTextLimit = 500, capacityReasonLimit = 1000, dispatchFailureReasonLimit = 300;
export const ellipsis = '…';
export const bounded = (text: string, limit: number) => text.length > limit ? `${text.slice(0, Math.max(0, limit - ellipsis.length))}${ellipsis}` : text;
export const dispatchFailureSchema = z.object({
  kind: z.enum(['review', 'producer']), work: z.string().min(1).max(40), sha: z.string().min(1).max(40),
  attempts: z.number().int().min(1).max(1000), reason: z.string().max(cursorTextLimit), at: z.string(), nextAt: z.string(),
}).strict();
export type DispatchFailure = z.infer<typeof dispatchFailureSchema>;
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
  /**
   * Both halves of the last tick: what it could launch and what it did. A dispatcher that is
   * ticking but launching nothing looks identical to a stopped one from the tick count alone,
   * so the counts and the reasons nothing launched are kept for `master status`.
   */
  lastTick: z.object({ at: z.string(), launched: z.number().int().min(0), refused: z.number().int().min(0), waiting: z.number().int().min(0), settled: z.number().int().min(0),
    reasons: z.array(z.string().max(cursorTextLimit)).max(20).default([]) }).strict().nullable().default(null),
  /**
   * A role none of whose accounts can launch (GY-89): why, and when its accounts are read again.
   * That is capacity, not a refusal, so it never counts toward a request's failure limit — a
   * request that waited out a week-long reset launches the moment an account returns.
   */
  capacity: z.object({ review: capacityHoldSchema.optional(), producer: capacityHoldSchema.optional() }).strict().default({}),
  /**
   * What launches last observed about each agent account and the launches that skipped an account,
   * with the reason. Read from the environment log beside the cursor, which every launcher writes;
   * never persisted in the cursor itself.
   */
  accounts: z.object({ environments: z.record(z.string(), z.any()), skipped: z.array(z.any()) }).optional(),
}).strict();
export type DispatchCursor = z.infer<typeof dispatchCursorSchema>;

/** A refused launch retries on a widening interval, never more often than this and never later than this. */
export const dispatchRetryMinMs = 30_000, dispatchRetryMaxMs = 600_000, dispatchFailureLimit = 12;
/** How long a role with no account left is not launched before its accounts are read again. */
export const capacityRecheckMs = 60_000;
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

export interface DispatchEffects {
  snapshot: () => Promise<{ work: Work[]; now: string }>;
  /** Herdr's agent list, or null when Herdr could not be read. */
  agents: () => HerdrAgent[] | null;
  credentials: (profiles: ProducerProfile[]) => Promise<Record<string, { available: boolean; reason: string | null }>>;
  reconcileReviews: (work: Work[], agents: HerdrAgent[] | null) => Promise<{ reviews: ReviewRecord[] }>;
  reconcileProducers: (work: Work[], agents: HerdrAgent[] | null) => Promise<{ producers: ProducerRecord[] }>;
  launchReview: (work: Work, request: DispatchRequest, profile: ReviewerProfile, agents: HerdrAgent[], observedAt: string) => Promise<unknown>;
  launchProducer: (work: Work, request: DispatchRequest, profile: ProducerProfile, agents: HerdrAgent[], observedAt: string) => Promise<unknown>;
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
  persist: (cursor: DispatchCursor) => Promise<void>;
}

/**
 * A launched session Herdr cannot find within seconds of its launch. The launcher's first read of
 * the pane — `agent get` after `agent start` timed out on readiness, or a start that failed for
 * something other than that timeout — answers `agent_not_found` when the runtime already exited,
 * and Herdr's JSON error says nothing about why. The pane still holds what the runtime printed
 * last, and that is the classification (GY-120): a provider limit notice is account exhaustion,
 * anything else is recorded with the pane's last words rather than the CLI's error.
 */
export interface InstantExit { pane: string; words: string; notice: ExhaustionSignal | null }
export class InstantExitError extends Error {
  constructor(readonly instantExit: InstantExit, override readonly cause: unknown) {
    super(instantExit.notice ? `the session exited within seconds of its launch on its provider's limit notice: ${instantExit.notice.reason}`
      : `the session exited within seconds of its launch; its pane last printed: ${instantExit.words ? `"${instantExit.words}"` : 'nothing'}`);
  }
}
export const instantExitTailLines = 40;
/** How many times one profile launches again on its next account within a single tick after such exits. */
export const instantExitRelaunchLimit = 4;
export type HerdrRun = (command: string, args: string[]) => string;
/**
 * The launcher's Herdr calls, with the first failed read of the pane it just started classified
 * from that pane's own output. One wrapper per launch: it remembers the pane `agent start` named
 * and touches nothing else the launcher runs.
 */
export function classifyInstantExit(run: HerdrRun, now: () => number = Date.now): HerdrRun {
  let pane: string | null = null;
  const tail = (target: string) => { try { return String(run('herdr', ['pane', 'read', target, '--source', 'recent-unwrapped', '--lines', String(instantExitTailLines), '--format', 'text'])); } catch { return null; } };
  const gone = (target: string) => { try { run('herdr', ['agent', 'get', target]); return false; } catch (error) { return herdrErrorCode(error) === 'agent_not_found'; } };
  return (command, args) => {
    const start = command === 'herdr' && args[0] === 'agent' && args[1] === 'start';
    if (start) { const flag = args.indexOf('--pane'); pane = flag >= 0 ? args[flag + 1] ?? null : null; }
    try { return run(command, args); }
    catch (error) {
      if (command !== 'herdr' || !pane || args[0] !== 'agent') throw error;
      const code = herdrErrorCode(error);
      // A readiness timeout is followed by the launcher's own `agent get`, which is the read
      // classified below; any other start failure is checked here for a session already gone.
      const exited = args[1] === 'get' && args[2] === pane ? code === 'agent_not_found' : start && code !== 'timeout' && gone(pane);
      if (!exited) throw error;
      const text = tail(pane);
      if (text === null) throw error;
      throw new InstantExitError({ pane, words: sessionWords(text), notice: detectExhaustion(text, now()) }, error);
    }
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
 */
export function launchedSessionHandle(kind: 'review' | 'proof', request: DispatchRequest, subject: string, host: string, launched: { pane?: string | null } | undefined, runtime: string, workspace?: string, principal?: string): SessionHandleInput {
  return {
    id: request.id, kind, runtime, host,
    // Whose session it is, when the launcher knows: a producer session runs under its own
    // credential, and naming it here is what lets that session — and nobody else — fill in the
    // tab and transcript the launcher cannot see.
    ...(principal ? { principal } : {}),
    ...(workspace ? { workspace } : {}),
    ...(launched?.pane ? { pane: launched.pane, attach: `herdr pane attach ${launched.pane}${workspace ? ` --workspace ${workspace}` : ''}` } : {}),
    subject: subject.slice(0, 300), state: 'running',
  };
}

export interface DispatchLaunch { kind: 'review' | 'producer'; work: string; requestId: string; sha: string; profile: string; group?: string; proofs?: string[]; failover?: string[]; relaunched?: boolean }
export interface DispatchWait { kind: 'review' | 'producer'; work: string; requestId: string; sha: string; reason: string; group?: string }
export interface DispatchTick { at: string; launched: DispatchLaunch[]; refused: (DispatchFailure & { requestId: string })[]; waiting: DispatchWait[]; skipped: number }

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
  for (const profile of profiles) {
    let dropped = false, exits = 0;
    for (;;) {
      try { return { profile, failover, relaunched: dropped, result: await launch(profile) }; }
      catch (error: any) {
        if (error?.promptDropped && !dropped) { dropped = true; continue; }
        if (error?.instantExit?.notice && exhaustedAtLaunch && exits < instantExitRelaunchLimit) { exits++; failover.push(await exhaustedAtLaunch(profile, error.instantExit)); continue; }
        if (error?.accountsExhausted) { failover.push(`${profile.name}: ${message(error)}`); capacity &&= !!error.capacityExhausted; break; }
        throw error;
      }
    }
  }
  // `accountsExhausted` still means only that every profile was passed over; `capacityExhausted`
  // means the role has no quota left, which is the one case that waits rather than refuses.
  throw Object.assign(new Error(failover.join('; ') || 'no profile could launch'), { accountsExhausted: failover.length > 0, capacityExhausted: failover.length > 0 && capacity });
}

/**
 * One tick: settle the sessions the ledgers hold against the snapshot, then launch a session for
 * every open request that has none. Each launch is recorded by the launcher's own ledger before
 * the tick moves on, so a kill between two launches leaves nothing to repeat.
 */
export async function runDispatchTick(config: MasterConfig, cursor: DispatchCursor, effects: DispatchEffects, now: () => number = Date.now, readTimeoutMs = dispatchReadTimeoutMs): Promise<DispatchTick> {
  const snapshot = await boundedRead(effects.snapshot, readTimeoutMs);
  const observedAt = snapshot.now;
  const clock = Number.isFinite(Date.parse(observedAt)) ? Date.parse(observedAt) : now();
  const tick: DispatchTick = { at: new Date(clock).toISOString(), launched: [], refused: [], waiting: [], skipped: 0 };
  const herdr = effects.agents();
  const { reviews } = await effects.reconcileReviews(snapshot.work, herdr);
  const { producers } = await effects.reconcileProducers(snapshot.work, herdr);
  // Herdr unreadable: nothing is launched, because a launch needs the agent inventory to count
  // each profile's sessions against its limit; the requests wait and the tick says so.
  const agents = herdr ?? [];
  const credentials = await effects.credentials(config.producers);
  // The sessions this tick has started join the inventory at once, so two requests in one tick
  // never both take a profile's last slot. A launcher that does not report its session name is
  // counted under the name it would have chosen for the request.
  const started: { name: string }[] = [];
  const inventory = () => [...agents, ...started];
  const launchedName = (profile: { agentName: string; concurrency?: number }, request: DispatchRequest, result: unknown) =>
    typeof (result as { agentName?: unknown })?.agentName === 'string' ? (result as { agentName: string }).agentName : sessionAgentName(profile, { id: request.id, requestId: request.id });
  const room = (profile: ReviewerProfile | ProducerProfile, records: { profile: string; agentName: string; state: string }[]) => profileSessions(profile, inventory(), records);
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
  const persist = async () => { try { await effects.persist(cursor); } catch (error) { throw attributePersistFailure(error, cursor, composed().map(([, entry]) => entry)); } };
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
  // Whether the request already has its session, waits to relaunch one that failed or expired, or may launch now.
  const session = (kind: 'review' | 'producer', item: Work, request: DispatchRequest, records: { requestId?: string; state: string; requestedAt: string; closedAt?: string; resolution?: string }[]) => {
    const retry = sessionRetry(records, request.id, now());
    if (retry.settled) {
      tick.skipped++;
      // A session that settled while its request stands answered nothing the gates accept, and no
      // attempt follows a settled session. The tick says so rather than passing over it in silence:
      // a request nothing is running for and nothing refused is otherwise invisible until somebody
      // notices the item has not moved.
      if (retry.last && retry.last.state !== 'pending') wait(kind, item, request, `${kind === 'review' ? 'reviewer' : 'producer'} session attempt ${retry.attempts} ${retry.last.state} without satisfying the request: ${retry.last.resolution ?? 'no reason recorded'}; no automatic attempt follows a settled session${kind === 'review' ? `, force one with master review ${item.key}` : ''}`);
      return false;
    }
    if (retry.launch) return true;
    const last = `${kind === 'review' ? 'reviewer' : 'producer'} session attempt ${retry.attempts} ${retry.last!.state}: ${retry.last!.resolution ?? 'no reason recorded'}`;
    wait(kind, item, request, retry.exhausted ? `${last}; no further automatic attempt after ${retry.attempts} sessions${kind === 'review' ? ', launch it with master review once the cause is fixed' : ''}` : `${last}; attempt ${retry.attempts + 1} of ${retry.limit} at ${retry.nextAt}`);
    return false;
  };
  for (const item of snapshot.work.filter(work => work.stage !== 'done' && work.autoDispatch)) {
    const review = item.autoDispatch!.review;
    if (review?.state === 'requested' && review.provider === 'github') {
      if (!session('review', item, review, reviews)) { /* settled, or waiting to relaunch */ }
      else if (!herdr) wait('review', item, review, 'Herdr session inventory is unavailable');
      else if (spent('review')) wait('review', item, review, capacityWait('review'));
      else if (!retryable(review)) wait('review', item, review, `launch refused ${cursor.failures[review.id].attempts} time(s): ${cursor.failures[review.id].reason}; ${cursor.failures[review.id].attempts >= dispatchFailureLimit ? 'no further automatic attempt, launch it with master review once the cause is fixed' : `next attempt at ${cursor.failures[review.id].nextAt}`}`);
      else {
        const { profile, reason } = selectReviewerProfile(config);
        // The selected profile answers; the other reviewer profiles are its failover when none of
        // its accounts can launch. A profile with no slot left is passed over for one with room,
        // and a request no profile has room for waits on the limit it names.
        const order = profile ? [profile, ...config.reviewers.filter(other => other.name !== profile.name)].filter(candidate => room(candidate, reviews).free > 0) : [];
        if (!profile) wait('review', item, review, reason!);
        else if (!order.length) wait('review', item, review, `every reviewer profile is busy: ${[profile, ...config.reviewers.filter(other => other.name !== profile.name)].map(candidate => atLimit(candidate, reviews)).join('; ')}; raise concurrency in .graphyard/master.json or add a reviewer profile`);
        else {
          try {
            const launched = await launchWithFailover(order, candidate => effects.launchReview(item, review, candidate, inventory(), observedAt), effects.holdAccount ? exhaustedAtLaunch('review', item, review) : undefined);
            started.push({ name: launchedName(launched.profile, review, launched.result) }); delete cursor.failures[review.id]; delete cursor.capacity.review;
            // The session is running somewhere; put its coordinates where every Graphyard reader
            // looks, so watching this reviewer never means reading this host's local ledger.
            await effects.recordSession?.(item, launchedSessionHandle('review', review, `${item.key}: review ${review.sha.slice(0, 12)} (PR #${review.pr})`, config.hostId, launched.result as { pane?: string | null }, launched.profile.kind, config.herdrWorkspace))
              .catch(() => { /* the launch landed; a handle that could not be written is not a failed launch */ });
            tick.launched.push({ kind: 'review', work: item.key, requestId: review.id, sha: review.sha, profile: launched.profile.name, ...(launched.failover.length ? { failover: launched.failover } : {}), ...(launched.relaunched ? { relaunched: true } : {}) });
          } catch (error) { if (!outOfCapacity('review', item, review, error)) refuse('review', item, review, error); }
          await persist();
        }
      }
    }
    for (const request of item.autoDispatch!.producers.filter(entry => entry.state === 'requested')) {
      if (!session('producer', item, request, producers)) continue;
      if (!herdr) { wait('producer', item, request, 'Herdr session inventory is unavailable'); continue; }
      if (spent('producer')) { wait('producer', item, request, capacityWait('producer')); continue; }
      if (!retryable(request)) { wait('producer', item, request, `launch refused ${cursor.failures[request.id].attempts} time(s): ${cursor.failures[request.id].reason}; ${cursor.failures[request.id].attempts >= dispatchFailureLimit ? 'no further automatic attempt' : `next attempt at ${cursor.failures[request.id].nextAt}`}`); continue; }
      // Independence is per item, never per process: a profile whose principal held an assignment
      // on this item is skipped for this item however many slots it has, and the launcher selects
      // among the rest up to each one's concurrency.
      const independent = independentProducerProfiles(item, config.producers);
      const usable = independent.filter(profile => credentials[profile.name]?.available !== false && room(profile, producers).free > 0);
      if (!usable.length) {
        wait('producer', item, request, !config.producers.length ? 'no producer profile is configured; add one with master producer add'
          : !independent.length ? `every producer principal (${config.producers.map(profile => profile.principal).join(', ')}) has held an assignment on ${item.key}; its evidence would not be trusted`
          : `every independent producer profile is busy or unavailable (${independent.map(profile => credentials[profile.name]?.available === false ? `${profile.name}: ${credentials[profile.name].reason}` : atLimit(profile, producers)).join('; ')}); raise concurrency in .graphyard/master.json or add a producer profile`);
        continue;
      }
      try {
        const launched = await launchWithFailover(usable, candidate => effects.launchProducer(item, request, candidate, inventory(), observedAt), effects.holdAccount ? exhaustedAtLaunch('producer', item, request) : undefined);
        started.push({ name: launchedName(launched.profile, request, launched.result) }); delete cursor.failures[request.id]; delete cursor.capacity.producer;
        await effects.recordSession?.(item, launchedSessionHandle('proof', request, `${item.key}: ${request.group} proofs on ${request.sha.slice(0, 12)} (${(request.proofs ?? []).join(', ')})`, config.hostId, launched.result as { pane?: string | null }, launched.profile.kind, config.herdrWorkspace, launched.profile.principal))
          .catch(() => { /* as above: the session exists whether or not its handle could be written */ });
        tick.launched.push({ kind: 'producer', work: item.key, requestId: request.id, sha: request.sha, profile: launched.profile.name, group: request.group, proofs: request.proofs, ...(launched.failover.length ? { failover: launched.failover } : {}), ...(launched.relaunched ? { relaunched: true } : {}) });
      } catch (error) { if (!outOfCapacity('producer', item, request, error)) refuse('producer', item, request, error); }
      await persist();
    }
  }
  // A failure for a request the control plane resolved is history the cursor need not keep.
  const live = new Set(snapshot.work.flatMap(work => [...(work.autoDispatch?.review ? [work.autoDispatch.review.id] : []), ...(work.autoDispatch?.producers ?? []).map(request => request.id)]));
  for (const id of Object.keys(cursor.failures)) if (!live.has(id)) delete cursor.failures[id];
  cursor.ticks += 1; cursor.lastTickAt = cursor.lastSuccessAt = new Date(now()).toISOString(); cursor.consecutiveFailures = 0;
  cursor.lastTick = { at: tick.at, launched: tick.launched.length, refused: tick.refused.length, waiting: tick.waiting.length, settled: tick.skipped, reasons: composed().map(([reason]) => reason) };
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
  let refused: string | null = null, waiting = '';
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
      for (const launch of tick.launched) log(`[graphyard-dispatch] launched ${launch.kind} for ${launch.work} ${launch.sha.slice(0, 12)} on ${launch.profile}${launch.group ? ` (${launch.group}: ${launch.proofs?.join(', ')})` : ''}${launch.failover?.length ? ` after skipping ${launch.failover.join('; ')}` : ''}${launch.relaunched ? ' (relaunched after a dropped prompt)' : ''}`);
      for (const refusal of tick.refused) log(`[graphyard-dispatch] ${refusal.kind} launch for ${refusal.work} refused (attempt ${refusal.attempts}): ${refusal.reason}`);
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
export function dispatchEffects(root: string, config: MasterConfig | (() => MasterConfig), deps: { snapshot: () => Promise<{ work: Work[]; now: string }>; mutate?: (path: string, body: unknown, requestId?: string) => Promise<any>; run?: HerdrRun; log?: (line: string) => void; now?: () => number }): DispatchEffects {
  const run = deps.run ?? ((command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 }));
  const current = typeof config === 'function' ? config : () => config;
  const log = deps.log ?? (line => console.error(line));
  // A repair is logged once per path: the same over-long string would otherwise be reported on
  // every tick that persists it, when one line naming the path is what a reader needs.
  const repaired = new Set<string>();
  const onRepair: RepairListener = repair => { if (repaired.has(repair.path)) return; repaired.add(repair.path); log(repairLine('persisting', repair)); };
  // The coordinator mutation this loop records handles with. It is built from the same
  // configuration the loop already runs on — the credential the dispatcher authenticates every
  // launch decision with — so a dispatcher records what it launched wherever it runs, rather than
  // only where a caller remembered to pass one. A caller with a mutation of its own passes it.
  const mutate = deps.mutate ?? (async (path: string, body: unknown, requestId: string = randomUUID()) => {
    const token = await readCredentialFile(current().credentialFile);
    const response = await fetch(`${current().url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': requestId }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : JSON.stringify(result));
    return result;
  });
  return {
    snapshot: deps.snapshot,
    agents: () => { try { return listHerdrAgents(run); } catch { return null; } },
    credentials: profiles => inspectProducerCredentials(root, profiles),
    reconcileReviews: (work, agents) => reconcileReviews(root, current(), { run, work, agents }),
    reconcileProducers: (work, agents) => reconcileProducers(root, current(), work, agents, { run }),
    // Each launch's first failed read of its own pane is classified from what the pane printed.
    launchReview: (work, request, profile, agents, observedAt) => launchReview(root, work, profile.name, agents, observedAt, { run: classifyInstantExit(run, deps.now), requestId: request.id }),
    launchProducer: (work, request, profile, agents, observedAt) => launchProducer(root, work, request, profile, agents, observedAt, { run: classifyInstantExit(run, deps.now) }),
    // The handle goes where every Graphyard reader already looks, so watching a reviewer or
    // producer session the loop launched never means reading this host's own ledger.
    recordSession: (work: Work, handle: SessionHandleInput) => mutate(`work/${work.id}/session`, handle, randomUUID()),
    // The same three moves the coordination loop makes for a session exhausted mid-work.
    selectedAccount: async (role, profile) => (await readEnvironmentLog(current())).selected?.[selectionKey(role, profile)] ?? null,
    holdAccount: (account, observed) => recordObservedExhaustion(current(), account, observed, deps.now?.()),
    reportCapacity: (work, event) => mutate(`work/${work.id}/capacity`, event),
    persist: cursor => writeDispatchCursor(current(), cursor, onRepair),
  };
}

/** The compact dispatcher view `master status` joins onto the per-candidate requests. */
export function dispatchSummary(cursor: DispatchCursor, now: number, intervalMs: number) {
  const lastTickAt = cursor.lastTickAt ? Date.parse(cursor.lastTickAt) : Number.NaN;
  const lagMs = Number.isFinite(lastTickAt) ? now - lastTickAt : null;
  return { running: lagMs !== null && lagMs < Math.max(3 * intervalMs, 60_000), ticks: cursor.ticks, lastTickAt: cursor.lastTickAt, lagMs, intervalMs,
    lastSuccessAt: cursor.lastSuccessAt, consecutiveFailures: cursor.consecutiveFailures, lastFailure: cursor.lastFailure, lastTick: cursor.lastTick ?? null,
    failures: Object.entries(cursor.failures).map(([requestId, failure]) => ({ requestId, ...failure })),
    // A role with no account left, as one entry per role rather than a failure per request.
    capacity: Object.entries(cursor.capacity ?? {}).map(([kind, hold]) => ({ role: kind === 'review' ? 'reviewer' : 'producer', ...hold })),
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
export function dispatchFailureAttention(dispatch: { consecutiveFailures?: number; lastSuccessAt?: string | null; lastFailure?: TickFailure | null; error?: string }): AttentionItem[] {
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
}
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
  const claimed = await effects.claim({ host: identity.host, executor: identity.id, kinds });
  const action = claimed.action;
  if (!action) return step(null, 'idle', 'the queue has no action this executor can run');
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
