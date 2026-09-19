import { probeCandidateConflicts } from '../conflicts.js';
import { agentOwner, assessContainment, buildMasterStatus, humanOwner, inspectWorkerCredentials, mergeProtocolSkew, observeHerdrAgents, snapshotWithClock, type AttentionItem, type MasterConfig } from '../master.js';
import { daemonSummary, readDaemonState } from '../master-daemon.js';
import { readReviewLedger, reconcileReviews, summarizeReviews } from '../reviewer.js';
import { readProducerLedger, reconcileProducers, summarizeProducers } from '../producer.js';
import { dispatchSummary, readDispatchCursor } from '../auto-dispatch.js';
import { readAdministrationLedger, readSudoState, summarizeAdministration } from '../master-browser.js';

/**
 * Terminal decisions nothing waits on any more: a stale one — approval refused on a revision or
 * candidate race, so its pin can never hold again — and a withdrawn one the requester took back.
 * A stale decision raises master attention with the re-request command only while it is still the
 * latest decision for its action — a later decision of the same action supersedes it, whatever its
 * state; a withdrawn one is listed for the record and never raises attention.
 */
async function terminalDecisions(masterApi: (path: string) => Promise<any>, work: { id: string; key: string; stage: string }[]) {
  const listed: { work: string; id: string; action: string; state: string; reason: string | null; race?: unknown }[] = [];
  const attentionItems: AttentionItem[] = [];
  for (const item of work) {
    if (item.stage === 'done') continue;
    const history = await masterApi(`work/${item.id}/decisions`).catch(() => null);
    const decisions = history?.decisions ?? [];
    const latest = new Map<string, string>();
    for (const decision of decisions) latest.set(decision.action, decision.id);
    for (const decision of decisions) {
      if (decision.state !== 'stale' && decision.state !== 'withdrawn') continue;
      listed.push({ work: item.key, id: decision.id, action: decision.action, state: decision.state, reason: decision.outcome ?? null, ...(decision.race ? { race: decision.race } : {}) });
      if (decision.state === 'stale' && latest.get(decision.action) === decision.id)
        attentionItems.push({ subject: item.key, text: `Decision ${decision.id} (${decision.action}) is stale: ${decision.outcome ?? 'the item moved past it'}; request it again, the stale decision no longer blocks`,
          ...agentOwner('master', `graphyard master decide ${item.key} ${decision.action} [JSON|@FILE] REASON, then graphyard master approver ${item.key} DECISION`, 'approver') });
    }
  }
  return { listed, attentionItems };
}

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
  const status = buildMasterStatus(snapshot, master.workers, runtime.agents, credentials, containment, reviews, master.baseBranch, coordinator, { producers, failures: dispatch.failures }, probeCandidateConflicts(root, snapshot.work));
  // A waiting sudo prompt is the operator confirming their own GitHub credential on their device,
  // the one step no agent may take for them; a timed-out one is the master's to rerun.
  const sudo = administration.sudo;
  const attentionItems = sudo ? [...status.attentionItems, { subject: 'installation', text: sudo.instruction,
    ...(Date.parse(sudo.deadline) <= Date.now() ? agentOwner('master', `graphyard master browser ${sudo.flow}`) : humanOwner('issuing credentials to people', sudo.instruction)) }] : status.attentionItems;
  const decisions = await terminalDecisions(masterApi, snapshot.work);
  return { ...status, attentionItems: [...attentionItems, ...decisions.attentionItems], terminalDecisions: decisions.listed, autoMerge: master.autoMerge, mergeApproval: master.autoMerge ? 'routine merges permitted after gates pass' : 'each merge needs an approved merge decision: graphyard master decide GY-N merge REASON, approved by the approver agent',
    versionSkew: mergeProtocolSkew(coordinator, cli), cli,
    reviewer: master.reviewer ? { identity: `${master.reviewer.slug}[bot]`, appId: master.reviewer.appId, profiles: master.reviewers.map(profile => profile.name), automatic: master.run.reviewerProfile ?? (master.reviewers.length === 1 ? master.reviewers[0].name : null) } : null,
    producerProfiles: master.producers.map(profile => ({ name: profile.name, principal: profile.principal, kind: profile.kind, agentName: profile.agentName })),
    administration, daemon, dispatch, runtime: { herdr: { available: runtime.available, reason: runtime.reason }, reviews: reviewRuntime } };
}
