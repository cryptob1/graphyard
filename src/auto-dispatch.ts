import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Work } from './model.js';
import type { DispatchRequest } from './model/dispatch.js';
import { assertOutsideWorktrees, inspectProducerCredentials, listHerdrAgents, readEnvironmentLog, type ConfigReload, type EnvironmentLog, type HerdrAgent, type MasterConfig, type ProducerProfile, type ReviewerProfile } from './master.js';
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
 */

export const dispatchFailureSchema = z.object({
  kind: z.enum(['review', 'producer']), work: z.string().min(1).max(40), sha: z.string().min(1).max(40),
  attempts: z.number().int().min(1).max(1000), reason: z.string().max(500), at: z.string(), nextAt: z.string(),
}).strict();
export type DispatchFailure = z.infer<typeof dispatchFailureSchema>;
const capacityHoldSchema = z.object({ at: z.string(), recheckAt: z.string(), reason: z.string().max(1000) }).strict();
export const dispatchCursorSchema = z.object({
  version: z.literal(1), url: z.string(), repository: z.string(),
  ticks: z.number().int().min(0).default(0),
  lastTickAt: z.string().nullable().default(null),
  /** The last tick that read the snapshot and ran to the end, and how many ticks have failed since. */
  lastSuccessAt: z.string().nullable().default(null),
  consecutiveFailures: z.number().int().min(0).default(0),
  lastFailure: z.object({ at: z.string(), reason: z.string().max(500) }).strict().nullable().default(null),
  /** Launches that refused, by request id, with the widening retry time; cleared by the launch that succeeds. */
  failures: z.record(z.string(), dispatchFailureSchema).default({}),
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
export async function readDispatchCursor(root: string, config: MasterConfig): Promise<DispatchCursor> {
  const file = dispatchCursorPath(config);
  await assertOutsideWorktrees(root, dirname(file), 'Master dispatch cursor directory');
  let raw: string;
  const withAccounts = async (cursor: DispatchCursor): Promise<DispatchCursor> => {
    const log: EnvironmentLog = await readEnvironmentLog(config);
    return Object.keys(log.environments).length || log.skipped.length ? { ...cursor, accounts: { environments: log.environments, skipped: log.skipped } } : cursor;
  };
  try { raw = await readFile(file, 'utf8'); }
  catch (error: any) { if (error.code === 'ENOENT') return withAccounts(emptyDispatchCursor(config)); throw error; }
  const cursor = dispatchCursorSchema.parse(JSON.parse(raw));
  if (cursor.url !== config.url || cursor.repository.toLowerCase() !== config.repository.toLowerCase()) throw new Error('Master dispatch cursor belongs to another Graphyard server or repository; remove it before running the loop');
  return withAccounts(cursor);
}
export async function writeDispatchCursor(config: MasterConfig, cursor: DispatchCursor) {
  const file = dispatchCursorPath(config), temporary = `${file}.${randomUUID()}.tmp`;
  const { accounts: _accounts, ...persisted } = cursor;
  await writeFile(temporary, JSON.stringify(dispatchCursorSchema.parse(persisted), null, 2), { mode: 0o600, flag: 'wx' });
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
  persist: (cursor: DispatchCursor) => Promise<void>;
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
 * refused. Any other refusal stops at the profile that raised it.
 */
async function launchWithFailover<P extends { name: string }>(profiles: P[], launch: (profile: P) => Promise<unknown>) {
  const failover: string[] = [];
  // Whether every profile so far was passed over for spent quota alone. A logged-out account or an
  // unconfigured environment also fails over, but it is a fault a master can fix now, so it must
  // not turn the role's launches into a wait for a provider reset (GY-89).
  let capacity = true;
  for (const profile of profiles) {
    for (let attempt = 1; ; attempt++) {
      try { await launch(profile); return { profile, failover, relaunched: attempt > 1 }; }
      catch (error: any) {
        if (error?.promptDropped && attempt < 2) continue;
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
  // Herdr unreadable: nothing is launched, because a launch needs the agent inventory to keep
  // one session per profile; the requests wait and the tick says so.
  const agents = herdr ?? [];
  const credentials = await effects.credentials(config.producers);
  const busy = new Set(agents.map(agent => agent.name).filter((name): name is string => !!name));
  const wait = (kind: 'review' | 'producer', item: Work, request: DispatchRequest, reason: string) => tick.waiting.push({ kind, work: item.key, requestId: request.id, sha: request.sha, reason, ...(request.group ? { group: request.group } : {}) });
  const refuse = (kind: 'review' | 'producer', item: Work, request: DispatchRequest, error: unknown) => {
    const previous = cursor.failures[request.id];
    const attempts = (previous?.attempts ?? 0) + 1;
    const failure: DispatchFailure = { kind, work: item.key, sha: request.sha, attempts, reason: message(error).slice(0, 500), at: new Date(now()).toISOString(), nextAt: new Date(now() + retryDelay(attempts)).toISOString() };
    cursor.failures[request.id] = failure;
    tick.refused.push({ ...failure, requestId: request.id });
  };
  // A role out of capacity is not launched again until its accounts are due to be read, and the
  // wait is never a failure: nothing is counted, and the request launches when an account returns.
  const spent = (kind: 'review' | 'producer') => { const hold = cursor.capacity[kind]; return hold && Date.parse(hold.recheckAt) > now() ? hold : null; };
  const capacityWait = (kind: 'review' | 'producer') => `${kind === 'review' ? 'reviewer' : 'producer'} capacity is exhausted (${cursor.capacity[kind]!.reason}); launches are paused and its accounts are read again at ${cursor.capacity[kind]!.recheckAt}`;
  const outOfCapacity = (kind: 'review' | 'producer', item: Work, request: DispatchRequest, error: unknown) => {
    if (!(error as { capacityExhausted?: boolean })?.capacityExhausted) return false;
    cursor.capacity[kind] = { at: cursor.capacity[kind]?.at ?? new Date(now()).toISOString(), recheckAt: new Date(now() + capacityRecheckMs).toISOString(), reason: message(error).slice(0, 1000) };
    delete cursor.failures[request.id];
    wait(kind, item, request, capacityWait(kind));
    return true;
  };
  const retryable = (request: DispatchRequest) => { const failure = cursor.failures[request.id]; return !failure || failure.attempts < dispatchFailureLimit && Date.parse(failure.nextAt) <= now(); };
  // Whether the request already has its session, waits to relaunch one that failed or expired, or may launch now.
  const session = (kind: 'review' | 'producer', item: Work, request: DispatchRequest, records: { requestId?: string; state: string; requestedAt: string; closedAt?: string; resolution?: string }[]) => {
    const retry = sessionRetry(records, request.id, now());
    if (retry.settled) { tick.skipped++; return false; }
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
        if (!profile) wait('review', item, review, reason!);
        else if (busy.has(profile.agentName)) wait('review', item, review, `reviewer agent ${profile.agentName} is busy in Herdr`);
        else {
          // The selected profile answers; the other reviewer profiles are its failover when none of
          // its accounts can launch.
          const order = [profile, ...config.reviewers.filter(other => other.name !== profile.name && !busy.has(other.agentName))];
          try {
            const launched = await launchWithFailover(order, candidate => effects.launchReview(item, review, candidate, agents, observedAt));
            busy.add(launched.profile.agentName); delete cursor.failures[review.id]; delete cursor.capacity.review;
            tick.launched.push({ kind: 'review', work: item.key, requestId: review.id, sha: review.sha, profile: launched.profile.name, ...(launched.failover.length ? { failover: launched.failover } : {}), ...(launched.relaunched ? { relaunched: true } : {}) });
          } catch (error) { if (!outOfCapacity('review', item, review, error)) refuse('review', item, review, error); }
          await effects.persist(cursor);
        }
      }
    }
    for (const request of item.autoDispatch!.producers.filter(entry => entry.state === 'requested')) {
      if (!session('producer', item, request, producers)) continue;
      if (!herdr) { wait('producer', item, request, 'Herdr session inventory is unavailable'); continue; }
      if (spent('producer')) { wait('producer', item, request, capacityWait('producer')); continue; }
      if (!retryable(request)) { wait('producer', item, request, `launch refused ${cursor.failures[request.id].attempts} time(s): ${cursor.failures[request.id].reason}; ${cursor.failures[request.id].attempts >= dispatchFailureLimit ? 'no further automatic attempt' : `next attempt at ${cursor.failures[request.id].nextAt}`}`); continue; }
      const independent = independentProducerProfiles(item, config.producers);
      const usable = independent.filter(profile => credentials[profile.name]?.available !== false && !busy.has(profile.agentName));
      if (!usable.length) {
        wait('producer', item, request, !config.producers.length ? 'no producer profile is configured; add one with master producer add'
          : !independent.length ? `every producer principal (${config.producers.map(profile => profile.principal).join(', ')}) has held an assignment on ${item.key}; its evidence would not be trusted`
          : `every independent producer profile is busy or unavailable (${independent.map(profile => `${profile.name}: ${credentials[profile.name]?.available === false ? credentials[profile.name].reason : 'busy'}`).join('; ')})`);
        continue;
      }
      try {
        const launched = await launchWithFailover(usable, candidate => effects.launchProducer(item, request, candidate, agents, observedAt));
        busy.add(launched.profile.agentName); delete cursor.failures[request.id]; delete cursor.capacity.producer;
        tick.launched.push({ kind: 'producer', work: item.key, requestId: request.id, sha: request.sha, profile: launched.profile.name, group: request.group, proofs: request.proofs, ...(launched.failover.length ? { failover: launched.failover } : {}), ...(launched.relaunched ? { relaunched: true } : {}) });
      } catch (error) { if (!outOfCapacity('producer', item, request, error)) refuse('producer', item, request, error); }
      await effects.persist(cursor);
    }
  }
  // A failure for a request the control plane resolved is history the cursor need not keep.
  const live = new Set(snapshot.work.flatMap(work => [...(work.autoDispatch?.review ? [work.autoDispatch.review.id] : []), ...(work.autoDispatch?.producers ?? []).map(request => request.id)]));
  for (const id of Object.keys(cursor.failures)) if (!live.has(id)) delete cursor.failures[id];
  cursor.ticks += 1; cursor.lastTickAt = cursor.lastSuccessAt = new Date(now()).toISOString(); cursor.consecutiveFailures = 0;
  await effects.persist(cursor);
  return tick;
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
  let refused: string | null = null;
  do {
    if (options.signal?.aborted) break;
    const interval = typeof options.intervalMs === 'function' ? options.intervalMs() : options.intervalMs;
    let wait = interval;
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
    } catch (error) {
      // A failed tick launched nothing it has not already recorded, so it is retried promptly;
      // the cursor keeps the streak so master status can say how long dispatch has been blind.
      cursor.consecutiveFailures += 1; cursor.lastFailure = { at: new Date(now()).toISOString(), reason: message(error).slice(0, 500) };
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
export function dispatchEffects(root: string, config: MasterConfig | (() => MasterConfig), deps: { snapshot: () => Promise<{ work: Work[]; now: string }>; run?: (command: string, args: string[]) => string }): DispatchEffects {
  const run = deps.run ?? ((command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 }));
  const current = typeof config === 'function' ? config : () => config;
  return {
    snapshot: deps.snapshot,
    agents: () => { try { return listHerdrAgents(run); } catch { return null; } },
    credentials: profiles => inspectProducerCredentials(root, profiles),
    reconcileReviews: (work, agents) => reconcileReviews(root, current(), { run, work, agents }),
    reconcileProducers: (work, agents) => reconcileProducers(root, current(), work, agents, { run }),
    launchReview: (work, request, profile, agents, observedAt) => launchReview(root, work, profile.name, agents, observedAt, { run, requestId: request.id }),
    launchProducer: (work, request, profile, agents, observedAt) => launchProducer(root, work, request, profile, agents, observedAt, { run }),
    persist: cursor => writeDispatchCursor(current(), cursor),
  };
}

/** The compact dispatcher view `master status` joins onto the per-candidate requests. */
export function dispatchSummary(cursor: DispatchCursor, now: number, intervalMs: number) {
  const lastTickAt = cursor.lastTickAt ? Date.parse(cursor.lastTickAt) : Number.NaN;
  const lagMs = Number.isFinite(lastTickAt) ? now - lastTickAt : null;
  return { running: lagMs !== null && lagMs < Math.max(3 * intervalMs, 60_000), ticks: cursor.ticks, lastTickAt: cursor.lastTickAt, lagMs, intervalMs,
    lastSuccessAt: cursor.lastSuccessAt, consecutiveFailures: cursor.consecutiveFailures, lastFailure: cursor.lastFailure,
    failures: Object.entries(cursor.failures).map(([requestId, failure]) => ({ requestId, ...failure })),
    // A role with no account left, as one entry per role rather than a failure per request.
    capacity: Object.entries(cursor.capacity ?? {}).map(([kind, hold]) => ({ role: kind === 'review' ? 'reviewer' : 'producer', ...hold })),
    // Each agent account as the last launch check saw it, and the launches that skipped one and why.
    accounts: cursor.accounts ? {
      environments: Object.values(cursor.accounts.environments).map((health: any) => ({ environment: health.name, kind: health.kind, loggedIn: health.loggedIn, quota: health.quota, healthy: health.healthy, reason: health.reason, usage: health.usage, login: health.login, checkedAt: health.checkedAt })),
      skipped: cursor.accounts.skipped.slice(-20),
    } : { environments: [], skipped: [] } };
}
