// Concern: the production wiring of the cycle's effects — every read, launch, write and reclaim the loop runs, bound to one coordinator process.
import { wakeOwnObservation } from '../master/base-break-refresh.js';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { worktreeReclaimPass } from './worktree-reclaim.js';
import { type ChildRun, ChildWaitLedger, childRunner } from '../child-runner.js';
import type { Work } from '../model.js';
import type { DecisionSituation } from '../model/approval.js';
import { loopBlockerProbe, type BlockerClassification, type BlockerProbeRecord, type BlockerProbeResult } from './blocker-probes.js';
import type { SessionHandleInput } from '../model/sessions.js';
import { paneAlreadyGone, withPaneGone } from '../request-settlement.js';
import { type HostMemoryReading, type ResourceReclaimReport, disposableWorktrees, reclaimResources, dispatchRefusal, readHostMemory } from '../master-resources.js';
import { RefusedResponse } from '../model/refusal.js';
import { rerunFailedChecks } from '../master/profiles.js';
import type { CapacityRole, PartialWork } from '../model/capacity.js';
import { readProducerLedger, saveProducerLedger, launchProducer } from '../producer.js';
import { followUpThreadIds, readReviewLedger, updateReviewLedger, launchReview } from '../reviewer.js';
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
import { type OrphanSupervisor, stopWatchSupervisor } from './sessions.js';
import { neededDecision, type ExhaustedProof, type RoutineDecisionAction } from './decisions.js';
import { decisionEventKinds } from './decision-reads.js';
import type { FaultClassPolicy, FaultKind } from '../model/fault-classes.js';
import type { daemonSummary } from './run.js';
import { observeDeployment, deploymentEnvironmentName } from './deployment.js';
import { mainWatchReads, type MainWatchReads } from './main-watch.js';
import { mergeRecordKey, mergeWriterReads, type MergeWriterReads } from './cycle-merge-writer.js';
import { worktreeRoot } from '../install/worktree-root.js';
import { throughputEffects, type ThroughputEffects } from './throughput-effect.js';
import { readingEffects } from './reading-effect.js';
import { alignRunningLoopUnit, awaitSupervisorRestart, detectLoopSupervisorUnit, performSelfUpgrade, recoverMovedHead, type SelfUpgradeDeps, type SelfUpgradeOutcome } from './upgrade.js';
import { loopCodeRoot } from './checkout-state.js';
import { readRelease } from '../protocol-version.js';
import { serverCallName, timedCall, timedFetch, timedRun } from '../master/timings.js';
import type { RunRecord, Runner } from '../runner/types.js';
import { loopRunAdoption, type AdoptedRun } from './run-adoption.js';
import type { ResearchEvent } from '../research.js';
import type { DecompositionEvent } from '../decomposition.js';
import { doctorEffects, doctorSettings, type DoctorEffects } from './doctor.js';
import { docsSyncEffects, type DocsSyncEffects } from '../docs-sync.js';
import { acceptanceEffects, type AcceptanceEffects } from './acceptance.js';
import { plannerEffects, type PlannerEffects } from './planner.js';
import type { TriageJudgement } from '../model/machine-backlog.js';
import { answeredMechanicalReviews } from './mechanical-plan-report.js';
import { mechanicalFixState, readMechanicalFixState } from '../mechanical-findings.js';
import { retriedSnapshot } from './snapshot-retry.js';
import { promptTarget, refusedBodyDetail, type DaemonEffects } from './effects.js';

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
  const snapshot = async () => { await (await import('../master/environments.js')).reportPendingExhaustions(current(), { fetch: fetcher }).catch(() => {}); return timedCall('server', 'GET work-snapshot', deps.snapshot); }; // resending first any account hold the agent registry has not heard of (GY-1573)
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
    const text = await response.text(); // GY-1751: a proxy's empty or HTML 502-504 keeps its status
    let result: any; try { result = JSON.parse(text); } catch { result = response.ok ? undefined : { text: text.slice(0, 200) }; }
    // The body is kept on the error: a decision refusal names the standing refused decision as a field (GY-265).
    // GY-1713: the message carries error and zod issues so diagnosis/doctor attention names the field.
    if (!response.ok) throw new RefusedResponse(`Graphyard refused ${path} (${response.status}): ${refusedBodyDetail(result)}`, response.status, result);
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
    // The status travels with the refusal, so a caller can tell a 404 from any other refusal.
    if (!response.ok) throw new RefusedResponse(`Graphyard refused ${path} (${response.status}): ${result?.error ?? JSON.stringify(result)}`, response.status, result);
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
  const approver: DaemonEffects['approver'] = async (work, decision) => { const launched = await launchApprover(root, work, decision, undefined, await observeHerdrAgents(run), run, {}, handle => mutate(`work/${work.id}/session`, handle)); return { agentName: launched.agentName, pane: launched.pane, account: launched.account?.environment ?? null, runtime: launched.runtime, session: launched.session, run: launched.run, settled: launched.settled, ...(launched.replaced ? { replaced: launched.replaced } : {}) }; };
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
  let publishedEnvironment: string | null = null, publishedMergeQueue: string | null = null;
  /** GY-1524: the recorded merger, read from /api/status afresh for every merge decision (AC-6), never cached: a switch to `github` stops the next merge, not the one after a window. */
  // The control plane is the only merge writer.
  const recordedMerger = async () => 'control-plane' as const;
  /** GY-1927: the automatic-merging hold over one item, read from the plane afresh before the writer opens a merge and before it pushes; a plane without the route (404) records no hold, and any other failure stops the merge. */
  const recordedHold = async (work: { id: string }) => {
    try { return ((await asCoordinator(`auto-merge?work=${encodeURIComponent(work.id)}`)) as { hold?: string | null }).hold ?? null; }
    catch (error) { if (error instanceof RefusedResponse && error.status === 404) return null; throw error; }
  };
  // The shared project memory (GY-1125) is mirrored to its own file only when it changed.
  let writtenMemory: string | null = null;
  const persistLoop = async (state: DaemonState) => {
    const memory = state.projectMemory ? JSON.stringify(state.projectMemory) : null;
    if (memory && memory !== writtenMemory) await writeProjectMemory(root, state.projectMemory).then(() => { writtenMemory = memory; }, () => {});
    return writeDaemonState(current(), state);
  };
  const upgradeDeps = (keepAlive?: () => Promise<void>): SelfUpgradeDeps => ({ root, run, // shared with the moved-HEAD recovery (GY-1356)
    restartSelf: async () => {
      const unit = detectLoopSupervisorUnit();
      if (!unit) throw new Error('this loop runs under no graphyard-master supervisor unit, so it cannot re-execute itself; run it under the packaged unit (examples/master/graphyard-master.service), or restart it by hand with systemctl --user restart graphyard-master');
      // --no-block queues the restart; systemd's stop then ends this wait, and reaches this process too (upgrade.ts restartEndedBySupervisorStop).
      await awaitSupervisorRestart(() => run('systemctl', ['--user', '--no-block', 'restart', unit]));
    },
    alignUnit: () => alignRunningLoopUnit(root, current()),
    persist: persistLoop,
    // GY-1982: continuous deploy, through the install's own adapter; imported when first used, as the CLI's upgrade module loads the installer.
    // GY-2167: the deploy's e2e cases authenticate as the install's own e2e identity, read from its
    // roster token file inside deployPorts — never with this loop's coordinator credential, whose
    // principal may create no item and whose use failed every create-step case with 403.
    deploy: async () => (await import('../cli/upgrade.js')).deployPorts({ cliRoot: loopCodeRoot(current().cliPath, root), repoRoot: root, repository: current().repository, url: current().url, run, keepAlive }),
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
    sessionOutput: async (agent, lines = 60) => { const target = agent.name ?? agent.pane_id; return target ? herdrCall(run, ['agent', 'read', target, '--source', 'recent-unwrapped', '--lines', String(lines), '--format', 'text']) : null; },
    // The decline is typed into the pane and given a moment to close the dialog, so the instruction
    // that follows lands in the runtime's input rather than in the closing menu.
    answerSession: async (agent, keys) => { await herdrCall(run, ['pane', 'send-keys', agent.pane_id!, ...keys]); await delay(2_000); },
    promptSession: async (agent, text) => { await deliverPrompt(promptTarget(agent), text, run); },
    reportCapacity: (work, event) => mutate(`work/${work.id}/capacity`, event), blockDispatch: (work, reason) => mutate(`work/${work.id}/dispatchblock`, { reason }),
    recordResearch: (work, event) => mutate(`work/${work.id}/research`, event), recordDecomposition: (work, event) => mutate(`work/${work.id}/decomposition`, event),
    research: { cwd: root }, harness: { servingUnit: detectLoopSupervisorUnit() },
    adoptRuns: loopRunAdoption(root, current, deps.fetcher),
    recordTriage: (work, body) => mutate(`work/${work.id}/triage`, body),
    withdrawTriage: (work, body) => mutate(`work/${work.id}/triage`, { withdraw: body }),
    launchedSessions: async () => [
      ...(await readReviewLedger(root)).reviews.filter(entry => entry.state === 'pending' && !entry.launching).map(entry => ({ role: 'reviewer' as const, record: entry.id, profile: entry.profile, agentName: entry.agentName, pane: entry.pane, work: entry.key, requestId: entry.requestId ?? null })),
      ...(await readProducerLedger(root)).producers.filter(entry => entry.state === 'pending').map(entry => ({ role: 'producer' as const, record: entry.id, profile: entry.profile, agentName: entry.agentName, pane: entry.pane, work: entry.key, requestId: entry.requestId, group: entry.group })),
    ],
    selectedAccount: (role, profile, session) => sessionAccount(root, current(), role, profile, session), // by the session's own identity (GY-1582)
    preserveWork: async (work, epoch, cause = 'interrupted by provider quota exhaustion') => {
      const workspace = work.workspaces.find(entry => entry.epoch === epoch);
      if (!workspace || workspace.host !== current().hostId) return { state: 'not-applicable', detail: workspace ? `the attempt worktree is on ${workspace.host}, not this host; its commits stay on ${workspace.branch}` : 'the attempt registered no workspace' };
      return preservePartialWork(workspace.path, `${work.key} attempt ${epoch} ${cause}`, run);
    },
    holdAccount: (account, observed) => recordObservedExhaustion(current(), account, observed, undefined, { fetch: fetcher }),
    endSession: async (session, resolution) => {
      // A pane that is already gone is closed (GY-137): the record still settles, and says so.
      let paneGone = false;
      try { if (session.pane) await closeHerdrPane(session.pane, run); } catch (error) { if (!paneAlreadyGone(error)) throw error; paneGone = true; }
      const closedAt = new Date().toISOString(), ended = { state: 'failed' as const, resolution: paneGone ? withPaneGone(resolution, session.pane!, 500) : resolution.slice(0, 500), closedAt };
      if (session.role === 'reviewer') await updateReviewLedger(root, ledger => { ledger.reviews = ledger.reviews.map(entry => entry.id === session.record && entry.state === 'pending' ? { ...entry, ...ended } : entry); });
      else { const ledger = await readProducerLedger(root); await saveProducerLedger(root, { ...ledger, producers: ledger.producers.map(entry => entry.id === session.record && entry.state === 'pending' ? { ...entry, ...ended } : entry) }); }
    },
    relaunch: async (session, work, snapshot) => {
      // launchReview/launchProducer also re-hold before selectAccount (GY-1705); this call keeps the
      // failover path refusing early when the durable hold cannot be written, before a pane starts.
      const holdAt = Date.now();
      await holdRepeatedLimitAccount(current(), work, holdAt, { fetch: fetcher }, session.role).catch((error: unknown) => {
        throw new Error(`${work.key}'s last ${session.role} sessions each ended on one account's limit notice, and the hold that keeps the next launch off it could not be placed: ${message(error).slice(0, 300)}; nothing was relaunched`, { cause: error });
      });
      return relaunchSession(current(), session, work, await listHerdrAgents(run), {
        review: (profile, request, agents) => launchReview(root, work, profile.name, agents, snapshot.now, { run, requestId: request.id }),
        producer: (profile, request, agents) => launchProducer(root, work, request, profile, agents, snapshot.now, { run }),
        record: handle => mutate(`work/${work.id}/session`, handle),
      });
    },
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
    worktreeReclaimable: (work, at) => disposableWorktrees(root, current(), { work, now: at }),
    reclaimResources: (work, agents) => reclaimResources(root, withRoleDefaults(current()), { work, agents }, { closePane: pane => closeHerdrPane(pane, run) }),
    planeHealth: () => dispatchRefusal(current().url, fetcher),
    hostMemory: readHostMemory,
    probeBlocker: (work, classification) => loopBlockerProbe(current(), root, run, () => dispatchRefusal(current().url, fetcher))(work, classification), recordBlockerProbe: (work, body) => mutate(`work/${work.id}/blocker-probe`, body) as Promise<Work>,
    deferWindow: (work, body) => mutate(`work/${work.id}/window`, body) as Promise<Work>,
    closeWork: (work, body, key) => mutate(`work/${work.id}/close`, body, key) as Promise<Work>,
    dispatch: (work, profile, agents, snapshot) => dispatchWork(root, work, profile, agents, run, snapshot.work, undefined, undefined, undefined, snapshot.now, { agents: () => listHerdrAgents(run) }),
    recordSession: (work, handle) => mutate(`work/${work.id}/session`, handle),
    wakeObservation: work => mutate(`work/${work.id}/resync`, { prioritized: true, wait: false }),
    reclaimLease: work => mutate(`work/${work.id}/resync`, {}, randomUUID()),
    observe: (work, waitMs) => wakeOwnObservation(body => mutate(`work/${work.id}/resync`, { ...body, prioritized: true }, randomUUID()), ms => delay(ms), { waitMs }),
    get withdrawReview() {
      // GY-2078: a change request is withdrawn in the control plane's own review record; no GitHub request is made.
      return (work: Work, reviewId: number, message: string) =>
        mutate(`work/${work.id}/review-withdraw`, { reviewId, reason: message.slice(0, 7000) }, randomUUID()).then(() => {});
    },
    requestProof: async work => {
      const config = current();
      await run('gh', ['workflow', 'run', config.run.proofWorkflow!, '--repo', config.repository, '--ref', config.baseBranch,
        '-f', `pr=${work.submission!.pr}`, '-f', `work_id=${work.id}`, '-f', `policy_revision=${work.policyRevision}`]);
    },
    // `root` is this checkout: containment is derived from its object store, never from the forge.
    observeDeployment: (delivered, retained) => observeDeployment(current(), delivered, run, fetcher, () => Date.now(), { root, retained }),
    // GY-1519: the watch reads history from this checkout and its policy from the control plane.
    get mainWatch() { return mainWatchReads(current(), root, run, { policy: () => asCoordinator('main-watch') }); },
    // GY-1524: the executor merges in this checkout's object store, pushes with the install's deploy key alone, records each step as the coordinator under one key per (step, commits), and acts only while the recorded merger is control-plane (read before every merge decision).
    get mergeWriter() { const config = current(); return mergeWriterReads(config, root, run, { base: worktreeRoot(root, config), record: (work, event) => mutate(`work/${work.id}/merge-record`, event, mergeRecordKey(work, event)), merger: recordedMerger, hold: recordedHold }); },
    publishProductionEnvironment: async () => {
      const environment = deploymentEnvironmentName(current(), root);
      if (environment === publishedEnvironment) return;
      await mutate('production-environment', { environment });
      publishedEnvironment = environment;
    },
    // Imported when first run: only this step reads the install modules. Each run also registers the merge
    // writer's deploy key when it is missing (setupRenewingDeployKey; soaked in tests/soak-deploy-key-renewal.test.ts).
    selfProvision: async () => {
      const [{ loopSelfProvision, setupRenewingDeployKey }, { hostCredentialPorts }] = await Promise.all([import('../cli/master-setup.js'), import('./step-stalls.js')]);
      const config = current();
      return loopSelfProvision(root, config, { setup: setupRenewingDeployKey(() => hostCredentialPorts(config, root).renewDeployKey()) });
    },
    publishMergeSettings: async () => {
      const config = { rerunFailedChecks: rerunFailedChecks(current()) };
      const published = JSON.stringify(config);
      if (published === publishedMergeQueue) return;
      await mutate('merge-queue', config);
      publishedMergeQueue = published;
    },
    ...throughputEffects(root, current, run, asCoordinator), ...readingEffects(current, mutate, asCoordinator), // GY-1779: the loop's own post-deploy readings
    readThroughputOwner: async owner => await asCoordinator(`work/${encodeURIComponent(owner.id)}`) as Work,
    readWork: async work => await asCoordinator(`work/${encodeURIComponent(work.id)}`) as Work,
    recordDeployment: (work, observation) => mutate(`work/${work.id}/deployment`, { sha: observation.sha, mergeSha: work.delivery!.mergeSha, source: observation.source, observedAt: observation.observedAt }),
    exhaustedProofs: async () => Object.entries((await readDispatchCursor(root, current(), () => {})).abandoned).filter(([, entry]) => entry.kind === 'producer')
      .map(([requestId, entry]) => ({ requestId, work: entry.work, sha: entry.sha, group: entry.group ?? null, proofs: entry.proofs ?? [], attempts: entry.attempts, reason: entry.reason })),
    // GY-1814: the read also names the approvals the ledger answered (planned, follow-ups filed, a fresh read, a fallback), so a plan still owed is reported only until the answer lands. A ledger that cannot be read answers everything: the requests-only read carries no `answered`, and the gate never holds what nothing backs.
    mechanicalFixes: async () => { try { const reviews = (await readReviewLedger(root)).reviews; return { ...mechanicalFixState(reviews), answered: answeredMechanicalReviews(reviews) }; } catch { return readMechanicalFixState(root); } }, recordMechanicalPlan: (work, plan, answered) => mutate(`work/${work.id}/mechanicalplan`, plan ? { ...plan, planned: true } : { reviewId: answered?.reviewId ?? work.mechanicalPlan?.reviewId ?? 1, head: answered?.head ?? work.mechanicalPlan?.head ?? work.candidate!.sha, planned: false }),
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
    reclaim: (work, now) => worktreeReclaimPass(root, current(), run, work, now),
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
    reportedAttention: async (work: Work[], coordinator: ControlPlaneStatus & Record<string, unknown>, observed: { agents: HerdrAgent[]; available?: boolean; approvals: ReturnType<typeof daemonSummary>['approvals']; loop: ReturnType<typeof daemonSummary>['liveness']; now: string; mergeWriter?: ReturnType<typeof daemonSummary>['mergeWriter'] | null }) => {
      // Imported when first read: the status report imports this module, so a static import would be a cycle.
      const reported = await (await import('../cli/master-status.js')).reportedAttention(root, withRoleDefaults(current()), asCoordinator, coordinator, { work, now: observed.now }, { reviews: (await readReviewLedger(root)).reviews, producers: (await readProducerLedger(root)).producers,
        runtime: { available: observed.available ?? true, agents: observed.agents }, commit: null, approvals: observed.approvals, loop: observed.loop, standalone: true,
        // GY-2015: the loop's own writer summary rides the same observed, so its fault step counts a held trial refusal as the writer's motion.
        mergeWriter: observed.mergeWriter ?? null,
        // The intervention report takes the server close to a minute (GY-377): the cycle uses the
        // cached copy and refreshes it detached from itself, which is also the copy master status reads.
        reports: 'background', reportBoundMs: deps.reportReadBoundMs });
      // No check-run annotation is read back (GY-2010): stored checks are pull-request-era history.
      return reported;
    },
    // GY-1535: under a control-plane merger (read afresh before each draft) the draft is committed here and landed by the merge writer's reads, with no pull request.
    get acceptance() { const config = current(); return config.operatorAgent && config.approver ? acceptanceEffects(config, root, { run, fetcher, asCoordinator, asOperatorAgent, merger: recordedMerger,
      writer: mergeWriterReads(config, root, run, { base: worktreeRoot(root, config), record: (work, event) => mutate(`work/${work.id}/merge-record`, event, mergeRecordKey(work, event)), merger: recordedMerger, hold: recordedHold }) }) : undefined; },
    get planner() { const config = current(); return config.operatorAgent && config.approver ? plannerEffects(config, root, { fetcher, asCoordinator, asOperatorAgent }) : undefined; },
    get unblock() { return current().operatorAgent ? (work: Work, reason: string) => asOperatorAgent('POST', `work/${work.id}/unblock`, { reason, expectedRevision: work.revision }) as Promise<Work> : undefined; },
    get doctor() { const config = current(); return config.operatorAgent && doctorSettings(config.run).enabled ? doctorEffects(config, root, asOperatorAgent) : undefined; },
    controlPlaneClock: () => readControlPlaneClock(current().url, { fetcher }),
    containment: (work, observed) => assessContainment(work, { hostId: current().hostId, observedAt: observed.now, clockOffset: observed.clockOffset, clockRoundTripMs: observed.clockRoundTripMs, clockSource: observed.clockSource, probe: async target => annotatePaneShell(await probeSupervisorAbsence(target, { run }),
      work.find(item => item.key === target.key && item.containmentQuarantine?.epoch === target.epoch), pane => herdrJson(['pane', 'process-info', '--pane', pane], run), undefined, () => herdrJson(['pane', 'list'], run),
      () => herdrJson(['status', 'server', '--json'], run)) }),
    settleContainment: (work, assessment) => mutate(`work/${work.id}/autosettle`, { epoch: assessment.epoch, settlementHash: work.containmentQuarantine!.settlementHash,
      reason: `The master loop verified on ${assessment.host ?? current().hostId} that the supervisor of epoch ${assessment.epoch} is gone; the item is released for a fresh attempt`, verification: assessment.verification, origin: 'loop' }),
    // systemd-notify keep-alive (NOTIFY_SOCKET; NotifyAccess=all; bounded child via `run`). GY-437: upgrade between cycles, re-exec under the cgroup unit.
    // GY-1899: the release the loop records is the checkout its loaded code comes from — the one
    // the running CLI starts from, read once at process startup — never the managed repository's
    // root, whose HEAD names the managed project. A later move of that checkout is a moved head
    // (GY-1464), still judged between cycles; the startup reading stays what this process loaded.
    loadedRelease: readRelease(loopCodeRoot(current().cliPath, root)),
    selfUpgrade: (state, keepAlive) => performSelfUpgrade(current(), state, upgradeDeps(keepAlive)),
    recoverHead: (state, from, to, keepAlive) => recoverMovedHead(current(), state, from, to, upgradeDeps(keepAlive)),
    notify: async state => { await run('systemd-notify', state === 'ready' ? ['--ready'] : ['WATCHDOG=1']); },
    masterSession: masterSessionEffects(root, current, run),
    persist: persistLoop,
  }, {});
}
