import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Work } from './model.js';
import type { DispatchRequest } from './model/dispatch.js';
import { assertOutsideWorktrees, inspectProducerCredentials, listHerdrAgents, type ConfigReload, type HerdrAgent, type MasterConfig, type ProducerProfile, type ReviewerProfile } from './master.js';
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
export const dispatchCursorSchema = z.object({
  version: z.literal(1), url: z.string(), repository: z.string(),
  ticks: z.number().int().min(0).default(0),
  lastTickAt: z.string().nullable().default(null),
  /** Launches that refused, by request id, with the widening retry time; cleared by the launch that succeeds. */
  failures: z.record(z.string(), dispatchFailureSchema).default({}),
}).strict();
export type DispatchCursor = z.infer<typeof dispatchCursorSchema>;

/** A refused launch retries on a widening interval, never more often than this and never later than this. */
export const dispatchRetryMinMs = 30_000, dispatchRetryMaxMs = 600_000, dispatchFailureLimit = 12;

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
  try { raw = await readFile(file, 'utf8'); }
  catch (error: any) { if (error.code === 'ENOENT') return emptyDispatchCursor(config); throw error; }
  const cursor = dispatchCursorSchema.parse(JSON.parse(raw));
  if (cursor.url !== config.url || cursor.repository.toLowerCase() !== config.repository.toLowerCase()) throw new Error('Master dispatch cursor belongs to another Graphyard server or repository; remove it before running the loop');
  return cursor;
}
export async function writeDispatchCursor(config: MasterConfig, cursor: DispatchCursor) {
  const file = dispatchCursorPath(config), temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(dispatchCursorSchema.parse(cursor), null, 2), { mode: 0o600, flag: 'wx' });
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

export interface DispatchLaunch { kind: 'review' | 'producer'; work: string; requestId: string; sha: string; profile: string; group?: string; proofs?: string[] }
export interface DispatchWait { kind: 'review' | 'producer'; work: string; requestId: string; sha: string; reason: string; group?: string }
export interface DispatchTick { at: string; launched: DispatchLaunch[]; refused: (DispatchFailure & { requestId: string })[]; waiting: DispatchWait[]; skipped: number }

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const retryDelay = (attempts: number) => Math.min(dispatchRetryMinMs * 2 ** Math.max(0, attempts - 1), dispatchRetryMaxMs);

/**
 * One tick: settle the sessions the ledgers hold against the snapshot, then launch a session for
 * every open request that has none. Each launch is recorded by the launcher's own ledger before
 * the tick moves on, so a kill between two launches leaves nothing to repeat.
 */
export async function runDispatchTick(config: MasterConfig, cursor: DispatchCursor, effects: DispatchEffects, now: () => number = Date.now): Promise<DispatchTick> {
  const snapshot = await effects.snapshot();
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
      else if (!retryable(review)) wait('review', item, review, `launch refused ${cursor.failures[review.id].attempts} time(s): ${cursor.failures[review.id].reason}; ${cursor.failures[review.id].attempts >= dispatchFailureLimit ? 'no further automatic attempt, launch it with master review once the cause is fixed' : `next attempt at ${cursor.failures[review.id].nextAt}`}`);
      else {
        const { profile, reason } = selectReviewerProfile(config);
        if (!profile) wait('review', item, review, reason!);
        else if (busy.has(profile.agentName)) wait('review', item, review, `reviewer agent ${profile.agentName} is busy in Herdr`);
        else {
          try {
            await effects.launchReview(item, review, profile, agents, observedAt);
            busy.add(profile.agentName); delete cursor.failures[review.id];
            tick.launched.push({ kind: 'review', work: item.key, requestId: review.id, sha: review.sha, profile: profile.name });
          } catch (error) { refuse('review', item, review, error); }
          await effects.persist(cursor);
        }
      }
    }
    for (const request of item.autoDispatch!.producers.filter(entry => entry.state === 'requested')) {
      if (!session('producer', item, request, producers)) continue;
      if (!herdr) { wait('producer', item, request, 'Herdr session inventory is unavailable'); continue; }
      if (!retryable(request)) { wait('producer', item, request, `launch refused ${cursor.failures[request.id].attempts} time(s): ${cursor.failures[request.id].reason}; ${cursor.failures[request.id].attempts >= dispatchFailureLimit ? 'no further automatic attempt' : `next attempt at ${cursor.failures[request.id].nextAt}`}`); continue; }
      const independent = independentProducerProfiles(item, config.producers);
      const free = independent.find(profile => credentials[profile.name]?.available !== false && !busy.has(profile.agentName));
      if (!free) {
        wait('producer', item, request, !config.producers.length ? 'no producer profile is configured; add one with master producer add'
          : !independent.length ? `every producer principal (${config.producers.map(profile => profile.principal).join(', ')}) has held an assignment on ${item.key}; its evidence would not be trusted`
          : `every independent producer profile is busy or unavailable (${independent.map(profile => `${profile.name}: ${credentials[profile.name]?.available === false ? credentials[profile.name].reason : 'busy'}`).join('; ')})`);
        continue;
      }
      try {
        await effects.launchProducer(item, request, free, agents, observedAt);
        busy.add(free.agentName); delete cursor.failures[request.id];
        tick.launched.push({ kind: 'producer', work: item.key, requestId: request.id, sha: request.sha, profile: free.name, group: request.group, proofs: request.proofs });
      } catch (error) { refuse('producer', item, request, error); }
      await effects.persist(cursor);
    }
  }
  // A failure for a request the control plane resolved is history the cursor need not keep.
  const live = new Set(snapshot.work.flatMap(work => [...(work.autoDispatch?.review ? [work.autoDispatch.review.id] : []), ...(work.autoDispatch?.producers ?? []).map(request => request.id)]));
  for (const id of Object.keys(cursor.failures)) if (!live.has(id)) delete cursor.failures[id];
  cursor.ticks += 1; cursor.lastTickAt = new Date(now()).toISOString();
  await effects.persist(cursor);
  return tick;
}

/** Tick until stopped. Runs beside the daemon in `master run`; the signal is the daemon's stop. */
export async function runAutoDispatch(config: MasterConfig, cursor: DispatchCursor, effects: DispatchEffects, options: { intervalMs: number | (() => number); once?: boolean; signal?: AbortSignal; now?: () => number; log?: (line: string) => void;
  /** Re-reads .graphyard/master.json before each tick, so a changed profile or run setting applies without a restart. */
  reload?: () => Promise<ConfigReload> }) {
  const now = options.now ?? Date.now, log = options.log ?? (line => console.error(line));
  const ticks: DispatchTick[] = [];
  let refused: string | null = null;
  do {
    if (options.signal?.aborted) break;
    try {
      if (options.reload) {
        const reload = await options.reload();
        config = reload.config;
        if (reload.changed.length) log(`[graphyard-dispatch] adopted master.json changes: ${reload.changed.join(', ')}`);
        if (reload.refused && reload.refused !== refused) log(`[graphyard-dispatch] ${reload.refused}`);
        refused = reload.refused;
      }
      const tick = await runDispatchTick(config, cursor, effects, now);
      ticks.push(tick);
      for (const launch of tick.launched) log(`[graphyard-dispatch] launched ${launch.kind} for ${launch.work} ${launch.sha.slice(0, 12)} on ${launch.profile}${launch.group ? ` (${launch.group}: ${launch.proofs?.join(', ')})` : ''}`);
      for (const refusal of tick.refused) log(`[graphyard-dispatch] ${refusal.kind} launch for ${refusal.work} refused (attempt ${refusal.attempts}): ${refusal.reason}`);
    } catch (error) { log(`[graphyard-dispatch] tick failed: ${message(error)}`); }
    if (options.once || options.signal?.aborted) break;
    try { await delay(typeof options.intervalMs === 'function' ? options.intervalMs() : options.intervalMs, undefined, { signal: options.signal }); } catch { /* woken to stop */ }
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
    failures: Object.entries(cursor.failures).map(([requestId, failure]) => ({ requestId, ...failure })) };
}
