// Concern: the daemon cursor — its schema, persistence, bounds and single-writer lock.
import { randomUUID } from 'node:crypto';
import { readlinkSync } from 'node:fs';
import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { z } from 'zod';
import { runRecordSchema } from '../runner/types.js';
import { type MasterConfig, assertOutsideWorktrees, writeFailure, diskExhaustionMessage, reclaimAdvice } from '../master.js';
import { boundDetail } from './decisions.js';
import { waitReason } from '../model/action-kinds.js'; import { timingsSchema } from '../master/timings.js';
import { classified, faultClasses, faultInstanceSchema, noteActionOutcome, type FaultKind } from '../model/fault-classes.js';
import { docsSyncWatchSchema, routedConflictSchema } from '../model/docs-sync.js'; import { unansweredStands } from '../model/fault-record.js';
import { emptyInvariantRecord, invariantRecordSchema } from '../model/invariants.js';
import { emptyProjectMemory, projectMemorySchema, type ProjectMemory } from '../model/project-memory.js';
import { itemClockSchema, latencySampleSchema } from './latency-clock.js';
import { mainWatchStateSchema } from './main-watch.js';
import { emptyMergeWriterState, mergeWriterStateSchema } from './cycle-merge-writer.js'; // lazy: it imports this module

// 'diagnosis' stays a kind a cursor may hold: the diagnostician's rows (GY-439, retired by GY-2186) still load, and nothing new records one.
export const daemonActionKinds = ['close', 'dispatch', 'review', 'refresh', 'proof', 'merge', 'deployment', 'smoke', 'escalation', 'config', 'session', 'reclaim', 'decision', 'scope', 'settle', 'failover', 'capacity', 'human', 'preserve', 'fault', 'diagnosis', 'wake', 'blocker'] as const;
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
  /** Closing finished sessions, failing over exhausted ones, stopping orphaned supervisors, and reclaiming worktrees and quarantines. */
  close: stepCostSchema,
  /** Requesting, supervising and retiring the routine decisions an approver applies. */
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
 * The release reading the continuous deploy (GY-1982) writes and master status reads: the base tip
 * the loop last saw, the commit it last deployed and when, and why it did not. Not strict: a cursor
 * written while the release-candidate drive ran (GY-1983 removed it) still carries its candidate,
 * soak, seal-check, dispatch and run fields, which load and are dropped.
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
  /** When both observations first held, whatever the stop then did; status names only established orphans (GY-1617). */
  establishedAt: z.string().nullable().default(null),
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
  /** Headless approver runs lost for this decision (GY-453) whose launch was given back; bounded by `maxLostApproverRuns`. */
  lostRuns: z.number().int().min(0).default(0),
  /** Requests made for this binding, counting the ones the server settled without applying; bounded by `maxDecisionRequests`. */
  requests: z.number().int().min(0).default(1),
  /** How each earlier session ended without a judgement, oldest first. */
  ended: z.array(z.string().max(300)).max(10).default([]),
  /** Set once the decision is applied: the watch is kept so the same binding is not requested again. */
  settledAt: z.string().nullable().default(null),
  /** GY-1298. When and by whom the decision was approved while it stood unapplied, so its wait names the apply it owes, not an approver judgement. */
  approvedAt: z.string().nullable().default(null), approvedBy: z.string().max(200).nullable().default(null),
  /** Set once every launch is spent on a decision still unjudged: the loop has escalated it. */
  exhaustedAt: z.string().nullable().default(null),
  closeAttempts: z.number().int().min(0).default(0),
  /** The GitHub observation a rework request was decided from (GY-144): its time and candidate head. */
  observation: z.object({ at: z.string(), sha: z.string() }).strict().nullable().default(null),
  /** The account and runtime the current session was launched on, so its exhaustion holds the right account (GY-182). */
  account: z.string().max(200).nullable().default(null), runtime: z.string().max(40).nullable().default(null),
  /** Retired (GY-1992): the scope request a decision answered; a cursor written before keeps parsing. */
  scope: z.unknown().optional(), coveringAdopt: z.unknown().optional(), givenBack: z.unknown().optional(),
  /** The agent-registry session the current approver runs on (GY-190), ended once the decision is judged or its quota is spent (GY-182). */
  session: z.string().max(200).nullable().default(null),
  /** Why the last launch waits for a slot: the registry refused it only because the role was full (GY-190). */
  capacity: z.string().max(500).nullable().default(null),
  /** A headless approver's run (GY-169): its last events, its result, and what became of its verdict. */
  run: runRecordSchema.nullable().default(null),
  /** The decision and launch whose spent-account hold and capacity `exhausted` report the loop already wrote (GY-316): a retried failover writes neither again. */
  reportedExhaustion: z.string().max(200).nullable().default(null),
  /** The decision and launch whose spent-account hold alone is written (GY-489): a capacity report that failed after it is retried without writing the hold again. */
  heldExhaustion: z.string().max(200).nullable().default(null),
  /** GY-1612. A replacement pane first seen while its predecessor's registry end was refused, and when: its rebind dates from that sight. */
  movedPane: z.object({ pane: z.string().max(200), at: z.string() }).strict().nullable().default(null),
  /** GY-1394. An attest decision's refusal and the head it bound: the loop returns that head to a worker on it, with no approver. */
  refusal: z.object({ approver: z.string().max(200), reason: z.string().max(1200), at: z.string(), proof: z.string().max(200), sha: z.string().max(64), baseSha: z.string().max(64), policyRevision: z.number().int().min(0) }).strict().nullable().default(null),
}).strict();
export type ApprovalWatch = z.infer<typeof approvalWatchSchema>;
/** What a re-keyed watch takes over from the one it retires: the session and what it runs on, so its exhaustion holds the account it spent (GY-182). */
export const carriedSession = (prior: ApprovalWatch) => ({ launches: prior.launches, lostRuns: prior.lostRuns, agentName: prior.agentName, pane: prior.pane, launchedAt: prior.launchedAt,
  exhaustedAt: prior.exhaustedAt, account: prior.account, runtime: prior.runtime, session: prior.session, movedPane: prior.movedPane });

/**
 * The loop's own failures (GY-119). A cycle that throws — a control-plane read that timed out, a runtime call that failed, a
 * configuration reload that could not be read — is a failed cycle, not the end of the process: it is recorded here, the cycle counter
 * advances, and the next cycle runs after a delay that grows with the consecutive count. An unhandled rejection or uncaught exception
 * anywhere in the process — a detached promise in the dispatcher, an approver watch, a Herdr read — is caught at the process level and
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

// ---- The pipeline doctor's run record (GY-711, src/daemon/doctor.ts) ---------------------------
const doctorLine = (max: number) => z.string().trim().min(1).max(max);
/** One finding of a doctor run: what was stuck, under which check bound, and whether it could act. */
export const doctorFindingsSchema = z.object({
  subject: doctorLine(200),
  check: z.enum(['blocked', 'worker', 'ci', 'review-request', 'launch', 'proofs', 'mergeable', 'decision', 'containment', 'refusal', 'overdue']),
  detail: doctorLine(2000),
  unactionable: z.boolean().default(false),
}).strict();
/** One sanctioned command the doctor ran, with what became of it. */
export const doctorActionSchema = z.object({
  subject: doctorLine(200), command: doctorLine(500), outcome: z.enum(['applied', 'refused']), detail: doctorLine(1000),
}).strict();
/** The fault item a doctor run asks the loop to file, deduplicated against open items. */
export const doctorFileEntrySchema = z.object({
  faultClass: z.enum(faultClasses), title: z.string().max(200), work: z.string().max(50).nullable().default(null), deduplicated: z.boolean().default(false),
}).strict();
/** The full fault-filing request a doctor run makes (src/daemon/doctor.ts doctorFileItem): what the loop files when no open item covers the class. */
export const doctorFiledSchema = z.object({
  faultClass: z.enum(faultClasses), title: doctorLine(200), description: doctorLine(20000),
  priority: z.number().int().min(0).max(1),
  criteria: z.array(z.object({ id: z.string().trim().regex(/^[A-Z]+-\d+$/), text: doctorLine(4000), proofs: z.array(doctorLine(200)).min(1).max(10) }).strict()).min(1).max(20),
  /** Retired (GY-1992): items carry no planned files; a run or cursor that still names them keeps parsing. */
  plannedFiles: z.unknown().optional(),
}).strict();
/** A filing the control plane did not accept when its run applied, kept for the later cycles that file it again. */
export const doctorPendingFileSchema = z.object({
  /** The filing's stable idempotency key: the same key the refused filing was posted under. */
  key: doctorLine(200), at: z.string().max(40), file: doctorFiledSchema,
}).strict();
export const doctorStates = ['running', 'reported', 'failed'] as const;
export const doctorRunRecordSchema = z.object({
  at: z.string().max(40), state: z.enum(doctorStates),
  runs: z.array(z.object({ runtime: z.string().max(40), model: z.string().max(200), result: z.string().max(40), detail: z.string().max(500) }).strict()).max(4).default([]),
  findings: z.array(doctorFindingsSchema).max(50).default([]),
  actions: z.array(doctorActionSchema).max(50).default([]),
  filed: z.array(doctorFileEntrySchema).max(20).default([]),
  detail: z.string().max(1000).default(''),
}).strict();
export const retainedDoctorRuns = 20;
export type DoctorRunRecord = z.infer<typeof doctorRunRecordSchema>;
export type DoctorFinding = z.infer<typeof doctorFindingsSchema>;
export type DoctorAction = z.infer<typeof doctorActionSchema>;
export type DoctorFiled = z.infer<typeof doctorFiledSchema>;
export type DoctorPendingFile = z.infer<typeof doctorPendingFileSchema>;
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

export const dispatchFailureRunSchema = z.object({ key: z.string().max(100), cause: z.string().max(2000), count: z.number().int().min(1), epoch: z.number().int().min(0).default(0), firstAt: z.string(), lastAt: z.string() }).strict(); export type DispatchFailureRun = z.infer<typeof dispatchFailureRunSchema>;
/** GY-1854: one attempt of the remedy a stalled loop-step signature binds to, recorded on the stall. */
export const stepStallRemedyRecordSchema = z.object({
  kind: z.string().max(40), at: z.string(),
  /** `started` is the attempt written before its mutation runs: a process that ends during it leaves the run remedied, never applied twice. */
  outcome: z.enum(['started', 'applied', 'unchanged', 'refused']), verified: z.boolean(), detail: z.string().max(2000),
}).strict();
export type StepStallRemedyRecord = z.infer<typeof stepStallRemedyRecordSchema>;
/**
 * GY-1854: one run of consecutive cycles a loop step or dispatcher call failed with one normalised
 * signature, and the stall three of them are — recorded once, its bound remedy applied once and
 * verified, and its call backed off to once per five minutes. The rules live in
 * ./step-stalls.ts, which also bounds the record a cycle that fails nowhere clears.
 */
export const stepStallSchema = z.object({
  signature: z.string().max(800),
  /** The failing call: a cycle step's action kind, the dispatcher's `dispatch`, or `cycle` for a whole failed cycle. */
  step: z.string().max(100),
  count: z.number().int().min(1),
  /** The loop cycle the run was last seen failing in: a cycle that ends without the step failing clears the run. */
  lastCycle: z.number().int().min(0),
  firstAt: z.string(), lastAt: z.string(), lastError: z.string().max(1000),
  /** When the run reached three consecutive cycles and was recorded as this stall; null until then. */
  stalledAt: z.string().nullable(),
  /** The one attempt of its bound remedy, or null while none was applied. */
  remedy: stepStallRemedyRecordSchema.nullable().default(null),
  /** When the stalled call may be attempted next: once per five minutes while the stall stands. */
  nextAttemptAt: z.string().nullable().default(null),
  /** When the held call admitted its window's one attempt, until that attempt's failure is counted; null otherwise. */
  attemptAt: z.string().nullable().default(null),
  /** The loop effects whose thrown failure the run's failed actions carry, whether each failed as a promise, and the resource the failing invocation named (its first argument's key, pane or id; null when it named none — or the run holds every invocation of the call, the collapse a full list becomes once a signature is shared by more invocations than the bound names, GY-1900): the invocations its window holds. The bound is stallInvocationBound in ./step-stalls.ts. */
  calls: z.array(z.object({ call: z.string().max(100), async: z.boolean(), resource: z.string().max(200).nullable().default(null) }).strict()).max(8).default(() => []),
  /** Whether the run is a failed cycle's own call (the snapshot read a cycle fails on): the loop holds the whole next cycle to its window. */
  cycle: z.boolean().default(false),
}).strict();
export type StepStall = z.infer<typeof stepStallSchema>;
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
  mainWatch: z.lazy(() => mainWatchStateSchema).nullable().default(null), // GY-1519: unknown main commits; lazy as main-watch.ts imports this module
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
  /** Retired (GY-1980): the progress watchdog replaced the silence record; nothing reads or writes it, and src/daemon/doctor.ts still names it until it drops its `silenceReport` argument. */
  silence: z.unknown().optional(),
  /** Retired (GY-1992): the scope requests this loop decided; a cursor written before keeps parsing. */
  scope: z.unknown().optional(),
  /** Per work item, what the loop last saw of an assignment whose Herdr session is gone. */
  orphans: z.record(z.string(), orphanObservationSchema).default({}),
  /** Per decision action key, the request this loop put to an approver and what became of it. */
  approvals: z.record(z.string(), approvalWatchSchema).default({}),
  /** Per item, head and base tip, the docs-sync session the loop launched for a docs-only conflict (GY-566). */
  docsSyncs: z.record(z.string(), docsSyncWatchSchema).default({}),
  /** Every confirmed conflict the loop routed, newest last: master status reads its hotspots from here (GY-566). */
  conflicts: z.array(routedConflictSchema).default([]),
  /** Per work item, a live lease whose session Herdr no longer reports while no fence stands (see step 1d). */
  absences: z.record(z.string(), z.object({ epoch: z.number().int().min(0), owner: z.string().max(200), firstSeenAt: z.string(), cycle: z.number().int().min(0) }).strict()).default({}),
  /** How the loop itself has been failing, as distinct from the steps it runs (see `cycleFailureSchema`). */
  failures: cycleFailureSchema.default({ consecutive: 0, total: 0, last: null, unhandled: 0, lastUnhandled: null }),
  /**
   * Every fault instance the loop recorded, each with its class (GY-173), and per standing fault
   * (`kind|subject`) the instance it is, and per action key in a run of failures the instance that run
   * is. A class that recurs past its threshold is one master-status attention line (GY-2186): no item
   * is filed and no instance is linked to one. `observedAt` is when (loop time) the loop last read the sources standing faults are observed from, which it reads on a slower cadence than it cycles.
   * The default is a factory: zod 4 hands a literal default out by reference, which would share one record between states.
   */
  faults: z.object({ instances: z.array(faultInstanceSchema).default([]), open: z.record(z.string(), z.string()).default({}), failing: z.record(z.string(), z.string()).default({}), observedAt: z.string().optional() }).strict()
    .default(() => ({ instances: [], open: {}, failing: {} })),
  /**
   * Per failing test and base head (`baseFailureKey`), a required check that fails on the base
   * branch head as well as on the candidates it blocks (GY-528): no rework is requested for it, one
   * P0 item is filed, and once the base passes again the blocked candidates are rerun and refreshed.
   */
  baseFailures: z.record(z.string(), baseFailureSchema).default(() => ({})),
  /**
   * The pipeline doctor's last runs (GY-711, src/daemon/doctor.ts): each with what it found, did
   * and filed, and the runs it took. The newest is kept whole; the list is bounded below.
   */
  doctor: z.object({
    runs: z.array(doctorRunRecordSchema).default([]),
    /** The runs (by `at`) the control plane has not yet accepted: posted again on later cycles until it does. */
    unposted: z.array(z.string().max(40)).max(40).default([]),
    /** Filings the control plane did not accept when their run applied: filed again on later cycles, under the same key, until one is. */
    pendingFiles: z.array(doctorPendingFileSchema).max(40).default([]),
    /** GY-1530: digests of filings the create route refused as written, with when the doctor last reported each: a later run reporting the same content is not filed again. A digest is kept for good (only its last-reported time is renewed): neither other refusals nor the time since the doctor last reported it evict it. */
    refusedFilings: z.array(z.object({ digest: z.string().max(80), at: z.number() }).strict()).default([]),
    /** When the approver remedy last read each open item's decision history, by item id. */
    decisionsCheckedAt: z.record(z.string(), z.string()).default({}),
    /** GY-2005: set when the loop's progress watchdog fires (cycle.ts, at the onset of its progressAttention lines): the next doctorStep launches a run at once, past the interval. */
    watchdogDue: z.boolean().default(false),
    /** GY-2005: whether the last cycle ended with the progress watchdog's lines standing — its edge, so the resolver fires once per stall, not every cycle. */
    watchdogStanding: z.boolean().default(false),
  }).strict().default(() => ({ runs: [], unposted: [], pendingFiles: [], refusedFilings: [], decisionsCheckedAt: {}, watchdogDue: false, watchdogStanding: false })),
  /**
   * The system invariants (GY-404): what the loop carries between cycles to judge them — base
   * refreshes per candidate, when each merge candidate was first seen mergeable, the builds and lease
   * losses seen — and the last cycle's report, one line per invariant, for `master status`.
   */
  invariants: invariantRecordSchema.default(emptyInvariantRecord),
  /** The master session the loop launches, adopts, wakes and rotates (GY-898); see `masterSessionSchema`. */
  master: masterSessionSchema.default(() => emptyMasterSession()),
  /**
   * Per work item id, the run of consecutive dispatch failures with one unchanged cause (GY-1078),
   * across epochs: each failed launch spends an epoch, so no per-epoch record could see the run.
   * Cleared by a launch that lands and once the blocker naming the cause is recorded.
   */
  dispatchFailures: z.record(z.string(), dispatchFailureRunSchema).default(() => ({})),
  /**
   * Per normalised signature (GY-1854), the run of consecutive cycles a loop step or dispatcher
   * call failed with it, and the stall three of them are. src/daemon/step-stalls.ts owns the rules
   * and bounds the record (retainedStepStalls).
   */
  stepStalls: z.record(z.string(), stepStallSchema).default(() => ({})),
  /** The item keys the decisions step reached past its time budget last cycle, which this cycle reaches first (GY-1286). */
  decisionsDeferred: z.array(z.string().max(200)).max(5000).default(() => []),
  /** Shared project memory (GY-1125): recent approved decisions, recurring pitfalls with sanctioned remedies, and merges. */
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
export { standingTmpKey, retainedActions, retainedMetrics, profileCooldownMs, maxProofAttempts, retainedSamples, retainedClocks, retainedBaseFailures, retainedDispatchFailureRuns, reclaimIntervalMs, gigabytes, emptyDaemonState, daemonStatePath, readDaemonState, writeDaemonState, pruneDaemonState, clampCount, storeAction, touchStanding, faultActionKey, boundDaemonState, boundDeployment, pidNamespace, initialPidNamespace, liveProcess, acquireDaemonLock, message } from './state-cursor.js';

