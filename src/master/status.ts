// Concern: the master status report — dispatch sessions, role concurrency, schedule, branches and deliveries.
import { concurrentOverlap, scopeBreadth, inFlight, dispatchable, dispatchOrder } from '../coordination.js';
import type { ConflictReport } from '../conflicts.js';
import { standingCapacity, describeCapacity, quotaRoles } from '../model/capacity.js';
import { parkedOnHuman, humanDecisionLabel, answerCommand, openHumanRequests } from '../model/human-request.js';
import { type Work, reviewProviderOf, reviewerProfileFor, exhaustedReviewerProfiles, implementerIdentities, describeQueueBinding, deploySmokeRequired, isClosed, closedHistory, deliveryState, postDeployMs, productionLatencyMs, rollbackGuidance, type QueueBindingReport } from '../model.js';
import { containmentAttestation, containmentGraceMs } from '../quarantine.js';
import { predictQueue, describeGitHubQueue, pendingBaseRefresh, baseRefreshConflict, currentBaseRefreshCarry, branchContamination, currentRestore, restoredApproval, unpublishableEntry, refusedReconciliation, type QueuePlacement } from '../merge-queue.js';
import { MERGE_PROTOCOL } from '../protocol-version.js';
import { mergeBaseDismissal, mergeBaseDismissalAttention } from '../merge-base-ancestry.js';
import { pipelineSpeed, pipelineSpeedSummary } from '../pipeline-speed.js';
import { profileSessions, type WorkerProfile } from './profiles.js';
import { sessionActivity } from './launch.js';
import { sessionView } from '../model/session-state.js';
import type { HerdrAgent } from './herdr.js';
import { type ContainmentAssessment, containmentHold, containmentPhase } from './containment.js';
import { agentOwner, type AttentionItem, controlPlaneAttention, type ControlPlaneStatus, fleetStatus, workAttentionOwner, type WorkAttentionCause } from './attention.js';
import { classified } from '../model/fault-classes.js';
import { unrunnableRemedies } from './harness.js';
import { mergedWithoutAuthorization, unauthorizedMergeViolation } from './merge.js';

// Reviewer failover is a capacity decision the operator must see, not a silent retry.
function reviewState(work: Work) {
  if (reviewProviderOf(work.policy) !== 'agent') return null;
  const failedOver = (work.reviewFailovers ?? []).filter(failover => failover.sha === work.candidate?.sha
    && failover.baseSha === work.candidate?.baseSha && failover.policyRevision === work.policyRevision)
    .map(({ profile, runtime, exhaustion, reason, at, nextProfile }) => ({ profile, runtime, exhaustion, reason, at, nextProfile }));
  const active = reviewerProfileFor(work);
  return { provider: 'agent' as const, profile: active?.name ?? null, runtime: active?.runtime ?? null,
    exhausted: !active && !!work.policy.reviewerProfiles?.length && !!exhaustedReviewerProfiles(work).length, failedOver };
}

/**
 * The version-skew guard the broker runs before touching a merge. The CLI and the server
 * each declare the merge protocol they speak; a server behind the CLI — main merged, the
 * deployment never served it — is reported as exactly that, with both commits, instead of
 * the broker failing later on a reply shape it does not recognize. A server that reports no
 * protocol predates the exchange and is version 1.
 */
export function mergeProtocolSkew(status: { build?: { commit?: string | null; protocol?: number | null } | null } | undefined, cli: { commit: string | null; protocol?: number }): string | null {
  const serverProtocol = status?.build?.protocol ?? 1, cliProtocol = cli.protocol ?? MERGE_PROTOCOL;
  if (serverProtocol === cliProtocol) return null;
  const serverCommit = status?.build?.commit ?? 'an unknown commit', cliCommit = cli.commit ?? 'an unknown commit';
  return `server runs ${serverCommit}, CLI expects ${cliCommit}: deploy main first (server merge protocol ${serverProtocol}, CLI merge protocol ${cliProtocol}${serverProtocol < cliProtocol ? '; the deployment has not served the commit the CLI runs' : '; update the CLI checkout to the deployed commit'})`;
}
/** Sessions the local ledgers hold and the launches the dispatcher refused, as `master status` joins them onto each candidate's requests. */
export interface SessionRetryReport { requestId: string; attempts: number; started: number; neverStarted: number; limit: number; unstartedLimit: number; nextAt: string | null; exhausted: boolean; last: { state: string; resolution: string | null } | null }
export interface DispatchSessions { producers: { pending: any[]; completed: any[] }; failures: { requestId: string; kind: string; attempts: number; reason: string; at: string; nextAt: string }[]; retries?: SessionRetryReport[] }
const noSessions: DispatchSessions = { producers: { pending: [], completed: [] }, failures: [] };
/**
 * What is running for one candidate and since when: every open request the control plane
 * holds for the current head, the session (if any) launched for it, and the launch failure
 * standing against it, plus the last resolved requests so a re-request reads with its history.
 */
export function describeDispatch(work: Work, reviews: { pending: any[]; completed: any[] }, sessions: DispatchSessions, now: number) {
  const state = work.autoDispatch;
  if (!state) return null;
  const since = (at: string) => Math.max(0, now - Date.parse(at));
  const session = (records: any[], requestId: string) => {
    const record = [...records].reverse().find(entry => entry.requestId === requestId);
    // A pending session is running only once it is acknowledged (acknowledgeLaunch); until then
    // it awaits acknowledgement, with the one re-prompt the loop sent on the record.
    return record ? { id: record.review ?? record.producer, profile: record.profile, agentName: record.agentName, state: record.state, attempt: record.attempt ?? 1, requestedAt: record.requestedAt, sinceMs: since(record.requestedAt),
      delivery: record.delivery ?? null, activity: record.state === 'pending' ? record.activity ?? sessionActivity(record) : null, acknowledgedAt: record.acknowledgedAt ?? null, repromptedAt: record.repromptedAt ?? null,
      ...(record.verdict !== undefined ? { verdict: record.verdict } : {}), ...(record.outcome ? { outcome: record.outcome } : {}), resolution: record.resolution ?? null, attention: record.attention ?? null } : null;
  };
  const failure = (requestId: string) => sessions.failures.find(entry => entry.requestId === requestId) ?? null;
  // A session that failed or expired is relaunched for the same request on a widening interval;
  // the attempts so far and when the next one is due are reported beside the request.
  const retry = (requestId: string) => sessions.retries?.find(entry => entry.requestId === requestId) ?? null;
  const describe = (request: NonNullable<typeof state.review>, records: any[]) => ({ requestId: request.id, sha: request.sha, baseSha: request.baseSha, policyRevision: request.policyRevision, requestedAt: request.requestedAt, sinceMs: since(request.requestedAt), reason: request.reason,
    ...(request.group ? { group: request.group, proofs: request.proofs } : {}), session: session(records, request.id), failure: failure(request.id), retry: retry(request.id) });
  const reviewRecords = [...reviews.completed, ...reviews.pending], producerRecords = [...sessions.producers.completed, ...sessions.producers.pending];
  return { review: state.review ? describe(state.review, reviewRecords) : null, producers: state.producers.map(request => describe(request, producerRecords)),
    recent: state.history.slice(-5).map(request => ({ kind: request.kind, ...(request.group ? { group: request.group } : {}), sha: request.sha, state: request.state, resolution: request.resolution ?? null, resolvedAt: request.resolvedAt ?? null })) };
}
/** Hold ages and bounds read in hours to one decimal: `1.5h`, `2h`. */
export const hours = (ms: number) => `${Math.round(ms / 360_000) / 10}h`;
/**
 * Queueing at the gates, per role (GY-107): how many sessions run against the limit the fleet
 * declares, and how long the longest request has waited for a slot. A request waits for a slot
 * when it is open, has no session, and nothing else holds it — no launch refused, no retry
 * pending, no settled session that no attempt follows — and, for a producer request, when some
 * profile is independent of the item at all. A fleet starving on review capacity reads here as
 * `running` at `limit` with `waiting` above zero and `longestWaitMs` climbing, without a session list.
 */
export interface RoleConcurrencyProfile { profile: string; agentName: string; limit: number; running: number; sessions: string[] }
export interface RoleConcurrencyReport { role: 'reviewer' | 'producer'; limit: number; running: number; free: number; waiting: number; longestWaitMs: number | null; longest: { work: string; requestId: string; group: string | null; waitedMs: number } | null; starved: boolean; profiles: RoleConcurrencyProfile[] }
export interface RoleProfiles { reviewers: { name: string; agentName: string; concurrency?: number }[]; producers: { name: string; agentName: string; principal: string; concurrency?: number }[] }
export function roleConcurrency(role: 'reviewer' | 'producer', profiles: RoleProfiles['reviewers'] | RoleProfiles['producers'], work: Work[], agents: { name?: string }[], records: { pending: any[]; completed: any[] }, sessions: Pick<DispatchSessions, 'failures' | 'retries'>, now: number): RoleConcurrencyReport {
  const all = [...records.completed, ...records.pending];
  const perProfile = profiles.map(profile => { const counted = profileSessions(profile, agents, all); return { profile: profile.name, agentName: profile.agentName, limit: counted.limit, running: counted.running.length, sessions: counted.running }; });
  const limit = perProfile.reduce((total, entry) => total + entry.limit, 0), running = perProfile.reduce((total, entry) => total + entry.running, 0);
  // How long an open request has waited for a slot, or null when something other than a slot holds it.
  const slotWait = (request: { id: string; requestedAt: string }): number | null => {
    const last = [...all].reverse().find(record => record.requestId === request.id);
    if (last && last.state === 'pending') return null;
    if (last && !['failed', 'expired'].includes(last.state)) return null;
    if (sessions.failures.some(failure => failure.requestId === request.id)) return null;
    const retry = sessions.retries?.find(entry => entry.requestId === request.id);
    if (retry) return retry.exhausted || (retry.nextAt && Date.parse(retry.nextAt) > now) ? null : Math.max(0, now - Date.parse(retry.nextAt ?? last?.closedAt ?? request.requestedAt));
    return last ? null : Math.max(0, now - Date.parse(request.requestedAt));
  };
  const waiting = work.filter(item => item.stage !== 'done' && item.autoDispatch).flatMap(item => {
    if (role === 'reviewer') { const review = item.autoDispatch!.review; return review?.state === 'requested' && review.provider === 'github' ? [{ item, request: review }] : []; }
    const implementers = new Set(implementerIdentities(item));
    if (!(profiles as RoleProfiles['producers']).some(profile => !implementers.has(profile.principal))) return [];
    return item.autoDispatch!.producers.filter(request => request.state === 'requested').map(request => ({ item, request }));
  }).flatMap(({ item, request }) => { const waitedMs = slotWait(request); return waitedMs === null ? [] : [{ work: item.key, requestId: request.id, group: request.group ?? null, waitedMs }]; }).sort((a, b) => b.waitedMs - a.waitedMs);
  const longest = waiting[0] ?? null;
  return { role, limit, running, free: Math.max(0, limit - running), waiting: waiting.length, longestWaitMs: longest?.waitedMs ?? null, longest, starved: limit > 0 && running >= limit && waiting.length > 0, profiles: perProfile };
}
/** A starved role is attention for the master: the limit and the wait, with what raises the one. */
export const concurrencyStarvedMs = 10 * 60_000;
export function concurrencyAttention(reports: RoleConcurrencyReport[]): AttentionItem[] {
  return reports.filter(report => report.starved && (report.longestWaitMs ?? 0) >= concurrencyStarvedMs).map(report => ({ subject: `${report.role} concurrency`,
    text: `${report.role} capacity is saturated: ${report.running} session${report.running === 1 ? '' : 's'} running against a limit of ${report.limit} (${report.profiles.map(entry => `${entry.profile} ${entry.running}/${entry.limit}`).join(', ')}), ${report.waiting} request${report.waiting === 1 ? '' : 's'} waiting for a slot, the longest (${report.longest!.work}${report.longest!.group ? ` ${report.longest!.group} proofs` : ''}) for ${Math.round(report.longestWaitMs! / 60_000)} minutes`,
    ...agentOwner('master', `Raise concurrency on a ${report.role} profile in .graphyard/master.json, or add a ${report.role} profile on another account (master ${report.role} add); master run adopts the change on its next tick and starts more sessions without a restart. See docs/onboarding.md#size-review-and-proof-capacity`) }));
}
export function buildMasterStatus(snapshot: { work: Work[]; now: string }, profiles: WorkerProfile[], agents: HerdrAgent[], credentialHealth: Record<string, { available: boolean; reason: string | null }> = {}, containment: Record<string, ContainmentAssessment> = {}, reviews: { pending: any[]; completed: any[] } = { pending: [], completed: [] }, baseBranch = 'main', controlPlane?: ControlPlaneStatus, sessions: DispatchSessions = noSessions, candidateConflicts: { report: Record<string, ConflictReport>; available: boolean; reason: string | null } = { report: {}, available: false, reason: 'Candidate conflicts were not probed' }, roles?: RoleProfiles, cliPath = 'graphyard') {
  const now = Date.parse(snapshot.now);
  const scheduling = dispatchSchedule(snapshot.work, now);
  const installation = controlPlaneAttention(controlPlane), registry = fleetStatus(controlPlane?.fleet);
  // Per-role concurrency (GY-107): sessions against the declared limit, and the queue at the gate.
  const concurrency = roles ? [roleConcurrency('reviewer', roles.reviewers, snapshot.work, agents, reviews, sessions, now), roleConcurrency('producer', roles.producers, snapshot.work, agents, sessions.producers, sessions, now)] : [];
  const concurrencyItems: AttentionItem[] = concurrencyAttention(concurrency).map(item => ({ ...item, ...classified('concurrency-starved') }));
  const workerSessions = profiles.map(profile => {
    const agent = agents.find(candidate => candidate.name === profile.agentName);
    const credential = credentialHealth[profile.name] ?? { available: true, reason: null };
    return { profile: profile.name, principal: profile.principal, agentName: profile.agentName, mode: profile.mode, state: agent?.agent_status ?? 'offline', pane: agent?.pane_id ?? null, cwd: agent?.foreground_cwd ?? agent?.cwd ?? null, contextPercent: agent?.tokens?.agent_watcher_context_pct ? Number(agent.tokens.agent_watcher_context_pct) : null, credential };
  });
  const placements = predictQueue(snapshot.work, now);
  // Each queued item's place in GitHub's own merge queue, as the control plane last read it (GY-258):
  // GitHub performs the merge, so this is where a queued item waits once every gate passes.
  const githubQueueRow = (work: Work) => work.observation?.githubQueue ? { github: { ...work.observation.githubQueue, summary: describeGitHubQueue(work) } } : {};
  const queueRows = placements.map(placement => { const work = snapshot.work.find(item => item.id === placement.id)!; return { ...queueRow(placement, describeQueueBinding(work, snapshot.work, new Date(now), placement)), ...githubQueueRow(work) }; });
  // The cause each row's attention was raised for, which is the fault kind its attention item carries.
  const causes = new Map<string, WorkAttentionCause>();
  const rows = snapshot.work.filter(work => work.stage !== 'done').map(work => {
    const placement = placements.find(entry => entry.id === work.id) ?? null;
    const active = !!work.lease && Date.parse(work.lease.expiresAt) > now;
    const profile = active ? profiles.find(item => item.principal === work.lease!.owner) : undefined;
    const session = profile ? workerSessions.find(item => item.profile === profile.name) : undefined;
    // The one session state (GY-172): the attempt's registered record, as every reader shows it.
    // Herdr's reading of the profile answers only for a session no launcher registered.
    const handle = active ? (work.sessions ?? []).find(entry => entry.kind === 'implementation' && entry.id === `${work.lease!.owner}:${work.lease!.epoch}`) : undefined;
    const recorded = handle ? sessionView(handle, new Date(now)) : null;
    const sessionState = handle && recorded ? recorded.live ? recorded.observed! : handle.state === 'running' ? `not seen since ${recorded.seenAt ?? handle.updatedAt}` : recorded.observed ?? 'finished' : session?.state ?? 'offline';
    const first = work.gates.find(gate => !gate.passed);
    const freshObservation = !!work.observation && now - Date.parse(work.observation.at) >= 0 && now - Date.parse(work.observation.at) < 120_000;
    const mergeable = freshObservation && work.stage === 'merge' && !!work.candidate && !!work.mergeAuthorization
      && work.mergeAuthorization.sha === work.candidate.sha && work.mergeAuthorization.baseSha === work.candidate.baseSha
      && work.mergeAuthorization.policyRevision === work.policyRevision
      && work.gates.every(gate => gate.passed) && !work.violations.length;
    const dwellMs = now - Date.parse(work.stageEnteredAt);
    const review = reviewState(work);
    const assessed = containment[work.id];
    const phase = containmentPhase(work, now);
    const quarantine = work.containmentQuarantine && phase
      ? { epoch: work.containmentQuarantine.epoch, owner: work.containmentQuarantine.owner, at: work.containmentQuarantine.at,
        // A live owner's containment is its running session; the grace window and settlement apply only once the lease lapses.
        phase: phase.state, lapsedAt: phase.state === 'live' ? null : phase.lapsedAt, graceRemainingMs: phase.state === 'grace' ? phase.remainingMs : null,
        hold: containmentHold(work, now)!,
        settleable: phase.state !== 'live' && (assessed?.settleable ?? false),
        refusals: phase.state === 'live' ? [containmentHold(work, now)!] : assessed?.refusals ?? ['Supervisor absence has not been verified on the registered host'],
        host: assessed?.host ?? work.workspaces.find(item => item.epoch === work.containmentQuarantine!.epoch)?.host ?? null,
        scope: work.containmentQuarantine.scope ?? null,
        // Each process the verification found holding the fence, with cmdline and cwd, so the
        // master reads what it would stop before it stops anything.
        held: assessed?.verification?.held ?? [],
        verifiedAt: assessed?.verification?.observedAt ?? null,
        // A refusal is only useful with the path that still works.
        attestation: phase.state === 'live' || assessed?.settleable ? null : containmentAttestation(work.key) }
      : null;
    const seconds = (ms: number) => `${Math.ceil(ms / 1000)}s`;
    const containmentAttention: [string, Parameters<typeof workAttentionOwner>[1]] | null = !quarantine || quarantine.phase === 'live' ? null
      : quarantine.settleable ? [`Containment quarantine from epoch ${quarantine.epoch} is verified settleable; run master settle-containment ${work.key}`, 'containment-settleable']
      : quarantine.phase === 'grace' ? [`Worker lease for epoch ${quarantine.epoch} lapsed at ${quarantine.lapsedAt}; containment grace window has ${seconds(quarantine.graceRemainingMs!)} remaining before supervisor absence can be verified`, 'containment-grace']
      : [`Containment quarantine from epoch ${quarantine.epoch} blocks dispatch: ${quarantine.lapsedAt ? `worker lease lapsed at ${quarantine.lapsedAt}, past the ${seconds(containmentGraceMs)} grace window; ` : ''}${quarantine.refusals[0]}`, 'containment'];
    const gaps = work.proofGaps ?? [];
    // Planned-file overlap holds nothing (dispatch is optimistic); an item beside another on the
    // same files shows what it runs concurrently with, so the overlap stays on the record.
    const concurrent = concurrentOverlap(work, snapshot.work, now);
    const conflictReport = candidateConflicts.report[work.key];
    const conflicts = work.submission && work.candidate ? { candidates: (conflictReport?.conflicts ?? []).map(conflict => conflict.key), files: conflictReport?.conflicts ?? [], unprobed: conflictReport?.unprobed ?? [], probed: !!conflictReport && candidateConflicts.available } : null;
    const dispatch = describeDispatch(work, reviews, sessions, now);
    const baseRefresh = pendingBaseRefresh(work), baseConflict = baseRefreshConflict(work);
    const refreshCarry = currentBaseRefreshCarry(work);
    // A branch found carrying another item's unlanded commits, with the restore the control plane
    // owes, requested or ran for it (GY-127); and an approval GitHub dismissed for a merge-base
    // change on an unchanged head that the control plane restored rather than re-requesting.
    const contaminated = branchContamination(work, snapshot.work);
    const restore = currentRestore(work);
    const contamination = contaminated || restore?.restore ? { head: contaminated?.head ?? restore!.restore!.contaminated, foreign: contaminated?.foreign ?? restore!.restore!.foreign, source: contaminated?.source ?? [],
      restore: restore?.restore ? { cause: restore.restore.cause, requested: restore.restore.requested, performedAt: restore.restore.performedAt, outcome: restore.restore.outcome, own: restore.restore.own, head: restore.head, conflict: restore.conflict } : null } : null;
    const restored = restoredApproval(work), baseDismissal = mergeBaseDismissal(work);
    const approvalRestored = restored ? { reviewer: restored.reviewer, reviewId: restored.reviewId ?? null, sha: restored.sha, dismissal: restored.dismissal, at: restored.at,
      line: `${restored.reviewer}'s approval of ${restored.sha.slice(0, 12)} was dismissed by GitHub for a merge-base change while the head was unchanged (${restored.dismissal.reason ?? 'reason unread'}${restored.dismissal.at ? ` at ${restored.dismissal.at}` : ''}); the control plane restored it as the binding approval, requested no review, spent no attempt, and re-posts it through the reviewer App before the merge` } : null;
    // A role with no account left is one line for the whole repository (`capacity` below), never a
    // launch refusal or a session retry repeated on every item that waits for it.
    const paused = new Set(standingCapacity(work).map(entry => entry.role));
    const stalledLaunch = [dispatch?.review, ...(dispatch?.producers ?? [])].find(request => request?.failure && !paused.has(request.failure.kind === 'review' ? 'reviewer' : 'producer'));
    const retrying = [dispatch?.review, ...(dispatch?.producers ?? [])].find(request => request?.retry && request.session && ['failed', 'expired'].includes(request.session.state) && !paused.has(request.group ? 'producer' : 'reviewer'));
    // A session re-prompted once and still not acknowledged is awaiting acknowledgement, not running.
    const unacknowledged = [dispatch?.review, ...(dispatch?.producers ?? [])].find(request => request?.session?.state === 'pending' && request.session.activity === 'awaiting acknowledgement' && request.session.repromptedAt);
    // An observed merge no execution authorized is not a candidate waiting for its queue tip: it
    // is named as the violation it is, with the recovery, and never as a gate refusal.
    // Its queue entry, when it still holds one, can never publish a speculative tip: the entry and
    // everything waiting behind it are named, with the exit (see merge-queue.ts unpublishableEntry).
    const dead = unpublishableEntry(work);
    // A merged item whose content the base branch does not hold is a reverted delivery, not an
    // ordinary unreconciled merge (GY-97): the row names the files missing from the base and the
    // merge that removed them, so nobody has to read a diff to learn the work is gone.
    const reverted = work.stage !== 'done' && work.observation?.merged ? work.observation.revertedDelivery ?? null : null;
    const merged = mergedWithoutAuthorization(work) || reverted ? { at: work.observation!.mergedAt ?? null, sha: work.observation!.mergeSha ?? null, violation: unauthorizedMergeViolation,
      refusal: refusedReconciliation(work)?.violation ?? null,
      ...(reverted ? { reverted: { base: reverted.base, files: reverted.files, removedBy: reverted.removedBy, partial: !!reverted.partial } } : {}),
      ...(dead && placement ? { queue: { sequence: dead.sequence, position: placement.position + 1, size: placement.size, unpublishable: true as const, behind: placements.filter(entry => entry.sequence > placement.sequence).map(entry => entry.key) } } : {}) } : null;
    const parked = parkedOnHuman(work) ? work.humanRequest! : null;
    const queueRefusal = work.observation?.merged ? null : work.observation?.githubQueue?.refused ?? null;
    const mergeRefusal = queueRefusal && queueRefusal.head === work.candidate?.sha ? queueRefusal : null;
    const [attention, cause]: [string | null, WorkAttentionCause | null] = containmentAttention ? containmentAttention
      : parked ? [`${work.key} is parked on a human-only decision (${humanDecisionLabel[parked.kind]}) since ${parked.at}: ${parked.needed} — ${parked.reason}. It holds no lease and delays nothing else`, 'human-request']
      : merged?.reverted ? [`${work.key} was merged on GitHub (${merged.sha?.slice(0, 12) ?? 'merge commit unknown'} at ${merged.at ?? 'an unrecorded time'}) and its content is not on the base branch: ${merged.reverted.files.length}${merged.reverted.partial ? ' or more' : ''} file${merged.reverted.files.length === 1 && !merged.reverted.partial ? '' : 's'} missing from base ${merged.reverted.base.slice(0, 12)} — ${merged.reverted.files.map(file => `${file.path} (${file.detail})`).join(', ')} — ${merged.reverted.removedBy
        ? `removed by merge ${merged.reverted.removedBy.mergeSha?.slice(0, 12) ?? 'commit unknown'} of ${merged.reverted.removedBy.key ? `${merged.reverted.removedBy.key}, ` : ''}pull request #${merged.reverted.removedBy.pr}${merged.reverted.removedBy.commit ? ` (commit ${merged.reverted.removedBy.commit.slice(0, 12)})` : ', whose head carried this item\'s commits without their content'}`
        : 'and the merge that removed them could not be identified from the branch history'}. This is a reverted delivery, not an unreconciled merge: nothing is delivered until the content is restored${merged.refusal ? `; the last reconciliation was refused — ${merged.refusal}` : ''}`, 'merged-reverted']
      : merged ? [`${work.key} was merged on GitHub (${merged.sha?.slice(0, 12) ?? 'merge commit unknown'} at ${merged.at ?? 'an unrecorded time'}) without a valid merge execution: ${merged.violation}. It is held at the merge stage, not waiting for its queue tip; ${merged.queue ? `its merge queue entry (sequence ${merged.queue.sequence}, position ${merged.queue.position} of ${merged.queue.size}) can never publish a speculative tip because the pull request is already merged${merged.queue.behind.length ? `, and ${merged.queue.behind.join(', ')} wait behind it` : ''}; ` : ''}${merged.refusal ? `the last reconciliation was refused — ${merged.refusal}; an operator may deliver it as operator-authorized by a decision citing that refusal` : `a two-party merge decision requested now reconciles it if every gate passed and every required proof was live at the merge cutoff${merged.queue ? ', and a refused one removes the entry without delivering' : ''}`}`, 'merged-unauthorized']
      // A branch carrying another item's unlanded commits blocks the candidate whatever else stands
      // (GY-127): the restore is the control plane's, and the row says whether it is owed, requested or ran.
      : contaminated && !(contamination?.restore && contamination.restore.performedAt && contamination.restore.head !== contaminated.head) ? [`${work.key} branch head ${contaminated.head.slice(0, 12)} carries the unlanded commits of ${contaminated.foreign.join(', ')} (${contaminated.source.includes('ejection') ? `a speculative tip published behind ${contaminated.foreign.join(', ')} and ejected from the merge queue` : 'found in its history by GitHub'}): kept, it is refused as an out-of-scope regression; landed, it would record ${contaminated.foreign.join(', ')} merged without ${contaminated.foreign.length === 1 ? 'its' : 'their'} content. ${contamination?.restore?.outcome === 'unrepairable' ? 'A restore found no own reviewed head under it: the foreign commits sit under something the control plane cannot move' : contamination?.restore && !contamination.restore.performedAt ? `A restore is requested (${contamination.restore.cause}) and runs on the next reconciliation` : work.queueEjection?.sha === contaminated.head ? 'The control plane restores it to its own reviewed head merged onto the base on the next reconciliation' : `graphyard master repair ${work.key} REASON restores it to its own reviewed head merged onto the base`}`, 'contaminated']
      : active && !['working', 'idle'].includes(sessionState) ? [`Assigned worker session is ${sessionState}`, 'session']
      : gaps.length ? [`No principal is authorized to produce ${gaps.join(', ')}; grant the proof name before dispatch`, 'proof-gap']
      : review?.exhausted ? [`Every configured reviewer profile is exhausted for the current candidate (${review.failedOver.map(entry => `${entry.profile}: ${entry.exhaustion}`).join(', ')})`, 'reviewer-exhausted']
      : stalledLaunch ? [`Automatic ${stalledLaunch.failure!.kind} launch for ${work.key} refused ${stalledLaunch.failure!.attempts} time(s): ${stalledLaunch.failure!.reason}`, stalledLaunch.failure!.kind === 'review' ? 'launch-review' : 'launch-producer']
      : retrying ? [`${retrying.group ? `Producer session for ${retrying.group} proofs` : 'Reviewer session'} of ${work.key} ${retrying.session!.state} after attempt ${retrying.retry!.attempts} of ${retrying.retry!.limit}: ${retrying.session!.resolution ?? 'no reason recorded'}; ${retrying.retry!.exhausted ? 'no further automatic attempt' : `next attempt at ${retrying.retry!.nextAt}`}`, retrying.group ? 'launch-producer' : 'launch-review']
      : unacknowledged ? [`${unacknowledged.group ? `Producer session for ${unacknowledged.group} proofs` : 'Reviewer session'} of ${work.key} (${unacknowledged.session!.agentName}) is awaiting acknowledgement: no activity since its launch at ${unacknowledged.session!.requestedAt}, re-prompted once at ${unacknowledged.session!.repromptedAt}; the loop records it as never started if it stays quiet`, unacknowledged.group ? 'launch-producer' : 'launch-review']
      : baseConflict ? [baseConflict, 'base-conflict']
      // An approval GitHub withdrew for a merge-base change is named with its time and commits (GY-145).
      : baseDismissal ? [mergeBaseDismissalAttention(work.key, baseDismissal), 'merge-base-dismissed']
      // An item the control plane is bringing onto a moved base is not waiting for anybody. It
      // used to be the commonest attention line on this list — one per open candidate, every
      // merge — and answering it cost a rework round for a change that was a clean fast-forward.
      // GitHub refused the control plane's merge request for this head: named with GitHub's reason,
      // never left as a silent wait (every merge once stalled on a refused auto-merge).
      : mergeRefusal ? [`GitHub refused the merge request for ${work.key} at ${mergeRefusal.head.slice(0, 12)} since ${mergeRefusal.at}: ${mergeRefusal.reason}`, 'merge-refused']
      : baseRefresh && !work.blocker ? [null, null]
      : work.blocker || dwellMs > 3_600_000 ? [first?.reasons[0] ?? `Work has remained at ${work.stage} for more than one hour`, 'gate'] : [null, null];
    const attentionOwner = cause ? workAttentionOwner(work, cause) : null;
    if (cause) causes.set(work.key, cause);
    return { key: work.key, title: work.title, stage: work.stage, owner: active ? work.lease!.owner : null, profile: profile?.name ?? null, session: session?.state ?? null, refusal: first ? { gate: first.name, reason: first.reasons[0] } : null, mergeable, review, dispatch, proofGaps: gaps, containment: quarantine, attention, attentionOwner, queue: placement ? queueRows.find(row => row.key === work.key) ?? null : null,
      // Set only for an item GitHub merged with no valid execution: the merge, the violation and
      // the last refused reconciliation, so the row reads as stuck rather than as a candidate.
      merged,
      // The two waits that stall only this item (GY-89): the open human-only request, and the
      // sessions that ran out of quota with any role that has no account left.
      humanRequest: parked ? { id: parked.id, kind: parked.kind, decision: humanDecisionLabel[parked.kind], needed: parked.needed, reason: parked.reason, requestedBy: parked.requestedBy, at: parked.at, waitedMs: Math.max(0, now - Date.parse(parked.at)), answer: answerCommand(work.key, parked) } : null,
      capacity: work.capacity ? { exhaustions: work.capacity.exhaustions.slice(-5), escalations: work.capacity.escalations } : null,
      // What the control plane is doing, or last did, about a base branch that moved under this
      // candidate: nobody is asked for a round while `pending` is set.
      base: baseRefresh || baseConflict || refreshCarry ? { pending: baseRefresh, conflict: baseConflict,
        refreshed: refreshCarry ? { from: refreshCarry.from.sha, head: refreshCarry.to.sha, base: refreshCarry.to.baseSha,
          approval: { carried: refreshCarry.approval.carried, reason: refreshCarry.approval.reason },
          evidence: refreshCarry.evidence.map(entry => ({ proof: entry.proof, carried: entry.carried, reason: entry.reason })) } : null } : null,
      // A branch carrying another item's unlanded commits and the restore for it (GY-127), and
      // an approval GitHub dismissed for a merge-base change that the control plane restored.
      contamination, restoredApproval: approvalRestored,
      scope: scopeBreadth(work.plannedFiles), overlap: { concurrent }, conflicts,
      // Execution versus wait so far, rework rounds and hand-offs, from the item's own timeline.
      speed: pipelineSpeed(work, now) };
  });
  const delivered = snapshot.work.filter(work => work.stage === 'done' && work.delivery && deploySmokeRequired(work.policy)).map(work => deliveredRow(work, now, baseBranch));
  // Every delivery no valid execution authorized, apart by how it was judged: reconciled — the
  // record at the merge cutoff satisfied every gate — or operator-authorized, where it did not
  // and an operator took responsibility (GY-94). Neither is mistaken for the other or for a routine merge.
  const deliveries = recoveredDeliveries(snapshot.work);
  // Merge-to-production over every delivery with an observed deployment, whether or not its
  // policy asked for a smoke proof, so the periodic measurement reads one number for the repository.
  const mergeToProduction = latencyPercentiles(snapshot.work.map(work => mergeToProductionMs(work)).filter((value): value is number => value !== null));
  // Submit→merge p50/p90 over every delivery with a recorded submission, judged against the
  // pipeline-speed target; the periodic measurement records this beside the production latency.
  const speed = pipelineSpeedSummary(snapshot.work, now);
  // Capacity, one line per spent role: the accounts, their resets, and every item that waits on it.
  const open = snapshot.work.filter(work => work.stage !== 'done');
  const capacity = quotaRoles.flatMap(role => {
    const waiting = open.filter(work => standingCapacity(work, role).length);
    if (!waiting.length) return [];
    const latest = waiting.map(work => standingCapacity(work, role)[0]).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    return [{ role, since: latest.at, retryAt: latest.retryAt, accounts: latest.accounts, waiting: waiting.map(work => work.key), line: `${describeCapacity(role, latest.accounts)}; waiting: ${waiting.map(work => work.key).join(', ')}` }];
  });
  const capacityItems: AttentionItem[] = capacity.map(entry => ({ subject: `${entry.role} capacity`, text: entry.line, ...classified('role-capacity'),
    ...agentOwner('master', `Nothing to run before ${entry.retryAt ?? 'an account reports quota again'}: the loop resumes ${entry.role} launches on its own. To restore capacity sooner, log another account in and add it with graphyard master environments --apply and graphyard master config accounts:PROFILE=…; buying quota or opening a provider account is the human's decision`) }));
  const humanRequests = openHumanRequests(snapshot.work, now);
  // The fleet's concurrency beside its idle workers: every open item in flight or dispatchable may
  // run at once — planned-file overlap holds nothing — so idle workers beside dispatchable items is
  // a dispatch shortfall, not serialization.
  const inFlightCount = snapshot.work.filter(work => inFlight(work, now)).length;
  const idle = workerSessions.filter(session => session.mode === 'launch' && session.credential.available && (session.state === 'offline' || session.state === 'idle') && !rows.some(row => row.owner === session.principal));
  const launchProfiles = workerSessions.filter(session => session.mode === 'launch').length;
  const fleet = { effective: inFlightCount + scheduling.order.length, inFlight: inFlightCount, dispatchable: scheduling.order.length, idleWorkers: idle.length, workers: launchProfiles,
    statement: `${inFlightCount + scheduling.order.length} item${inFlightCount + scheduling.order.length === 1 ? '' : 's'} could be in flight at once (${inFlightCount} in flight, ${scheduling.order.length} dispatchable; planned-file overlap holds nothing); ${idle.length} of ${launchProfiles} launch profile${launchProfiles === 1 ? '' : 's'} idle` };
  // A blocker whose remedy no launched session may run is Graphyard's own defect (GY-128).
  const remedies = unrunnableRemedies(snapshot.work, { cliPath, baseBranch, workerKinds: profiles.filter(profile => profile.mode === 'launch').flatMap(profile => profile.kind ? [profile.kind] : []) });
  const remedyItems: AttentionItem[] = remedies.map(entry => ({ subject: entry.key, text: entry.text, ...classified('unrunnable-remedy'),
    ...agentOwner('master', `Create a work item that lets the ${entry.role} run \`${entry.command}\` (or has the control plane perform it); the ${entry.role} harness rule ${entry.rule} denies it`) }));
  return { observedAt: snapshot.now,
    counts: { open: rows.length, ready: rows.filter(row => row.stage === 'ready').length, active: rows.filter(row => row.owner).length, attention: rows.filter(row => row.attention).length + remedyItems.length + capacityItems.length + concurrencyItems.length + installation.attention.length + registry.attentionItems.length, proofAuthorityGaps: rows.filter(row => row.proofGaps.length).length, mergeable: rows.filter(row => row.mergeable).length, reviewsPending: reviews.pending.length, producersPending: sessions.producers.pending.length,
      // Candidates the guarded merge could take once their gates pass, and the items GitHub already
      // merged without a valid execution, which are never candidates and wait on a reconciliation.
      mergeCandidates: rows.filter(row => row.stage === 'merge' && !row.merged).length, mergedUnreconciled: rows.filter(row => row.merged && !row.merged.reverted).length, revertedDeliveries: rows.filter(row => row.merged?.reverted).length,
      dispatchRequested: rows.reduce((total, row) => total + (row.dispatch ? (row.dispatch.review ? 1 : 0) + row.dispatch.producers.length : 0), 0), dispatchRunning: rows.reduce((total, row) => total + (row.dispatch ? [row.dispatch.review, ...row.dispatch.producers].filter(request => request?.session?.state === 'pending' && request.session.activity === 'running').length : 0), 0),
      dispatchAwaiting: rows.reduce((total, row) => total + (row.dispatch ? [row.dispatch.review, ...row.dispatch.producers].filter(request => request?.session?.state === 'pending' && request.session.activity === 'awaiting acknowledgement').length : 0), 0), reviewFailover: rows.filter(row => row.review?.failedOver.length).length, queued: placements.length,
      quarantined: rows.filter(row => row.containment && row.containment.phase !== 'live').length, settleableQuarantines: rows.filter(row => row.containment?.settleable).length,
      awaitingSmoke: delivered.filter(row => row.state === 'awaiting-deployment' || row.state === 'awaiting-smoke').length, postDeployFailures: delivered.filter(row => row.state === 'delivered-with-failure').length,
      reconciledDeliveries: deliveries.reconciled.length, operatorAuthorizedDeliveries: deliveries.operatorAuthorized.length,
      humanRequests: humanRequests.length, capacityExhausted: capacity.length, concurrencyStarved: concurrency.filter(report => report.starved).length, unrunnableRemedies: remedies.length, effectiveConcurrency: fleet.effective, idleWorkers: idle.length,
      contaminatedBranches: rows.filter(row => row.contamination && row.contamination.source.length).length, restoredApprovals: rows.filter(row => row.restoredApproval).length,
      // Closed without delivery (model/closure.ts): never open, never delivered, counted only here.
      closed: snapshot.work.filter(isClosed).length },
    // Every attention item with the role that resolves it and the next command, work items first.
    attentionItems: [...rows.flatMap(row => row.attention && row.attentionOwner ? [{ subject: row.key, text: row.attention, ...row.attentionOwner, ...classified(causes.get(row.key) ?? 'gate') }] : []), ...remedyItems, ...capacityItems, ...concurrencyItems, ...installation.attentionItems, ...registry.attentionItems] as AttentionItem[],
    // What waits on the human, longest first, with how to answer; the roles out of capacity; each
    // role's sessions against its concurrency limit with the longest wait for a slot; the
    // fleet's concurrency — every open item in flight or dispatchable — beside its idle workers;
    // and the blockers whose remedy no launched session may run.
    humanRequests, capacity, concurrency, effectiveConcurrency: fleet, unrunnableRemedies: remedies,
    closed: closedHistory(snapshot.work),
    workers: workerSessions, reviews, producers: sessions.producers, work: rows, queue: queueRows, delivered, deliveries, latency: { mergeToProduction }, speed, controlPlane: installation, fleet: registry.fleet,
    schedule: scheduling, conflicts: { available: candidateConflicts.available, reason: candidateConflicts.reason, ...sequenceAdvice(rows.filter(row => row.conflicts).map(row => ({ key: row.key, conflicts: row.conflicts!.candidates }))) } };
}

/**
 * What the merge queue's own pushes did to pull-request branches and their approvals (GY-127),
 * in one place: every branch found carrying another item's unlanded commits, with the restore
 * the control plane owes, requested or ran for it, and every approval GitHub dismissed for a
 * merge-base change on an unchanged head that the control plane restored instead of asking the
 * reviewer again. The rows carry the same facts under `contamination` and `restoredApproval`;
 * this is the list a master reads before it wonders why a reviewer approved the same commit twice.
 */
export function branchReport(rows: ReturnType<typeof buildMasterStatus>['work']) {
  const contaminated = rows.flatMap(row => row.contamination ? [{ key: row.key, head: row.contamination.head, foreign: row.contamination.foreign, source: row.contamination.source,
    restore: row.contamination.restore ? { cause: row.contamination.restore.cause, requestedBy: row.contamination.restore.requested?.by ?? null, performedAt: row.contamination.restore.performedAt, outcome: row.contamination.restore.outcome, own: row.contamination.restore.own, head: row.contamination.restore.head } : null,
    line: row.contamination.restore?.outcome === 'restored' && row.contamination.restore.head !== row.contamination.head
      ? `${row.key}: head ${row.contamination.head.slice(0, 12)} carried ${row.contamination.foreign.join(', ')}; restored to own reviewed head ${row.contamination.restore.own?.slice(0, 12) ?? '(unknown)'} merged onto the base as ${row.contamination.restore.head!.slice(0, 12)}`
      : row.contamination.restore?.outcome === 'conflict' ? `${row.key}: head ${row.contamination.head.slice(0, 12)} carried ${row.contamination.foreign.join(', ')}; reset to own reviewed head ${row.contamination.restore.own?.slice(0, 12) ?? '(unknown)'}, whose merge onto the base conflicts and is the worker's`
      : row.contamination.restore?.outcome === 'unrepairable' ? `${row.key}: head ${row.contamination.head.slice(0, 12)} carries ${row.contamination.foreign.join(', ')} under something the control plane cannot move; request rework`
      : row.contamination.restore ? `${row.key}: head ${row.contamination.head.slice(0, 12)} carries ${row.contamination.foreign.join(', ')}; a ${row.contamination.restore.cause} restore is requested and runs on the next reconciliation`
      : `${row.key}: head ${row.contamination.head.slice(0, 12)} carries ${row.contamination.foreign.join(', ')}; ${row.attention ?? 'a restore is owed'}` }] : []);
  const restoredApprovals = rows.flatMap(row => row.restoredApproval ? [{ key: row.key, reviewer: row.restoredApproval.reviewer, sha: row.restoredApproval.sha, reason: row.restoredApproval.dismissal.reason, at: row.restoredApproval.at, line: `${row.key}: ${row.restoredApproval.line}` }] : []);
  return { contaminated, restoredApprovals };
}
/**
 * The dispatch plan the durable loop and `master dispatch` follow: ready items in the order they
 * would be offered (smallest planned scope first within a priority), and the broad scopes that
 * make a weak change-scope contract. Nothing is held for planned-file overlap: dispatch is
 * optimistic, and the merge queue and a sync round integrate whichever overlapping item lands second.
 */
export function dispatchSchedule(work: Work[], now: number) {
  const ready = work.filter(item => dispatchable(item, now)).sort(dispatchOrder);
  return { order: ready.map(item => ({ key: item.key, priority: item.priority, scope: scopeBreadth(item.plannedFiles) })),
    highConflict: ready.filter(item => scopeBreadth(item.plannedFiles).highConflict).map(item => ({ key: item.key, broad: scopeBreadth(item.plannedFiles).broad })) };
}
/** Fewest conflicts first: the order that forces the fewest re-integration rounds on the rest. */
export function sequenceAdvice(candidates: { key: string; conflicts: string[] }[]) {
  const sequence = [...candidates].sort((a, b) => a.conflicts.length - b.conflicts.length || a.key.localeCompare(b.key)).map(entry => entry.key);
  const conflicting = candidates.filter(entry => entry.conflicts.length);
  return { sequence, conflicting: conflicting.map(entry => ({ key: entry.key, conflicts: entry.conflicts })) };
}

/**
 * The deliveries that did not come through an authorized merge execution, each with the decision
 * it rests on. A reconciled delivery cites the pre-merge snapshot that satisfied every gate; an
 * operator-authorized one states that no execution authorized the merge, names the operator and
 * both reasons, and lists what the record lacked. The item's own `delivery` carries the same
 * record under `reconciliation` or `operatorAuthorization`; the ledger keeps `merge.reconciled` or
 * `merge.operator-authorized`.
 */
export function recoveredDeliveries(work: Work[]) {
  const done = work.filter(item => item.stage === 'done' && item.delivery) as (Work & { delivery: NonNullable<Work['delivery']> & { reconciliation?: any; operatorAuthorization?: any } })[];
  const cite = (item: typeof done[number], record: any) => ({ key: item.key, title: item.title, mergeSha: item.delivery.mergeSha, mergedAt: item.delivery.mergedAt, decision: record.decision as string,
    requestedBy: record.requestedBy as string, approvedBy: record.approvedBy as string, reason: record.reason as string, approvalReason: record.approvalReason as string, cutoff: record.cutoff as string, snapshotRevision: record.snapshotRevision as number });
  return {
    reconciled: done.filter(item => item.delivery.reconciliation).map(item => ({ ...cite(item, item.delivery.reconciliation), authorization: 'reconciled' as const, judgement: item.delivery.reconciliation.judgement as string })),
    operatorAuthorized: done.filter(item => item.delivery.operatorAuthorization).map(item => ({ ...cite(item, item.delivery.operatorAuthorization), authorization: 'operator' as const, execution: null,
      operator: item.delivery.operatorAuthorization.operator as string, refusedDecision: item.delivery.operatorAuthorization.refusedDecision as string, unmet: item.delivery.operatorAuthorization.unmet as string[], judgement: item.delivery.operatorAuthorization.judgement as string })),
  };
}
/**
 * The second confidence layer, per delivered item that asked for it: what the release served, what
 * the trusted producer found, and — on a failure — exactly what to roll back. Failures stay listed;
 * nothing here ages out or is cleared by a later delivery.
 */
function deliveredRow(work: Work, now: number, baseBranch: string) {
  const { mergedAt, mergeSha, deployment, smoke } = work.delivery!;
  return { key: work.key, title: work.title, mergedAt, mergeSha, state: deliveryState(work)!,
    deployment: deployment ? { sha: deployment.sha, covers: deployment.covers, source: deployment.source, observedAt: deployment.observedAt } : null,
    smoke: smoke ? { result: smoke.result, sha: smoke.sha, producer: smoke.producer, at: smoke.at, executed: smoke.executed, skipped: smoke.skipped, url: smoke.url ?? null } : null,
    postDeployMs: postDeployMs(work, now), productionLatencyMs: productionLatencyMs(work), mergeToProductionMs: mergeToProductionMs(work), rollback: rollbackGuidance(work, baseBranch) };
}
/** Time from the accepted merge to the observed deployment covering it: merge-to-production latency. */
export function mergeToProductionMs(work: Work): number | null {
  const observedAt = work.delivery?.deployment?.observedAt;
  if (work.stage !== 'done' || !observedAt) return null;
  const value = Date.parse(observedAt) - Date.parse(work.delivery!.mergedAtRepository ?? work.delivery!.mergedAt);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
/** Nearest-rank percentiles over the measured deliveries, for the periodic measurement. */
export function latencyPercentiles(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (percentile: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile / 100) - 1))] : 0;
  return { count: sorted.length, p50Ms: at(50), p90Ms: at(90) };
}

/**
 * One queue entry as the master reads it. `binding` says, per entry, whether its review and each
 * required proof bind the published tip exactly, were carried across a Graphyard-authored tip or a
 * tree-identical base advance, or must be produced afresh — and the recorded reason for each.
 */
function queueRow(placement: QueuePlacement, binding: QueueBindingReport | null) {
  return { key: placement.key, position: placement.position + 1, size: placement.size, predictedBase: placement.predictedBase,
    predictedTip: placement.tip, validated: placement.current, waitMs: placement.waitMs, waitMinutes: Math.floor(placement.waitMs / 60_000),
    enqueuedAt: placement.enqueuedAt, ahead: placement.predecessors, skipped: placement.skipped ?? [], passedOver: placement.passedOver ?? null, reasons: placement.reasons, binding };
}
