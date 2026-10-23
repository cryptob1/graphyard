// Concern: who owns each attention item, control-plane attention, fleet and production summaries.
import { environmentBlocked, blockedPath } from '../worker-sandbox.js';
import { humanDecisionLabel, answerCommand } from '../model/human-request.js';
import { automatableProof } from '../model/mechanical-proofs.js';
import type { Work } from '../model.js';
import { missingBaseAncestry } from '../merge-base-ancestry.js';
import { type ProductionReport, attentionLines } from '../production-watch.js';
import type { FleetView } from '../model/registry.js';
import { humanOnlyDecisions } from './harness.js';
import { conflictReworkBoundMs, conflictReworkDue } from '../model/base-refresh.js';

/** The control-plane facts `GET /api/status` reports that are not about any one work item. */
export interface ControlPlaneStatus {
  appPermissions?: { app?: string; installationUrl?: string; verifiedAt?: string | null; error?: string | null; suspended?: boolean; missing?: { permission: string; required: string; features: string[] }[]; attention?: string[] } | null;
  heldJobs?: number;
  /** Observation jobs that saved no observation three or more times in a row (GY-506); a server before it reports none. */
  starvedJobs?: { key: string; unobserved: number; error?: string | null; deferred_reason?: string | null }[];
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
 * (master, reviewer, control plane); `human` is true only for the human-only list,
 * and `humanOnly` then names which of those decisions it is.
 */
export interface AttentionOwner { role: 'master' | 'reviewer' | 'control plane' | 'human'; human: boolean; humanOnly: typeof humanOnlyDecisions[number] | null; next: string }
/** One attention line. `resource` names the registered resource a symptom was attributed to (GY-1272). */
export interface AttentionItem extends AttentionOwner { subject: string; text: string; resource?: string;
  /** Until when the loop is itself carrying what the line names (GY-1315): shown in master status. */
  inMotionUntil?: string }
export const agentOwner = (role: 'master' | 'reviewer' | 'control plane', next: string): AttentionOwner => ({ role, human: false, humanOnly: null, next });
export const humanOwner = (humanOnly: typeof humanOnlyDecisions[number], next: string): AttentionOwner => ({ role: 'human', human: true, humanOnly, next });
/** The sources of installation attention. */
export const installationSources = ['app-permissions', 'held-jobs', 'delegation-limits', 'production'] as const;
/** The owner of one installation attention line, by the source that raised it. */
export function installationOwner(source: typeof installationSources[number], text: string, productionBranch: string | null = null): AttentionOwner {
  // Reinstating a suspended App installation is an account decision on the operator's GitHub account.
  if (source === 'app-permissions') return /suspended/i.test(text) ? humanOwner('spending money or opening third-party accounts', 'Reinstate the suspended GitHub App installation from the account that owns it')
    : agentOwner('master', 'graphyard master browser app-permissions, then graphyard master browser installation-accept');
  if (source === 'held-jobs') return agentOwner('control plane', 'Nothing to run: held jobs resume once graphyard master browser installation-accept grants the permission');
  if (source === 'delegation-limits') { const assignment = /Set (\S+=\S+)/.exec(text)?.[1]; return agentOwner('master', assignment ? `Set ${assignment} on the deployment (Railway: railway variables --set ${assignment} --service graphyard), then redeploy` : 'Set the named capacity variable on the deployment, then redeploy'); }
  // Production may track a release branch of its own: the fix is the deployment of what production
  // tracks (GY-1207). The branch is the one the watch reported (GRAPHYARD_PRODUCTION_BRANCH when set), never a fixed name (GY-1256).
  return agentOwner('master', productionBranch
    ? `Fix the failing deployment of ${productionBranch}, the branch production tracks, with the configured provider`
    : 'Fix the failing deployment of the base branch, which production tracks, with the configured provider');
}
/** Why a work item raises attention. */
export const workAttentionCauses = ['human-request', 'session', 'proof-gap', 'reviewer-exhausted', 'launch-review', 'launch-producer',
  'stalled-step', 'base-conflict', 'merged-unauthorized', 'merged-reverted', 'hold-overdue', 'merge-base-dismissed', 'merge-refused', 'gate'] as const;
export type WorkAttentionCause = typeof workAttentionCauses[number];
/**
 * The owner of a work item's attention, from the same facts that raised it. Everything an agent
 * identity may run is routed to an agent: decisions a human used to make the master applies at once.
 */
export function workAttentionOwner(work: Work, cause: WorkAttentionCause, now = Date.now()): AttentionOwner {
  const key = work.key;
  if (cause === 'merge-refused') return agentOwner('master', `Nothing to run by hand: the integration job asks GitHub again on every observation of ${key}; fix what GitHub names (branch protection, the App's pull request permission, a moved head) and the next observation clears it`);
  if (cause === 'merge-base-dismissed') return agentOwner('master', missingBaseAncestry(work)
    ? `Nothing to run: the loop requests a fresh review of ${key}'s head; graphyard master status shows the new verdict`
    : `Nothing to run: the approval is restored on the unchanged head`);
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
  // The merge already happened and cannot be re-run: it stays on the record as a violation, and
  // the work it skipped is a follow-up item.
  if (cause === 'merged-unauthorized') return agentOwner('master', `graphyard master create FILE for a follow-up item that re-verifies what ${key}'s merge skipped; its unauthorized-merge violation stays on the record`);
  // Graphyard absorbs a moved base itself; a conflict is the one case it cannot, so the candidate
  // goes back to a worker for a fresh attempt rather than waiting for a refresh that cannot land.
  // On a system-driven item that rework is the loop's own round (GY-1389), which refuses a hand request:
  // the owner names the loop's step and the bound it is due by, never a command the CLI refuses (GY-1434).
  if (cause === 'stalled-step' || (cause === 'base-conflict' && work.systemDriven === true)) {
    const due = conflictReworkDue(work, now);
    const bound = due ? ` (due at ${due.dueAt}, ${conflictReworkBoundMs / 60_000} minutes after the conflict was first recorded at ${due.since})` : '';
    return cause === 'stalled-step'
      ? agentOwner('master', `graphyard master rework ${key} REASON returns it now; check the loop is cycling (master status names its liveness), since its rework step left the conflict rework unapplied${bound}`)
      : agentOwner('control plane', `Nothing to run by hand: the loop's rework step returns ${key} to a worker itself${bound}; past that bound master status names the step as stalled`);
  }
  if (cause === 'base-conflict') return agentOwner('master', `graphyard master rework ${key} REASON`);
  // A system-driven item is never pushed by hand (GY-175): the owner text names the loop step, not a command the CLI refuses.
  const driven = work.systemDriven === true;
  if (cause === 'session') return agentOwner('master', `herdr agent list to inspect the session; once the lease lapses, ${driven ? `the loop's dispatcher launches ${key} again` : `graphyard master dispatch ${key} PROFILE`}`);
  if (cause === 'proof-gap') return agentOwner('master', `graphyard principal add PRODUCER --role producer --proof ${(work.proofGaps ?? [])[0] ?? 'PROOF'}`);
  const reviewNext = driven ? `the loop relaunches the review on its own; graphyard master review ${key} only once the loop has stopped relaunching its request` : `graphyard master review ${key}`;
  if (cause === 'reviewer-exhausted') return agentOwner('master', `graphyard master reviewer add FILE with a profile on another provider, then ${reviewNext}`);
  if (cause === 'launch-review') return agentOwner('master', `Fix the refusal reason, then ${reviewNext}`);
  if (cause === 'launch-producer') return agentOwner('master', 'Fix the refusal reason (graphyard master producer add FILE for a missing profile); the loop relaunches the producer on its own');
  // A required command the worker's sandbox refused is the launcher's to fix, never the item's (GY-134).
  if (environmentBlocked(work.blocker)) return agentOwner('master', `Grant ${blockedPath(work.blocker!) ?? 'the refused path'} to the worker's sandbox (docs/master-agent-sessions.md "Worker sandbox"), then graphyard master unblock ${key} REASON and dispatch it again`);
  // The owner follows the refusal the row shows: the first failing gate, then a bare blocker.
  const first = work.gates.find(gate => !gate.passed);
  const manual = first?.name === 'acceptance' ? /(manual:[\w./-]+)/.exec(first.reasons.join(' '))?.[1] : undefined;
  if (manual && driven && automatableProof(work, manual)) return agentOwner('control plane', `The loop's producer session produces ${manual} on the exact head; once the loop stops relaunching its request, graphyard master attest ${key} ${manual} REASON`);
  if (manual) return agentOwner('master', `graphyard master attest ${key} ${manual} REASON`);
  if (first?.name === 'review') return agentOwner('reviewer', driven ? `The reviewer session judges it; ${reviewNext}` : `The reviewer session judges it; graphyard master review ${key} relaunches a refused review`);
  if (first?.name === 'merge' && work.stage === 'merge') return agentOwner('master', `Nothing to run by hand: GitHub merges ${key} once its merge gate passes`);
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
  const raise = (source: Parameters<typeof installationOwner>[0], text: string) => items.push({ subject: 'installation', text, ...installationOwner(source, text, source === 'production' ? status?.production?.release?.branch ?? null : null) });
  for (const text of report?.attention ?? []) raise('app-permissions', text);
  if (status?.heldJobs) raise('held-jobs', `${status.heldJobs} integration job${status.heldJobs === 1 ? ' is' : 's are'} held on that permission shortfall rather than retried; they resume on their own once the installation reports the permission`);
  for (const text of status?.delegationLimits?.attention ?? []) raise('delegation-limits', text);
  // A job that keeps finishing without an observation holds the merge queue behind its item (GY-506).
  for (const job of status?.starvedJobs ?? []) { const text = starvedJobText(job); items.push({ subject: job.key, text, ...agentOwner('master', `graphyard diagnose ${job.key}: the recorded reason names what keeps the observation from being saved; the next saved observation clears this`) }); }
  const production = status?.production ? productionSummary(status.production) : null;
  for (const text of production?.attention ?? []) raise('production', text);
  const attention = items.map(item => item.text);
  return { attention, attentionItems: items, appPermissions: report ? { app: report.app ?? null, installationUrl: report.installationUrl ?? null, verifiedAt: report.verifiedAt ?? null, error: report.error ?? null, suspended: report.suspended ?? false, missing: (report.missing ?? []).map(shortfall => ({ permission: shortfall.permission, required: shortfall.required, features: shortfall.features })) } : null, heldJobs: status?.heldJobs ?? 0,
    delegationLimits: status?.delegationLimits ? { limits: status.delegationLimits.limits ?? null, deployed: status.delegationLimits.deployed ?? null, drift: (status.delegationLimits.drift ?? []).map(entry => ({ variable: entry.variable, deployed: entry.deployed, required: entry.required, reason: entry.reason })) } : null,
    build: status?.build ? { commit: status.build.commit ?? null, protocol: status.build.protocol ?? null } : null, production };
}
/** The attention line for an observation job starved of observations: the item and the path its last run took. */
export function starvedJobText(job: NonNullable<ControlPlaneStatus['starvedJobs']>[number]) {
  const path = job.error ? `last refusal: ${job.error}` : job.deferred_reason ? `last reschedule: ${job.deferred_reason}` : 'no reason recorded, so the job loop fails before the observation';
  return `${job.key}'s observation job has finished ${job.unobserved} times in a row without saving an observation; ${path}`;
}
/**
 * The fleet as `master status` reports it, straight from the control plane's agent registry:
 * each account with its runtime, model, role eligibility, live sessions, quota and reset time, and
 * the reason it is ineligible when it is; each role with the account its next action would run
 * on. Everything that stops a role from launching is attention the master resolves itself, in
 * the registry: no file on this host decides it.
 */
const masterRoleUnnamed = (text: string) => /^role master is not configured\b/.test(text);
/**
 * The production lag an operator reads first: what production serves, how far the base
 * branch is ahead of it, and the failing deployment reason when the provider reported one.
 */
export function productionSummary(report: Partial<ProductionReport>) {
  const incidents = (report.incidents ?? []).map(incident => ({ key: incident.key, mergeSha: incident.mergeSha, status: incident.status, reason: incident.reason, deploymentId: incident.deploymentId ?? null, since: incident.since }));
  const ahead = report.ahead ?? null;
  const release = report.release ?? null;
  const awaiting = release && typeof release.unreleased === 'number' ? `; main is ${release.unreleased} commit${release.unreleased === 1 ? '' : 's'} ahead of it, awaiting the next release` : '';
  const summary = release ? (ahead?.by === 0 ? `production serves ${release.branch}${awaiting}` : ahead ? `${release.branch} is ${ahead.by} commit${ahead.by === 1 ? '' : 's'} ahead of production${awaiting}` : `${report.aheadError ?? 'production lag is unknown'}${awaiting}`)
    : ahead ? ahead.by === 0 ? 'production serves the base branch tip' : `main is ${ahead.by} commit${ahead.by === 1 ? '' : 's'} ahead of production${ahead.rollingOut ? `; rollout in flight since ${ahead.unservedSince}` : ''}` : report.aheadError ?? 'production lag is unknown';
  return { provider: report.provider ?? null, observedAt: report.observedAt ?? null, serving: report.serving ?? null, running: report.running ?? null, aheadBy: ahead?.by ?? null, aheadCommits: ahead?.commits ?? [], release, summary,
    unservedSince: ahead?.unservedSince ?? null, rollingOut: ahead?.rollingOut ?? false,
    latestDeployment: report.latest ? { id: report.latest.id, status: report.latest.providerStatus, commit: report.latest.commit, createdAt: report.latest.createdAt, url: report.latest.url ?? null } : null,
    deployed: report.deployed ?? [], pending: report.pending ?? [], incidents, error: report.error ?? null,
    attention: attentionLines({ ahead, aheadError: report.aheadError ?? null, serving: report.serving ?? null, incidents: (report.incidents ?? []), error: report.error ?? null, latest: report.latest ?? null, provider: report.provider ?? null, release }) };
}
