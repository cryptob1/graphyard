// Concern: the effects a cycle acts through — their interface and cursor records; the production wiring lives beside it in ./effects-production.ts.
import { wakeOwnObservation } from '../master/base-break-refresh.js';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { type ChildRun, ChildWaitLedger, childRunner } from '../child-runner.js';
import type { Work } from '../model.js';
import type { SessionHandleInput } from '../model/sessions.js';
import { paneAlreadyGone, withPaneGone } from '../request-settlement.js';
import type { MergeWriterSummary } from './cycle-merge-writer.js';
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
import { defaultAwaitReviewers, readDispatchCursor } from '../auto-dispatch.js';
import { relaunchSession } from './relaunch.js';
import { type MasterSessionEffects, masterSessionEffects } from '../master/master-session.js';
import { type WorkerProfile, type HerdrAgent, type ObservedExhaustion, type ProfileAccountHealth, type MasterConfig, agentToken, holdRepeatedLimitAccount, listHerdrAgents, sessionAccount, preservePartialWork, recordObservedExhaustion, closeHerdrPane, inspectProfileAccounts, inspectProducerCredentials, observeHerdrAgents, inspectWorkerCredentials, deliverPrompt, dispatchWork, writeFailure, herdrJson, readCredentialFile, withRoleDefaults, type ControlPlaneStatus, type SessionIdentity } from '../master.js';
import { herdrCall, listHerdrPanes, type HerdrPane } from '../master/herdr.js';
import { httpFleetClient, reconcileFleetSessions, settledRecordSessions } from '../fleet.js';
import { type ContainmentRetention, type DaemonAction, type DaemonState, type LoopRelease, storeAction, type DeploymentObservation, message, writeDaemonState } from './state.js';
import { writeProjectMemory } from '../project-memory.js';
import type { ExhaustedProof } from './rework.js';
import type { daemonSummary } from './run.js';
import { observeDeployment, deploymentEnvironmentName } from './deployment.js';
import { mergeRecordKey, mergeWriterReads, type MergeWriterReads } from './cycle-merge-writer.js';
import { worktreeRoot } from '../install/worktree-root.js';
import type { ReadingEffects } from './reading-effect.js';
import { alignRunningLoopUnit, awaitSupervisorRestart, detectLoopSupervisorUnit, performSelfUpgrade, recoverMovedHead, type SelfUpgradeDeps, type SelfUpgradeOutcome } from './upgrade.js';
import { serverCallName, timedCall, timedFetch, timedRun } from '../master/timings.js';
import type { RunRecord, Runner } from '../runner/types.js';
import { loopRunAdoption, type AdoptedRun } from './run-adoption.js';
import { readMechanicalFixState, type MechanicalFixState } from '../mechanical-findings.js';
export { snapshotRetryDelayMs, retriedSnapshot } from './snapshot-retry.js';

/** A reviewer or producer session a launch ledger holds as pending, as the failover step reads it. */
export interface LaunchedSession { role: 'reviewer' | 'producer'; record: string; profile: string; agentName: string; pane: string | null; work: string; requestId: string | null; /** A producer's proof group: with the item, the session its account was selected for (GY-1582). */ group?: string }
/** A session only says its account is spent once it has stopped; while it works, its output is its own prose. */
export const stoppedStates = ['idle', 'done', 'blocked'];
export const failoverKey = (role: CapacityRole, work: Work, attempt: string | number) => `failover:${role}:${work.id}:${attempt}`;
export const capacityKey = (role: CapacityRole) => `capacity:${role}`;
/** GY-852: paste by pane_id, else name (profiles reuse names across sessions). */
export const promptTarget = (agent: Pick<HerdrAgent, 'name' | 'pane_id'>) => agent.pane_id ?? agent.name ?? '';

export interface DaemonEffects extends ReadingEffects {
  closeSession: (pane: string) => void | Promise<void>;
  dispatch: (work: Work, profile: WorkerProfile, agents: HerdrAgent[], snapshot: { work: Work[]; now: string }) => Promise<unknown>;
  /** An item as the control plane holds it now, read outside any transaction (GY-2151): a containment settlement is judged on this record before it is posted, because the plane lowers the fence against its own record, not the cycle's snapshot. */
  readWork?: (work: Work) => Promise<Work>;
  wakeObservation?: (work: Work) => Promise<unknown>; // GY-710: a prioritized `resync` now (GY-1266) that waits on no tick (GY-1286), for a step refused on a stale observation
  /** GY-1984: the control plane's reconciliation of an item whose lease lapsed with nothing submitted (`POST work/:id/resync`). */
  reclaimLease?: (work: Work) => Promise<unknown>;
  /** Wake the item's own observation; the item once a newer reading is saved, else null (GY-793). */
  observe?: (work: Work, waitMs: number) => Promise<Work | null>;
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
  /** The control-plane merge executor's reads (GY-1524, cycle-merge-writer.ts): git in the coordinator checkout, the leased deploy-key push, the merge-record post and the recorded merger; absent, the executor does not run. */
  mergeWriter?: MergeWriterReads | null;
  /** Publishes `mergeQueue.rerunFailedChecks` to the control plane (GY-516), which accepts and ignores it since the merge writer reruns a trial's failing files itself; sent only on a change. */
  publishMergeSettings?: () => Promise<unknown>;
  /** GY-1416: the loop's setup step, `master setup --apply` beside the cycle at most hourly; it sets derived deployment variables only where the provider adapter applies them in place. */
  selfProvision?: () => Promise<unknown>;
  /**
   * The producer requests the dispatcher has stopped attempting (GY-496), from its cursor: the loop
   * announces each and, a cycle later, applies the rework. Absent, nothing is announced.
   */
  exhaustedProofs?: () => Promise<ExhaustedProof[]>;
  /** The review ledger's planned mechanical fixes (GY-971), one bot round each: each is its round's rework. `answered` names the approvals the ledger settled otherwise (follow-ups filed, a fresh read, a fallback), so the gate's report of a still-owed plan is provisional, never past the ledger's answer (GY-1814). */ mechanicalFixes?: () => Promise<MechanicalFixState & { answered?: { key: string; reviewId: number }[] }>; /** GY-1764: reports the planned fix (or none) the review gate's hold reads. */ recordMechanicalPlan?: (work: Work, plan: { reviewId: number; head: string } | null, answered?: { reviewId: number; head: string }) => Promise<unknown>;
  /**
   * GY-437: between cycles, aligns this checkout with the verified deployed release — fetches the base branch, checks out its tip when the
   * checkout is a clean detached checkout, and, when the diff touches code the loop loads, re-executes the loop through its own supervisor. A loop wired without it keeps cycling exactly as before, on the release it loaded.
   */
  selfUpgrade?: (state: DaemonState, keepAlive?: () => Promise<void>) => Promise<SelfUpgradeOutcome>;
  /** GY-1356: adopts a coordinator HEAD that moved forward from `from` to `to` under the running loop, restarting onto it. */
  recoverHead?: (state: DaemonState, from: string, to: string, keepAlive?: () => Promise<void>) => Promise<SelfUpgradeOutcome>;
  /**
   * GY-437: the release this process loaded, read from its checkout when the effects are built at
   * startup, before anything can move the checkout. The loop records it on the cursor over whatever
   * a previous process left there; a loop wired without it reports none.
   */
  loadedRelease?: LoopRelease | null;
  /** Removes an ended attempt's assignment worktree with `git worktree remove` (never forced); whether one was removed. A loop wired without it removes none. */
  removeWorktree?: (path: string) => Promise<boolean>;
  /** Why the plane cannot record a dispatch's result (its /healthz verdict), or null when it can. */
  planeHealth?: () => Promise<string | null>;
  /** Returns one head to a worker with the master's own operator-agent identity (`POST work/:id/rework`); absent, the loop applies no rework. */
  rework?: (work: Work, reason: string, binding?: string) => Promise<unknown>;
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
  /** Tells the process supervisor the loop is alive, so a hung cycle becomes a restart. */
  notify?: (state: 'ready' | 'alive') => void | Promise<void>;
  /**
   * Mid-session capacity (GY-89). `sessionOutput` reads the tail of a stopped session's own
   * terminal, which is where a runtime says its provider account is spent; `reportCapacity`
   * records what the loop observed on the item. A loop wired without the two never fails a
   * session over and never escalates capacity: it cycles exactly as it did before.
   */
  sessionOutput?: (agent: HerdrAgent, lines?: number) => string | null | Promise<string | null>;
  /**
   * A blocked session's runtime prompt (GY-197). `answerSession` sends the keys that choose the prompt's
   * non-destructive answer into the session's pane; `promptSession` then gives it the one instruction to carry on
   * with a safe alternative. Without them a prompt is never answered, and the attempt fails after `blockedPromptFailMs`.
   */
  answerSession?: (agent: HerdrAgent, keys: string[]) => void | Promise<void>;
  promptSession?: (agent: HerdrAgent, text: string) => void | Promise<void>;
  reportCapacity?: (work: Work, event: Record<string, unknown>) => Promise<Work>;
  adoptRuns?: () => Promise<AdoptedRun[]>; // the headless runs a restart left running (GY-453, run-adoption.ts); unwired adopts nothing
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
  /** Account health of the reviewer and producer profiles, as the worker profiles' arrives in `credentials`. */
  roleHealth?: () => Promise<Partial<Record<'reviewer' | 'producer', { profiles: { name: string }[]; health: Record<string, { available: boolean; reason: string | null; accounts?: ProfileAccountHealth[] }> }>>>;
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
   * reached reports no sessions, so nothing is concluded from an inventory that says it is unavailable.
   */
  herdr?: () => { agents: HerdrAgent[]; available: boolean } | Promise<{ agents: HerdrAgent[]; available: boolean }>;
  /**
   * Milliseconds this process spent waiting on child processes since the previous call — the
   * runner's ledger (child-runner.ts), drained at each step boundary so every step of the cycle
   * reports its own `childWaitMs`. A loop wired without it reports every step as its own work.
   */
  childWaits?: () => number;
  /**
   * Records a launched session's durable handle on the item: the runtime, host, Herdr coordinates
   * and transcript a human attaches to it with. A loop configured without it keeps
   * cycling; the sessions it launches are then only visible in this host's own local ledgers,
   * which is the relaying the handle exists to end.
   */
  recordSession?: (work: Work, handle: SessionHandleInput) => Promise<unknown>;
  credentials: (profiles: WorkerProfile[]) => Promise<Record<string, { available: boolean; reason: string | null; accounts?: ProfileAccountHealth[] }>>;
  /**
   * The coordination read. `jobs` are the control plane's integration jobs with their last error.
   */
  snapshot: () => Promise<{ work: Work[]; now: string; jobs?: { work_id?: string; error?: string | null }[] }>;
  /**
   * Pull-request-era review threads a standing approval named as follow-up (GY-166); nothing reads
   * them since GY-2010 (effects-production.ts still supplies the read).
   */
  followUpThreads?: (work: Work[], now: number) => Promise<Map<string, Set<string>>>;
  persist: (state: DaemonState) => Promise<void>;
  masterSession?: MasterSessionEffects; // the loop's own master session (GY-898); absent, none is launched, woken or rotated
}

/** How long a refusal on the review findings stands before the loop reads the findings again. */
export const findingRecheckMs = 120_000;
/** How long after its claim a launched session is given to appear in Herdr before its absence means anything. */
export const launchAppearanceMs = 120_000;
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

