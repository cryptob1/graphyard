import { probeCandidateConflicts } from '../conflicts.js';
import { assessContainment, buildMasterStatus, inspectWorkerCredentials, mergeProtocolSkew, observeHerdrAgents, snapshotWithClock, type MasterConfig } from '../master.js';
import { daemonSummary, readDaemonState } from '../master-daemon.js';
import { readReviewLedger, reconcileReviews, summarizeReviews } from '../reviewer.js';
import { readProducerLedger, reconcileProducers, summarizeProducers } from '../producer.js';
import { dispatchSummary, readDispatchCursor } from '../auto-dispatch.js';
import { readAdministrationLedger, readSudoState, summarizeAdministration } from '../master-browser.js';

/**
 * The `master status` report: Graphyard work truth joined with Herdr session health, the local
 * review, producer, dispatch, daemon and administration ledgers, the dispatch schedule with its
 * overlap holds, and the conflict set of every open candidate probed over the fetched PR heads.
 */
export async function masterStatusReport(root: string, master: MasterConfig, masterApi: (path: string) => Promise<any>, coordinator: any, cli: { commit: string | null }) {
  const runtime = observeHerdrAgents();
  const credentials = await inspectWorkerCredentials(root, master.workers);
  let reviews = summarizeReviews((await readReviewLedger(root)).reviews), reviewRuntime = { available: true, reason: null as string | null };
  const { snapshot, clockOffset } = await snapshotWithClock(() => masterApi('work-snapshot'));
  // Sessions the automatic dispatcher launched are settled against this same snapshot: a
  // head change cancels them here as well as in the loop, so status never shows a stale one.
  try { reviews = summarizeReviews((await reconcileReviews(root, master, { work: snapshot.work })).reviews); }
  catch (error) { reviewRuntime = { available: false, reason: `Reviewer verdicts could not be reconciled with GitHub: ${error instanceof Error ? error.message : 'unknown reason'}` }; }
  let producers = summarizeProducers((await readProducerLedger(root)).producers);
  try { producers = summarizeProducers((await reconcileProducers(root, master, snapshot.work, runtime.available ? runtime.agents : null)).producers); } catch { /* the ledger as last written stands */ }
  const dispatchCursor = await readDispatchCursor(root, master).catch(error => ({ error: error instanceof Error ? error.message : 'Master dispatch cursor is unreadable' }));
  const dispatch = 'error' in dispatchCursor ? { running: false, failures: [] as { requestId: string; kind: string; attempts: number; reason: string; at: string; nextAt: string }[], error: dispatchCursor.error } : dispatchSummary(dispatchCursor, Date.now(), master.run.dispatchIntervalSeconds * 1000);
  const containment = assessContainment(snapshot.work, { hostId: master.hostId, observedAt: snapshot.now, clockOffset });
  const daemonState = await readDaemonState(root, master).catch(error => ({ error: error instanceof Error ? error.message : 'Master daemon state is unreadable' }));
  const daemon = 'error' in daemonState ? { running: false, error: daemonState.error } : daemonSummary(daemonState, Date.now(), master.run.intervalSeconds * 1000);
  // Browser administration is reported beside the work it unblocks: a pending sudo code is
  // the one thing the operator must act on, and the recent ledger entries say who changed what.
  const administration = { browser: master.browser ? { profile: master.browser.profile } : null, ...summarizeAdministration((await readAdministrationLedger(root)).entries, await readSudoState(root)) };
  return { ...buildMasterStatus(snapshot, master.workers, runtime.agents, credentials, containment, reviews, master.baseBranch, coordinator, { producers, failures: dispatch.failures }, probeCandidateConflicts(root, snapshot.work)), autoMerge: master.autoMerge, mergeApproval: master.autoMerge ? 'routine merges permitted after gates pass' : 'explicit operator approval required for each merge',
    versionSkew: mergeProtocolSkew(coordinator, cli), cli,
    reviewer: master.reviewer ? { identity: `${master.reviewer.slug}[bot]`, appId: master.reviewer.appId, profiles: master.reviewers.map(profile => profile.name), automatic: master.run.reviewerProfile ?? (master.reviewers.length === 1 ? master.reviewers[0].name : null) } : null,
    producerProfiles: master.producers.map(profile => ({ name: profile.name, principal: profile.principal, kind: profile.kind, agentName: profile.agentName })),
    administration, daemon, dispatch, runtime: { herdr: { available: runtime.available, reason: runtime.reason }, reviews: reviewRuntime } };
}
