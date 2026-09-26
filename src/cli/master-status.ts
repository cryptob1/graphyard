import { probeCandidateConflicts } from '../conflicts.js';
import { mergeBatchSize } from '../master.js';
import { humanOnlyStatusRow, type HumanRequestRow } from '../model/human-request.js';
import { agentOwner, assessContainment, branchReport, buildMasterStatus, diskPressure, diskPressureAttention, diskThresholdBytes, freeBytes, humanOwner, inspectWorkerCredentials, installationOwner, statusWorktreeInventory, managedRootStatus, mergeProtocolSkew, observeHerdrAgents, planWorktreeReclaim, profileConcurrency, reclaimIdleMs, snapshotWithClock, worktreesDirectory, type AttentionItem, type MasterConfig } from '../master.js';
import { impliedScopeRequests, type Work } from '../model/work.js';
import { actionReport, agentRequestReport, sessionReport } from './loop-report.js';
import { needsHumanActions, routedScopeStatus } from './owed-report.js';
import { installationMerger } from '../executor.js';
import { daemonSummary, loopAttention, readDaemonState } from '../master-daemon.js';
import { readReviewLedger, reconcileReviews, reviewLedgerSpec, sessionLedgerHeadroom, summarizeReviews } from '../reviewer.js';
import { producerLedgerSpec, readProducerLedger, reconcileProducers, sessionRetries, summarizeProducers } from '../producer.js';
import { defaultAwaitReviewers, dispatchFailureAttention, dispatchSummary, readDispatchCursor } from '../auto-dispatch.js';
import { actionlessItems, stallBoundMs } from '../model/action-account.js';
import { approverLaunchAttention, directMergeLine, nameOrphanSupervisors } from './status-attention.js';
import { nameUnobtainableReviews, type SettledReviewSession } from '../model/dispatch.js';
import { unansweredRequestAttention, unobtainableReviewAttention } from './unanswered-requests.js';
import { readAdministrationLedger, readSudoState, summarizeAdministration } from '../master-browser.js';
import { livenessStatus } from './liveness-report.js';
import { ghCheckAnnotations, qualifyTimingFailures } from './timing-failures.js';
import { setupHealth } from './master-setup.js';
import { stuckRequestReport, withStuckRequests } from './stuck-requests.js';
import { mergeStalls, nameUnresolvedThreads } from '../merge-queue.js';
import { observationThroughputStatus } from '../github.js';
import type { LoopSupervisorHost } from '../supervisor.js';
import { attributeAttention, derivedAttention, faulted, ledgerRefusalAttention, resourceStatus } from '../master-status.js';
import { generatedFilesAssignment, generatedFilesDrift, generatedFilesVariable, generatedManifestScript } from '../install/generated-files.js';
import { contextOverflows } from '../model/escalation-context.js';
import { interventionSummary, interventionSummaryRoute } from './intervention-status.js';
import { ReportSections } from '../master/sections.js';
import { terminalDecisions } from './decision-report.js';
import { masterBoard } from '../model/board.js';
import { executorFleetReport, readCommit, readExecutorRegistrations } from '../executor-fleet.js';
import { releaseLagStatus } from '../master/release-lag.js';
import { throughputStatus } from '../throughput.js';
import { Timings, timedApi, timedStep, withTimings } from '../master/timings.js';
import { slowReportReader } from '../master/report-cache.js';
import { repairLaneAttention } from '../master/repair-lane.js';

export { actionReport, agentRequestAttention, agentRequestReport, sessionReport } from './loop-report.js';
// The cycle-budget measure is a daemon metric (src/daemon/metrics.ts); it is read from here,
// as it always was, by `master status` and its tests.
export { cycleBudget } from '../daemon/metrics.js';
// `master scope` lives in its own module; it is read from here as it always was.
export { approveScopeRequest } from './master-scope.js';

/** A merge pending past five minutes on a head GitHub reports mergeable, with no refusal (GY-344). */
export const mergeStallAttention = (snapshot: { work: Work[]; now: string }): AttentionItem[] =>
  mergeStalls(snapshot.work, Date.parse(snapshot.now)).map(stall => ({ subject: stall.key, text: stall.text, ...agentOwner('master', stall.next) }));
// Observation throughput and the queue head's lag live beside the observation schedule they read
// (src/github.ts); the report reads them from here, as do the tests.
export { observationThroughputStatus };
// The attention builders live beside each other in `status-attention.ts`; the report reads them
// from here, as does everything that was reading them from here before the split.
export { approverLaunchAttention, nameOrphanSupervisors, orphanSupervisorAttention, stalledItemAttention, supervisorReclaimCommand } from './status-attention.js';
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
  // route and the phase it was made in: the report carries both under `timings` (GY-377).
  const timings = new Timings(dependencies.now);
  const report = await withTimings(timings, () => buildStatusReport(root, master, timedApi(masterApi), coordinator, cli, dependencies));
  return { ...report, timings: timings.report() };
}

async function buildStatusReport(root: string, master: MasterConfig, masterApi: (path: string, credential?: string, timeoutMs?: number) => Promise<any>, coordinator: any, cli: { commit: string | null }, dependencies: { supervisorHost?: LoopSupervisorHost; reportReadBoundMs?: number }) {
  const runtime = await timedStep('herdr', () => observeHerdrAgents());
  const credentials = await timedStep('credentials', () => inspectWorkerCredentials(root, master.workers));
  let reviewRecords = (await readReviewLedger(root)).reviews, reviewRuntime = { available: true, reason: null as string | null };
  const { snapshot, clockOffset } = await timedStep('snapshot', () => snapshotWithClock(() => masterApi('work-snapshot')));
  const sections = new ReportSections(); // optional sections (GY-422)
  // Sessions the automatic dispatcher launched are settled against this same snapshot: a
  // head change cancels them here as well as in the loop, so status never shows a stale one.
  try { reviewRecords = (await timedStep('reconcile reviews', () => reconcileReviews(root, master, { work: snapshot.work, agents: runtime.available ? runtime.agents : null }))).reviews; }
  catch (error) { reviewRuntime = { available: false, reason: `Reviewer verdicts could not be reconciled with GitHub: ${error instanceof Error ? error.message : 'unknown reason'}` }; }
  let producerRecords = (await readProducerLedger(root)).producers;
  try { producerRecords = (await timedStep('reconcile producers', () => reconcileProducers(root, master, snapshot.work, runtime.available ? runtime.agents : null))).producers; } catch { /* the ledger as last written stands */ }
  const reviews = summarizeReviews(reviewRecords), producers = summarizeProducers(producerRecords);
  // Every request whose last session failed or expired, with its attempts and the next relaunch.
  const retries = [...sessionRetries(reviewRecords, Date.now()), ...sessionRetries(producerRecords, Date.now())];
  // Setup that silently stops every launch, and the loop's supervision (GY-114), read from the host.
  const { setup, attention: setupItems } = await timedStep('setup', () => setupHealth(root, master, dependencies.supervisorHost));
  // Status reads the cursor as the loop would, repairing an over-long string in memory; the loop
  // is what logs and persists that repair, so status reports the cursor rather than announcing it.
  const dispatchCursor = await readDispatchCursor(root, master, () => {}).catch(error => ({ error: error instanceof Error ? error.message : 'Master dispatch cursor is unreadable' }));
  const stuck = stuckRequestReport({ reviews: reviewRecords, producers: producerRecords }, Date.now());
  const dispatch = 'error' in dispatchCursor ? { running: false, failures: [] as { requestId: string; kind: string; attempts: number; reason: string; at: string; nextAt: string }[], error: dispatchCursor.error } : withStuckRequests(dispatchSummary(dispatchCursor, Date.now(), master.run.dispatchIntervalSeconds * 1000, master.run.awaitReviewers ?? defaultAwaitReviewers.logins), stuck.stuck);
  // A dispatcher failing its tick launches nothing; it is named before the requests it is not launching.
  const dispatchItems = dispatchFailureAttention(dispatch);
  const containment = await timedStep('containment', () => assessContainment(snapshot.work, { hostId: master.hostId, observedAt: snapshot.now, clockOffset }));
  // Disk is reported from the host, not from the cursor: the loop may be stopped, and the volume
  // filling is exactly the condition that stops it. The plan is the one `master reclaim` computes,
  // over the inventory the loop's reclaim step cached (GY-360): walking a thousand trees here, on
  // every call, is what made status take minutes.
  const worktrees = worktreesDirectory(root);
  const inventory = await timedStep('worktrees', () => statusWorktreeInventory(root).catch(() => ({ entries: [], at: null, cached: false }))), trees = inventory.entries, reclaimPlan = planWorktreeReclaim(trees, snapshot.work, { now: Date.now(), idleMs: reclaimIdleMs(master) });
  const disk = diskPressure(worktrees, await freeBytes(worktrees), diskThresholdBytes(master), reclaimPlan);
  // The managed worktree root is a volume of its own as often as not: proof and review checkouts
  // live there, and it is judged against its own minimum and budget, before a write there fails.
  const managedRoot = await timedStep('managed root', () => managedRootStatus(root, master, [...reviewRecords, ...producerRecords]));
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
  const sessions = await timedStep('build status', () => nameOrphanSupervisors(nameUnresolvedThreads(buildMasterStatus(snapshot, master.workers, runtime.agents, credentials, containment, reviews, master.baseBranch, coordinator, { producers, failures: dispatch.failures, retries }, probeCandidateConflicts(root, snapshot.work), { reviewers: master.reviewers, producers: master.producers }, master.cliPath, { batchSize: mergeBatchSize(master) }), snapshot.work, agentOwner),
    snapshot.work, master.workers, runtime, Date.parse(snapshot.now)));
  // A check failed on the clock says so, against its budget; a routed scope request, its approver.
  const status = routedScopeStatus(await timedStep('timing failures', () => qualifyTimingFailures(sessions, snapshot.work, master.repository, ghCheckAnnotations(master.repository))), snapshot.work, cycling?.approvals);
  // A waiting sudo prompt is the operator confirming their own GitHub credential on their device,
  // the one step no agent may take for them; a timed-out one is the master's to rerun.
  const sudo = administration.sudo;
  // A request whose session settled without satisfying its gate: nothing runs for it, nothing
  // refused, and nothing will launch again until it is named here with the command that answers it.
  // A review every session settled on a dismissal for is the stronger statement of the same
  // request (GY-100) and is reported once, as the review that cannot be obtained on that commit.
  const unobtainable = unobtainableReviewAttention(status.work, reviews.completed as SettledReviewSession[]);
  const unanswered = unansweredRequestAttention(status.work);
  // An open item the control plane names no action for. Those waiting on another item or on a
  // live session are accounted and raise nothing; what is left is named, with what is missing.
  const actionless = actionlessItems(snapshot.work, new Date(snapshot.now));
  const liveness = livenessStatus(snapshot); // GY-201: open items holding no obligation, with ages
  // Requests, conflicts, stalls, executors and owed judgments come from derivedAttention, which the loop reads too.
  const { generatedFiles, overflow, interventions, releases, decisions, throughput, resources, derived: { scopeRequests, stalledItems: derivedStalls, actorless, executors, conflicted, stalled, owed, budget, overlong } } = await reportedAttention(root, master, masterApi, coordinator, snapshot,
    { reviews: reviewRecords, producers: producerRecords, runtime, commit: cli.commit, approvals: cycling?.approvals ?? [], loop: cycling?.liveness ?? null, rows: status.work, trees,
      // The intervention report takes the server a minute: status reads the loop's copy, or a bounded live read.
      reports: 'bounded', reportBoundMs: dependencies.reportReadBoundMs, sections });
  const lag = await timedStep('release lag', () => releaseLagStatus(root, master.baseBranch, snapshot.work, { cliCommit: cli.commit, loop: cycling, executors: releases.executors }));
  // Named with the stalls: a pending merge GitHub reports mergeable (GY-344), a repair-lane merge until a
  // normal merge proves the path (GY-406), an unobserved queue head (GY-492).
  const observation = observationThroughputStatus(coordinator, snapshot);
  const stalledItems = [...derivedStalls, ...mergeStallAttention(snapshot), ...observation.attention, ...repairLaneAttention(snapshot.work)];
  // Exactly one component merges (GY-245): the loop, where one is installed or running, else the executors.
  const merger = installationMerger({ loop: { configured: !!setup.supervisor.installed, running: !!cycling?.running, autoMerge: master.autoMerge },
    declaration: executors.supervision.declaration, served: executors.presence.served });
  const attentionItems = [...diskAttention, ...scopeRequests, ...unanswered, ...conflicted, ...stuck.attentionItems, ...stalledItems, ...actorless, ...stalled, ...overlong, ...budget, ...owed.items, ...(sudo ? [...status.attentionItems, { subject: 'installation', text: sudo.instruction,
    ...(Date.parse(sudo.deadline) <= Date.now() ? agentOwner('master', `graphyard master browser ${sudo.flow}`) : humanOwner('issuing credentials to people', sudo.instruction)) }] : [...status.attentionItems])];
  // In front of all of it: the loop's health (loopItems above), the dispatcher's, an action no live executor
  // can claim, the merger, a release lag (GY-437): nothing below moves until they do.
  attentionItems.unshift(...loopItems, ...dispatchItems, ...executors.attention, ...merger.attention, ...lag.attention);
  // Setup that stops every launch, or leaves the loop unsupervised, is the master's to repair.
  attentionItems.push(...setupItems);
  attentionItems.push(...generatedFiles, ...overflow); attentionItems.push(...interventions.attentionItems, ...releases.attention, ...(throughput.attention ? [throughput.attention] : []));
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
      attention: status.counts.attention + diskAttention.length + generatedFiles.length + unanswered.length + conflicted.length + stuck.attentionItems.length + stalledItems.length + actorless.length + stalled.length + overlong.length + loopItems.length + dispatchItems.length + executors.attention.length + merger.attention.length + releases.attention.length + lag.attention.length + overflow.length + budget.length + (throughput.attention ? 1 : 0) + observation.attention.length + owed.counted + resources.attention.length } }, snapshot.work);
  return { ...directMergeLine(coordinator), ...status, ...attributed, ...faulted(attributeAttention(attributed.attentionItems, resources.readings)), resources: resources.report,
    // The board (GY-200): what the master owes first, with commands, then the rest.
    board: await timedStep('board', () => masterBoard(masterApi, snapshot, coordinator, decisions.unanswered)),
    unavailable: sections.unavailable,
    humanOnly: humanOnly.map(humanOnlyStatusRow),
    // Every open item the control plane names no action for, with the account it names instead
    // and how long it has held its failing gate; the bound the stalled ones were judged against.
    actionless: { bound: stallBoundMs, items: actionless },
    liveness,
    interventions: interventions.summary,
    terminalDecisions: decisions.listed, throughput, unansweredDecisions: decisions.unanswered,
    // The commits no reviewer session has ever obtained a verdict on, with the dismissed review.
    unobtainableReviews: unobtainable.map(item => ({ work: item.subject, ...item.review })),
    merger: { merger: merger.merger, detail: merger.detail }, autoMerge: master.autoMerge, mergeQueue: { batchSize: mergeBatchSize(master) }, mergeApproval: master.autoMerge ? 'routine merges permitted after gates pass' : 'each merge needs an approved merge decision: graphyard master decide GY-N merge REASON, approved by the approver agent',
    // What the observation workers achieve and how far the queue head has drifted (GY-492).
    observationThroughput: observation,
    versionSkew: mergeProtocolSkew(coordinator, cli), cli,
    reviewer: master.reviewer ? { identity: `${master.reviewer.slug}[bot]`, appId: master.reviewer.appId, profiles: master.reviewers.map(profile => profile.name), automatic: master.run.reviewerProfile ?? (master.reviewers.length === 1 ? master.reviewers[0].name : null),
      concurrency: master.reviewers.map(profile => ({ name: profile.name, agentName: profile.agentName, concurrency: profileConcurrency(profile) })) } : null,
    producerProfiles: master.producers.map(profile => ({ name: profile.name, principal: profile.principal, kind: profile.kind, agentName: profile.agentName, concurrency: profileConcurrency(profile) })),
    setup, administration, daemon, dispatch,
    // Each session ledger's bound, retention and the room left for live sessions (GY-131).
    ledgers: { reviews: sessionLedgerHeadroom(reviewRecords, reviewLedgerSpec), producers: sessionLedgerHeadroom(producerRecords, producerLedgerSpec) },
    // The inverted loop: what the control plane says each item needs, who is running it, and
    // every session it can be watched through.
    actions: needsHumanActions(actionReport(snapshot), owed.rows),
    // Presence and supervision (GY-105) and the release each registered executor runs (GY-126).
    executors: { ...executors, ...releases, attention: [...executors.attention, ...releases.attention] }, sessions: sessionReport(snapshot),
    releaseLag: lag.report,
    // Branches the queue's own pushes contaminated and the approvals its pushes cost (GY-127).
    branches: branchReport(status.work),
    requests: agentRequestReport(snapshot), impliedScopeRequests: impliedScopeRequests(snapshot.work),
    // What the host has left, what a reclaim would give back, and the bound it was judged against.
    disk: { ...disk, worktreeRoot: managedRoot.health, idleMs: reclaimIdleMs(master), inventory: { at: inventory.at, cached: inventory.cached }, reclaimable: reclaimPlan.filter(entry => entry.disposable).map(entry => ({ path: entry.path, key: entry.key, epoch: entry.epoch, disposition: entry.disposition, detail: entry.detail })) },
    runtime: { herdr: { available: runtime.available, reason: runtime.reason }, reviews: reviewRuntime } };
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
  const reports = slowReportReader(master, masterApi, observed.reports, observed.reportBoundMs);
  const summarized = await timedStep('attention: interventions', () => interventionSummary(reports.read));
  if (summarized.summary.error) sections.mark('interventions', interventionSummaryRoute, summarized.summary.error);
  const interventions = { ...summarized, summary: { ...summarized.summary, ...reports.freshness() } };
  const releases = executorFleetReport(await readExecutorRegistrations(master).catch(() => []), { commit: observed.commit ?? readCommit(root) }, { hostId: master.hostId });
  const decisions = await timedStep('attention: decisions', () => sections.optional('decisions', 'GET /api/work/:id/decisions', () => terminalDecisions(masterApi, snapshot.work, { approvals: observed.approvals, runtime: observed.runtime, now: Date.now() }),
    () => ({ listed: [], attentionItems: [] as AttentionItem[], unanswered: [], refused: 0 })));
  const throughput = await timedStep('attention: throughput', () => throughputStatus(root, coordinator, snapshot.work));
  const resources = await timedStep('attention: resources', () => resourceStatus(root, master, { reviews: observed.reviews, producers: observed.producers, agents: observed.runtime.available ? observed.runtime.agents : null, work: snapshot.work, loop: observed.loop }));
  const derived = await timedStep('attention: derived', () => derivedAttention(root, master, masterApi, coordinator, snapshot, { ...observed, reviews: observed.reviews ?? [], producers: observed.producers ?? [], runtime: { available: observed.runtime.available, agents: observed.runtime.available ? observed.runtime.agents : [] } }));
  if (!derived.executors.presence.available && /^GET \/api\/actions failed/.test(derived.executors.presence.reason)) sections.mark('executors', 'GET /api/actions', derived.executors.presence.reason);
  const items = [...resources.attention, ...generatedFiles, ...overflow, ...interventions.attentionItems, ...releases.attention, ...(throughput.attention ? [throughput.attention] : []), ...decisions.attentionItems, ...derived.items];
  // The last step over the whole list, as the loop runs it: a cause named once, not its symptoms.
  const attribute = (status: { work: any[]; attentionItems: AttentionItem[] }) => attributeAttention(ledgerRefusalAttention(status, snapshot.work).attentionItems, resources.readings);
  return { generatedFiles, overflow, interventions, releases, decisions, throughput, resources, derived, items, attribute, unavailable: sections.unavailable };
}
