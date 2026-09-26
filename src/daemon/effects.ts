// Concern: the effects a cycle acts through — their interface, cursor records, and the production wiring.
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { productionEnvironmentFromEnv } from '../flow-analytics.js';
import { type ChildRun, ChildWaitLedger, childRunner } from '../child-runner.js';
import type { Work } from '../model.js';
import type { DecisionSituation } from '../model/approval.js';
import type { ScopeRequestState } from '../model/scope.js';
import { successorWidening } from '../model/successors.js';
import type { SessionHandleInput } from '../model/sessions.js';
import { paneAlreadyGone, withPaneGone } from '../request-settlement.js';
import { type ResourceReclaimReport, reclaimResources, dispatchRefusal } from '../master-resources.js';
import { mergeBatchSize } from '../master/profiles.js';
import type { CapacityRole, PartialWork } from '../model/capacity.js';
import { readProducerLedger, saveProducerLedger, independentProducerProfiles, launchProducer, reclaimCheckouts } from '../producer.js';
import { followUpThreadIds, readReviewLedger, updateReviewLedger, launchReview } from '../reviewer.js';
import { type ReviewFinding, type SuccessionRead, readReviewFindings, basePaths, baseText, baseMentions, successionReader } from '../review-scope.js';
import { defaultAwaitReviewers, launchedSessionHandle } from '../auto-dispatch.js';
import type { DispatchRequest } from '../model/dispatch.js';
import { registeredLaunch } from '../model/session-state.js';
import { readApproverLaunches } from '../master/autonomy.js';
import { type WorkerProfile, type HerdrAgent, type WorktreeReclaimReport, type ContainmentAssessment, type EscalationSession, type ObservedExhaustion, type ProfileAccountHealth, type MasterConfig, type MergeExecutor, agentToken, approverRoleHealth, decisionInput, escalationRoleHealth, launchApprover, launchEscalationHandler, readApproverLaunch, readEscalationSessions, saveEscalationSession, verifiedContext, listHerdrAgents, readEnvironmentLog, selectionKey, preservePartialWork, recordObservedExhaustion, closeHerdrPane, inspectProfileAccounts, inspectProducerCredentials, observeHerdrAgents, inspectWorkerCredentials, deliverPrompt, dispatchWork, mergeExecutor, reclaimWorktrees, removeReclaimableWorktrees, writeWorktreeInventoryCache, reclaimIdleMs, writeFailure, assessContainment, herdrJson } from '../master.js';
import { annotatePaneShell } from '../quarantine.js';
import { probeSupervisorAbsence } from '../containment-probe.js';
import { httpFleetClient, reconcileFleetSessions } from '../fleet.js';
import { type ContainmentRetention, type DaemonAction, type DaemonState, storeAction, type DeploymentObservation, message, writeDaemonState } from './state.js';
import { answeringWidening } from './reconcile.js';
import { type OrphanSupervisor, readyToRetry, stopWatchSupervisor } from './sessions.js';
import { neededDecision, type RoutineDecisionAction } from './decisions.js';
import type { FaultClassPolicy, FaultKind, faultClassItem } from '../model/fault-classes.js';
import type { ControlPlaneStatus } from '../master.js';
import { readCredentialFile } from '../master.js';
import { onceAnnotations, timingFaultAttention, type ReportedAttention } from './faults.js';
import type { daemonSummary } from './run.js';
import { observeDeployment } from './deployment.js';
import { serverCallName, timedCall, timedFetch, timedRun } from '../master/timings.js';
import type { RunRecord, Runner } from '../runner/types.js';
import type { ResearchEvent } from '../research.js';

/** A reviewer or producer session a launch ledger holds as pending, as the failover step reads it. */
export interface LaunchedSession { role: 'reviewer' | 'producer'; record: string; profile: string; agentName: string; pane: string | null; work: string; requestId: string | null }
/** A session only says its account is spent once it has stopped; while it works, its output is its own prose. */
export const stoppedStates = ['idle', 'done', 'blocked'];
/** The wait an escalation launch refused for spent capacity already computed: the earliest reset among every account it skipped. */
export const launcherRetry = (error: unknown) => { const retryAt = (error as { retryAt?: unknown } | null)?.retryAt; return typeof retryAt === 'string' ? retryAt : null; };
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
  /**
   * Publishes `mergeQueue.batchSize` (GY-330) to the control plane, whose merge queue batches by
   * it; sent only on a change, and read at the start of every cycle so a reconfiguration applies
   * before the next merge.
   */
  publishMergeBatchSize?: () => Promise<unknown>;
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
  /**
   * One item's decision history: the approved merge decision automatic merging asks for, and what
   * became of every decision this loop requested.
   */
  decisions?: (work: Work) => Promise<{ decisions: { id: string; action: string; state: string; input: any; pin?: { escalations?: { trigger: string; at: string }[] } | null; reason?: string; precedent?: string[]; situation?: DecisionSituation | null; approvedBy: string | null; approvedAt?: string | null; approvalReason?: string | null; outcome?: string | null; refusal?: { approver: string; reason: string; at?: string } | null }[] }>;
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
  /**
   * A blocked session's runtime prompt (GY-197). `answerSession` sends the keys that choose the
   * prompt's non-destructive answer into the session's pane; `promptSession` then gives it the one
   * instruction to carry on with a safe alternative. A loop wired without them never answers a
   * prompt, and fails an attempt blocked on one once it has stood for `blockedPromptFailMs`.
   */
  answerSession?: (agent: HerdrAgent, keys: string[]) => void | Promise<void>;
  promptSession?: (agent: HerdrAgent, text: string) => void | Promise<void>;
  reportCapacity?: (work: Work, event: Record<string, unknown>) => Promise<Work>;
  /**
   * Research before build (GY-259): records a research run's start, brief or failure on the item as
   * the coordinator, and names the checkout the research session reads (and, in a test, its runner).
   * A loop wired without it, or whose config has no `run.research`, researches nothing and dispatches as before.
   */
  recordResearch?: (work: Work, event: ResearchEvent) => Promise<unknown>;
  research?: { cwd: string; runner?: Runner };
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
  reportedAttention?: (work: Work[], coordinator: ControlPlaneStatus & Record<string, unknown>, observed: { agents: HerdrAgent[]; available?: boolean; approvals: ReturnType<typeof daemonSummary>['approvals']; loop: ReturnType<typeof daemonSummary>['liveness']; now: string }) => Promise<ReportedAttention>;
}

/** Put an action on the cursor, through storeAction, which bounds it and notes it against the fault record (GY-173). */
export async function record(state: DaemonState, key: string, action: Omit<DaemonAction, 'at' | 'epoch' | 'faultClass'> & { at?: string; epoch?: number | null }, now: number, persist: DaemonEffects['persist'], faultKind?: FaultKind | null) {
  const entry = storeAction(state, key, { epoch: null, ...action, at: action.at ?? new Date(now).toISOString() }, faultKind);
  await persist(state);
  return entry;
}

/** One preservation per attempt: the record an interrupted attempt leaves for the next one. */
export const preserveKey = (work: Pick<Work, 'id'>, epoch: number) => `preserve:${work.id}:${epoch}`;
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
export const promptDigest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
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
export async function preserveInterruptedAttempt(state: DaemonState, effects: DaemonEffects, item: Work, epoch: number, profile: WorkerProfile | undefined, observed: string, now: () => number, performed: DaemonAction[]) {
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

/** The pause before the one retry of a failed snapshot read: a second or so, jittered so loops never retry in step. */
export const snapshotRetryDelayMs = (random: () => number = Math.random) => Math.round(500 + random() * 1000);
/**
 * The coordination snapshot read, retried once. The read is an idempotent GET, and one timed-out or
 * refused read is usually the network or a busy server, not a fault worth a failed cycle and its
 * backoff: it is tried again after a jittered pause, and only a second failure fails the cycle
 * (GY-187). `master run` wraps its snapshot effect in this.
 */
export function retriedSnapshot<T>(read: () => Promise<T>, pause: () => number = snapshotRetryDelayMs): () => Promise<T> {
  return async () => {
    try { return await read(); }
    catch { await delay(pause()); return read(); }
  };
}

/**
 * The quota failover's relaunch of a reviewer or producer session, registered like every other
 * launch (GY-172 AC-2). The session that ran out was ended on its ledger, but its record still
 * names its pane and its launch; it is closed with that reason, and the next session for the same
 * request is registered through `registeredLaunch` before its runtime starts and coordinated once
 * it has, so the relaunched session is observed and closed by the session report like the one it
 * replaces rather than running unrecorded while the report loses the old pane.
 */
export async function relaunchSession(config: MasterConfig, session: LaunchedSession, work: Work, agents: HerdrAgent[], launch: {
  review: (profile: MasterConfig['reviewers'][number], request: DispatchRequest, agents: HerdrAgent[]) => Promise<unknown>;
  producer: (profile: MasterConfig['producers'][number], request: DispatchRequest, agents: HerdrAgent[]) => Promise<unknown>;
  record?: (handle: SessionHandleInput) => Promise<unknown>;
}): Promise<{ profile: string }> {
  const request = session.role === 'reviewer' ? work.autoDispatch?.review : work.autoDispatch?.producers.find(entry => entry.id === session.requestId);
  if (!request || request.id !== session.requestId || request.state !== 'requested') throw new Error(`${work.key} no longer requests this ${session.role} session`);
  const kind = session.role === 'reviewer' ? 'review' as const : 'proof' as const;
  const subject = kind === 'review' ? `${work.key}: review ${request.sha.slice(0, 12)} (PR #${request.pr})` : `${work.key}: ${request.group} proofs on ${request.sha.slice(0, 12)} (${(request.proofs ?? []).join(', ')})`;
  const previous = work.sessions?.find(handle => handle.id === request.id && handle.state === 'running');
  if (previous && launch.record) {
    await launch.record({ id: previous.id, kind: previous.kind, runtime: previous.runtime, host: previous.host, subject: previous.subject, state: 'finished',
      outcome: `ended on its provider's quota notice (${session.agentName} on profile ${session.profile}); its request is launched again on another account` }).catch(() => {});
  }
  // The profile that just ran out goes last: its other accounts are still its own failover.
  const order = <P extends { name: string; agentName: string }>(profiles: P[]) => [...profiles.filter(profile => profile.name !== session.profile), ...profiles.filter(profile => profile.name === session.profile)].filter(profile => !agents.some(agent => agent.name === profile.agentName));
  const skipped: string[] = [];
  // As in the dispatcher: only skips that were all spent quota make this a wait for capacity.
  let capacity = true;
  const attach = (pane: string) => `herdr pane attach ${pane}${config.herdrWorkspace ? ` --workspace ${config.herdrWorkspace}` : ''}`;
  for (const profile of session.role === 'reviewer' ? order(config.reviewers) : order(independentProducerProfiles(work, config.producers))) {
    try {
      const principal = session.role === 'producer' ? (profile as MasterConfig['producers'][number]).principal : undefined;
      await registeredLaunch(launch.record, launchedSessionHandle(kind, request, subject, config.hostId, undefined, profile.kind, config.herdrWorkspace, principal),
        () => session.role === 'reviewer' ? launch.review(profile as MasterConfig['reviewers'][number], request, agents) : launch.producer(profile as MasterConfig['producers'][number], request, agents), undefined, attach);
      return { profile: profile.name };
    } catch (error) { if (!(error as { accountsExhausted?: boolean })?.accountsExhausted) throw error; skipped.push(message(error)); capacity &&= !!(error as { capacityExhausted?: boolean }).capacityExhausted; }
  }
  if (!skipped.length) throw new Error(`no ${session.role} profile is free to take the request`);
  throw Object.assign(new Error(skipped.join('; ')), { accountsExhausted: true, capacityExhausted: capacity });
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
  const approver: DaemonEffects['approver'] = async (work, decision) => { const launched = await launchApprover(root, work, decision, undefined, await listHerdrAgents(run), run, {}, handle => mutate(`work/${work.id}/session`, handle)); return { agentName: launched.agentName, pane: launched.pane, account: launched.account?.environment ?? null, runtime: launched.runtime, session: launched.session, run: launched.run, settled: launched.settled }; };
  const endRegistrySession: DaemonEffects['endRegistrySession'] = async (session, reason) => {
    const config = current();
    if (config.url) await httpFleetClient({ url: config.url, credentialFile: config.credentialFile }).end(session, reason);
  };
  // The same route, as the same requester: only the identity that asked may take a request back.
  const withdraw: DaemonEffects['withdraw'] = (work, decision, reason) => asOperatorAgent('POST', `work/${work.id}/decide`, { action: 'withdraw', decision, reason });
  const decisions: DaemonEffects['decisions'] = work => asOperatorAgent('GET', `work/${encodeURIComponent(work.id)}/decisions`);
  let publishedEnvironment: string | null = null, publishedBatchSize: number | null = null;
  return {
    agents: () => listHerdrAgents(run).catch(() => []),
    reconcileSessions: (runtime, finished) => reconcileFleetSessions(current(), runtime, finished),
    childWaits: () => ledger.drain(),
    // The tail of the session's own terminal, unwrapped so a notice the pane folded reads as one line.
    sessionOutput: async agent => { const target = agent.name ?? agent.pane_id; return target ? run('herdr', ['agent', 'read', target, '--source', 'recent-unwrapped', '--lines', '60', '--format', 'text']) : null; },
    // The decline is typed into the pane and given a moment to close the dialog, so the instruction
    // that follows lands in the runtime's input rather than in the closing menu.
    answerSession: async (agent, keys) => { await run('herdr', ['pane', 'send-keys', agent.pane_id!, ...keys]); await delay(2_000); },
    promptSession: async (agent, text) => { await deliverPrompt(agent.name ?? agent.pane_id!, text, run); },
    reportCapacity: (work, event) => mutate(`work/${work.id}/capacity`, event),
    recordResearch: (work, event) => mutate(`work/${work.id}/research`, event),
    research: { cwd: root },
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
    reclaimResources: (work, agents) => reclaimResources(root, current(), { work, agents }, { closePane: pane => closeHerdrPane(pane, run) }),
    planeHealth: () => dispatchRefusal(current().url, fetcher),
    dispatch: (work, profile, agents, snapshot) => dispatchWork(root, work, profile, agents, run, snapshot.work, undefined, undefined, undefined, snapshot.now, { agents: () => listHerdrAgents(run) }),
    recordSession: (work, handle) => mutate(`work/${work.id}/session`, handle),
    decideScope: work => mutate(`work/${work.id}/autoscope`, { epoch: work.scopeRequest!.epoch }),
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
    get widenScope() {
      return current().operatorAgent ? async (work: Work, request: ScopeRequestState, paths: string[], reason: string) =>
        asOperatorAgent('POST', `work/${work.id}/requirements`, answeringWidening(work, request, paths, reason)) : undefined;
    },
    requestProof: async work => {
      const config = current();
      await run('gh', ['workflow', 'run', config.run.proofWorkflow!, '--repo', config.repository, '--ref', config.baseBranch,
        '-f', `pr=${work.submission!.pr}`, '-f', `work_id=${work.id}`, '-f', `policy_revision=${work.policyRevision}`]);
    },
    merge: work => mergeExecutor(current(), snapshot, mutate, deps.executor, randomUUID(), run)(work),
    // `root` is this checkout: containment is derived from its object store, never from the forge.
    observeDeployment: (delivered, retained) => observeDeployment(current(), delivered, run, fetcher, () => Date.now(), { root, retained }),
    publishProductionEnvironment: async () => {
      const environment = current().run.productionEnvironment ?? productionEnvironmentFromEnv();
      if (environment === publishedEnvironment) return;
      await mutate('production-environment', { environment });
      publishedEnvironment = environment;
    },
    publishMergeBatchSize: async () => {
      const batchSize = mergeBatchSize(current());
      if (batchSize === publishedBatchSize) return;
      await mutate('merge-queue', { batchSize });
      publishedBatchSize = batchSize;
    },
    recordDeployment: (work, observation) => mutate(`work/${work.id}/deployment`, { sha: observation.sha, mergeSha: work.delivery!.mergeSha, source: observation.source, observedAt: observation.observedAt }),
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
    // the faults it counts are read with the coordinator's visibility, with or without that identity,
    // so an installation that has not provisioned it yet still counts every recurrence.
    controlPlane: coordinatorStatus,
    reportedAttention: async (work: Work[], coordinator: ControlPlaneStatus & Record<string, unknown>, observed: { agents: HerdrAgent[]; available?: boolean; approvals: ReturnType<typeof daemonSummary>['approvals']; loop: ReturnType<typeof daemonSummary>['liveness']; now: string }) => {
      // Imported when first read: the status report imports this module, so a static import would be a cycle.
      const reported = await (await import('../cli/master-status.js')).reportedAttention(root, current(), asCoordinator, coordinator, { work, now: observed.now }, { reviews: (await readReviewLedger(root)).reviews, producers: (await readProducerLedger(root)).producers,
        runtime: { available: observed.available ?? true, agents: observed.agents }, commit: null, approvals: observed.approvals, loop: observed.loop, standalone: true,
        // The intervention report takes the server close to a minute (GY-377): the cycle uses the
        // cached copy and refreshes it detached from itself, which is also the copy master status reads.
        reports: 'background', reportBoundMs: deps.reportReadBoundMs });
      // A required check red on the clock is named as master status names it, after buildMasterStatus.
      return { ...reported, items: [...reported.items, ...await timingFaultAttention(work, current().repository, annotations)] };
    },
    get fileFaultClass() { return current().operatorAgent ? (input: ReturnType<typeof faultClassItem>, key: string) => asOperatorAgent('POST', 'work', input, key) as Promise<Work> : undefined; },
    containment: (work, observed) => assessContainment(work, { hostId: current().hostId, observedAt: observed.now, clockOffset: observed.clockOffset, probe: async target => annotatePaneShell(await probeSupervisorAbsence(target, { run }),
      work.find(item => item.key === target.key && item.containmentQuarantine?.epoch === target.epoch), pane => herdrJson(['pane', 'process-info', '--pane', pane], run), undefined, () => herdrJson(['pane', 'list'], run)) }),
    settleContainment: (work, assessment) => mutate(`work/${work.id}/autosettle`, { epoch: assessment.epoch, settlementHash: work.containmentQuarantine!.settlementHash,
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
