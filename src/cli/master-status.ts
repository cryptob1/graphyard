import { workerLaunchStatus } from '../master/dispatch.js';
import { type HumanRequestRow } from '../model/human-request.js';
import { agentOwner, assessContainment, diskPressure, diskPressureAttention, diskThresholdBytes, freeBytes, humanOwner, inspectWorkerCredentials, statusWorktreeInventory, managedRootStatus, planWorktreeReclaim, reclaimIdleMs, worktreesDirectory, type AttentionItem, type MasterConfig, observeHerdrAgents, installationOwner } from '../master.js';
import { type Work } from '../model/work.js';
import { installationMerger } from '../executor.js';
import { baseFailureAttention, daemonSummary, loopAttention, readDaemonState } from '../master-daemon.js';
import { slowCycleAttention } from '../daemon/liveness.js';
import { promotionStatus } from '../daemon/deployment.js';
import { defaultAwaitReviewers, dispatchFailureAttention, dispatchSummary, loopMemoryAttention, readDispatchCursor } from '../auto-dispatch.js';
import { actionlessItems, stallBoundMs } from '../model/action-account.js';
import { approverLaunchAttention, nameBaseBreaks } from './status-attention.js';
import { nameUnobtainableReviews, type SettledReviewSession } from '../model/dispatch.js';
import { unansweredRequestAttention, unobtainableReviewAttention } from './unanswered-requests.js';
import { readAdministrationLedger, readSudoState, summarizeAdministration } from '../master-browser.js';
import { livenessStatus } from './liveness-report.js';
import { setupHealth } from './master-setup.js';
import { stuckRequestReport, withStuckRequests } from './stuck-requests.js';
import type { LoopSupervisorHost } from '../supervisor.js';
import { attributeAttention, derivedAttention, faulted, ledgerRefusalAttention, resourceStatus } from '../master-status.js';
import { generatedFilesAssignment, generatedFilesDrift, generatedFilesVariable, generatedManifestScript } from '../install/generated-files.js';
import { contextOverflows } from '../model/escalation-context.js';
import { ReportSections } from '../master/sections.js';
import { terminalDecisions } from './decision-report.js';
import { promotionWait, releaseLagStatus } from '../master/release-lag.js';
import { Timings, timedApi, timedStep, withTimings } from '../master/timings.js';
import { hotspots } from './hotspots.js';
import { stallAttention } from './stall-attention.js';
import { coordinationStep } from './coordination-snapshot.js';
import { buildPipelineStatus, reconcileLedgers } from './master-status-pipeline.js';
import { assembleReportedAttention, assembleStatusSections } from './master-status-sections.js';

export { actionReport, agentRequestAttention, agentRequestReport, sessionReport } from './loop-report.js';
// Read from here as they always were.
export { cycleBudget } from '../daemon/metrics.js';
export { approveScopeRequest } from './master-scope.js';

// The queue-head observation lag, lease health and stall composition live in `stall-attention.ts`;
// the report and the tests read them from here, as they always have.
export { observationThroughputStatus } from './stall-attention.js';
// The attention builders live in `status-attention.ts`; the report reads them from here.
export { approverLaunchAttention, mergeStallAttention, nameOrphanSupervisors, orphanSupervisorAttention, stalledItemAttention, supervisorReclaimCommand } from './status-attention.js';
export { humanNeededAttention, needsHumanActions, scopeRequestAttention } from './owed-report.js';
export { stalledActionAttention } from './stalled-actions.js';
export { overlongSessionAttention } from './overlong-sessions.js';
export { unansweredRequestAttention, unansweredRequestOwner, unobtainableReviewAttention } from './unanswered-requests.js';

/**
 * The `master status` report: Graphyard work truth joined with Herdr session health, the local
 * review, producer, dispatch, daemon and administration ledgers, the dispatch schedule with its
 * overlap holds, and the conflict set of every open candidate probed over the fetched PR heads.
 */
export async function masterStatusReport(root: string, master: MasterConfig, masterApi: (path: string, credential?: string, timeoutMs?: number) => Promise<any>, coordinator: any, cli: { commit: string | null }, dependencies: { supervisorHost?: LoopSupervisorHost; now?: () => number; reportReadBoundMs?: number } = {}) {
  // Every phase of the build is timed, and every server read of a second or more is named with its
  // route and the phase it was made in: both are carried under `timings` (GY-377).
  const timings = new Timings(dependencies.now);
  const report = await withTimings(timings, () => buildStatusReport(root, master, timedApi(masterApi), coordinator, cli, dependencies));
  return { ...report, timings: timings.report() };
}

async function buildStatusReport(root: string, master: MasterConfig, masterApi: (path: string, credential?: string, timeoutMs?: number) => Promise<any>, coordinator: any, cli: { commit: string | null }, dependencies: { supervisorHost?: LoopSupervisorHost; reportReadBoundMs?: number }) {
  const runtime = await timedStep('herdr', () => observeHerdrAgents());
  const credentials = await timedStep('credentials', () => inspectWorkerCredentials(root, master.workers));
  const { snapshot, clockOffset } = await coordinationStep(run => timedStep('snapshot', run), masterApi);
  const sections = new ReportSections(); // optional sections (GY-422)
  const { reviewRecords, reviewRuntime, producerRecords, reviews, producers, retries } = await reconcileLedgers(root, master, snapshot, runtime);
  // Setup that silently stops every launch, and the loop's supervision (GY-114), read from the host.
  const { setup, attention: setupItems } = await timedStep('setup', () => setupHealth(root, master, dependencies.supervisorHost, coordinator));
  // Status reads the cursor as the loop would; the loop logs and persists any repair it makes.
  const dispatchCursor = await readDispatchCursor(root, master, () => {}).catch(error => ({ error: error instanceof Error ? error.message : 'Master dispatch cursor is unreadable' }));
  const stuck = stuckRequestReport({ reviews: reviewRecords, producers: producerRecords }, Date.now());
  const dispatch = 'error' in dispatchCursor ? { running: false, failures: [] as { requestId: string; kind: string; attempts: number; reason: string; at: string; nextAt: string }[], error: dispatchCursor.error } : withStuckRequests(dispatchSummary(dispatchCursor, Date.now(), master.run.dispatchIntervalSeconds * 1000, master.run.awaitReviewers ?? defaultAwaitReviewers.logins, snapshot.work, Date.parse(snapshot.now) || Date.now()), stuck.stuck);
  // Dispatcher failures, then long launch waits (GY-710).
  const dispatchItems = dispatchFailureAttention(dispatch);
  const launches = await timedStep('worker launches', () => workerLaunchStatus(root, master)); // GY-417
  dispatchItems.push(...launches.items);
  const containment = await timedStep('containment', () => assessContainment(snapshot.work, { hostId: master.hostId, observedAt: snapshot.now, clockOffset }));
  // Disk is read from the host: the volume filling stops the loop. The plan is `master reclaim`'s,
  // over the cached inventory (GY-360).
  const worktrees = worktreesDirectory(root);
  const inventory = await timedStep('worktrees', () => statusWorktreeInventory(root).catch(() => ({ entries: [], at: null, cached: false }))), trees = inventory.entries, reclaimPlan = planWorktreeReclaim(trees, snapshot.work, { now: Date.now(), idleMs: reclaimIdleMs(master) });
  const disk = diskPressure(worktrees, await freeBytes(worktrees), diskThresholdBytes(master), reclaimPlan);
  // The managed root, often its own volume, has its own minimum and budget.
  const managedRoot = await timedStep('managed root', () => managedRootStatus(root, master, [...reviewRecords, ...producerRecords]));
  const daemonState = await readDaemonState(root, master).catch(error => ({ error: error instanceof Error ? error.message : 'Master daemon state is unreadable' }));
  const hs = hotspots(daemonState);
  const intervalMs = master.run.intervalSeconds * 1000;
  const cycling = 'error' in daemonState ? null : daemonSummary(daemonState, Date.now(), intervalMs, master.hostId);
  const daemon = cycling ?? { running: false, error: (daemonState as { error: string }).error };
  const diskAttention = [...diskPressureAttention(disk), ...managedRoot.attention, ...loopMemoryAttention(cycling)];
  // The loop's own health comes first: a stalled coordinator is why nothing else moves.
  const loopItems: AttentionItem[] = cycling
    ? [...loopAttention({ liveness: cycling.liveness, silence: cycling.silence, budget: cycling.budget, failures: cycling.failures, cost: cycling.cost }), ...slowCycleAttention(cycling), ...approverLaunchAttention(cycling), ...baseFailureAttention(cycling.baseFailures, master.baseBranch)]
    : [{ subject: 'loop', text: `The master loop's cursor cannot be read, so whether it is cycling is unknown: ${(daemonState as { error: string }).error}`, ...agentOwner('master', 'graphyard master restart (a supervised deployment restarts it on its own: systemctl --user restart graphyard-master)') }];
  // Browser administration beside the work it unblocks: a pending sudo code, and who changed what.
  const administration = { browser: master.browser ? { profile: master.browser.profile } : null, ...summarizeAdministration((await readAdministrationLedger(root)).entries, await readSudoState(root)) };
  // Candidate session status, conflict probe and timing failure qualification (GY-1157)
  const { probe, status: pipelined, delivery } = await buildPipelineStatus(root, master, snapshot, coordinator, runtime, credentials, containment, reviews, producers, dispatch.failures, retries, daemonState, cycling, launches, masterApi, sections);
  // A failed check a since-fixed base breakage explains names the refresh that clears it (GY-793).
  const status = nameBaseBreaks(pipelined, snapshot.work);
  // A waiting sudo prompt is the operator confirming their own GitHub credential on their device.
  const sudo = administration.sudo;
  // A request whose session settled without satisfying its gate: nothing runs for it, nothing
  // refused, and nothing relaunches until it is named here with the command that answers it.
  // A review every session settled on a dismissal for is the stronger statement of the same
  // request (GY-100), reported once as the review that cannot be obtained on that commit.
  const unobtainable = unobtainableReviewAttention(status.work, reviews.completed as SettledReviewSession[]);
  const unanswered = unansweredRequestAttention(status.work);
  // An open item the control plane names no action for. Those waiting on another item or on a
  // live session are accounted and raise nothing; what is left is named, with what is missing.
  const actionless = actionlessItems(snapshot.work, new Date(snapshot.now));
  const liveness = livenessStatus(snapshot); // GY-201: open items holding no obligation, with ages
  // Requests, conflicts, stalls, executors, owed judgments: derivedAttention, which the loop reads too.
  const { generatedFiles, docs, overflow, interventions, releases, decisions, throughput, resources, derived: { scopeRequests, stalledItems: derivedStalls, actorless, executors, conflicted, stalled, owed, budget, overlong, triage, backlog } } = await reportedAttention(root, master, masterApi, coordinator, snapshot,
    { reviews: reviewRecords, producers: producerRecords, runtime, commit: cli.commit, approvals: cycling?.approvals ?? [], loop: cycling?.liveness ?? null, rows: status.work, trees,
      // The slow intervention report: the loop's copy, or a bounded live read.
      reports: 'bounded', reportBoundMs: dependencies.reportReadBoundMs, sections });
  const lag = await timedStep('release lag', () => releaseLagStatus(root, master.baseBranch, snapshot.work, { cliCommit: cli.commit, loop: cycling, executors: releases.executors, promotion: 'error' in daemonState ? null : promotionWait(daemonState) }));
  // Stalls: a mergeable pending merge (GY-344), a repair-lane merge (GY-406),
  // queue-head lag (GY-492), slow renewals (GY-558) and conflict hotspots (GY-566).
  const { observation, health, stalledItems } = stallAttention(snapshot, coordinator, derivedStalls, hs.attention);
  // Exactly one component merges (GY-245): the loop, where one is installed or running, else the executors.
  const merger = installationMerger({ loop: { configured: !!setup.supervisor.installed, running: !!cycling?.running, autoMerge: master.autoMerge },
    declaration: executors.supervision.declaration, served: executors.presence.served });
  const attentionItems = [...diskAttention, ...scopeRequests, ...unanswered, ...conflicted, ...stuck.attentionItems, ...stalledItems, ...actorless, ...stalled, ...overlong, ...budget, ...triage, ...owed.items, ...status.attentionItems, ...(sudo ? [{ subject: 'installation', text: sudo.instruction,
    ...(Date.parse(sudo.deadline) <= Date.now() ? agentOwner('master', `graphyard master browser ${sudo.flow}`) : humanOwner('issuing credentials to people', sudo.instruction)) }] : [])];
  // First: loop health, dispatcher, unclaimable actions, merger, release lag (GY-437); nothing below moves until they do.
  const ahead = [...loopItems, ...dispatchItems, ...executors.attention, ...merger.attention, ...lag.attention];
  attentionItems.unshift(...ahead);
  // Setup that stops every launch, or leaves the loop unsupervised, is the master's to repair.
  attentionItems.push(...setupItems);
  attentionItems.push(...generatedFiles, ...overflow); attentionItems.push(...interventions.attentionItems, ...releases.attention, ...(throughput.attention ? [throughput.attention] : []), ...delivery.attention);
  attentionItems.splice(loopItems.length + dispatchItems.length, 0, ...resources.attention);
  // Everything the control plane takes from the operator's own credential alone, from the
  // human-only rule table, answered on the dashboard's Needs you page (GY-102).
  const humanOnly = (coordinator?.humanOnly ?? []) as HumanRequestRow[];
  // A standing ledger refusal is attributed first (GY-131); what still reads as a symptom of a
  // resource at its bound is then rewritten to name that resource (GY-132).
  const attributed = ledgerRefusalAttention({ work: status.work, attentionItems: [...nameUnobtainableReviews(attentionItems as (AttentionItem & { requestId?: string })[], unobtainable), ...decisions.attentionItems],
    counts: { ...status.counts, dispatchUnanswered: unanswered.length, dispatchUnobtainableReview: unobtainable.length, unansweredDecisions: decisions.unanswered.length, refusedDecisions: decisions.refused, reviewConflicts: conflicted.length, stuckRequests: stuck.stuck.length, stalledActions: stalled.length, overlongSessions: overlong.length, needsHuman: owed.rows.length, humanOnly: humanOnly.length,
      // Items with no action, split the way a reader has to read them: one waiting on another
      // item is the pipeline working, one with nothing moving it is the pipeline stopped.
      actionless: actionless.length, actorless: actorless.length, livenessViolations: liveness.violations, waitingOnAnother: actionless.filter(entry => entry.outcome === 'waiting-on').length, stalled: stalledItems.length,
      ...backlog,
      attention: status.counts.attention + diskAttention.length + generatedFiles.length + unanswered.length + conflicted.length + stuck.attentionItems.length + stalledItems.length + actorless.length + stalled.length + overlong.length + triage.length + ahead.length + releases.attention.length + overflow.length + budget.length + (throughput.attention ? 1 : 0) + observation.attention.length + owed.counted + resources.attention.length + delivery.attention.length } }, snapshot.work);
  const sectionsReport = await assembleStatusSections({
    master, snapshot, coordinator, cli, probe, observation, health, hs,
    merger, setup, administration, daemon, dispatch, reviewRecords, producerRecords,
    owed, executors, releases, lag, status, disk, managedRoot, inventory, reclaimPlan,
    runtime, reviewRuntime, humanOnly, masterApi, decisions, approvals: cycling?.approvals ?? [],
  });
  return {
    ...status, ...attributed, ...faulted(attributeAttention(attributed.attentionItems, resources.readings)), resources: resources.report,
    unavailable: sections.unavailable,
    docsBudget: docs,
    delivery: delivery.report,
    // The loop's promotion drive (GY-1302): the last promoted SHA, merges production is behind, the next due promotion.
    promotion: promotionStatus('error' in daemonState ? null : daemonState.promotion),
    // Every open item the control plane names no action for, with the account it names and how
    // long it has held its failing gate.
    actionless: { bound: stallBoundMs, items: actionless },
    liveness,
    backlog,
    interventions: interventions.summary,
    terminalDecisions: decisions.listed, throughput, unansweredDecisions: decisions.unanswered,
    // Commits no reviewer session ever got a verdict on, with the dismissed review.
    unobtainableReviews: unobtainable.map(item => ({ work: item.subject, ...item.review })),
    ...sectionsReport,
    // Open goals (GY-1417) with their stage and who acts next: acceptance drafting, awaiting approval, planned, delivering.
    goals: await sections.optional('goals', 'GET /api/goals', async () => (await masterApi('goals?open=1&view=summary')).goals, () => null),
    // Doctor runs: accepted, else cursor's.
    doctor: coordinator?.doctor?.length ? coordinator.doctor : cycling?.doctor?.recent ?? null,
  };
}

/** What the report adds after buildMasterStatus; the loop reads it too, to track every class (GY-173). */
export async function reportedAttention(root: string, master: MasterConfig, masterApi: (path: string, credential?: string, timeoutMs?: number) => Promise<any>, coordinator: any, snapshot: { work: Work[]; now: string },
  observed: Omit<Parameters<typeof resourceStatus>[2], 'work' | 'agents'> & Pick<Parameters<typeof terminalDecisions>[2], 'approvals' | 'runtime'> & Pick<Parameters<typeof derivedAttention>[5], 'rows' | 'trees' | 'standalone' | 'approvals'> & { commit: string | null;
    /** How the slow intervention report is read (report-cache.ts): the loop's `background`, status's `bounded`, or live. */
    reports?: 'background' | 'bounded'; reportBoundMs?: number; sections?: ReportSections }) {
  const generatedFiles: AttentionItem[] = [];
  try {
    const deployed = coordinator?.delegationLimits?.deployed?.[generatedFilesVariable];
    for (const text of generatedFilesDrift(deployed, generatedFilesAssignment(root))) generatedFiles.push({ subject: 'installation', text, ...installationOwner('delegation-limits', text) });
  } catch (error) {
    generatedFiles.push({ subject: 'installation', text: `The repository generated-file manifest is unreadable: ${error instanceof Error ? error.message : 'unknown reason'}`,
      ...agentOwner('master', `Fix ${generatedManifestScript} so --list prints the generated paths; master status reports the deployment drift again once it does`) });
  }
  // Per-item reads run bounded-concurrently and each read below is a step of the recorder in force (GY-377);
  // a section whose route fails is named in `unavailable` and the rest is still built (GY-422).
  const sections = observed.sections ?? new ReportSections();
  const overflow = await sections.optional('escalation contexts', 'GET /api/work/:id/context', () => contextOverflows(masterApi, snapshot.work), () => [] as Awaited<ReturnType<typeof contextOverflows>>);
  return assembleReportedAttention(root, master, masterApi, coordinator, snapshot, observed, { sections, generatedFiles, overflow });
}
