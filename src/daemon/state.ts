// Concern: the daemon cursor — its schema, persistence, bounds and single-writer lock.
import { randomUUID } from 'node:crypto';
import { readlinkSync } from 'node:fs';
import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { z } from 'zod';
import { type MasterConfig, assertOutsideWorktrees, writeFailure, diskExhaustionMessage, reclaimAdvice } from '../master.js';
import { boundDetail } from './text.js';
import { waitReason } from '../model/action-kinds.js'; import { timingsSchema } from '../master/timings.js';
import { emptyInvariantRecord, invariantRecordSchema } from '../model/invariants.js';
import { emptyProjectMemory, projectMemorySchema, type ProjectMemory } from '../model/project-memory.js';
import { itemClockSchema, latencySampleSchema } from './latency-clock.js';
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

const percentileSchema = z.object({ count: z.number().int().min(0), p50Ms: z.number().int().min(0), p90Ms: z.number().int().min(0) }).strict();
const noMeasurement = { count: 0, p50Ms: 0, p90Ms: 0 };
/**
 * The six phases of one cycle, in the order the cycle runs them. Each carries the milliseconds the cycle spent in it (`ms`) and, of
 * those, how many it spent waiting on a child process (`childWaitMs`): Herdr, gh, git or systemctl, run through the asynchronous runner
 * and metered by its ledger (child-runner.ts). The difference is the step's own work. A cycle that outgrows its interval therefore says
 * both which step took the time and whether that step was computing or waiting — eighty seconds waiting on gh and eighty seconds of the
 * loop's own work are different faults, and only the second is a loop to worry about. The six sum to a little under `durationMs`: the
 * remainder is the cursor writes and the measurement itself, which belong to no step.
 */
export const cycleStepNames = ['observe', 'close', 'decisions', 'dispatch', 'merge', 'deployment'] as const;
export type CycleStepName = typeof cycleStepNames[number];
const stepCostSchema = z.object({ ms: z.number().int().min(0), childWaitMs: z.number().int().min(0) }).strict();
export type StepCost = z.infer<typeof stepCostSchema>;
export const cycleStepsSchema = z.object({
  /** Reading the coordination snapshot and reconciling the actions an interrupted cycle left. */
  observe: stepCostSchema,
  /** Closing finished sessions, failing over exhausted ones, and reclaiming worktrees and lapsed leases. */
  close: stepCostSchema,
  /** Re-checking blockers, setting base failures aside and sending reworks. */
  decisions: stepCostSchema,
  /** Dispatching claimable work and shepherding the review and proof requests. */
  dispatch: stepCostSchema,
  /** The guarded merges. */
  merge: stepCostSchema,
  /** Observing the deployed release and the post-deployment smoke requests. */
  deployment: stepCostSchema,
}).strict();
export type CycleSteps = z.infer<typeof cycleStepsSchema>;
export const emptyCycleSteps = (): CycleSteps => Object.fromEntries(cycleStepNames.map(step => [step, { ms: 0, childWaitMs: 0 }])) as CycleSteps;

export const cycleMetricsSchema = z.object({
  cycle: z.number().int().min(0), at: z.string(), durationMs: z.number().int().min(0),
  /**
   * Of `durationMs`, the wall-clock time at least one child process was in flight, and the rest,
   * which is the loop's own work. Absent on a cycle recorded before the loop metered its waits.
   */
  childWaitMs: z.number().int().min(0).optional(),
  workMs: z.number().int().min(0).optional(),
  /** Of `durationMs`, the time at least one request was in flight on the control plane, answered or not (GY-1344, GY-1562), left out of `workMs`. Absent when none. */
  planeWaitMs: z.number().int().min(0).optional(),
  /** Where `durationMs` went, step by step. Absent on a cycle recorded before the loop measured its steps. */
  steps: cycleStepsSchema.optional(),
  /**
   * Every step the cycle ran, finer than `steps` (snapshot, observe, close, scope, reclaim, dispatch
   * and its launches, decisions, reviews and proofs, merges, deployment verification, faults), and
   * its slowest external calls of a second or more — server route, GitHub request kind, Herdr
   * command, account probe — each with the step it was made in (GY-377). Absent on older cycles.
   */
  timings: timingsSchema.optional(),
  open: z.number().int().min(0), actions: z.number().int().min(0),
  /**
   * What the cycle could act on, and nothing else about them: stillness is the progress
   * watchdog's judgement (`progressAttention` in ./liveness.ts). Absent — never zero — on a cycle
   * recorded before the loop measured it.
   */
  actionable: z.number().int().min(0).optional(),
  /** How long the longest unacted subject had waited, while the cursor field stood; never written now, kept so older cursors parse. */
  idleMs: z.number().int().min(0).optional(),
  stages: z.record(z.string(), percentileSchema).default({}),
  lead: percentileSchema,
  // Delivery analytics behind the merge: creation to the observed deployment (PR-to-production
  // latency), merge to the smoke verdict (post-deploy time), and how many verdicts failed.
  production: percentileSchema.default(noMeasurement),
  postDeploy: percentileSchema.default(noMeasurement),
  postDeployFailures: z.number().int().min(0).default(0),
  /** Retired (GY-1992): the scope-request latency; nothing writes it, and a cursor written before keeps parsing. */
  scope: z.unknown().optional(), scopeOpenMs: z.unknown().optional(),
}).strict();
export type CycleMetrics = z.infer<typeof cycleMetricsSchema>;

/**
 * What one observation has established about containment, carried to the next cycle. `release` is
 * the release every retained entry has been verified against: a later release that descends from it
 * contains everything it contains, so one ancestry check revalidates the whole set. `settled` keeps,
 * per delivered item, the release its containment was first established against — the record of when
 * the delivery started serving, which is never rewritten by a later release that merely still holds it.
 */
export const containmentRetentionSchema = z.object({
  release: z.string().min(7).max(40),
  settled: z.record(z.string().max(40), z.string().min(7).max(40)).default({}),
}).strict();
export type ContainmentRetention = z.infer<typeof containmentRetentionSchema>;
/** Containment is retained for this many deliveries; older ones are derived again if ever asked about. */
export const retainedContainments = 1000;

export const deploymentObservationSchema = z.object({
  source: z.enum(['endpoint', 'github-deployment', 'unavailable']),
  sha: z.string().nullable(), at: z.string(), reason: z.string().max(500).nullable(),
  deployed: z.array(z.string()).max(200).default([]), pending: z.array(z.string()).max(200).default([]),
  /**
   * What the observation cost, so the bound is a reading rather than a claim: GitHub requests made
   * (zero since the endpoint is the only source; older records may hold more), deliveries whose
   * containment was derived locally this pass, and deliveries answered from `containment`.
   * Absent — never zero — on an observation recorded before the loop measured it.
   */
  requests: z.number().int().min(0).optional(),
  derived: z.number().int().min(0).optional(),
  retained: z.number().int().min(0).optional(),
  containment: containmentRetentionSchema.nullable().optional(),
}).strict();
export type DeploymentObservation = z.infer<typeof deploymentObservationSchema>;

/**
 * The release reading the continuous deploy records (GY-1982): `mainSha` the base tip it last
 * deployed, `promotedSha`/`promotedAt` the release the install runs, `deployFailed` the failed
 * deploy's line, `reason` why no deploy ran. The other fields are the retired promotion drive's
 * (GY-1302), kept so a cursor written before still parses; nothing sets or reads them now.
 */
export const promotionStateSchema = z.object({
  checkedAt: z.string(),
  mainSha: z.string().nullable(),
  promotedSha: z.string().nullable(),
  promotedAt: z.string().nullable(),
  /** First-parent merges on the base branch production does not run yet; null when unknown. */
  behind: z.number().int().min(0).nullable(),
  reason: z.string().max(500).nullable(),
  /** GY-1982: the base tip whose continuous deploy failed, the step and why, and what the loop did about it. */
  deployFailed: z.object({ sha: z.string().max(64), step: z.string().max(32), reason: z.string().max(40000), rolledBackTo: z.string().max(64).nullable(), kept: z.boolean(), attempts: z.number().int().min(1), at: z.string().max(64) }).strict().nullable().optional(),
  /** GY-2844: the loop's verified deploys of main, oldest first: the commit, its committer date and when its deploy passed. */
  deploys: z.array(z.object({ sha: z.string().max(64), committedAt: z.string().max(64), at: z.string().max(64) }).strict()).max(200).optional(),
});
export type PromotionState = z.infer<typeof promotionStateSchema>;

/** What one reclamation did, kept on the cursor so `master status` reports it without rescanning. */
export const reclaimSummarySchema = z.object({
  at: z.string(), scanned: z.number().int().min(0), removed: z.number().int().min(0), kept: z.number().int().min(0),
  freedBytes: z.number().int().min(0), freeBytes: z.number().int().min(0).nullable().default(null),
  errors: z.array(z.string().max(500)).max(20).default([]),
  // The managed worktree root's share of the pass: ephemeral checkouts no live session owned that
  // were removed, and the free space left on the root's own volume.
  checkouts: z.number().int().min(0).default(0), checkoutsOffVolume: z.number().int().min(0).default(0), rootFreeBytes: z.number().int().min(0).nullable().default(null),
  // Finished assignment worktrees removed outright (GY-360), and the reclaimable ones the per-pass
  // bound left for the next cycle: while any are left, the loop reclaims every cycle.
  trees: z.number().int().min(0).default(0), treeBacklog: z.number().int().min(0).default(0),
}).strict();
export type ReclaimSummary = z.infer<typeof reclaimSummarySchema>;

/** The host's memory at the last cycle (GY-612): below its floor, new launches on the host are deferred. */
export const hostMemoryStateSchema = z.object({
  host: z.string().max(200).nullable(), at: z.string(), totalBytes: z.number().min(0), availableBytes: z.number().min(0), floorBytes: z.number().min(0),
  low: z.boolean(), since: z.string().nullable(),
  consumers: z.array(z.object({ command: z.string().max(200), processes: z.number().int().min(0), rssBytes: z.number().min(0) }).strict()).max(10).default([]),
}).strict();

export { itemClockSchema, latencySampleSchema, type ItemClock, type LatencySample } from './latency-clock.js';

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

/** A base failure the loop raised (GY-528): one per failing test and base head; see model/base-failure.ts. */
const blockedCandidateSchema = z.object({ key: z.string().max(40), id: z.string().max(100), sha: z.string().max(64), jobId: z.number().int().nullable(), url: z.string().max(500).nullable() }).strict();
export const baseFailureSchema = z.object({
  test: z.string().max(500), check: z.string().max(200), baseSha: z.string().max(64), jobId: z.number().int().nullable(), url: z.string().max(500).nullable(), raisedAt: z.string(),
  blocks: z.array(blockedCandidateSchema).max(200), item: z.string().max(40).nullable(),
  cleared: z.object({ at: z.string(), baseSha: z.string().max(64), jobId: z.number().int().nullable() }).strict().nullable(),
}).strict();

/** The release this loop's own process loaded, read once at its startup (GY-437) and overwritten by every new process: what every action it takes runs, until its supervisor replaces it. */
export const loopReleaseSchema = z.object({ commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(), dirty: z.boolean().nullable() }).strict();
export type LoopRelease = z.infer<typeof loopReleaseSchema>;

/** The causes an owed self-upgrade restart stalls on (GY-1445); `release-lagged` (GY-1585) is a held restart, not a fault; `snapshot-failed` (GY-1773): the held-cli snapshot a dirty checkout's upgrade restarts onto could not be made; `checkout-dirty` is kept for cursors written before GY-1773, and the `executors-` causes for cursors written before GY-1984. */
export const upgradeStallCauses = ['executors-refused', 'executors-unavailable', 'supervisor-unreachable', 'checkout-dirty', 'checkout-not-detached', 'fetch-failed', 'checkout-failed', 'release-lagged', 'snapshot-failed'] as const;
export type UpgradeStallCause = typeof upgradeStallCauses[number];
export const upgradeStallSchema = z.object({ cause: z.enum(upgradeStallCauses), reason: z.string().max(500), since: z.string(), at: z.string() }).strict();
export type UpgradeStall = z.infer<typeof upgradeStallSchema>;
/**
 * The between-cycles self-upgrade (GY-437), on the cursor so a restarted loop resumes it instead
 * of repeating it: which verified release the checkout was aligned with, what restarts a previous
 * alignment still owes, what the last one did, and why a checkout was left untouched.
 */
export const upgradeStateSchema = z.object({
  /** The verified deployed release the checkout was last aligned with: a new sha is a new trigger. */
  alignedRelease: z.string().regex(/^[0-9a-f]{7,40}$/).nullable().default(null),
  /** The checkout moved to `to` and the restart it owes, the loop's own, is not done yet. */
  pending: z.object({ from: z.string().nullable(), to: z.string(), code: z.boolean() }).strict().nullable().default(null),
  /** The last alignment that completed: what was checked out, whether loaded code moved, and whether the loop re-executed; `executors` only on cursors written before GY-1984. */
  last: z.object({ at: z.string(), from: z.string().nullable(), to: z.string(), code: z.boolean(), executors: z.string().max(300).nullable().optional(), self: z.boolean() }).strict().nullable().default(null),
  /** Why the checkout was left untouched (dirty, not detached): master status names it until it clears. */
  refused: z.object({ at: z.string(), reason: z.string().max(500), commit: z.string().nullable() }).strict().nullable().default(null),
  /**
   * Why the restart the self-upgrade owes cannot complete (GY-1445): one named wait, kept while its
   * cause stands — `since` when it began, `at` the latest attempt — and removed by the next pass that
   * aligns or upgrades. Absent while nothing stalls it.
   */
  stalled: upgradeStallSchema.optional(),
  /** GY-1773: the loop runs a held-cli snapshot of `commit`, not the coordinator checkout, which stood dirty when the self-upgrade ran and was left at `checkout` with its `dirty` tracked paths; `master status` names it while the pin stands, and moving the checkout onto `commit` lifts the pin and removes this. Absent while the loop runs the checkout itself. */
  snapshot: z.object({ at: z.string(), commit: z.string(), checkout: z.string().nullable(), dirty: z.array(z.string().max(300)).max(20) }).strict().optional(),
}).strict().default(() => ({ alignedRelease: null, pending: null, last: null, refused: null }));
export type UpgradeState = z.infer<typeof upgradeStateSchema>;

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
/** The master line of the daemon summary (GY-898); the session and heartbeat budgets are added by the reader from its config. */
export function masterSummary(master: MasterSessionState, now: number) {
  const startedAt = master.startedAt ? Date.parse(master.startedAt) : Number.NaN;
  return { session: master.agentName, pane: master.pane, runtime: master.runtime, account: master.account, adopted: master.adopted,
    startedAt: master.startedAt, ageMs: Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : null,
    rotations: master.rotations, lastEnd: master.lastEnd, lastWake: master.lastWake, launching: master.launching };
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
  deployment: deploymentObservationSchema.nullable().default(null),
  promotion: promotionStateSchema.nullable().default(null), // the continuous deploy's release reading (GY-1982)
  /** Retired: the main watch (GY-1519) is gone; a cursor written before still carries its state, which nothing reads. */
  mainWatch: z.unknown().optional(),
  mergeWriter: z.lazy(() => mergeWriterStateSchema).default(() => emptyMergeWriterState()), // GY-1524: the control-plane merge executor's queue, flight, last delivery and refusals
  /** The release the running loop process loaded, recorded by each process at its startup (GY-437). */
  release: loopReleaseSchema.nullable().default(null),
  upgrade: upgradeStateSchema, // the between-cycles self-upgrade's progress (GY-437)
  /** The last reload of .graphyard/master.json: what the running loop adopted, or why it refused. */
  config: z.object({ at: z.string(), changed: z.array(z.string().max(100)).max(100), refused: z.string().max(1000).nullable() }).strict().nullable().default(null),
  reclaim: reclaimSummarySchema.nullable().default(null), // the last worktree reclamation: what it removed and how much room the host has
  /** The host's memory as the last cycle read it, and whether launches are deferred on it. */
  memory: hostMemoryStateSchema.nullable().default(null),
  clocks: z.record(z.string(), itemClockSchema).default({}), // per-item passage clocks and the samples they produced: the loop's own latency measurement
  latency: z.array(latencySampleSchema).default([]),
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
  /**
   * Per failing test and base head (`baseFailureKey`), a required check that fails on the base
   * branch head as well as on the candidates it blocks (GY-528): no rework is requested for it, one
   * P0 item is filed, and once the base passes again the blocked candidates are rerun and refreshed.
   */
  baseFailures: z.record(z.string(), baseFailureSchema).default(() => ({})),
  /**
   * The system invariants (GY-404): what the loop carries between cycles to judge them — base
   * refreshes per candidate, when each merge candidate was first seen mergeable — and the last
   * cycle's report, one line per invariant, for `master status`.
   */
  invariants: invariantRecordSchema.default(emptyInvariantRecord),
  /** The master session the loop launches, adopts, wakes and rotates (GY-898); see `masterSessionSchema`. */
  master: masterSessionSchema.default(() => emptyMasterSession()),
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
export { standingTmpKey, retainedActions, retainedMetrics, profileCooldownMs, maxProofAttempts, retainedSamples, retainedClocks, retainedBaseFailures, reclaimIntervalMs, gigabytes, emptyDaemonState, daemonStatePath, readDaemonState, writeDaemonState, pruneDaemonState, clampCount, storeAction, touchStanding, boundDaemonState, boundDeployment, pidNamespace, initialPidNamespace, liveProcess, acquireDaemonLock, message } from './state-cursor.js';

