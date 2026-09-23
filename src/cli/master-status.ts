import { randomUUID } from 'node:crypto';
import { probeCandidateConflicts } from '../conflicts.js';
import { agentOwner, agentToken, assessContainment, branchReport, broadScopeFlag, buildMasterStatus, guardBroadScope, diskPressure, diskPressureAttention, diskThresholdBytes, freeBytes, humanOwner, inspectWorkerCredentials, installationOwner, inventoryWorktrees, managedRootStatus, mergeProtocolSkew, observeHerdrAgents, planWorktreeReclaim, profileConcurrency, reclaimIdleMs, snapshotWithClock, worktreesDirectory, type AttentionItem, type MasterConfig } from '../master.js';
import { generatedFilesAssignment, generatedFilesDrift, generatedFilesVariable, generatedManifestScript } from '../install/generated-files.js';
import type { Work } from '../model.js';
import { actionReport, agentRequestAttention, agentRequestReport, sessionReport } from './loop-report.js';
import { executorFleet } from './executor-report.js';
import { owedAttention, needsHumanActions, scopeRequestAttention } from './owed-report.js';
import { daemonSummary, loopAttention, readDaemonState, type CycleMetrics, type DaemonState } from '../master-daemon.js';
import { readReviewLedger, reconcileReviews, summarizeReviews } from '../reviewer.js';
import { readProducerLedger, reconcileProducers, sessionRetries, summarizeProducers } from '../producer.js';
import { dispatchFailureAttention, dispatchSummary, readDispatchCursor } from '../auto-dispatch.js';
import { actionlessItems, stallBoundMs } from '../model/action-account.js';
import { nameOrphanSupervisors, stalledItemAttention } from './status-attention.js';
import { nameUnobtainableReviews, type SettledReviewSession } from '../model/dispatch.js';
import { unansweredRequestAttention, unobtainableReviewAttention } from './unanswered-requests.js';
import { readAdministrationLedger, readSudoState, summarizeAdministration } from '../master-browser.js';
import { stalledActionAttention } from './stalled-actions.js';
import { overlongSessionAttention } from './overlong-sessions.js';
import { ghCheckAnnotations, qualifyTimingFailures } from './timing-failures.js';
import { setupHealth } from './master-setup.js';
import { consentHoldItems } from './consent-holds.js';
import { stuckRequestReport, withStuckRequests } from './stuck-requests.js';
import { nameUnresolvedThreads } from '../merge-queue.js';
import { contextOverflows } from '../model/escalation-context.js';
import type { LoopSupervisorHost } from '../supervisor.js';
import { terminalDecisions } from './decision-report.js';

export { actionReport, agentRequestAttention, agentRequestReport, sessionReport } from './loop-report.js';
// The attention builders live beside each other in `status-attention.ts`; the report reads them
// from here, as does everything that was reading them from here before the split.
export { nameOrphanSupervisors, orphanSupervisorAttention, stalledItemAttention, supervisorReclaimCommand } from './status-attention.js';
export { humanNeededAttention, needsHumanActions, scopeRequestAttention } from './owed-report.js';
export { stalledActionAttention } from './stalled-actions.js';
export { overlongSessionAttention } from './overlong-sessions.js';
export { unansweredRequestAttention, unansweredRequestOwner, unobtainableReviewAttention } from './unanswered-requests.js';

/**
 * One attention item per requested decision whose approver could not be launched (GY-101). A
 * decision changes nothing until a session judges it, and a launch the runtime refuses — for a
 * name it will not take, a credential it cannot read, a workspace that is gone — leaves the watch
 * standing with a session that never started. `master status` used to show that as a decision
 * "waiting for approver session NAME to judge it", naming a session nobody could find. It is
 * named here as what it is, with the loop's own refusal and the command that launches it again.
 */
export function approverLaunchAttention(daemon: {
  approvals?: { key: string; work: string; action: string; decision: string; agentName: string | null; launches: number; launchedAt: string | null; requestedAt: string; settledAt: string | null }[];
  actions?: { key: string; kind: string; state: string; detail: string; at: string }[];
}): AttentionItem[] {
  const actions = daemon.actions ?? [];
  return (daemon.approvals ?? []).flatMap(watch => {
    if (watch.settledAt) return [];
    // The loop records a refused launch under the decision it was requested for (the request that
    // could not reach an approver) or under that launch's own key (a replacement that could not).
    const since = Date.parse(watch.launchedAt ?? watch.requestedAt);
    const refusal = actions.find(action => action.state === 'failed' && action.kind === 'decision'
      && (action.key === watch.key || action.key.startsWith(`approver:${watch.decision}:launch:`))
      && (!Number.isFinite(since) || Date.parse(action.at) >= since));
    return refusal ? [{ subject: watch.work, text: `${watch.work} is awaiting an approver for ${watch.action} decision ${watch.decision} that could not start${watch.agentName ? ` as ${watch.agentName}` : ''}: ${refusal.detail}`,
      ...agentOwner('master', `graphyard master approver ${watch.work} ${watch.decision} [AGENT_KIND]`, 'approver') }] : [];
  });
}

/**
 * The `master status` report: Graphyard work truth joined with Herdr session health, the local
 * review, producer, dispatch, daemon and administration ledgers, the dispatch schedule with its
 * overlap holds, and the conflict set of every open candidate probed over the fetched PR heads.
 */
export async function masterStatusReport(root: string, master: MasterConfig, masterApi: (path: string) => Promise<any>, coordinator: any, cli: { commit: string | null }, dependencies: { supervisorHost?: LoopSupervisorHost } = {}) {
  const runtime = await observeHerdrAgents();
  const credentials = await inspectWorkerCredentials(root, master.workers);
  let reviewRecords = (await readReviewLedger(root)).reviews, reviewRuntime = { available: true, reason: null as string | null };
  const { snapshot, clockOffset } = await snapshotWithClock(() => masterApi('work-snapshot'));
  // Sessions the automatic dispatcher launched are settled against this same snapshot: a
  // head change cancels them here as well as in the loop, so status never shows a stale one.
  try { reviewRecords = (await reconcileReviews(root, master, { work: snapshot.work, agents: runtime.available ? runtime.agents : null })).reviews; }
  catch (error) { reviewRuntime = { available: false, reason: `Reviewer verdicts could not be reconciled with GitHub: ${error instanceof Error ? error.message : 'unknown reason'}` }; }
  let producerRecords = (await readProducerLedger(root)).producers;
  try { producerRecords = (await reconcileProducers(root, master, snapshot.work, runtime.available ? runtime.agents : null)).producers; } catch { /* the ledger as last written stands */ }
  const reviews = summarizeReviews(reviewRecords), producers = summarizeProducers(producerRecords);
  // Every request whose last session failed or expired, with its attempts and the next relaunch.
  const retries = [...sessionRetries(reviewRecords, Date.now()), ...sessionRetries(producerRecords, Date.now())];
  // Setup that silently stops every launch, and the loop's supervision (GY-114), read from the host.
  const { setup, attention: setupItems } = await setupHealth(root, master, dependencies.supervisorHost);
  // Status reads the cursor as the loop would, repairing an over-long string in memory; the loop
  // is what logs and persists that repair, so status reports the cursor rather than announcing it.
  const dispatchCursor = await readDispatchCursor(root, master, () => {}).catch(error => ({ error: error instanceof Error ? error.message : 'Master dispatch cursor is unreadable' }));
  const stuck = stuckRequestReport({ reviews: reviewRecords, producers: producerRecords }, Date.now());
  const dispatch = 'error' in dispatchCursor ? { running: false, failures: [] as { requestId: string; kind: string; attempts: number; reason: string; at: string; nextAt: string }[], error: dispatchCursor.error } : withStuckRequests(dispatchSummary(dispatchCursor, Date.now(), master.run.dispatchIntervalSeconds * 1000), stuck.stuck);
  // A dispatcher that keeps failing its tick launches nothing for any item; it is named before the requests it is not launching.
  const dispatchItems = dispatchFailureAttention(dispatch);
  const containment = await assessContainment(snapshot.work, { hostId: master.hostId, observedAt: snapshot.now, clockOffset });
  // Disk is reported from the host, not from the cursor: the loop may be stopped, and the volume
  // filling is exactly the condition that stops it. The plan behind the number is the same one the
  // loop and `master reclaim` compute, so the attention item never promises room reclaiming cannot give.
  const worktrees = worktreesDirectory(root);
  const trees = await inventoryWorktrees(root).catch(() => []), reclaimPlan = planWorktreeReclaim(trees, snapshot.work, { now: Date.now(), idleMs: reclaimIdleMs(master) });
  const disk = diskPressure(worktrees, await freeBytes(worktrees), diskThresholdBytes(master), reclaimPlan);
  // The managed worktree root is a volume of its own as often as not: proof and review checkouts
  // live there, and it is judged against its own minimum and budget, before a write there fails.
  const managedRoot = await managedRootStatus(root, master, [...reviewRecords, ...producerRecords]);
  const diskAttention = [...diskPressureAttention(disk), ...managedRoot.attention];
  const daemonState = await readDaemonState(root, master).catch(error => ({ error: error instanceof Error ? error.message : 'Master daemon state is unreadable' }));
  const intervalMs = master.run.intervalSeconds * 1000;
  const cycling = 'error' in daemonState ? null : daemonSummary(daemonState, Date.now(), intervalMs, master.hostId);
  const daemon = cycling ?? { running: false, error: (daemonState as { error: string }).error };
  // The loop's own health comes before every work item: a coordinator that is absent or stalled is
  // why nothing else on this list is moving, and no other attention item would say so; a cycle that
  // outgrew its interval names its costly step and whether it computed or waited.
  const loopItems: AttentionItem[] = cycling
    ? [...loopAttention({ liveness: cycling.liveness, silence: cycling.silence, budget: cycling.budget, failures: cycling.failures, cost: cycling.cost }), ...approverLaunchAttention(cycling)]
    : [{ subject: 'loop', text: `The master loop's cursor cannot be read, so whether it is cycling is unknown: ${(daemonState as { error: string }).error}`, ...agentOwner('master', 'graphyard master restart (a supervised deployment restarts it on its own: systemctl --user restart graphyard-master)') }];
  // Browser administration is reported beside the work it unblocks: a pending sudo code is
  // the one thing the operator must act on, and the recent ledger entries say who changed what.
  const administration = { browser: master.browser ? { profile: master.browser.profile } : null, ...summarizeAdministration((await readAdministrationLedger(root)).entries, await readSudoState(root)) };
  // A worker session Herdr no longer reports, on an assignment whose lease is still advancing, is
  // an orphaned supervisor rather than a session that finished; it is named with what reclaims it.
  // Reviewer and producer profiles go in with their concurrency (GY-107): status reports, per
  // role, the sessions running against the declared limit and the longest wait for a slot.
  const sessions = nameOrphanSupervisors(nameUnresolvedThreads(buildMasterStatus(snapshot, master.workers, runtime.agents, credentials, containment, reviews, master.baseBranch, coordinator, { producers, failures: dispatch.failures, retries }, probeCandidateConflicts(root, snapshot.work), { reviewers: master.reviewers, producers: master.producers }, master.cliPath), snapshot.work, agentOwner),
    snapshot.work, master.workers, runtime, Date.parse(snapshot.now));
  // A required check that failed on the clock says so, with the measurement against its budget.
  const status = await qualifyTimingFailures(sessions, snapshot.work, master.repository, ghCheckAnnotations(master.repository));
  // A waiting sudo prompt is the operator confirming their own GitHub credential on their device,
  // the one step no agent may take for them; a timed-out one is the master's to rerun.
  const sudo = administration.sudo;
  const scopeRequests = [...scopeRequestAttention(snapshot), ...agentRequestAttention(snapshot), ...consentHoldItems(trees, snapshot)];
  // A session past its role's maximum: running but making no progress is as visible as one that died.
  const overlong = overlongSessionAttention(snapshot, { ...runtime, hostId: master.hostId }, { proof: master.run.producerTimeoutMinutes * 60_000 });
  // A request whose session settled without satisfying its gate: nothing runs for it, nothing
  // refused, and nothing will launch again until it is named here with the command that answers it.
  // A review every session settled on a dismissal for is the stronger statement of the same
  // request (GY-100) and is reported once, as the review that cannot be obtained on that commit.
  const unobtainable = unobtainableReviewAttention(status.work, reviews.completed as SettledReviewSession[]);
  const unanswered = unansweredRequestAttention(status.work);
  // An open item the control plane names no action for. Those waiting on another item or on a
  // live session are accounted and raise nothing; what is left is named, with what is missing.
  const actionless = actionlessItems(snapshot.work, new Date(snapshot.now));
  const stalledItems = stalledItemAttention(snapshot);
  // An action no live executor can claim is not queued behind other work (GY-105); it is named
  // with its wait and the unit to start, ahead of everything that waits on it.
  const executors = await executorFleet(root, masterApi, snapshot);
  // A row that keeps failing for the same reason: owed, attempted, and going nowhere. It is raised
  // as soon as it is classified, which is inside the same idle bound a row nobody is acting on has.
  const stalled = stalledActionAttention(snapshot);
  // What waits on a judgment rather than on capacity, named once and counted apart (GY-104).
  const owed = owedAttention(snapshot, status.work as { key: string; attention: string | null }[], scopeRequests);
  const attentionItems = [...diskAttention, ...scopeRequests, ...unanswered, ...stuck.attentionItems, ...stalledItems, ...stalled, ...overlong, ...owed.items, ...(sudo ? [...status.attentionItems, { subject: 'installation', text: sudo.instruction,
    ...(Date.parse(sudo.deadline) <= Date.now() ? agentOwner('master', `graphyard master browser ${sudo.flow}`) : humanOwner('issuing credentials to people', sudo.instruction)) }] : [...status.attentionItems])];
  // The loop's own health goes in front of all of it (see loopItems above), then the dispatcher's,
  // then an action no live executor can claim: nothing below any of the three is moving until they are.
  attentionItems.unshift(...loopItems, ...dispatchItems, ...executors.attention);
  // Setup that stops every launch, or leaves the loop unsupervised, is the master's to repair.
  attentionItems.push(...setupItems);
  // The generated-files variable the installers set beside GRAPHYARD_PRINCIPALS, compared with
  // the managed repository's manifest: a deployment that does not exempt the manifest's paths
  // sends every docs-touching item into the out-of-scope refusal, so the drift is raised here
  // with the exact command that fixes the deployment.
  const generatedFiles: AttentionItem[] = [];
  try {
    const manifest = generatedFilesAssignment(root);
    const deployed = coordinator?.delegationLimits?.deployed?.[generatedFilesVariable];
    for (const text of generatedFilesDrift(deployed, manifest)) generatedFiles.push({ subject: 'installation', text, ...installationOwner('delegation-limits', text) });
  } catch (error) {
    generatedFiles.push({ subject: 'installation', text: `The repository generated-file manifest is unreadable: ${error instanceof Error ? error.message : 'unknown reason'}`,
      ...agentOwner('master', `Fix ${generatedManifestScript} so --list prints the generated paths; master status reports the deployment drift again once it does`) });
  }
  // An escalation context over its budget (GY-138), named before a handler declines on it.
  const overflow = await contextOverflows(masterApi, snapshot.work);
  attentionItems.push(...generatedFiles, ...overflow);
  const decisions = await terminalDecisions(masterApi, snapshot.work, { approvals: cycling?.approvals ?? [], runtime, now: Date.now() });
  return { ...status, attentionItems: [...nameUnobtainableReviews(attentionItems as (AttentionItem & { requestId?: string })[], unobtainable), ...decisions.attentionItems],
    counts: { ...status.counts, dispatchUnanswered: unanswered.length, dispatchUnobtainableReview: unobtainable.length, unansweredDecisions: decisions.unanswered.length, refusedDecisions: decisions.refused, stuckRequests: stuck.stuck.length, stalledActions: stalled.length, overlongSessions: overlong.length, needsHuman: owed.rows.length,
      // Items with no action, split the way a reader has to read them: one waiting on another
      // item is the pipeline working, one with nothing moving it is the pipeline stopped.
      actionless: actionless.length, waitingOnAnother: actionless.filter(entry => entry.outcome === 'waiting-on').length, stalled: stalledItems.length,
      attention: status.counts.attention + diskAttention.length + generatedFiles.length + unanswered.length + stuck.attentionItems.length + stalledItems.length + stalled.length + overlong.length + loopItems.length + dispatchItems.length + executors.attention.length + overflow.length + owed.counted },
    // Every open item the control plane names no action for, with the account it names instead
    // and how long it has held its failing gate; the bound the stalled ones were judged against.
    actionless: { bound: stallBoundMs, items: actionless },
    terminalDecisions: decisions.listed, unansweredDecisions: decisions.unanswered,
    // The commits no reviewer session has ever obtained a verdict on, with the dismissed review.
    unobtainableReviews: unobtainable.map(item => ({ work: item.subject, ...item.review })),
    autoMerge: master.autoMerge, mergeApproval: master.autoMerge ? 'routine merges permitted after gates pass' : 'each merge needs an approved merge decision: graphyard master decide GY-N merge REASON, approved by the approver agent',
    versionSkew: mergeProtocolSkew(coordinator, cli), cli,
    reviewer: master.reviewer ? { identity: `${master.reviewer.slug}[bot]`, appId: master.reviewer.appId, profiles: master.reviewers.map(profile => profile.name), automatic: master.run.reviewerProfile ?? (master.reviewers.length === 1 ? master.reviewers[0].name : null),
      concurrency: master.reviewers.map(profile => ({ name: profile.name, agentName: profile.agentName, concurrency: profileConcurrency(profile) })) } : null,
    producerProfiles: master.producers.map(profile => ({ name: profile.name, principal: profile.principal, kind: profile.kind, agentName: profile.agentName, concurrency: profileConcurrency(profile) })),
    setup, administration, daemon, dispatch,
    // The inverted loop: what the control plane says each item needs, who is running it, and
    // every session it can be watched through.
    actions: needsHumanActions(actionReport(snapshot), owed.rows), executors, sessions: sessionReport(snapshot),
    // Branches the queue's own pushes contaminated and the approvals its pushes cost (GY-127).
    branches: branchReport(status.work),
    requests: agentRequestReport(snapshot),
    // What the host has left, what a reclaim would give back, and the bound it was judged against.
    disk: { ...disk, worktreeRoot: managedRoot.health, idleMs: reclaimIdleMs(master), reclaimable: reclaimPlan.filter(entry => entry.disposable).map(entry => ({ path: entry.path, key: entry.key, epoch: entry.epoch, disposition: entry.disposition, detail: entry.detail })) },
    runtime: { herdr: { available: runtime.available, reason: runtime.reason }, reviews: reviewRuntime } };
}

/**
 * How the coordination cycle keeps to its configured interval, from the durations the daemon
 * records for its retained cycles: the last one, the p95, and every cycle that overran. A cycle
 * longer than its interval means the loop is falling behind the work it shepherds.
 */
export function cycleBudget(state: Pick<DaemonState, 'metrics'>, intervalMs: number) {
  const metrics = state.metrics;
  const last = metrics.at(-1) ?? null;
  const durations = metrics.map(metric => metric.durationMs).sort((a, b) => a - b);
  const p95Ms = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : null;
  const overruns = metrics.filter(metric => metric.durationMs > intervalMs);
  const describe = (m: CycleMetrics) => ({ cycle: m.cycle, at: m.at, durationMs: m.durationMs, childWaitMs: m.childWaitMs ?? null, workMs: m.workMs ?? null });
  return {
    intervalMs, measured: metrics.length, lastCycle: last ? describe(last) : null,
    withinInterval: last ? last.durationMs <= intervalMs : null, p95Ms, overruns: overruns.length,
    lastOverrun: overruns.length ? describe(overruns.at(-1)!) : null,
  };
}

/**
 * `master scope`: apply an open scope request of the lease-holding epoch as an additive
 * requirements revision; a root-level directory needs --allow-broad-scope.
 */
export async function approveScopeRequest(root: string, config: MasterConfig, args: string[], deps: { coordinator: (path: string) => Promise<any>; fetcher?: typeof fetch; operatorToken?: () => Promise<string> }) {
  const allowBroad = args.includes(broadScopeFlag); args = args.filter(flag => flag !== broadScopeFlag);
  if (!args[0]) throw new Error(`Use master scope GY-N [${broadScopeFlag}] [REASON]`);
  const work = ((await deps.coordinator('work-snapshot')).work as Work[]).find(item => item.id === args[0] || item.key === args[0]);
  if (!work) throw new Error(`Unknown work item ${args[0]}`);
  const request = work.scopeRequest;
  if (!request) throw new Error(`${work.key} has no open scope request to approve`);
  if (!work.lease || work.lease.epoch !== request.epoch) throw new Error(`${work.key}'s scope request belongs to epoch ${request.epoch}, which no longer holds the lease; ask the live worker to request again`);
  const token = await (deps.operatorToken ? deps.operatorToken() : agentToken(root, config, 'operatorAgent')), fetcher = deps.fetcher ?? fetch;
  const plannedFiles = [...new Set([...work.plannedFiles, ...request.paths])];
  const reason = guardBroadScope({ ...work, plannedFiles }, args.slice(1).join(' ').trim() || `Approve ${request.requestedBy}'s scope request: ${request.reason}`, { allow: allowBroad, command: 'master scope', existing: work.plannedFiles });
  const response = await fetcher(`${config.url}/api/work/${work.id}/requirements`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': process.env.GRAPHYARD_REQUEST_ID ?? randomUUID() }, body: JSON.stringify({ expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: work.dependencies, plannedFiles, exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [], reason }), signal: AbortSignal.timeout(30_000) });
  const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
}
