// Concern: routine decisions — standing verdicts, decision reasons and the approver step.
import { type Work, type AgentReview, reviewProviderOf, standingEscalations, leaseLossEpoch } from '../model.js';
import { routableScopeRequest, scopeDecisionBinding, scopeDecisionReason } from '../model/scope.js';
import { baseRefreshConflict, threadsAwaitReview, botThread, openThreads, pendingBaseRefresh, type ReviewThread, describeThread } from '../merge-queue.js';
import { mechanicalFailure, mechanicalVerdicts } from '../model/mechanical-proofs.js';
import { unexercisedFindings } from '../auto-dispatch.js';
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
  // A head GitHub reports conflicting with the base, or one the merge queue ejected because its
  // speculative merge conflicts, is not waited on either (GY-191): nothing but a sync can move it,
  // so the loop asks for that round at once, naming the base tip it conflicts with.
  const sync = work.reworkRequested ? null : syncConflict(work);
  if (sync) return { action: 'rework', reason: `${work.key}: ${sync.reason}. Only a sync can resolve it (graphyard sync ${work.key}: merge the base, resolve, push), so the candidate returns to a worker.`, binding: sync.binding };
  const verdict = standingVerdict(work);
  if (verdict) return { action: 'rework', reason: `${work.key}: ${verdict.reason}. The verdict stands against the current head, so the item returns to a worker for the next round.`, binding: `${work.candidate!.sha}:verdict:${verdict.reviewer}` };
  // A failed trusted proof, or evidence the producer found does not exercise its criterion, returns
  // the head before any review (GY-193): no review comes for such a head, so the thread rule below —
  // which waits for one — must not hold this rework.
  const proofs = proofRework(work);
  if (proofs) return { action: 'rework', ...proofs };
  const ci = failedCheckRework(work);
  if (ci) return { action: 'rework', ...ci };
  // Unresolved review threads block no merge: the reviewer's verdict on the head is the review
  // gate and the threads are its inputs. A thread still open once the review of the current head
  // has settled — one it was not shown, or a policy with no review — is a finding the loop sends
  // back for, early on. The review judges threads first: its approval names the ones fixed or
  // overridden and the loop resolves them, so a rework requested before it settles would invalidate
  // the review that clears them. After `botThreadReworkRounds` rework rounds a bot's thread is
  // advisory: bot findings alone had kept items cycling round after round on the same head family.
  const threads = !work.reworkRequested && work.candidate && !threadsAwaitReview(work, Date.parse(work.observation?.at ?? '')) ? reworkThreads(work) : [];
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
 * The rework a required CI check that failed on exactly the current head calls for, or null. The
 * next action for such a head is already `request-rework` (refusal-mapping.ts), but nothing asked
 * for the round: on 2026-09-25 GY-245's worker had completed, a base refresh produced
 * a3b75653db55, its `test` check failed, and the item sat in Test for over four hours with its
 * next step named for no one. The latest attempt of each check decides, so a rerun that is still
 * going or passed asks for nothing; the binding names the head and the failed checks.
 */
export function failedCheckRework(work: Work): { reason: string; binding: string } | null {
  const candidate = work.candidate, observation = work.observation;
  if (!work.submission || work.reworkRequested || !candidate || !observation || work.stage === 'done') return null;
  if (observation.candidate.sha !== candidate.sha || observation.merged || observation.prState === 'closed') return null;
  const failed = work.policy.checks.filter(name => {
    const runs = observation.checks.filter(check => check.name === name);
    const latest = runs.length ? runs.reduce((newest, check) => (check.attempt ?? 0) >= (newest.attempt ?? 0) ? check : newest) : null;
    return !!latest && ['failure', 'timed_out', 'action_required', 'cancelled'].includes(latest.result);
  }).sort();
  if (!failed.length) return null;
  return { reason: `${work.key}: required CI check${failed.length === 1 ? '' : 's'} ${failed.join(', ')} failed on candidate ${candidate.sha.slice(0, 12)}. No gate passes a head whose required checks failed, so the item returns to a worker to fix what CI found.`,
    binding: `${candidate.sha}:ci:${failed.join(',')}` };
}
/**
 * GY-193. The rework a head's own proofs call for, or null. A trusted proof that failed on the head
 * (the build gate returns it to its worker before review) and evidence the producer recorded as not
 * exercising its criterion (the proof also passed with the change removed) both leave a head no
 * review will ever judge, so the rework is asked for now, whatever threads stand open on it: the
 * rule that waits for a review to judge the threads first would wait for a review that never comes.
 * The reason quotes each finding and names the open threads, so the worker takes both in one round.
 */
export function proofRework(work: Work): { reason: string; binding: string } | null {
  const candidate = work.candidate;
  if (!work.submission || work.reworkRequested || !candidate || work.stage === 'done' || work.observation?.merged) return null;
  const failed = mechanicalVerdicts(work, [work], new Date()).filter(verdict => verdict.outcome === 'failed');
  const unexercised = unexercisedFindings(work);
  if (!failed.length && !unexercised.length) return null;
  const threads = work.observation?.candidate.sha === candidate.sha ? work.observation.conversations?.unresolved ?? [] : [];
  const findings = [
    ...(failed.length ? [`a trusted proof failed: ${failed.map(verdict => mechanicalFailure(verdict, candidate.sha)).join('; ')}`] : []),
    ...(unexercised.length ? [`the producer recorded evidence that does not exercise its criterion on ${candidate.sha.slice(0, 12)} — ${unexercised.map(entry => `${entry.proof}: "${entry.finding.length > 400 ? `${entry.finding.slice(0, 399)}…` : entry.finding}"`).join('; ')}`] : []),
  ];
  const named = threads.slice(0, 5).map(thread => { const text = describeThread(thread); return text.length > 120 ? `${text.slice(0, 119)}…` : text; });
  const open = threads.length ? ` ${threads.length} review thread${threads.length === 1 ? ' is' : 's are'} also unresolved on the pull request (${named.join('; ')}${threads.length > named.length ? `; and ${threads.length - named.length} more` : ''}); address them in the same round.` : '';
  return { reason: `${work.key}: ${findings.join('. ')}. No review judges a head whose proof did not pass, so the item returns to a worker now to fix what the proof found.${open}`,
    binding: `${candidate.sha}:proof:${[...failed.map(verdict => verdict.proof), ...unexercised.map(entry => `unexercised:${entry.proof}`)].sort().join(',')}` };
}

/** The reason `advanceQueue` ejects an entry whose speculative merge conflicts (github.ts SpeculativeConflict). */
const speculativeConflictReason = /^Speculative merge of [0-9a-f]+ into .+ conflicts/;
/**
 * The conflict with the base that only a sync round can resolve, for exactly the current head, or
 * null. Two observations say so. GitHub computed a merge conflict for the open pull request (its
 * `mergeable` is false, not merely uncomputed); and the merge queue ejected this head because its
 * speculative merge conflicts. An ejection whose base the control plane has not yet tried to
 * bring the head onto waits for that attempt first: a clean refresh republishes the head and it
 * re-enters the queue with no round at all, and a conflicting one is named by `baseRefreshConflict`.
 * The binding names the head and the base tip, so a base that moves on is a fresh ground.
 */
export function syncConflict(work: Work): { reason: string; binding: string } | null {
  const candidate = work.candidate, observation = work.observation;
  if (!work.submission || work.reworkRequested || !candidate || !observation || work.stage === 'done') return null;
  if (observation.candidate.sha !== candidate.sha || observation.merged || observation.prState === 'closed') return null;
  const tip = observation.baseTip ?? candidate.baseSha;
  if (observation.conflicting && !work.queue)
    return { reason: `GitHub reports that candidate ${candidate.sha.slice(0, 12)} conflicts with base branch tip ${tip.slice(0, 12)}`, binding: `${candidate.sha}:sync:${tip}` };
  const ejection = work.queueEjection;
  if (ejection && !work.queue && ejection.sha === candidate.sha && ejection.policyRevision === work.policyRevision && speculativeConflictReason.test(ejection.reason) && !pendingBaseRefresh(work))
    return { reason: `the merge queue ejected candidate ${candidate.sha.slice(0, 12)}: ${ejection.reason} (base branch tip ${tip.slice(0, 12)})`, binding: `${candidate.sha}:queue-conflict:${ejection.sequence}:${tip}` };
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
/**
 * The snapshot as the cycle decides from it: each item's unresolved threads without the ones its
 * approval named as follow-up (GY-166). Those are the review loop's to file and resolve, not a
 * worker's to fix, so a thread-rework decision is never requested for them. Only the cycle's copy
 * changes; GitHub still blocks the merge on each until the loop has resolved it.
 */
export function setAsideFollowUpThreads<S extends { work: Work[] }>(snapshot: S, followUps: Map<string, Set<string>> | undefined): S {
  if (!followUps?.size) return snapshot;
  return { ...snapshot, work: snapshot.work.map(item => {
    const ids = followUps.get(item.key), conversations = item.observation?.conversations;
    if (!ids?.size || !conversations?.unresolved.some(thread => thread.id && ids.has(thread.id))) return item;
    return { ...item, observation: { ...item.observation!, conversations: { ...conversations, unresolved: conversations.unresolved.filter(thread => !thread.id || !ids.has(thread.id)) } } };
  }) };
}
/** How many rework rounds an item takes before a bot's review thread stops being grounds for another. */
export const botThreadReworkRounds = 2;
/**
 * The open threads on the current head the loop requests rework for: every one within the first
 * `botThreadReworkRounds` rework rounds, and after that only a person's — a bot's thread is then
 * advisory, and only the reviewer's own CHANGES_REQUESTED sends the item back.
 */
export function reworkThreads(work: Work): ReviewThread[] {
  const threads = openThreads(work);
  return (work.pipeline?.reworkRounds ?? 0) >= botThreadReworkRounds ? threads.filter(thread => !botThread(thread)) : threads;
}
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
  return `${threads.length} review thread${threads.length === 1 ? ' is' : 's are'} still open on ${sha.slice(0, 12)} after its review settled: ${named.join('; ')}${more ? `; and ${more} more on the pull request` : ''}. Rework the candidate to address the findings, never dismiss them`;
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
/** How many standing refusals the server names that a rework request answers by citing them before it gives up. */
export const maxRefusalAnswers = 3;
/** The refused rework decision the server's refusal of a request names as standing against it, or null. */
export const refusalNamedIn = (error: string): string | null =>
  /Decision ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) \(rework\) with this input\b/.exec(error)?.[1] ?? null;
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
