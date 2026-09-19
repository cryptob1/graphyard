import { probeCandidateConflicts } from '../conflicts.js';
import { agentOwner, assessContainment, buildMasterStatus, herdrWorkspaceHealth, humanOwner, inspectWorkerCredentials, installationOwner, mergeProtocolSkew, observeHerdrAgents, snapshotWithClock, type MasterConfig } from '../master.js';
import { generatedFilesAssignment, generatedFilesDrift, generatedFilesVariable, generatedManifestScript } from '../install/generated-files.js';
import { daemonSummary, readDaemonState } from '../master-daemon.js';
import { readReviewLedger, reconcileReviews, reviewerBindingHealth, summarizeReviews } from '../reviewer.js';
import { readProducerLedger, reconcileProducers, sessionRetries, summarizeProducers } from '../producer.js';
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
  // Setup that silently stops every launch: an App registered but never bound, a bound App whose
  // credential is gone, a Herdr workspace that no longer exists.
  const reviewerBinding = await reviewerBindingHealth(master);
  const workspace = herdrWorkspaceHealth(master);
  const setup = { reviewer: reviewerBinding, herdrWorkspace: workspace, attention: [...reviewerBinding.attention, ...(workspace.exists === false ? [workspace.reason!] : [])] };
  const dispatchCursor = await readDispatchCursor(root, master).catch(error => ({ error: error instanceof Error ? error.message : 'Master dispatch cursor is unreadable' }));
  const dispatch = 'error' in dispatchCursor ? { running: false, failures: [] as { requestId: string; kind: string; attempts: number; reason: string; at: string; nextAt: string }[], error: dispatchCursor.error } : dispatchSummary(dispatchCursor, Date.now(), master.run.dispatchIntervalSeconds * 1000);
  const containment = assessContainment(snapshot.work, { hostId: master.hostId, observedAt: snapshot.now, clockOffset });
  const daemonState = await readDaemonState(root, master).catch(error => ({ error: error instanceof Error ? error.message : 'Master daemon state is unreadable' }));
  const daemon = 'error' in daemonState ? { running: false, error: daemonState.error } : daemonSummary(daemonState, Date.now(), master.run.intervalSeconds * 1000);
  // Browser administration is reported beside the work it unblocks: a pending sudo code is
  // the one thing the operator must act on, and the recent ledger entries say who changed what.
  const administration = { browser: master.browser ? { profile: master.browser.profile } : null, ...summarizeAdministration((await readAdministrationLedger(root)).entries, await readSudoState(root)) };
  const status = buildMasterStatus(snapshot, master.workers, runtime.agents, credentials, containment, reviews, master.baseBranch, coordinator, { producers, failures: dispatch.failures, retries }, probeCandidateConflicts(root, snapshot.work));
  // A waiting sudo prompt is the operator confirming their own GitHub credential on their device,
  // the one step no agent may take for them; a timed-out one is the master's to rerun.
  const sudo = administration.sudo;
  const attentionItems = sudo ? [...status.attentionItems, { subject: 'installation', text: sudo.instruction,
    ...(Date.parse(sudo.deadline) <= Date.now() ? agentOwner('master', `graphyard master browser ${sudo.flow}`) : humanOwner('issuing credentials to people', sudo.instruction)) }] : [...status.attentionItems];
  // Setup that stops every launch is the master's to repair.
  for (const text of reviewerBinding.attention) attentionItems.push({ subject: 'setup', text, ...agentOwner('master', 'graphyard master reviewer setup (or graphyard master reviewer bind FILE --key-stdin) to bind the reviewer App') });
  if (workspace.exists === false) attentionItems.push({ subject: 'setup', text: workspace.reason!, ...agentOwner('master', 'Set herdrWorkspace in .graphyard/master.json to a workspace herdr workspace list shows; master run adopts it on its next tick') });
  // The generated-files variable the installers set beside GRAPHYARD_PRINCIPALS, compared with
  // the managed repository's manifest: a deployment that does not exempt the manifest's paths
  // sends every docs-touching item into the out-of-scope refusal, so the drift is raised here
  // with the exact command that fixes the deployment.
  try {
    const manifest = generatedFilesAssignment(root);
    const deployed = coordinator?.delegationLimits?.deployed?.[generatedFilesVariable];
    for (const text of generatedFilesDrift(deployed, manifest)) attentionItems.push({ subject: 'installation', text, ...installationOwner('delegation-limits', text) });
  } catch (error) {
    attentionItems.push({ subject: 'installation', text: `The repository generated-file manifest is unreadable: ${error instanceof Error ? error.message : 'unknown reason'}`,
      ...agentOwner('master', `Fix ${generatedManifestScript} so --list prints the generated paths; master status reports the deployment drift again once it does`) });
  }
  return { ...status, attentionItems, autoMerge: master.autoMerge, mergeApproval: master.autoMerge ? 'routine merges permitted after gates pass' : 'each merge needs an approved merge decision: graphyard master decide GY-N merge REASON, approved by the approver agent',
    versionSkew: mergeProtocolSkew(coordinator, cli), cli,
    reviewer: master.reviewer ? { identity: `${master.reviewer.slug}[bot]`, appId: master.reviewer.appId, profiles: master.reviewers.map(profile => profile.name), automatic: master.run.reviewerProfile ?? (master.reviewers.length === 1 ? master.reviewers[0].name : null) } : null,
    producerProfiles: master.producers.map(profile => ({ name: profile.name, principal: profile.principal, kind: profile.kind, agentName: profile.agentName })),
    setup, administration, daemon, dispatch, runtime: { herdr: { available: runtime.available, reason: runtime.reason }, reviews: reviewRuntime } };
}
