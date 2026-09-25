import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ciReportingEnvironment } from './install/ci-proofs.js';
import { productionEnvironmentFromEnv } from './flow-analytics.js';
import { ChildWaitLedger, childRunner, type ChildRun } from './child-runner.js';
import { uncitedRefusals } from './model/approval.js';
import { classified, classifyAttention, faultClasses, faultClassItem, openFaultClassItem, type FaultClass, faultClassPolicyFromEnv, faultInstanceSchema, noteActionOutcome, noteFault, recurringClasses, statusFaults, trackFaults, workFaults, type FaultClassPolicy, type FaultKind, type FaultObservation } from './model/fault-classes.js';
import { currentEvidence, deliveryState, deploySmokeRequired, exhaustedReviewerProfiles, leaseLossEpoch, postDeployMs, productionLatencyMs, reviewProviderOf, reviewerProfileFor, rollbackGuidance, standingEscalations, type AgentReview, type ContainmentScope, type Work } from './model.js';
import { pathScopeContains, redecidableScopeRefusal, scopeBlockedBudgetMs, scopeDecisionBudgetMs, scopeDecisionSample, type ScopeRequestState } from './model/scope.js';
import { scopePattern, watchAssignment } from './supervisor.js';
import type { SessionHandleInput } from './model/sessions.js';
import { paneAlreadyGone, withPaneGone } from './request-settlement.js';
import { baseRefreshConflict, blockingThreads, describeThread, pendingBaseRefresh, threadsAwaitReview, type ReviewThread } from './merge-queue.js';
export { threadResolutionGraceMs, threadsAwaitReview } from './merge-queue.js';
import { dispatchOrder } from './coordination.js';
import { describeReclaim, dispatchRefusal, reclaimResources, type ResourceReclaimReport } from './master-resources.js';
import { capacitySignature, describeCapacity, detectExhaustion, standingCapacity, type CapacityAccount, type CapacityRole, type PartialWork } from './model/capacity.js';
import { answerCommand, humanDecisionLabel, parkedOnHuman } from './model/human-request.js';
import { stalledItems } from './model/action-account.js';
import { humanNeededActions } from './model/next-action.js';
import { independentProducerProfiles, launchProducer, readProducerLedger, reclaimCheckouts, saveProducerLedger } from './producer.js';
import { launchReview, readReviewLedger, updateReviewLedger } from './reviewer.js';
import { basePaths, findingScope, readReviewFindings, type ReviewFinding } from './review-scope.js';
import { defaultAwaitReviewers } from './auto-dispatch.js';
import { inspectProducerCredentials, inspectProfileAccounts, preservePartialWork, profileAccount, readEnvironmentLog, readCredentialFile, recordObservedExhaustion, roleCapacity, selectionKey, type ObservedExhaustion, type ProfileAccountHealth, type RoleCapacity } from './master.js';
import { agentOwner, agentToken, approvedMerge, approverSessionName, assertDispatchable, buildMasterStatus, guardBroadScope, assertOutsideWorktrees, assessContainment, closeHerdrPane, containmentPhase, decisionInput, diskExhaustionMessage, diskThresholdBytes, dispatchWork, inspectWorkerCredentials, launchApprover, listHerdrAgents, mergeExecutor, mergedWithoutAuthorization, observeHerdrAgents, reclaimAdvice, reclaimIdleMs, reclaimWorktrees, unauthorizedMergeViolation, writeFailure, type AttentionItem, type ConfigReload, type ContainmentAssessment, type ControlPlaneStatus, type HerdrAgent, type MasterConfig, type MergeExecutor, type WorkerProfile, type WorktreeReclaimReport } from './master.js';
import { worktreeRootMinFreeBytes } from './install/worktree-root.js';
import { probeSupervisorAbsence } from './containment-probe.js';

/**
 * The durable coordination loop. Every step is a pure decision over one Graphyard snapshot plus
 * an injected effect, so the same cycle runs under systemd, under Herdr, or inside a test with no
 * process supervision at all. The daemon is a coordinator: it never claims a lease, never produces
 * evidence, never calls an operator route, and reaches GitHub only through the guarded merge.
 */

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
  state: z.enum(['started', 'done', 'failed', 'indeterminate']),
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
}).strict();
export type ApprovalWatch = z.infer<typeof approvalWatchSchema>;

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
  faults: z.object({ instances: z.array(faultInstanceSchema).default([]), open: z.record(z.string(), z.string()).default({}), failing: z.record(z.string(), z.string()).default({}) }).strict()
    .default(() => ({ instances: [], open: {}, failing: {} })),
}).strict();
export type DaemonState = z.infer<typeof daemonStateSchema>;

export const retainedActions = 500, retainedMetrics = 100, profileCooldownMs = 600_000, maxProofAttempts = 3, retainedScopeDecisions = 200;
export const retainedSamples = 200, retainedClocks = 500;
/** Reclamation scans the worktree directory, so it runs on its own bounded interval, not every cycle. */
export const reclaimIntervalMs = 600_000;
const gigabytes = (bytes: number | null) => bytes === null ? 'an unknown amount of space' : `${(bytes / 1e9).toFixed(1)} GB`;

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
    await writeFile(temporary, JSON.stringify(daemonStateSchema.parse(state), null, 2), { mode: 0o600, flag: 'wx' });
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

const liveProcess = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; } };

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
 * A daemon killed mid-action leaves a `started` cursor entry. Graphyard, not the cursor, decides
 * what actually happened: an assignment that landed is closed as done, one that did not is released
 * for a fresh attempt. Neither outcome repeats an action that already took effect.
 *
 * A dispatch lands only by the launcher claiming under the worker's own identity, and every claim
 * advances the epoch, so the attempt epoch is the one honest witness. A submission is not: rework
 * authorized by an operator keeps the previous attempt's submission while the item waits to be
 * assigned again, and reading that as success would strand the rework at a key that never retries.
 */
export function reconcilePendingActions(state: DaemonState, work: Work[], now: number) {
  const resumed: DaemonAction[] = [];
  for (const [key, action] of Object.entries(state.actions)) {
    if (action.state !== 'started') continue;
    // A base refresh is the control plane's own work, not an effect this loop invoked, so there is
    // nothing interrupted to reconcile: the cycle resolves the same entry from Graphyard's record
    // of what the merge did, or leaves it open while the reconciliation job has not run yet.
    if (action.kind === 'refresh') continue;
    const item = work.find(candidate => candidate.key === action.work || candidate.id === action.work);
    const owned = !!item?.lease && item.lease.owner === action.principal && Date.parse(item.lease.expiresAt) > now;
    const next: DaemonAction = { ...action, at: new Date(now).toISOString() };
    if (action.kind === 'dispatch') {
      // A cursor written before attempt epochs were recorded can fall back only to a submission the
      // current attempt owns; one kept across rework says nothing about the attempt just dispatched.
      const landed = owned ? 'Graphyard shows the assignment landed before the restart'
        : action.epoch !== null && item && item.epoch > action.epoch ? `Graphyard advanced the attempt past epoch ${action.epoch}, so the assignment landed before the restart`
          : action.epoch === null && item?.submission && !item.reworkRequested ? 'the current attempt is already submitted, so the assignment landed before the restart'
            : null;
      next.state = landed ? 'done' : 'failed';
      next.detail = landed ? `Resumed: ${landed}` : 'Resumed: no assignment landed, so the item stays eligible for a fresh dispatch';
    } else if (action.kind === 'merge') {
      next.state = item?.observation?.merged || item?.stage === 'done' ? 'done' : 'failed';
      next.detail = next.state === 'done' ? 'Resumed: Graphyard observed the merge' : 'Resumed: no merge was observed; the guarded merge may be attempted again';
    } else if (action.kind === 'scope' && action.work) {
      // The decision lives on the item: either the control plane recorded one for the open
      // request or it did not, and an undecided request is simply asked again next cycle.
      const pending = item?.scopeRequest && !item.scopeRequest.decision;
      next.state = pending ? 'failed' : 'done';
      next.detail = pending ? 'Resumed: the scope request is still undecided and will be decided again'
        : `Resumed: Graphyard holds the decision (${item?.scopeRequest?.decision?.state ?? 'the request was withdrawn or superseded'})`;
    } else if (action.kind === 'failover') {
      // A worker failover took effect exactly when the attempt's lease ended on the record. An
      // interrupted one is tried again: the control plane writes an exhaustion once, and a
      // reviewer or producer session already ended is no longer pending, so nothing repeats.
      const ended = action.epoch !== null && !!item && (!item.lease || item.lease.epoch !== action.epoch);
      next.state = ended ? 'done' : 'failed';
      next.detail = ended ? `Resumed: Graphyard shows attempt ${action.epoch} ended, so the item is re-queued` : 'Resumed: the failover was interrupted; the session is read again on this cycle';
    } else if (action.kind === 'deployment' && action.work) {
      // Recording a deployment either landed on the delivery snapshot or it did not; a repeat of a
      // landed record is refused by Graphyard, so retrying is safe.
      next.state = item?.delivery?.deployment ? 'done' : 'failed';
      next.detail = next.state === 'done' ? 'Resumed: Graphyard holds the deployment observation' : 'Resumed: no deployment observation was recorded; it may be recorded again';
    } else if (action.kind === 'decision') {
      // Both halves are safe to repeat: a request already standing on the item is adopted rather
      // than made twice, and a session already listed under the decision's name is adopted rather
      // than launched twice. Left indeterminate, the decision would never be looked at again.
      next.state = state.approvals[key] ? 'done' : 'failed';
      next.detail = next.state === 'done' ? 'Resumed: the decision was requested before the restart; its approver session is supervised from here'
        : 'Resumed: no request was recorded before the restart; a standing one is adopted, otherwise it is requested again';
    } else if (action.kind === 'fault') {
      // Filing a recurring class's item is idempotent under its key: the item the filing made stands open naming the
      // class, and later instances link to it; without one, the class files again under the same key.
      const filed = openFaultClassItem(work, key.slice(faultActionKey('').length) as FaultClass);
      next.state = filed ? 'done' : 'failed';
      next.work = filed?.key ?? null;
      next.detail = filed ? `Resumed: ${filed.key} stands open for the class; later instances link to it` : 'Resumed: no item stands for the class, so it is filed again under the same idempotency key';
    } else {
      next.state = 'indeterminate';
      next.detail = `Resumed: the ${action.kind} request was interrupted and its effect is unknown`;
    }
    resumed.push(storeAction(state, key, next));
  }
  return resumed;
}

export const dispatchKey = (work: Work) => `dispatch:${work.id}:${work.epoch}`;
export const candidateKey = (kind: DaemonActionKind, work: Work) => `${kind}:${work.id}:${work.candidate?.sha ?? 'none'}:${work.candidate?.baseSha ?? 'none'}:${work.policyRevision}`;
export const closeKey = (profile: WorkerProfile, pane: string) => `close:${profile.name}:${pane}`;
/** One routine decision per action, item, binding (the head, or the quarantined epoch) and policy revision. */
export const decisionKey = (work: Work, decision: Pick<RoutineDecision, 'action' | 'binding'>) => `decision:${decision.action}:${work.id}:${decision.binding}:${work.policyRevision}`;
/** One decision per request: the instant the worker recorded it identifies the ask. */
export const scopeKey = (work: Work, request: ScopeRequestState) => `scope:${work.id}:${request.epoch}:${request.at}`;
/**
 * The requirements revision that widens `work` by `paths` in answer to `request`. It names the
 * request it answers and the head its findings were read for, so the control plane refuses it once a
 * claim or a lease end has cleared that request, or a push has replaced that head, while the loop
 * was still reading the findings it is grounded on.
 */
export const answeringWidening = (work: Work, request: ScopeRequestState, paths: string[], reason: string) => ({
  expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: work.dependencies,
  plannedFiles: [...new Set([...(work.plannedFiles ?? []), ...paths])], exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [],
  reason, answers: { epoch: request.epoch, at: request.at, sha: work.candidate?.sha ?? null } });

export function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? Math.max(0, Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)])) : 0;
  return { count: sorted.length, p50Ms: at(50), p90Ms: at(90) };
}

/**
 * How the loop is keeping the promise a scope request rests on: request-to-decision percentiles
 * over the decisions it has taken, every request still undecided with how long it has waited, and
 * the breaches of the two bounds — p90 within five minutes once ten requests have been decided,
 * and nothing left undecided for longer than fifteen. A breach means workers are waiting on the
 * loop, so it is escalated with the numbers rather than left in the metrics.
 */
export function scopeBudget(work: Work[], decisions: ScopeMeasurement[], now: number) {
  const measured = percentiles(decisions.map(entry => entry.waitedMs));
  const open = work.flatMap(item => {
    const request = item.scopeRequest;
    return request && !request.decision ? [{ key: item.key, epoch: request.epoch, waitedMs: Math.max(0, now - Date.parse(request.at)) }] : [];
  }).sort((a, b) => b.waitedMs - a.waitedMs);
  // One id per breach, not per wording: the numbers in the detail move every cycle, and an
  // escalation that changed key each time would read as a new incident every twenty seconds.
  const breaches = [
    ...(measured.count >= scopeDecisionSample && measured.p90Ms > scopeDecisionBudgetMs
      ? [{ id: 'p90', detail: `Scope decisions are too slow: p90 is ${Math.round(measured.p90Ms / 1000)}s over the last ${measured.count} requests, above the ${scopeDecisionBudgetMs / 60_000}-minute budget` }] : []),
    ...open.filter(entry => entry.waitedMs > scopeBlockedBudgetMs)
      .map(entry => ({ id: `blocked:${entry.key}:${entry.epoch}`,
        detail: `${entry.key} has been blocked on its scope request for ${Math.round(entry.waitedMs / 60_000)} minutes, above the ${scopeBlockedBudgetMs / 60_000}-minute bound; decide it with graphyard master scope ${entry.key} REASON` })),
  ];
  return { ...measured, open, longestOpenMs: open[0]?.waitedMs ?? 0, breaches, withinBudget: !breaches.length };
}

/**
 * Stage dwell for work still in flight, delivered lead time, and the post-deploy flow: time to the
 * observed deployment and time from merge to the smoke verdict, with failures counted. All of it
 * comes from the snapshot the cycle already read, so the measurement cannot disagree with the
 * state the cycle acted on.
 */
export function stageMetrics(work: Work[], now: number) {
  const stages: Record<string, ReturnType<typeof percentiles>> = {};
  const open = work.filter(item => item.stage !== 'done');
  for (const stage of [...new Set(open.map(item => item.stage))].sort()) {
    stages[stage] = percentiles(open.filter(item => item.stage === stage).map(item => now - Date.parse(item.stageEnteredAt)).filter(Number.isFinite));
  }
  const delivered = work.filter(item => item.stage === 'done' && item.delivery);
  const lead = percentiles(delivered.map(item => Date.parse(item.delivery!.mergedAt) - Date.parse(item.createdAt)).filter(value => Number.isFinite(value) && value >= 0));
  const production = percentiles(delivered.map(item => productionLatencyMs(item)).filter((value): value is number => value !== null));
  const postDeploy = percentiles(delivered.map(item => postDeployMs(item, now)).filter((value): value is number => value !== null));
  const postDeployFailures = delivered.filter(item => deliveryState(item) === 'delivered-with-failure').length;
  return { stages, lead, production, postDeploy, postDeployFailures };
}

export function missingProofs(work: Work, now: Date) {
  const proofs = [...new Set(work.criteria.flatMap(criterion => criterion.proofs))];
  return proofs.filter(proof => {
    const evidence = currentEvidence(work, proof, now);
    return !evidence || evidence.result !== 'pass' || evidence.executed < 1 || evidence.skipped > 0;
  });
}

/** An assignment whose watch supervisor has outlived the session it was launched to run. */
export interface OrphanSupervisor { id: string; key: string; epoch: number; owner: string; profile: string; agentName: string; scope: ContainmentScope; leaseExpiresAt: string }

/**
 * Assignments held by a supervisor whose session Herdr no longer reports.
 *
 * The supervisor records its own pid and the containment scope it created when it launches, so an
 * orphan is named by the launch record rather than found with `pgrep`. Only an assignment carrying
 * that record for the very epoch that holds the lease qualifies: without it there is no scope to
 * stop the supervisor through, and a neighbouring attempt's scope must never be mistaken for it.
 *
 * This says nothing about whether the lease is still advancing — the caller that acts on it needs
 * a second observation for that (`orphanObservationSchema`); `master status` names what it sees.
 */
export function orphanedSupervisors(work: Work[], profiles: WorkerProfile[], agents: HerdrAgent[], now: number): OrphanSupervisor[] {
  return work.flatMap(item => {
    const lease = item.lease;
    if (item.stage === 'done' || !lease || !(Date.parse(lease.expiresAt) > now)) return [];
    const profile = profiles.find(candidate => candidate.mode === 'launch' && candidate.principal === lease.owner);
    if (!profile || agents.some(agent => agent.name === profile.agentName)) return [];
    const quarantine = item.containmentQuarantine;
    if (!quarantine?.scope || quarantine.epoch !== lease.epoch || quarantine.owner !== lease.owner) return [];
    return [{ id: item.id, key: item.key, epoch: lease.epoch, owner: lease.owner, profile: profile.name, agentName: profile.agentName, scope: quarantine.scope, leaseExpiresAt: lease.expiresAt }];
  });
}

/**
 * Stop one orphaned watch supervisor on this host: the containment scope it created for the agent,
 * and the supervisor process that outlived it.
 *
 * The scope is the master's own user unit, so no privilege beyond the coordinator's own session is
 * used. The recorded pid is signalled only while its own command line still names this assignment's
 * `watch KEY EPOCH --` invocation: a pid the kernel has since handed to something else is reported,
 * never signalled. A refusal of one half is recorded; only a stop that reached neither throws.
 */
export async function stopWatchSupervisor(orphan: OrphanSupervisor, signal: NodeJS.Signals, run: ChildRun,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill, readCommand: (pid: number) => string = pid => readFileSync(`/proc/${pid}/cmdline`, 'utf8')) {
  if (!scopePattern.test(orphan.scope.unit)) throw new Error(`Recorded containment scope ${orphan.scope.unit} is not a Graphyard watch scope`);
  const refusals: string[] = [];
  let stopped = 0;
  try { await run('systemctl', ['--user', 'kill', '--kill-whom=all', `--signal=${signal}`, orphan.scope.unit]); stopped++; }
  catch (error) { refusals.push(`containment scope ${orphan.scope.unit} could not be signalled: ${message(error)}`); }
  let argv: string[] | null = null;
  try { argv = readCommand(orphan.scope.pid).split('\0').filter(Boolean); }
  catch (error) { refusals.push(`supervisor pid ${orphan.scope.pid} could not be read: ${message(error)}`); }
  if (argv) {
    const assignment = watchAssignment(argv);
    if (assignment?.key === orphan.key && assignment.epoch === String(orphan.epoch)) {
      try { kill(orphan.scope.pid, signal); stopped++; }
      catch (error) { refusals.push(`supervisor pid ${orphan.scope.pid} could not be signalled: ${message(error)}`); }
    } else refusals.push(`pid ${orphan.scope.pid} no longer runs the watch supervisor for ${orphan.key} epoch ${orphan.epoch}`);
  }
  if (!stopped) throw new Error(refusals.join('; ') || 'Nothing of the recorded containment could be stopped');
  return { unit: orphan.scope.unit, pid: orphan.scope.pid, signal, refusals };
}

export interface ProfileHealth { profile: WorkerProfile; healthy: boolean; busy: boolean; reason: string | null }
/**
 * A profile is dispatchable only when its credential still authenticates its principal, its agent
 * name is free in Herdr, and it is not inside a failure cool-off. Everything else routes around it.
 * A profile that is merely working is `busy`: that is capacity, not something to escalate.
 */
export function profileHealth(profiles: WorkerProfile[], credentials: Record<string, { available: boolean; reason: string | null }>, agents: HerdrAgent[], state: DaemonState, now: number): ProfileHealth[] {
  return profiles.map(profile => {
    const credential = credentials[profile.name] ?? { available: true, reason: null };
    const agent = agents.find(candidate => candidate.name === profile.agentName);
    const cooldown = state.profiles[profile.name]?.cooldownUntil;
    const busy = profile.mode === 'launch' && credential.available && !!agent;
    const reason = profile.mode !== 'launch' ? 'Existing sessions are observed only; Graphyard will not inject new work into an unsupervised process'
      : !credential.available ? credential.reason ?? 'Worker credential is unavailable'
        : agent ? `Herdr agent ${profile.agentName} is ${agent.agent_status ?? 'present'}`
          : cooldown && Date.parse(cooldown) > now ? `Cooling off after a failed launch until ${cooldown}: ${state.profiles[profile.name]?.reason ?? 'launch failed'}`
            : null;
    return { profile, healthy: !reason, busy, reason };
  });
}

/** Retry a refused action on a widening cycle interval rather than on every pass. */
export function readyToRetry(previous: DaemonAction | undefined, cycle: number, maxBackoffCycles = 30) {
  if (!previous) return true;
  if (previous.state !== 'failed') return false;
  return cycle - previous.cycle >= Math.min(2 ** Math.max(0, previous.attempts - 1), maxBackoffCycles);
}

export function recordProfileFailure(state: DaemonState, profile: WorkerProfile, reason: string, now: number) {
  const previous = state.profiles[profile.name] ?? { failures: 0, reason: null, cooldownUntil: null };
  state.profiles[profile.name] = { failures: previous.failures + 1, reason: reason.slice(0, 500), cooldownUntil: new Date(now + profileCooldownMs).toISOString() };
}
export function clearProfileFailure(state: DaemonState, profile: WorkerProfile) { delete state.profiles[profile.name]; }

// ---- Routine decisions ---------------------------------------------------------------------
/*
 * The pipeline used to stop here. A verdict landed, a base conflicted, a supervisor died — and
 * nothing moved until a master session happened to look. Each of those is a routine decision with
 * one correct answer, so the loop makes it: it requests the decision with the master's own
 * operator-agent identity and launches the independent approver session for it. It never approves
 * its own request, never weakens a requirement, and never touches a worker or producer credential;
 * the separation the server enforces is unchanged, and only the waiting is gone.
 */

export interface StandingVerdict { reviewer: string; at: string; reason: string }
/**
 * The change request standing against the exact current candidate. Observations keep one review
 * per reviewer, so a CHANGES_REQUESTED entry on the head is the reviewer's latest word on it; an
 * agent or Codex provider records `verdict: 'changes-requested'` on the head instead. Either way
 * the head cannot progress, and the item is waiting for a rework round nobody has asked for.
 *
 * `approved: false` alone is never a verdict. The observers report it for a review not yet
 * dispatched, one still running, a retry, an unready pull request and exhausted profiles, and a
 * submission ends the worker's lease — so reading it as a verdict would send a head nobody has
 * reviewed back to a worker on the cycle after it was submitted, and skip its proofs.
 */
/**
 * The binding `exactApproval` demands of an approval, demanded of a change request too: the verdict
 * answers the request Graphyard recorded for this candidate, base and policy revision, under the
 * provider the policy names. A verdict left over from an earlier request is not the head's.
 */
function agentVerdictBindsRequest(work: Work, agent: AgentReview): boolean {
  const candidate = work.candidate!, request = work.reviewRequest;
  return agent.provider === reviewProviderOf(work.policy) && !!request && request.commentId === agent.requestId
    && request.sha === candidate.sha && request.baseSha === candidate.baseSha && request.policyRevision === work.policyRevision;
}
export function standingVerdict(work: Work): StandingVerdict | null {
  const candidate = work.candidate, observation = work.observation;
  if (!work.submission || work.reworkRequested || !candidate || !observation) return null;
  if (observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha) return null;
  const review = observation.reviews.find(entry => entry.sha === candidate.sha && entry.state === 'CHANGES_REQUESTED');
  if (review) return { reviewer: review.reviewer, at: review.submittedAt ?? observation.at, reason: `${review.reviewer} requested changes on ${review.sha.slice(0, 12)}` };
  const agent = observation.agentReview;
  if (agent && agent.sha === candidate.sha && !agent.approved && agent.verdict === 'changes-requested' && agentVerdictBindsRequest(work, agent))
    return { reviewer: agent.profile ?? agent.provider, at: agent.completedAt ?? observation.at, reason: `${agent.profile ?? agent.provider} requested changes on ${agent.sha.slice(0, 12)}: ${agent.reason}` };
  return null;
}

/**
 * GY-144. Rework throws away a current review and its proofs, so it is asked for only on a GitHub
 * observation that still describes the item: one taken within the two minutes the merge gate
 * trusts, while GitHub answers. During a rate-limit pause the control plane cannot observe, and
 * a worker may meanwhile have synced, pushed and submitted a green head the last observation
 * never saw; a verdict or conflict read from that observation is about a head the branch has
 * moved past. The loop waits for a fresh observation and decides from that.
 */
export const reworkObservationMaxAgeMs = 120_000;
export interface GitHubPause { until: string }
/**
 * Whether the control plane's GitHub client is paused, read from the observation jobs it refused:
 * a paused client refuses every request with "GitHub requests paused until <time>", and the job
 * keeps that error until it next runs. The latest pause still in the future is the one standing.
 */
export function githubPause(jobs: readonly { error?: string | null }[] | undefined, now: number): GitHubPause | null {
  let until = 0;
  for (const job of jobs ?? []) {
    const at = Date.parse(/requests paused until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(job.error ?? '')?.[1] ?? '');
    if (Number.isFinite(at) && at > now && at > until) until = at;
  }
  return until ? { until: new Date(until).toISOString() } : null;
}
/** What a rework request records of the observation it was decided from, so an approver can see whether the item has moved since. */
export const observedFrom = (work: Work) => work.observation
  ? `[Decided from the GitHub observation taken at ${work.observation.at} of candidate ${work.observation.candidate.sha}; if the item has moved since, this request no longer describes it.]`
  : '[Decided with no GitHub observation of the item.]';
/**
 * Why a rework request must wait for a fresh observation, or null when the one on the item may be
 * decided from. The reason names the stale observation — its time and head — and never its age,
 * so it reads the same on every cycle it stands.
 */
export function reworkObservationWait(work: Work, now: number, pause: GitHubPause | null): string | null {
  const observation = work.observation;
  if (!observation) return `${work.key}: rework waits for a GitHub observation of the item; there is none to decide from`;
  const seen = `the last GitHub observation (taken at ${observation.at} of head ${observation.candidate.sha.slice(0, 12)})`;
  if (pause) return `${work.key}: rework waits for a fresh GitHub observation — GitHub requests are paused until ${pause.until}, so ${seen} is a stale observation that may describe a head the branch has moved past`;
  const age = now - Date.parse(observation.at);
  if (!(Number.isFinite(age) && age < reworkObservationMaxAgeMs)) return `${work.key}: rework waits for a fresh GitHub observation — ${seen} is a stale observation, older than two minutes, and the branch may have moved past that head`;
  return null;
}

export const routineDecisionActions = ['rework', 'recover', 'merge', 'resolve'] as const;
export type RoutineDecisionAction = typeof routineDecisionActions[number];
/** `input` is what the decision names beyond what `decisionInput` derives from the item (a resolve's trigger). */
/** `escalation` is the one standing escalation a resolve settles: a standing request for any other is not this decision. */
export interface RoutineDecision { action: RoutineDecisionAction; reason: string; binding: string; input?: Record<string, unknown>; escalation?: { trigger: string; at: string } }
/**
 * The decision one item needs right now, or null. Rework returns a head nothing can carry forward
 * — a standing verdict, or a base branch Graphyard could not merge in — to a fresh attempt.
 * Recovery releases a delivered item whose supervisor is still quarantined. A merge decision is
 * needed only where automatic merging is off, and then for the exact candidate that is mergeable.
 */
export function routineDecision(work: Work, config: Pick<MasterConfig, 'autoMerge'>, now: number, assessment?: ContainmentAssessment | null): RoutineDecision | null {
  const needed = neededDecision(work, config);
  if (!needed) return null;
  if (needed.action === 'merge') return needed;
  // A lease-loss a newer attempt superseded rests on the record, not on this host: see supersededLeaseLoss.
  if (needed.action === 'resolve' && supersededLeaseLoss(work)?.superseded) return needed;
  const stopped = workerStopped(work, now, assessment);
  // The grounds travel with the request: the approver cannot verify this host, so it is told
  // exactly what the requester verified and judges the attestation on that.
  return stopped.stopped ? { ...needed, reason: `${needed.reason} The previous worker is stopped: ${stopped.grounds}.` } : null;
}
/** What the item calls for, before asking whether the loop may attest that its worker is stopped. */
function neededDecision(work: Work, config: Pick<MasterConfig, 'autoMerge'>): RoutineDecision | null {
  if (work.stage === 'done') {
    return work.containmentQuarantine
      ? { action: 'recover', reason: `${work.key} is delivered and still fenced by its epoch ${work.containmentQuarantine.epoch} containment quarantine; recovery releases it without touching the delivery.`, binding: String(work.containmentQuarantine.epoch) } : null;
  }
  // Like a verdict, a conflict keeps matching the head it was found on until a new one is pushed,
  // and the engine's `rework` does not clear it: once the round is requested the item needs a
  // worker, not a second decision, even when that round's worker dies before pushing.
  const conflict = work.reworkRequested ? null : baseRefreshConflict(work);
  // A rework binding names its grounds as well as the head: a refused request on one ground (the
  // approver judged it premature) must not bar the same head's rework on another. On 2026-09-24
  // GY-163's thread rework was refused before its reviewer had judged the head; the reviewer then
  // requested changes, and the loop never asked again because both keyed on the head alone.
  if (conflict) return { action: 'rework', reason: `${work.key}: ${conflict}. Only a fresh attempt can resolve it, so the candidate returns to a worker.`, binding: `${work.candidate!.sha}:conflict` };
  const verdict = standingVerdict(work);
  if (verdict) return { action: 'rework', reason: `${work.key}: ${verdict.reason}. The verdict stands against the current head, so the item returns to a worker for the next round.`, binding: `${work.candidate!.sha}:verdict:${verdict.reviewer}` };
  // Unresolved review threads block the provider's merge (GY-139) whatever the review state that
  // opened them — a bot's COMMENTED review leaves no verdict, so without this the item waited on a human.
  // The review of the current head judges those threads first: its approval names the ones fixed and
  // the loop resolves them, so a rework requested before it settles invalidated the review that
  // would have cleared them, and the same open threads carried to the next head — without end.
  const threads = !work.reworkRequested && work.candidate && !threadsAwaitReview(work, Date.parse(work.observation?.at ?? '')) ? blockingThreads(work) : [];
  if (threads.length) return { action: 'rework', reason: `${work.key}: ${threadReworkSummary(work.candidate!.sha, threads)}. The findings stand against the current head, so the item returns to a worker to address them; the next review names the threads it verified fixed and the loop resolves them.`,
    binding: `${work.candidate!.sha}:threads:${threads.map(thread => thread.id ?? `${thread.path}:${thread.line}`).sort().join(',')}` };
  // A lease-loss the control plane raised is operational: once the lost attempt can no longer act,
  // settling it is a routine two-party decision, not a wait on a human master session (GY-161,
  // 2026-09-24: its first worker exited five minutes in, a new attempt took the item, and the
  // standing escalation would have refused the merge until somebody asked for the resolution).
  const lost = supersededLeaseLoss(work);
  if (lost) return { action: 'resolve', input: { trigger: 'lease-loss' }, escalation: { trigger: 'lease-loss', at: lost.escalation.at }, binding: `lease-loss:${lost.epoch}:${lost.escalation.at}`,
    reason: `${work.key}: the control plane raised a lease-loss for epoch ${lost.epoch} at ${lost.escalation.at} (${lost.escalation.reason}). ${lost.evidence}Nothing from the lost attempt can act or merge. Resolving clears only this concern: it decides no gate and ships nothing.` };
  if (!config.autoMerge && mergeableCandidate(work)) return { action: 'merge', reason: `${work.key}: every gate passes for candidate ${work.candidate!.sha.slice(0, 12)} and automatic merging is off, so the merge needs an approved decision.`, binding: work.candidate!.sha };
  return null;
}
/**
 * The standing control-plane lease-loss the loop may ask to settle, and why. `superseded` when a
 * newer attempt took the item: a claim needs the old lease ended, and a newer attempt's containment
 * fence can only be raised once the lost epoch's fence was lowered, so the record alone shows the
 * lost attempt can no longer act. Otherwise the item is between attempts, and the request also
 * rests on this host verifying the worker stopped (`workerStopped`, applied in `routineDecision`).
 * A lead-raised concern, another trigger, or a lost epoch whose fence still stands is never asked.
 */
export function supersededLeaseLoss(work: Work): { escalation: ReturnType<typeof standingEscalations>[number]; epoch: number; superseded: boolean; evidence: string } | null {
  if (work.stage === 'done') return null;
  for (const escalation of standingEscalations(work)) {
    const epoch = leaseLossEpoch(escalation);
    if (escalation.trigger !== 'lease-loss' || escalation.actor !== 'graphyard' || epoch === null) continue;
    const fence = work.containmentQuarantine;
    if (fence && fence.epoch <= epoch) continue;
    // Only the latest attempt's own lease or submission shows it: a submission survives the rework
    // claim that follows it, so an older one would vouch for a later attempt that lapsed unexplained
    // (its lease-loss suppressed as a repeat of this one) and resolving would erase that loss too.
    const newer = work.epoch > epoch && (work.lease && work.lease.epoch === work.epoch ? `epoch ${work.lease.epoch} is held by ${work.lease.owner}`
      : work.submission && work.submission.epoch === work.epoch ? `epoch ${work.submission.epoch} submitted PR #${work.submission.pr}` : null);
    if (newer) return { escalation, epoch, superseded: true, evidence: `A newer attempt superseded it: ${newer}, a claim is granted only after the epoch ${epoch} lease has ended, and ${fence ? `the containment fence now standing belongs to epoch ${fence.epoch}, so the epoch ${epoch} fence was lowered` : 'no containment fence stands'}. ` };
    if (work.epoch === epoch && (!work.lease || work.lease.epoch !== epoch)) return { escalation, epoch, superseded: false, evidence: `No newer attempt holds the item. ` };
  }
  return null;
}
/**
 * Whether a standing resolve decision settles exactly this escalation: the same trigger, and — when
 * the control plane reports the pin it was requested against — the same raising of it.
 */
export function resolveCovers(standing: { input: any; pin?: { escalations?: { trigger: string; at: string }[] } | null }, escalation: { trigger: string; at: string }): boolean {
  if (standing.input?.trigger !== escalation.trigger) return false;
  return !standing.pin?.escalations || standing.pin.escalations.some(entry => entry.trigger === escalation.trigger && entry.at === escalation.at);
}
/** The control plane's bound on a decision's reason (`src/model/approval.ts`); a longer one is refused on every retry. */
export const decisionReasonMax = 2000;
/** How many unresolved threads a rework reason names; the binding still carries every one, and the worker reads them all from the pull request. */
const reworkThreadsNamed = 5;
/**
 * The unresolved threads a rework request names, bounded: their authors and paths are contributor
 * text of any length and count, and a reason past the control plane's bound is refused on every
 * retry, so the item would never reach its approver or its rework worker.
 */
export function threadReworkSummary(sha: string, threads: ReviewThread[]): string {
  const named = threads.slice(0, reworkThreadsNamed).map(thread => { const text = describeThread(thread); return text.length > 120 ? `${text.slice(0, 119)}…` : text; });
  const more = threads.length - named.length;
  return `Branch protection requires conversation resolution and ${threads.length} review thread${threads.length === 1 ? ' is' : 's are'} unresolved on ${sha.slice(0, 12)}: ${named.join('; ')}${more ? `; and ${more} more on the pull request` : ''}. GitHub blocks the merge until each is resolved; rework the candidate to address the findings, never dismiss them`;
}
/**
 * A decision reason within the control plane's bound. What the requester adds around the loop's own
 * grounds — the observation it decided from, the refusals it answers — is kept whole, because the
 * server reads the cited refusals from it; the grounds are shortened to make room.
 */
export function fitDecisionReason(prefix: string, grounds: string, suffix: string): string {
  const room = decisionReasonMax - prefix.length - suffix.length;
  return prefix + (grounds.length <= room ? grounds : `${grounds.slice(0, Math.max(0, room - 1))}…`) + suffix;
}
/**
 * An action detail within its bound. A scope request carries up to 50 paths of up to 500 characters,
 * so a detail that lists them — or quotes an error that does — is cut, never left to fail record()
 * after the action it records has already happened. record() applies it to every detail it stores.
 */
export function boundDetail(detail: string, max = actionDetailMax): string {
  return detail.length <= max ? detail : `${detail.slice(0, max - 1)}…`;
}

/**
 * Whether a detail differs from the one an action already stores. record() stores the bounded form,
 * so a stable detail over the bound compares equal and is not re-recorded every cycle (GY-179).
 */
export function detailChanged(previous: { detail: string } | undefined, detail: string): boolean {
  return previous?.detail !== boundDetail(detail);
}

/** Paths named in a detail: every one while short, else the first few and a count of the rest. */
export function namePaths(paths: readonly string[], room = 600): string {
  const named: string[] = [];
  let used = 0;
  for (const path of paths) {
    const text = path.length > 200 ? `${path.slice(0, 199)}…` : path;
    if (named.length && used + text.length + 2 > room) break;
    named.push(text);
    used += text.length + 2;
  }
  const more = paths.length - named.length;
  return `${paths.length} file${paths.length === 1 ? '' : 's'} (${named.join(', ')}${more ? ` and ${more} more` : ''})`;
}
/** The least of its own grounds a rework request keeps beside the refusals it cites; below it the request would not say why. */
export const reworkGroundsMin = 160;
/**
 * A rework reason that cites every refused rework decision on the item — the server refuses a
 * request of the same input unless its reason names each one by id — within the control plane's
 * bound. The citations are written out in prose while they leave the grounds room, then as a bare
 * id list; when even that leaves the grounds less than `reworkGroundsMin`, no reason can satisfy
 * both the bound and the server's check, and this is null: the loop escalates rather than sending a
 * request the server refuses on every retry.
 */
export function reworkDecisionReason(prefix: string, grounds: string, refused: string[]): string | null {
  if (!refused.length) return fitDecisionReason(prefix, grounds, '');
  const prose = ` This rests on different grounds from refused rework decision${refused.length === 1 ? '' : 's'} ${refused.join(', ')}, which ${refused.length === 1 ? 'was' : 'were'} judged on earlier grounds.`;
  const bare = ` Answers refused rework decisions ${refused.join(' ')}.`;
  const suffix = [prose, bare].find(text => decisionReasonMax - prefix.length - text.length >= Math.min(reworkGroundsMin, grounds.length));
  return suffix === undefined ? null : fitDecisionReason(prefix, grounds, suffix);
}
/**
 * Whether the loop may attest that the item's previous worker is stopped. `rework` and `recover`
 * carry that attestation and the engine lowers the containment fence on it, so it rests only on
 * what was verified: no lease is held, and either no fence stands — the worker's own supervisor
 * settled it at exit, or this loop settled it after verifying the supervisor gone — or this host's
 * probe verified the supervisor gone on the snapshot this cycle acts on. A fence in its grace
 * window is waited out. A lapsed fence this host could not verify is `unverified`: the decision is
 * withheld and escalated, never requested on an attestation nobody checked.
 */
export function workerStopped(work: Work, now: number, assessment?: ContainmentAssessment | null): { stopped: boolean; grounds: string; unverified: string | null } {
  if (work.lease && Date.parse(work.lease.expiresAt) > now) return { stopped: false, grounds: '', unverified: null };
  const quarantine = work.containmentQuarantine;
  if (!quarantine) return { stopped: true, grounds: `${work.key} holds no lease and no containment fence stands for it`, unverified: null };
  if (containmentPhase(work, now)?.state !== 'lapsed') return { stopped: false, grounds: '', unverified: null };
  if (assessment?.settleable && assessment.epoch === quarantine.epoch)
    return { stopped: true, grounds: `its lease and launch authority have lapsed, and the master loop verified on ${assessment.host ?? 'the registered host'} that the supervisor of epoch ${quarantine.epoch} is gone`, unverified: null };
  return { stopped: false, grounds: '', unverified: assessment?.refusals.length ? assessment.refusals.join('; ') : `no host verification of the epoch ${quarantine.epoch} supervisor was possible from this loop` };
}
/** The decision an item needs but the loop will not request, because the stopped worker is unverified. */
export function withheldDecision(work: Work, config: Pick<MasterConfig, 'autoMerge'>, now: number, assessment?: ContainmentAssessment | null): { action: RoutineDecisionAction; reason: string } | null {
  const needed = neededDecision(work, config);
  if (!needed || needed.action === 'merge' || needed.action === 'resolve' && supersededLeaseLoss(work)?.superseded) return null;
  const unverified = workerStopped(work, now, assessment).unverified;
  return unverified ? { action: needed.action, reason: `${work.key} needs a ${needed.action} decision, but it attests that the previous worker is stopped and that is not verified: ${unverified}` } : null;
}

// ---- The approver a decision is waiting on -------------------------------------------------
/*
 * A requested decision changes nothing until an approver judges it, and the approver is a launched
 * session: it can die, drop its prompt, hit an account limit, decline, or hang. Each cycle therefore
 * reads the decision back from the control plane and the session back from Herdr, and takes the one
 * step that follows. Launches are bounded, so a decision no session will judge ends as an escalation
 * and an actionable silence rather than as a relaunch every few minutes forever.
 */
export const approverJudgeBoundMs = 600_000, approverSettleMs = 60_000, maxApproverLaunches = 3, maxApproverCloses = 3, maxDecisionRequests = 3;
export type ApprovalStep =
  | { step: 'wait'; detail: string }
  | { step: 'settled'; detail: string }
  | { step: 'refused'; detail: string }
  | { step: 'rerequest'; detail: string }
  | { step: 'relaunch'; detail: string }
  | { step: 'exhausted'; detail: string };
export function approvalStep(watch: ApprovalWatch, decision: { state: string; outcome?: string | null; refusal?: { approver: string; reason: string } | null } | null | undefined,
  sessions: { agents: HerdrAgent[]; available: boolean }, now: number): ApprovalStep {
  const label = `${watch.action} decision ${watch.decision} on ${watch.work}`;
  // `undefined`: the history could not be read this cycle. Nothing is concluded from that.
  if (decision === undefined) return { step: 'wait', detail: `The decision history of ${watch.work} could not be read; ${label} is looked at again next cycle` };
  if (decision === null) return { step: 'rerequest', detail: `The control plane no longer holds ${label}` };
  if (decision.state === 'applied') return { step: 'settled', detail: `The approver applied ${label}` };
  // A refusal is the approver's considered judgement (GY-141), not a session to replace or a
  // request to repeat: the server refuses the same request unchanged, and answering it is the master's.
  if (decision.state === 'refused') return { step: 'refused', detail: `${label} was refused by ${decision.refusal?.approver ?? 'its approver'}: ${decision.refusal?.reason ?? decision.outcome ?? 'no reason recorded'}` };
  if (decision.state !== 'requested' && decision.state !== 'approved')
    return { step: 'rerequest', detail: `${label} ended ${decision.state}${decision.outcome ? ` (${decision.outcome})` : ''}` };
  if (!sessions.available) return { step: 'wait', detail: `Herdr could not be read, so the approver session of ${label} is unknown this cycle` };
  const session = watch.agentName ? sessions.agents.find(agent => agent.name === watch.agentName) : undefined;
  const launchedAt = watch.launchedAt ? Date.parse(watch.launchedAt) : Number.NaN, age = Number.isFinite(launchedAt) ? now - launchedAt : 0;
  const ended = !session ? `approver session ${watch.agentName ?? '(never launched)'} is gone without judging it`
    : ['idle', 'done', 'blocked'].includes(session.agent_status ?? '') && age >= approverSettleMs ? `approver session ${watch.agentName} ended ${session.agent_status} without approving it — declined, or its prompt was dropped`
      : age > approverJudgeBoundMs ? `approver session ${watch.agentName} has not judged it for ${Math.round(age / 60_000)} minutes, past the ${Math.round(approverJudgeBoundMs / 60_000)}-minute bound`
        : null;
  if (!ended) return { step: 'wait', detail: `${label} is with approver session ${watch.agentName} (launch ${watch.launches} of ${maxApproverLaunches})` };
  return watch.launches < maxApproverLaunches ? { step: 'relaunch', detail: `${label}: ${ended}` } : { step: 'exhausted', detail: `${label}: ${ended}` };
}
/** Every gate green on a submitted candidate: what "mergeable" means to the cycle and its budget. */
export const mergeableCandidate = (work: Work) => work.stage === 'merge' && !!work.candidate && !work.violations.length && work.gates.every(gate => gate.passed);

// ---- What the loop could act on ------------------------------------------------------------
/*
 * A cycle that reports "0 actions" says nothing about whether it had anything to do. Every cycle
 * therefore records both halves: the subjects it could act on, and the actions it took. A subject
 * the cycle acts on has its clock reset; one that goes without any action accumulates, and the
 * longest such wait is what `master status` reports and what the 20-minute bound is judged on.
 */
export const silenceBudgetMs = 1_200_000;
export interface ActionableSubject { key: string; kind: DaemonActionKind; work: string | null; detail: string }
export function actionableSubjects(config: Pick<MasterConfig, 'autoMerge' | 'run'>, work: Work[], now: number,
  context: { assessments?: Record<string, ContainmentAssessment>; approvals?: DaemonState['approvals'] } = {}): ActionableSubject[] {
  const subjects: ActionableSubject[] = [];
  const add = (kind: DaemonActionKind, item: Work | null, detail: string) => subjects.push({ key: `${kind}:${item?.key ?? 'pipeline'}`, kind, work: item?.key ?? null, detail });
  // An open item the control plane names no action for and nothing is moving. The loop cannot
  // clear it — that is what makes it a subject rather than an action: counted here, its wait
  // accumulates against the silence bound instead of being absent from every measure the loop
  // keeps, which is how an item used to hold a failing gate for hours with nobody told (GY-106).
  const stalled = new Map(stalledItems(work, new Date(now), 0).map(entry => [entry.key, entry]));
  for (const item of work) {
    // A routine decision is the one subject a delivered item can still raise: containment recovery.
    // It stays a subject until it is applied. A decision sitting with an approver is the pipeline
    // waiting on its own agent, and counting that as nothing to act on is how a dead approver used
    // to make an item disappear from the one measure built to notice it.
    const decision = routineDecision(item, config, now, context.assessments?.[item.id]);
    const watch = decision ? context.approvals?.[decisionKey(item, decision)] : undefined;
    if (decision && !watch?.settledAt) add('decision', item, !watch ? `${item.key} needs a ${decision.action} decision requested and approved`
      : watch.exhaustedAt ? `${item.key}'s ${decision.action} decision ${watch.decision} is unjudged after ${watch.launches} approver session(s)`
        : `${item.key}'s ${decision.action} decision ${watch.decision} is requested and waiting for approver session ${watch.agentName ?? '(not launched)'} to judge it`);
    const withheld = decision ? null : withheldDecision(item, config, now, context.assessments?.[item.id]);
    if (withheld) add('decision', item, withheld.reason.slice(0, 500));
    if (item.stage === 'done') continue;
    const stall = stalled.get(item.key);
    if (stall) add('escalation', item, `${item.key} holds its ${stall.gate ?? 'unevaluated'} gate with no action, no dependency and no recorded human need: ${stall.refusal ?? stall.detail}`);
    try { assertDispatchable(item, work, new Date(now).toISOString()); add('dispatch', item, `${item.key} is claimable and waiting for a worker`); } catch { /* not claimable: not actionable */ }
    const request = item.scopeRequest;
    if (request && (!request.decision || redecidableScopeRefusal(item)) && item.lease && item.lease.epoch === request.epoch && Date.parse(item.lease.expiresAt) > now)
      add('scope', item, boundDetail(`${item.key}: ${request.requestedBy} is waiting for a decision on ${namePaths(request.paths, 300)}`, 500));
    if (item.containmentQuarantine && containmentPhase(item, now)?.state === 'lapsed') add('settle', item, `${item.key} holds a lapsed containment quarantine from epoch ${item.containmentQuarantine.epoch}`);
    if (config.autoMerge && mergeableCandidate(item)) add('merge', item, `${item.key} is mergeable: every gate passes for ${item.candidate!.sha.slice(0, 12)}`);
    if (pendingBaseRefresh(item)) add('refresh', item, `${item.key} is waiting for the control plane to bring its candidate onto the moved base`);
    // The same heads step 5 shepherds: one a verdict stands against is going back to a worker,
    // so nothing asks for its proofs and nothing is waiting on them.
    if (item.submission && item.candidate && !item.reworkRequested && !standingVerdict(item) && config.run.proofWorkflow) {
      const outstanding = missingProofs(item, new Date(now)).filter(proof => !proof.startsWith('manual:'));
      if (outstanding.length) add('proof', item, `${item.key} is missing trusted evidence for ${outstanding.join(', ')}`);
    }
  }
  for (const item of work.filter(entry => entry.stage === 'done' && entry.delivery && deploySmokeRequired(entry.policy))) {
    const outcome = deliveryState(item);
    if (!item.delivery!.deployment) add('deployment', item, `${item.key} is merged and waiting for the deployment that serves it to be observed`);
    else if (outcome === 'awaiting-smoke') add('smoke', item, `${item.key} is deployed at ${item.delivery!.deployment.sha.slice(0, 12)} and waiting for its smoke proof`);
  }
  return subjects;
}

export interface SilenceEntry { key: string; kind: string; work: string | null; detail: string; since: string; idleMs: number }
export interface SilenceReport { actionable: number; longestIdleMs: number; longest: SilenceEntry | null; budgetMs: number; breached: boolean; lastActionAt: string | null; subjects: SilenceEntry[] }
/** Fold this cycle's actionable inventory and its actions into the silence record. */
export function trackSilence(state: DaemonState, subjects: ActionableSubject[], performed: DaemonAction[], now: number): SilenceReport {
  const record = state.silence, at = new Date(now).toISOString();
  // Only an action that succeeded is the loop acting on a subject. A request refused every time it
  // is retried — a revoked credential, a standing 409 — moves nothing, and a wait that restarted
  // on each refusal would never reach the bound that puts it in front of someone.
  const acted = new Set(performed.filter(action => action.state === 'done').map(action => `${action.kind}:${action.work ?? 'pipeline'}`));
  const live = new Map(subjects.map(subject => [subject.key, subject]));
  for (const key of Object.keys(record.subjects)) if (!live.has(key)) delete record.subjects[key];
  for (const [key, subject] of live) {
    const previous = record.subjects[key];
    // First sight, or an action for this exact subject: the wait starts again from now.
    if (!previous || acted.has(key)) record.subjects[key] = { since: at, work: subject.work, kind: subject.kind, detail: subject.detail };
    else record.subjects[key] = { ...previous, detail: subject.detail };
  }
  if (performed.length) record.lastActionAt = at;
  return silenceReport(record, now);
}
export function silenceReport(record: DaemonState['silence'], now: number): SilenceReport {
  const subjects: SilenceEntry[] = Object.entries(record.subjects)
    .map(([key, entry]) => ({ key, kind: entry.kind, work: entry.work, detail: entry.detail, since: entry.since, idleMs: Math.max(0, now - Date.parse(entry.since)) }))
    .sort((a, b) => b.idleMs - a.idleMs);
  const longestIdleMs = subjects[0]?.idleMs ?? 0;
  return { actionable: subjects.length, longestIdleMs, longest: subjects[0] ?? null, budgetMs: silenceBudgetMs, breached: longestIdleMs > silenceBudgetMs, lastActionAt: record.lastActionAt, subjects: subjects.slice(0, 20) };
}

// ---- Latency the loop is judged on ---------------------------------------------------------
/*
 * Four budgets, all measured from what the loop itself observed cycle by cycle, so no figure can
 * disagree with the state the loop acted on: ready work reaching a worker, a first push arriving,
 * a mergeable candidate merging, and a standing verdict reaching a rework request.
 */
export const latencyTargets = {
  readyToClaimP90Ms: 120_000, readyToFirstPushP90Ms: 900_000,
  approvalToMergeP90Ms: 600_000, mergeableToMergeMs: 300_000, verdictToReworkMs: 300_000,
  minimumDeliveries: 10,
} as const;

/** Bring one item's clock in line with the snapshot, and return the delivery sample it completed. */
export function observeItemClock(state: DaemonState, work: Work, now: number): LatencySample | null {
  const at = new Date(now).toISOString();
  const time = (value: string | null | undefined) => { const parsed = value ? Date.parse(value) : Number.NaN; return Number.isFinite(parsed) ? parsed : null; };
  // A delivery is sampled once, from the clock the loop held while the item was open, and sampling
  // drops that clock. A delivered item with no clock is therefore history — delivered before this
  // loop watched it, or already sampled — and measuring it again would start its clocks at this
  // cycle and bury every real passage under a zero per delivered item per cycle.
  if (work.stage === 'done' && !state.clocks[work.id]) return null;
  const clock: ItemClock = state.clocks[work.id] ?? itemClockSchema.parse({ key: work.key, epoch: work.epoch });
  state.clocks[work.id] = clock;
  clock.key = work.key;
  const claimable = (() => { try { assertDispatchable(work, [work], at); return true; } catch { return !work.lease && work.ready && !work.blocker && (!work.submission || work.reworkRequested); } })();
  // A rework round is a fresh wait for a worker, so the claim, push and approval clocks start over
  // the moment the item becomes claimable again — and that moment is this cycle, not whenever the
  // stage last changed: a verdict or a conflict lands before the round it needs is approved, and
  // charging the worker for the decision in between would measure the wrong thing.
  if (claimable && (clock.claimedAt || clock.pushedAt || clock.epoch !== work.epoch)) Object.assign(clock, { readyAt: at, claimedAt: null, pushedAt: null, approvedAt: null, mergeableAt: null });
  clock.epoch = work.epoch;
  // The first attempt's wait starts when the item was released, which may predate this loop.
  if (!clock.readyAt && claimable) clock.readyAt = new Date(time(work.stageEnteredAt) ?? now).toISOString();
  // Graphyard's own claim time, which outlives the lease: an attempt that claimed, pushed and
  // submitted between two cycles still measured its wait, because the assignment recorded it.
  const assignment = work.lastAssignment?.epoch === work.epoch ? work.lastAssignment : work.lease ? { claimedAt: undefined } : null;
  if (!clock.claimedAt && assignment) clock.claimedAt = new Date(time(assignment.claimedAt) ?? now).toISOString();
  const readyMs = time(clock.readyAt);
  if (!clock.pushedAt && work.candidate) {
    // The provider's own creation time when it belongs to this attempt; otherwise the first cycle
    // that saw the head, which is the earliest this loop can honestly claim to have observed it.
    const observed = [work.candidate.createdAt, work.observation?.at].map(time).find(value => value !== null && (readyMs === null || value >= readyMs));
    clock.pushedAt = new Date(observed ?? now).toISOString();
  }
  // An approval is a review gate that passed. An item with no review gate was never approved, so
  // it measures no approval→merge passage rather than one that starts at its first push.
  if (!clock.approvedAt && work.submission && !work.reworkRequested && work.gates.find(gate => gate.name === 'review')?.passed === true && work.gates.find(gate => gate.name === 'build')?.passed) clock.approvedAt = at;
  if (!clock.mergeableAt && mergeableCandidate(work)) clock.mergeableAt = at;
  if (work.stage !== 'done') return null;
  const mergedAt = time(work.delivery?.mergedAtRepository ?? work.delivery?.mergedAt) ?? now;
  const since = (value: string | null) => { const start = time(value); return start === null ? null : Math.max(0, Math.round(mergedAt - start)); };
  delete state.clocks[work.id];
  return latencySampleSchema.parse({ work: work.key, at: new Date(mergedAt).toISOString(),
    readyToClaimMs: clock.readyAt && clock.claimedAt ? Math.max(0, Math.round(Date.parse(clock.claimedAt) - Date.parse(clock.readyAt))) : null,
    readyToPushMs: clock.readyAt && clock.pushedAt ? Math.max(0, Math.round(Date.parse(clock.pushedAt) - Date.parse(clock.readyAt))) : null,
    approvalToMergeMs: since(clock.approvedAt), mergeableToMergeMs: since(clock.mergeableAt) });
}

export interface LatencyBudget {
  target: typeof latencyTargets; deliveries: number;
  readyToClaim: ReturnType<typeof percentiles>; readyToFirstPush: ReturnType<typeof percentiles>; approvalToMerge: ReturnType<typeof percentiles>;
  mergeDwell: { count: number; worstMs: number; breaches: { work: string; ms: number }[] };
  reworkRequest: { count: number; worstMs: number; breaches: { work: string; ms: number }[] };
  met: boolean | null; reasons: string[];
}
/**
 * The four budgets over the samples the cursor holds. `met` is null while fewer than ten
 * deliveries are measured — the population the p90 targets are stated for — and the per-candidate
 * bounds (mergeable→merge, verdict→rework) are judged on every sample, however few.
 */
export function latencyBudget(samples: LatencySample[]): LatencyBudget {
  const value = (key: keyof LatencySample) => samples.map(sample => sample[key]).filter((entry): entry is number => typeof entry === 'number');
  const deliveries = samples.filter(sample => sample.mergeableToMergeMs !== null || sample.approvalToMergeMs !== null).length;
  const bound = (key: 'mergeableToMergeMs' | 'verdictToReworkMs', limit: number) => {
    const measured = samples.filter(sample => typeof sample[key] === 'number');
    return { count: measured.length, worstMs: measured.reduce((worst, sample) => Math.max(worst, sample[key] as number), 0),
      breaches: measured.filter(sample => (sample[key] as number) > limit).map(sample => ({ work: sample.work, ms: sample[key] as number })) };
  };
  const readyToClaim = percentiles(value('readyToClaimMs')), readyToFirstPush = percentiles(value('readyToPushMs')), approvalToMerge = percentiles(value('approvalToMergeMs'));
  const mergeDwell = bound('mergeableToMergeMs', latencyTargets.mergeableToMergeMs), reworkRequest = bound('verdictToReworkMs', latencyTargets.verdictToReworkMs);
  const minutes = (ms: number) => `${Math.round(ms / 6000) / 10} min`;
  const reasons = [
    ...(readyToClaim.count && readyToClaim.p90Ms > latencyTargets.readyToClaimP90Ms ? [`ready→claim p90 ${minutes(readyToClaim.p90Ms)} exceeds ${minutes(latencyTargets.readyToClaimP90Ms)}`] : []),
    ...(readyToFirstPush.count && readyToFirstPush.p90Ms > latencyTargets.readyToFirstPushP90Ms ? [`ready→first push p90 ${minutes(readyToFirstPush.p90Ms)} exceeds ${minutes(latencyTargets.readyToFirstPushP90Ms)}`] : []),
    ...(approvalToMerge.count && approvalToMerge.p90Ms > latencyTargets.approvalToMergeP90Ms ? [`approval→merge p90 ${minutes(approvalToMerge.p90Ms)} exceeds ${minutes(latencyTargets.approvalToMergeP90Ms)}`] : []),
    ...mergeDwell.breaches.map(breach => `${breach.work} stayed mergeable for ${minutes(breach.ms)}, past the ${minutes(latencyTargets.mergeableToMergeMs)} bound`),
    ...reworkRequest.breaches.map(breach => `${breach.work} carried a standing verdict for ${minutes(breach.ms)} before rework was requested, past the ${minutes(latencyTargets.verdictToReworkMs)} bound`),
  ];
  const enough = deliveries >= latencyTargets.minimumDeliveries;
  return { target: latencyTargets, deliveries, readyToClaim, readyToFirstPush, approvalToMerge, mergeDwell, reworkRequest,
    met: reasons.length ? false : enough ? true : null,
    reasons: reasons.length ? reasons : enough ? [] : [`${deliveries} deliver${deliveries === 1 ? 'y' : 'ies'} measured; the p90 targets are judged over at least ${latencyTargets.minimumDeliveries}`] };
}

// ---- The loop's own liveness ---------------------------------------------------------------
export type LoopState = 'running' | 'slow' | 'stalled' | 'absent';
export interface LoopLiveness { state: LoopState; lagMs: number | null; stalledAfterMs: number; cycle: number; lock: DaemonState['lock']; detail: string; restart: string; cost: CycleCost | null }

/**
 * What the last measured cycle cost, against the cadence it is judged on. A cycle is the loop's
 * whole clock: while one runs nothing else coordinates, so a cycle longer than the interval is the
 * interval, and a cycle past the two-interval liveness bound is indistinguishable from a stopped
 * loop unless the measurement says otherwise. The bound is compared against the cycle's own work
 * (`workMs`), never against what it spent waiting on children: a cycle that waited eighty seconds
 * on gh is a slow provider, and one that computed for eighty seconds is a slow loop — only the
 * second has a step to shorten, which `slowest` names.
 */
export interface CycleCost {
  cycle: number; at: string; durationMs: number; childWaitMs: number; workMs: number; intervalMs: number; stalledAfterMs: number;
  steps: CycleSteps | null;
  /** The step with the most of its own work, when any step worked at all. */
  slowest: { step: CycleStepName; ms: number; childWaitMs: number } | null;
  /** The step that waited longest on children, when any step waited at all. */
  longestWait: { step: CycleStepName; childWaitMs: number } | null;
  /** Both judged on `workMs`: the loop's own time, net of its child waits. */
  withinInterval: boolean; withinLivenessBound: boolean;
  /** The step breakdown as an operator sentence, longest first, each step's wait beside it. */
  breakdown: string;
}
const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;
export function cycleCost(metrics: CycleMetrics | null | undefined, intervalMs: number): CycleCost | null {
  if (!metrics) return null;
  const steps = metrics.steps ?? null;
  const childWaitMs = metrics.childWaitMs ?? (steps ? Object.values(steps).reduce((total, step) => total + step.childWaitMs, 0) : 0);
  const workMs = metrics.workMs ?? Math.max(0, metrics.durationMs - childWaitMs);
  const ordered = steps ? (Object.entries(steps) as [CycleStepName, StepCost][]).sort((a, b) => (b[1].ms - b[1].childWaitMs) - (a[1].ms - a[1].childWaitMs)) : [];
  const slowest = ordered.length && ordered[0][1].ms - ordered[0][1].childWaitMs > 0 ? { step: ordered[0][0], ms: ordered[0][1].ms - ordered[0][1].childWaitMs, childWaitMs: ordered[0][1].childWaitMs } : null;
  const waits = ordered.filter(([, cost]) => cost.childWaitMs > 0).sort((a, b) => b[1].childWaitMs - a[1].childWaitMs);
  const longestWait = waits.length ? { step: waits[0][0], childWaitMs: waits[0][1].childWaitMs } : null;
  return { cycle: metrics.cycle, at: metrics.at, durationMs: metrics.durationMs, childWaitMs, workMs, intervalMs, stalledAfterMs: 2 * intervalMs, steps, slowest, longestWait,
    withinInterval: workMs <= intervalMs, withinLivenessBound: workMs <= 2 * intervalMs,
    breakdown: ordered.length
      ? `${seconds(workMs)} of its own work and ${seconds(childWaitMs)} waiting on child processes; ${ordered.map(([step, cost]) => `${step} ${seconds(cost.ms)}${cost.childWaitMs ? ` (${seconds(cost.childWaitMs)} waiting)` : ''}`).join(', ')}`
      : 'no step breakdown was recorded for this cycle' };
}

/**
 * Whether the loop is cycling, from its own cursor. Nothing else in the installation notices a
 * coordinator that stopped: the work simply stops moving. Two intervals without a completed cycle
 * is a stall, and no lock at all — or a lock whose process is gone on this host — is an absence.
 * A measured cycle that itself accounts for the lag is `slow`, not stalled: the loop is inside a
 * long cycle, and the cost says whether that cycle is computing (a step to shorten) or waiting on
 * a child (a provider to look at), so nobody restarts a loop that is still cycling.
 */
export function loopLiveness(state: Pick<DaemonState, 'lock' | 'cycle' | 'lastCycleAt'> & Partial<Pick<DaemonState, 'failures' | 'metrics'>>, now: number, intervalMs: number, hostId?: string): LoopLiveness {
  const cost = cycleCost(state.metrics?.at(-1) ?? null, intervalMs);
  const lastCycleAt = state.lastCycleAt ? Date.parse(state.lastCycleAt) : Number.NaN;
  const lagMs = Number.isFinite(lastCycleAt) ? Math.max(0, now - lastCycleAt) : null;
  // A loop backing off from failed cycles is waiting on purpose, not hung: its bound is two
  // intervals past the retry it announced, so the backoff never reads as a stall to restart.
  const backoff = backingOff(state.failures, now);
  const stalledAfterMs = 2 * intervalMs + (backoff ? Math.max(0, backoff.dueAt - lastCycleAt) : 0);
  const restart = 'graphyard master restart (a supervised deployment restarts it on its own: systemctl --user restart graphyard-master)';
  const lock = state.lock;
  const gone = !!lock && !!hostId && lock.host === hostId && !liveProcess(lock.pid);
  if (!lock || gone) {
    return { state: 'absent', lagMs, stalledAfterMs, cycle: state.cycle, lock, restart, cost,
      detail: gone ? `No master loop is running: the cursor's lock (pid ${lock!.pid} on ${lock!.host}) names a process that is gone, last cycle ${state.lastCycleAt ?? 'never'}. Nothing is dispatching, deciding or merging until it is restarted.`
        : `No master loop holds this repository${state.lastCycleAt ? `; the last cycle was at ${state.lastCycleAt}` : ' and none has ever cycled'}. Nothing is dispatching, deciding or merging until it is started.` };
  }
  if (lagMs === null || lagMs > stalledAfterMs) {
    // The last measured cycle explains the lag while the lag is no longer than that cycle plus the
    // bound: the loop is inside another cycle like it. Past that, nothing explains the silence.
    const slow = cost && lagMs !== null && cost.durationMs > stalledAfterMs && lagMs <= cost.durationMs + stalledAfterMs;
    if (slow) return { state: 'slow', lagMs, stalledAfterMs, cycle: state.cycle, lock, restart, cost,
      detail: `The master loop (pid ${lock.pid} on ${lock.host}) has not completed a cycle for ${Math.round(lagMs / 1000)}s, past the two-interval bound of ${Math.round(stalledAfterMs / 1000)}s, but cycle ${cost.cycle} took ${Math.round(cost.durationMs / 1000)}s of its own: ${cost.breakdown}. The loop is inside a slow cycle, not stalled${cost.withinLivenessBound ? `: its own work fits the bound, and the time went to child processes${cost.longestWait ? ` in the ${cost.longestWait.step} step` : ''}` : cost.slowest ? `; the ${cost.slowest.step} step is the one to shorten` : ''}.` };
    return { state: 'stalled', lagMs, stalledAfterMs, cycle: state.cycle, lock, restart, cost,
      detail: `The master loop (pid ${lock.pid} on ${lock.host}) has not completed a cycle ${lagMs === null ? 'at all' : `for ${Math.round(lagMs / 1000)}s`}, past the two-interval bound of ${Math.round(stalledAfterMs / 1000)}s; cycle ${state.cycle} is stalled.` };
  }
  if (backoff) {
    return { state: 'running', lagMs, stalledAfterMs, cycle: state.cycle, lock, restart, cost,
      detail: `Cycle ${backoff.last.cycle} failed ${Math.round(lagMs / 1000)}s ago in ${describeFailingCall(backoff.last)} (${backoff.last.reason}); ${backoff.consecutive} consecutive failure(s), the next cycle is due at ${backoff.last.nextAt}` };
  }
  return { state: 'running', lagMs, stalledAfterMs, cycle: state.cycle, lock, restart, cost, detail: `Cycle ${state.cycle} completed ${Math.round(lagMs / 1000)}s ago` };
}

// ---- A cycle that fails (GY-119) -----------------------------------------------------------
/** Consecutive failed cycles after which `master status` raises an attention item naming the failing call. */
export const cycleFailureAttentionAfter = 3;
/** The backoff ceiling: the delay before the next cycle doubles from the interval up to five minutes. */
export const cycleFailureCeilingMs = 300_000;
/**
 * How long to wait after a failed cycle. The first failure waits the normal interval — one timed-out
 * read is not a fault — and each consecutive failure doubles it, to the ceiling or the interval
 * itself when that is longer. Under a supervisor with a watchdog the ceiling is halved against the
 * window (`cycleFailureCeiling`), so a loop backing off is never mistaken for one that hung.
 */
export const cycleFailureDelay = (consecutive: number, intervalMs: number, ceilingMs = cycleFailureCeilingMs) =>
  Math.min(intervalMs * 2 ** Math.max(0, consecutive - 1), Math.max(intervalMs, ceilingMs));
export const cycleFailureCeiling = (watchdogWindowMs: number | null) => watchdogWindowMs ? Math.min(cycleFailureCeilingMs, Math.floor(watchdogWindowMs / 2)) : cycleFailureCeilingMs;
export const describeFailingCall = (failure: Pick<NonNullable<CycleFailures['last']>, 'phase' | 'call'>) =>
  failure.phase === 'reload' ? 'the configuration reload' : failure.call ? `the ${failure.call} call` : 'the cycle itself';
/** The failed-cycle wait the loop is in, if any: the last failure with its retry still ahead (allowing one interval of slack). */
function backingOff(failures: CycleFailures | undefined, now: number) {
  const last = failures?.last;
  if (!failures || !last || failures.consecutive === 0) return null;
  const dueAt = Date.parse(last.nextAt);
  return Number.isFinite(dueAt) ? { last, consecutive: failures.consecutive, dueAt } : null;
}

/**
 * Records a rejection that escaped the cycle (or the configuration reload before it) as a failed
 * cycle: the counter advances, the failure and its cause are kept on the cursor, and the delay
 * before the next cycle is chosen from the consecutive count. The loop itself keeps cycling.
 */
export async function noteCycleFailure(state: DaemonState, error: unknown, phase: 'cycle' | 'reload', options: { now: number; intervalMs: number; ceilingMs?: number; persist: DaemonEffects['persist'] }) {
  const call = phase === 'reload' ? 'reload' : failingCall(error);
  const consecutive = state.failures.consecutive + 1;
  const delayMs = cycleFailureDelay(consecutive, options.intervalMs, options.ceilingMs);
  const at = new Date(options.now).toISOString();
  const last = { cycle: state.cycle, at, phase, call, reason: message(error).slice(0, 1000), delayMs, nextAt: new Date(options.now + delayMs).toISOString() };
  state.failures = { ...state.failures, consecutive, total: state.failures.total + 1, last };
  // A run of failures reaching the attention bound is one loop fault instance (GY-173), not one per retry.
  if (consecutive === cycleFailureAttentionAfter) noteFault(state.faults, { ...classified('loop-failures'), subject: 'loop', text: `${consecutive} consecutive failed cycles, the last in ${describeFailingCall(last)}: ${last.reason}` }, at);
  // The cycle ended, failed, and the loop is alive: the counter and the heartbeat both say so.
  state.cycle += 1;
  state.lastCycleAt = at;
  if (state.lock) state.lock = { ...state.lock, heartbeatAt: at };
  try { await options.persist(state); } catch { /* a cursor that cannot be written is the next cycle's failure, not this one's */ }
  return last;
}
/** A completed cycle ends the run of failures; the total stays. */
export function noteCycleSuccess(state: DaemonState) {
  const recovered = state.failures.consecutive;
  if (recovered) state.failures = { ...state.failures, consecutive: 0 };
  return recovered;
}
/** Records an unhandled rejection or uncaught exception the process caught and survived. */
export function noteUnhandled(state: DaemonState, error: unknown, origin: 'unhandledRejection' | 'uncaughtException', now: number) {
  const entry = { at: new Date(now).toISOString(), origin, reason: message(error).slice(0, 1000), cycle: state.cycle };
  state.failures = { ...state.failures, unhandled: state.failures.unhandled + 1, lastUnhandled: entry };
  return entry;
}
const callTag = Symbol.for('graphyard.daemonCall');
const failingCall = (error: unknown) => { const call = (error as { [callTag]?: unknown } | null)?.[callTag]; return typeof call === 'string' ? call : null; };
/**
 * The same effects, with every rejection or throw tagged with the name of the effect it escaped
 * from, so a failed cycle can say which call failed — `snapshot`, `credentials`, `merge` — rather
 * than only what the runtime said about it. The tag is a symbol on the error; nothing else changes.
 */
export function namedEffects(effects: DaemonEffects): DaemonEffects {
  const tag = (error: unknown, name: string) => { if (error && typeof error === 'object' && !(callTag in error)) Object.defineProperty(error, callTag, { value: name, enumerable: false }); return error; };
  return new Proxy(effects, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      return (...args: unknown[]) => {
        let result: unknown;
        try { result = value.apply(target, args); } catch (error) { throw tag(error, property); }
        return result instanceof Promise ? result.catch(error => { throw tag(error, property); }) : result;
      };
    },
  });
}

/**
 * The loop's own attention, ahead of every work item: a coordinator that is not cycling is why
 * nothing else on the list is moving. A breached silence bound or latency budget follows it.
 */
export function loopAttention(report: { liveness: LoopLiveness; silence?: SilenceReport | null; budget?: LatencyBudget | null; failures?: CycleFailures | null; cost?: CycleCost | null }): AttentionItem[] {
  const items: AttentionItem[] = [];
  const cost = report.cost ?? report.liveness.cost;
  // What to do about a long cycle depends on where its time went: a step that computed too long
  // is shortened; one that waited on a child is a provider or a runtime to look at, and since
  // GY-125 that wait blocks nothing else in the process. Neither is a restart.
  const shorten = cost?.withinLivenessBound && cost.longestWait
    ? `graphyard master status shows the last cycle's step breakdown under daemon.cost; the time went to child processes in the ${cost.longestWait.step} step (${Math.round(cost.longestWait.childWaitMs / 1000)}s), so look at what Herdr, gh or git is slow on rather than restarting a loop that is still cycling`
    : cost?.slowest ? `graphyard master status shows the last cycle's step breakdown under daemon.cost; shorten the ${cost.slowest.step} step rather than restarting a loop that is still cycling`
      : 'graphyard master status shows the last cycle under daemon.cost';
  if (report.liveness.state !== 'running') items.push({ subject: 'loop', text: report.liveness.detail, ...agentOwner('master', report.liveness.state === 'slow' ? shorten : report.liveness.restart), ...classified('loop-liveness') });
  // A cycle whose own work does not fit its interval is raised whatever the lag says: the loop
  // looks healthy the instant a long cycle ends, and the cost is the only reading that names
  // what took the time. A cycle that merely waited is reported net: its work fit, and the wait is
  // in the breakdown for anyone reading it.
  if (cost && !cost.withinInterval && report.liveness.state !== 'slow' && report.liveness.state !== 'absent') {
    items.push({ subject: 'loop', text: `Cycle ${cost.cycle} spent ${Math.round(cost.workMs / 1000)}s on its own work, longer than the ${Math.round(cost.intervalMs / 1000)}s interval${cost.withinLivenessBound ? '' : ` and past the two-interval liveness bound of ${Math.round(cost.stalledAfterMs / 1000)}s`} (${Math.round(cost.durationMs / 1000)}s in all, ${Math.round(cost.childWaitMs / 1000)}s of it waiting on child processes): ${cost.breakdown}${cost.slowest ? `. The ${cost.slowest.step} step is the slowest, at ${Math.round(cost.slowest.ms / 1000)}s of work` : ''}`, ...agentOwner('master', shorten), ...classified('loop-cost') });
  }
  // A cycle that keeps failing is retried in-process with backoff; past the bound it names the
  // failing call, because a restart would not clear a read that times out every time.
  const failures = report.failures;
  if (failures?.last && failures.consecutive >= cycleFailureAttentionAfter) items.push({ subject: 'loop',
    text: `The master loop has failed ${failures.consecutive} consecutive cycles, the last (cycle ${failures.last.cycle} at ${failures.last.at}) in ${describeFailingCall(failures.last)}: ${failures.last.reason}. It keeps cycling in-process, waiting ${Math.round(failures.last.delayMs / 1000)}s before the next attempt (due ${failures.last.nextAt}); a restart does not clear this`,
    ...agentOwner('master', `graphyard master status shows daemon.failures with the failing call and its reason; clear what ${describeFailingCall(failures.last)} is refusing on`), ...classified('loop-failures') });
  const silence = report.silence;
  if (silence?.breached && silence.longest) items.push({ subject: silence.longest.work ?? 'loop', text: `Nothing has acted on ${silence.longest.detail} for ${Math.round(silence.longest.idleMs / 60_000)} minutes, past the ${Math.round(silence.budgetMs / 60_000)}-minute bound, while ${silence.actionable} subject(s) were actionable`,
    ...agentOwner('master', `graphyard master status shows the cycle's actions under daemon.actions; ${report.liveness.state === 'running' ? 'clear what is refusing the action' : report.liveness.state === 'slow' ? shorten : report.liveness.restart}`), ...classified('loop-silence') });
  if (report.budget?.met === false) items.push({ subject: 'loop', text: `The unattended delivery budget is not met: ${report.budget.reasons.join('; ')}`,
    ...agentOwner('master', 'graphyard master status shows daemon.budget with every measured passage; clear what is holding the breached step'), ...classified('delivery-budget') });
  return items;
}

/**
 * The supervisor's watchdog, when the loop runs under one. A cycle that hangs leaves the process
 * alive and the pipeline silent, which no `Restart=` setting notices; a keep-alive per cycle turns
 * a stalled cycle into a supervised restart. A window shorter than two intervals would restart a
 * healthy loop instead, so that is refused by name rather than obeyed.
 */
export function watchdogPlan(environment: Record<string, string | undefined>, intervalMs: number) {
  if (!environment.NOTIFY_SOCKET) return { supervised: false, windowMs: null as number | null, refusal: null as string | null };
  const microseconds = Number(environment.WATCHDOG_USEC);
  const windowMs = Number.isFinite(microseconds) && microseconds > 0 ? Math.round(microseconds / 1000) : null;
  const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
  return { supervised: true, windowMs,
    refusal: windowMs !== null && windowMs <= 2 * intervalMs
      ? `The supervisor's watchdog window (${seconds(windowMs)}) is not longer than two cycle intervals (${seconds(2 * intervalMs)}); raise WatchdogSec or shorten run.intervalSeconds, or the supervisor will restart a healthy loop mid-cycle`
      : null };
}

/**
 * How long to wait before the next cycle. A configured interval is the idle cadence, not a bound
 * on how long claimable work may sit: while anything is actionable the loop comes back inside the
 * responsive window, so a long interval cannot push ready work past its dispatch budget.
 */
export const actionableIntervalMs = 30_000;
export const cycleDelay = (intervalMs: number, report: Pick<SilenceReport, 'actionable'> | null) =>
  report && report.actionable > 0 ? Math.min(intervalMs, actionableIntervalMs) : intervalMs;
/** A reviewer or producer session a launch ledger holds as pending, as the failover step reads it. */
export interface LaunchedSession { role: 'reviewer' | 'producer'; record: string; profile: string; agentName: string; pane: string | null; work: string; requestId: string | null }
/** A session only says its account is spent once it has stopped; while it works, its output is its own prose. */
export const stoppedStates = ['idle', 'done', 'blocked'];
export const failoverKey = (role: CapacityRole, work: Work, attempt: string | number) => `failover:${role}:${work.id}:${attempt}`;
export const capacityKey = (role: CapacityRole) => `capacity:${role}`;

export interface DaemonEffects {
  closeSession: (pane: string) => void | Promise<void>;
  dispatch: (work: Work, profile: WorkerProfile, agents: HerdrAgent[], snapshot: { work: Work[]; now: string }) => Promise<unknown>;
  requestProof: (work: Work) => void | Promise<void>;
  /**
   * Asks the control plane to decide the item's open scope request and returns the decided
   * document. The loop carries no verdict of its own: it asks, and Graphyard decides from the
   * item's own criteria. A loop wired without it simply never decides one, and every request
   * waits for the operator exactly as it did before.
   */
  decideScope?: (work: Work) => Promise<Work>;
  /**
   * The review findings standing against the item's head — its unresolved threads and its
   * reviewer's latest change request (review-scope.ts) — read outside every transaction.
   */
  reviewFindings?: (work: Work) => Promise<ReviewFinding[]>;
  /** Which of the paths exist on the base branch, read from one fetch of it per decision. */
  basePaths?: (paths: readonly string[]) => Promise<Set<string>>;
  /**
   * The master's own additive scope widening — the revision `master scope` applies — with its
   * audited reason, bound to the scope request it answers (`answeringWidening`).
   */
  widenScope?: (work: Work, request: ScopeRequestState, paths: string[], reason: string) => Promise<unknown>;
  merge: (work: Work) => Promise<unknown>;
  /**
   * The deployed release and which deliveries it serves. The containment the previous observation
   * retained is handed back so the cycle re-derives only what the release has not already been
   * shown to contain (see `observeDeployment`).
   */
  observeDeployment: (delivered: Work[], retained?: ContainmentRetention | null) => Promise<DeploymentObservation>;
  /** Records the coordinator's own deployment observation on the delivered item. */
  recordDeployment: (work: Work, observation: { sha: string; source: 'endpoint' | 'github-deployment'; observedAt: string }) => Promise<unknown>;
  /**
   * Publishes the production environment this loop verifies deployments under
   * (`config.run.productionEnvironment`, else GRAPHYARD_PRODUCTION_ENVIRONMENT, else `production`)
   * so the dashboard and flow report read releases under that same name; sent only on a change.
   */
  publishProductionEnvironment?: () => Promise<unknown>;
  /** Asks the provider to run the trusted smoke workflow against the observed deployment. */
  requestSmoke: (work: Work) => void | Promise<void>;
  /**
   * Removes the dependency directories of finished assignment worktrees. A loop configured
   * without it keeps cycling; it simply never reclaims. It touches no checkout, no branch, and
   * no Graphyard record, so it needs no credential and is safe to run on every cycle.
   */
  reclaim?: (work: Work[]) => Promise<WorktreeReclaimReport>;
  /**
   * The resource reclaim pass (GY-132): reaps terminal ledger records, closes finished sessions
   * holding profile names, and releases the slots of stuck sessions. Runs every cycle.
   */
  reclaimResources?: (work: Work[], agents: HerdrAgent[] | null) => Promise<ResourceReclaimReport>;
  /** Why the plane cannot record a dispatch's result (its /healthz verdict), or null when it can. */
  planeHealth?: () => Promise<string | null>;
  /**
   * Requests one routine decision with the master's own operator-agent identity and returns it.
   * A loop configured without these three keeps cycling: each routine decision is then recorded as
   * an escalation naming the command a master session runs, exactly as before.
   */
  decide?: (work: Work, action: RoutineDecisionAction, reason: string, input?: Record<string, unknown>) => Promise<{ id: string }>;
  /**
   * Launches the independent approver session for one requested decision, under the name
   * `approverSessionName` gives it, and reports the session so later cycles can supervise it.
   * Never the requester.
   */
  approver?: (work: Work, decision: string) => Promise<{ agentName: string; pane: string | null }>;
  /**
   * One item's decision history: the approved merge decision automatic merging asks for, and what
   * became of every decision this loop requested.
   */
  decisions?: (work: Work) => Promise<{ decisions: { id: string; action: string; state: string; input: any; pin?: { escalations?: { trigger: string; at: string }[] } | null; reason?: string; precedent?: string[]; approvedBy: string | null; outcome?: string | null; refusal?: { approver: string; reason: string } | null }[] }>;
  /**
   * Takes back one of the loop's own requests, as its requester. Only for a request the item has
   * moved past — a merge decision bound to an earlier candidate, a round the item no longer needs —
   * which would otherwise stand forever, refuse the request for the current one, or be adopted
   * for a later round on a reason that describes an older head.
   */
  withdraw?: (work: Work, decision: string, reason: string) => Promise<unknown>;
  /** Verifies on this host which quarantined supervisors are demonstrably gone. */
  containment?: (work: Work[], observed: { now: string; clockOffset: { min: number; max: number } }) => Record<string, ContainmentAssessment> | Promise<Record<string, ContainmentAssessment>>;
  /** Settles one quarantine this host verified dead, so the item can be claimed again. */
  settleContainment?: (work: Work, assessment: ContainmentAssessment) => Promise<unknown>;
  /** Tells the process supervisor the loop is alive, so a hung cycle becomes a restart. */
  notify?: (state: 'ready' | 'alive') => void | Promise<void>;
  /**
   * Mid-session capacity (GY-89). `sessionOutput` reads the tail of a stopped session's own
   * terminal, which is where a runtime says its provider account is spent; `reportCapacity`
   * records what the loop observed on the item. A loop wired without the two never fails a
   * session over and never escalates capacity: it cycles exactly as it did before.
   */
  sessionOutput?: (agent: HerdrAgent) => string | null | Promise<string | null>;
  reportCapacity?: (work: Work, event: Record<string, unknown>) => Promise<Work>;
  /** The reviewer and producer sessions the launch ledgers hold as pending. */
  launchedSessions?: () => Promise<LaunchedSession[]>;
  /** The account the profile's current session was launched on, as its launcher recorded it. */
  selectedAccount?: (role: CapacityRole, profile: string) => Promise<{ environment: string | null; kind: string | null } | null>;
  /**
   * Commits (or cleanly discards) what the interrupted attempt left uncommitted in its worktree.
   * `cause` is the WIP commit's subject after the key and attempt; the provider-quota wording is
   * the default, and the killed-worker step names its own.
   */
  preserveWork?: (work: Work, epoch: number, cause?: string) => Promise<PartialWork>;
  /** Keeps every launcher off the spent account until it resets. */
  holdAccount?: (account: string, observed: Omit<ObservedExhaustion, 'until'>) => Promise<unknown>;
  /** Ends an exhausted reviewer or producer session on its ledger, so its request may launch again. */
  endSession?: (session: LaunchedSession, resolution: string) => Promise<void>;
  /** Launches the session's request again on another account or runtime; throws `accountsExhausted` when none is left. */
  relaunch?: (session: LaunchedSession, work: Work, snapshot: { work: Work[]; now: string }) => Promise<{ profile: string }>;
  /** Account health of the reviewer and producer profiles, as the worker profiles' arrives in `credentials`. */
  roleHealth?: () => Promise<Partial<Record<'reviewer' | 'producer', { profiles: { name: string }[]; health: Record<string, { available: boolean; reason: string | null; accounts?: ProfileAccountHealth[] }> }>>>;
  /** Herdr's agent inventory, read asynchronously: an empty list when Herdr cannot be read. */
  agents: () => HerdrAgent[] | Promise<HerdrAgent[]>;
  /**
   * The same session inventory with whether it could be read at all. A Herdr that cannot be
   * reached reports no sessions, and stopping a supervisor on that would kill live work, so the
   * orphan step acts only on an inventory that says it is available.
   */
  herdr?: () => { agents: HerdrAgent[]; available: boolean } | Promise<{ agents: HerdrAgent[]; available: boolean }>;
  /**
   * Milliseconds this process spent waiting on child processes since the previous call — the
   * runner's ledger (child-runner.ts), drained at each step boundary so every step of the cycle
   * reports its own `childWaitMs`. A loop wired without it reports every step as its own work.
   */
  childWaits?: () => number;
  /** Stops an orphaned watch supervisor through the containment scope it recorded at launch. */
  stopSupervisor?: (orphan: OrphanSupervisor, signal: NodeJS.Signals) => void | Promise<void>;
  /**
   * Records a launched session's durable handle on the item: the runtime, host, Herdr coordinates
   * and transcript a human or an executor attaches to it with. A loop configured without it keeps
   * cycling; the sessions it launches are then only visible in this host's own local ledgers,
   * which is the relaying the handle exists to end.
   */
  recordSession?: (work: Work, handle: SessionHandleInput) => Promise<unknown>;
  credentials: (profiles: WorkerProfile[]) => Promise<Record<string, { available: boolean; reason: string | null; accounts?: ProfileAccountHealth[] }>>;
  /**
   * The coordination read. `jobs` are the control plane's integration jobs with their last error,
   * which is where a paused GitHub client shows (see `githubPause`); a snapshot without them is
   * judged on observation age alone.
   */
  snapshot: () => Promise<{ work: Work[]; now: string; jobs?: { work_id?: string; error?: string | null }[] }>;
  persist: (state: DaemonState) => Promise<void>;
  /**
   * Files the one backlog item a recurring fault class gets (GY-173), as the master's own
   * operator-agent identity, under an idempotency key naming the class and its instances. Absent
   * while no such identity is provisioned: the classes are still recorded and reported.
   */
  fileFaultClass?: (input: ReturnType<typeof faultClassItem>, key: string) => Promise<Work>;
  /** The recurrence rule; the environment's (GRAPHYARD_FAULT_CLASS_*) or the shipped default when absent. */
  faultClassPolicy?: FaultClassPolicy;
  /**
   * The control plane's status, read with the coordinator's visibility, whose status-level problems
   * (App permissions, held jobs, production, a GitHub pause, unserved executors) are classified and
   * tracked each cycle. A read that fails makes the cycle partial: it opens what it saw and ends nothing.
   */
  controlPlane?: () => Promise<ControlPlaneStatus & Record<string, unknown>>;
  /**
   * The attention `master status` adds after `buildMasterStatus` (generated-file drift, context
   * overflows, intervention patterns, executors, terminal decisions, throughput, resources, and the
   * requests, review conflicts, stalls, overlong sessions, owed judgments, setup and dispatcher lines
   * of derivedAttention), read with the control plane's status so the loop tracks every class the report shows.
   * `attribute` is the report's last step over the whole list — a ledger refusal in place of the launch symptoms
   * it causes, a resource at its bound named in place of its symptom — so one cause is tracked as the report shows it, once.
   */
  reportedAttention?: (work: Work[], coordinator: ControlPlaneStatus & Record<string, unknown>, observed: { agents: HerdrAgent[]; approvals: ReturnType<typeof daemonSummary>['approvals']; loop: ReturnType<typeof daemonSummary>['liveness']; now: string }) => Promise<ReportedAttention>;
}

/**
 * Every write of an action goes through here (GY-173): a failed or indeterminate action carries
 * the class of its fault kind, anything else carries none, and the outcome is noted against the
 * fault record — a failure opening one instance per run of failures, a success ending the run.
 */
export function storeAction(state: DaemonState, key: string, action: Omit<DaemonAction, 'faultClass'> & { faultClass?: unknown }, faultKind: FaultKind = daemonActionFaultKind(action.kind)): DaemonAction {
  const { faultClass: _, ...rest } = action;
  const failed = rest.state === 'failed' || rest.state === 'indeterminate';
  const fault = classified(faultKind);
  const entry = daemonActionSchema.parse({ ...rest, detail: boundDetail(rest.detail), ...(failed ? { faultClass: fault.faultClass } : {}) });
  noteActionOutcome(state.faults, key, entry.state, { ...fault, subject: entry.work ?? key, text: entry.detail }, entry.at);
  state.actions[key] = entry;
  return entry;
}

/**
 * Put an action on the cursor. The detail is bounded (in storeAction) before the schema sees it, so a caller
 * that quotes a long error or path list cannot fail every cycle with an over-long string (GY-179).
 */
async function record(state: DaemonState, key: string, action: Omit<DaemonAction, 'at' | 'epoch'> & { at?: string; epoch?: number | null }, now: number, persist: DaemonEffects['persist']) {
  const entry = storeAction(state, key, { epoch: null, ...action, at: action.at ?? new Date(now).toISOString() });
  await persist(state);
  return entry;
}

/** The attention `master status` adds after buildMasterStatus, and its final attribution over the whole list. */
export interface ReportedAttention { items: AttentionItem[]; attribute?: (status: { work: any[]; attentionItems: AttentionItem[] }) => AttentionItem[] }
/** What the cycle already read that faults are derived from, beside the items' own records. */
export interface FaultSources {
  config?: MasterConfig; agents?: HerdrAgent[]; credentials?: Record<string, { available: boolean; reason: string | null }>;
  containment?: Record<string, ContainmentAssessment>;
  /** The control plane's status as the loop read it, and the integration jobs on the coordination read. */
  status?: (ControlPlaneStatus & Record<string, unknown>) | null; jobs?: { work_id?: string; error?: string | null }[];
  /** What `master status` adds after `buildMasterStatus`, as the loop read it this cycle (see DaemonEffects.reportedAttention). */
  reported?: AttentionItem[];
  /** The report's final attribution (ReportedAttention.attribute), run over the derived and reported lines together. */
  attribute?: ReportedAttention['attribute'];
}
/**
 * What this cycle saw standing wrong, classified (GY-173): every open item's own faults
 * (escalations, fences, parks, scope requests, proof gaps, spent accounts, violations, blockers);
 * the attention `master status` derives from the same snapshot, Herdr and containment reads
 * (session liveness, review convergence, base conflicts, overlap holds, merge violations, installation
 * sources); the status-level problems (App permissions, held or failed integration jobs, a GitHub
 * pause, unserved executors, no GitHub connection); and disk below its bound. Each has a stable
 * subject, so a fault that keeps standing is one instance; one that clears and returns is another.
 * The lines go through the report's own attribution first, so a symptom the report names as its
 * cause (a full ledger, a resource at its bound) is tracked as that cause alone. A derived line that
 * restates a fault the item's own record shows (the same kind, or a kind in `restatements`) is that
 * fault, so it is not counted twice; a different fault of the same class on the item is its own
 * instance. Nor is the one-hour dwell line (`gate`) counted, which is the ordinary pace of work — a
 * gate nothing moves is `stalled-item`. Failed actions are not read here: the action history
 * retains failures long after they stopped mattering, so each is noted once, as it happens, by storeAction.
 */
export function cycleFaults(state: DaemonState, work: Work[], now: number, sources: FaultSources = {}): FaultObservation[] {
  const own = work.flatMap(item => workFaults(item, now));
  const derived: FaultObservation[] = [];
  const { config } = sources;
  if (config) {
    let status: { work: any[]; attentionItems: AttentionItem[] } = { work: [], attentionItems: [] };
    try {
      status = buildMasterStatus({ work, now: new Date(now).toISOString() }, config.workers, sources.agents ?? [], sources.credentials ?? {}, sources.containment ?? {}, undefined, config.baseBranch, sources.status ?? undefined);
    } catch (error) {
      derived.push({ ...classified('loop-failures'), subject: 'loop', text: `The loop could not derive this cycle's attention to classify it: ${message(error)}`.slice(0, 500) });
    }
    const listed = { work: status.work, attentionItems: [...status.attentionItems, ...(sources.reported ?? [])] };
    for (const item of classifyAttention(sources.attribute ? sources.attribute(listed) : listed.attentionItems)) if (item.kind !== 'gate') derived.push({ kind: item.kind, faultClass: item.faultClass, subject: item.subject, text: item.text.slice(0, 500) });
    const reclaim = state.reclaim, below = (free: number | null | undefined, bound: number) => free !== null && free !== undefined && free < bound;
    if (reclaim && (below(reclaim.freeBytes, diskThresholdBytes(config)) || below(reclaim.rootFreeBytes, worktreeRootMinFreeBytes(config))))
      derived.push({ ...classified('disk-pressure'), subject: 'disk', text: `Free space below its configured bound at the last reclaim (${reclaim.at})` });
  }
  // The reported attention names each unserved executor kind on the item it holds, and master status already derived its installation
  // lines from the same status: the status's copy of those lines is not a second fault (distinct faults of one kind stay distinct).
  const derivedKinds = new Set(derived.map(fault => `${fault.kind}|${fault.subject}`));
  if (sources.status || sources.jobs?.length) derived.push(...statusFaults({ github: true, ...sources.status, jobs: sources.jobs ?? [] }).filter(fault => !(sources.reported && fault.kind === 'executor') && !derivedKinds.has(`${fault.kind}|${fault.subject}`)));
  const shown = new Set(own.map(fault => `${fault.subject}|${fault.kind}`));
  return [...own, ...derived.filter(fault => ![fault.kind, ...(restatements[fault.kind] ?? [])].some(kind => shown.has(`${fault.subject}|${kind}`)))];
}
/**
 * The derived lines that restate a fault the item's own record holds under another kind: a fence's settle or grace line
 * is the fence, an exhausted reviewer is the item's spent account, a missing session is its lost lease, and a gate with
 * no action named is the blocker holding it. A derived line of the item's own kind always restates it.
 */
export const restatements: Partial<Record<FaultKind, FaultKind[]>> = {
  'containment-settleable': ['containment'], 'containment-grace': ['containment'], 'reviewer-exhausted': ['role-capacity'], 'session': ['escalation:lease-loss'], 'stalled-item': ['blocker', 'sandbox-blocker'],
};
export const faultActionKey = (faultClass: string) => `fault:${faultClass}`;
/**
 * A failing run ends when its action succeeds (noteActionOutcome), and also when the loop no longer
 * keeps the action's row or the row has not been attempted again within the recurrence window: a
 * one-shot failure (a timestamped refusal, a terminal action) never records the success that would
 * end it, and a run left standing would keep its instance past the retention bound for ever. The
 * action failing again after that opens a new instance.
 */
export function endFailingRuns(state: Pick<DaemonState, 'actions' | 'faults'>, policy: FaultClassPolicy, now: number) {
  const from = now - policy.windowHours * 3_600_000;
  for (const action of Object.keys(state.faults.failing)) {
    const row = state.actions[action];
    if (!row || row.state === 'done' || !(Date.parse(row.at) >= from)) delete state.faults.failing[action];
  }
}
/**
 * One structural item per recurring class (AC-2). A class whose unaccounted instances in the window
 * reach the threshold, with no open item naming it, gets one backlog item filed as the master's
 * operator-agent identity, listing the instances; while that item is open, every later instance is
 * linked to it instead of filing another. Nothing is filed below the threshold.
 */
export async function fileRecurringFaultClasses(state: DaemonState, effects: DaemonEffects, work: Work[], clock: number, now: () => number, performed: DaemonAction[]) {
  const policy = effects.faultClassPolicy ?? faultClassPolicyFromEnv(process.env);
  for (const recurrence of recurringClasses(state.faults.instances, work, policy, clock)) {
    if (recurrence.item) { for (const instance of recurrence.unlinked) instance.linkedTo = recurrence.item.key; continue; }
    if (!recurrence.file || !effects.fileFaultClass) continue;
    const key = faultActionKey(recurrence.faultClass), previous = state.actions[key];
    if (previous && previous.state !== 'done' && !readyToRetry(previous, state.cycle)) continue;
    const attempts = previous?.state === 'done' ? 1 : (previous?.attempts ?? 0) + 1;
    // The same instances always file under the same key, so a retry after a lost reply returns the item already filed.
    const idempotency = `fault-class:${recurrence.faultClass}:${createHash('sha256').update(recurrence.recent.map(entry => entry.id).sort().join(',')).digest('hex').slice(0, 32)}`;
    await record(state, key, { kind: 'fault', work: null, principal: null, state: 'started', detail: `Filing one item for the recurring ${recurrence.faultClass} fault class: ${recurrence.count} instances in ${policy.windowHours} hours`, attempts, cycle: state.cycle }, now(), effects.persist);
    try {
      const filed = await effects.fileFaultClass(faultClassItem(recurrence, policy, clock), idempotency);
      for (const instance of recurrence.recent) instance.linkedTo = filed.key;
      work.push(filed);
      performed.push(await record(state, key, { kind: 'fault', work: filed.key, principal: null, state: 'done', detail: `Filed ${filed.key} for the recurring ${recurrence.faultClass} fault class (${recurrence.count} ≥ ${policy.threshold} in ${policy.windowHours} hours), linking ${recurrence.recent.length} instance(s); later instances link to it`, attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file the item for the recurring ${recurrence.faultClass} fault class: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
    }
  }
}
/** The recurrences `master status` reports under daemon.faults: per class, the window's count and the item standing for it. */
export function faultRecurrenceReport(state: Pick<DaemonState, 'faults'>, policy: FaultClassPolicy, now: number) {
  const instances = state.faults.instances;
  const linked = (faultClass: string) => [...new Set(instances.filter(entry => entry.faultClass === faultClass && entry.linkedTo).map(entry => entry.linkedTo!))];
  return { policy, recorded: instances.length, standing: Object.keys(state.faults.open).length,
    classes: faultClasses.flatMap(faultClass => {
      const from = now - policy.windowHours * 3_600_000, inWindow = instances.filter(entry => entry.faultClass === faultClass && Date.parse(entry.at) >= from);
      return inWindow.length ? [{ faultClass, instances: inWindow.length, unlinked: inWindow.filter(entry => !entry.linkedTo).length, items: linked(faultClass), latest: inWindow.at(-1)!.at }] : [];
    }).sort((a, b) => b.instances - a.instances) };
}

/** One preservation per attempt: the record an interrupted attempt leaves for the next one. */
export const preserveKey = (work: Pick<Work, 'id'>, epoch: number) => `preserve:${work.id}:${epoch}`;
/** How long a refusal on the review findings stands before the loop reads the findings again. */
export const findingRecheckMs = 120_000;
/** How long after its claim a launched session is given to appear in Herdr before its absence means anything. */
export const launchAppearanceMs = 120_000;
/**
 * Keep what a worker that died left behind, the same way an exhausted one's is kept (GY-105).
 *
 * A worker killed outright — the agent process OOM-killed, the supervisor's tree stopped, the host
 * rebooted — never reaches `complete`, and its worktree holds whatever it had not committed. Before
 * the item can be dispatched again, that is committed on the attempt's own branch (or the record
 * says it was discarded) and written onto the item through the same capacity record the quota path
 * uses, with the cause it was observed for; the next attempt's request then names the commit,
 * branch and worktree. For an attempt whose lease is still live the record ends it, so the item
 * becomes claimable only once its partial work is on the record. Nothing is preserved for an
 * attempt that submitted — its work is on the pull request — or one the quota path already kept.
 */
async function preserveInterruptedAttempt(state: DaemonState, effects: DaemonEffects, item: Work, epoch: number, profile: WorkerProfile | undefined, observed: string, now: () => number, performed: DaemonAction[]) {
  if (!effects.reportCapacity) return null;
  const key = preserveKey(item, epoch), previous = state.actions[key];
  if (previous?.state === 'done' || (previous && !readyToRetry(previous, state.cycle))) return previous;
  if (item.submission?.epoch === epoch || item.capacity?.exhaustions.some(entry => entry.role === 'worker' && entry.epoch === epoch)) return null;
  const principal = profile?.principal ?? item.lastAssignment?.owner ?? null, attempts = (previous?.attempts ?? 0) + 1;
  await record(state, key, { kind: 'preserve', work: item.key, principal, epoch, state: 'started', detail: `Keeping what attempt ${epoch} of ${item.key} left in its worktree: ${observed}`, attempts, cycle: state.cycle }, now(), effects.persist);
  try {
    const partialWork = await effects.preserveWork?.(item, epoch, 'interrupted before it could submit') ?? { state: 'not-applicable' as const, detail: 'this loop has no access to the attempt worktree' };
    await effects.reportCapacity(item, { event: 'exhausted', cause: 'interrupted', role: 'worker', epoch, profile: profile?.name ?? principal ?? 'unknown', account: null, runtime: profile?.kind ?? null, reason: observed.slice(0, 500), resetsAt: null, partialWork });
    const where = partialWork.commit ? ` at ${partialWork.commit.slice(0, 12)}${partialWork.branch ? ` on ${partialWork.branch}` : ''}${partialWork.path ? ` (${partialWork.path})` : ''}` : '';
    return performed[performed.push(await record(state, key, { kind: 'preserve', work: item.key, principal, epoch, state: 'done', detail: `${item.key} attempt ${epoch} ${observed}. Partial work ${partialWork.state}${where}${partialWork.detail ? `: ${partialWork.detail}` : ''}; the attempt ended on the record and the next attempt's request names the commit`, attempts, cycle: state.cycle }, now(), effects.persist)) - 1];
  } catch (error) {
    return performed[performed.push(await record(state, key, { kind: 'preserve', work: item.key, principal, epoch, state: 'failed', detail: `${item.key} attempt ${epoch} ${observed}, but its partial work could not be put on the record: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist)) - 1];
  }
}

/**
 * One coordination cycle: close finished sessions, reclaim the disk finished assignments hold,
 * dispatch claimable work to a healthy profile, shepherd reviews and proofs, invoke only the
 * guarded merge, verify the deployed SHA, and measure the stages. The cursor is persisted before and after every external action, so a kill between
 * them leaves an entry the next start reconciles against Graphyard instead of repeating.
 */
export async function runCycle(config: MasterConfig, state: DaemonState, effects: DaemonEffects, now: () => number = Date.now) {
  const startedAt = now();
  const snapshot = await effects.snapshot();
  const readAt = now();
  const observedAt = Date.parse(snapshot.now), clock = Number.isFinite(observedAt) ? observedAt : startedAt;
  // The same bound `master status` uses, from the read that produced this snapshot: containment
  // settlement may only be proposed while the local clock can be compared with the control plane.
  const clockOffset = { min: Math.round(startedAt - clock), max: Math.round(readAt - clock) };
  const performed: DaemonAction[] = [];
  const resumed = reconcilePendingActions(state, snapshot.work, clock);
  if (resumed.length) { performed.push(...resumed); await effects.persist(state); }
  // Where this cycle's time goes. Each `spent` closes the step that just ran with its wall time
  // and, of that, the time at least one child process was in flight (the runner's ledger, drained
  // at the boundary), so the cycle can say which step outgrew the interval and whether that step
  // was computing or waiting on Herdr, gh or git.
  const steps = emptyCycleSteps();
  let stepStartedAt = startedAt;
  const spent = (step: CycleStepName) => {
    const at = now(), ms = Math.max(0, at - stepStartedAt);
    steps[step].ms += ms; steps[step].childWaitMs += Math.min(ms, Math.max(0, Math.round(effects.childWaits?.() ?? 0)));
    stepStartedAt = at;
  };
  spent('observe');

  const agents = await effects.agents();
  const credentials = await effects.credentials(config.workers);
  const open = snapshot.work.filter(item => item.stage !== 'done');
  const owns = (principal: string) => open.some(item => !!item.lease && item.lease.owner === principal && Date.parse(item.lease.expiresAt) > clock);

  // 1. Close finished worker sessions. Authority stops at the lease, so a launched agent with no
  //    active assignment has nothing left to do and its pane must not linger holding a provider seat.
  for (const profile of config.workers.filter(worker => worker.mode === 'launch')) {
    const agent = agents.find(candidate => candidate.name === profile.agentName);
    if (!agent?.pane_id || owns(profile.principal)) continue;
    if (!['idle', 'done', 'blocked'].includes(agent.agent_status ?? '')) continue;
    const key = closeKey(profile, agent.pane_id);
    if (state.actions[key]?.state === 'done') continue;
    await record(state, key, { kind: 'close', work: null, principal: profile.principal, state: 'started', detail: `Closing ${profile.agentName}: no active Graphyard assignment`, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    try {
      await effects.closeSession(agent.pane_id);
      performed.push(await record(state, key, { kind: 'close', work: null, principal: profile.principal, state: 'done', detail: `Closed finished session ${profile.agentName} (${agent.agent_status ?? 'unknown'}) with no active assignment`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'close', work: null, principal: profile.principal, state: 'failed', detail: `Could not close ${profile.agentName}: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 1a. Mid-session exhaustion. A session that ran out of provider quota does not fail: it stops
  //     on its runtime's limit notice and waits for a person. The loop reads that notice from the
  //     session's own output, keeps what the attempt had not committed, holds the account until
  //     it resets, records the exhaustion — account, notice, reset time, partial work — on the
  //     item, and gets the action onto another account: a worker's lease ends in that same
  //     record, so the dispatch step re-queues the item on the next cycle, and a reviewer or
  //     producer request is launched again at once. Nobody repoints a profile by hand.
  const failedOver = new Set<string>();
  if (effects.sessionOutput && effects.reportCapacity) {
    const stopped = (name: string) => { const agent = agents.find(candidate => candidate.name === name); return agent && stoppedStates.includes(agent.agent_status ?? '') ? agent : null; };
    const notice = async (agent: HerdrAgent) => { try { const output = await effects.sessionOutput!(agent); return output ? detectExhaustion(output, clock) : null; } catch { return null; } };
    const held = async (role: CapacityRole, profile: string, item: Work, signal: { reason: string; resetsAt: string | null }) => {
      const selected = await effects.selectedAccount?.(role, profile) ?? null;
      const account = selected?.environment ?? null;
      await effects.holdAccount?.(account ?? profileAccount(profile), { at: new Date(clock).toISOString(), resetsAt: signal.resetsAt, reason: signal.reason, role, profile, work: item.key });
      return { account, runtime: selected?.kind ?? null };
    };
    for (const profile of config.workers.filter(worker => worker.mode === 'launch')) {
      const agent = stopped(profile.agentName);
      const item = open.find(candidate => !!candidate.lease && candidate.lease.owner === profile.principal && Date.parse(candidate.lease.expiresAt) > clock);
      if (!agent || !item || item.submission?.epoch === item.lease!.epoch) continue;
      const key = failoverKey('worker', item, item.lease!.epoch), previous = state.actions[key];
      if (previous?.state === 'done' || !readyToRetry(previous, state.cycle)) { if (previous) failedOver.add(item.id); continue; }
      const signal = await notice(agent);
      if (!signal) continue;
      failedOver.add(item.id);
      const epoch = item.lease!.epoch, attempts = (previous?.attempts ?? 0) + 1;
      const resets = signal.resetsAt ? `resets ${signal.resetsAt}` : 'reset time unknown';
      await record(state, key, { kind: 'failover', work: item.key, principal: profile.principal, epoch, state: 'started', detail: `${profile.agentName} on ${item.key} (epoch ${epoch}) stopped on its provider's limit notice: ${signal.reason}`, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        const partialWork = await effects.preserveWork?.(item, epoch) ?? { state: 'not-applicable' as const, detail: 'this loop has no access to the attempt worktree' };
        const { account, runtime } = await held('worker', profile.name, item, signal);
        await effects.reportCapacity(item, { event: 'exhausted', role: 'worker', epoch, profile: profile.name, account, runtime: runtime ?? profile.kind ?? null, reason: signal.reason, resetsAt: signal.resetsAt, partialWork });
        // The lease is over on the record; the supervisor is stopped through the containment scope
        // it recorded, which is the path that settles its quarantine, so the item is claimable again.
        const scope = item.containmentQuarantine?.epoch === epoch && item.containmentQuarantine.owner === profile.principal ? item.containmentQuarantine.scope : undefined;
        let stop = 'its supervisor stops on the ended lease';
        try {
          if (scope && effects.stopSupervisor) { await effects.stopSupervisor({ id: item.id, key: item.key, epoch, owner: profile.principal, profile: profile.name, agentName: profile.agentName, scope, leaseExpiresAt: item.lease!.expiresAt }, 'SIGTERM'); stop = `its supervisor (pid ${scope.pid}) was stopped through ${scope.unit}`; }
        } catch (error) { stop = `its supervisor could not be signalled (${message(error)}) and stops on the ended lease`; }
        clearProfileFailure(state, profile);
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: profile.principal, epoch, state: 'done',
          detail: `${item.key} epoch ${epoch} exhausted ${account ?? `${profile.name}'s own account`} mid-session (${signal.reason}; ${resets}). Partial work ${partialWork.state}${partialWork.commit ? ` at ${partialWork.commit.slice(0, 12)}` : ''}; the attempt ended as released, ${stop}, and ${item.key} is re-queued for another account`,
          attempts, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: profile.principal, epoch, state: 'failed', detail: `${item.key} epoch ${epoch} exhausted its account (${signal.reason}) but could not be failed over: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
      }
    }
    for (const session of await effects.launchedSessions?.().catch(() => [] as LaunchedSession[]) ?? []) {
      const agent = stopped(session.agentName), item = open.find(candidate => candidate.key === session.work);
      if (!agent || !item) continue;
      const key = failoverKey(session.role, item, session.record), previous = state.actions[key];
      if (previous?.state === 'done' || !readyToRetry(previous, state.cycle)) continue;
      const signal = await notice(agent);
      if (!signal) continue;
      const attempts = (previous?.attempts ?? 0) + 1, resets = signal.resetsAt ? `resets ${signal.resetsAt}` : 'reset time unknown';
      await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'started', detail: `${session.role} session ${session.agentName} for ${item.key} stopped on its provider's limit notice: ${signal.reason}`, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        const { account, runtime } = await held(session.role, session.profile, item, signal);
        await effects.reportCapacity(item, { event: 'exhausted', role: session.role, ...(session.requestId ? { requestId: session.requestId } : {}), profile: session.profile, account, runtime, reason: signal.reason, resetsAt: signal.resetsAt,
          partialWork: { state: 'not-applicable', detail: `a ${session.role} session edits nothing: it reads the exact head and leaves no work to keep` } });
        await effects.endSession?.(session, `provider quota exhausted on ${account ?? `${session.profile}'s own account`} mid-session (${signal.reason}; ${resets}); launched again on another account`);
        let next = 'its request launches again on the next dispatch tick';
        if (session.requestId && effects.relaunch) {
          try { next = `relaunched on profile ${(await effects.relaunch(session, item, snapshot)).profile}`; }
          catch (error) {
            next = (error as { capacityExhausted?: boolean })?.capacityExhausted ? `no other account is left for the role (${message(error)}), so it waits for capacity`
              : `it could not be launched again at once (${message(error)}), so the dispatcher launches it on its retry schedule`;
          }
        }
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'done',
          detail: `${session.role} session ${session.agentName} for ${item.key} exhausted ${account ?? `${session.profile}'s own account`} mid-session (${signal.reason}; ${resets}); ${next}`, attempts, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'failed', detail: `${session.role} session ${session.agentName} for ${item.key} exhausted its account (${signal.reason}) but could not be failed over: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
      }
    }
  }

  // 1b. A worker session that stops on a prompt while it holds its assignment is waiting on input
  //     no one will give; it is recorded as failed with that reason, once per pane, for the master.
  for (const profile of config.workers.filter(worker => worker.mode === 'launch')) {
    const agent = agents.find(candidate => candidate.name === profile.agentName);
    const item = open.find(candidate => !!candidate.lease && candidate.lease.owner === profile.principal && Date.parse(candidate.lease.expiresAt) > clock);
    if (!agent?.pane_id || !item || agent.agent_status !== 'blocked' || failedOver.has(item.id)) continue;
    const key = `session:blocked:${profile.name}:${agent.pane_id}:${item.epoch}`;
    if (state.actions[key]) continue;
    performed.push(await record(state, key, { kind: 'session', work: item.key, principal: profile.principal, state: 'failed', detail: `Worker session ${profile.agentName} on ${item.key} (epoch ${item.epoch}) is waiting on input (Herdr reports it blocked) instead of deciding on its own; answer or stop it. A session that needs something records a typed request and exits — POST /api/work/${item.key}/request with a type of scope-request, decision, blocker, note or escalation — which names its decider and frees the item, rather than holding the lease at a prompt`, attempts: 1, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
    // The session is blocked, not gone: it still holds its pane, and the one moment somebody
    // needs the attach command is this one. The handle stays running, carrying why it stalled;
    // step 1 records it finished once the agent is actually closed.
    await effects.recordSession?.(item, { id: `${profile.principal}:${item.epoch}`, kind: 'implementation', principal: profile.principal, runtime: profile.kind ?? profile.mode, host: config.hostId,
      ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}),
      ...(agent.pane_id ? { pane: agent.pane_id, attach: `herdr pane attach ${agent.pane_id}${config.herdrWorkspace ? ` --workspace ${config.herdrWorkspace}` : ''}` } : {}),
      subject: `${item.key}: ${item.title}`.slice(0, 300), state: 'running',
      outcome: 'waiting on input instead of recording a typed request; answer or stop it, and the attempt is recorded as failed with that reason' }).catch(() => {});
  }

  // 1c. A lease that keeps advancing while Herdr no longer reports the session renewing it is an
  //     orphaned watch supervisor: the agent is gone, the item stays owned by a worker that cannot
  //     act, nothing lapses, and no replacement can be dispatched. Two observations establish it —
  //     one lease expiry later than the one first seen with the session already gone — and the
  //     supervisor is then stopped through the containment scope it recorded at launch, rather
  //     than left for a master to find with `pgrep` and kill by hand.
  const runtime = await effects.herdr?.();
  if (runtime?.available && effects.stopSupervisor) {
    const orphans = orphanedSupervisors(open, config.workers, runtime.agents, clock);
    for (const id of Object.keys(state.orphans)) if (!orphans.some(orphan => orphan.id === id)) delete state.orphans[id];
    for (const orphan of orphans) {
      const previous = state.orphans[orphan.id];
      const tracked = previous && previous.epoch === orphan.epoch && previous.owner === orphan.owner && previous.pid === orphan.scope.pid ? previous : null;
      if (!tracked) {
        state.orphans[orphan.id] = orphanObservationSchema.parse({ epoch: orphan.epoch, owner: orphan.owner, pid: orphan.scope.pid, unit: orphan.scope.unit, firstSeenAt: new Date(clock).toISOString(), leaseExpiresAt: orphan.leaseExpiresAt });
        await effects.persist(state); continue;
      }
      // A supervisor already stopped is judged against the expiry it was stopped at: a lease that
      // advances past it proves the stop did not take, and the next signal is not negotiable.
      const baseline = Date.parse(tracked.stoppedLeaseExpiresAt ?? tracked.leaseExpiresAt);
      state.orphans[orphan.id] = { ...tracked, leaseExpiresAt: orphan.leaseExpiresAt };
      if (!(Date.parse(orphan.leaseExpiresAt) > baseline)) { await effects.persist(state); continue; }
      const stops = tracked.stops + 1, signal: NodeJS.Signals = stops === 1 ? 'SIGTERM' : 'SIGKILL';
      const key = `incident:orphan-supervisor:${orphan.id}:${orphan.epoch}:${orphan.scope.pid}`;
      const incident = `${orphan.key} epoch ${orphan.epoch} renewed its lease to ${orphan.leaseExpiresAt} while Herdr no longer reports session ${orphan.agentName}: its watch supervisor (pid ${orphan.scope.pid}, containment scope ${orphan.scope.unit}) has outlived the agent`;
      await record(state, key, { kind: 'escalation', work: orphan.key, principal: orphan.owner, epoch: orphan.epoch, state: 'started', detail: `${incident}; stopping it with ${signal} through that scope`, attempts: stops, cycle: state.cycle }, now(), effects.persist);
      // The agent is gone, so its worktree is quiescent: what it left uncommitted is kept and put
      // on the record — which ends the attempt — before the supervisor holding it is stopped.
      const held = open.find(item => item.id === orphan.id);
      if (held) await preserveInterruptedAttempt(state, effects, held, orphan.epoch, config.workers.find(profile => profile.principal === orphan.owner), `ended without submitting: its agent session ${orphan.agentName} is gone from Herdr while its supervisor (pid ${orphan.scope.pid}) still renewed the lease`, now, performed);
      try {
        await effects.stopSupervisor(orphan, signal);
        state.orphans[orphan.id] = { ...state.orphans[orphan.id], stops, stoppedLeaseExpiresAt: orphan.leaseExpiresAt };
        performed.push(await record(state, key, { kind: 'escalation', work: orphan.key, principal: orphan.owner, epoch: orphan.epoch, state: 'done', detail: `${incident}; stopped with ${signal} through that scope, so the lease lapses instead of renewing`, attempts: stops, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'escalation', work: orphan.key, principal: orphan.owner, epoch: orphan.epoch, state: 'failed', detail: `${incident}; it could not be stopped through that scope: ${message(error)}`, attempts: stops, cycle: state.cycle }, now(), effects.persist));
      }
    }
  }

  // 1d. A worker whose supervisor has already exited. When the agent dies under a supervisor that
  //     is still healthy, the supervisor stops, settles its own quarantine and exits — but it
  //     releases nothing, so the lease stays live until it lapses, and the item would then be
  //     dispatched again with the attempt's uncommitted work still sitting in the old worktree.
  //     Herdr no longer reporting the session while no fence stands for a lease that is still
  //     live is that state exactly (a live launch holds its fence until the agent has appeared,
  //     and a stopped agent still in Herdr is 1a's case). The partial work is kept and recorded,
  //     which ends the attempt, so the re-dispatch that follows is told where it is (GY-105).
  //     Two observations establish it, as for an orphaned supervisor: a session Herdr failed to
  //     list once is not a dead worker, and ending a live attempt on one reading would stop it.
  if (runtime?.available) {
    const gone = new Set<string>();
    for (const profile of config.workers.filter(worker => worker.mode === 'launch')) {
      const item = open.find(candidate => !!candidate.lease && candidate.lease.owner === profile.principal && Date.parse(candidate.lease.expiresAt) > clock);
      if (!item || failedOver.has(item.id) || item.containmentQuarantine || runtime.agents.some(agent => agent.name === profile.agentName)) continue;
      const epoch = item.lease!.epoch;
      if (item.submission?.epoch === epoch || item.lastAssignment?.epoch !== epoch || !(clock - Date.parse(item.lastAssignment.claimedAt ?? item.stageEnteredAt) > launchAppearanceMs)) continue;
      gone.add(item.id);
      const seen = state.absences[item.id];
      if (!seen || seen.epoch !== epoch || seen.owner !== profile.principal) { state.absences[item.id] = { epoch, owner: profile.principal, firstSeenAt: new Date(clock).toISOString(), cycle: state.cycle }; await effects.persist(state); continue; }
      if (seen.cycle === state.cycle) continue;
      await preserveInterruptedAttempt(state, effects, item, epoch, profile, `ended without submitting: its agent session ${profile.agentName} is gone from Herdr (first seen gone at ${seen.firstSeenAt}) and its supervisor has exited without releasing the lease`, now, performed);
    }
    for (const id of Object.keys(state.absences)) if (!gone.has(id)) delete state.absences[id];
  }

  // A pane this cycle just closed frees its profile, so health is read after the closures.
  const health = profileHealth(config.workers, credentials, await effects.agents(), state, clock);

  spent('close');

  // 2. Decide the open scope requests. A worker that needs a file its own criteria — or this
  //    repository's documentation rule — already imply must not wait for a master session to run
  //    a command: the control plane recomputes the decision from the item itself, and the loop
  //    asks it to settle every open request on the cycle it first sees one. An implied additive
  //    request is applied to the live item with its audited reason; anything wider is refused and
  //    escalated here with that reason, and the item stays blocked until an operator decides it.
  //    What this pass decides is kept, so the budget below measures what is still waiting rather
  //    than what has just been answered.
  const settled = new Map<string, Work>();
  // 2a. A refused request for files a review finding on the item's own change names. The finding
  //     is the grounds the item's criteria lack: the loop reads it with its own GitHub access and
  //     widens by exactly those files as the master's own additive intent, once per request and
  //     policy revision; anything the findings do not name stays refused and escalated. Findings
  //     change while the request and revision stand — a bot's thread lands after the refusal — so
  //     a refusal on the findings is judged again every findingRecheckMs, never cached for good.
  //     The reads take seconds; the widening names the request it answers, so a claim or lease
  //     end that clears that request meanwhile makes the control plane refuse it, never apply it.
  const widenOnFindings = async (item: Work, request: ScopeRequestState): Promise<boolean> => {
    if (!effects.reviewFindings || !effects.widenScope || request.remove?.length || request.criteria?.length) return false;
    if (!item.lease || item.lease.epoch !== request.epoch || Date.parse(item.lease.expiresAt) <= clock) return false;
    const paths = (request.decision?.paths?.length ? request.decision.paths : request.paths).filter(path => !(item.plannedFiles ?? []).some(planned => pathScopeContains(planned, path)));
    if (!paths.length) return false;
    const key = `${scopeKey(item, request)}:finding:${item.policyRevision}`;
    const previous = state.actions[key];
    if (previous?.state === 'done' && /^Widened /.test(previous.detail)) return true;
    const judged = previous?.state === 'done';
    if (judged ? clock - Date.parse(previous.at) < findingRecheckMs : previous && (previous.state !== 'failed' || !readyToRetry(previous, state.cycle))) return false;
    const attempts = judged ? previous.attempts : (previous?.attempts ?? 0) + 1;
    try {
      const findings = await effects.reviewFindings(item);
      const existing = await effects.basePaths?.(paths) ?? new Set<string>();
      const scoped = findingScope(paths, findings, path => existing.has(path));
      if ('refusal' in scoped) {
        const detail = boundDetail(`Not widened on a review finding: ${scoped.refusal}`);
        const entry = await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done', detail, attempts, cycle: state.cycle }, now(), effects.persist);
        // An unchanged refusal is the same decision read again, not a new action.
        if (judged && previous.detail !== detail) performed.push(entry);
        return false;
      }
      const grounds = scoped.grounds.map(entry => `${entry.path} (${entry.ground})`).join('; ');
      const reason = guardBroadScope({ ...item, plannedFiles: [...new Set([...(item.plannedFiles ?? []), ...paths])] },
        `Additive scope a review finding on ${item.key}'s own change names: ${grounds}. ${request.requestedBy} asked because ${request.reason}`.slice(0, 1900), { allow: false, command: 'the loop', existing: item.plannedFiles });
      await effects.widenScope(item, request, paths, reason);
      performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done', detail: boundDetail(`Widened ${item.key} with ${namePaths(paths)} on the review finding that names ${paths.length === 1 ? 'it' : 'them'}: ${grounds}`), attempts, cycle: state.cycle }, now(), effects.persist));
      return true;
    } catch (error) {
      performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'failed', detail: boundDetail(`Could not widen ${item.key} on a review finding: ${message(error)}`), attempts, cycle: state.cycle }, now(), effects.persist));
      return false;
    }
  };
  for (const item of open) {
    const request = item.scopeRequest;
    // A refusal is reconsidered only when the rules as they stand now would approve it — once per
    // policy revision of the item, backing off on failure — so a standing refusal never churns.
    const redecide = !!request?.decision && redecidableScopeRefusal(item);
    if (request?.decision?.state === 'refused' && !redecide) { await widenOnFindings(item, request); continue; }
    if (!effects.decideScope || !request || (request.decision && !redecide)) continue;
    // A request whose attempt no longer holds the lease is moot: a fresh attempt asks afresh.
    if (!item.lease || item.lease.epoch !== request.epoch || Date.parse(item.lease.expiresAt) <= clock) continue;
    const key = redecide ? `${scopeKey(item, request)}:redecide:${item.policyRevision}` : scopeKey(item, request);
    const previous = state.actions[key];
    if (!readyToRetry(previous, state.cycle)) continue;
    const attempts = (previous?.attempts ?? 0) + 1;
    await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'started',
      detail: `Deciding ${item.key}'s scope request for ${request.paths.length ? namePaths(request.paths) : 'no path'}`, attempts, cycle: state.cycle }, now(), effects.persist);
    try {
      const decided = await effects.decideScope(item);
      const decision = decided.scopeDecision;
      if (!decision) throw new Error('The control plane answered without a decision');
      settled.set(item.id, decided);
      state.scope.push(scopeMeasurementSchema.parse({ work: item.key, epoch: request.epoch, at: decision.at, waitedMs: decision.waitedMs, state: decision.state }));
      const waited = `${Math.round(decision.waitedMs / 1000)}s after ${request.requestedBy} asked`;
      performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done',
        detail: boundDetail(decision.state === 'approved'
          ? `Widened ${item.key} with ${namePaths(request.paths)} ${waited}: ${decision.reason}`
          : `Refused ${item.key}'s scope request for ${request.paths.length ? namePaths(request.paths) : 'no path'} ${waited}: ${decision.reason}`),
        attempts, cycle: state.cycle }, now(), effects.persist));
      if (decision.state === 'refused' && await widenOnFindings(decided, decided.scopeRequest ?? { ...request, decision })) continue;
      if (decision.state === 'refused') {
        const escalationKey = `escalation:scope:${item.id}:${request.at}`;
        performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done',
          detail: `${item.key} is blocked on scope: ${request.requestedBy} asked for ${request.paths.length ? namePaths(request.paths) : 'a requirements change'} because ${boundDetail(request.reason, 400)}, and the loop refused it because ${boundDetail(decision.reason, 500)}. Decide it with graphyard master scope ${item.key} REASON, or graphyard master requirements ${item.key} FILE REASON for anything that is not purely additive`,
          attempts: 1, cycle: state.cycle }, now(), effects.persist));
      }
    } catch (error) {
      performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'failed',
        detail: boundDetail(`Could not decide ${item.key}'s scope request: ${message(error)}`), attempts, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 2b. The promise that decision rests on: workers wait minutes, not a shift. A p90 above the
  //     budget, or any request left undecided past the blocked bound, is escalated with the
  //     numbers — the loop is the only thing that could have answered them.
  const budget = scopeBudget(open.map(item => settled.get(item.id) ?? item), state.scope, clock);
  for (const breach of budget.breaches) {
    const key = `escalation:scope-budget:${breach.id}`;
    if (!detailChanged(state.actions[key], breach.detail)) continue;
    performed.push(await record(state, key, { kind: 'escalation', work: null, principal: null, state: 'failed', detail: breach.detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  }

  spent('decisions');

  // 3. Reclaim the disk the finished assignments are holding, before anything asks for more of
  //    it. Every attempt and every rework checks the repository out again, so without this step
  //    the host fills and the loop starts failing at whatever it happens to write next. The
  //    reclaimer removes dependency directories only: checkouts, branches and Graphyard's
  //    registered workspace records are never touched, so nothing here can lose work.
  //    Scanning the worktree directory is not free, so it keeps to its own interval — except
  //    while the last scan found free space below the configured threshold, when the host needs
  //    every cycle it can get rather than a cadence.
  const reclaimedAt = state.reclaim ? Date.parse(state.reclaim.at) : Number.NaN;
  const below = (free: number | null | undefined, bound: number) => free !== null && free !== undefined && free < bound;
  const pressed = below(state.reclaim?.freeBytes, diskThresholdBytes(config)) || below(state.reclaim?.rootFreeBytes, worktreeRootMinFreeBytes(config));
  if (effects.reclaim && (pressed || !(Number.isFinite(reclaimedAt) && clock - reclaimedAt < reclaimIntervalMs))) {
    try {
      const report = await effects.reclaim(snapshot.work);
      state.reclaim = reclaimSummarySchema.parse({ at: report.at, scanned: report.scanned, removed: report.removed.length, kept: report.kept.length,
        freedBytes: report.freedBytes, freeBytes: report.freeAfter === null ? null : Math.max(0, Math.round(report.freeAfter)), errors: [...report.errors, ...(report.checkouts?.errors ?? [])].map(entry => entry.slice(0, 500)).slice(0, 20),
        checkouts: report.checkouts?.removed.length ?? 0, rootFreeBytes: report.checkouts?.freeBytes == null ? null : Math.max(0, Math.round(report.checkouts.freeBytes)) });
      const orphans = report.checkouts?.removed.length ?? 0, failures = report.errors.length + (report.checkouts?.errors.length ?? 0);
      if (orphans && !report.removed.length && !failures) {
        performed.push(await record(state, `reclaim:${report.at}`, { kind: 'reclaim', work: null, principal: null, state: 'done',
          detail: `Reclaimed ${orphans} ephemeral checkout(s) no live session owned from ${report.checkouts!.root}, ${gigabytes(report.checkouts!.freeBytes)} free there`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
      } else if (report.checkouts?.errors.length && !report.removed.length && !report.errors.length) {
        performed.push(await record(state, `reclaim:${report.at}`, { kind: 'reclaim', work: null, principal: null, state: 'failed',
          detail: `Reclaimed ${orphans} ephemeral checkout(s) from ${report.checkouts.root}; ${report.checkouts.errors.length} could not be removed: ${report.checkouts.errors[0]}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
      } else if (report.removed.length || report.errors.length) {
        performed.push(await record(state, `reclaim:${report.at}`, { kind: 'reclaim', work: null, principal: null, state: report.errors.length ? 'failed' : 'done',
          detail: `Reclaimed ${report.removed.length} dependency director${report.removed.length === 1 ? 'y' : 'ies'} from ${report.scanned} assignment worktree(s), ${gigabytes(report.freedBytes)} recovered, ${gigabytes(report.freeAfter)} free${orphans ? `; ${orphans} ephemeral checkout(s) no live session owned removed from ${report.checkouts!.root}` : ''}${report.errors.length ? `; ${report.errors.length} could not be removed: ${report.errors[0]}` : ''}`,
          attempts: 1, cycle: state.cycle }, now(), effects.persist));
      } else await effects.persist(state);
    } catch (error) {
      performed.push(await record(state, `reclaim:${new Date(clock).toISOString()}`, { kind: 'reclaim', work: null, principal: null, state: 'failed', detail: `Worktree reclamation failed: ${message(error)}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 3a. Reclaim the loop's own bounded resources (GY-132): ledger records, agent names and
  //     session slots, each within the bound docs/master-agent.md documents, recorded when it took any.
  if (effects.reclaimResources) {
    try {
      const inventory = await effects.herdr?.();
      const report = await effects.reclaimResources(snapshot.work, inventory ? (inventory.available ? inventory.agents : null) : agents);
      const detail = describeReclaim(report);
      if (detail) performed.push(await record(state, `reclaim:resources:${report.at}`, { kind: 'reclaim', work: null, principal: null, state: report.errors.length ? 'failed' : 'done', detail, attempts: 1, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, `reclaim:resources:${new Date(clock).toISOString()}`, { kind: 'reclaim', work: null, principal: null, state: 'failed', detail: `Resource reclaim failed: ${message(error)}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 3b. Reclaim the items whose sessions died. A supervised launch fences its worker in a scope
  //     unit; when that session dies the fence outlives it and the item cannot be claimed again
  //     until somebody settles the quarantine. This host is the only one that can verify the
  //     supervisor is gone, so it does: the probe is the same one `master settle-containment`
  //     runs, the control plane re-evaluates every refusal itself, and an unverifiable signal is
  //     recorded as an escalation rather than settled. A live worker's quarantine is never touched.
  const assessments = await effects.containment?.(snapshot.work, { now: snapshot.now, clockOffset }) ?? {};
  for (const item of open.filter(candidate => candidate.containmentQuarantine && containmentPhase(candidate, clock)?.state === 'lapsed')) {
    const epoch = item.containmentQuarantine!.epoch;
    const assessment = assessments[item.id];
    const key = `settle:${item.id}:${epoch}`;
    if (!assessment) continue;
    if (!assessment.settleable) {
      const escalationKey = `escalation:containment:${item.id}:${epoch}`;
      const detail = `${item.key}: containment quarantine from epoch ${epoch} cannot be settled automatically: ${assessment.refusals.join('; ')}`;
      if (detailChanged(state.actions[escalationKey], detail)) performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[escalationKey]?.attempts ?? 0) + 1, epoch, cycle: state.cycle }, now(), effects.persist));
      continue;
    }
    if (!effects.settleContainment) continue;
    const previous = state.actions[key];
    if (previous && (previous.state === 'done' || !readyToRetry(previous, state.cycle))) continue;
    // A supervisor verified gone with the lease lapsed is a worker killed outright — the whole
    // tree stopped, or the host rebooted. Its partial work goes on the record before the fence is
    // lowered, so the item is offered again only once the next attempt can be told where it is.
    await preserveInterruptedAttempt(state, effects, item, epoch, config.workers.find(profile => profile.principal === item.containmentQuarantine!.owner), `ended without submitting: its lease lapsed and its supervisor (pid ${assessment.scope?.pid ?? 'unknown'}) is verified gone on ${assessment.host ?? 'this host'}`, now, performed);
    await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'started', detail: `Settling the verified-dead containment quarantine of ${item.key} epoch ${epoch}`, attempts: (previous?.attempts ?? 0) + 1, epoch, cycle: state.cycle }, now(), effects.persist);
    try {
      await effects.settleContainment(item, assessment);
      performed.push(await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'done', detail: `Settled the containment quarantine of ${item.key} epoch ${epoch}: its supervisor is verified gone on ${assessment.host ?? 'this host'}, so the item can be claimed again`, attempts: state.actions[key].attempts, epoch, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'failed', detail: `Containment settlement refused for ${item.key} epoch ${epoch}: ${message(error)}`, attempts: state.actions[key].attempts, epoch, cycle: state.cycle }, now(), effects.persist));
    }
  }

  spent('close');

  // 4. Dispatch claimable work to a healthy profile. The launcher claims under the worker's own
  //    identity; the daemon never holds a lease. An unhealthy profile is skipped, not waited on.
  //    An item whose planned files overlap a claimed or unmerged item is not claimable (the
  //    loop never overrides that; `master dispatch --allow-overlap` is the operator's call), and
  //    the smallest planned scope within a priority is offered first.
  const claimable = open.filter(item => {
    try { assertDispatchable(item, snapshot.work, snapshot.now); return true; } catch { return false; }
  }).sort(dispatchOrder);

  // 4a. Capacity. A role whose every configured account is spent is not a launch to keep
  //     retrying and not a failure to keep reporting: each item that needs the role records one
  //     capacity escalation naming every account and its reset time, the loop stops launching
  //     that role until the first of them resets, and the cycle says so in one line. Everything
  //     that needs a different role — a review, a proof, a merge, a deployment — runs below
  //     exactly as it would have, and the escalation is withdrawn the cycle an account returns.
  const capacities: RoleCapacity[] = [roleCapacity('worker', config.workers.filter(worker => worker.mode === 'launch'), credentials)];
  if (effects.reportCapacity) {
    const others = await effects.roleHealth?.().catch(() => null) ?? {};
    for (const role of ['reviewer', 'producer'] as const) if (others[role]) capacities.push(roleCapacity(role, others[role]!.profiles, others[role]!.health));
    const needs: Record<CapacityRole, Work[]> = {
      worker: claimable,
      reviewer: open.filter(item => item.autoDispatch?.review?.state === 'requested'),
      producer: open.filter(item => item.autoDispatch?.producers.some(request => request.state === 'requested')),
    };
    for (const capacity of capacities) {
      const key = capacityKey(capacity.role), previous = state.actions[key];
      if (capacity.exhausted) {
        const waiting = needs[capacity.role];
        const signature = capacitySignature(capacity.role, capacity.accounts);
        for (const item of waiting) {
          const standing = standingCapacity(item, capacity.role)[0];
          if (standing && capacitySignature(standing.role, standing.accounts) === signature) continue;
          try { await effects.reportCapacity(item, { event: 'escalated', role: capacity.role, accounts: capacity.accounts }); }
          catch (error) { performed.push(await record(state, `${key}:${item.id}`, { kind: 'capacity', work: item.key, principal: null, state: 'failed', detail: `Could not record the ${capacity.role} capacity escalation on ${item.key}: ${message(error)}`, attempts: (state.actions[`${key}:${item.id}`]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist)); }
        }
        const detail = `${describeCapacity(capacity.role, capacity.accounts)}${waiting.length ? `; waiting: ${waiting.map(item => item.key).join(', ')}` : ''}`;
        if (detailChanged(previous, detail)) performed.push(await record(state, key, { kind: 'capacity', work: null, principal: null, state: 'done', detail, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
        continue;
      }
      const restored = open.filter(item => standingCapacity(item, capacity.role).length);
      for (const item of restored) await effects.reportCapacity(item, { event: 'restored', role: capacity.role, reason: `An account for the ${capacity.role} role reports quota again` }).catch(() => {});
      if (restored.length || previous && !previous.detail.startsWith('Restored')) {
        performed.push(await record(state, key, { kind: 'capacity', work: null, principal: null, state: 'done', detail: `Restored: a ${capacity.role} account reports quota again; ${capacity.role} launches resume${restored.length ? ` for ${restored.map(item => item.key).join(', ')}` : ''}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
      }
    }
  }
  const workersSpent = !!effects.reportCapacity && capacities[0].exhausted;

  // 4b-human. An item parked on a decision only a human may make holds no lease and is not
  //     claimable, so there is nothing to dispatch and nothing to escalate to an agent: the loop
  //     names it once, with how to answer. The answer itself makes the item claimable, and the
  //     dispatch below picks it up on the next cycle — no master session is part of that.
  for (const item of open.filter(parkedOnHuman)) {
    const request = item.humanRequest!, key = `human:${item.id}:${request.id}`;
    if (state.actions[key]) continue;
    performed.push(await record(state, key, { kind: 'human', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done',
      detail: `${item.key} is parked on a human-only decision (${humanDecisionLabel[request.kind]}): ${request.needed} — ${request.reason}. Its attempt ended without a lease and nothing else waits on it; the human answers with ${answerCommand(item.key, request)} and the loop dispatches it again`,
      attempts: 1, cycle: state.cycle }, now(), effects.persist));
  }

  // 4b-owed. An action no executor may claim is a judgment the loop cannot make: `escalate` and
  //     `request-rework` are decided in the step itself (`actionJudgment`), so the executor holds
  //     no handler for either and the row is never claimed, never fails, and never shows up as a
  //     refused launch. The loop names each one once — what is waiting, what decides it, and the
  //     command that answers it — so an item whose only action is a judgment is visible as owing
  //     one from the cycle that computed it, instead of surfacing five minutes later as an idle
  //     queue row nobody was ever coming for. A concern carried beside an action that is running
  //     is named here too: the work is not frozen by it, and it is not lost behind the work. An
  //     item parked on a human-only decision is named by the step above with the exact answer
  //     command, so it is not named twice.
  for (const owed of humanNeededActions(open.filter(item => !parkedOnHuman(item)), new Date(clock))) {
    const key = `owed:${owed.work}:${owed.kind}:${owed.trigger ?? 'refusal'}:${owed.since}`;
    if (state.actions[key]) continue;
    performed.push(await record(state, key, { kind: 'human', work: owed.key, principal: null, state: 'done',
      detail: `${owed.reason} — no executor may run a ${owed.kind}: it waits on ${owed.decision}, since ${owed.since}. ${owed.resolve}`,
      attempts: 1, cycle: state.cycle }, now(), effects.persist));
  }

  // A plane that cannot record what a launch produces is not dispatched into (GY-132): the worker
  // could not claim, and its work would be recorded nowhere. One escalation names the cause.
  const unrecordable = claimable.length && !workersSpent && effects.planeHealth ? await effects.planeHealth() : null;
  if (unrecordable && detailChanged(state.actions['escalation:dispatch:plane'], `Dispatch held: ${unrecordable}`))
    performed.push(await record(state, 'escalation:dispatch:plane', { kind: 'escalation', work: null, principal: null, state: 'done', detail: `Dispatch held: ${unrecordable}`, attempts: (state.actions['escalation:dispatch:plane']?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  const taken = new Set<string>();
  for (const item of workersSpent || unrecordable ? [] : claimable) {
    const key = dispatchKey(item);
    if (state.actions[key] && state.actions[key].state !== 'failed') continue;
    const free = await effects.agents();
    const choice = health.find(entry => entry.healthy && !taken.has(entry.profile.name) && !free.some(agent => agent.name === entry.profile.agentName));
    if (!choice) {
      // Every launch profile working is capacity, not a decision for anyone. Escalate only when no
      // profile could take work even if it were free.
      const launchable = health.filter(entry => entry.profile.mode === 'launch');
      if (!launchable.some(entry => entry.healthy || entry.busy)) {
        const detail = `No worker profile can take ${item.key}: ${launchable.map(entry => `${entry.profile.name} (${entry.reason})`).join('; ') || 'no launch profile is configured'}`;
        const escalationKey = `escalation:dispatch:${item.id}`;
        if (detailChanged(state.actions[escalationKey], detail)) performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[escalationKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      }
      break;
    }
    taken.add(choice.profile.name);
    await record(state, key, { kind: 'dispatch', work: item.key, principal: choice.profile.principal, epoch: item.epoch, state: 'started', detail: `Dispatching ${item.key} to ${choice.profile.name}`, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    try {
      const dispatched = await effects.dispatch(item, choice.profile, free, snapshot) as { pane?: string | null; agentName?: string; principal?: string } | undefined;
      clearProfileFailure(state, choice.profile);
      // The session is now running somewhere. Put the handle where every Graphyard reader looks,
      // so watching this specific agent never means asking this loop to relay its pane id.
      await effects.recordSession?.(item, {
        id: `${choice.profile.principal}:${item.epoch + 1}`, kind: 'implementation', principal: choice.profile.principal, runtime: choice.profile.kind ?? choice.profile.mode, host: config.hostId,
        ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}),
        ...(dispatched?.pane ? { pane: dispatched.pane, attach: `herdr pane attach ${dispatched.pane}${config.herdrWorkspace ? ` --workspace ${config.herdrWorkspace}` : ''}` } : {}),
        subject: `${item.key}: ${item.title}`.slice(0, 300), state: 'running',
      }).catch(() => { /* the dispatch landed; a handle that could not be written is not a failed dispatch */ });
      performed.push(await record(state, key, { kind: 'dispatch', work: item.key, principal: choice.profile.principal, epoch: item.epoch, state: 'done', detail: `Dispatched ${item.key} to ${choice.profile.name}; the worker launcher claimed under ${choice.profile.principal}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      recordProfileFailure(state, choice.profile, message(error), now());
      performed.push(await record(state, key, { kind: 'dispatch', work: item.key, principal: choice.profile.principal, epoch: item.epoch, state: 'failed', detail: `Dispatch of ${item.key} to ${choice.profile.name} failed: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 4b. A base branch that moved under an in-flight candidate. Nobody is asked to do anything
  //     about it: the control plane merges the new base into the candidate's own branch and
  //     decides what the review and each proof carry (see merge-queue.ts). The cycle reports
  //     what that refresh did — or the conflict that stopped it — so a pass that brought six
  //     stalled items forward is an action rather than a "0 actions" line.
  for (const item of open.filter(candidate => candidate.submission && candidate.candidate && !candidate.reworkRequested)) {
    const refresh = item.baseRefresh, pending = pendingBaseRefresh(item);
    // One action per head, base tip and policy revision: opened when the branch moves under the
    // candidate, resolved when the control plane reports what its merge did.
    const target = pending ? { head: item.candidate!.sha, base: pending.baseTip } : refresh ? { head: refresh.from.sha, base: refresh.base } : null;
    if (!target) continue;
    const key = `refresh:${item.id}:${target.head}:${target.base}:${item.policyRevision}`;
    if (pending) {
      if (state.actions[key]) continue;
      performed.push(await record(state, key, { kind: 'refresh', work: item.key, principal: null, state: 'started',
        detail: `${item.key}: base branch moved from ${pending.boundBase.slice(0, 12)} to ${pending.baseTip.slice(0, 12)}; the control plane is bringing ${item.candidate!.sha.slice(0, 12)} onto it. No rework round, no review round and no proof round is requested for the move.`,
        attempts: 1, cycle: state.cycle }, now(), effects.persist));
      continue;
    }
    if (state.actions[key]?.state === 'done' || state.actions[key]?.state === 'failed') continue;
    const carry = refresh!.carry;
    const kept = carry ? [...(carry.approval.carried ? ['the approval'] : []), ...carry.evidence.filter(entry => entry.carried).map(entry => entry.proof)] : [];
    const again = carry ? [...(carry.approval.carried ? [] : ['the approval']), ...carry.evidence.filter(entry => !entry.carried).map(entry => entry.proof)] : [];
    const detail = refresh!.conflict
      ? `${item.key}: ${refresh!.from.sha.slice(0, 12)} cannot be brought onto base branch tip ${refresh!.base.slice(0, 12)} by Graphyard; it returns to the worker with the conflict named: ${refresh!.conflict}`
      : `${item.key}: brought ${refresh!.from.sha.slice(0, 12)} onto base branch tip ${refresh!.base.slice(0, 12)} as ${(refresh!.head ?? '').slice(0, 12)} with no rework round; kept ${kept.join(', ') || 'nothing'}${again.length ? `; required afresh: ${again.join(', ')}` : ''}`;
    performed.push(await record(state, key, { kind: 'refresh', work: item.key, principal: null, state: refresh!.conflict ? 'failed' : 'done', detail,
      attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  }

  spent('dispatch');

  // 4c. The routine decisions. A standing verdict, a base the control plane could not merge in, and
  //     a delivered item still fenced by a dead supervisor each have one correct answer, and each
  //     used to wait for a master session to notice. The loop requests the decision with the
  //     master's own operator-agent identity and launches the independent approver session for it;
  //     it never approves its own request, so the separation the server enforces is unchanged.
  //     Automatic merging turned off is the fourth: the merge itself then waits for that approval.
  //     A request is not the end of it. The approver is a launched session like any other, so every
  //     cycle reads the decision back and looks at its session again (see `approvalStep`): a
  //     finished session is closed, a dead, stalled or hung one is replaced within a bound, a
  //     refused one is left to the master to answer, a decision the server settled some other way
  //     is requested again, and one no session will judge is escalated and left standing on the
  //     silence measure.
  const stamp = new Date(clock).toISOString();
  // One Herdr read serves the step, and is taken again after anything that changes the inventory.
  let inventory: { agents: HerdrAgent[]; available: boolean } | null = null;
  const sessions = async () => inventory ??= await effects.herdr?.() ?? { agents: await effects.agents(), available: true };
  const note = async (key: string, item: Work, kind: DaemonActionKind, outcome: 'done' | 'failed', detail: string) =>
    performed.push(await record(state, key, { kind, work: item.key, principal: null, state: outcome, detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
  /** Close the approver session a watch names, if Herdr still lists it. False only when it could not be closed. */
  const closeApprover = async (item: Work, watch: ApprovalWatch, why: string) => {
    const session = watch.agentName ? (await sessions()).agents.find(agent => agent.name === watch.agentName) : undefined;
    if (!session?.pane_id) return true;
    const key = `close:approver:${watch.decision}:${session.pane_id}`;
    try { await effects.closeSession(session.pane_id); inventory = null; await note(key, item, 'close', 'done', `Closed approver session ${watch.agentName} (${session.agent_status ?? 'unknown'}): ${why}`); return true; }
    catch (error) { inventory = null; watch.closeAttempts += 1; await note(key, item, 'close', 'failed', `Could not close approver session ${watch.agentName}: ${message(error)}`); return false; }
  };
  /** Put a watched decision to an approver session. The launch is counted before it is made. */
  const launch = async (item: Work, watch: ApprovalWatch, adopt: boolean) => {
    const name = approverSessionName(item, watch.decision), seen = await sessions();
    // A session a master started for the same decision (`master approver`) is the approver it has.
    const listed = adopt && seen.available ? seen.agents.find(agent => agent.name === name) : undefined;
    Object.assign(watch, { launches: watch.launches + 1, agentName: name, pane: listed?.pane_id ?? null, launchedAt: stamp });
    await effects.persist(state);
    if (listed) return `adopted approver session ${name}, already judging it`;
    inventory = null;
    const launched = await effects.approver!(item, watch.decision);
    Object.assign(watch, { agentName: launched?.agentName ?? name, pane: launched?.pane ?? null });
    return `launched independent approver session ${watch.agentName} (launch ${watch.launches} of ${maxApproverLaunches})`;
  };
  const escalateUnjudged = async (item: Work, watch: ApprovalWatch, detail: string) => {
    watch.exhaustedAt = stamp;
    await note(`escalation:decision-unjudged:${watch.decision}`, item, 'escalation', 'failed', `${detail}. ${watch.launches} approver session(s) and ${watch.requests} request(s) have not produced a judgement${watch.ended.length ? ` (${watch.ended.join('; ')})` : ''}, so the loop has stopped spending sessions on it: read it with graphyard master decisions ${item.key}, then put it to a fresh approver with graphyard master approver ${item.key} ${watch.decision}, or take the request back and decide what the item needs instead`);
  };
  /** Request the decision (or adopt the one already standing) and put it to an approver. */
  const request = async (item: Work, decision: RoutineDecision, key: string, carried: ApprovalWatch | null) => {
    const verdict = decision.action === 'rework' && !carried ? standingVerdict(item) : null;
    const attempts = (state.actions[key]?.attempts ?? 0) + 1;
    await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'started', detail: `Requesting the ${decision.action} decision for ${item.key}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist);
    try {
      const history = effects.decisions ? (await effects.decisions(item).catch(() => ({ decisions: [] }))).decisions : [];
      const applied = decision.action === 'merge' ? approvedMerge(item, history) : null;
      if (applied) {
        state.approvals[key] = approvalWatchSchema.parse({ work: item.key, action: decision.action, decision: applied.id, requestedAt: stamp, settledAt: stamp });
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `${item.key} already holds an applied merge decision for candidate ${decision.binding.slice(0, 12)}; nothing to request`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
        return;
      }
      // A request whose response was lost is already standing on the item, and the server refuses a
      // second one; adopting it is what keeps a retry from leaving a decision nobody will judge.
      let standing = history.find(entry => entry.action === decision.action && (entry.state === 'requested' || entry.state === 'approved'));
      // Only a merge decision names what it binds. One standing for an earlier candidate can never
      // apply to this one, and it refuses the request that could: the requester takes it back.
      if (standing && decision.action === 'merge' && !(standing.input?.sha === item.candidate?.sha && standing.input?.baseSha === item.candidate?.baseSha && standing.input?.policyRevision === item.policyRevision)) {
        const stale = `merge decision ${standing.id} is ${standing.state} for candidate ${String(standing.input?.sha).slice(0, 12)}, not the current ${decision.binding.slice(0, 12)}`;
        if (standing.state !== 'requested' || !effects.withdraw) throw new Error(`${stale}, and ${effects.withdraw ? 'only a requested decision can be withdrawn' : 'this loop has no way to withdraw it'}: graphyard master decisions ${item.key}`);
        await effects.withdraw(item, standing.id, `The candidate moved to ${decision.binding.slice(0, 12)}; ${stale}, so it can never apply and is withdrawn for a request that names the current candidate`);
        standing = undefined;
      }
      // Nor does the server keep more than one resolve standing, whatever its trigger. One for
      // another escalation (a security-concern a master asked about) is not this decision: adopting
      // it would settle this watch while the lease-loss still stands, and the binding would never
      // ask again. It is left to its own requester, and this one is asked once it settles.
      if (standing && decision.action === 'resolve' && decision.escalation && !resolveCovers(standing, decision.escalation)) {
        throw new Error(`resolve decision ${standing.id} is ${standing.state} for ${String(standing.input?.trigger)}, not the ${decision.escalation.trigger} raised at ${decision.escalation.at}; the control plane holds one resolve at a time, so this one is requested once it settles: graphyard master decisions ${item.key}`);
      }
      // A rework request names the observation it was decided from (GY-144), so its approver sees
      // at once whether the item has moved since; the watch keeps the same pair.
      const observed = decision.action === 'rework' && item.observation ? { at: item.observation.at, sha: item.observation.candidate.sha } : null;
      // The server refuses a request identical to a refused one unless it cites that refusal. The loop
      // reaches this point only on grounds no refused request of its own rested on (a rework binding
      // names its grounds, and a refused binding is never requested again), so it answers the prior
      // refusals of this action on the item by citing them. A refusal an earlier refused request
      // already cited is answered through it, so only the uncited ones are named: however many
      // refusals the item gathers, the citation stays the newest one or few (GY-163).
      const refused = decision.action === 'rework' ? uncitedRefusals(history.map(entry => ({ ...entry, reason: entry.reason ?? '' })), 'rework', decisionInput('rework', item, {}), (a, b) => JSON.stringify(a) === JSON.stringify(b)) : [];
      const reason = decision.action === 'rework' ? reworkDecisionReason(`${observedFrom(item)} `, decision.reason, refused) : fitDecisionReason('', decision.reason, '');
      if (reason === null) {
        // Retrying would be refused every time; the request is not sent, and the master is told once.
        const escalation = `escalation:rework-refusals:${item.key}:${refused.length}`;
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'failed', detail: `Did not request the rework decision for ${item.key}: its ${refused.length} uncited refused rework decisions no longer fit, cited, within the reason bound`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
        if (!state.actions[escalation]) await note(escalation, item, 'escalation', 'failed', `${item.key} has ${refused.length} refused rework decisions that no later refused request cited, and a rework request must cite each by id within the ${decisionReasonMax}-character reason bound; they no longer fit beside its grounds (${decision.reason.slice(0, 300)}), so the loop has stopped requesting it: read them with graphyard master decisions ${item.key}, then request it with graphyard master decide ${item.key} rework --precedent ID[,ID] REASON citing them, or act on the item yourself`);
        return;
      }
      const requested = standing ?? await effects.decide!(item, decision.action, reason, decision.input);
      // A standing request another watch holds is the same decision under a binding that has since
      // changed (a rework's unresolved-thread set moved while it was requested). That watch is
      // retired here, its sessions and counts carried over, so the cleanup below does not withdraw
      // the decision this watch just adopted and close its approver — on every cycle the set moves.
      const [retired, prior] = standing ? Object.entries(state.approvals).find(([other, entry]) => other !== key && entry.decision === requested.id && !entry.settledAt) ?? [] : [];
      if (retired) delete state.approvals[retired];
      const kept = prior ? { launches: prior.launches, agentName: prior.agentName, pane: prior.pane, launchedAt: prior.launchedAt, exhaustedAt: prior.exhaustedAt } : {};
      const watch = state.approvals[key] = approvalWatchSchema.parse({ work: item.key, action: decision.action, decision: requested.id, requestedAt: prior?.requestedAt ?? stamp, ...kept, requests: prior ? prior.requests : (carried?.requests ?? 0) + 1, ended: (prior ?? carried)?.ended ?? [], observation: observed });
      // A verdict measured from when the reviewer landed it to when the loop asked for the round it
      // needs. A base conflict has no verdict behind it, so it is not part of that measurement. It
      // is sampled with the request, before the launch: a request whose first launch throws is
      // supervised from the watch and never comes back through here.
      const verdictAt = verdict ? Date.parse(verdict.at) : Number.NaN;
      if (Number.isFinite(verdictAt)) state.latency.push(latencySampleSchema.parse({ work: item.key, at: stamp, verdictToReworkMs: Math.max(0, Math.round(clock - verdictAt)) }));
      await effects.persist(state);
      // The request alone changes nothing; the approver session is what applies it. A launch that
      // fails leaves the watch behind, so the next cycle sees a decision with no session and
      // launches again, inside the same bound.
      // A retired watch's approver is judging this decision already; supervision relaunches it if it ends.
      const how = prior?.agentName ? `kept approver session ${prior.agentName}, already judging it under the earlier binding` : await launch(item, watch, true);
      performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `${standing ? `Adopted decision ${requested.id} (${decision.action}), already standing on ${item.key},` : `Requested decision ${requested.id} (${decision.action}) for ${item.key}`} and ${how}: ${reason}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'failed', detail: `Could not put the ${decision.action} decision for ${item.key} to an approver: ${message(error)}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
    }
  };
  /** Look again at a decision already requested: its state on the control plane, and its session. */
  const supervise = async (item: Work, decision: RoutineDecision, key: string, watch: ApprovalWatch) => {
    const history = effects.decisions ? await effects.decisions(item).then(result => result.decisions, () => undefined) : undefined;
    const step = approvalStep(watch, history === undefined ? undefined : history.find(entry => entry.id === watch.decision) ?? null, await sessions(), clock);
    if (step.step === 'wait' || (watch.exhaustedAt && step.step === 'exhausted')) return;
    const base = `approver:${watch.decision}`;
    if (step.step === 'settled') {
      await closeApprover(item, watch, 'its decision is applied');
      watch.settledAt = stamp;
      await note(`${base}:settled`, item, 'decision', 'done', step.detail);
      return;
    }
    if (step.step === 'refused') {
      // Settled for the loop: no replacement session and no re-request. The refusal stands in
      // `master status` until the master answers it with a request that cites it, or acts on it.
      await closeApprover(item, watch, 'its decision is refused');
      watch.settledAt = stamp;
      await note(`escalation:decision-refused:${watch.decision}`, item, 'escalation', 'done', `${step.detail}. The loop does not request it again or launch another approver; answer the refusal: read it with graphyard master decisions ${item.key}, then request what the item needs with a reason that cites ${watch.decision} and gives what the refused request lacked, or act on the refusal instead`);
      return;
    }
    // Every other step replaces the session, so the one that ended goes first. While it cannot be
    // closed its name is still taken, and the step is taken again next cycle.
    if (!await closeApprover(item, watch, step.detail) && watch.closeAttempts < maxApproverCloses) return;
    if (watch.ended.at(-1) !== step.detail.slice(0, 300)) watch.ended = [...watch.ended, step.detail.slice(0, 300)].slice(-10);
    if (step.step === 'rerequest') {
      // The server settled it some other way — failed on a precondition, stale, withdrawn — and
      // the item still needs the decision, so it is asked again: a bounded number of times, and on
      // the same widening interval as any refused action. The watch stays until a new request
      // replaces it, so the bound survives a request that is itself refused.
      if (watch.requests >= maxDecisionRequests) { if (!watch.exhaustedAt) await escalateUnjudged(item, watch, step.detail); return; }
      if (state.actions[key]?.state === 'failed' && !readyToRetry(state.actions[key], state.cycle)) return;
      if (!state.actions[`${base}:ended`]) await note(`${base}:ended`, item, 'decision', 'failed', `${step.detail}; ${item.key} still needs it, so it is requested again`);
      await request(item, decision, key, watch);
      return;
    }
    if (step.step === 'exhausted') { await escalateUnjudged(item, watch, step.detail); return; }
    try { await note(`${base}:launch:${watch.launches + 1}`, item, 'decision', 'done', `${step.detail}; ${await launch(item, watch, false)}`); }
    catch (error) { await note(`${base}:launch:${watch.launches}`, item, 'decision', 'failed', `${step.detail}; a replacement approver session could not be launched: ${message(error)}`); }
  };

  const needed = new Set<string>(), unattestable = new Set<string>();
  const pause = githubPause(snapshot.jobs, clock);
  for (const item of snapshot.work) {
    const assessment = assessments[item.id];
    const decision = routineDecision(item, config, clock, assessment);
    if (!decision) {
      // Still called for, only not attestable this cycle: its request is not one the item moved past.
      const called = neededDecision(item, config);
      if (called) unattestable.add(decisionKey(item, called));
      // The item needs the decision and the loop will not attest what it could not verify. Step 3b
      // has already escalated an open item whose fence this host assessed and could not settle.
      const withheld = withheldDecision(item, config, clock, assessment);
      const escalationKey = `escalation:decision-withheld:${item.id}:${item.containmentQuarantine?.epoch ?? item.epoch}`;
      const detail = withheld ? `${withheld.reason}. Stop the supervisor on its registered host and settle the fence there (graphyard master settle-containment ${item.key}), or request the decision yourself on an attestation you verified` : '';
      if (withheld && !(item.stage !== 'done' && assessment) && detailChanged(state.actions[escalationKey], detail)) await note(escalationKey, item, 'escalation', 'done', detail);
      continue;
    }
    const key = decisionKey(item, decision);
    needed.add(key);
    const watch = state.approvals[key];
    // Rework waits for an observation that still describes the item (GY-144). A request already
    // standing is left as it is — neither supervised into a second request nor withdrawn — until
    // GitHub is observed again and the item says whether it still needs the round.
    const wait = decision.action === 'rework' ? reworkObservationWait(item, clock, pause) : null;
    if (wait) {
      const waitKey = `wait:rework:${item.id}`;
      if (detailChanged(state.actions[waitKey], wait)) await note(waitKey, item, 'decision', 'done', wait);
      continue;
    }
    if (watch) { if (!watch.settledAt) await supervise(item, decision, key, watch); continue; }
    const previous = state.actions[key];
    // A `done` entry with no watch is a cursor written before requests were supervised; the
    // request path adopts the decision it left standing and launches an approver for it.
    if (previous?.state === 'failed' && !readyToRetry(previous, state.cycle)) continue;
    if (!effects.decide || !effects.approver) {
      const escalationKey = `escalation:decision:${item.id}:${decision.binding}`;
      const detail = `${item.key} needs a ${decision.action} decision: ${decision.reason} This loop runs without the decision effects, so it cannot request one: graphyard master decide ${item.key} ${decision.action} REASON, then graphyard master approver ${item.key} DECISION`;
      if (detailChanged(state.actions[escalationKey], detail)) performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[escalationKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      continue;
    }
    await request(item, decision, key, null);
  }
  // A watch whose item no longer needs its decision — applied and moved on, or overtaken by a new
  // head — has nothing left to judge. Its session is closed rather than left holding a provider
  // seat, and the watch goes with it; one Herdr cannot be read for stays until it can.
  for (const [key, watch] of Object.entries(state.approvals)) {
    if (needed.has(key)) continue;
    if (!(await sessions()).available) continue;
    const item = snapshot.work.find(candidate => candidate.key === watch.work);
    // A request the item moved past is taken back by the identity that made it, whatever its
    // action: left `requested`, it would be adopted for some later round on a reason that describes
    // an older head. One the item still calls for stays, and is adopted when it can be attested.
    let withdrawn = true;
    // Another current watch holds this decision: the request is not moved past, only re-keyed.
    if (Object.entries(state.approvals).some(([other, entry]) => other !== key && needed.has(other) && entry.decision === watch.decision)) { delete state.approvals[key]; continue; }
    if (item && !watch.settledAt && !unattestable.has(key) && effects.withdraw && effects.decisions) {
      try {
        const standing = (await effects.decisions(item)).decisions.find(entry => entry.id === watch.decision);
        if (standing?.state === 'requested') {
          await effects.withdraw(item, watch.decision, `${watch.work} moved past the ${watch.action} this decision asked for before any approver judged it, so its reason no longer describes the item`);
          await note(`approver:${watch.decision}:withdrawn`, item, 'decision', 'done', `Withdrew ${watch.action} decision ${watch.decision}: ${watch.work} no longer needs it and no approver had judged it`);
        }
      } catch (error) {
        withdrawn = false; watch.closeAttempts += 1;
        await note(`approver:${watch.decision}:withdrawn`, item, 'decision', 'failed', `Could not withdraw ${watch.action} decision ${watch.decision}, which ${watch.work} no longer needs: ${message(error)}`);
      }
    }
    const closed = !item || await closeApprover(item, watch, `${watch.work} no longer needs ${watch.action} decision ${watch.decision}`);
    // A tab that will not close, or a request that cannot be taken back, is left to the operator
    // after a few tries; the session name is this decision's alone, so it can refuse no other launch.
    if ((closed && withdrawn) || watch.closeAttempts >= maxApproverCloses) delete state.approvals[key];
  }

  spent('decisions');

  // 5. Shepherd reviews and proofs for submitted candidates. Graphyard dispatches provider reviews
  //    and trusted producers publish evidence; the daemon records exactly one request per candidate
  //    and escalates what only a human or a producer may resolve.
  for (const item of open.filter(candidate => candidate.submission && candidate.candidate && !candidate.reworkRequested && !standingVerdict(candidate))) {
    const reviewGate = item.gates.find(gate => gate.name === 'review');
    if (reviewGate && !reviewGate.passed) {
      const key = candidateKey('review', item);
      const provider = reviewProviderOf(item.policy);
      const exhausted = provider === 'agent' && !reviewerProfileFor(item) && exhaustedReviewerProfiles(item).length > 0;
      if (exhausted) {
        const escalation = `${item.key}: every configured reviewer profile is exhausted for the current candidate (${exhaustedReviewerProfiles(item).join(', ')}); add reviewer capacity or revise the review policy. Exhaustion is never an approval.`;
        const escalationKey = `escalation:review:${item.id}:${item.candidate!.sha}:${item.policyRevision}`;
        if (state.actions[escalationKey]?.state !== 'done') performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: escalation, attempts: 1, cycle: state.cycle }, now(), effects.persist));
      } else {
        const detail = provider === 'github' ? `${item.key}: an independent GitHub approval of the current commit is required; the coordinator cannot supply it`
          : item.reviewRequest ? `${item.key}: Graphyard dispatched ${provider} review to profile ${item.reviewRequest.profile ?? provider}; waiting for a verdict on ${item.candidate!.sha.slice(0, 12)}`
            : `${item.key}: waiting for Graphyard to dispatch a ${provider} review for ${item.candidate!.sha.slice(0, 12)}`;
        if (detailChanged(state.actions[key], detail)) performed.push(await record(state, key, { kind: 'review', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      }
    }
    const outstanding = missingProofs(item, new Date(clock));
    if (!outstanding.length) continue;
    const manual = outstanding.filter(proof => proof.startsWith('manual:'));
    const automatable = outstanding.filter(proof => !proof.startsWith('manual:'));
    if (manual.length) {
      const key = `escalation:proof:${item.id}:${item.candidate!.sha}:${item.policyRevision}`;
      if (state.actions[key]?.state !== 'done') performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: `${item.key} needs operator-witnessed proof for ${manual.join(', ')}; the coordinator holds no producer credential and cannot submit it`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
    }
    if (!automatable.length) continue;
    const key = candidateKey('proof', item);
    const previous = state.actions[key];
    if (previous && (previous.state === 'done' || previous.attempts >= maxProofAttempts || !readyToRetry(previous, state.cycle))) continue;
    if (!config.run.proofWorkflow) {
      if (previous?.state !== 'failed') performed.push(await record(state, key, { kind: 'proof', work: item.key, principal: null, state: 'failed', detail: `${item.key} needs trusted evidence for ${automatable.join(', ')}; configure master run --proof-workflow so the loop can request it from the trusted producer workflow`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      continue;
    }
    await record(state, key, { kind: 'proof', work: item.key, principal: null, state: 'started', detail: `Requesting ${config.run.proofWorkflow} for ${item.key}`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    try {
      await effects.requestProof(item);
      performed.push(await record(state, key, { kind: 'proof', work: item.key, principal: null, state: 'done', detail: `Requested trusted producer workflow ${config.run.proofWorkflow} for ${item.key} PR #${item.submission!.pr} at ${item.candidate!.sha.slice(0, 12)} (${automatable.join(', ')})`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'proof', work: item.key, principal: null, state: 'failed', detail: `Could not request ${config.run.proofWorkflow} for ${item.key}: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    }
  }

  spent('dispatch');

  // 6. Merge. The only path is the guarded command, which rechecks the exact candidate, every gate,
  //    branch protection and the published queue tip immediately before the provider call.
  //    An item GitHub already merged with no valid execution behind it is not a candidate: the
  //    merge cannot be re-run, so the loop names the violation and the two-party decision that
  //    reconciles it once, instead of asking the guarded merge every cycle.
  for (const item of open.filter(mergedWithoutAuthorization)) {
    const key = `${candidateKey('escalation', item)}:merged`;
    if (state.actions[key]?.state === 'done') continue;
    performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: `${item.key} was merged on GitHub (${item.observation!.mergeSha?.slice(0, 12) ?? 'merge commit unknown'} at ${item.observation!.mergedAt ?? 'an unrecorded time'}) without a valid merge execution: ${unauthorizedMergeViolation}. It stays at the merge stage until a two-party decision reconciles it: graphyard master decide ${item.key} merge REASON, then graphyard master approver ${item.key} DECISION; Graphyard re-checks the record at the merge cutoff and delivers on the approved decision`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
  }
  const mergeCandidates = open.filter(candidate => candidate.stage === 'merge' && !mergedWithoutAuthorization(candidate));
  for (const item of mergeCandidates) {
    const key = candidateKey('merge', item);
    const previous = state.actions[key];
    if (!readyToRetry(previous, state.cycle)) continue;
    // With automatic merging off the guarded merge runs for exactly the candidate an approver
    // agent approved (step 4c requested it). Until that approval is applied, the loop waits on the
    // approver rather than on a person, and says which decision it is waiting for.
    if (!config.autoMerge) {
      const approval = effects.decisions ? approvedMerge(item, (await effects.decisions(item).catch(() => ({ decisions: [] }))).decisions as Parameters<typeof approvedMerge>[1]) : null;
      if (!approval) {
        const waitKey = candidateKey('escalation', item);
        const watch = state.approvals[decisionKey(item, { action: 'merge', binding: item.candidate!.sha })];
        // A loop that can request the decision says so and waits for the approver agent; one
        // without the master's operator-agent identity is genuinely waiting on the master session,
        // and names the two commands that put the same decision to the same approver. The wait
        // names the decision and the session it is with, so it is raised again whenever that
        // changes — a replaced session, or a decision no session judged — not once and never again.
        const detail = watch?.exhaustedAt ? `Automatic merging is disabled and merge decision ${watch.decision} for ${item.key} is still unjudged after ${watch.launches} approver session(s); put it to a fresh one with graphyard master approver ${item.key} ${watch.decision}`
          : watch ? `Automatic merging is disabled; ${item.key} merges as soon as approver session ${watch.agentName ?? '(not launched yet)'} (launch ${watch.launches} of ${maxApproverLaunches}) applies merge decision ${watch.decision}, which this loop requested`
          : effects.decide ? `Automatic merging is disabled; ${item.key} merges once an approver agent applies a merge decision for candidate ${item.candidate!.sha.slice(0, 12)}`
            : `Automatic merging is disabled; ${item.key} awaits explicit operator approval before the guarded merge runs: graphyard master decide ${item.key} merge REASON, then graphyard master approver ${item.key} DECISION`;
        if (detailChanged(state.actions[waitKey], detail)) performed.push(await record(state, waitKey, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[waitKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
        continue;
      }
    }
    await record(state, key, { kind: 'merge', work: item.key, principal: null, state: 'started', detail: `Invoking the guarded merge for ${item.key}`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    try {
      const result = await effects.merge(item);
      performed.push(await record(state, key, { kind: 'merge', work: item.key, principal: null, state: 'done', detail: `Guarded merge accepted for ${item.key}: ${(result as { result?: string })?.result ?? 'merge requested'}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      // A refusal is the gate working, not a daemon fault: record it and keep cycling.
      performed.push(await record(state, key, { kind: 'merge', work: item.key, principal: null, state: 'failed', detail: `Guarded merge refused for ${item.key}: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    }
  }

  spent('merge');

  // 7. Verify what is actually deployed. This is an observation, never a gate: Graphyard already
  //    marked the work Done on an observed merge, and a lagging rollout must stay visible as lag.
  const delivered = snapshot.work.filter(item => item.stage === 'done' && item.delivery)
    .sort((a, b) => Date.parse(a.delivery!.mergedAt) - Date.parse(b.delivery!.mergedAt));
  const deploymentKey = `deployment:${delivered.at(-1)?.delivery?.mergeSha ?? 'none'}`;
  try {
    const observation = await effects.observeDeployment(delivered, state.deployment?.containment ?? null);
    state.deployment = deploymentObservationSchema.parse(observation);
    if (detailChanged(state.actions[deploymentKey], deploymentDetail(state.deployment))) {
      performed.push(await record(state, deploymentKey, { kind: 'deployment', work: null, principal: null, state: observation.source === 'unavailable' ? 'failed' : 'done', detail: deploymentDetail(state.deployment), attempts: (state.actions[deploymentKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
    }
  } catch (error) {
    // A failed observation keeps the containment already established: it is a record of releases
    // that did serve these deliveries, and nothing about this failure makes that untrue.
    state.deployment = { source: 'unavailable', sha: null, at: new Date(now()).toISOString(), reason: message(error), deployed: [], pending: delivered.map(item => item.key), containment: state.deployment?.containment ?? null };
    performed.push(await record(state, deploymentKey, { kind: 'deployment', work: null, principal: null, state: 'failed', detail: `Deployment SHA could not be verified: ${message(error)}`, attempts: (state.actions[deploymentKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  }

  // 7a'. The control plane reads a release as live under the environment named here; a failed
  //      publication is retried next cycle and holds nothing else back.
  if (effects.publishProductionEnvironment) await effects.publishProductionEnvironment().catch(() => undefined);

  // 7b. The second confidence layer. For each delivery whose policy asks for a smoke proof: record
  //     the observation on Graphyard once the release serves its merge, ask the provider to run the
  //     trusted smoke workflow against exactly that commit, and escalate a failed verdict with
  //     rollback guidance. The loop never produces the verdict: the workflow's producer does.
  const observed = state.deployment;
  for (const item of delivered.filter(candidate => deploySmokeRequired(candidate.policy))) {
    const delivery = item.delivery!;
    if (!delivery.deployment) {
      if (observed?.source === 'unavailable' || !observed?.sha || !observed.deployed.includes(item.key)) continue;
      const key = `deployment:record:${item.id}:${observed.sha}`;
      if (state.actions[key] && state.actions[key].state !== 'failed') continue;
      if (!readyToRetry(state.actions[key], state.cycle)) continue;
      const attempts = (state.actions[key]?.attempts ?? 0) + 1;
      await record(state, key, { kind: 'deployment', work: item.key, principal: null, state: 'started', detail: `Recording that ${observed.sha.slice(0, 12)} from ${observed.source} serves ${item.key}`, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        await effects.recordDeployment(item, { sha: observed.sha, source: observed.source as 'endpoint' | 'github-deployment', observedAt: observed.at });
        performed.push(await record(state, key, { kind: 'deployment', work: item.key, principal: null, state: 'done', detail: `Recorded deployment ${observed.sha.slice(0, 12)} (${observed.source}) covering ${item.key} merge ${delivery.mergeSha.slice(0, 12)}; the smoke proof may now be requested`, attempts, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'deployment', work: item.key, principal: null, state: 'failed', detail: `Could not record the deployment for ${item.key}: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
      }
      continue;
    }
    const outcome = deliveryState(item);
    if (outcome === 'delivered-with-failure') {
      const key = `escalation:smoke:${item.id}:${delivery.smoke!.evidenceId}`;
      if (state.actions[key]?.state !== 'done') performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: rollbackGuidance(item, config.baseBranch)!, attempts: 1, cycle: state.cycle }, now(), effects.persist));
      continue;
    }
    if (outcome !== 'awaiting-smoke') continue;
    const key = `smoke:${item.id}:${delivery.deployment.sha}`;
    const previous = state.actions[key];
    if (previous && (previous.state === 'done' || previous.attempts >= maxProofAttempts || !readyToRetry(previous, state.cycle))) continue;
    if (!config.run.smokeWorkflow) {
      if (previous?.state !== 'failed') performed.push(await record(state, key, { kind: 'smoke', work: item.key, principal: null, state: 'failed', detail: `${item.key} is deployed at ${delivery.deployment.sha.slice(0, 12)} and needs its post-deployment smoke proof; configure master init --smoke-workflow so the loop can request it from the trusted producer workflow`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      continue;
    }
    await record(state, key, { kind: 'smoke', work: item.key, principal: null, state: 'started', detail: `Requesting ${config.run.smokeWorkflow} for ${item.key} at ${delivery.deployment.sha.slice(0, 12)}`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    try {
      await effects.requestSmoke(item);
      performed.push(await record(state, key, { kind: 'smoke', work: item.key, principal: null, state: 'done', detail: `Requested trusted smoke workflow ${config.run.smokeWorkflow} for ${item.key} against deployed ${delivery.deployment.sha.slice(0, 12)} (merge ${delivery.mergeSha.slice(0, 12)})`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'smoke', work: item.key, principal: null, state: 'failed', detail: `Could not request ${config.run.smokeWorkflow} for ${item.key}: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 7b. Classify what is wrong and file one item per recurring class (GY-173). It shares the
  //     deployment step's clock: it reads the same snapshot and makes at most one call per class.
  //     A read that fails makes the cycle partial: faults its source would have shown were not
  //     observed, so none standing ends this cycle (and none reopens as a new instance next cycle).
  let partial = false, reported: ReportedAttention | undefined;
  const controlPlane = effects.controlPlane ? await effects.controlPlane().catch(() => { partial = true; return null; }) : null;
  const summary = controlPlane && effects.reportedAttention ? daemonSummary(state, clock, config.run.intervalSeconds * 1000, config.hostId) : null;
  if (summary) reported = await effects.reportedAttention!(snapshot.work, controlPlane!, { agents, approvals: summary.approvals, loop: summary.liveness, now: new Date(clock).toISOString() })
    .catch(error => { partial = true; return { items: [{ subject: 'loop', text: `The loop could not read the attention master status adds to classify it: ${message(error)}`, kind: 'loop-failures' } as AttentionItem] }; });
  endFailingRuns(state, effects.faultClassPolicy ?? faultClassPolicyFromEnv(process.env), clock);
  trackFaults(state.faults, cycleFaults(state, snapshot.work, clock, { config, agents, credentials, containment: assessments, status: controlPlane, jobs: snapshot.jobs, reported: reported?.items, attribute: reported?.attribute }), new Date(clock).toISOString(), partial);
  await fileRecurringFaultClasses(state, effects, snapshot.work, clock, now, performed);

  spent('deployment');

  // 8. Measure. Every cycle records stage p50/p90 whether or not it acted, what it could have
  //    acted on and how long the longest of those has waited, and the passage of every item it
  //    watches: ready→claim, ready→first push, approval→merge and how long a mergeable candidate
  //    stayed mergeable. All of it from the snapshot this cycle acted on, so no figure can
  //    disagree with the state that produced it.
  for (const item of snapshot.work) {
    const sample = observeItemClock(state, item, clock);
    if (sample) state.latency.push(sample);
  }
  const actionable = actionableSubjects(config, snapshot.work, clock, { assessments, approvals: state.approvals });
  const silence = trackSilence(state, actionable, performed, clock);
  const { stages, lead, production, postDeploy, postDeployFailures } = stageMetrics(snapshot.work, clock);
  // The cycle's duration, and of it the time at least one child was in flight: the difference is
  // the loop's own work, which is what the liveness bound is judged on (cycleCost).
  const durationMs = Math.max(0, Math.round(now() - startedAt));
  const childWaitMs = Math.min(durationMs, Object.values(steps).reduce((total, step) => total + step.childWaitMs, 0));
  const metrics = cycleMetricsSchema.parse({ cycle: state.cycle, at: new Date(clock).toISOString(), durationMs, childWaitMs, workMs: durationMs - childWaitMs, steps, open: open.length, actions: performed.length,
    actionable: silence.actionable, idleMs: silence.longestIdleMs, stages, lead, production, postDeploy, postDeployFailures,
    scope: { count: budget.count, p50Ms: budget.p50Ms, p90Ms: budget.p90Ms }, scopeOpenMs: budget.longestOpenMs });
  state.metrics.push(metrics);
  state.cycle += 1;
  state.lastCycleAt = new Date(now()).toISOString();
  if (state.lock) state.lock = { ...state.lock, heartbeatAt: state.lastCycleAt };
  pruneDaemonState(state);
  await effects.persist(state);
  return { actions: performed, metrics, deployment: state.deployment, health, silence, budget: latencyBudget(state.latency), scope: budget };
}

/**
 * Every failure the cycle records passes through here. A command that failed because the host
 * ran out of room keeps its own output and gains the name of the condition, so the action reads
 * as a disk to reclaim rather than as an unexplained command error.
 */
const message = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error), exhausted = diskExhaustionMessage(error);
  // An error already reported as disk exhaustion is not explained twice.
  return exhausted && !text.includes(reclaimAdvice) ? `${text} — ${exhausted}` : text;
};
function deploymentDetail(observation: DeploymentObservation) {
  if (observation.source === 'unavailable') return `Deployment SHA is unverified: ${observation.reason ?? 'no deployment observation is configured or available'}`;
  return `Deployed SHA ${observation.sha?.slice(0, 12) ?? 'unknown'} from ${observation.source}; verified ${observation.deployed.length} delivered item(s), ${observation.pending.length} not yet serving, from ${observation.requests ?? 0} GitHub request(s)${observation.reason ? `; ${observation.reason}` : ''}`;
}

/**
 * How many listing pages of `deploymentPageSize` the observation reads to find the release, and
 * therefore how many GitHub requests one observation may make: per page, the listing and at most
 * one batched read of its release candidates' latest statuses. Records that are not releases (the
 * CI reporting environment, other branches) are never asked about: on 2026-09-24 a single 20-entry
 * page could be filled by reporting records, hiding the release behind them. The statuses are read
 * a page at a time rather than one attempt at a time, so failed and pending production attempts
 * newer than the release production serves cost nothing extra and never stop the read short of it
 * (a per-attempt read bound left deliveries pending behind 20 failed attempts). Nothing below this
 * bound scales with how much has been delivered — containment is derived locally — so the cycle's
 * deployment step costs the same on the first delivery as on the five hundredth. A configured
 * `--deployment-url` costs zero GitHub requests.
 */
export const deploymentPageSize = 100;
export const deploymentListingPages = 5;
export const maxDeploymentRequests = deploymentListingPages * 2;

/**
 * Local ancestry over this checkout's own object store, which is what "does the release contain
 * this merge" actually asks. The base branch is fetched once, lazily: an observation that answers
 * every delivery from the retained containment fetches nothing at all.
 */
function localAncestry(root: string, baseBranch: string, run: ChildRun) {
  let fetched: string | null | undefined;
  const git = (...args: string[]) => run('git', ['-C', root, ...args]);
  const fetchBase = async () => {
    if (fetched !== undefined) return fetched;
    try { await git('fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`); fetched = null; }
    catch (error) { fetched = message(error).split('\n')[0]; }
    return fetched;
  };
  return {
    get fetchFailure() { return fetched || null; },
    /** `true`/`false` when git could answer, `null` when this checkout does not hold both commits. */
    async contains(ancestor: string, descendant: string): Promise<boolean | null> {
      if (ancestor === descendant) return true;
      await fetchBase();
      try { await git('merge-base', '--is-ancestor', ancestor, descendant); return true; }
      // Exit 1 is git's "not an ancestor". Anything else — a commit this checkout does not hold,
      // a broken repository — is unknown, and unknown containment is never read as deployed.
      catch (error: any) { return error?.status === 1 ? false : null; }
    },
  };
}

/**
 * The deployed commit, taken from a configured endpoint that reports it or from the provider's own
 * deployment record. A delivered item counts as deployed when the serving commit is its merge commit
 * or a descendant of it, so later merges do not make earlier ones look undeployed.
 *
 * Containment is derived from git, not from the forge: one fetch of the base branch and
 * `git merge-base --is-ancestor` per delivery whose containment this loop has not already
 * established. What it has established is retained with the release it was verified against, and
 * one ancestry check carries the whole retained set onto a release that descends from it — so a
 * steady cycle derives containment only for deliveries newer than the last observed release, and
 * the GitHub requests stay under `maxDeploymentRequests` however long the delivery history grows.
 * `root` is the managed repository's checkout, which every caller must name: the Graphyard
 * launcher's directory may be a checkout of another repository, or no checkout at all, and
 * ancestry asked there would leave every delivery pending without saying why.
 * A release that does not descend from the retained one (a rollback, an unrelated commit) drops
 * the retention and every delivery is derived again.
 */
/**
 * Whether a GitHub deployment's environment is the configured production environment (the master
 * run's `productionEnvironment`, else GRAPHYARD_PRODUCTION_ENVIRONMENT, else `production`), compared as the provider's whole
 * identity. Railway names the GitHub environment `<project> / <environment>`, and one repository can
 * deploy several Railway projects: `staging-copy / production` is not the managed installation's
 * release, so a Railway installation configures the full name (`graphyard / production`), as the
 * flow analytics' production phase already requires.
 */
export const productionEnvironmentRecord = (environment: unknown, production: string) => environment === production;

/** GitHub's node ids are opaque base64-like tokens; anything else is not sent inside a query. */
const deploymentNodeId = /^[A-Za-z0-9_=-]{1,200}$/;
/**
 * The latest status of each listed deployment, in listing order, in one GraphQL read: the REST API
 * has only a per-deployment status listing. A deployment whose status could not be read has no
 * entry (`undefined`); one with no status yet is `pending`.
 */
async function deploymentStates(repository: string, deployments: any[], run: ChildRun): Promise<{ states: (string | undefined)[]; failure: string | null }> {
  const ids = deployments.map(deployment => typeof deployment?.node_id === 'string' && deploymentNodeId.test(deployment.node_id) ? deployment.node_id : null);
  const readable = ids.filter((id): id is string => id !== null);
  if (!readable.length) return { states: [], failure: 'GitHub listed it without a node id' };
  let nodes: any[];
  try {
    const query = `query { nodes(ids: ${JSON.stringify(readable)}) { ... on Deployment { databaseId latestStatus { state } } } }`;
    const answer = JSON.parse(await run('gh', ['api', 'graphql', '-f', `query=${query}`]));
    nodes = Array.isArray(answer?.data?.nodes) ? answer.data.nodes : [];
  } catch (error) { return { states: [], failure: message(error) }; }
  const byId = new Map(readable.map((id, index) => [id, nodes[index]]));
  return {
    failure: null,
    states: deployments.map((deployment, index) => {
      const node = ids[index] === null ? undefined : byId.get(ids[index]!);
      // A node that answers for another deployment is not this one's status.
      if (!node || (node.databaseId !== undefined && node.databaseId !== deployment.id)) return undefined;
      return typeof node.latestStatus?.state === 'string' ? node.latestStatus.state.toLowerCase() : 'pending';
    }),
  };
}

export async function observeDeployment(config: MasterConfig, delivered: Work[], run: ChildRun, fetcher: typeof fetch = fetch, now = () => Date.now(),
  options: { root: string; retained?: ContainmentRetention | null }): Promise<DeploymentObservation> {
  const at = new Date(now()).toISOString();
  let requests = 0;
  const unavailable = (reason: string): DeploymentObservation => ({ source: 'unavailable', sha: null, at, reason, deployed: [], pending: delivered.map(item => item.key), requests, derived: 0, retained: 0, containment: options.retained ?? null });
  if (!delivered.length) return { source: 'unavailable', sha: null, at, reason: 'No delivered work is awaiting deployment verification', deployed: [], pending: [], requests, derived: 0, retained: 0, containment: options.retained ?? null };
  let sha: string | null = null, source: DeploymentObservation['source'] = 'unavailable';
  if (config.run.deploymentUrl) {
    let payload: any;
    try {
      const response = await fetcher(config.run.deploymentUrl, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return unavailable(`Deployment endpoint answered ${response.status}`);
      payload = await response.json();
    } catch (error) { return unavailable(`Deployment endpoint is unreachable: ${message(error)}`); }
    const value = config.run.deploymentShaField.split('.').reduce((node: any, part) => node?.[part], payload);
    if (typeof value !== 'string' || !/^[0-9a-f]{7,40}$/i.test(value)) return unavailable(`Deployment endpoint did not report a commit at ${config.run.deploymentShaField}`);
    sha = value.toLowerCase(); source = 'endpoint';
  } else {
    // Not filtered by ref: a platform that deploys the base branch (Railway) records each release
    // with its commit SHA as the ref, so `ref=main` saw only the CI reporting environment's records,
    // and on 2026-09-24 GY-159 stayed pending behind a release production had already served. The
    // listing is read page by page, newest first, until a release answers or a bound is reached.
    const releaseAncestry = localAncestry(options.root, config.baseBranch, run);
    let production: string;
    try { production = config.run.productionEnvironment ?? productionEnvironmentFromEnv(); } catch (error) { return unavailable(message(error)); }
    let listed = 0, exhausted = false;
    // Environments named like production under another identity, reported when no release is found
    // so an unconfigured Railway installation is told the name to configure rather than left pending.
    const namesake = new Set<string>();
    for (let page = 1; page <= deploymentListingPages && !sha && !exhausted; page++) {
      let deployments: any[];
      requests++;
      try { deployments = JSON.parse(await run('gh', ['api', `repos/${config.repository}/deployments?per_page=${deploymentPageSize}&page=${page}`])); }
      catch (error) {
        if (page === 1) return unavailable(`No deployment endpoint is configured and GitHub deployments are unavailable: ${message(error)}`);
        return unavailable(`No release was found in the first ${listed} GitHub deployment(s), and page ${page} of the listing could not be read: ${message(error)}`);
      }
      if (!Array.isArray(deployments)) deployments = [];
      listed += deployments.length;
      exhausted = deployments.length < deploymentPageSize;
      const candidates: any[] = [];
      for (const deployment of deployments) {
        // CI proof reporting records deployments too; it is never a release.
        if (deployment?.environment === ciReportingEnvironment) continue;
        // The base branch and its commits are deployed to staging and previews as readily as to
        // production, whether the ref names the branch or the commit; only the production
        // environment's record says what production serves.
        if (!productionEnvironmentRecord(deployment?.environment, production)) {
          if (typeof deployment?.environment === 'string' && deployment.environment.endsWith(` / ${production}`) && namesake.size < 5) namesake.add(deployment.environment);
          continue;
        }
        // A release is the base branch or a commit on it; another branch's deployment is not.
        const ref = typeof deployment?.ref === 'string' ? deployment.ref : null;
        if (ref && ref !== config.baseBranch) {
          if (typeof deployment.sha !== 'string' || ref.toLowerCase() !== deployment.sha.toLowerCase()) continue;
          if (await releaseAncestry.contains(deployment.sha.toLowerCase(), `refs/remotes/origin/${config.baseBranch}`) !== true) continue;
        }
        candidates.push(deployment);
      }
      if (!candidates.length) continue;
      requests++;
      const states = await deploymentStates(config.repository, candidates, run);
      // Newest first: the first success is the release. An attempt whose status cannot be read may
      // be the newest success, so no older release is taken past it: the observation is
      // unavailable, and every delivery stays pending.
      for (const [index, deployment] of candidates.entries()) {
        const state = states.states[index];
        if (state === undefined) return unavailable(`The status of ${production} deployment ${deployment.id} could not be read, so no older release is taken to be the one production serves${states.failure ? `: ${states.failure}` : ''}`);
        if (state === 'success' && typeof deployment.sha === 'string') { sha = deployment.sha.toLowerCase(); source = 'github-deployment'; break; }
      }
    }
    if (!listed) return unavailable('No deployment endpoint is configured and the repository records no GitHub deployment for the managed base branch');
    // What lies past the listing bound is unread — a rollback to an older release included — so no
    // release is asserted, the last one observed neither: the observation is unavailable and says why.
    if (!sha && !exhausted) return unavailable(`None of the newest ${listed} GitHub deployment(s) is a successful ${production} release of the managed base branch, and older ones are past the ${deploymentListingPages}-page read bound, so the release production serves is not known`);
    if (!sha) return unavailable(`No GitHub deployment of the managed base branch to the ${production} environment reports a successful status${namesake.size
      ? `; deployments to ${[...namesake].map(name => `'${name}'`).join(', ')} are not the '${production}' environment — name the one production serves with graphyard master config productionEnvironment='${[...namesake][0]}' (or GRAPHYARD_PRODUCTION_ENVIRONMENT)`
      : ''}`);
  }
  const ancestry = localAncestry(options.root, config.baseBranch, run);
  // The retained set is carried forward whole, on one ancestry check, or dropped whole.
  const retention = options.retained ?? null;
  const carried = retention && (retention.release === sha || await ancestry.contains(retention.release, sha) === true) ? retention : null;
  const deployed: string[] = [], pending: string[] = [];
  const settled: Record<string, string> = {};
  let derived = 0, retainedCount = 0;
  for (const item of delivered) {
    const mergeSha = item.delivery!.mergeSha.toLowerCase();
    const established = carried?.settled[item.key];
    // Already shown to be served by a release this one descends from: nothing to ask git again.
    if (established) { deployed.push(item.key); settled[item.key] = established; retainedCount++; continue; }
    // Everything else is derived this pass, so `derived + retained` is always the delivery count.
    // The release's own merge needs no ancestry; every other delivery asks git once.
    derived++;
    if (mergeSha === sha || await ancestry.contains(mergeSha, sha) === true) { deployed.push(item.key); settled[item.key] = sha; }
    else pending.push(item.key);
  }
  const keep = Object.entries(settled).slice(-retainedContainments);
  // A base branch this checkout could not fetch is said out loud: containment was then derived
  // from whatever objects are here, and a delivery git could not place stays pending, never deployed.
  const stale = ancestry.fetchFailure;
  return deploymentObservationSchema.parse({ source, sha, at, reason: stale ? `Containment was derived without a fresh base branch: ${stale}` : null, deployed: deployed.slice(-200), pending: pending.slice(-200),
    requests, derived, retained: retainedCount, containment: { release: sha, settled: Object.fromEntries(keep) } });
}

/** The compact daemon view `master status` joins onto Graphyard truth. */
export function daemonSummary(state: DaemonState, now: number, intervalMs: number, hostId?: string) {
  const lastCycleAt = state.lastCycleAt ? Date.parse(state.lastCycleAt) : Number.NaN;
  const lagMs = Number.isFinite(lastCycleAt) ? now - lastCycleAt : null;
  const recent = Object.entries(state.actions).map(([key, action]) => ({ key, ...action })).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const liveness = loopLiveness(state, now, intervalMs, hostId);
  return {
    // A loop inside a failed-cycle backoff is running: it announced when its next cycle is due.
    running: !!state.lock && lagMs !== null && (lagMs < Math.max(3 * intervalMs, 120_000) || liveness.state === 'running' || liveness.state === 'slow'),
    // Whether the loop is cycling at all, on the two-interval bound, with the restart command.
    liveness,
    // Failed cycles and the process-level events the loop survived (GY-119).
    failures: state.failures,
    // What it could act on and the longest any of those has waited, and the latency budgets.
    silence: silenceReport(state.silence, now),
    budget: latencyBudget(state.latency),
    lock: state.lock, cycle: state.cycle, lastCycleAt: state.lastCycleAt, lagMs,
    unresolved: recent.filter(action => action.state === 'started' || action.state === 'indeterminate'),
    escalations: recent.filter(action => action.kind === 'escalation').slice(0, 20),
    actions: recent.slice(0, 40),
    metrics: state.metrics.at(-1) ?? null,
    // Where the last cycle's time went, against the interval and the liveness bound it is judged
    // on: its own work, its child waits, and the step behind each, so a long cycle is a step to
    // shorten or a provider to look at, never a loop to restart.
    cost: cycleCost(state.metrics.at(-1) ?? null, intervalMs),
    deployment: state.deployment,
    profiles: state.profiles,
    config: state.config,
    reclaim: state.reclaim,
    // Every decision the loop has put to an approver and not yet seen applied and retired.
    approvals: Object.entries(state.approvals).map(([key, watch]) => ({ key, ...watch })),
    // Fault instances by class in the recurrence window, and the item each recurring class filed (GY-173).
    faults: faultRecurrenceReport(state, faultClassPolicyFromEnv(process.env), now),
  };
}

/**
 * Adopt a reloaded master.json into the running loop, or record why it was refused. A refusal is
 * an escalation naming the stale setting, written once per distinct reason; an adoption names what
 * changed. Either way the loop keeps cycling on the settings it holds.
 */
export async function noteConfigReload(state: DaemonState, reload: ConfigReload, persist: DaemonEffects['persist']) {
  const previous = state.config;
  state.config = { at: reload.at, changed: reload.changed.slice(0, 100), refused: reload.refused?.slice(0, 1000) ?? null };
  const noted: DaemonAction[] = [];
  if (reload.refused && previous?.refused !== state.config.refused) {
    // A refused reload is a configuration fault, whatever kind of action reports it.
    noted.push(storeAction(state, `escalation:config:${reload.at}`, { kind: 'escalation', work: null, principal: null, state: 'failed', detail: state.config.refused!, attempts: 1, epoch: null, cycle: state.cycle, at: reload.at }, 'action:config'));
  }
  if (reload.changed.length) {
    noted.push(storeAction(state, `config:${reload.at}`, { kind: 'config', work: null, principal: null, state: 'done', detail: `Adopted .graphyard/master.json changes without a restart: ${reload.changed.join(', ')}`, attempts: 1, epoch: null, cycle: state.cycle, at: reload.at }));
  }
  if (noted.length || previous?.refused !== state.config.refused) await persist(state);
  return noted;
}

/** A watchdog window too short for the configured interval is recorded once, not obeyed silently. */
export async function noteWatchdog(state: DaemonState, plan: ReturnType<typeof watchdogPlan>, at: string, persist: DaemonEffects['persist']) {
  if (!plan.refusal) return [];
  const key = `escalation:watchdog:${plan.windowMs}`;
  if (state.actions[key]) return [];
  const entry = storeAction(state, key, { kind: 'escalation', work: null, principal: null, state: 'failed', detail: plan.refusal, attempts: 1, epoch: null, cycle: state.cycle, at }, 'action:config');
  await persist(state);
  return [entry];
}

/**
 * Supervised entry point. The process owns no lease and no credential beyond the coordinator token,
 * so a restart is always safe: it reconciles the cursor against Graphyard and keeps cycling.
 *
 * A cycle that throws does not end the process (GY-119). The rejection — a control-plane read that
 * timed out, a runtime call that failed, a reload that could not be parsed — fails that cycle: it is
 * recorded on the cursor with the cycle number and the call it escaped from, logged, and the next
 * cycle runs after a delay that grows with the consecutive count. An unhandled rejection or uncaught
 * exception anywhere in the process is caught here, logged with its origin, counted on the cursor,
 * and survived. Only a stop signal ends the loop; the supervisor's restart is reserved for a process
 * that hangs, which its watchdog detects.
 */
export async function runDaemon(config: MasterConfig, state: DaemonState, raw: DaemonEffects, options: { once?: boolean; intervalMs: number | (() => number); identity: { pid: number; host: string }; signals?: NodeJS.Signals[]; now?: () => number; log?: (line: string) => void;
  /** The process supervisor's environment, for the watchdog keep-alive; defaults to this process's. */
  environment?: Record<string, string | undefined>;
  /** Re-reads .graphyard/master.json before each cycle, so profiles, workspace, run settings and autoMerge apply without a restart. */
  reload?: () => Promise<ConfigReload>;
  /** The process whose unhandled rejections and uncaught exceptions the loop catches; defaults to this one. */
  process?: Pick<NodeJS.Process, 'on' | 'off'> } ) {
  // Progress goes to stderr so stdout stays the machine-readable result the CLI prints.
  const now = options.now ?? Date.now, log = options.log ?? (line => console.error(line));
  const interval = () => typeof options.intervalMs === 'function' ? options.intervalMs() : options.intervalMs;
  const effects = namedEffects(raw), host = options.process ?? process;
  acquireDaemonLock(state, options.identity, now(), interval());
  await effects.persist(state);
  // Under a supervisor that watches for keep-alives, a hung cycle is a restart rather than a
  // silent pipeline; a window that would restart a healthy loop is recorded and left to the
  // supervisor's configuration rather than worked around.
  const watchdog = watchdogPlan(options.environment ?? process.env, interval());
  for (const action of await noteWatchdog(state, watchdog, new Date(now()).toISOString(), effects.persist)) log(`[graphyard-master] ${action.kind} ${action.state}: ${action.detail}`);
  if (watchdog.supervised) { try { await effects.notify?.('ready'); } catch (error) { log(`[graphyard-master] supervisor notification failed: ${message(error)}`); } }
  let stopping = false;
  // A supervisor's SIGTERM must land during the wait, not one whole interval later.
  const waking = new AbortController();
  const stop = () => { stopping = true; waking.abort(); };
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  for (const signal of signals) host.on(signal, stop);
  // A detached promise that rejects — in the dispatcher beside this loop, an approver watch, a
  // Herdr read nobody awaited — would otherwise end the process. It is counted and survived; the
  // cursor write is best-effort, since the handler runs outside any cycle's own persistence.
  const unhandled = (origin: 'unhandledRejection' | 'uncaughtException') => (error: unknown) => {
    const entry = noteUnhandled(state, error, origin, now());
    log(`[graphyard-master] ${origin} caught at the process level during cycle ${entry.cycle} (${state.failures.unhandled} so far); the loop keeps running: ${entry.reason}`);
    effects.persist(state).catch(() => {});
  };
  const onRejection = unhandled('unhandledRejection'), onException = unhandled('uncaughtException');
  host.on('unhandledRejection', onRejection); host.on('uncaughtException', onException);
  const cycles: { cycle: number; actions: number; durationMs: number; childWaitMs: number }[] = [], failed: { cycle: number; call: string | null; reason: string; delayMs: number }[] = [];
  try {
    do {
      let phase: 'reload' | 'cycle' = 'reload', wait: number;
      try {
        if (options.reload) {
          for (const action of await noteConfigReload(state, await options.reload().then(reload => { config = reload.config; return reload; }), effects.persist)) log(`[graphyard-master] ${action.kind} ${action.state}: ${action.detail}`);
        }
        phase = 'cycle';
        const result = await runCycle(config, state, effects, now);
        // The end of a run of failures is written at once, so `master status` stops naming it.
        const recovered = noteCycleSuccess(state);
        if (recovered) await effects.persist(state);
        cycles.push({ cycle: result.metrics.cycle, actions: result.actions.length, durationMs: result.metrics.durationMs, childWaitMs: result.metrics.childWaitMs ?? 0 });
        for (const action of result.actions) log(`[graphyard-master] cycle ${result.metrics.cycle} ${action.kind} ${action.state}: ${action.detail}`);
        // Both halves of every cycle: what it could act on, and what it did about it.
        log(`[graphyard-master] cycle ${result.metrics.cycle} complete in ${result.metrics.durationMs}ms (${result.metrics.childWaitMs ?? 0}ms waiting on child processes); ${result.metrics.open} open, ${result.silence.actionable} actionable, ${result.actions.length} action(s)${result.silence.longest && result.silence.longestIdleMs > 0 ? `, longest wait ${Math.round(result.silence.longestIdleMs / 1000)}s on ${result.silence.longest.detail}` : ''}${recovered ? `; recovered after ${recovered} failed cycle(s)` : ''}`);
        // The configured interval is the idle cadence; while anything is actionable the loop comes
        // back inside the responsive window so ready work cannot sit out a long interval.
        wait = cycleDelay(interval(), result.silence);
      } catch (error) {
        // The cycle failed; the loop did not. The counter advances, the cause is on the cursor, and
        // the next cycle waits longer for each consecutive failure so a fault is not hammered.
        const failure = await noteCycleFailure(state, error, phase, { now: now(), intervalMs: interval(), ceilingMs: cycleFailureCeiling(watchdog.windowMs), persist: effects.persist });
        failed.push({ cycle: failure.cycle, call: failure.call, reason: failure.reason, delayMs: failure.delayMs });
        log(`[graphyard-master] cycle ${failure.cycle} failed in ${describeFailingCall(failure)}: ${failure.reason}; ${state.failures.consecutive} consecutive failure(s), the next cycle runs in ${Math.round(failure.delayMs / 1000)}s at ${failure.nextAt}`);
        wait = failure.delayMs;
      }
      // The keep-alive says the process is alive, which a failed cycle leaves true: the watchdog
      // is for a cycle that hangs, and a thrown one has just proved it did not.
      if (watchdog.supervised) { try { await effects.notify?.('alive'); } catch (error) { log(`[graphyard-master] supervisor notification failed: ${message(error)}`); } }
      if (options.once || stopping) break;
      try { await delay(wait, undefined, { signal: waking.signal }); } catch { /* woken to stop */ }
    } while (!stopping);
  } finally {
    for (const signal of signals) host.off(signal, stop);
    host.off('unhandledRejection', onRejection); host.off('uncaughtException', onException);
    state.lock = null;
    await effects.persist(state).catch(() => {});
  }
  return { cycles, failed, stopped: stopping };
}

/** Effects bound to the real coordinator process; `config` may be a live source the loop reloads. */
export function daemonEffects(root: string, source: MasterConfig | (() => MasterConfig), deps: {
  snapshot: () => Promise<{ work: Work[]; now: string }>;
  mutate: (path: string, data: unknown, requestId?: string) => Promise<any>;
  /**
   * The merge executor this daemon process is: its coordinator principal and an instance minted
   * once per process. Every guarded merge the loop runs presents it, so an execution this process
   * acquired is resumed by this process alone and never by an interactive merge or a second loop.
   */
  executor: MergeExecutor;
  /** The child runner; a test's stub, or the process's own bounded asynchronous runner. */
  run?: ChildRun;
  fetcher?: typeof fetch;
}): DaemonEffects {
  // One runner, one ledger, for everything this loop runs — Herdr, gh, git, systemctl — so the
  // cycle's `childWaitMs` counts the cycle's own children and not the dispatcher's beside it.
  // Every child is awaited on the event loop and bounded by the runner's timeout (GY-125).
  const ledger = new ChildWaitLedger();
  const run = deps.run ?? childRunner({ timeoutMs: 90_000, ledger });
  const current = typeof source === 'function' ? source : () => source;
  const fetcher = deps.fetcher ?? fetch;
  /**
   * One call as the master's own operator-agent identity — the identity that requests decisions.
   * The coordinator credential cannot, and the approver's
   * credential is never read here: an agent that requested a decision may not approve it.
   */
  const asOperatorAgent = async (method: 'GET' | 'POST', path: string, body?: unknown, key: string = randomUUID()) => {
    const config = current();
    if (!config.operatorAgent) throw new Error('No master operator-agent identity is provisioned; run graphyard master autonomy --admin-token-stdin --apply so the loop can request routine decisions');
    const token = await agentToken(root, config, 'operatorAgent');
    const response = await fetcher(`${config.url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status}): ${result?.error ?? JSON.stringify(result)}`);
    return result;
  };
  /**
   * The status read faults are classified from, with the loop's own coordinator credential: the
   * operator-agent read withholds held jobs, integration jobs and production (routes/status.ts),
   * so faults in those catalogued kinds could never recur to the loop and file their class (GY-173).
   * The attention master status adds is read the same way, as `master status` reads it: the
   * intervention report refuses operator-agent callers (routes/interventions.ts).
   */
  const asCoordinator = async (path: string) => {
    const config = current();
    const response = await fetcher(`${config.url}/api/${path}`, { headers: { Authorization: `Bearer ${await readCredentialFile(config.credentialFile)}` }, signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status}): ${result?.error ?? JSON.stringify(result)}`);
    return result;
  };
  const coordinatorStatus = async () => await asCoordinator('status') as ControlPlaneStatus & Record<string, unknown>;
  const decide: DaemonEffects['decide'] = async (work, action, reason, input = {}) => {
    const post = (target: Work) => asOperatorAgent('POST', `work/${target.id}/decide`, { action, input: decisionInput(action, target, input), reason });
    try { return await post(work); }
    catch (error) {
      // A resolve names the item's revision, and a heartbeat between the snapshot and this request
      // moves it. Any other mutation moves it too — the lease-loss settled and another raised — so
      // the item is read again and asked once more only when it still needs this very resolve on
      // the same grounds; otherwise the refusal stands and the next cycle decides afresh. Its
      // approval is pinned by resolvePin, so later heartbeats do not refuse it.
      if (action !== 'resolve' || !/Task revision changed/.test(message(error))) throw error;
      const fresh = (await deps.snapshot()).work.find(entry => entry.id === work.id);
      const before = neededDecision(work, current()), after = fresh ? neededDecision(fresh, current()) : null;
      if (!fresh || !before || !after || after.action !== 'resolve' || after.binding !== before.binding || after.reason !== before.reason) {
        throw new Error(`${message(error)}; ${work.key} ${after?.action === 'resolve' ? `now needs the resolve on other grounds (${after.binding})` : 'no longer needs this resolve'}, so it is not asked again at the new revision`);
      }
      return post(fresh);
    }
  };
  // The approver's runtime and account come from the registry's approver role; naming a kind here
  // would be a runtime read out of code, and the role would decide nothing.
  const approver: DaemonEffects['approver'] = async (work, decision) => { const launched = await launchApprover(root, work, decision, undefined, await listHerdrAgents(run), run); return { agentName: launched.agentName, pane: launched.pane }; };
  // The same route, as the same requester: only the identity that asked may take a request back.
  const withdraw: DaemonEffects['withdraw'] = (work, decision, reason) => asOperatorAgent('POST', `work/${work.id}/decide`, { action: 'withdraw', decision, reason });
  const decisions: DaemonEffects['decisions'] = work => asOperatorAgent('GET', `work/${encodeURIComponent(work.id)}/decisions`);
  let publishedEnvironment: string | null = null;
  return {
    agents: () => listHerdrAgents(run).catch(() => []),
    childWaits: () => ledger.drain(),
    // The tail of the session's own terminal, unwrapped so a notice the pane folded reads as one line.
    sessionOutput: async agent => { const target = agent.name ?? agent.pane_id; return target ? run('herdr', ['agent', 'read', target, '--source', 'recent-unwrapped', '--lines', '60', '--format', 'text']) : null; },
    reportCapacity: (work, event) => deps.mutate(`work/${work.id}/capacity`, event),
    launchedSessions: async () => [
      ...(await readReviewLedger(root)).reviews.filter(entry => entry.state === 'pending' && !entry.launching).map(entry => ({ role: 'reviewer' as const, record: entry.id, profile: entry.profile, agentName: entry.agentName, pane: entry.pane, work: entry.key, requestId: entry.requestId ?? null })),
      ...(await readProducerLedger(root)).producers.filter(entry => entry.state === 'pending').map(entry => ({ role: 'producer' as const, record: entry.id, profile: entry.profile, agentName: entry.agentName, pane: entry.pane, work: entry.key, requestId: entry.requestId })),
    ],
    selectedAccount: async (role, profile) => (await readEnvironmentLog(current())).selected?.[selectionKey(role, profile)] ?? null,
    preserveWork: async (work, epoch, cause = 'interrupted by provider quota exhaustion') => {
      const workspace = work.workspaces.find(entry => entry.epoch === epoch);
      if (!workspace || workspace.host !== current().hostId) return { state: 'not-applicable', detail: workspace ? `the attempt worktree is on ${workspace.host}, not this host; its commits stay on ${workspace.branch}` : 'the attempt registered no workspace' };
      return preservePartialWork(workspace.path, `${work.key} attempt ${epoch} ${cause}`, run);
    },
    holdAccount: (account, observed) => recordObservedExhaustion(current(), account, observed),
    endSession: async (session, resolution) => {
      // A pane that is already gone is closed (GY-137): the record still settles, and says so.
      let paneGone = false;
      try { if (session.pane) await closeHerdrPane(session.pane, run); } catch (error) { if (!paneAlreadyGone(error)) throw error; paneGone = true; }
      const closedAt = new Date().toISOString(), ended = { state: 'failed' as const, resolution: paneGone ? withPaneGone(resolution, session.pane!, 500) : resolution.slice(0, 500), closedAt };
      if (session.role === 'reviewer') await updateReviewLedger(root, ledger => { ledger.reviews = ledger.reviews.map(entry => entry.id === session.record && entry.state === 'pending' ? { ...entry, ...ended } : entry); });
      else { const ledger = await readProducerLedger(root); await saveProducerLedger(root, { ...ledger, producers: ledger.producers.map(entry => entry.id === session.record && entry.state === 'pending' ? { ...entry, ...ended } : entry) }); }
    },
    relaunch: async (session, work, snapshot) => {
      const config = current(), agents = await listHerdrAgents(run);
      const request = session.role === 'reviewer' ? work.autoDispatch?.review : work.autoDispatch?.producers.find(entry => entry.id === session.requestId);
      if (!request || request.id !== session.requestId || request.state !== 'requested') throw new Error(`${work.key} no longer requests this ${session.role} session`);
      // The profile that just ran out goes last: its other accounts are still its own failover.
      const order = <P extends { name: string; agentName: string }>(profiles: P[]) => [...profiles.filter(profile => profile.name !== session.profile), ...profiles.filter(profile => profile.name === session.profile)].filter(profile => !agents.some(agent => agent.name === profile.agentName));
      const skipped: string[] = [];
      // As in the dispatcher: only skips that were all spent quota make this a wait for capacity.
      let capacity = true;
      for (const profile of session.role === 'reviewer' ? order(config.reviewers) : order(independentProducerProfiles(work, config.producers))) {
        try {
          if (session.role === 'reviewer') await launchReview(root, work, profile.name, agents, snapshot.now, { run, requestId: request.id });
          else await launchProducer(root, work, request, profile as MasterConfig['producers'][number], agents, snapshot.now, { run });
          return { profile: profile.name };
        } catch (error) { if (!(error as { accountsExhausted?: boolean })?.accountsExhausted) throw error; skipped.push(message(error)); capacity &&= !!(error as { capacityExhausted?: boolean }).capacityExhausted; }
      }
      if (!skipped.length) throw new Error(`no ${session.role} profile is free to take the request`);
      throw Object.assign(new Error(skipped.join('; ')), { accountsExhausted: true, capacityExhausted: capacity });
    },
    roleHealth: async () => {
      const config = current();
      return {
        ...(config.reviewers.length ? { reviewer: { profiles: config.reviewers, health: await inspectProfileAccounts(config, 'reviewer', config.reviewers, Object.fromEntries(config.reviewers.map(profile => [profile.name, { available: true, reason: null as string | null }]))) } } : {}),
        ...(config.producers.length ? { producer: { profiles: config.producers, health: await inspectProducerCredentials(root, config.producers) } } : {}),
      };
    },
    herdr: async () => { const runtime = await observeHerdrAgents(run); return { agents: runtime.agents, available: runtime.available }; },
    stopSupervisor: async (orphan, signal) => { await stopWatchSupervisor(orphan, signal, run); },
    credentials: profiles => inspectWorkerCredentials(root, profiles),
    snapshot: deps.snapshot,
    closeSession: pane => closeHerdrPane(pane, run),
    reclaimResources: (work, agents) => reclaimResources(root, current(), { work, agents }, { closePane: pane => closeHerdrPane(pane, run) }),
    planeHealth: () => dispatchRefusal(current().url, fetcher),
    dispatch: (work, profile, agents, snapshot) => dispatchWork(root, work, profile, agents, run, snapshot.work, undefined, undefined, undefined, snapshot.now),
    recordSession: (work, handle) => deps.mutate(`work/${work.id}/session`, handle),
    decideScope: work => deps.mutate(`work/${work.id}/autoscope`, { epoch: work.scopeRequest!.epoch }),
    // No pull request yet means no review finding: the first attempt's scope is the criteria's alone.
    // Only the configured reviewer's and the awaited bot reviewers' words are findings the loop acts on.
    reviewFindings: async work => work.candidate?.pr ? readReviewFindings({ repository: current().repository, pr: work.candidate.pr, sha: work.candidate.sha, reviewer: current().reviewer ? `${current().reviewer!.slug}[bot]` : null,
      trusted: current().run.awaitReviewers ?? defaultAwaitReviewers.logins }, run) : [],
    basePaths: paths => basePaths(root, current().baseBranch, paths, run),
    get widenScope() {
      return current().operatorAgent ? async (work: Work, request: ScopeRequestState, paths: string[], reason: string) =>
        asOperatorAgent('POST', `work/${work.id}/requirements`, answeringWidening(work, request, paths, reason)) : undefined;
    },
    requestProof: async work => {
      const config = current();
      await run('gh', ['workflow', 'run', config.run.proofWorkflow!, '--repo', config.repository, '--ref', config.baseBranch,
        '-f', `pr=${work.submission!.pr}`, '-f', `work_id=${work.id}`, '-f', `policy_revision=${work.policyRevision}`]);
    },
    merge: work => mergeExecutor(current(), deps.snapshot, deps.mutate, deps.executor, randomUUID(), run)(work),
    // `root` is this checkout: containment is derived from its object store, never from the forge.
    observeDeployment: (delivered, retained) => observeDeployment(current(), delivered, run, fetcher, () => Date.now(), { root, retained }),
    publishProductionEnvironment: async () => {
      const environment = current().run.productionEnvironment ?? productionEnvironmentFromEnv();
      if (environment === publishedEnvironment) return;
      await deps.mutate('production-environment', { environment });
      publishedEnvironment = environment;
    },
    recordDeployment: (work, observation) => deps.mutate(`work/${work.id}/deployment`, { sha: observation.sha, mergeSha: work.delivery!.mergeSha, source: observation.source, observedAt: observation.observedAt }),
    requestSmoke: async work => {
      const config = current();
      await run('gh', ['workflow', 'run', config.run.smokeWorkflow!, '--repo', config.repository, '--ref', config.baseBranch,
        '-f', `work_id=${work.id}`, '-f', `deployed_sha=${work.delivery!.deployment!.sha}`, '-f', `merge_sha=${work.delivery!.mergeSha}`, '-f', `policy_revision=${work.policyRevision}`]);
    },
    // The idle bound comes from the live configuration, so a host under pressure can shorten it
    // (or a slow repository lengthen it) without restarting the loop.
    // The same pass takes back every ephemeral checkout no live session owns, under the managed root.
    reclaim: async work => {
      const report = await reclaimWorktrees(root, work, { idleMs: reclaimIdleMs(current()) });
      try { return { ...report, checkouts: await reclaimCheckouts(root, current()) }; }
      catch (error) { return { ...report, errors: [...report.errors, `Ephemeral checkouts: ${writeFailure(error, 'Reclaiming the managed worktree root').message}`] }; }
    },
    // The decision effects exist only while the live configuration names the master's
    // operator-agent identity. Without one the loop has no way to request anything, so the cycle
    // sees them absent and records each routine decision as the escalation naming the two commands,
    // instead of a request that fails on every retry; provisioning the identity brings them back
    // on the next reload, with no restart.
    get decide() { return current().operatorAgent ? decide : undefined; },
    get approver() { return current().operatorAgent ? approver : undefined; },
    get withdraw() { return current().operatorAgent ? withdraw : undefined; },
    get decisions() { return current().operatorAgent ? decisions : undefined; },
    // A recurring fault class is filed as intent, by the same operator-agent identity (GY-173);
    // the faults it counts are read with the coordinator's visibility.
    controlPlane: coordinatorStatus,
    get reportedAttention() {
      return current().operatorAgent ? async (work: Work[], coordinator: ControlPlaneStatus & Record<string, unknown>, observed: { agents: HerdrAgent[]; approvals: ReturnType<typeof daemonSummary>['approvals']; loop: ReturnType<typeof daemonSummary>['liveness']; now: string }) =>
        // Imported when first read: the status report imports this module, so a static import would be a cycle.
        (await (await import('./cli/master-status.js')).reportedAttention(root, current(), asCoordinator, coordinator, { work, now: observed.now }, { reviews: (await readReviewLedger(root)).reviews, producers: (await readProducerLedger(root)).producers,
          runtime: { available: true, agents: observed.agents }, commit: null, approvals: observed.approvals, loop: observed.loop, standalone: true })) : undefined;
    },
    get fileFaultClass() { return current().operatorAgent ? (input: ReturnType<typeof faultClassItem>, key: string) => asOperatorAgent('POST', 'work', input, key) as Promise<Work> : undefined; },
    containment: (work, observed) => assessContainment(work, { hostId: current().hostId, observedAt: observed.now, clockOffset: observed.clockOffset, probe: target => probeSupervisorAbsence(target, { run }) }),
    settleContainment: (work, assessment) => deps.mutate(`work/${work.id}/autosettle`, { epoch: assessment.epoch, settlementHash: work.containmentQuarantine!.settlementHash,
      reason: `The master loop verified on ${assessment.host ?? current().hostId} that the supervisor of epoch ${assessment.epoch} is gone; the item is released for a fresh attempt`, verification: assessment.verification }),
    // systemd's own keep-alive channel. `systemd-notify` is part of systemd, so it is present
    // wherever NOTIFY_SOCKET is, and the loop only speaks to it when the supervisor set one.
    // Node has no unix datagram socket, so the message goes through that short-lived child, which
    // the unit admits with NotifyAccess=all. Since systemd 246 the tool waits on a barrier until
    // the manager has processed the message, so it cannot exit before it is attributed; on an
    // older systemd a keep-alive can be lost to that race, which is why the packaged window is
    // 180s against a cycle of at most 30s: a healthy loop would have to lose six in a row.
    // The keep-alive is a child too: it runs through the same runner, awaited on the event loop
    // and bounded like every other child, and a keep-alive that fails is logged by the loop.
    notify: async state => { await run('systemd-notify', state === 'ready' ? ['--ready'] : ['WATCHDOG=1']); },
    persist: state => writeDaemonState(current(), state),
  };
}
