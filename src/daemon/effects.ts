// Concern: the effects a cycle acts through — their interface, cursor records, and the production wiring.
import { wakeOwnObservation } from '../master/base-break-refresh.js';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { productionEnvironmentFromEnv } from '../flow-analytics.js';
import { type ChildRun, ChildWaitLedger, childRunner } from '../child-runner.js';
import type { Work } from '../model.js';
import type { DecisionSituation } from '../model/approval.js';
import type { ScopeRequestState } from '../model/scope.js';
import { loopBlockerProbe, type BlockerClassification, type BlockerProbeRecord, type BlockerProbeResult } from './blocker-probes.js';
import { successorWidening } from '../model/successors.js';
import type { SessionHandleInput } from '../model/sessions.js';
import { paneAlreadyGone, withPaneGone } from '../request-settlement.js';
import { type HostMemoryReading, type ResourceReclaimReport, reclaimResources, dispatchRefusal, readHostMemory } from '../master-resources.js';
import { healUserSupervision, type UserSupervisionAllowance, type UserSupervisionHeal } from '../user-manager.js';
import { RefusedResponse } from '../model/refusal.js';
import { rerunFailedChecks } from '../master/profiles.js';
import type { CapacityRole, PartialWork } from '../model/capacity.js';
import { readProducerLedger, saveProducerLedger, launchProducer, reclaimCheckouts } from '../producer.js';
import { dismissApproval, followUpThreadIds, readReviewLedger, updateReviewLedger, launchReview } from '../reviewer.js';
import { type ReviewFinding, type SuccessionRead, readReviewFindings, basePaths, baseText, baseMentions, successionReader } from '../review-scope.js';
import { defaultAwaitReviewers, readDispatchCursor } from '../auto-dispatch.js';
import { relaunchSession } from './relaunch.js';
import { readApproverLaunches } from '../master/autonomy.js';
import { type MasterSessionEffects, masterSessionEffects } from '../master/master-session.js';
import { type WorkerProfile, type HerdrAgent, type WorktreeReclaimReport, type ContainmentAssessment, type EscalationSession, type ObservedExhaustion, type ProfileAccountHealth, type MasterConfig, agentToken, approverRoleHealth, decisionInput, escalationRoleHealth, launchApprover, launchEscalationHandler, readApproverLaunch, readEscalationSessions, saveEscalationSession, verifiedContext, listHerdrAgents, readEnvironmentLog, selectionKey, preservePartialWork, recordObservedExhaustion, closeHerdrPane, inspectProfileAccounts, inspectProducerCredentials, observeHerdrAgents, inspectWorkerCredentials, deliverPrompt, dispatchWork, reclaimWorktrees, removeReclaimableWorktrees, writeWorktreeInventoryCache, reclaimIdleMs, writeFailure, assessContainment, herdrJson, readCredentialFile, withRoleDefaults, type ControlPlaneStatus } from '../master.js';
import { readControlPlaneClock, type ContainmentObservation, type ControlPlaneClock } from '../master/containment.js';
import { annotatePaneShell } from '../quarantine.js';
import { herdrCall, listHerdrPanes, type HerdrPane } from '../master/herdr.js';
import { probeSupervisorAbsence } from '../containment-probe.js';
import { httpFleetClient, reconcileFleetSessions, selectFleetSession, settledRecordSessions } from '../fleet.js';
import { type ContainmentRetention, type DaemonAction, type DaemonState, type LoopRelease, storeAction, type DeploymentObservation, message, writeDaemonState } from './state.js';
import { writeProjectMemory } from '../project-memory.js';
import { flakeLedgerEffects, type FlakeLedgerEffects } from '../flake-ledger.js';
import { answeringWidening } from './reconcile.js';
import { type OrphanSupervisor, stopWatchSupervisor } from './sessions.js';
import { neededDecision, type ExhaustedProof, type RoutineDecisionAction } from './decisions.js';
import { decisionEventKinds } from './decision-reads.js';
import type { FaultClassPolicy, FaultKind, faultClassItem } from '../model/fault-classes.js';
import { onceAnnotations, timingFaultAttention, type ReportedAttention } from './faults.js';
import { type BaseFailureEffects, baseFailureEffects } from './base-failure-effects.js';
import type { daemonSummary } from './run.js';
import { observeDeployment, promotionReads, promotionWorkflow, type PromotionReads } from './deployment.js';
import { mainWatchFreezeFromEnv, mainWatchReads, type MainWatchReads } from './main-watch.js';
import { shadowReads, shadowVerdictBody, shadowVerdictKey, type ShadowReads } from './cycle-shadow.js';
import { mergeRecordKey, mergeWriterReads, type MergeWriterReads } from './cycle-merge-writer.js';
import { readMergeWriter } from '../master/dispatch.js';
import { worktreeRoot } from '../install/worktree-root.js';
import { throughputEffects, type ThroughputEffects } from './throughput-effect.js';
import { alignRunningLoopUnit, awaitSupervisorRestart, detectLoopSupervisorUnit, performSelfUpgrade, recoverMovedHead, type SelfUpgradeDeps, type SelfUpgradeOutcome } from './upgrade.js';
import { readRelease, restartExecutors } from '../executor-fleet.js';
import { serverCallName, timedCall, timedFetch, timedRun } from '../master/timings.js';
import type { RunRecord, Runner } from '../runner/types.js';
import { loopRunAdoption, type AdoptedRun } from './run-adoption.js';
import type { ResearchEvent } from '../research.js';
import type { DecompositionEvent } from '../decomposition.js';
import { doctorEffects, doctorSettings, type DoctorEffects } from './doctor.js';
import { docsSyncEffects, type DocsSyncEffects } from '../docs-sync.js';
import { diagnosticianRole, type DiagnosticianEffects } from './diagnosis.js';
import { acceptanceEffects, type AcceptanceEffects } from './acceptance.js';
import { plannerEffects, type PlannerEffects } from './planner.js';
import { diagnosticianSettings } from '../runner/payloads.js';
import { piRunner } from '../runner/pi.js';
import { registryHeadlessLaunch, registryRunner } from '../runner/roles.js';
import type { TriageJudgement } from '../model/machine-backlog.js';
import type { FlowResult, RemedyFlow, RemedyRecord } from '../stall-remedies.js';
import { browserFlowChild } from './cycle-remedies.js';
import { readMechanicalFixState, type MechanicalFixState } from '../mechanical-findings.js';
export { snapshotRetryDelayMs, retriedSnapshot } from './snapshot-retry.js';

/** A reviewer or producer session a launch ledger holds as pending, as the failover step reads it. */
export interface LaunchedSession { role: 'reviewer' | 'producer'; record: string; profile: string; agentName: string; pane: string | null; work: string; requestId: string | null }
/** A session only says its account is spent once it has stopped; while it works, its output is its own prose. */
export const stoppedStates = ['idle', 'done', 'blocked'];
/** The wait an escalation launch refused for spent capacity already computed: the earliest reset among every account it skipped. */
export const launcherRetry = (error: unknown) => { const retryAt = (error as { retryAt?: unknown } | null)?.retryAt; return typeof retryAt === 'string' ? retryAt : null; };
export const failoverKey = (role: CapacityRole, work: Work, attempt: string | number) => `failover:${role}:${work.id}:${attempt}`;
export const capacityKey = (role: CapacityRole) => `capacity:${role}`;
/**
 * The address a paste to a session is delivered to (GY-852): the pane, which is the session's own
 * stable coordinate, and only for a session the runtime lists without one — a session the loop
 * cannot see in any pane — its name. Profiles reuse agent names across sessions, so a paste
 * resolved by name first lands on whichever session holds the name now, which is how one item's
 * re-prompt reached another item's pane (2026-09-26).
 */
export const promptTarget = (agent: Pick<HerdrAgent, 'name' | 'pane_id'>) => agent.pane_id ?? agent.name ?? '';

/** An item the loop files as the operator-agent: a fault-class item, or the docs trim item (GY-574), which names no class. */
export type LoopFiledItem = Omit<ReturnType<typeof faultClassItem>, 'origin'> & Partial<Pick<ReturnType<typeof faultClassItem>, 'origin'>>;
export interface DaemonEffects extends BaseFailureEffects, Partial<DocsSyncEffects>, ThroughputEffects, FlakeLedgerEffects {
  closeSession: (pane: string) => void | Promise<void>;
  dispatch: (work: Work, profile: WorkerProfile, agents: HerdrAgent[], snapshot: { work: Work[]; now: string }) => Promise<unknown>;
  requestProof: (work: Work) => void | Promise<void>;
  /** Asks the control plane to decide the item's open scope request and returns the decided document. */
  decideScope?: (work: Work) => Promise<Work>;
  wakeObservation?: (work: Work) => Promise<unknown>; // GY-710: a prioritized `resync` now (GY-1266) that waits on no tick (GY-1286), for a step refused on a stale observation
  /** Wake the item's own observation; the item once a newer reading is saved, else null (GY-793). */
  observe?: (work: Work, waitMs: number) => Promise<Work | null>;
  /**
   * The review findings standing against the item's head — its unresolved threads and its
   * reviewer's latest change request (review-scope.ts) — read outside every transaction.
   */
  reviewFindings?: (work: Work) => Promise<ReviewFinding[]>;
  /** Which of the paths exist on the base branch, read from one fetch of it per decision. */
  basePaths?: (paths: readonly string[]) => Promise<Set<string>>;
  /** A file's text on the base branch as `basePaths` fetched it, or null when it has none: what the pinning-test rule reads (GY-199). */
  baseText?: (path: string) => Promise<string | null>;
  /** How many files on the base branch mention an identifier: the base-tree search the criteria-implied rule weighs a call by (GY-438). */
  baseMentions?: (identifier: string) => Promise<number>;
  /**
   * The master's own additive scope widening — the revision `master scope` applies — with its
   * audited reason, bound to the scope request it answers (`answeringWidening`).
   */
  widenScope?: (work: Work, request: ScopeRequestState, paths: string[], reason: string) => Promise<unknown>;
  /**
   * The successions on the base branch since `since` — git's renames and copies, and the successor
   * map a split commit records — and which successors are files at the base tip (GY-394).
   */
  baseSuccessions?: (since: string) => Promise<SuccessionRead>;
  /**
   * Re-plans an open item onto the successors of its planned files: the master's own audited,
   * additive requirements revision (`successorWidening`), which removes nothing.
   */
  replan?: (work: Work, paths: string[], reason: string) => Promise<unknown>;
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
  /**
   * GY-1302: the promotion drive's reads and its dispatch of the release-candidate workflow; null
   * when the repository has no such workflow, absent on a loop wired without it.
   */
  promotion?: PromotionReads | null;
  /** The main watch's reads (GY-1519, main-watch.ts): the checkout's history and the control plane's acknowledgements; absent, the watch does not run. */
  mainWatch?: MainWatchReads | null;
  /** The shadow merge gate's reads (GY-1522, cycle-shadow.ts): the coordinator checkout's trial merge, build and tests, and the verdict post; absent, the gate does not run. */
  shadow?: ShadowReads | null;
  /** The control-plane merge executor's reads (GY-1524, cycle-merge-writer.ts): git in the coordinator checkout, the leased deploy-key push, the merge-record post and the recorded merger; absent, the executor does not run. */
  mergeWriter?: MergeWriterReads | null;
  /** Publishes `mergeQueue.rerunFailedChecks` to the control plane, which reruns a failed required check by it (GY-516); sent only on a change, and read at the start of every cycle so a reconfiguration applies before the next observation. */
  publishMergeSettings?: () => Promise<unknown>;
  /** GY-1416: the loop's setup step, `master setup --apply` beside the cycle at most hourly; it sets derived deployment variables only where the provider adapter applies them in place. */
  selfProvision?: () => Promise<unknown>;
  /** Asks the provider to run the trusted smoke workflow against the observed deployment. */
  requestSmoke: (work: Work) => void | Promise<void>;
  /**
   * The producer requests the dispatcher has stopped attempting (GY-496), from its cursor: the loop
   * escalates each and, a cycle later, requests the rework. Absent, nothing is escalated.
   */
  exhaustedProofs?: () => Promise<ExhaustedProof[]>;
  /** The review ledger's planned mechanical fixes (GY-971), one bot round each: each asks for its round's rework decision. */ mechanicalFixes?: () => Promise<MechanicalFixState>;
  /** GY-1118: withdraws a capped change request as the reviewer App that posted it (GitHub's review dismissal); absent, it is escalated instead. */
  withdrawReview?: (work: Work, reviewId: number, message: string) => Promise<void>;
  /**
   * GY-437: between cycles, aligns this checkout with the verified deployed release — fetches the
   * base branch, checks out its tip when the checkout is a clean detached checkout, and, when the
   * diff touches code the loop or the executors load, restarts the fleet and then re-executes the
   * loop through its own supervisor. A loop wired without it keeps cycling exactly as before, on
   * the release it loaded.
   */
  /** `keepAlive` feeds the supervisor's watchdog while the upgrade waits on the executors. */
  selfUpgrade?: (state: DaemonState, keepAlive?: () => Promise<void>) => Promise<SelfUpgradeOutcome>;
  /** GY-1356: adopts a coordinator HEAD that moved forward from `from` to `to` under the running loop, restarting onto it. */
  recoverHead?: (state: DaemonState, from: string, to: string, keepAlive?: () => Promise<void>) => Promise<SelfUpgradeOutcome>;
  /**
   * GY-437: the release this process loaded, read from its checkout when the effects are built at
   * startup, before anything can move the checkout. The loop records it on the cursor over whatever
   * a previous process left there; a loop wired without it reports none.
   */
  loadedRelease?: LoopRelease | null;
  /**
   * Removes the dependency directories of finished assignment worktrees. A loop configured
   * without it keeps cycling; it simply never reclaims. It touches no checkout, no branch, and
   * no Graphyard record, so it needs no credential and is safe to run on every cycle.
   */
  reclaim?: (work: Work[]) => Promise<WorktreeReclaimReport>;
  /** The resource reclaim pass (GY-132): reaps terminal records, closes finished sessions holding profile names, frees stuck sessions' slots; every cycle. */
  reclaimResources?: (work: Work[], agents: HerdrAgent[] | null) => Promise<ResourceReclaimReport>;
  /** Why the plane cannot record a dispatch's result (its /healthz verdict), or null when it can. */
  planeHealth?: () => Promise<string | null>;
  /** This host's memory (GY-612): below its floor, new launches are deferred. A loop wired without it never defers. */
  hostMemory?: () => Promise<HostMemoryReading | null>;
  /** GY-1428: revive this host's silent user manager and start its declared slots found down, as the step allows (user-manager.ts). */
  healHostSupervision?: (allow: UserSupervisionAllowance) => Promise<UserSupervisionHeal>;
  /** GY-1008: probe a blocker's cause as the next attempt meets it (blocker-probes.ts), and record it as the coordinator; a pass clears it. */ probeBlocker?: (work: Work, classification: BlockerClassification) => Promise<BlockerProbeResult | null>; recordBlockerProbe?: (work: Work, body: BlockerProbeRecord) => Promise<Work>;
  /**
   * Requests one routine decision with the master's own operator-agent identity and returns it.
   * A loop configured without these three keeps cycling: each routine decision is then recorded as
   * an escalation naming the command a master session runs, exactly as before. It also requests a
   * stale backlog release again (GY-1315).
   */
  decide?: (work: Work, action: RoutineDecisionAction | 'release', reason: string, input?: Record<string, unknown>) => Promise<{ id: string }>;
  /**
   * Launches the independent approver session for one requested decision, under the name
   * `approverSessionName` gives it, and reports the session so later cycles can supervise it.
   * Never the requester.
   */
  approver?: (work: Work, decision: string) => Promise<{ agentName: string; pane: string | null; account?: string | null; runtime?: string | null; session?: string | null; run?: RunRecord | null; settled?: Promise<RunRecord> }>;
  /** The account and runtime a listed approver session was launched on, so an adopted session's exhaustion holds the account it spent. */
  approverLaunch?: (agentName: string) => Promise<{ account: string | null; runtime: string | null; session?: string | null } | null>;
  /** Every approver launch recorded on this host, with the item and decision each judges (GY-403). */
  approverLaunches?: () => Promise<{ agentName: string; account: string | null; runtime: string | null; session: string | null; launchedAt: string; work: string | null; decision: string | null }[]>;
  /**
   * Ends an agent registry session whose runtime ran out of quota, so the role's slot is free for
   * the replacement launched in the same cycle (GY-182). The registry would otherwise count it live
   * until its decision window passes.
   */
  endRegistrySession?: (session: string, reason: string) => Promise<void>;
  /**
   * Ends the agent-registry sessions that no longer run (GY-190): every live one whose runtime
   * session is gone from this host's Herdr, and every one `finished` names, with its reason.
   * Returns what it ended. A loop wired without it leaves the registry to its own time windows.
   */
  reconcileSessions?: (runtime: { agents: HerdrAgent[]; available: boolean }, finished: ReadonlyMap<string, string>) => Promise<{ session: string; role: string; work: string | null; account: string; reason: string }[]>;
  /** One item's decision history: the approved merge decision automatic merging asks for, and what became of every decision this loop requested. */
  decisions?: (work: Work) => Promise<{ decisions: { id: string; action: string; state: string; input: any; requestedBy?: string; requestedAt?: string; pin?: { escalations?: { trigger: string; at: string }[] } | null; reason?: string; precedent?: string[]; situation?: DecisionSituation | null; approvedBy: string | null; approvedAt?: string | null; approvalReason?: string | null; outcome?: string | null; refusal?: { approver: string; reason: string; at?: string } | null }[] }>;
  /**
   * GY-1142. The items whose decision ledger moved after ledger seq `after`, in one read per cycle,
   * and the seq it now stands at; `after` null reads only where it stands. `complete` false means
   * more moved than one page holds. The loop keeps a history read on an earlier cycle only for an
   * item this names unmoved; absent, every history is read again each cycle.
   */
  decisionChanges?: (after: string | null) => Promise<{ seq: string; work: string[]; complete: boolean }>;
  /** The deadline the decisions step's control-plane reads share, in ms (GY-1241); `decisionReadDeadlineMs` when unset. */
  decisionReadDeadlineMs?: number;
  /**
   * Takes back one of the loop's own requests, as its requester. Only for a request the item has
   * moved past — a merge decision bound to an earlier candidate, a round the item no longer needs —
   * which would otherwise stand forever, refuse the request for the current one, or be adopted
   * for a later round on a reason that describes an older head.
   */
  withdraw?: (work: Work, decision: string, reason: string) => Promise<unknown>;
  /**
   * Asks the control plane to apply a decision an approver already approved whose application
   * recorded no outcome (GY-1300). It approves nothing: the server replays what the recorded
   * approval authorized, under the decision's own engine key, and answers the decision as it settled.
   */
  resume?: (work: Work, decision: string) => Promise<{ id: string; state?: string; outcome?: string | null; approvedBy?: string | null; approvedAt?: string | null; approvalReason?: string | null }>;
  /** Verifies on this host which quarantined supervisors are demonstrably gone. */
  containment?: (work: Work[], observed: ContainmentObservation) => Record<string, ContainmentAssessment> | Promise<Record<string, ContainmentAssessment>>;
  /** Bounds this host's clock against the control plane with a light timed read just before containment is assessed (GY-811). */
  controlPlaneClock?: () => Promise<ControlPlaneClock>;
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
  /**
   * A blocked session's runtime prompt (GY-197). `answerSession` sends the keys that choose the prompt's
   * non-destructive answer into the session's pane; `promptSession` then gives it the one instruction to carry on
   * with a safe alternative. Without them a prompt is never answered, and the attempt fails after `blockedPromptFailMs`.
   */
  answerSession?: (agent: HerdrAgent, keys: string[]) => void | Promise<void>;
  promptSession?: (agent: HerdrAgent, text: string) => void | Promise<void>;
  reportCapacity?: (work: Work, event: Record<string, unknown>) => Promise<Work>;
  blockDispatch?: (work: Work, reason: string) => Promise<unknown>; // GY-1078: an item's repeated dispatch-failure cause as its blocker; absent, the loop holds it
  /** Run one master browser flow as a child command (GY-949); a refusal resolves, only a child that printed no result rejects. */
  browserFlow?: (flow: RemedyFlow) => Promise<FlowResult>;
  /** Record the loop's attempt of a remedy on the stalled row it was applied for (`POST /api/actions/:id/remedy`). */
  recordRemedy?: (row: string, attempt: Omit<RemedyRecord, 'at' | 'by'>) => Promise<unknown>;
  /**
   * Research before build (GY-259): records a research run's start, brief or failure on the item as
   * the coordinator, and names the checkout the research session reads (and, in a test, its runner).
   * A loop wired without it, or whose config has no `run.research`, researches nothing and dispatches as before.
   */
  recordResearch?: (work: Work, event: ResearchEvent) => Promise<unknown>;
  research?: { cwd: string; runner?: Runner };
  recordDecomposition?: (work: Work, event: DecompositionEvent) => Promise<unknown>; // GY-1126: a split run's start, decision or failure, as the coordinator; runs in `research`'s checkout and runner
  adoptRuns?: () => Promise<AdoptedRun[]>; // the headless runs a restart left running (GY-453, run-adoption.ts); unwired adopts nothing
  /** Records a triage judgement on a machine-filed item as the coordinator (GY-402, POST work/ID/triage). */
  recordTriage?: (work: Work, body: { judgement: TriageJudgement; runtime?: string }) => Promise<unknown>;
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
  /**
   * The escalation handlers this host launched (GY-182), how one that ran out of quota is ended,
   * and how its escalation is launched again on another account; the last throws `accountsExhausted`
   * when none is left.
   */
  escalationSessions?: () => Promise<EscalationSession[]>;
  endEscalation?: (session: EscalationSession, resolution: string, waiting: EscalationSession['waiting']) => Promise<void>;
  /** Write an escalation handler's record back as given (the loop notes when it first saw the handler stopped). */
  markEscalation?: (session: EscalationSession) => Promise<void>;
  relaunchEscalation?: (session: EscalationSession) => Promise<{ agentName: string; account: string | null }>;
  /** Account health of the reviewer, producer and approver profiles, as the worker profiles' arrives in `credentials`. */
  roleHealth?: () => Promise<Partial<Record<'reviewer' | 'producer' | 'approver' | 'escalation-handler', { profiles: { name: string }[]; health: Record<string, { available: boolean; reason: string | null; accounts?: ProfileAccountHealth[] }> }>>>;
  /** Herdr's agent inventory, read asynchronously: an empty list when Herdr cannot be read. */
  agents: () => HerdrAgent[] | Promise<HerdrAgent[]>;
  /**
   * The host's pane inventory (`herdr pane list`, GY-842): every pane, with its cwd and agent. The
   * agent inventory never carries a bare shell (GY-1533), so the sweep's agentless candidates and
   * the pane count come from here; a loop without it, or an unreadable runtime, sweeps none.
   */
  panes?: () => Promise<{ panes: HerdrPane[]; available: boolean }>;
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
  /**
   * The review threads, per item key, that a standing approval named as follow-up (GY-166), or that
   * an approval of `work`'s current head was shown while the dispatcher has yet to file its
   * follow-ups. The review loop files and resolves them, so the cycle requests no thread rework for them.
   */
  followUpThreads?: (work: Work[], now: number) => Promise<Map<string, Set<string>>>;
  persist: (state: DaemonState) => Promise<void>;
  /** Files the one backlog item a recurring fault class (GY-173) or a flaky test (GY-1498) gets, as the operator-agent, under the key; absent without that identity, they are still recorded and reported. */
  fileFaultClass?: (input: LoopFiledItem, key: string) => Promise<Work>;
  /** The pipeline doctor (GY-711, src/daemon/doctor.ts): absent while `run.doctor.enabled` is false or the operator-agent identity is missing, the loop then running only the deterministic remedies. */
  doctor?: DoctorEffects;
  /** Clears an item's blocker as the operator-agent identity, bound to the revision the loop read (GY-711 remedy 2): only for a scope refusal plannedFiles already covers. */
  unblock?: (work: Work, reason: string) => Promise<Work>;
  diagnostician?: DiagnosticianEffects; // GY-439; absent while `run.diagnostician.enabled` is false or either master identity is missing
  acceptance?: AcceptanceEffects; // the acceptance role (GY-1417); absent while either master identity is missing
  planner?: PlannerEffects; // the planner (GY-1418); absent while either master identity is missing — each acts only through the two identities a two-party decision needs
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
  reportedAttention?: (work: Work[], coordinator: ControlPlaneStatus & Record<string, unknown>, observed: { agents: HerdrAgent[]; available?: boolean; approvals: ReturnType<typeof daemonSummary>['approvals']; loop: ReturnType<typeof daemonSummary>['liveness']; now: string }) => Promise<ReportedAttention>;
  masterSession?: MasterSessionEffects; // the loop's own master session (GY-898); absent, none is launched, woken or rotated
}

/** How long a refusal on the review findings stands before the loop reads the findings again. */
export const findingRecheckMs = 120_000;
/** How long after its claim a launched session is given to appear in Herdr before its absence means anything. */
export const launchAppearanceMs = 120_000;
/** How long an escalation handler stays stopped with no limit notice before it is taken as finished. */
export const handlerSettleMs = 180_000;
/**
 * A session blocked on its runtime's own prompt (GY-197). A known prompt is answered on the cycle
 * that sees it — within one loop interval, well inside two minutes — and answered at most
 * `blockedPromptAnswers` times, `blockedPromptSettleMs` apart, before it counts as one the loop
 * cannot answer. A prompt the loop cannot answer is a failed attempt, not a wait: once it has
 * stood for `blockedPromptFailMs` the session is closed as failed with the prompt as the reason.
 */
export const blockedPromptFailMs = 5 * 60_000, blockedPromptAnswers = 2, blockedPromptSettleMs = 15_000;
export { relaunchSession };
export const promptDigest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
export { record, preserveKey, preserveInterruptedAttempt } from './preserve.js';

/** Effects bound to the real coordinator process; `config` may be a live source the loop reloads. */
export function daemonEffects(root: string, source: MasterConfig | (() => MasterConfig), deps: {
  snapshot: () => Promise<{ work: Work[]; now: string }>;
  mutate: (path: string, data: unknown, requestId?: string) => Promise<any>;
  /** The child runner; a test's stub, or the process's own bounded asynchronous runner. */
  run?: ChildRun;
  fetcher?: typeof fetch;
  /** How long a cycle waits for the intervention report when no copy is cached yet; `reportReadBoundMs` by default. */
  reportReadBoundMs?: number;
}): DaemonEffects {
  // One runner, one ledger, for everything this loop runs — Herdr, gh, git, systemctl — so the
  // cycle's `childWaitMs` counts the cycle's own children and not the dispatcher's beside it.
  // Every child is awaited on the event loop and bounded by the runner's timeout (GY-125).
  const ledger = new ChildWaitLedger();
  const current = typeof source === 'function' ? source : () => source;
  // Every child, server request and mutation is timed against the cycle that made it (GY-377): one
  // of a second or more is recorded with its step, and the slowest is named on the cycle's line.
  const run = timedRun(deps.run ?? childRunner({ timeoutMs: 90_000, ledger }));
  const fetcher = timedFetch(deps.fetcher ?? fetch, () => current().url);
  const snapshot = () => timedCall('server', 'GET work-snapshot', deps.snapshot);
  const mutate = (path: string, data: unknown, requestId?: string) => timedCall('server', serverCallName('POST', path), () => deps.mutate(path, data, requestId));
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
    // The body is kept on the error: a decision refusal names the standing refused decision as a field (GY-265).
    if (!response.ok) throw new RefusedResponse(`Graphyard refused ${path} (${response.status}): ${result?.error ?? JSON.stringify(result)}`, response.status, result);
    return result;
  };
  /**
   * The status read faults are classified from, with the loop's own coordinator credential: the
   * operator-agent read withholds held jobs, integration jobs and production (routes/status.ts),
   * so faults in those catalogued kinds could never recur to the loop and file their class (GY-173).
   * The attention master status adds is read the same way, as `master status` reads it: the
   * intervention report refuses operator-agent callers (routes/interventions.ts).
   */
  const asCoordinator = async (path: string, _credential?: string, timeoutMs = 30_000) => {
    const config = current();
    const response = await fetcher(`${config.url}/api/${path}`, { headers: { Authorization: `Bearer ${await readCredentialFile(config.credentialFile)}` }, signal: AbortSignal.timeout(timeoutMs) });
    const result = await response.json();
    if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status}): ${result?.error ?? JSON.stringify(result)}`);
    return result;
  };
  const coordinatorStatus = async () => await asCoordinator('status') as ControlPlaneStatus & Record<string, unknown>;
  const annotations = onceAnnotations(async checkRunId => JSON.parse(await run('gh', ['api', '--paginate', `repos/${current().repository}/check-runs/${checkRunId}/annotations`])));
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
      const fresh = (await snapshot()).work.find(entry => entry.id === work.id);
      const before = neededDecision(work, current()), after = fresh ? neededDecision(fresh, current()) : null;
      if (!fresh || !before || !after || after.action !== 'resolve' || after.binding !== before.binding || after.reason !== before.reason) {
        throw new Error(`${message(error)}; ${work.key} ${after?.action === 'resolve' ? `now needs the resolve on other grounds (${after.binding})` : 'no longer needs this resolve'}, so it is not asked again at the new revision`);
      }
      return post(fresh);
    }
  };
  // The approver's runtime and account come from the registry's approver role; naming a kind here
  // would be a runtime read out of code, and the role would decide nothing.
  // The inventory says whether Herdr could be read (GY-205): one it could not judges no approver session gone.
  const approver: DaemonEffects['approver'] = async (work, decision) => { const launched = await launchApprover(root, work, decision, undefined, await observeHerdrAgents(run), run, {}, handle => mutate(`work/${work.id}/session`, handle)); return { agentName: launched.agentName, pane: launched.pane, account: launched.account?.environment ?? null, runtime: launched.runtime, session: launched.session, run: launched.run, settled: launched.settled }; };
  const docsSyncing = docsSyncEffects(root, run, work => handle => mutate(`work/${work.id}/session`, handle));
  const endRegistrySession: DaemonEffects['endRegistrySession'] = async (session, reason) => {
    const config = current();
    if (config.url) await httpFleetClient({ url: config.url, credentialFile: config.credentialFile }).end(session, reason);
  };
  // The same route, as the same requester: only the identity that asked may take a request back.
  const withdraw: DaemonEffects['withdraw'] = (work, decision, reason) => asOperatorAgent('POST', `work/${work.id}/decide`, { action: 'withdraw', decision, reason });
  const resume: DaemonEffects['resume'] = (work, decision) => asOperatorAgent('POST', `work/${work.id}/decide`, { action: 'resume', decision });
  const decisions: DaemonEffects['decisions'] = work => asOperatorAgent('GET', `work/${encodeURIComponent(work.id)}/decisions`);
  // One coordinator read of the decision ledger's kinds after the last seq the loop saw (GY-1142).
  const decisionChanges: DaemonEffects['decisionChanges'] = async after => {
    const query = new URLSearchParams({ kind: decisionEventKinds.join(','), payload: 'none', routine: 'include', order: after ? 'asc' : 'desc', limit: after ? '1000' : '1', view: 'page' });
    if (after) query.set('cursor', after);
    const read = await asCoordinator(`events?${query}`) as { events: { seq: string; work_id: string }[]; page: { hasMore: boolean } };
    return { seq: (after ? read.events.at(-1)?.seq : read.events[0]?.seq) ?? after ?? '0', work: [...new Set(read.events.map(event => event.work_id))], complete: !!after && !read.page.hasMore };
  };
  /**
   * The diagnostician's effects under the live configuration (GY-439). Its first run takes the
   * registry's diagnostician role when an operator defines one, else Pi on `run.diagnostician.model`;
   * the fallback run is Pi on the stronger `fallbackModel`. The excerpts are the loop journal, the
   * server log when a command for it is configured, and `gh pr view` of each named pull request.
   */
  const diagnostician = (config: MasterConfig): DiagnosticianEffects => {
    const settings = diagnosticianSettings(config.run);
    const lines = async (command: string[]) => String(await run(command[0], command.slice(1))).split('\n');
    return {
      settings, cwd: root,
      runner: async (attempt, subject) => {
        if (attempt === 'primary') {
          const fleet = await selectFleetSession(config, diagnosticianRole, { name: diagnosticianRole, principal: config.operatorAgent!.id }, { work: subject.work?.key });
          if (fleet) { const launch = registryHeadlessLaunch(fleet.account); return { runner: registryRunner(fleet.account), runtime: launch.command, model: launch.model, release: fleet.release }; }
        }
        const model = attempt === 'primary' ? settings.model : settings.fallbackModel;
        return { runner: piRunner({ command: settings.command, model }), runtime: 'pi', model };
      },
      context: async (_subject, numbers) => ({
        journal: await lines(settings.journalCommand).catch(error => [`(the loop journal could not be read with ${settings.journalCommand.join(' ')}: ${message(error)})`]),
        serverLog: settings.serverLogCommand ? await lines(settings.serverLogCommand).catch(error => [`(the server log could not be read with ${settings.serverLogCommand!.join(' ')}: ${message(error)})`])
          : ['(no run.diagnostician.serverLogCommand is configured, so no server log excerpt was read)'],
        pullRequests: await Promise.all(numbers.map(async number => ({ number, state: await Promise.resolve(run('gh', ['pr', 'view', String(number), '--repo', config.repository, '--json', 'number,title,state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefName,reviewDecision,statusCheckRollup']))
          .then(output => JSON.parse(String(output)), (error: unknown) => ({ error: message(error) })) }))),
      }),
      file: (input, key) => asOperatorAgent('POST', 'work', input, key) as Promise<Work>,
      decide: (work, action, reason, input) => asOperatorAgent('POST', `work/${work.id}/decide`, { action, input: decisionInput(action, work, input), reason }),
    };
  };
  let publishedEnvironment: string | null = null, publishedMergeQueue: string | null = null;
  /** GY-1524: the recorded merger, read from /api/status at most once a minute for the merge executor's switch. */
  let mergerRead: { at: number; merger: Awaited<ReturnType<typeof readMergeWriter>> } | null = null;
  const recordedMerger = async () => { if (mergerRead && Date.now() - mergerRead.at < 60_000) return mergerRead.merger; const merger = await readMergeWriter(current(), deps.fetcher); mergerRead = { at: Date.now(), merger }; return merger; };
  // The shared project memory (GY-1125) is mirrored to its own file only when it changed.
  let writtenMemory: string | null = null;
  const persistLoop = async (state: DaemonState) => {
    const memory = state.projectMemory ? JSON.stringify(state.projectMemory) : null;
    if (memory && memory !== writtenMemory) await writeProjectMemory(root, state.projectMemory).then(() => { writtenMemory = memory; }, () => {});
    return writeDaemonState(current(), state);
  };
  const upgradeDeps = (keepAlive?: () => Promise<void>): SelfUpgradeDeps => ({ root, run, // shared with the moved-HEAD recovery (GY-1356)
    restartExecutors: to => restartExecutors(current(), { actions: () => asCoordinator('actions'), coordinatorCommit: to, onWait: keepAlive, skipCurrent: true }), // a slot already on the tip is left running (GY-1432)
    restartSelf: async () => {
      const unit = detectLoopSupervisorUnit();
      if (!unit) throw new Error('this loop runs under no graphyard-master supervisor unit, so it cannot re-execute itself; run it under the packaged unit (examples/master/graphyard-master.service), or restart it by hand with systemctl --user restart graphyard-master');
      // --no-block queues the restart; systemd's stop then ends this wait, and reaches this process too (upgrade.ts restartEndedBySupervisorStop).
      await awaitSupervisorRestart(() => run('systemctl', ['--user', '--no-block', 'restart', unit]));
    },
    alignUnit: () => alignRunningLoopUnit(root, current()),
    persist: persistLoop,
  });
  return Object.defineProperties({
    agents: () => listHerdrAgents(run).catch(() => []),
    panes: async () => { try { return { panes: await listHerdrPanes(run), available: true }; } catch { return { panes: [], available: false }; } },
    // A reviewer or producer session ends with its ledger record (GY-205): its Herdr name is not one the registry session determines.
    reconcileSessions: async (runtime, finished) => {
      const settled = new Map(finished);
      for (const [session, reason] of [...settledRecordSessions('reviewer', (await readReviewLedger(root).catch(() => null))?.reviews ?? []), ...settledRecordSessions('producer', (await readProducerLedger(root).catch(() => null))?.producers ?? [])])
        if (!settled.has(session)) settled.set(session, reason);
      return reconcileFleetSessions(current(), runtime, settled);
    },
    childWaits: () => ledger.drain(),
    // The tail of the session's own terminal, unwrapped so a notice the pane folded reads as one line.
    sessionOutput: async agent => { const target = agent.name ?? agent.pane_id; return target ? herdrCall(run, ['agent', 'read', target, '--source', 'recent-unwrapped', '--lines', '60', '--format', 'text']) : null; },
    // The decline is typed into the pane and given a moment to close the dialog, so the instruction
    // that follows lands in the runtime's input rather than in the closing menu.
    answerSession: async (agent, keys) => { await herdrCall(run, ['pane', 'send-keys', agent.pane_id!, ...keys]); await delay(2_000); },
    promptSession: async (agent, text) => { await deliverPrompt(promptTarget(agent), text, run); },
    reportCapacity: (work, event) => mutate(`work/${work.id}/capacity`, event), blockDispatch: (work, reason) => mutate(`work/${work.id}/dispatchblock`, { reason }),
    browserFlow: flow => browserFlowChild(run, root, flow),
    recordRemedy: (row, attempt) => mutate(`actions/${row}/remedy`, attempt),
    recordResearch: (work, event) => mutate(`work/${work.id}/research`, event), recordDecomposition: (work, event) => mutate(`work/${work.id}/decomposition`, event),
    research: { cwd: root },
    adoptRuns: loopRunAdoption(root, current, deps.fetcher),
    recordTriage: (work, body) => mutate(`work/${work.id}/triage`, body),
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
    relaunch: async (session, work, snapshot) => relaunchSession(current(), session, work, await listHerdrAgents(run), {
      review: (profile, request, agents) => launchReview(root, work, profile.name, agents, snapshot.now, { run, requestId: request.id }),
      producer: (profile, request, agents) => launchProducer(root, work, request, profile, agents, snapshot.now, { run }),
      record: handle => mutate(`work/${work.id}/session`, handle),
    }),
    escalationSessions: () => readEscalationSessions(root),
    approverLaunch: agentName => readApproverLaunch(root, agentName),
    approverLaunches: () => readApproverLaunches(root),
    endRegistrySession,
    endEscalation: async (session, resolution, waiting) => {
      if (session.session) await endRegistrySession(session.session, resolution.slice(0, 500));
      try { if (session.pane) await closeHerdrPane(session.pane, run); } catch (error) { if (!paneAlreadyGone(error)) throw error; }
      await saveEscalationSession(root, session.work, session.trigger, waiting ? { ...session, pane: null, session: null, waiting, idleSince: undefined } : null);
    },
    markEscalation: session => saveEscalationSession(root, session.work, session.trigger, session),
    relaunchEscalation: async session => {
      // A registry session a failed launch could not end is ended first, so the relaunch has its slot.
      if (session.session) {
        await endRegistrySession(session.session, `escalation handler for ${session.work} (${session.trigger}) is launched again`);
        await saveEscalationSession(root, session.work, session.trigger, { ...session, session: null });
      }
      // The same escalation, from a context assembled again now: the one the ended handler read may be stale.
      const context = verifiedContext(await asOperatorAgent('GET', `work/${encodeURIComponent(session.work)}/context?trigger=${encodeURIComponent(session.trigger)}`));
      const launched = await launchEscalationHandler(root, current(), context, session.kind as NonNullable<WorkerProfile['kind']>, await listHerdrAgents(run), run, handle => mutate(`work/${encodeURIComponent(session.work)}/session`, handle));
      return { agentName: launched.agentName, account: launched.account };
    },
    roleHealth: async () => {
      const config = current();
      return {
        ...(config.approver && config.operatorAgent ? { approver: await approverRoleHealth(config) } : {}),
        ...(config.operatorAgent ? { 'escalation-handler': await escalationRoleHealth(config, {}, (await readEscalationSessions(root).catch(() => [] as EscalationSession[])).filter(session => session.waiting).map(session => session.runtime ?? session.kind)) } : {}),
        ...(config.reviewers.length ? { reviewer: { profiles: config.reviewers, health: await inspectProfileAccounts(config, 'reviewer', config.reviewers, Object.fromEntries(config.reviewers.map(profile => [profile.name, { available: true, reason: null as string | null }]))) } } : {}),
        ...(config.producers.length ? { producer: { profiles: config.producers, health: await inspectProducerCredentials(root, config.producers) } } : {}),
      };
    },
    herdr: async () => { const runtime = await observeHerdrAgents(run); return { agents: runtime.agents, available: runtime.available }; },
    stopSupervisor: async (orphan, signal) => { await stopWatchSupervisor(orphan, signal, run); },
    credentials: profiles => inspectWorkerCredentials(root, profiles),
    snapshot,
    followUpThreads: async (work, at) => {
      const reviewer = current().reviewer;
      return followUpThreadIds((await readReviewLedger(root)).reviews, work, reviewer ? { reviewer: `${reviewer.slug}[bot]`, now: at } : undefined);
    },
    closeSession: pane => closeHerdrPane(pane, run),
    reclaimResources: (work, agents) => reclaimResources(root, withRoleDefaults(current()), { work, agents }, { closePane: pane => closeHerdrPane(pane, run) }),
    planeHealth: () => dispatchRefusal(current().url, fetcher),
    hostMemory: readHostMemory, healHostSupervision: allow => healUserSupervision(root, {}, allow),
    probeBlocker: (work, classification) => loopBlockerProbe(current(), root, run, () => dispatchRefusal(current().url, fetcher))(work, classification), recordBlockerProbe: (work, body) => mutate(`work/${work.id}/blocker-probe`, body) as Promise<Work>,
    dispatch: (work, profile, agents, snapshot) => dispatchWork(root, work, profile, agents, run, snapshot.work, undefined, undefined, undefined, snapshot.now, { agents: () => listHerdrAgents(run) }),
    recordSession: (work, handle) => mutate(`work/${work.id}/session`, handle),
    decideScope: work => mutate(`work/${work.id}/autoscope`, { epoch: work.scopeRequest!.epoch }), wakeObservation: work => mutate(`work/${work.id}/resync`, { prioritized: true, wait: false }),
    observe: (work, waitMs) => wakeOwnObservation(body => mutate(`work/${work.id}/resync`, { ...body, prioritized: true }, randomUUID()), ms => delay(ms), { waitMs }),
    // No pull request yet means no review finding: the first attempt's scope is the criteria's alone.
    // Only the configured reviewer's and the awaited bot reviewers' words are findings the loop acts on.
    reviewFindings: async work => work.candidate?.pr ? readReviewFindings({ repository: current().repository, pr: work.candidate.pr, sha: work.candidate.sha, reviewer: current().reviewer ? `${current().reviewer!.slug}[bot]` : null,
      trusted: current().run.awaitReviewers ?? defaultAwaitReviewers.logins }, run) : [],
    basePaths: paths => basePaths(root, current().baseBranch, paths, run),
    baseText: path => baseText(root, current().baseBranch, path, run),
    baseMentions: identifier => baseMentions(root, current().baseBranch, identifier, run),
    baseSuccessions: (() => { let reader: ReturnType<typeof successionReader> | null = null, branch = ''; return (since: string) => {
      if (!reader || branch !== current().baseBranch) { branch = current().baseBranch; reader = successionReader(root, branch, run); }
      return reader(since);
    }; })(),
    get replan() {
      return current().operatorAgent ? async (work: Work, paths: string[], reason: string) =>
        asOperatorAgent('POST', `work/${work.id}/requirements`, successorWidening(work, paths, reason)) : undefined;
    },
    get withdrawReview() {
      const reviewer = current().reviewer;
      return reviewer ? (work: Work, reviewId: number, message: string) => dismissApproval(root, reviewer, current().repository, work.candidate!.pr, reviewId, message) : undefined;
    },
    get widenScope() {
      return current().operatorAgent ? async (work: Work, request: ScopeRequestState, paths: string[], reason: string) => {
        // An unrepresentable widening is refused before it is posted (GY-630): answeringWidening
        // returns null rather than a revision the schema would reject on every retry.
        const revision = answeringWidening(work, request, paths, reason);
        return revision ? asOperatorAgent('POST', `work/${work.id}/requirements`, revision) : undefined;
      } : undefined;
    },
    requestProof: async work => {
      const config = current();
      await run('gh', ['workflow', 'run', config.run.proofWorkflow!, '--repo', config.repository, '--ref', config.baseBranch,
        '-f', `pr=${work.submission!.pr}`, '-f', `work_id=${work.id}`, '-f', `policy_revision=${work.policyRevision}`]);
    },
    // `root` is this checkout: containment is derived from its object store, never from the forge.
    observeDeployment: (delivered, retained) => observeDeployment(current(), delivered, run, fetcher, () => Date.now(), { root, retained }),
    get promotion() { return promotionReads(current(), root, run, existsSync(join(root, '.github', 'workflows', promotionWorkflow))); },
    // GY-1519: the watch reads history from this checkout and its policy from the control plane; the freeze is the environment's ask.
    get mainWatch() { return mainWatchReads(current(), root, run, { policy: () => asCoordinator('main-watch'), freeze: mainWatchFreezeFromEnv() }); },
    // GY-1522: the gate trial-merges in this checkout's object store under the managed worktree root and records each verdict as the coordinator, one idempotency key per (head, tip).
    get shadow() { const config = current(); return shadowReads(config, root, run, { base: worktreeRoot(root, config), record: (work, verdict) => mutate(`work/${work.id}/shadow-verdict`, shadowVerdictBody(verdict), shadowVerdictKey(work, verdict)) }); },
    // GY-1524: the executor merges in this checkout's object store, pushes with the install's deploy key alone, records each step as the coordinator under one key per (step, commits), and acts only while the recorded merger is control-plane (read at most once a minute).
    get mergeWriter() { const config = current(); return mergeWriterReads(config, root, run, { base: worktreeRoot(root, config), record: (work, event) => mutate(`work/${work.id}/merge-record`, event, mergeRecordKey(work, event)), merger: recordedMerger }); },
    publishProductionEnvironment: async () => {
      const environment = current().run.productionEnvironment ?? productionEnvironmentFromEnv();
      if (environment === publishedEnvironment) return;
      await mutate('production-environment', { environment });
      publishedEnvironment = environment;
    },
    selfProvision: async () => (await import('../cli/master-setup.js')).loopSelfProvision(root, current()), // imported when first run: only this step reads the install modules
    publishMergeSettings: async () => {
      const config = { rerunFailedChecks: rerunFailedChecks(current()) };
      const published = JSON.stringify(config);
      if (published === publishedMergeQueue) return;
      await mutate('merge-queue', config);
      publishedMergeQueue = published;
    },
    ...throughputEffects(root, current, run, asCoordinator, asOperatorAgent), ...flakeLedgerEffects(root),
    recordDeployment: (work, observation) => mutate(`work/${work.id}/deployment`, { sha: observation.sha, mergeSha: work.delivery!.mergeSha, source: observation.source, observedAt: observation.observedAt }),
    exhaustedProofs: async () => Object.entries((await readDispatchCursor(root, current(), () => {})).abandoned).filter(([, entry]) => entry.kind === 'producer')
      .map(([requestId, entry]) => ({ requestId, work: entry.work, sha: entry.sha, group: entry.group ?? null, proofs: entry.proofs ?? [], attempts: entry.attempts, reason: entry.reason })),
    mechanicalFixes: () => readMechanicalFixState(root),
    requestSmoke: async work => {
      const config = current();
      await run('gh', ['workflow', 'run', config.run.smokeWorkflow!, '--repo', config.repository, '--ref', config.baseBranch,
        '-f', `work_id=${work.id}`, '-f', `deployed_sha=${work.delivery!.deployment!.sha}`, '-f', `merge_sha=${work.delivery!.mergeSha}`, '-f', `policy_revision=${work.policyRevision}`]);
    },
    // The idle bound comes from the live configuration, so a host under pressure can shorten it
    // (or a slow repository lengthen it) without restarting the loop.
    // The same pass takes back every ephemeral checkout no live session owns, under the managed root.
    // Finished worktrees are removed outright first, a bounded number per pass (GY-360); the
    // inventory that remains is the one the dependency reclaim judges and `master status` reads.
    reclaim: async work => {
      const config = current(), idleMs = reclaimIdleMs(config);
      const livePaths = [...(await readReviewLedger(root)).reviews, ...(await readProducerLedger(root)).producers]
        .filter(record => record.state === 'pending' && record.checkout).map(record => record.checkout!);
      const trees = await removeReclaimableWorktrees(root, work, { idleMs, run, baseBranch: config.baseBranch, limit: config.run.worktreeRemovalLimit, livePaths });
      const report = await reclaimWorktrees(root, work, { idleMs, entries: trees.entries });
      const taken = new Set(report.applied ? report.removed : []);
      await writeWorktreeInventoryCache(root, { at: trees.at, entries: trees.entries.map(entry => ({ ...entry, dependencies: entry.dependencies.filter(dependency => !taken.has(dependency.path)) })),
        held: trees.held })
        .catch(error => report.errors.push(`Worktree inventory cache: ${writeFailure(error, 'Writing the worktree inventory cache').message}`));
      const withTrees = { ...report, trees };
      try { return { ...withTrees, checkouts: await reclaimCheckouts(root, config) }; }
      catch (error) { return { ...withTrees, errors: [...withTrees.errors, `Ephemeral checkouts: ${writeFailure(error, 'Reclaiming the managed worktree root').message}`] }; }
    },
    // The decision effects exist only while the live configuration names the master's operator-agent identity. Without one the loop
    // has no way to request anything, so the cycle sees them absent and records each routine decision as the escalation naming the
    // two commands, instead of a request that fails on every retry; provisioning the identity brings them back on the next reload, with no restart.
    get decide() { return current().operatorAgent ? decide : undefined; },
    get approver() { return current().operatorAgent ? approver : undefined; },
    get docsSync() { return current().operatorAgent ? docsSyncing.docsSync : undefined; }, conflictPaths: docsSyncing.conflictPaths, docsSyncSettled: docsSyncing.docsSyncSettled,
    get withdraw() { return current().operatorAgent ? withdraw : undefined; },
    get resume() { return current().operatorAgent ? resume : undefined; },
    get decisions() { return current().operatorAgent ? decisions : undefined; },
    get decisionChanges() { return current().operatorAgent ? decisionChanges : undefined; },
    // A recurring fault class is filed as intent, by the same operator-agent identity (GY-173);
    // the faults it counts are read with the coordinator's visibility, with or without that identity,
    // so an installation that has not provisioned it yet still counts every recurrence.
    controlPlane: coordinatorStatus,
    reportedAttention: async (work: Work[], coordinator: ControlPlaneStatus & Record<string, unknown>, observed: { agents: HerdrAgent[]; available?: boolean; approvals: ReturnType<typeof daemonSummary>['approvals']; loop: ReturnType<typeof daemonSummary>['liveness']; now: string }) => {
      // Imported when first read: the status report imports this module, so a static import would be a cycle.
      const reported = await (await import('../cli/master-status.js')).reportedAttention(root, withRoleDefaults(current()), asCoordinator, coordinator, { work, now: observed.now }, { reviews: (await readReviewLedger(root)).reviews, producers: (await readProducerLedger(root)).producers,
        runtime: { available: observed.available ?? true, agents: observed.agents }, commit: null, approvals: observed.approvals, loop: observed.loop, standalone: true,
        // The intervention report takes the server close to a minute (GY-377): the cycle uses the
        // cached copy and refreshes it detached from itself, which is also the copy master status reads.
        reports: 'background', reportBoundMs: deps.reportReadBoundMs });
      // A required check red on the clock is named as master status names it, after buildMasterStatus.
      return { ...reported, items: [...reported.items, ...await timingFaultAttention(work, current().repository, annotations)] };
    },
    get diagnostician() { const config = current(); return config.operatorAgent && config.approver && diagnosticianSettings(config.run).enabled ? diagnostician(config) : undefined; },
    get acceptance() { const config = current(); return config.operatorAgent && config.approver ? acceptanceEffects(config, root, { run, fetcher, asCoordinator, asOperatorAgent }) : undefined; },
    get planner() { const config = current(); return config.operatorAgent && config.approver ? plannerEffects(config, root, { fetcher, asCoordinator, asOperatorAgent }) : undefined; },
    get fileFaultClass() { return current().operatorAgent ? (input: LoopFiledItem, key: string) => asOperatorAgent('POST', 'work', input, key) as Promise<Work> : undefined; },
    get unblock() { return current().operatorAgent ? (work: Work, reason: string) => asOperatorAgent('POST', `work/${work.id}/unblock`, { reason, expectedRevision: work.revision }) as Promise<Work> : undefined; },
    get doctor() { const config = current(); return config.operatorAgent && doctorSettings(config.run).enabled ? doctorEffects(config, root, asOperatorAgent) : undefined; },
    controlPlaneClock: () => readControlPlaneClock(current().url, { fetcher }),
    containment: (work, observed) => assessContainment(work, { hostId: current().hostId, observedAt: observed.now, clockOffset: observed.clockOffset, clockRoundTripMs: observed.clockRoundTripMs, clockSource: observed.clockSource, probe: async target => annotatePaneShell(await probeSupervisorAbsence(target, { run }),
      work.find(item => item.key === target.key && item.containmentQuarantine?.epoch === target.epoch), pane => herdrJson(['pane', 'process-info', '--pane', pane], run), undefined, () => herdrJson(['pane', 'list'], run),
      () => herdrJson(['status', 'server', '--json'], run)) }),
    settleContainment: (work, assessment) => mutate(`work/${work.id}/autosettle`, { epoch: assessment.epoch, settlementHash: work.containmentQuarantine!.settlementHash,
      reason: `The master loop verified on ${assessment.host ?? current().hostId} that the supervisor of epoch ${assessment.epoch} is gone; the item is released for a fresh attempt`, verification: assessment.verification, origin: 'loop' }),
    // systemd's own keep-alive channel. `systemd-notify` is part of systemd, so it is present wherever NOTIFY_SOCKET is, and the loop
    // only speaks to it when the supervisor set one. Node has no unix datagram socket, so the message goes through that short-lived
    // child, which the unit admits with NotifyAccess=all. Since systemd 246 the tool waits on a barrier until the manager has processed
    // the message, so it cannot exit before it is attributed; on an older systemd a keep-alive can be lost to that race, which is why
    // the packaged window is 180s against a cycle of at most 30s: a healthy loop would have to lose six in a row. The keep-alive is a
    // child too: it runs through the same runner, awaited on the event loop and bounded like every other child, and a keep-alive that fails is logged by the loop.
    // GY-437: the loop upgrades its own checkout between cycles. The executors come first,
    // through the shipped restart command — a refusal (a claim in flight, another restart's
    // fence) leaves the owed restarts on the cursor for the next cycle — and the loop
    // re-executes itself only through the supervisor unit it actually runs under, detected from
    // its own cgroup like an executor's.
    loadedRelease: readRelease(root),
    selfUpgrade: (state, keepAlive) => performSelfUpgrade(current(), state, upgradeDeps(keepAlive)),
    recoverHead: (state, from, to, keepAlive) => recoverMovedHead(current(), state, from, to, upgradeDeps(keepAlive)),
    notify: async state => { await run('systemd-notify', state === 'ready' ? ['--ready'] : ['WATCHDOG=1']); },
    masterSession: masterSessionEffects(root, current, run),
    persist: persistLoop,
  }, Object.getOwnPropertyDescriptors(baseFailureEffects(run, current, asOperatorAgent)));
}
