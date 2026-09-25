// Concern: the effects a cycle acts through — their interface, cursor records, and the production wiring.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { productionEnvironmentFromEnv } from '../flow-analytics.js';
import { type ChildRun, ChildWaitLedger, childRunner } from '../child-runner.js';
import type { Work } from '../model.js';
import type { ScopeRequestState } from '../model/scope.js';
import type { SessionHandleInput } from '../model/sessions.js';
import { paneAlreadyGone, withPaneGone } from '../request-settlement.js';
import { type ResourceReclaimReport, reclaimResources, dispatchRefusal } from '../master-resources.js';
import type { CapacityRole, PartialWork } from '../model/capacity.js';
import { readProducerLedger, saveProducerLedger, independentProducerProfiles, launchProducer, reclaimCheckouts } from '../producer.js';
import { followUpThreadIds, readReviewLedger, updateReviewLedger, launchReview } from '../reviewer.js';
import { type ReviewFinding, readReviewFindings, basePaths } from '../review-scope.js';
import { defaultAwaitReviewers } from '../auto-dispatch.js';
import { type WorkerProfile, type HerdrAgent, type WorktreeReclaimReport, type ContainmentAssessment, type ObservedExhaustion, type ProfileAccountHealth, type MasterConfig, type MergeExecutor, agentToken, decisionInput, launchApprover, listHerdrAgents, readEnvironmentLog, selectionKey, preservePartialWork, recordObservedExhaustion, closeHerdrPane, inspectProfileAccounts, inspectProducerCredentials, observeHerdrAgents, inspectWorkerCredentials, dispatchWork, mergeExecutor, reclaimWorktrees, reclaimIdleMs, writeFailure, assessContainment } from '../master.js';
import { probeSupervisorAbsence } from '../containment-probe.js';
import { clampCount, type ContainmentRetention, type DaemonAction, daemonActionSchema, type DaemonState, type DeploymentObservation, message, writeDaemonState } from './state.js';
import { answeringWidening } from './reconcile.js';
import { type OrphanSupervisor, readyToRetry, stopWatchSupervisor } from './sessions.js';
import { boundDetail, neededDecision, type RoutineDecisionAction } from './decisions.js';
import { observeDeployment } from './deployment.js';

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
  decisions?: (work: Work) => Promise<{ decisions: { id: string; action: string; state: string; input: any; pin?: { escalations?: { trigger: string; at: string }[] } | null; reason?: string; precedent?: string[]; approvedBy: string | null; approvedAt?: string | null; approvalReason?: string | null; outcome?: string | null; refusal?: { approver: string; reason: string; at?: string } | null }[] }>;
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
  /**
   * The review threads, per item key, that a standing approval named as follow-up (GY-166), or that
   * an approval of `work`'s current head was shown while the dispatcher has yet to file its
   * follow-ups. The review loop files and resolves them, so the cycle requests no thread rework for them.
   */
  followUpThreads?: (work: Work[], now: number) => Promise<Map<string, Set<string>>>;
  persist: (state: DaemonState) => Promise<void>;
}

/**
 * Put an action on the cursor. The detail is bounded here, before the schema sees it, so a caller
 * that quotes a long error or path list cannot fail every cycle with an over-long string (GY-179).
 */
export async function record(state: DaemonState, key: string, action: Omit<DaemonAction, 'at' | 'epoch'> & { at?: string; epoch?: number | null }, now: number, persist: DaemonEffects['persist']) {
  const entry = daemonActionSchema.parse({ ...action, detail: boundDetail(action.detail), attempts: clampCount(action.attempts, 1000), at: action.at ?? new Date(now).toISOString() });
  state.actions[key] = entry; await persist(state);
  return entry;
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
  const asOperatorAgent = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const config = current();
    if (!config.operatorAgent) throw new Error('No master operator-agent identity is provisioned; run graphyard master autonomy --admin-token-stdin --apply so the loop can request routine decisions');
    const token = await agentToken(root, config, 'operatorAgent');
    const response = await fetcher(`${config.url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status}): ${result?.error ?? JSON.stringify(result)}`);
    return result;
  };
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
    followUpThreads: async (work, at) => {
      const reviewer = current().reviewer;
      return followUpThreadIds((await readReviewLedger(root)).reviews, work, reviewer ? { reviewer: `${reviewer.slug}[bot]`, now: at } : undefined);
    },
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
