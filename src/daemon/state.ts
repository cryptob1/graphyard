import { readlinkSync } from 'node:fs';
import { writeFile, chmod } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { assertOutsideWorktrees } from '../private-file.js';
import { writeFailure, diskExhaustionMessage, reclaimAdvice } from '../disk-space.js';
import { forwardTolerant } from '../master/profiles.js';
import { boundDetail, actionDetailMax } from './text.js';
// Concern: the daemon cursor — its schema, persistence, bounds and single-writer lock.
import { randomUUID } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { z } from 'zod';
import { type MasterConfig } from '../master/profiles.js';
import { emptyProjectMemory, projectMemorySchema } from '../model/project-memory.js';
import { emptyMergeWriterState, mergeWriterStateSchema } from './merge-writer-state.js';
import { continuitySchema } from '../master/conversation.js';

// 'diagnosis' stays a kind a cursor may hold: the diagnostician's rows (GY-439, retired by GY-2186) still load, and nothing new records one.
// A cursor's rows of the retired 'decision' and 'escalation' kinds (GY-2874) load as 'judgement' and 'attention'.
const retiredActionKinds: Record<string, string> = { decision: 'judgement', escalation: 'attention' };
export const daemonActionKinds = ['close', 'dispatch', 'review', 'refresh', 'proof', 'merge', 'deployment', 'smoke', 'attention', 'config', 'session', 'reclaim', 'judgement', 'scope', 'settle', 'failover', 'capacity', 'human', 'preserve', 'fault', 'diagnosis', 'wake', 'blocker'] as const;
export type DaemonActionKind = typeof daemonActionKinds[number];
/** The most an action's detail may carry: daemonActionSchema's bound, which record() enforces. */
export { actionDetailMax } from './text.js';
export const daemonActionSchema = z.object({
  kind: z.preprocess(kind => retiredActionKinds[kind as string] ?? kind, z.enum(daemonActionKinds)),
  work: z.string().nullable().default(null),
  principal: z.string().nullable().default(null),
  state: z.enum(['started', 'done', 'failed', 'indeterminate', 'waiting']),
  detail: z.string().max(actionDetailMax),
  attempts: z.number().int().min(0).max(1000).default(1),
  // The item's attempt epoch when the action started. A dispatch that lands always advances it,
  // which is what separates a landed assignment from a submission left over from an earlier one.
  epoch: z.number().int().min(0).nullable().default(null),
  cycle: z.number().int().min(0),
  at: z.string(),
  /** Set on a refused merge (GY-831): when the guarded merge first gave the refusal this detail names, unchanged since. */
  since: z.string().optional(),
  /** Set on an owed launch coordinate (GY-1895): the exact write to send again — the item and the launch's own handle — so a restarted loop resends it, never retiring it unsent. */
  owed: z.object({ work: z.object({ id: z.string(), key: z.string() }).strict(), handle: z.record(z.string(), z.unknown()) }).strict().optional(),
  /** Set on a spec-check launch (GY-2992): the session's pane, which the loop closes once the report lands or the launch expires. */
  pane: z.string().max(200).optional(),
  /** The registered spec-check launch this pane answers; absent on older cursors. */
  specCheckLaunch: z.string().max(200).optional(),
}).strict();
export type DaemonAction = z.infer<typeof daemonActionSchema>;

export const cycleMetricsSchema = z.object({
  cycle: z.number().int().min(0), at: z.string(),
  open: z.number().int().min(0), actions: z.number().int().min(0),
  /** The steps the cycle ran, in order: snapshot, close, dispatch, merge writer, persist. A cursor written before recorded step costs here, which read as absent. */
  steps: z.preprocess(steps => Array.isArray(steps) && steps.every(step => typeof step === 'string') ? steps : undefined, z.array(z.string().max(40)).max(10).optional()),
}).strip();
export type CycleMetrics = z.infer<typeof cycleMetricsSchema>;

/**
 * The loop's own failures (GY-119). A cycle that throws — a control-plane read that timed out, a runtime call that failed, a
 * configuration reload that could not be read — is a failed cycle, not the end of the process: it is recorded here, the cycle counter
 * advances, and the next cycle runs after a delay that grows with the consecutive count. An unhandled rejection or uncaught exception
 * anywhere in the process — a detached promise in the dispatcher, a Herdr read — is caught at the process level and
 * counted here too. The supervisor's restart is reserved for a process that hangs, which the watchdog detects; nothing here ends the process.
 */
export const cycleFailureSchema = z.object({
  /** Failed cycles since the last one that completed; the backoff and the attention item read it. */
  consecutive: z.number().int().min(0).default(0),
  /** Every failed cycle this cursor has seen, so a loop that fails and recovers still says so. */
  total: z.number().int().min(0).default(0),
  last: z.object({
    cycle: z.number().int().min(0), at: z.string(),
    /** Where the rejection escaped from: the cycle itself, or the configuration reload before it. */
    phase: z.enum(['cycle', 'reload']),
    /** The effect that threw (`snapshot`, `credentials`, `merge`, ...), when one can be named; the reload is `reload`. */
    call: z.string().max(100).nullable().default(null),
    reason: z.string().max(1000),
    /** The delay chosen before the next cycle, and when that cycle is due. */
    delayMs: z.number().int().min(0), nextAt: z.string(),
  }).strict().nullable().default(null),
  /** Unhandled rejections and uncaught exceptions the process caught and survived. */
  unhandled: z.number().int().min(0).default(0),
  lastUnhandled: z.object({ at: z.string(), origin: z.enum(['unhandledRejection', 'uncaughtException']), reason: z.string().max(1000), cycle: z.number().int().min(0) }).strict().nullable().default(null),
}).strict();
export type CycleFailures = z.infer<typeof cycleFailureSchema>;

/** The release this loop's own process loaded, read once at its startup (GY-437) and overwritten by every new process: what every action it takes runs, until its supervisor replaces it. */
export const loopReleaseSchema = z.object({ commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(), dirty: z.boolean().nullable() }).strict();
export type LoopRelease = z.infer<typeof loopReleaseSchema>;

/**
 * What the loop last saw of the master session it launches and supervises (GY-898): the handle it
 * launched (or adopted), the registry session and account it holds, the rotation count and why the
 * last one ended, and the wake bookkeeping — the subject digests last named, so an unchanged cause
 * never wakes twice, and the last wake's time and causes. All of it is cursor state: a restarted
 * loop adopts the live session from this record and its Herdr name rather than launching a second.
 */
const masterSessionRecordSchema = z.object({
  /** Native conversation identity; independent of the registry allocation and retained on rotation. */
  continuity: continuitySchema.nullable().default(null),
  /** Immutable pre-upgrade launch request, retained before its named delivery file is reused. */
  launchRequestRecord: z.string().nullable().default(null),
  agentName: z.string().max(200).nullable().default(null),
  pane: z.string().max(200).nullable().default(null),
  runtime: z.string().max(40).nullable().default(null),
  /** The account the registry's master role chose, held so its exhaustion holds the right account. */
  account: z.string().max(200).nullable().default(null),
  /** The agent registry session the launch holds; ended when the session is replaced. */
  session: z.string().max(200).nullable().default(null),
  /** When this session started (a launch, or the moment the loop adopted one it found live). */
  startedAt: z.string().nullable().default(null),
  /** Whether the record came from adopting a session the loop did not launch. */
  adopted: z.boolean().default(false),
  rotations: z.number().int().min(0).default(0),
  /** Why the last session ended and when: exited, exhausted, or budget. */
  lastEnd: z.object({ cause: z.string().max(40), at: z.string(), detail: z.string().max(500) }).strict().nullable().default(null),
  /** The account hold a provider limit notice on the pane recorded (GY-2949): the instant the account resets. Cleared when a session launches or is adopted. */
  limitedUntil: z.string().nullable().default(null),
  /** The last wake: when, the subject keys it named (empty for a heartbeat), and whether it was the heartbeat. */
  lastWake: z.object({ at: z.string(), causes: z.array(z.string().max(60)).max(20), heartbeat: z.boolean() }).strict().nullable().default(null),
  /** Consecutive liveness misses: an exit is established on the second. */
  misses: z.number().int().min(0).default(0),
  /** True from hand-off until the launch settles, so no cycle doubles it. */
  launching: z.boolean().default(false),
  /**
   * Per subject key, the digest of its detail when it was last woken about (or first seen). It is
   * never cut to a count: it tracks exactly the current actionable subjects (pruned to them every
   * cycle, each carrying its detail), and a digest dropped for a bound would read as a changed
   * subject and wake the session every cycle with no event.
   */
  subjects: z.record(z.string().max(60), z.string().max(40)).default({}),
  /**
   * Registry sessions an ended or failed launch could not give back: the master role runs one
   * session at a time, so a leaked row would refuse every relaunch. Each is ended again every cycle
   * until the registry takes it back, or until the registry's own session cap has ended it.
   */
  unreleased: z.array(z.object({ session: z.string().max(200), since: z.string(), reason: z.string().max(300) }).strict()).max(20).default([]),
}).strict();
export const masterSessionSchema = masterSessionRecordSchema.extend({
  /** Unread histories remain addressable with their original session and delivery provenance. */
  recoveryFailures: z.array(z.object({ at: z.string(), error: z.string(), master: masterSessionRecordSchema }).strict()).default([]),
});
export type MasterSessionState = z.infer<typeof masterSessionSchema>;
export const emptyMasterSession = (): MasterSessionState => masterSessionSchema.parse({});
/**
 * The master session's one reading (GY-2949): `working`, `idle` (when Herdr reports the pane idle),
 * `limited until T` while the account hold a limit notice recorded stands, and `absent` once the pane
 * is closed with no hold standing. An unreadable screen or unknown runtime never reads working.
 */
export function masterSessionState(master: MasterSessionState, now: number, agent?: { agent_status?: string }, screen?: string | null) {
  if (master.agentName) {
    if (screen === null) return 'screen unreadable';
    return agent?.agent_status ?? 'unknown';
  }
  if (master.limitedUntil && Date.parse(master.limitedUntil) > now) return `limited until ${master.limitedUntil}`;
  return 'absent';
}
/** The master line of the daemon summary (GY-898); the session and heartbeat budgets are added by the reader from its config. */
export function masterSummary(master: MasterSessionState, now: number, agent?: { agent_status?: string; pane_id?: string }, screen?: string | null) {
  const startedAt = master.startedAt ? Date.parse(master.startedAt) : Number.NaN;
  return { session: master.agentName, pane: agent?.pane_id ?? master.pane, runtime: master.runtime, account: master.account, adopted: master.adopted,
    startedAt: master.startedAt, ageMs: Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : null,
    recoveryFailures: master.recoveryFailures,
    rotations: master.rotations, lastEnd: master.lastEnd, lastWake: master.lastWake, launching: master.launching,
    state: masterSessionState(master, now, agent, screen) };
}

export const daemonStateSchema = z.object({
  version: z.literal(1), url: z.string(), repository: z.string(),
  /** `pidNamespace` (GY-1370): the PID namespace the pid was taken in, absent on a lock written before it was recorded. */
  lock: z.object({ id: z.string(), pid: z.number().int().positive(), host: z.string(), startedAt: z.string(), heartbeatAt: z.string(), pidNamespace: z.string().max(100).nullable().optional() }).strict().nullable().default(null),
  cycle: z.number().int().min(0).default(0),
  lastCycleAt: z.string().nullable().default(null),
  actions: z.record(z.string(), daemonActionSchema).default({}),
  profiles: z.record(z.string(), z.object({ failures: z.number().int().min(0), reason: z.string().max(500).nullable(), cooldownUntil: z.string().nullable() }).strict()).default({}),
  metrics: z.array(cycleMetricsSchema).default([]),
  mergeWriter: mergeWriterStateSchema.default(() => emptyMergeWriterState()), // GY-1524: the control-plane merge executor's queue, flight, last delivery and refusals
  /** The release the running loop process loaded, recorded by each process at its startup (GY-437). */
  release: loopReleaseSchema.nullable().default(null),
  /** The last reload of .graphyard/master.json: what the running loop adopted, or why it refused. */
  config: z.object({ at: z.string(), changed: z.array(z.string().max(100)).max(100), refused: z.string().max(1000).nullable() }).strict().nullable().default(null),
  /** How the loop itself has been failing, as distinct from the steps it runs (see `cycleFailureSchema`). */
  failures: cycleFailureSchema.default({ consecutive: 0, total: 0, last: null, unhandled: 0, lastUnhandled: null }),
  /** The master session the loop launches, adopts, wakes and rotates (GY-898); see `masterSessionSchema`. */
  master: masterSessionSchema.default(() => emptyMasterSession()),
  personalMasters: z.record(z.string(), masterSessionSchema).default({}),
  /** The control plane the snapshot could not reach (GY-2966): since when, and on a compose install the loop's last `docker compose up -d` with the server's last exit and the free disk space; null while it answers. */
  controlPlane: z.object({ unreachableSince: z.string(), error: z.string().max(1000), restartedAt: z.string().nullable(), restart: z.string().max(1000).nullable(), exitReason: z.string().max(1000).nullable(), freeDisk: z.string().max(500).nullable() }).strict().nullable().default(null),
  /** Shared project memory (GY-1125): recent decisions and merges. */
  projectMemory: projectMemorySchema.default(() => emptyProjectMemory()),
}).strip();
export type DaemonState = z.infer<typeof daemonStateSchema>;

/**
 * GY-1851: set the cursor aside so the next loop starts a fresh one, as a reinstall onto a fresh
 * database needs. It is kept beside itself as `NAME.daemon.archived-STAMP.json`, never deleted;
 * the archive's path and the cycle the cursor had reached come back, or null when there was none.
 */
export async function archiveDaemonCursor(config: Pick<MasterConfig, 'credentialFile'>, now = new Date()): Promise<{ file: string; cycle: number } | null> {
  const file = daemonStatePath(config as MasterConfig);
  let raw: string;
  try { raw = await readFile(file, 'utf8'); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  let cycle = 0;
  try { cycle = clampCount(Number(JSON.parse(raw)?.cycle), Number.MAX_SAFE_INTEGER); } catch { /* an unreadable cursor is archived all the same */ }
  const archive = file.replace(/\.json$/, `.archived-${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`);
  await rename(file, archive);
  return { file: archive, cycle };
}

/**
 * The cursor validates declared fields and preserves unknown fields from newer or retired versions.
 */
let tolerated: typeof daemonStateSchema | undefined;
const toleratedStateSchema = () => tolerated ??= forwardTolerant(daemonStateSchema);
/**
 * GY-1960: a cursor record the loop rewrites from what it declares (its release, its latest
 * reload) keeps the fields a newer loop wrote under it. `next` sets every declared field, so only
 * the undeclared ones of `previous` survive under it; a null `next` clears the record as before.
 */
export const carryUndeclared = <T extends object | null>(previous: object | null | undefined, next: T): T => previous && next ? { ...previous, ...next } : next;
export const retainedActions = 500, retainedMetrics = 100, profileCooldownMs = 600_000, maxProofAttempts = 3;

export function emptyDaemonState(config: MasterConfig): DaemonState {
  return daemonStateSchema.parse({ version: 1, url: config.url, repository: config.repository });
}

/** Derived from the coordinator credential, so the cursor lives beside it and never inside a worktree. */
export function daemonStatePath(config: MasterConfig) {
  return besideCursor(config, 'daemon');
}
/** A file beside the loop's cursor, under the credential's private directory. */
export const besideCursor = (config: Pick<MasterConfig, 'credentialFile'>, suffix: string) =>
  resolve(dirname(config.credentialFile), `${basename(config.credentialFile).replace(/\.token$/, '')}.${suffix}.json`);

export async function readDaemonState(root: string, config: MasterConfig): Promise<DaemonState> {
  const file = daemonStatePath(config);
  await assertOutsideWorktrees(root, dirname(file), 'Master daemon state directory');
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (error: any) { if (error.code === 'ENOENT') return emptyDaemonState(config); throw error; }
  // Preserve unknown cursor fields across reads and writes, including keys retired from the schema.
  const stored = JSON.parse(raw);
  for (const action of Object.values<Record<string, unknown>>(stored.actions ?? {})) delete action.faultClass;
  delete (stored.mergeWriter as Record<string, unknown> | undefined)?.advisory;
  const state = toleratedStateSchema().parse(stored);
  if (state.url !== config.url || state.repository.toLowerCase() !== config.repository.toLowerCase()) throw new Error('Master daemon state belongs to another Graphyard server or repository; remove it before running the loop');
  return state;
}

export async function writeDaemonState(config: MasterConfig, state: DaemonState) {
  const file = daemonStatePath(config), temporary = `${file}.${randomUUID()}.tmp`;
  // The cursor is written twice per external action, so it is usually the first thing a full
  // volume stops. Saying so is the difference between a disk to reclaim and a mystery.
  try {
    await writeFile(temporary, JSON.stringify(toleratedStateSchema().parse(boundDaemonState(state)), null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } catch (error) { throw writeFailure(error, 'Writing the master daemon cursor'); }
  await chmod(file, 0o600);
}

/** Keep the cursor bounded without ever discarding an unresolved action. */
export function pruneDaemonState(state: DaemonState) {
  const entries = Object.entries(state.actions);
  const resolved = entries.filter(([key, action]) => action.state === 'done' || action.state === 'failed' && !key.startsWith('early-exit:'));
  if (resolved.length > retainedActions) {
    for (const [key] of resolved.sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at)).slice(0, resolved.length - retainedActions)) delete state.actions[key];
  }
  if (state.metrics.length > retainedMetrics) state.metrics = state.metrics.slice(-retainedMetrics);
  return state;
}

/**
 * Fit every bounded field of the cursor to its schema bound, in place (GY-187). The schema is the
 * cursor's contract, and parsing it is the last step of every write — so a value over its bound
 * (a delivered list longer than 200, a refusal quoted in full, an attempt counter past 1000) used
 * to fail that write, and with it the whole cycle, on every cycle until somebody edited the file.
 * Truncation loses the tail of a long string or the oldest entries of a long list; failing the
 * write loses the cycle. Counts are clamped, never reset, so a backoff keeps its place.
 */
export const clampCount = (value: number, max: number) => Math.min(max, Math.max(0, Math.floor(Number.isFinite(value) ? value : 0)));

/**
 * Every write of an action goes through here. The detail is bounded here, before the schema sees
 * it, so a caller that quotes a long error or path list cannot fail every cycle with an over-long
 * string (GY-179).
 */
export function storeAction(state: DaemonState, key: string, action: DaemonAction): DaemonAction {
  const entry = daemonActionSchema.parse({ ...action, detail: boundDetail(action.detail), attempts: clampCount(action.attempts, 1000) });
  state.actions[key] = entry;
  return entry;
}
/** A refusal that still stands, observed again with the same detail (GY-1086): its row is not rewritten, but its time moves. */
export function touchStanding(state: DaemonState, key: string, at: string) {
  const row = state.actions[key];
  if (row && row.state === 'failed') row.at = at;
}
const cut = <T extends string | null | undefined>(value: T, max: number): T => (typeof value === 'string' && value.length > max ? boundDetail(value, max) : value) as T;
export function boundDaemonState(state: DaemonState): DaemonState {
  for (const action of Object.values(state.actions)) {
    action.detail = boundDetail(action.detail);
    action.attempts = clampCount(action.attempts, 1000);
  }
  for (const profile of Object.values(state.profiles)) profile.reason = cut(profile.reason, 500);
  if (state.config) state.config = { ...state.config, changed: state.config.changed.slice(0, 100).map(entry => cut(entry, 100)), refused: cut(state.config.refused, 1000) };
  if (state.controlPlane) state.controlPlane = { ...state.controlPlane, error: cut(state.controlPlane.error, 1000), restart: cut(state.controlPlane.restart, 1000), exitReason: cut(state.controlPlane.exitReason, 1000), freeDisk: cut(state.controlPlane.freeDisk, 500) };
  if (state.master) {
    state.master.agentName = cut(state.master.agentName, 200);
    state.master.pane = cut(state.master.pane, 200);
    state.master.account = cut(state.master.account, 200);
    state.master.session = cut(state.master.session, 200);
    if (state.master.lastEnd) state.master.lastEnd = { ...state.master.lastEnd, cause: cut(state.master.lastEnd.cause, 40), detail: cut(state.master.lastEnd.detail, 500) };
    if (state.master.lastWake) state.master.lastWake = { ...state.master.lastWake, causes: state.master.lastWake.causes.slice(-20).map(cause => cut(cause, 60)) };
    state.master.unreleased = state.master.unreleased.slice(-20).map(entry => ({ ...entry, session: cut(entry.session, 200), reason: cut(entry.reason, 300) }));
  }
  const failures = state.failures;
  if (failures.last) Object.assign(failures.last, { call: cut(failures.last.call, 100), reason: cut(failures.last.reason, 1000) });
  if (failures.lastUnhandled) failures.lastUnhandled.reason = cut(failures.lastUnhandled.reason, 1000);
  if (state.projectMemory) {
    state.projectMemory.notes = (state.projectMemory.notes ?? []).slice(0, 50);
    state.projectMemory.changes = (state.projectMemory.changes ?? []).slice(0, 50);
  }
  return state;
}
/**
 * This process's PID namespace (`pid:[4026531836]`), or null where /proc does not say (not Linux).
 * A pid means something only in the namespace it was taken in (GY-1370): a sandbox with its own
 * PID namespace sees none of the host's processes, so its probe of a host pid always reads gone.
 */
export const pidNamespace = () => { try { return readlinkSync('/proc/self/ns/pid'); } catch { return null; } };
/** The host's initial PID namespace (the kernel's PROC_PID_INIT_INO), which a lock written before GY-1370 was taken in. */
export const initialPidNamespace = 'pid:[4026531836]';
export const liveProcess = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; } };

/**
 * One loop per repository. A second daemon would duplicate dispatch, so a live lock refuses. A
 * lock left behind by a killed daemon is reclaimed as soon as its process is demonstrably gone,
 * which is what makes kill-and-restart resume rather than wait out a timeout.
 */
export function acquireDaemonLock(state: DaemonState, identity: { pid: number; host: string }, now: number, intervalMs: number) {
  const lock = state.lock;
  const staleAfterMs = Math.max(3 * intervalMs, 120_000);
  if (lock) {
    const age = now - Date.parse(lock.heartbeatAt);
    const sameHost = lock.host === identity.host;
    const alive = sameHost ? lock.pid !== identity.pid && liveProcess(lock.pid) : !Number.isFinite(age) || age < staleAfterMs;
    if (alive) throw new Error(`Another Graphyard master loop holds this repository (pid ${lock.pid} on ${lock.host}, last cycle ${lock.heartbeatAt}); stop it before starting a second daemon`);
  }
  state.lock = { id: randomUUID(), pid: identity.pid, host: identity.host, startedAt: new Date(now).toISOString(), heartbeatAt: new Date(now).toISOString(), pidNamespace: pidNamespace() };
  return state.lock;
}

/**
 * Every failure the cycle records passes through here. A command that failed because the host
 * ran out of room keeps its own output and gains the name of the condition, so the action reads
 * as a disk to reclaim rather than as an unexplained command error.
 */
export const message = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error), exhausted = diskExhaustionMessage(error);
  // An error already reported as disk exhaustion is not explained twice.
  return exhausted && !text.includes(reclaimAdvice) ? `${text} — ${exhausted}` : text;
};
