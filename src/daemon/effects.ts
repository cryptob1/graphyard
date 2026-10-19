// Concern: the effects a cycle acts through — their interface and cursor records; the production wiring lives beside it in ./effects-production.ts.
import { wakeOwnObservation } from '../master/base-break-refresh.js';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type ChildRun, ChildWaitLedger, childRunner } from '../child-runner.js';
import type { Work } from '../model.js';
import type { DecisionSituation } from '../model/approval.js';
import type { ScopeRequestState } from '../model/scope.js';
import { loopBlockerProbe, type BlockerClassification, type BlockerProbeRecord, type BlockerProbeResult } from './blocker-probes.js';
import { successorWidening } from '../model/successors.js';
import type { SessionHandleInput } from '../model/sessions.js';
import { paneAlreadyGone, withPaneGone } from '../request-settlement.js';
import type { MergeWriterSummary } from './cycle-merge-writer.js';
import { type HostMemoryReading, type ResourceReclaimReport, reclaimResources, dispatchRefusal, readHostMemory } from '../master-resources.js';
import { healUserSupervision, type UserSupervisionAllowance, type UserSupervisionHeal } from '../user-manager.js';
import { RefusedResponse } from '../model/refusal.js';

/** GY-1713: body `error` + zod `issues` so attention names the refused field; else stringify. */
export function refusedBodyDetail(result: unknown): string {
  if (!result || typeof result !== 'object') return JSON.stringify(result);
  const body = result as { error?: unknown; issues?: unknown };
  if (typeof body.error !== 'string') return JSON.stringify(result);
  const issues = Array.isArray(body.issues) ? body.issues : [];
  if (!issues.length) return body.error;
  const named = issues.map((issue: unknown) => {
    if (!issue || typeof issue !== 'object') return String(issue);
    const row = issue as { path?: unknown; message?: unknown };
    const path = Array.isArray(row.path) ? row.path.map(String).join('.') : '';
    const text = typeof row.message === 'string' ? row.message : String(issue);
    return path ? `${path}: ${text}` : text;
  }).join('; ');
  return `${body.error}: ${named}`;
}
import { rerunFailedChecks } from '../master/profiles.js';
import type { CapacityRole, PartialWork } from '../model/capacity.js';
import { readProducerLedger, saveProducerLedger, launchProducer } from '../producer.js';
import { followUpThreadIds, readReviewLedger, updateReviewLedger, launchReview } from '../reviewer.js';
import { type ReviewFinding, type SuccessionRead, basePaths, baseText, baseMentions, successionReader } from '../review-scope.js';
import { defaultAwaitReviewers, readDispatchCursor } from '../auto-dispatch.js';
import { relaunchSession } from './relaunch.js';
import { readApproverLaunches } from '../master/autonomy.js';
import { type MasterSessionEffects, masterSessionEffects } from '../master/master-session.js';
import { type WorkerProfile, type HerdrAgent, type WorktreeReclaimReport, type ContainmentAssessment, type EscalationSession, type ObservedExhaustion, type ProfileAccountHealth, type MasterConfig, agentToken, approverRoleHealth, decisionInput, escalationRoleHealth, holdRepeatedLimitAccount, launchApprover, launchEscalationHandler, readApproverLaunch, readEscalationSessions, saveEscalationSession, verifiedContext, listHerdrAgents, sessionAccount, preservePartialWork, recordObservedExhaustion, closeHerdrPane, inspectProfileAccounts, inspectProducerCredentials, observeHerdrAgents, inspectWorkerCredentials, deliverPrompt, dispatchWork, writeFailure, assessContainment, herdrJson, readCredentialFile, withRoleDefaults, heldAwareProbe, type ControlPlaneStatus, type SessionIdentity } from '../master.js';
import { readControlPlaneClock, type ContainmentObservation, type ControlPlaneClock } from '../master/containment.js';
import { annotatePaneShell } from '../quarantine.js';
import { herdrCall, listHerdrPanes, type HerdrPane } from '../master/herdr.js';
import { probeSupervisorAbsence } from '../containment-probe.js';
import { httpFleetClient, reconcileFleetSessions, selectFleetSession, settledRecordSessions } from '../fleet.js';
import { type ContainmentRetention, type DaemonAction, type DaemonState, type LoopRelease, storeAction, type DeploymentObservation, message, writeDaemonState } from './state.js';
import { writeProjectMemory } from '../project-memory.js';
import { answeringWidening } from './reconcile.js';
import { type OrphanSupervisor, stopWatchSupervisor } from './sessions.js';
import { neededDecision, type ExhaustedProof, type RoutineDecisionAction } from './decisions.js';
import { decisionEventKinds } from './decision-reads.js';
import type { FaultClassPolicy, FaultKind, faultClassItem } from '../model/fault-classes.js';
import { derivePlannedFiles, plannedFilesRefusal } from '../model/planned-files.js';
import { baseTree } from '../cli/planned-files-intent.js'; import { currentBaseTree } from '../executor.js';
import type { ReportedAttention } from './faults.js';
import { type BaseFailureEffects, baseFailureEffects } from './base-failure-effects.js';
import type { daemonSummary } from './run.js';
import { observeDeployment, deploymentEnvironmentName, promotionReads, promotionWorkflow, type PromotionReads } from './deployment.js';
import { mainWatchFreezeFromEnv, mainWatchReads, type MainWatchReads } from './main-watch.js';
import { mergeRecordKey, mergeWriterReads, type MergeWriterReads } from './cycle-merge-writer.js';
import { localReleasePorts } from './release-ports.js';
import { revertRecordKey } from '../release-revert.js';
import { worktreeRoot } from '../install/worktree-root.js';
import { throughputEffects, type ThroughputEffects } from './throughput-effect.js';
import type { ReadingEffects } from './reading-effect.js';
import { alignRunningLoopUnit, awaitSupervisorRestart, detectLoopSupervisorUnit, performSelfUpgrade, recoverMovedHead, type SelfUpgradeDeps, type SelfUpgradeOutcome } from './upgrade.js';
import { readRelease, restartExecutors } from '../executor-fleet.js';
import { serverCallName, timedCall, timedFetch, timedRun } from '../master/timings.js';
import type { RunRecord, Runner } from '../runner/types.js';
import { loopRunAdoption, type AdoptedRun } from './run-adoption.js';
import type { ResearchEvent } from '../research.js';
import type { DecompositionEvent } from '../decomposition.js';
import { doctorEffects, doctorSettings, type DoctorEffects } from './doctor.js';
import { docsSyncEffects, type DocsSyncEffects } from '../docs-sync.js';
import { diagnosticianEffects, diagnosticianRole, type DiagnosticianEffects } from './diagnosis.js';
import { acceptanceEffects, type AcceptanceEffects } from './acceptance.js';
import { plannerEffects, type PlannerEffects } from './planner.js';
import { diagnosticianSettings } from '../runner/payloads.js';
import type { TriageJudgement } from '../model/machine-backlog.js';
import type { FlowResult, RemedyFlow, RemedyRecord } from '../stall-remedies.js';
import { browserFlowChild } from './cycle-remedies.js';
import { readMechanicalFixState, type MechanicalFixState } from '../mechanical-findings.js';
export { snapshotRetryDelayMs, retriedSnapshot } from './snapshot-retry.js';

/** GY-1574 / GY-1705. Diagnostician registry selection through heldAwareProbe — kept here so unit:role-selection-honours-held-twin sees it. */
export async function selectDiagnosticianFleet(config: MasterConfig, work?: string | null) {
  return selectFleetSession(config, diagnosticianRole, { name: diagnosticianRole, principal: config.operatorAgent!.id }, await heldAwareProbe(config, { work: work ?? undefined }));
}

/** A reviewer or producer session a launch ledger holds as pending, as the failover step reads it. */
export interface LaunchedSession { role: 'reviewer' | 'producer'; record: string; profile: string; agentName: string; pane: string | null; work: string; requestId: string | null; /** A producer's proof group: with the item, the session its account was selected for (GY-1582). */ group?: string }
/** A session only says its account is spent once it has stopped; while it works, its output is its own prose. */
export const stoppedStates = ['idle', 'done', 'blocked'];
/** The wait an escalation launch refused for spent capacity already computed: the earliest reset among every account it skipped. */
export const launcherRetry = (error: unknown) => { const retryAt = (error as { retryAt?: unknown } | null)?.retryAt; return typeof retryAt === 'string' ? retryAt : null; };
export const failoverKey = (role: CapacityRole, work: Work, attempt: string | number) => `failover:${role}:${work.id}:${attempt}`;
export const capacityKey = (role: CapacityRole) => `capacity:${role}`;
/** GY-852: paste by pane_id, else name (profiles reuse names across sessions). */
export const promptTarget = (agent: Pick<HerdrAgent, 'name' | 'pane_id'>) => agent.pane_id ?? agent.name ?? '';

/** An item the loop files as the operator-agent: a fault-class item, or the docs trim item (GY-574), which names no class. */
export type LoopFiledItem = Omit<ReturnType<typeof faultClassItem>, 'origin'> & Partial<Pick<ReturnType<typeof faultClassItem>, 'origin'>>;
export interface DaemonEffects extends BaseFailureEffects, Partial<DocsSyncEffects>, ThroughputEffects, ReadingEffects {
  closeSession: (pane: string) => void | Promise<void>;
  dispatch: (work: Work, profile: WorkerProfile, agents: HerdrAgent[], snapshot: { work: Work[]; now: string }) => Promise<unknown>;
  requestProof: (work: Work) => void | Promise<void>;
  /** The throughput owner as the control plane holds it now, read before its needs-decision is keyed by its requirements revision (GY-1609). */
  readThroughputOwner?: (owner: Work) => Promise<Work>;
  /** Asks the control plane to decide the item's open scope request and returns the decided document. */
  decideScope?: (work: Work, nonRepository?: readonly { path: string; nearMiss: string | null; why: 'install-local' | 'untracked' }[], treeRead?: boolean) => Promise<Work>; repositoryFiles?: () => Promise<ReadonlySet<string>>;
  wakeObservation?: (work: Work) => Promise<unknown>; // GY-710: a prioritized `resync` now (GY-1266) that waits on no tick (GY-1286), for a step refused on a stale observation
  /** Wake the item's own observation; the item once a newer reading is saved, else null (GY-793). */
  observe?: (work: Work, waitMs: number) => Promise<Work | null>;
  /** The review findings standing against the item's head (unresolved threads, latest change request; review-scope.ts), read outside every transaction. */
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
  recordDeployment: (work: Work, observation: { sha: string; source: 'endpoint' | 'github-deployment'; observedAt: string }) => Promise<unknown>; // the coordinator's own deployment observation on the delivered item
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
  /** The review ledger's planned mechanical fixes (GY-971), one bot round each: each asks for its round's rework decision. `answered` names the approvals the ledger settled otherwise (follow-ups filed, a fresh read, a fallback), so the gate's report of a still-owed plan is provisional, never past the ledger's answer (GY-1814). */ mechanicalFixes?: () => Promise<MechanicalFixState & { answered?: { key: string; reviewId: number }[] }>; /** GY-1764: reports the planned fix (or none) the review gate's hold reads. */ recordMechanicalPlan?: (work: Work, plan: { reviewId: number; head: string } | null, answered?: { reviewId: number; head: string }) => Promise<unknown>;
  /** GY-1118: withdraws a capped change request as the reviewer App that posted it (GitHub's review dismissal); absent, it is escalated instead. */
  withdrawReview?: (work: Work, reviewId: number, message: string) => Promise<void>;
  /**
   * GY-437: between cycles, aligns this checkout with the verified deployed release — fetches the base branch, checks out its tip when the
   * checkout is a clean detached checkout, and, when the diff touches code the loop or the executors load, restarts the fleet and then
   * re-executes the loop through its own supervisor. A loop wired without it keeps cycling exactly as before, on the release it loaded.
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
  reclaim?: (work: Work[], now?: number) => Promise<WorktreeReclaimReport>;
  /** Worktrees disposable now by the plan over the current inventory (GY-1784); null when the plan cannot be read. */
  worktreeReclaimable?: (work: Work[], now: number) => Promise<number | null>;
  /** The resource reclaim pass (GY-132): reaps terminal records, closes finished sessions holding profile names, frees stuck sessions' slots; every cycle. */
  reclaimResources?: (work: Work[], agents: HerdrAgent[] | null) => Promise<ResourceReclaimReport>;
  /** Why the plane cannot record a dispatch's result (its /healthz verdict), or null when it can. */
  planeHealth?: () => Promise<string | null>;
  /** This host's memory (GY-612): below its floor, new launches are deferred. A loop wired without it never defers. */
  hostMemory?: () => Promise<HostMemoryReading | null>;
  /** GY-1428: revive this host's silent user manager and start its declared slots found down, as the step allows (user-manager.ts). */
  healHostSupervision?: (allow: UserSupervisionAllowance) => Promise<UserSupervisionHeal>;
  /** GY-1008: probe a blocker's cause as the next attempt meets it (blocker-probes.ts), and record it as the coordinator; a pass clears it. */ probeBlocker?: (work: Work, classification: BlockerClassification) => Promise<BlockerProbeResult | null>; recordBlockerProbe?: (work: Work, body: BlockerProbeRecord) => Promise<Work>;
  /** GY-1740: hold an unleased post-deploy follow-up on the instant its blocker names, clearing it (`window`). */ deferWindow?: (work: Work, body: { expectedRevision: number; notBefore: string; reason: string }) => Promise<Work>;
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
  approver?: (work: Work, decision: string) => Promise<{ agentName: string; pane: string | null; account?: string | null; runtime?: string | null; session?: string | null; run?: RunRecord | null; settled?: Promise<RunRecord>; /** GY-1598: why a same-named session that never ran its request was closed first. */ replaced?: string }>;
  /** The account and runtime a listed approver session was launched on, so an adopted session's exhaustion holds the account it spent. */
  approverLaunch?: (agentName: string) => Promise<{ account: string | null; runtime: string | null; session?: string | null; pane?: string | null } | null>;
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
  sessionOutput?: (agent: HerdrAgent, lines?: number) => string | null | Promise<string | null>; /** GY-1598: how long the loop watches an idle approver's screen before ending it. */ idleScreenPauseMs?: number;
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
  research?: { cwd: string; runner?: Runner }; harness?: { servingUnit?: string | null; unitDirectory?: string }; // GY-1662: the unit serving this loop, checked against the checkout the harness contract is applied to
  recordDecomposition?: (work: Work, event: DecompositionEvent) => Promise<unknown>; // GY-1126: a split run's start, decision or failure, as the coordinator; runs in `research`'s checkout and runner
  adoptRuns?: () => Promise<AdoptedRun[]>; // the headless runs a restart left running (GY-453, run-adoption.ts); unwired adopts nothing
  recordTriage?: (work: Work, body: { judgement: TriageJudgement; runtime?: string }) => Promise<unknown>; // records a triage judgement on a machine-filed item as the coordinator (GY-402, POST work/ID/triage)
  withdrawTriage?: (work: Work, body: { triageAt: string; reason: string }) => Promise<unknown>; // withdraws the closure proposed at `triageAt` (GY-1632, POST work/ID/triage `withdraw`)
  /** The reviewer and producer sessions the launch ledgers hold as pending. */
  launchedSessions?: () => Promise<LaunchedSession[]>;
  /** The account a session was launched on, as its launcher recorded it: a worker attempt's own launch record, a reviewer's or producer's own selection, by the `session` named (GY-1582). */
  selectedAccount?: (role: CapacityRole, profile: string, session?: SessionIdentity) => Promise<{ environment: string | null; kind: string | null } | null>;
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
  /** Files the one backlog item a recurring fault class (GY-173) or the docs trim item (GY-574) gets, as the operator-agent, under the key; absent without that identity, they are still recorded and reported. */
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
   * The attention `master status` adds after `buildMasterStatus` (generated-file drift, context overflows, intervention patterns, executors,
   * terminal decisions, throughput, resources, and the requests, review conflicts, stalls, overlong sessions, owed judgments, setup and
   * dispatcher lines of derivedAttention), read with the control plane's status so the loop tracks every class the report shows. `attribute`
   * is the report's last step over the whole list — a ledger refusal in place of the launch symptoms it causes, a resource at its bound
   * named in place of its symptom — so one cause is tracked as the report shows it, once.
   */
  reportedAttention?: (work: Work[], coordinator: ControlPlaneStatus & Record<string, unknown>, observed: { agents: HerdrAgent[]; available?: boolean; approvals: ReturnType<typeof daemonSummary>['approvals']; loop: ReturnType<typeof daemonSummary>['liveness']; now: string;
    /** GY-2015: the loop's own merge-writer summary, so a trial refusal its queue holds reads as its motion, not an owed decision. */
    mergeWriter?: MergeWriterSummary | null }) => Promise<ReportedAttention>;
  masterSession?: MasterSessionEffects; // the loop's own master session (GY-898); absent, none is launched, woken or rotated
}

/** How long a refusal on the review findings stands before the loop reads the findings again. */
export const findingRecheckMs = 120_000;
/** How long after its claim a launched session is given to appear in Herdr before its absence means anything. */
export const launchAppearanceMs = 120_000;
/** How long an escalation handler stays stopped with no limit notice before it is taken as finished. */
export const handlerSettleMs = 180_000;
/**
 * A session blocked on its runtime's own prompt (GY-197). A known prompt is answered on the cycle that sees it — within one loop
 * interval, well inside two minutes — and answered at most `blockedPromptAnswers` times, `blockedPromptSettleMs` apart, before it
 * counts as one the loop cannot answer. A prompt the loop cannot answer is a failed attempt, not a wait: once it has stood for
 * `blockedPromptFailMs` the session is closed as failed with the prompt as the reason.
 */
export const blockedPromptFailMs = 5 * 60_000, blockedPromptAnswers = 2, blockedPromptSettleMs = 15_000;
export { relaunchSession };
export const promptDigest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
export { record, preserveKey, preserveInterruptedAttempt } from './preserve.js';

// The production wiring lives in ./effects-production.ts; this re-export keeps every existing
// import of `daemonEffects` working.
export { daemonEffects } from './effects-production.js';

