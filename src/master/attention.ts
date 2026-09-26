// Concern: who owns each attention item, control-plane attention, fleet and production summaries.
import { environmentBlocked, blockedPath } from '../worker-sandbox.js';
import { humanDecisionLabel, answerCommand } from '../model/human-request.js';
import { automatableProof } from '../model/mechanical-proofs.js';
import { type Work, standingEscalations } from '../model.js';
import { currentRestore, refusedReconciliation } from '../merge-queue.js';
import { missingBaseAncestry } from '../merge-base-ancestry.js';
import { type ProductionReport, attentionLines } from '../production-watch.js';
import type { FleetView } from '../model/registry.js';
import { classified, type FaultClass, type FaultKind } from '../model/fault-classes.js';
import { humanOnlyDecisions } from './harness.js';

/** The control-plane facts `GET /api/status` reports that are not about any one work item. */
export interface ControlPlaneStatus {
  appPermissions?: { app?: string; installationUrl?: string; verifiedAt?: string | null; error?: string | null; suspended?: boolean; missing?: { permission: string; required: string; features: string[] }[]; attention?: string[] } | null;
  heldJobs?: number;
  /** Capacity variables against the configured roster; a server before GY-59 reports none. */
  delegationLimits?: { limits?: Record<string, number>; deployed?: Record<string, string | null>; drift?: { variable: string; deployed: string | null; required: string; reason: string }[]; attention?: string[] } | null;
  /** The build the server runs and the merge protocol it speaks. */
  build?: { commit?: string | null; protocol?: number | null } | null;
  /** Production deployment observation for the base branch. */
  production?: Partial<ProductionReport> | null;
  /** The agent registry as the control plane holds it; a server before GY-91 reports none. */
  fleet?: FleetView | null;
}
/**
 * Who resolves an attention item and the next command they run. `role` is an agent role
 * (master, approver, reviewer, control plane); `human` is true only for the human-only list,
 * and `humanOnly` then names which of those decisions it is.
 */
export interface AttentionOwner { role: 'master' | 'reviewer' | 'control plane' | 'human'; approvedBy: 'approver' | null; human: boolean; humanOnly: typeof humanOnlyDecisions[number] | null; next: string }
/** An attention item carries its fault kind and class (GY-173); a builder that sets neither is classified by its wording. */
export interface AttentionItem extends AttentionOwner { subject: string; text: string; kind?: FaultKind; faultClass?: FaultClass }
export const agentOwner = (role: 'master' | 'reviewer' | 'control plane', next: string, approvedBy: 'approver' | null = null): AttentionOwner => ({ role, approvedBy, human: false, humanOnly: null, next });
export const humanOwner = (humanOnly: typeof humanOnlyDecisions[number], next: string): AttentionOwner => ({ role: 'human', approvedBy: null, human: true, humanOnly, next });
/** The sources of installation attention; each is also its fault kind. */
export const installationSources = ['app-permissions', 'held-jobs', 'delegation-limits', 'production'] as const;
/** The owner of one installation attention line, by the source that raised it. */
export function installationOwner(source: typeof installationSources[number], text: string): AttentionOwner {
  // Reinstating a suspended App installation is an account decision on the operator's GitHub account.
  if (source === 'app-permissions') return /suspended/i.test(text) ? humanOwner('spending money or opening third-party accounts', 'Reinstate the suspended GitHub App installation from the account that owns it')
    : agentOwner('master', 'graphyard master browser app-permissions, then graphyard master browser installation-accept');
  if (source === 'held-jobs') return agentOwner('control plane', 'Nothing to run: held jobs resume once graphyard master browser installation-accept grants the permission');
  if (source === 'delegation-limits') { const assignment = /Set (\S+=\S+)/.exec(text)?.[1]; return agentOwner('master', assignment ? `Set ${assignment} on the deployment (Railway: railway variables --set ${assignment} --service graphyard), then redeploy` : 'Set the named capacity variable on the deployment, then redeploy'); }
  return agentOwner('master', 'Fix or trigger the deployment of the base branch with the configured provider, then graphyard master verify-deployment GY-N for each pending delivery');
}
/** Why a work item raises attention; each cause is also its fault kind. */
export const workAttentionCauses = ['human-request', 'containment-settleable', 'containment-grace', 'containment', 'session', 'proof-gap', 'reviewer-exhausted', 'launch-review', 'launch-producer',
  'base-conflict', 'merged-unauthorized', 'merged-reverted', 'hold-overdue', 'contaminated', 'merge-base-dismissed', 'merge-refused', 'gate'] as const satisfies readonly FaultKind[];
export type WorkAttentionCause = typeof workAttentionCauses[number];
/**
 * The owner of a work item's attention, from the same facts that raised it. Everything an agent
 * identity may run is routed to an agent: decisions a human used to make go to the master and
 * its independent approver through graphyard master decide.
 */
export function workAttentionOwner(work: Work, cause: WorkAttentionCause): AttentionOwner {
  const key = work.key;
  if (cause === 'merge-refused') return agentOwner('master', `Nothing to run by hand: the integration job asks GitHub again on every observation of ${key}; fix what GitHub names (branch protection, the App's pull request permission, a moved head) and the next observation clears it`);
  if (cause === 'merge-base-dismissed') return agentOwner('master', missingBaseAncestry(work)
    ? `Nothing to run: the merge queue republishes ${key}'s tip onto the base branch tip and the merge broker refuses it until then; graphyard master status shows the new head`
    : `Nothing to run: the approval is restored on the unchanged head and re-posted before the merge`);
  // A branch carrying another item's unlanded commits is the control plane's to restore (GY-127):
  // an ejected tip is restored on its own, any other contaminated head on the coordinator's
  // request, and a head nothing can move goes back to a worker as a fresh attempt.
  if (cause === 'contaminated') {
    const restore = currentRestore(work)?.restore ?? null;
    if (restore?.outcome === 'unrepairable') return agentOwner('master', `graphyard master decide ${key} rework REASON, then graphyard master approver ${key} DECISION: the foreign commits sit under something the control plane cannot move, so a fresh attempt on a fresh branch is the way back`, 'approver');
    if (restore && !restore.performedAt) return agentOwner('master', `Nothing to run: the reconciliation job restores ${key} to its own reviewed head merged onto the base and reports the result here`);
    return work.queueEjection?.sha === work.candidate?.sha
      ? agentOwner('master', `Nothing to run: the control plane restores an ejected tip on its own, to ${key}'s own reviewed head merged onto the base; graphyard master repair ${key} REASON requests it again if the record shows no restore`)
      : agentOwner('master', `graphyard master repair ${key} REASON: the control plane resets the branch to ${key}'s own reviewed head and merges the base onto it; no worker force-push and no shell`);
  }
  // The one attention item no agent may clear: the three human decisions, answered by the human.
  if (cause === 'human-request') {
    const request = work.humanRequest!;
    return humanOwner(humanDecisionLabel[request.kind], `${answerCommand(key, request)} (or Work → Needs you on the dashboard); the answer returns ${key} to the loop, which dispatches it without a master session`);
  }
  // A merge the base branch does not hold the content of is not a record to settle (GY-97): no
  // decision can deliver work that is not there. The content goes back first, as a follow-up
  // item naming this one, its files and the merge that removed them; the delivery waits for it.
  if (cause === 'merged-reverted') {
    const reverted = work.observation!.revertedDelivery!;
    return agentOwner('master', `graphyard master create FILE for a follow-up item that restores ${reverted.files.map(file => file.path).join(', ')} to the base branch as ${key} shipped them${reverted.removedBy ? `, naming merge ${reverted.removedBy.mergeSha?.slice(0, 12) ?? `of pull request #${reverted.removedBy.pr}`}${reverted.removedBy.key ? ` of ${reverted.removedBy.key}` : ''} as what removed them` : ''}; request no merge decision for ${key} until the base branch holds its content — a reconciliation now would record a delivery for work that is not there`);
  }
  // The merge already happened and cannot be re-run: the only way to a correct delivery record is
  // the two-party merge decision the engine re-checks against the record at the merge cutoff. Once
  // the record has refused one, what remains is the operator's: a decision citing that refusal,
  // with an admin credential on one side, delivers the merge as operator-authorized (GY-94).
  if (cause === 'merged-unauthorized') {
    const refused = refusedReconciliation(work);
    return refused ? agentOwner('master', `graphyard master decide ${key} merge REASON with a REASON that cites refused decision ${refused.decision}, then the operator approves it with their admin credential (GRAPHYARD_TOKEN_FILE=ADMIN_TOKEN_FILE graphyard master approve ${key} DECISION REASON); the next observation delivers it as operator-authorized, stating that no execution authorized the merge and what the record lacked`, 'approver')
      : agentOwner('master', `graphyard master decide ${key} merge REASON, then graphyard master approver ${key} DECISION; the next observation re-checks the record at the merge cutoff and delivers on the approved decision, or records why it cannot${work.queue ? ` and removes the queue entry the merged pull request can never publish, without delivering` : ''}`, 'approver');
  }
  // Graphyard absorbs a moved base itself; a conflict is the one case it cannot, so the candidate
  // goes back to a worker for a fresh attempt rather than waiting for a refresh that cannot land.
  if (cause === 'base-conflict') return agentOwner('master', `graphyard master decide ${key} rework REASON, then graphyard master approver ${key} DECISION`, 'approver');
  if (cause === 'containment-settleable') return agentOwner('master', `graphyard master settle-containment ${key} REASON`);
  if (cause === 'containment-grace') return agentOwner('master', `Wait out the grace window, then graphyard master status verifies the host and graphyard master settle-containment ${key} REASON once settleable`);
  if (cause === 'containment') return agentOwner('master', `Stop the recorded supervisor on its host, then graphyard master decide ${key} ${work.stage === 'done' ? 'recover' : 'rework'} REASON and graphyard master approver ${key} DECISION`, 'approver');
  // A system-driven item is never pushed by hand (GY-175): the owner text names the loop step, not a command the CLI refuses.
  const driven = work.systemDriven === true;
  if (cause === 'session') return agentOwner('master', `herdr agent list to inspect the session; once the lease lapses, ${driven ? `the loop's dispatcher launches ${key} again` : `graphyard master dispatch ${key} PROFILE`}`);
  if (cause === 'proof-gap') return agentOwner('master', `graphyard master decide ${key} grant '{"principal":"PRODUCER","patterns":["${(work.proofGaps ?? [])[0] ?? 'PROOF'}"]}' REASON, then graphyard master approver ${key} DECISION`, 'approver');
  const reviewNext = driven ? `the loop relaunches the review on its own; graphyard master review ${key} only once the loop has stopped relaunching its request` : `graphyard master review ${key}`;
  if (cause === 'reviewer-exhausted') return agentOwner('master', `graphyard master reviewer add FILE with a profile on another provider, then ${reviewNext}`);
  if (cause === 'launch-review') return agentOwner('master', `Fix the refusal reason, then ${reviewNext}`);
  if (cause === 'launch-producer') return agentOwner('master', 'Fix the refusal reason (graphyard master producer add FILE for a missing profile); the loop relaunches the producer on its own');
  const escalation = standingEscalations(work)[0];
  if (escalation) return agentOwner('master', `graphyard master decide ${key} resolve '{"trigger":"${escalation.trigger}"}' REASON, then graphyard master approver ${key} DECISION`, 'approver');
  // A required command the worker's sandbox refused is the launcher's to fix, never the item's (GY-134).
  if (environmentBlocked(work.blocker)) return agentOwner('master', `Grant ${blockedPath(work.blocker!) ?? 'the refused path'} to the worker's sandbox (docs/master-agent-sessions.md "Worker sandbox"), then graphyard master unblock ${key} REASON and dispatch it again`);
  // The owner follows the refusal the row shows: the first failing gate, then a bare blocker.
  const first = work.gates.find(gate => !gate.passed);
  const manual = first?.name === 'acceptance' ? /(manual:[\w./-]+)/.exec(first.reasons.join(' '))?.[1] : undefined;
  if (manual && driven && automatableProof(work, manual)) return agentOwner('control plane', `The loop's producer session produces ${manual} on the exact head; once the loop stops relaunching its request, graphyard master decide ${key} attest '{"proof":"${manual}"}' REASON, then graphyard master approver ${key} DECISION`);
  if (manual) return agentOwner('master', `graphyard master decide ${key} attest '{"proof":"${manual}"}' REASON, then graphyard master approver ${key} DECISION`, 'approver');
  if (first?.name === 'review') return agentOwner('reviewer', driven ? `The reviewer session judges it; ${reviewNext}` : `The reviewer session judges it; graphyard master review ${key} relaunches a refused review`);
  if (first?.name === 'merge' && work.stage === 'merge') return agentOwner('master', driven ? `Nothing to run by hand: the loop's merge step performs the guarded merge of ${key} once its authorization is current` : `graphyard master merge ${key}`);
  if (work.blocker) return agentOwner('master', `Clear the cause, then graphyard master unblock ${key} REASON; a cause that needs money, a third-party account or a person's credential goes to the human`);
  return agentOwner('master', `graphyard diagnose ${key}`);
}
/**
 * Attention that belongs to the installation rather than to a work item: a declared App
 * permission the installation lacks, an unverifiable preflight, the jobs held on it, a
 * capacity variable that no longer covers the roster, and a base branch that production has
 * not deployed.
 */
export function controlPlaneAttention(status: ControlPlaneStatus | undefined) {
  const report = status?.appPermissions;
  const items: AttentionItem[] = [];
  const raise = (source: Parameters<typeof installationOwner>[0], text: string) => items.push({ subject: 'installation', text, ...installationOwner(source, text), ...classified(source) });
  for (const text of report?.attention ?? []) raise('app-permissions', text);
  if (status?.heldJobs) raise('held-jobs', `${status.heldJobs} integration job${status.heldJobs === 1 ? ' is' : 's are'} held on that permission shortfall rather than retried; they resume on their own once the installation reports the permission`);
  for (const text of status?.delegationLimits?.attention ?? []) raise('delegation-limits', text);
  const production = status?.production ? productionSummary(status.production) : null;
  for (const text of production?.attention ?? []) raise('production', text);
  const attention = items.map(item => item.text);
  return { attention, attentionItems: items, appPermissions: report ? { app: report.app ?? null, installationUrl: report.installationUrl ?? null, verifiedAt: report.verifiedAt ?? null, error: report.error ?? null, suspended: report.suspended ?? false, missing: (report.missing ?? []).map(shortfall => ({ permission: shortfall.permission, required: shortfall.required, features: shortfall.features })) } : null, heldJobs: status?.heldJobs ?? 0,
    delegationLimits: status?.delegationLimits ? { limits: status.delegationLimits.limits ?? null, deployed: status.delegationLimits.deployed ?? null, drift: (status.delegationLimits.drift ?? []).map(entry => ({ variable: entry.variable, deployed: entry.deployed, required: entry.required, reason: entry.reason })) } : null,
    build: status?.build ? { commit: status.build.commit ?? null, protocol: status.build.protocol ?? null } : null, production };
}
/**
 * The fleet as `master status` reports it, straight from the control plane's agent registry:
 * each account with its runtime, model, role eligibility, live sessions, quota and reset time, and
 * the reason it is ineligible when it is; each role with the account its next action would run
 * on. Everything that stops a role from launching is attention the master resolves itself, in
 * the registry: no file on this host decides it.
 */
export function fleetStatus(fleet: FleetView | null | undefined) {
  if (!fleet) return { fleet: null, attentionItems: [] as AttentionItem[] };
  const accounts = fleet.accounts.map(account => ({ account: account.name, runtime: account.runtime, model: account.model, modelId: account.modelId, cost: account.cost, capability: account.capability?.tier ?? null, host: account.host,
    roles: account.roles.map(entry => `${entry.role} (${entry.preference} of ${entry.of})`), liveSessions: account.liveSessions.map(session => ({ role: session.role, work: session.work, since: session.since })),
    loggedIn: account.loggedIn, quota: account.quota, usage: account.usage, resetsAt: account.resetsAt, observedAt: account.observedAt, eligible: account.eligible, ineligible: account.ineligible }));
  const attentionItems: AttentionItem[] = fleet.configured ? fleet.attention.map(text => ({ subject: 'fleet', text,
    ...agentOwner('master', /is not configured/.test(text) ? 'graphyard master registry role set ROLE ACCOUNT[,ACCOUNT…] --concurrency N --reason REASON' : /serves no role/.test(text) ? 'graphyard master registry role set ROLE ACCOUNT[,ACCOUNT…] --reason REASON, or graphyard master registry account remove NAME --reason REASON'
      : 'graphyard master registry (each account\'s ineligible reason names what to fix: log it in, wait for its reset, or add an account and name it in the role)'), ...classified('fleet') })) : [];
  return { attentionItems, fleet: { configured: fleet.configured, revision: fleet.revision, updatedAt: fleet.updatedAt, host: fleet.host, runtimes: fleet.runtimes.map(runtime => runtime.name), accounts, roles: fleet.roles,
    ineligible: accounts.filter(account => !account.eligible).map(account => ({ account: account.account, reason: account.ineligible })), recentSelections: fleet.sessions.slice(-10).map(session => ({ at: session.selectedAt, role: session.role, account: session.account, work: session.work, reason: session.reason, endedAt: session.endedAt })),
    refusals: fleet.refusals.slice(-5), next: fleet.configured ? null : 'No role is configured in the agent registry, so sessions launch from local profiles; run graphyard master registry propose --apply' } };
}
/**
 * The production lag an operator reads first: what production serves, how far the base
 * branch is ahead of it, and the failing deployment reason when the provider reported one.
 */
export function productionSummary(report: Partial<ProductionReport>) {
  const incidents = (report.incidents ?? []).map(incident => ({ key: incident.key, mergeSha: incident.mergeSha, status: incident.status, reason: incident.reason, deploymentId: incident.deploymentId ?? null, since: incident.since }));
  const ahead = report.ahead ?? null;
  const summary = ahead ? ahead.by === 0 ? 'production serves the base branch tip' : `main is ${ahead.by} commit${ahead.by === 1 ? '' : 's'} ahead of production` : report.aheadError ?? 'production lag is unknown';
  return { provider: report.provider ?? null, observedAt: report.observedAt ?? null, serving: report.serving ?? null, running: report.running ?? null, aheadBy: ahead?.by ?? null, aheadCommits: ahead?.commits ?? [], summary,
    /** The watch's own recovery of the drift (GY-393): what it asked the provider to deploy, and when. */
    redeploy: report.redeploy ?? null, redeployError: report.redeployError ?? null,
    latestDeployment: report.latest ? { id: report.latest.id, status: report.latest.providerStatus, commit: report.latest.commit, createdAt: report.latest.createdAt, url: report.latest.url ?? null } : null,
    deployed: report.deployed ?? [], pending: report.pending ?? [], incidents, error: report.error ?? null,
    attention: attentionLines({ ahead, aheadError: report.aheadError ?? null, serving: report.serving ?? null, incidents: (report.incidents ?? []), error: report.error ?? null, latest: report.latest ?? null, provider: report.provider ?? null }) };
}
