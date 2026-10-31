// Concern: the daemon cursor — its schema, persistence, bounds and single-writer lock.
import { randomUUID } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { z } from 'zod';
import { type MasterConfig } from '../master.js';
import { emptyProjectMemory, projectMemorySchema } from '../model/project-memory.js';
import { emptyMergeWriterState, mergeWriterStateSchema } from './cycle-merge-writer.js'; // lazy: it imports this module

// 'diagnosis' stays a kind a cursor may hold: the diagnostician's rows (GY-439, retired by GY-2186) still load, and nothing new records one.
// A cursor's rows of the retired 'decision' and 'escalation' kinds (GY-2874) load as 'judgement' and 'attention'.
const retiredActionKinds: Record<string, string> = { decision: 'judgement', escalation: 'attention' };
export const daemonActionKinds = ['close', 'dispatch', 'review', 'refresh', 'proof', 'merge', 'deployment', 'smoke', 'attention', 'config', 'session', 'reclaim', 'judgement', 'scope', 'settle', 'failover', 'capacity', 'human', 'preserve', 'fault', 'diagnosis', 'wake', 'blocker'] as const;
export type DaemonActionKind = typeof daemonActionKinds[number];
/** The most an action's detail may carry: daemonActionSchema's bound, which record() enforces. */
export const actionDetailMax = 2000;
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
}).strict();
export type DaemonAction = z.infer<typeof daemonActionSchema>;

/** A field a release retired: an older cursor's value still parses. */
const retired = z.unknown().optional();
export const cycleMetricsSchema = z.object({
  cycle: z.number().int().min(0), at: z.string(),
  open: z.number().int().min(0), actions: z.number().int().min(0),
  /** Retired (GY-2877): what the cycle could act on. */
  actionable: retired,
  /** The steps the cycle ran, in order: snapshot, close, dispatch, merge writer, persist. A cursor written before recorded step costs here, which read as absent. */
  steps: z.preprocess(steps => Array.isArray(steps) && steps.every(step => typeof step === 'string') ? steps : undefined, z.array(z.string().max(40)).max(10).optional()),
  /** Retired (GY-2876): the cycle's durations and call timings, and the stage, lead-time and post-deploy measurements; a cursor written before still parses. */
  durationMs: retired, childWaitMs: retired, workMs: retired, planeWaitMs: retired, timings: retired,
  stages: retired, lead: retired, production: retired, postDeploy: retired, postDeployFailures: retired,
  /** Retired (GY-1992): the scope-request latency and the idle reading; nothing writes them, and a cursor written before keeps parsing. */
  idleMs: retired, scope: retired, scopeOpenMs: retired,
}).strict();
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
export const masterSessionSchema = z.object({
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
export type MasterSessionState = z.infer<typeof masterSessionSchema>;
export const emptyMasterSession = (): MasterSessionState => masterSessionSchema.parse({});
/**
 * The master session's one reading (GY-2949): `working`, `idle` (when Herdr reports the pane idle),
 * `limited until T` while the account hold a limit notice recorded stands, and `absent` once the pane
 * is closed with no hold standing — the states `master status` shows on its one page.
 */
export function masterSessionState(master: MasterSessionState, now: number, agent?: { agent_status?: string }) {
  if (master.agentName) return agent?.agent_status === 'idle' ? 'idle' : 'working';
  if (master.limitedUntil && Date.parse(master.limitedUntil) > now) return `limited until ${master.limitedUntil}`;
  return 'absent';
}
/** The master line of the daemon summary (GY-898); the session and heartbeat budgets are added by the reader from its config. */
export function masterSummary(master: MasterSessionState, now: number, agent?: { agent_status?: string }) {
  const startedAt = master.startedAt ? Date.parse(master.startedAt) : Number.NaN;
  return { session: master.agentName, pane: master.pane, runtime: master.runtime, account: master.account, adopted: master.adopted,
    startedAt: master.startedAt, ageMs: Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : null,
    rotations: master.rotations, lastEnd: master.lastEnd, lastWake: master.lastWake, launching: master.launching,
    state: masterSessionState(master, now, agent) };
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
  /** Retired (GY-2877): the deployment observation and the in-loop deploy's release reading; graphyard-deploy.service records what it serves in .graphyard/deploy.json. */
  deployment: retired, promotion: retired,
  /** Retired: the main watch (GY-1519) is gone; a cursor written before still carries its state, which nothing reads. */
  mainWatch: z.unknown().optional(),
  mergeWriter: z.lazy(() => mergeWriterStateSchema).default(() => emptyMergeWriterState()), // GY-1524: the control-plane merge executor's queue, flight, last delivery and refusals
  /** The release the running loop process loaded, recorded by each process at its startup (GY-437). */
  release: loopReleaseSchema.nullable().default(null),
  /** Retired (GY-2877): the between-cycles self-upgrade. */
  upgrade: retired,
  /** The last reload of .graphyard/master.json: what the running loop adopted, or why it refused. */
  config: z.object({ at: z.string(), changed: z.array(z.string().max(100)).max(100), refused: z.string().max(1000).nullable() }).strict().nullable().default(null),
  /** Retired (GY-2876): resource reclaim, host memory holds and the latency clocks; a cursor written before parses, and its next write drops them. */
  reclaim: retired, memory: retired, clocks: retired, latency: retired,
  /** Retired (GY-1980): the progress watchdog replaced the silence record; nothing reads or writes it, and a cursor written before keeps parsing. */
  silence: z.unknown().optional(),
  /** Retired (GY-1992): the scope requests this loop decided; a cursor written before keeps parsing. */
  scope: z.unknown().optional(),
  /** Retired (GY-2874): orphaned supervisors, approver watches, absent sessions and deferred decisions; a cursor written before keeps parsing. */
  orphans: z.unknown().optional(), approvals: z.unknown().optional(), absences: z.unknown().optional(), decisionsDeferred: z.unknown().optional(),
  /** Retired (GY-2875): docs-sync sessions and the conflicts the loop routed; a cursor written before keeps parsing. */
  docsSyncs: z.unknown().optional(), conflicts: z.unknown().optional(),
  /** How the loop itself has been failing, as distinct from the steps it runs (see `cycleFailureSchema`). */
  failures: cycleFailureSchema.default({ consecutive: 0, total: 0, last: null, unhandled: 0, lastUnhandled: null }),
  /** Retired (GY-2877): base failures and the system invariants. */
  baseFailures: retired, invariants: retired,
  /** The master session the loop launches, adopts, wakes and rotates (GY-898); see `masterSessionSchema`. */
  master: masterSessionSchema.default(() => emptyMasterSession()),
  personalMasters: z.record(z.string(), masterSessionSchema).default({}),
  /** The control plane the snapshot could not reach (GY-2966): since when, and on a compose install the loop's last `docker compose up -d` with the server's last exit and the free disk space; null while it answers. */
  controlPlane: z.object({ unreachableSince: z.string(), error: z.string().max(1000), restartedAt: z.string().nullable(), restart: z.string().max(1000).nullable(), exitReason: z.string().max(1000).nullable(), freeDisk: z.string().max(500).nullable() }).strict().nullable().default(null),
  /** Shared project memory (GY-1125): recent decisions and merges. */
  projectMemory: projectMemorySchema.default(() => emptyProjectMemory()),
}).strict();
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

// The cursor's persistence, bounds and single-writer lock live in ./state-cursor.ts; these
// re-export it, so every existing import keeps working.
import { daemonStatePath, clampCount } from './state-cursor.js';
export { retainedActions, retainedMetrics, profileCooldownMs, maxProofAttempts, emptyDaemonState, daemonStatePath, besideCursor, readDaemonState, writeDaemonState, pruneDaemonState, clampCount, storeAction, touchStanding, boundDaemonState, pidNamespace, initialPidNamespace, liveProcess, acquireDaemonLock, message } from './state-cursor.js';

