// Concern: routine decisions — standing verdicts, decision reasons and the approver step.
import { type Work, type AgentReview, reviewProviderOf, standingEscalations, leaseLossEpoch } from '../model.js';
import { routableScopeRequest, scopeDecisionBinding, scopeDecisionReason } from '../model/scope.js';
import { baseRefreshConflict, threadsAwaitReview, blockingThreads, type ReviewThread, describeThread } from '../merge-queue.js';
import { guardBroadScope, type MasterConfig, type ContainmentAssessment, containmentPhase, type HerdrAgent } from '../master.js';
import { actionDetailMax, type ApprovalWatch, message } from './state.js';

// ---- Routine decisions ---------------------------------------------------------------------
/*
 * The pipeline used to stop here. A verdict landed, a base conflicted, a supervisor died — and
 * nothing moved until a master session happened to look. Each of those is a routine decision with
 * one correct answer, so the loop makes it: it requests the decision with the master's own
 * operator-agent identity and launches the independent approver session for it. It never approves
 * its own request, never weakens a requirement, and never touches a worker or producer credential;
 * the separation the server enforces is unchanged, and only the waiting is gone.
 */

export interface StandingVerdict { reviewer: string; at: string; reason: string }
/**
 * The change request standing against the exact current candidate. Observations keep one review
 * per reviewer, so a CHANGES_REQUESTED entry on the head is the reviewer's latest word on it; an
 * agent or Codex provider records `verdict: 'changes-requested'` on the head instead. Either way
 * the head cannot progress, and the item is waiting for a rework round nobody has asked for.
 *
 * `approved: false` alone is never a verdict. The observers report it for a review not yet
 * dispatched, one still running, a retry, an unready pull request and exhausted profiles, and a
 * submission ends the worker's lease — so reading it as a verdict would send a head nobody has
 * reviewed back to a worker on the cycle after it was submitted, and skip its proofs.
 */
/**
 * The binding `exactApproval` demands of an approval, demanded of a change request too: the verdict
 * answers the request Graphyard recorded for this candidate, base and policy revision, under the
 * provider the policy names. A verdict left over from an earlier request is not the head's.
 */
function agentVerdictBindsRequest(work: Work, agent: AgentReview): boolean {
  const candidate = work.candidate!, request = work.reviewRequest;
  return agent.provider === reviewProviderOf(work.policy) && !!request && request.commentId === agent.requestId
    && request.sha === candidate.sha && request.baseSha === candidate.baseSha && request.policyRevision === work.policyRevision;
}
export function standingVerdict(work: Work): StandingVerdict | null {
  const candidate = work.candidate, observation = work.observation;
  if (!work.submission || work.reworkRequested || !candidate || !observation) return null;
  if (observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha) return null;
  const review = observation.reviews.find(entry => entry.sha === candidate.sha && entry.state === 'CHANGES_REQUESTED');
  if (review) return { reviewer: review.reviewer, at: review.submittedAt ?? observation.at, reason: `${review.reviewer} requested changes on ${review.sha.slice(0, 12)}` };
  const agent = observation.agentReview;
  if (agent && agent.sha === candidate.sha && !agent.approved && agent.verdict === 'changes-requested' && agentVerdictBindsRequest(work, agent))
    return { reviewer: agent.profile ?? agent.provider, at: agent.completedAt ?? observation.at, reason: `${agent.profile ?? agent.provider} requested changes on ${agent.sha.slice(0, 12)}: ${agent.reason}` };
  return null;
}

/**
 * GY-144. Rework throws away a current review and its proofs, so it is asked for only on a GitHub
 * observation that still describes the item: one taken within the two minutes the merge gate
 * trusts, while GitHub answers. During a rate-limit pause the control plane cannot observe, and
 * a worker may meanwhile have synced, pushed and submitted a green head the last observation
 * never saw; a verdict or conflict read from that observation is about a head the branch has
 * moved past. The loop waits for a fresh observation and decides from that.
 */
export const reworkObservationMaxAgeMs = 120_000;
export interface GitHubPause { until: string }
/**
 * Whether the control plane's GitHub client is paused, read from the observation jobs it refused:
 * a paused client refuses every request with "GitHub requests paused until <time>", and the job
 * keeps that error until it next runs. The latest pause still in the future is the one standing.
 */
export function githubPause(jobs: readonly { error?: string | null }[] | undefined, now: number): GitHubPause | null {
  let until = 0;
  for (const job of jobs ?? []) {
    const at = Date.parse(/requests paused until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(job.error ?? '')?.[1] ?? '');
    if (Number.isFinite(at) && at > now && at > until) until = at;
  }
  return until ? { until: new Date(until).toISOString() } : null;
}
/** What a rework request records of the observation it was decided from, so an approver can see whether the item has moved since. */
export const observedFrom = (work: Work) => work.observation
  ? `[Decided from the GitHub observation taken at ${work.observation.at} of candidate ${work.observation.candidate.sha}; if the item has moved since, this request no longer describes it.]`
  : '[Decided with no GitHub observation of the item.]';
/**
 * Why a rework request must wait for a fresh observation, or null when the one on the item may be
 * decided from. The reason names the stale observation — its time and head — and never its age,
 * so it reads the same on every cycle it stands.
 */
export function reworkObservationWait(work: Work, now: number, pause: GitHubPause | null): string | null {
  const observation = work.observation;
  if (!observation) return `${work.key}: rework waits for a GitHub observation of the item; there is none to decide from`;
  const seen = `the last GitHub observation (taken at ${observation.at} of head ${observation.candidate.sha.slice(0, 12)})`;
  if (pause) return `${work.key}: rework waits for a fresh GitHub observation — GitHub requests are paused until ${pause.until}, so ${seen} is a stale observation that may describe a head the branch has moved past`;
  const age = now - Date.parse(observation.at);
  if (!(Number.isFinite(age) && age < reworkObservationMaxAgeMs)) return `${work.key}: rework waits for a fresh GitHub observation — ${seen} is a stale observation, older than two minutes, and the branch may have moved past that head`;
  return null;
}

export const routineDecisionActions = ['rework', 'recover', 'merge', 'resolve', 'requirements'] as const;
export type RoutineDecisionAction = typeof routineDecisionActions[number];
/** `input` is what the decision names beyond what `decisionInput` derives from the item (a resolve's trigger). */
/** `escalation` is the one standing escalation a resolve settles: a standing request for any other is not this decision. */
/** `scope` is the worker request a `requirements` decision answers; `input.answers` binds the decision to it. */
export interface RoutineDecision { action: RoutineDecisionAction; reason: string; binding: string; input?: Record<string, unknown>; escalation?: { trigger: string; at: string }; scope?: NonNullable<ApprovalWatch['scope']> }
/**
 * Whether two decisions answer the same scope request. Compared field by field: the ledger keeps
 * the input as jsonb, which does not keep key order, so a serialised comparison never matches.
 */
export const sameAnswers = (a: any, b: any) => !a || !b ? !a && !b : a.epoch === b.epoch && a.at === b.at;
/**
 * The scope decision one item needs right now, or null (GY-176). A worker's additive request the
 * implication rule refused and no review finding grounds (`judged`: the loop has read the findings
 * for this request and policy revision and they named none of it) is put to the independent
 * approver as a `requirements` decision the master's operator-agent identity requests: the same
 * additive revision `master scope` applies, so an approved one keeps the worker's lease. A
 * widening that introduces a root-level directory is requested as the broad-scope exception, and
 * the approver grants it only with a stated reason. Unlike rework it attests nothing about a
 * stopped worker: the worker is live and waiting on the answer.
 */
export function scopeRoutineDecision(work: Work, now: number, judged: boolean): RoutineDecision | null {
  if (!judged || work.stage === 'done') return null;
  const routable = routableScopeRequest(work, now);
  if (!routable) return null;
  const { request, paths, plannedFiles } = routable;
  let broad: string | null = null;
  try { guardBroadScope({ ...work, plannedFiles }, request.reason, { allow: false, command: 'the loop', existing: work.plannedFiles }); }
  catch (error) { broad = `${guardBroadScope({ ...work, plannedFiles }, 'the approver grants it only with a stated reason', { allow: true, command: 'the loop', existing: work.plannedFiles })} (${message(error)})`; }
  return { action: 'requirements', binding: scopeDecisionBinding(request), input: { plannedFiles, answers: { epoch: request.epoch, at: request.at } }, reason: scopeDecisionReason(work.key, request, work.criteria, paths, broad),
    scope: { epoch: request.epoch, at: request.at, requestedBy: request.requestedBy, paths: paths.slice(0, 50).map(path => path.slice(0, 500)) } };
}
/**
 * The decision one item needs right now, or null. Rework returns a head nothing can carry forward
 * — a standing verdict, or a base branch Graphyard could not merge in — to a fresh attempt.
 * Recovery releases a delivered item whose supervisor is still quarantined. A merge decision is
 * needed only where automatic merging is off, and then for the exact candidate that is mergeable.
 */
export function routineDecision(work: Work, config: Pick<MasterConfig, 'autoMerge'>, now: number, assessment?: ContainmentAssessment | null): RoutineDecision | null {
  const needed = neededDecision(work, config);
  if (!needed) return null;
  if (needed.action === 'merge') return needed;
  // A lease-loss a newer attempt superseded rests on the record, not on this host: see supersededLeaseLoss.
  if (needed.action === 'resolve' && supersededLeaseLoss(work)?.superseded) return needed;
  const stopped = workerStopped(work, now, assessment);
  // The grounds travel with the request: the approver cannot verify this host, so it is told
  // exactly what the requester verified and judges the attestation on that.
  return stopped.stopped ? { ...needed, reason: `${needed.reason} The previous worker is stopped: ${stopped.grounds}.` } : null;
}
/** What the item calls for, before asking whether the loop may attest that its worker is stopped. */
export function neededDecision(work: Work, config: Pick<MasterConfig, 'autoMerge'>): RoutineDecision | null {
  if (work.stage === 'done') {
    return work.containmentQuarantine
      ? { action: 'recover', reason: `${work.key} is delivered and still fenced by its epoch ${work.containmentQuarantine.epoch} containment quarantine; recovery releases it without touching the delivery.`, binding: String(work.containmentQuarantine.epoch) } : null;
  }
  // Like a verdict, a conflict keeps matching the head it was found on until a new one is pushed,
  // and the engine's `rework` does not clear it: once the round is requested the item needs a
  // worker, not a second decision, even when that round's worker dies before pushing.
  const conflict = work.reworkRequested ? null : baseRefreshConflict(work);
  // A rework binding names its grounds as well as the head: a refused request on one ground (the
  // approver judged it premature) must not bar the same head's rework on another. On 2026-09-24
  // GY-163's thread rework was refused before its reviewer had judged the head; the reviewer then
  // requested changes, and the loop never asked again because both keyed on the head alone.
  if (conflict) return { action: 'rework', reason: `${work.key}: ${conflict}. Only a fresh attempt can resolve it, so the candidate returns to a worker.`, binding: `${work.candidate!.sha}:conflict` };
  const verdict = standingVerdict(work);
  if (verdict) return { action: 'rework', reason: `${work.key}: ${verdict.reason}. The verdict stands against the current head, so the item returns to a worker for the next round.`, binding: `${work.candidate!.sha}:verdict:${verdict.reviewer}` };
  // Unresolved review threads block the provider's merge (GY-139) whatever the review state that
  // opened them — a bot's COMMENTED review leaves no verdict, so without this the item waited on a human.
  // The review of the current head judges those threads first: its approval names the ones fixed and
  // the loop resolves them, so a rework requested before it settles invalidated the review that
  // would have cleared them, and the same open threads carried to the next head — without end.
  const threads = !work.reworkRequested && work.candidate && !threadsAwaitReview(work, Date.parse(work.observation?.at ?? '')) ? blockingThreads(work) : [];
  if (threads.length) return { action: 'rework', reason: `${work.key}: ${threadReworkSummary(work.candidate!.sha, threads)}. The findings stand against the current head, so the item returns to a worker to address them; the next review names the threads it verified fixed and the loop resolves them.`,
    binding: `${work.candidate!.sha}:threads:${threads.map(thread => thread.id ?? `${thread.path}:${thread.line}`).sort().join(',')}` };
  // A lease-loss the control plane raised is operational: once the lost attempt can no longer act,
  // settling it is a routine two-party decision, not a wait on a human master session (GY-161,
  // 2026-09-24: its first worker exited five minutes in, a new attempt took the item, and the
  // standing escalation would have refused the merge until somebody asked for the resolution).
  const lost = supersededLeaseLoss(work);
  if (lost) return { action: 'resolve', input: { trigger: 'lease-loss' }, escalation: { trigger: 'lease-loss', at: lost.escalation.at }, binding: `lease-loss:${lost.epoch}:${lost.escalation.at}`,
    reason: `${work.key}: the control plane raised a lease-loss for epoch ${lost.epoch} at ${lost.escalation.at} (${lost.escalation.reason}). ${lost.evidence}Nothing from the lost attempt can act or merge. Resolving clears only this concern: it decides no gate and ships nothing.` };
  if (!config.autoMerge && mergeableCandidate(work)) return { action: 'merge', reason: `${work.key}: every gate passes for candidate ${work.candidate!.sha.slice(0, 12)} and automatic merging is off, so the merge needs an approved decision.`, binding: work.candidate!.sha };
  return null;
}
/**
 * The standing control-plane lease-loss the loop may ask to settle, and why. `superseded` when a
 * newer attempt took the item: a claim needs the old lease ended, and a newer attempt's containment
 * fence can only be raised once the lost epoch's fence was lowered, so the record alone shows the
 * lost attempt can no longer act. Otherwise the item is between attempts, and the request also
 * rests on this host verifying the worker stopped (`workerStopped`, applied in `routineDecision`).
 * A lead-raised concern, another trigger, or a lost epoch whose fence still stands is never asked.
 */
export function supersededLeaseLoss(work: Work): { escalation: ReturnType<typeof standingEscalations>[number]; epoch: number; superseded: boolean; evidence: string } | null {
  if (work.stage === 'done') return null;
  for (const escalation of standingEscalations(work)) {
    const epoch = leaseLossEpoch(escalation);
    if (escalation.trigger !== 'lease-loss' || escalation.actor !== 'graphyard' || epoch === null) continue;
    const fence = work.containmentQuarantine;
    if (fence && fence.epoch <= epoch) continue;
    // Only the latest attempt's own lease or submission shows it: a submission survives the rework
    // claim that follows it, so an older one would vouch for a later attempt that lapsed unexplained
    // (its lease-loss suppressed as a repeat of this one) and resolving would erase that loss too.
    const newer = work.epoch > epoch && (work.lease && work.lease.epoch === work.epoch ? `epoch ${work.lease.epoch} is held by ${work.lease.owner}`
      : work.submission && work.submission.epoch === work.epoch ? `epoch ${work.submission.epoch} submitted PR #${work.submission.pr}` : null);
    if (newer) return { escalation, epoch, superseded: true, evidence: `A newer attempt superseded it: ${newer}, a claim is granted only after the epoch ${epoch} lease has ended, and ${fence ? `the containment fence now standing belongs to epoch ${fence.epoch}, so the epoch ${epoch} fence was lowered` : 'no containment fence stands'}. ` };
    if (work.epoch === epoch && (!work.lease || work.lease.epoch !== epoch)) return { escalation, epoch, superseded: false, evidence: `No newer attempt holds the item. ` };
  }
  return null;
}
/**
 * Whether a standing resolve decision settles exactly this escalation: the same trigger, and — when
 * the control plane reports the pin it was requested against — the same raising of it.
 */
export function resolveCovers(standing: { input: any; pin?: { escalations?: { trigger: string; at: string }[] } | null }, escalation: { trigger: string; at: string }): boolean {
  if (standing.input?.trigger !== escalation.trigger) return false;
  return !standing.pin?.escalations || standing.pin.escalations.some(entry => entry.trigger === escalation.trigger && entry.at === escalation.at);
}
/** The control plane's bound on a decision's reason (`src/model/approval.ts`); a longer one is refused on every retry. */
export const decisionReasonMax = 2000;
/** How many unresolved threads a rework reason names; the binding still carries every one, and the worker reads them all from the pull request. */
const reworkThreadsNamed = 5;
/**
 * The unresolved threads a rework request names, bounded: their authors and paths are contributor
 * text of any length and count, and a reason past the control plane's bound is refused on every
 * retry, so the item would never reach its approver or its rework worker.
 */
export function threadReworkSummary(sha: string, threads: ReviewThread[]): string {
  const named = threads.slice(0, reworkThreadsNamed).map(thread => { const text = describeThread(thread); return text.length > 120 ? `${text.slice(0, 119)}…` : text; });
  const more = threads.length - named.length;
  return `Branch protection requires conversation resolution and ${threads.length} review thread${threads.length === 1 ? ' is' : 's are'} unresolved on ${sha.slice(0, 12)}: ${named.join('; ')}${more ? `; and ${more} more on the pull request` : ''}. GitHub blocks the merge until each is resolved; rework the candidate to address the findings, never dismiss them`;
}
/**
 * A decision reason within the control plane's bound. What the requester adds around the loop's own
 * grounds — the observation it decided from, the refusals it answers — is kept whole, because the
 * server reads the cited refusals from it; the grounds are shortened to make room.
 */
export function fitDecisionReason(prefix: string, grounds: string, suffix: string): string {
  const room = decisionReasonMax - prefix.length - suffix.length;
  return prefix + (grounds.length <= room ? grounds : `${grounds.slice(0, Math.max(0, room - 1))}…`) + suffix;
}
/**
 * An action detail within its bound. A scope request carries up to 50 paths of up to 500 characters,
 * so a detail that lists them — or quotes an error that does — is cut, never left to fail record()
 * after the action it records has already happened. record() applies it to every detail it stores.
 */
export function boundDetail(detail: string, max = actionDetailMax): string {
  return detail.length <= max ? detail : `${detail.slice(0, max - 1)}…`;
}

/**
 * Whether a detail differs from the one an action already stores. record() stores the bounded form,
 * so a stable detail over the bound compares equal and is not re-recorded every cycle (GY-179).
 */
export function detailChanged(previous: { detail: string } | undefined, detail: string): boolean {
  return previous?.detail !== boundDetail(detail);
}

/** Paths named in a detail: every one while short, else the first few and a count of the rest. */
export function namePaths(paths: readonly string[], room = 600): string {
  const named: string[] = [];
  let used = 0;
  for (const path of paths) {
    const text = path.length > 200 ? `${path.slice(0, 199)}…` : path;
    if (named.length && used + text.length + 2 > room) break;
    named.push(text);
    used += text.length + 2;
  }
  const more = paths.length - named.length;
  return `${paths.length} file${paths.length === 1 ? '' : 's'} (${named.join(', ')}${more ? ` and ${more} more` : ''})`;
}
/** The least of its own grounds a rework request keeps beside the refusals it cites; below it the request would not say why. */
export const reworkGroundsMin = 160;
/**
 * A rework reason that cites every refused rework decision on the item — the server refuses a
 * request of the same input unless its reason names each one by id — within the control plane's
 * bound. The citations are written out in prose while they leave the grounds room, then as a bare
 * id list; when even that leaves the grounds less than `reworkGroundsMin`, no reason can satisfy
 * both the bound and the server's check, and this is null: the loop escalates rather than sending a
 * request the server refuses on every retry.
 */
export function reworkDecisionReason(prefix: string, grounds: string, refused: string[]): string | null {
  if (!refused.length) return fitDecisionReason(prefix, grounds, '');
  const prose = ` This rests on different grounds from refused rework decision${refused.length === 1 ? '' : 's'} ${refused.join(', ')}, which ${refused.length === 1 ? 'was' : 'were'} judged on earlier grounds.`;
  const bare = ` Answers refused rework decisions ${refused.join(' ')}.`;
  const suffix = [prose, bare].find(text => decisionReasonMax - prefix.length - text.length >= Math.min(reworkGroundsMin, grounds.length));
  return suffix === undefined ? null : fitDecisionReason(prefix, grounds, suffix);
}
/**
 * Whether the loop may attest that the item's previous worker is stopped. `rework` and `recover`
 * carry that attestation and the engine lowers the containment fence on it, so it rests only on
 * what was verified: no lease is held, and either no fence stands — the worker's own supervisor
 * settled it at exit, or this loop settled it after verifying the supervisor gone — or this host's
 * probe verified the supervisor gone on the snapshot this cycle acts on. A fence in its grace
 * window is waited out. A lapsed fence this host could not verify is `unverified`: the decision is
 * withheld and escalated, never requested on an attestation nobody checked.
 */
export function workerStopped(work: Work, now: number, assessment?: ContainmentAssessment | null): { stopped: boolean; grounds: string; unverified: string | null } {
  if (work.lease && Date.parse(work.lease.expiresAt) > now) return { stopped: false, grounds: '', unverified: null };
  const quarantine = work.containmentQuarantine;
  if (!quarantine) return { stopped: true, grounds: `${work.key} holds no lease and no containment fence stands for it`, unverified: null };
  if (containmentPhase(work, now)?.state !== 'lapsed') return { stopped: false, grounds: '', unverified: null };
  if (assessment?.settleable && assessment.epoch === quarantine.epoch)
    return { stopped: true, grounds: `its lease and launch authority have lapsed, and the master loop verified on ${assessment.host ?? 'the registered host'} that the supervisor of epoch ${quarantine.epoch} is gone`, unverified: null };
  return { stopped: false, grounds: '', unverified: assessment?.refusals.length ? assessment.refusals.join('; ') : `no host verification of the epoch ${quarantine.epoch} supervisor was possible from this loop` };
}
/** The decision an item needs but the loop will not request, because the stopped worker is unverified. */
export function withheldDecision(work: Work, config: Pick<MasterConfig, 'autoMerge'>, now: number, assessment?: ContainmentAssessment | null): { action: RoutineDecisionAction; reason: string } | null {
  const needed = neededDecision(work, config);
  if (!needed || needed.action === 'merge' || needed.action === 'resolve' && supersededLeaseLoss(work)?.superseded) return null;
  const unverified = workerStopped(work, now, assessment).unverified;
  return unverified ? { action: needed.action, reason: `${work.key} needs a ${needed.action} decision, but it attests that the previous worker is stopped and that is not verified: ${unverified}` } : null;
}

// ---- The approver a decision is waiting on -------------------------------------------------
/*
 * A requested decision changes nothing until an approver judges it, and the approver is a launched
 * session: it can die, drop its prompt, hit an account limit, decline, or hang. Each cycle therefore
 * reads the decision back from the control plane and the session back from Herdr, and takes the one
 * step that follows. Launches are bounded, so a decision no session will judge ends as an escalation
 * and an actionable silence rather than as a relaunch every few minutes forever.
 */
export const approverJudgeBoundMs = 600_000, approverSettleMs = 60_000, maxApproverLaunches = 3, maxApproverCloses = 3, maxDecisionRequests = 3;
export type ApprovalStep =
  | { step: 'wait'; detail: string }
  | { step: 'settled'; detail: string }
  | { step: 'refused'; detail: string }
  | { step: 'rerequest'; detail: string }
  | { step: 'relaunch'; detail: string }
  | { step: 'exhausted'; detail: string };
export function approvalStep(watch: ApprovalWatch, decision: { state: string; outcome?: string | null; refusal?: { approver: string; reason: string } | null } | null | undefined,
  sessions: { agents: HerdrAgent[]; available: boolean }, now: number): ApprovalStep {
  const label = `${watch.action} decision ${watch.decision} on ${watch.work}`;
  // `undefined`: the history could not be read this cycle. Nothing is concluded from that.
  if (decision === undefined) return { step: 'wait', detail: `The decision history of ${watch.work} could not be read; ${label} is looked at again next cycle` };
  if (decision === null) return { step: 'rerequest', detail: `The control plane no longer holds ${label}` };
  if (decision.state === 'applied') return { step: 'settled', detail: `The approver applied ${label}` };
  // A refusal is the approver's considered judgement (GY-141), not a session to replace or a
  // request to repeat: the server refuses the same request unchanged, and answering it is the master's.
  if (decision.state === 'refused') return { step: 'refused', detail: `${label} was refused by ${decision.refusal?.approver ?? 'its approver'}: ${decision.refusal?.reason ?? decision.outcome ?? 'no reason recorded'}` };
  if (decision.state !== 'requested' && decision.state !== 'approved')
    return { step: 'rerequest', detail: `${label} ended ${decision.state}${decision.outcome ? ` (${decision.outcome})` : ''}` };
  if (!sessions.available) return { step: 'wait', detail: `Herdr could not be read, so the approver session of ${label} is unknown this cycle` };
  const session = watch.agentName ? sessions.agents.find(agent => agent.name === watch.agentName) : undefined;
  const launchedAt = watch.launchedAt ? Date.parse(watch.launchedAt) : Number.NaN, age = Number.isFinite(launchedAt) ? now - launchedAt : 0;
  const ended = !session ? `approver session ${watch.agentName ?? '(never launched)'} is gone without judging it`
    : ['idle', 'done', 'blocked'].includes(session.agent_status ?? '') && age >= approverSettleMs ? `approver session ${watch.agentName} ended ${session.agent_status} without approving it — declined, or its prompt was dropped`
      : age > approverJudgeBoundMs ? `approver session ${watch.agentName} has not judged it for ${Math.round(age / 60_000)} minutes, past the ${Math.round(approverJudgeBoundMs / 60_000)}-minute bound`
        : null;
  if (!ended) return { step: 'wait', detail: `${label} is with approver session ${watch.agentName} (launch ${watch.launches} of ${maxApproverLaunches})` };
  return watch.launches < maxApproverLaunches ? { step: 'relaunch', detail: `${label}: ${ended}` } : { step: 'exhausted', detail: `${label}: ${ended}` };
}
/** Every gate green on a submitted candidate: what "mergeable" means to the cycle and its budget. */
export const mergeableCandidate = (work: Work) => work.stage === 'merge' && !!work.candidate && !work.violations.length && work.gates.every(gate => gate.passed);
