import { workerLaunchStatus } from '../master/dispatch.js';
import { type HumanRequestRow } from '../model/human-request.js';
import { herdrAttachCommand } from '../master/herdr.js';
import { agentOwner, buildMasterStatus, humanOwner, inspectWorkerCredentials, managedRootStatus, type AttentionItem, type MasterConfig, observeHerdrAgents, installationOwner } from '../master.js';
import { dataDirectory } from '../install/worktree-root.js';
import { probeCandidateConflictsWithBudget } from '../conflicts.js';
import { readReviewLedger, reconcileReviews, summarizeReviews } from '../reviewer.js';
import { readProducerLedger, reconcileProducers, sessionRetries, summarizeProducers } from '../producer.js';
import { type Work } from '../model/work.js';
import { deployLine, leftBehindCheckoutAttention, readHeldCli } from '../daemon/upgrade.js';
import { loopCodeRoot } from '../daemon/checkout-state.js';
import { daemonSummary, loopAttention, progressAttention, readDaemonState } from '../master-daemon.js';
import { defaultAwaitReviewers, dispatchFailureAttention, dispatchSummary, readDispatchCursor } from '../auto-dispatch.js';
import { actionlessItems, stallBoundMs } from '../model/action-account.js';
import { loopCursorLines, mergeWriterLine, nameBaseBreaks } from './status-attention.js';
import { readAdministrationLedger, readSudoState, summarizeAdministration } from '../master-browser.js';
import { livenessStatus } from './liveness-report.js';
import { setupHealth } from './master-setup.js';
import { stuckRequestReport, withStuckRequests } from './stuck-requests.js';
import type { LoopSupervisorHost } from '../supervisor.js';
import { derivedAttention, ledgerRefusalAttention } from '../master-status.js';
import { generatedFilesAssignment, generatedFilesDrift, generatedFilesVariable, generatedManifestScript } from '../install/generated-files.js';
import { ReportSections } from '../master/sections.js';
import { promotionWait, releaseLagStatus } from '../master/release-lag.js';
import { Timings, timedApi, timedStep, withTimings } from '../master/timings.js';
import { observationThroughputStatus } from '../observation-priority.js';
import { leaseHealthStatus } from './lease-health-attention.js';
import { coordinationStep } from './coordination-snapshot.js';
import { assembleReportedAttention, assembleStatusSections } from './master-status-sections.js';

export { actionReport, agentRequestAttention, agentRequestReport, sessionReport } from './loop-report.js';
// Read from here as they always were.

// The report and the tests read the queue-head observation lag from here.
export { observationThroughputStatus };
// The attention builders live in `status-attention.ts`; the report reads them from here.
export { stalledItemAttention } from './status-attention.js';
export { humanNeededAttention, needsHumanActions } from './owed-report.js';
export { overlongSessionAttention } from './overlong-sessions.js';

/** The `master status` report: work truth joined with Herdr session health, the ledgers, the dispatch schedule and the candidates' conflict sets. */
export async function masterStatusReport(root: string, master: MasterConfig, masterApi: (path: string, credential?: string, timeoutMs?: number) => Promise<any>, coordinator: any, cli: { commit: string | null }, dependencies: { supervisorHost?: LoopSupervisorHost; now?: () => number } = {}) {
  // Every phase is timed, server reads of a second or more named with route and phase, under `timings` (GY-377).
  const timings = new Timings(dependencies.now);
  const report = await withTimings(timings, () => buildStatusReport(root, master, timedApi(masterApi), coordinator, cli, dependencies));
  return { ...report, timings: timings.report() };
}

async function buildStatusReport(root: string, master: MasterConfig, masterApi: (path: string, credential?: string, timeoutMs?: number) => Promise<any>, coordinator: any, cli: { commit: string | null }, dependencies: { supervisorHost?: LoopSupervisorHost }) {
  const runtime = await timedStep('herdr', () => observeHerdrAgents());
  const credentials = await timedStep('credentials', () => inspectWorkerCredentials(root, master.workers));
  const { snapshot, clockOffset } = await coordinationStep(run => timedStep('snapshot', run), masterApi);
  const sections = new ReportSections(); // optional sections (GY-422)
  const { reviewRecords, reviewRuntime, producerRecords, reviews, producers, retries } = await reconcileLedgers(root, master, snapshot, runtime);
  // Setup that silently stops every launch, and the loop's supervision (GY-114), read from the host.
  const { setup, attention: setupItems } = await timedStep('setup', () => setupHealth(root, master, dependencies.supervisorHost));
  // Status reads the cursor as the loop would; the loop logs and persists any repair.
  const dispatchCursor = await readDispatchCursor(root, master, () => {}).catch(error => ({ error: error instanceof Error ? error.message : 'Master dispatch cursor is unreadable' }));
  const stuck = stuckRequestReport({ reviews: reviewRecords, producers: producerRecords }, Date.now());
  const dispatch = 'error' in dispatchCursor ? { running: false, failures: [] as { requestId: string; kind: string; attempts: number; reason: string; at: string; nextAt: string }[], error: dispatchCursor.error } : withStuckRequests(dispatchSummary(dispatchCursor, Date.now(), master.run.dispatchIntervalSeconds * 1000, master.run.awaitReviewers ?? defaultAwaitReviewers.logins, snapshot.work, Date.parse(snapshot.now) || Date.now()), stuck.stuck);
  // Dispatcher failures, then long launch waits (GY-710).
  const dispatchItems = dispatchFailureAttention(dispatch);
  const launches = await timedStep('worker launches', () => workerLaunchStatus(root, master)); // GY-417
  dispatchItems.push(...launches.items);
  const daemonState = await readDaemonState(root, master).catch(error => ({ error: error instanceof Error ? error.message : 'Master daemon state is unreadable' }));
  const cursor = 'error' in daemonState ? null : daemonState;
  // The managed root, often its own volume, has its own minimum and budget.
  const managedRoot = await timedStep('managed root', () => managedRootStatus(root, master, [...reviewRecords, ...producerRecords]));
  const intervalMs = master.run.intervalSeconds * 1000;
  const cycling = 'error' in daemonState ? null : daemonSummary(daemonState, Date.now(), intervalMs, master.hostId);
  const daemon = cycling ?? { running: false, error: (daemonState as { error: string }).error };
  const diskAttention = managedRoot.attention;
  // Loop health first: a stalled coordinator is why nothing else moves.
  const watchdogItems = progressAttention(snapshot.work, cursor?.promotion ?? null, Date.parse(snapshot.now) || Date.now());
  const loopItems: AttentionItem[] = cycling
    ? [...loopAttention({ liveness: cycling.liveness, failures: cycling.failures }), ...watchdogItems,
      ...loopCursorLines(cycling, master.baseBranch)]
    : [{ subject: 'loop', text: `The master loop's cursor cannot be read, so whether it is cycling is unknown: ${(daemonState as { error: string }).error}`, ...agentOwner('master', 'graphyard master restart (a supervised deployment restarts it on its own: systemctl --user restart graphyard-master)') }];
  // Browser administration beside the work it unblocks: a pending sudo code, and who changed what.
  const administration = { browser: master.browser ? { profile: master.browser.profile } : null, ...summarizeAdministration((await readAdministrationLedger(root)).entries, await readSudoState(root)) };
  // Candidate session status and the conflict probe (GY-1157)
  const probe = await timedStep('conflicts', () => probeCandidateConflictsWithBudget(root, snapshot.work, dataDirectory()));
  const pipelined = await timedStep('build status', async () => buildMasterStatus(snapshot, master.workers, runtime.agents, credentials, reviews, master.baseBranch, coordinator, { producers, failures: dispatch.failures, retries }, probe, { reviewers: master.reviewers, producers: master.producers }, master.cliPath, daemonState, { mode: master.supervision, operatorLogin: master.operatorLogin }));
  for (const worker of pipelined.workers) Object.assign(worker, launches.rows[worker.profile] ?? {});
  // Failed check a fixed base explains (GY-793).
  const status = nameBaseBreaks(pipelined, snapshot.work);
  const sudo = administration.sudo; // operator confirming their GitHub credential on device
  // Open item with no named action: waiting on another item or a live session raises nothing.
  const actionless = actionlessItems(snapshot.work, new Date(snapshot.now));
  const liveness = livenessStatus(snapshot); // GY-201: open items holding no obligation, with ages
  // Requests, conflicts, stalls, owed judgments: derivedAttention (the loop reads it too).
  const { generatedFiles, derived: { requests, stalledItems: derivedStalls, actorless, conflicted, owed, budget, overlong } } = await reportedAttention(root, master, masterApi, coordinator, snapshot,
    { reviews: reviewRecords, producers: producerRecords, runtime, commit: cli.commit, rows: status.work,
      // GY-2015: the writer summary the cursor holds, so a held trial refusal reads as the loop reads it.
      mergeWriter: cycling?.mergeWriter ?? null,
      sections });
  const lag = await timedStep('release lag', () => releaseLagStatus(root, master.baseBranch, snapshot.work, { cliCommit: cli.commit, loop: cycling, promotion: 'error' in daemonState ? null : promotionWait(daemonState) }));
  // GY-1773: a held snapshot ahead of the dirty checkout left behind.
  // GY-1899: the pin lives under the running CLI's checkout, where the upgrade's holdCliAt wrote it.
  const codeRoot = loopCodeRoot(master.cliPath, root);
  lag.attention.push(...leftBehindCheckoutAttention(cycling?.upgrade?.snapshot, readHeldCli(codeRoot), codeRoot));
  // Stalls: a mergeable pending merge (GY-344), a repair-lane merge (GY-406),
  // queue-head lag (GY-492), and slow renewals (GY-558).
  const observation = observationThroughputStatus(snapshot), health = leaseHealthStatus(coordinator);
  const stalledItems = [...derivedStalls, ...observation.attention, ...health.attention];
  const attentionItems = [...diskAttention, ...requests, ...conflicted, ...stuck.attentionItems, ...stalledItems, ...actorless, ...overlong, ...budget, ...owed.items, ...status.attentionItems, ...(sudo ? [{ subject: 'installation', text: sudo.instruction,
    ...(Date.parse(sudo.deadline) <= Date.now() ? agentOwner('master', `graphyard master browser ${sudo.flow}`) : humanOwner('issuing credentials to people', sudo.instruction)) }] : [])];
  // First: loop health, dispatcher, release lag (GY-437).
  const ahead = [...loopItems, ...dispatchItems, ...lag.attention];
  attentionItems.unshift(...ahead);
  // Setup that stops every launch, or leaves the loop unsupervised, is the master's to repair.
  attentionItems.push(...setupItems);
  attentionItems.push(...generatedFiles);
  // Everything the control plane takes from the operator's own credential alone, from the
  // human-only rule table, answered on the dashboard's Needs you page (GY-102).
  const humanOnly = (coordinator?.humanOnly ?? []) as HumanRequestRow[];
  // A standing ledger refusal is attributed first (GY-131); what still reads as a symptom of a
  // resource at its bound is then rewritten to name that resource (GY-132).
  const attributed = ledgerRefusalAttention({ work: status.work, attentionItems,
    counts: { ...status.counts, reviewConflicts: conflicted.length, stuckRequests: stuck.stuck.length, overlongSessions: overlong.length, needsHuman: owed.rows.length, humanOnly: humanOnly.length,
      // Items with no action, split the way a reader has to read them: one waiting on another
      // item is the pipeline working, one with nothing moving it is the pipeline stopped.
      actionless: actionless.length, actorless: actorless.length, livenessViolations: liveness.violations, waitingOnAnother: actionless.filter(entry => entry.outcome === 'waiting-on').length, stalled: stalledItems.length,
      attention: status.counts.attention + diskAttention.length + generatedFiles.length + conflicted.length + stuck.attentionItems.length + stalledItems.length + actorless.length + overlong.length + ahead.length + budget.length + observation.attention.length + owed.counted } }, snapshot.work);
  const sectionsReport = await assembleStatusSections({
    master, snapshot, coordinator, cli, probe, observation, health,
    setup, administration, daemon, dispatch, reviewRecords, producerRecords,
    owed, lag, status, managedRoot,
    runtime, reviewRuntime, humanOnly, masterApi,
  });
  return {
    // The merger setting (src/merger-mode.ts).
    ...mergeWriterLine(coordinator),
    ...status, ...attributed,
    unavailable: sections.unavailable,
    // GY-1511: the Herdr server holding this install's agents, and the command that opens them.
    herdr: { instance: master.herdrInstance ?? null, attach: herdrAttachCommand(master.herdrInstance ?? null), running: runtime.available },
    // GY-1982: the continuous deploy's release reading and a failed deploy's line.
    promotion: { lastPromotedSha: cursor?.promotion?.promotedSha ?? null, promotedAt: cursor?.promotion?.promotedAt ?? null, checkedAt: cursor?.promotion?.checkedAt ?? null, reason: cursor?.promotion?.reason ?? null, deploy: deployLine(cursor?.promotion?.deployFailed) },
    // Every open item the control plane names no action for, with the account it names and how
    // long it has held its failing gate.
    actionless: { bound: stallBoundMs, items: actionless },
    liveness,
    ...sectionsReport,
  };
}

/** The review and producer ledgers reconciled with the runtime and the snapshot, as the report reads them. */
export async function reconcileLedgers(root: string, master: MasterConfig, snapshot: any, runtime: any) {
  let reviewRecords = (await readReviewLedger(root)).reviews, reviewRuntime = { available: true, reason: null as string | null };
  try { reviewRecords = (await timedStep('reconcile reviews', () => reconcileReviews(root, master, { work: snapshot.work, agents: runtime.available ? runtime.agents : null }))).reviews; }
  catch (error) { reviewRuntime = { available: false, reason: `Reviewer verdicts could not be reconciled with GitHub: ${error instanceof Error ? error.message : 'unknown reason'}` }; }
  let producerRecords = (await readProducerLedger(root)).producers;
  try { producerRecords = (await timedStep('reconcile producers', () => reconcileProducers(root, master, snapshot.work, runtime.available ? runtime.agents : null))).producers; } catch { /* the ledger as last written stands */ }
  const reviews = summarizeReviews(reviewRecords), producers = summarizeProducers(producerRecords);
  const retries = [...sessionRetries(reviewRecords, Date.now()), ...sessionRetries(producerRecords, Date.now())];
  return { reviewRecords, reviewRuntime, producerRecords, reviews, producers, retries };
}

/** What the report adds after buildMasterStatus. */
export async function reportedAttention(root: string, master: MasterConfig, masterApi: (path: string, credential?: string, timeoutMs?: number) => Promise<any>, coordinator: any, snapshot: { work: Work[]; now: string },
  observed: Pick<Parameters<typeof derivedAttention>[5], 'reviews' | 'producers' | 'rows' | 'standalone' | 'mergeWriter' | 'runtime'> & { commit: string | null;
    sections?: ReportSections }) {
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
  return assembleReportedAttention(root, master, masterApi, coordinator, snapshot, observed, { sections, generatedFiles });
}
