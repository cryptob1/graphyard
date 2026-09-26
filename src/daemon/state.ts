// Concern: the daemon cursor — its schema, persistence, bounds and single-writer lock.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { z } from 'zod';
import { runRecordSchema } from '../runner/types.js';
import { type MasterConfig, assertOutsideWorktrees, writeFailure, diskExhaustionMessage, reclaimAdvice } from '../master.js';
import { boundDetail } from './decisions.js';
import { classified, faultClasses, faultInstanceSchema, type FaultKind } from '../model/fault-classes.js';
import { noteActionOutcome } from '../model/fault-tracking.js';
import { timingsSchema } from '../master/timings.js';
import { emptyInvariantRecord, invariantRecordSchema } from '../model/invariants.js';

export const daemonActionKinds = ['close', 'dispatch', 'review', 'refresh', 'proof', 'merge', 'deployment', 'smoke', 'escalation', 'config', 'session', 'reclaim', 'decision', 'scope', 'settle', 'failover', 'capacity', 'human', 'preserve', 'fault'] as const;
export type DaemonActionKind = typeof daemonActionKinds[number];
/** A failed action is a pipeline fault; its kind in the fault catalogue (GY-173) follows the action's kind. */
export const daemonActionFaultKind = (kind: DaemonActionKind) => `action:${kind}` as FaultKind;
/** The most an action's detail may carry: daemonActionSchema's bound, which record() enforces. */
export const actionDetailMax = 2000;
export const daemonActionSchema = z.object({
  kind: z.enum(daemonActionKinds),
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
  /** Set on a failed or indeterminate action: the fault class that failure is an instance of (GY-173). */
  faultClass: z.enum(faultClasses).optional(),
}).strict();
export type DaemonAction = z.infer<typeof daemonActionSchema>;

const percentileSchema = z.object({ count: z.number().int().min(0), p50Ms: z.number().int().min(0), p90Ms: z.number().int().min(0) }).strict();
const noMeasurement = { count: 0, p50Ms: 0, p90Ms: 0 };
/**
 * The six phases of one cycle, in the order the cycle runs them. Each carries the milliseconds
 * the cycle spent in it (`ms`) and, of those, how many it spent waiting on a child process
 * (`childWaitMs`): Herdr, gh, git or systemctl, run through the asynchronous runner and metered
 * by its ledger (child-runner.ts). The difference is the step's own work. A cycle that outgrows
 * its interval therefore says both which step took the time and whether that step was computing
 * or waiting — eighty seconds waiting on gh and eighty seconds of the loop's own work are
 * different faults, and only the second is a loop to worry about. The six sum to a little under
 * `durationMs`: the remainder is the cursor writes and the measurement itself, which belong to no
 * step.
 */
export const cycleStepNames = ['observe', 'close', 'decisions', 'dispatch', 'merge', 'deployment'] as const;
export type CycleStepName = typeof cycleStepNames[number];
const stepCostSchema = z.object({ ms: z.number().int().min(0), childWaitMs: z.number().int().min(0) }).strict();
export type StepCost = z.infer<typeof stepCostSchema>;
export const cycleStepsSchema = z.object({
  /** Reading the coordination snapshot and reconciling the actions an interrupted cycle left. */
  observe: stepCostSchema,
  /** Closing finished sessions, failing over exhausted ones, stopping orphaned supervisors, and reclaiming worktrees and quarantines. */
  close: stepCostSchema,
  /** Deciding scope requests and requesting, supervising and retiring the routine decisions an approver applies. */
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
   * What the cycle could act on, and the longest any one of those has gone unacted (see
   * `silenceReport`). Absent — never zero — on a cycle recorded before the loop measured it.
   */
  actionable: z.number().int().min(0).optional(),
  idleMs: z.number().int().min(0).optional(),
  stages: z.record(z.string(), percentileSchema).default({}),
  lead: percentileSchema,
  // Delivery analytics behind the merge: creation to the observed deployment (PR-to-production
  // latency), merge to the smoke verdict (post-deploy time), and how many verdicts failed.
  production: percentileSchema.default(noMeasurement),
  postDeploy: percentileSchema.default(noMeasurement),
  postDeployFailures: z.number().int().min(0).default(0),
  // How promptly the loop answers the workers waiting on it: request-to-decision over the
  // retained scope decisions, and the longest request still undecided at this cycle.
  // (Optional, so a cursor written before the loop decided scope keeps parsing as it is.)
  scope: percentileSchema.optional(),
  scopeOpenMs: z.number().int().min(0).optional(),
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
   * (never more than `maxDeploymentRequests`, whatever has been delivered), deliveries whose
   * containment was derived locally this pass, and deliveries answered from `containment`.
   * Absent — never zero — on an observation recorded before the loop measured it.
   */
  requests: z.number().int().min(0).optional(),
  derived: z.number().int().min(0).optional(),
  retained: z.number().int().min(0).optional(),
  containment: containmentRetentionSchema.nullable().optional(),
}).strict();
export type DeploymentObservation = z.infer<typeof deploymentObservationSchema>;

/** What one reclamation did, kept on the cursor so `master status` reports it without rescanning. */
export const reclaimSummarySchema = z.object({
  at: z.string(), scanned: z.number().int().min(0), removed: z.number().int().min(0), kept: z.number().int().min(0),
  freedBytes: z.number().int().min(0), freeBytes: z.number().int().min(0).nullable().default(null),
  errors: z.array(z.string().max(500)).max(20).default([]),
  // The managed worktree root's share of the pass: ephemeral checkouts no live session owned that
  // were removed, and the free space left on the root's own volume.
  checkouts: z.number().int().min(0).default(0), rootFreeBytes: z.number().int().min(0).nullable().default(null),
  // Finished assignment worktrees removed outright (GY-360), and the reclaimable ones the per-pass
  // bound left for the next cycle: while any are left, the loop reclaims every cycle.
  trees: z.number().int().min(0).default(0), treeBacklog: z.number().int().min(0).default(0),
}).strict();
export type ReclaimSummary = z.infer<typeof reclaimSummarySchema>;

export const scopeMeasurementSchema = z.object({
  work: z.string().max(200), epoch: z.number().int().min(0), at: z.string(),
  waitedMs: z.number().int().min(0), state: z.enum(['approved', 'refused']),
}).strict();
export type ScopeMeasurement = z.infer<typeof scopeMeasurementSchema>;

/**
 * What the loop itself observed about one item's passage, so latency is measured against what the
 * loop acted on rather than reconstructed from a ledger afterwards. One entry per open item,
 * dropped once its delivery has been sampled.
 */
export const itemClockSchema = z.object({
  key: z.string().max(40), epoch: z.number().int().min(0),
  /** First cycle that saw the item claimable — released, unclaimed, and not already submitted. */
  readyAt: z.string().nullable().default(null),
  claimedAt: z.string().nullable().default(null),
  /** First candidate head of the current attempt: the worker's first push. */
  pushedAt: z.string().nullable().default(null),
  approvedAt: z.string().nullable().default(null),
  /** First cycle that saw every gate green: when the candidate became mergeable. */
  mergeableAt: z.string().nullable().default(null),
}).strict();
export type ItemClock = z.infer<typeof itemClockSchema>;

/** One measured passage. A delivery fills the merge figures; a rework request fills its own. */
export const latencySampleSchema = z.object({
  work: z.string().max(40), at: z.string(),
  readyToClaimMs: z.number().int().min(0).nullable().default(null),
  readyToPushMs: z.number().int().min(0).nullable().default(null),
  approvalToMergeMs: z.number().int().min(0).nullable().default(null),
  mergeableToMergeMs: z.number().int().min(0).nullable().default(null),
  verdictToReworkMs: z.number().int().min(0).nullable().default(null),
}).strict();
export type LatencySample = z.infer<typeof latencySampleSchema>;

/** Everything the loop could act on but has not, keyed by kind and item; `since` resets on every action. */
export const silenceSchema = z.object({
  subjects: z.record(z.string(), z.object({ since: z.string(), work: z.string().max(40).nullable(), kind: z.string().max(40), detail: z.string().max(500) }).strict()).default({}),
  lastActionAt: z.string().nullable().default(null),
}).strict();

/**
 * What the loop last saw of an assignment whose Herdr session is gone: enough for a later cycle
 * to tell a lease that is still being renewed from one that has simply not lapsed yet. Without
 * that second look, every session that ends a moment before its lease does would read as an
 * orphaned supervisor.
 */
export const orphanObservationSchema = z.object({
  epoch: z.number().int().min(0), owner: z.string().max(200),
  pid: z.number().int().positive(), unit: z.string().max(200),
  firstSeenAt: z.string(), leaseExpiresAt: z.string(),
  /** How many times this supervisor has been stopped, and the expiry it was last stopped at. */
  stops: z.number().int().min(0).default(0),
  stoppedLeaseExpiresAt: z.string().nullable().default(null),
}).strict();
export type OrphanObservation = z.infer<typeof orphanObservationSchema>;

/**
 * One decision this loop has put to an approver, kept until the item no longer needs it. Reviews
 * and producers have a ledger because launched sessions die, drop their prompt and hit account
 * limits; an approver is a launched session like any other, and a request whose approver is gone
 * is a decision nobody will ever judge. This is what each cycle looks at again.
 */
export const approvalWatchSchema = z.object({
  work: z.string().max(40), action: z.string().max(40), decision: z.string().max(100),
  agentName: z.string().max(200).nullable().default(null), pane: z.string().max(200).nullable().default(null),
  requestedAt: z.string(), launchedAt: z.string().nullable().default(null),
  /** Approver sessions launched (or attempted) for this decision; bounded by `maxApproverLaunches`. */
  launches: z.number().int().min(0).default(0),
  /** Requests made for this binding, counting the ones the server settled without applying; bounded by `maxDecisionRequests`. */
  requests: z.number().int().min(0).default(1),
  /** How each earlier session ended without a judgement, oldest first. */
  ended: z.array(z.string().max(300)).max(10).default([]),
  /** Set once the decision is applied: the watch is kept so the same binding is not requested again. */
  settledAt: z.string().nullable().default(null),
  /** Set once every launch is spent on a decision still unjudged: the loop has escalated it. */
  exhaustedAt: z.string().nullable().default(null),
  closeAttempts: z.number().int().min(0).default(0),
  /** The GitHub observation a rework request was decided from (GY-144): its time and candidate head. */
  observation: z.object({ at: z.string(), sha: z.string() }).strict().nullable().default(null),
  /** The account and runtime the current session was launched on, so its exhaustion holds the right account (GY-182). */
  account: z.string().max(200).nullable().default(null), runtime: z.string().max(40).nullable().default(null),
  /** The worker scope request a `requirements` decision answers (GY-176): whose, and for what. */
  scope: z.object({ epoch: z.number().int().min(1), at: z.string(), requestedBy: z.string().max(200), paths: z.array(z.string().max(500)).max(50) }).strict().nullable().default(null),
  /** The agent-registry session the current approver runs on (GY-190), ended once the decision is judged,
   * or as soon as its quota is spent so the replacement has the slot (GY-182). */
  session: z.string().max(200).nullable().default(null),
  /** Why the last launch waits for a slot: the registry refused it only because the role was full (GY-190). */
  capacity: z.string().max(500).nullable().default(null),
  /** A headless approver's run (GY-169): its last events, its result, and what became of its verdict. */
  run: runRecordSchema.nullable().default(null),
  /** The decision and launch whose spent-account hold and capacity `exhausted` report the loop already wrote (GY-316): a retried failover writes neither again. */
  reportedExhaustion: z.string().max(200).nullable().default(null),
}).strict();
export type ApprovalWatch = z.infer<typeof approvalWatchSchema>;
/**
 * What a re-keyed watch takes over from the one it retires: the session goes on, and so does what
 * it runs on, so a retained session's exhaustion holds the account it spent (GY-182).
 */
export const carriedSession = (prior: ApprovalWatch) => ({ launches: prior.launches, agentName: prior.agentName, pane: prior.pane, launchedAt: prior.launchedAt,
  exhaustedAt: prior.exhaustedAt, account: prior.account, runtime: prior.runtime, session: prior.session });

/**
 * The loop's own failures (GY-119). A cycle that throws — a control-plane read that timed out, a
 * runtime call that failed, a configuration reload that could not be read — is a failed cycle, not
 * the end of the process: it is recorded here, the cycle counter advances, and the next cycle runs
 * after a delay that grows with the consecutive count. An unhandled rejection or uncaught exception
 * anywhere in the process — a detached promise in the dispatcher, an approver watch, a Herdr read —
 * is caught at the process level and counted here too. The supervisor's restart is reserved for a
 * process that hangs, which the watchdog detects; nothing here ends the process.
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

export const daemonStateSchema = z.object({
  version: z.literal(1), url: z.string(), repository: z.string(),
  lock: z.object({ id: z.string(), pid: z.number().int().positive(), host: z.string(), startedAt: z.string(), heartbeatAt: z.string() }).strict().nullable().default(null),
  cycle: z.number().int().min(0).default(0),
  lastCycleAt: z.string().nullable().default(null),
  actions: z.record(z.string(), daemonActionSchema).default({}),
  profiles: z.record(z.string(), z.object({ failures: z.number().int().min(0), reason: z.string().max(500).nullable(), cooldownUntil: z.string().nullable() }).strict()).default({}),
  metrics: z.array(cycleMetricsSchema).default([]),
  deployment: deploymentObservationSchema.nullable().default(null),
  /** The last reload of .graphyard/master.json: what the running loop adopted, or why it refused. */
  config: z.object({ at: z.string(), changed: z.array(z.string().max(100)).max(100), refused: z.string().max(1000).nullable() }).strict().nullable().default(null),
  /** The last worktree reclamation: what it removed and how much room the host has. */
  reclaim: reclaimSummarySchema.nullable().default(null),
  /** Per-item passage clocks and the samples they produced; the loop's own latency measurement. */
  clocks: z.record(z.string(), itemClockSchema).default({}),
  latency: z.array(latencySampleSchema).default([]),
  /** What is actionable and how long it has gone without an action (see `silenceReport`). */
  silence: silenceSchema.default({ subjects: {}, lastActionAt: null }),
  /** One entry per scope request this loop has decided, for the latency budget it must keep. */
  scope: z.array(scopeMeasurementSchema).default([]),
  /** Per work item, what the loop last saw of an assignment whose Herdr session is gone. */
  orphans: z.record(z.string(), orphanObservationSchema).default({}),
  /** Per decision action key, the request this loop put to an approver and what became of it. */
  approvals: z.record(z.string(), approvalWatchSchema).default({}),
  /** Per work item, a live lease whose session Herdr no longer reports while no fence stands (see step 1d). */
  absences: z.record(z.string(), z.object({ epoch: z.number().int().min(0), owner: z.string().max(200), firstSeenAt: z.string(), cycle: z.number().int().min(0) }).strict()).default({}),
  /** How the loop itself has been failing, as distinct from the steps it runs (see `cycleFailureSchema`). */
  failures: cycleFailureSchema.default({ consecutive: 0, total: 0, last: null, unhandled: 0, lastUnhandled: null }),
  /**
   * Every fault instance the loop recorded, each with its class (GY-173), and per standing fault
   * (`kind|subject`) the instance it is, and per action key in a run of failures the instance that run
   * is. A class that recurs files one item; later instances link to it.
   * The default is a factory: zod 4 hands a literal default out by reference, which would share one record between states.
   */
  faults: z.object({ instances: z.array(faultInstanceSchema).default([]), open: z.record(z.string(), z.string()).default({}), failing: z.record(z.string(), z.string()).default({}),
    /** The first cycle that read every source (GY-374): what stood before it is `baseline`, not a recurrence. */
    since: z.string().nullable().optional() }).strict()
    .default(() => ({ instances: [], open: {}, failing: {} })),
  /**
   * The system invariants (GY-404): what the loop carries between cycles to judge them — base
   * refreshes per candidate, when each merge candidate was first seen mergeable, the builds and lease
   * losses seen — and the last cycle's report, one line per invariant, for `master status`.
   */
  invariants: invariantRecordSchema.default(emptyInvariantRecord),
}).strict();
export type DaemonState = z.infer<typeof daemonStateSchema>;

export const retainedActions = 500, retainedMetrics = 100, profileCooldownMs = 600_000, maxProofAttempts = 3, retainedScopeDecisions = 200;
export const retainedSamples = 200, retainedClocks = 500;
/** Reclamation scans the worktree directory, so it runs on its own bounded interval, not every cycle. */
export const reclaimIntervalMs = 600_000;
export const gigabytes = (bytes: number | null) => bytes === null ? 'an unknown amount of space' : `${(bytes / 1e9).toFixed(1)} GB`;

export function emptyDaemonState(config: MasterConfig): DaemonState {
  return daemonStateSchema.parse({ version: 1, url: config.url, repository: config.repository });
}

/** Derived from the coordinator credential, so the cursor lives beside it and never inside a worktree. */
export function daemonStatePath(config: MasterConfig) {
  const file = config.credentialFile;
  return resolve(dirname(file), `${basename(file).replace(/\.token$/, '')}.daemon.json`);
}

export async function readDaemonState(root: string, config: MasterConfig): Promise<DaemonState> {
  const file = daemonStatePath(config);
  await assertOutsideWorktrees(root, dirname(file), 'Master daemon state directory');
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (error: any) { if (error.code === 'ENOENT') return emptyDaemonState(config); throw error; }
  const state = daemonStateSchema.parse(JSON.parse(raw));
  if (state.url !== config.url || state.repository.toLowerCase() !== config.repository.toLowerCase()) throw new Error('Master daemon state belongs to another Graphyard server or repository; remove it before running the loop');
  return state;
}

export async function writeDaemonState(config: MasterConfig, state: DaemonState) {
  const file = daemonStatePath(config), temporary = `${file}.${randomUUID()}.tmp`;
  // The cursor is written twice per external action, so it is usually the first thing a full
  // volume stops. Saying so is the difference between a disk to reclaim and a mystery.
  try {
    await writeFile(temporary, JSON.stringify(daemonStateSchema.parse(boundDaemonState(state)), null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } catch (error) { throw writeFailure(error, 'Writing the master daemon cursor'); }
  await chmod(file, 0o600);
}

/** Keep the cursor bounded without ever discarding an unresolved action. */
export function pruneDaemonState(state: DaemonState) {
  const entries = Object.entries(state.actions);
  const resolved = entries.filter(([, action]) => action.state === 'done' || action.state === 'failed');
  if (resolved.length > retainedActions) {
    for (const [key] of resolved.sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at)).slice(0, resolved.length - retainedActions)) delete state.actions[key];
  }
  // A failing run whose action row is retired has ended (GY-173): its reference would otherwise hold its instance forever.
  for (const key of Object.keys(state.faults.failing)) if (!state.actions[key]) delete state.faults.failing[key];
  if (state.metrics.length > retainedMetrics) state.metrics = state.metrics.slice(-retainedMetrics);
  if (state.latency.length > retainedSamples) state.latency = state.latency.slice(-retainedSamples);
  // A clock is dropped when its delivery was sampled; this bound only catches items the loop
  // stopped seeing (a removed item, a renamed repository) so the cursor cannot grow without end.
  const clocks = Object.keys(state.clocks);
  if (clocks.length > retainedClocks) for (const id of clocks.slice(0, clocks.length - retainedClocks)) delete state.clocks[id];
  if (state.scope.length > retainedScopeDecisions) state.scope = state.scope.slice(-retainedScopeDecisions);
  // A watch is retired when its item moves on; this bound only catches items the loop stopped seeing.
  const watches = Object.entries(state.approvals).sort((a, b) => Date.parse(a[1].requestedAt) - Date.parse(b[1].requestedAt));
  if (watches.length > retainedClocks) for (const [key] of watches.slice(0, watches.length - retainedClocks)) delete state.approvals[key];
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
 * Every write of an action goes through here (GY-173): a failed or indeterminate action carries
 * the class of its fault kind, anything else carries none, and the outcome is noted against the
 * fault record — a failure opening one instance per run of failures, a success ending the run.
 * A null fault kind is an outcome that is no fault (a guarded merge the gate refused): it is
 * stored for retry like any failure but carries no class and is never noted as an instance.
 * The detail is bounded here, before the schema sees it, so a caller that quotes a long error or
 * path list cannot fail every cycle with an over-long string (GY-179).
 */
export function storeAction(state: DaemonState, key: string, action: Omit<DaemonAction, 'faultClass'> & { faultClass?: unknown }, faultKind: FaultKind | null = daemonActionFaultKind(action.kind)): DaemonAction {
  const { faultClass: _, ...rest } = action;
  const failed = faultKind !== null && (rest.state === 'failed' || rest.state === 'indeterminate');
  const fault = faultKind === null ? null : classified(faultKind);
  const entry = daemonActionSchema.parse({ ...rest, detail: boundDetail(rest.detail), attempts: clampCount(rest.attempts, 1000), ...(failed && fault ? { faultClass: fault.faultClass } : {}) });
  if (fault) noteActionOutcome(state.faults, key, entry.state, { ...fault, subject: entry.work ?? key, text: entry.detail }, entry.at);
  state.actions[key] = entry;
  return entry;
}
/** The action key a recurring class's filing is recorded under. */
export const faultActionKey = (faultClass: string) => `fault:${faultClass}`;
const cut = <T extends string | null | undefined>(value: T, max: number): T => (typeof value === 'string' && value.length > max ? boundDetail(value, max) : value) as T;
export function boundDaemonState(state: DaemonState): DaemonState {
  for (const action of Object.values(state.actions)) {
    action.detail = boundDetail(action.detail);
    action.attempts = clampCount(action.attempts, 1000);
  }
  for (const profile of Object.values(state.profiles)) profile.reason = cut(profile.reason, 500);
  if (state.deployment) state.deployment = boundDeployment(state.deployment);
  if (state.config) state.config = { ...state.config, changed: state.config.changed.slice(0, 100).map(entry => cut(entry, 100)), refused: cut(state.config.refused, 1000) };
  if (state.reclaim) state.reclaim.errors = state.reclaim.errors.slice(0, 20).map(entry => cut(entry, 500));
  for (const clock of Object.values(state.clocks)) clock.key = cut(clock.key, 40);
  for (const sample of state.latency) sample.work = cut(sample.work, 40);
  for (const subject of Object.values(state.silence.subjects)) Object.assign(subject, { work: cut(subject.work, 40), kind: cut(subject.kind, 40), detail: cut(subject.detail, 500) });
  for (const entry of state.scope) entry.work = cut(entry.work, 200);
  for (const orphan of Object.values(state.orphans)) Object.assign(orphan, { owner: cut(orphan.owner, 200), unit: cut(orphan.unit, 200) });
  for (const watch of Object.values(state.approvals)) {
    Object.assign(watch, { work: cut(watch.work, 40), action: cut(watch.action, 40), decision: cut(watch.decision, 100), agentName: cut(watch.agentName, 200), pane: cut(watch.pane, 200) });
    watch.ended = watch.ended.slice(-10).map(entry => cut(entry, 300));
  }
  for (const absence of Object.values(state.absences)) absence.owner = cut(absence.owner, 200);
  const failures = state.failures;
  if (failures.last) Object.assign(failures.last, { call: cut(failures.last.call, 100), reason: cut(failures.last.reason, 1000) });
  if (failures.lastUnhandled) failures.lastUnhandled.reason = cut(failures.lastUnhandled.reason, 1000);
  return state;
}
/** A deployment observation within its schema: 200 deliveries a side (the newest kept) and a 500-character reason. */
export function boundDeployment<T extends Pick<DeploymentObservation, 'reason' | 'deployed' | 'pending'>>(observation: T): T {
  return { ...observation, reason: cut(observation.reason ?? null, 500), deployed: (observation.deployed ?? []).slice(-200), pending: (observation.pending ?? []).slice(-200) };
}

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
  state.lock = { id: randomUUID(), pid: identity.pid, host: identity.host, startedAt: new Date(now).toISOString(), heartbeatAt: new Date(now).toISOString() };
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
