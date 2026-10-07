// Concern: routine decisions — standing verdicts, decision reasons and the approver step.
import { type Work, type AgentReview, reviewProviderOf, RefusedResponse } from '../model.js';
import { routableScopeRequest, scopeDecisionBinding, scopeDecisionReason, scopeRefusalBlocker } from '../model/scope.js';
import { widenedPlannedFiles } from '../model/scope-collapse.js';
import { itemBlockerClass, maxAutomaticClears, uncoveredBlockerPaths } from '../model/blocker-class.js';
import { baseRefreshConflict, checkRerunHeld, ciAppIdsOf, requiredCheck, requiredCheckRun, requiredChecksOf, threadsAwaitReview, botThread, openThreads, pendingBaseRefresh, type ReviewThread, describeThread } from '../merge-queue.js';
import { mechanicalFailure, mechanicalProof, mechanicalVerdicts, producerManualFailure, producerManualFailures } from '../model/mechanical-proofs.js';
import { extractProducerAccountsOrRuntimes, unactedProducerAttempts, unexercisedFindings } from '../auto-dispatch.js';
import { decisionBindingMax, type DecisionSituation } from '../model/approval.js'; import { unsettledApproval } from './decision-reads.js';
import { guardBroadScope, type MasterConfig, type ContainmentAssessment, containmentPhase, type HerdrAgent } from '../master.js';
import { researchRework } from '../research.js'; import { baseBreakHold } from '../master/base-break-refresh.js';
import { unproducedManualProofs } from '../model/unproduced-attestation.js';
import { mechanicalRework, type MechanicalFixRequest } from '../mechanical-findings.js';
import { triageClosure } from '../model/machine-backlog.js';
import { actionDetailMax, type ApprovalWatch, message } from './state.js';
import { blockingFindings, followUpFindingsOf, pastReviewCap, reviewRound, reviewRoundCapOf } from '../review-cap.js';
import { sessionName } from '../session-name.js';

/**
 * The rework rounds the review-round cap judges an item by (GY-1118): its pipeline timeline's
 * count, or — on the coordination view the loop reads, which drops the timeline — the count that
 * view keeps beside it (`reworkRounds`, src/server/work-view.ts). Without it the loop read every
 * head as round 1, and the cap never ran (GY-1389).
 */
export const reworkRoundsOf = (work: Work) => work.pipeline?.reworkRounds ?? (work as Work & { reworkRounds?: number }).reworkRounds ?? 0;
const rounds = (work: Work) => ({ pipeline: { reworkRounds: reworkRoundsOf(work) } });

/** What the routine decisions read of the master configuration: automatic merging, and the review-round cap (GY-1118). */
export type ReviewCapConfig = Pick<MasterConfig, 'autoMerge'> & Partial<Pick<MasterConfig, 'reviewRoundCap' | 'reviewer'>>;

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
 * GY-1118. What a change request standing against the current head calls for once the item is past
 * its review-round cap, or null. One that names no `BLOCKING:` finding and was posted by the
 * configured reviewer App is a `follow-up`: its findings become the item's follow-up batch and the
 * request is withdrawn, so the head is reviewed again with no rework. One naming a blocking finding
 * is an `escalate`: the loop requests a rework decision only its independent approver may apply
 * (`cappedReworkBinding`), which puts the finding to that approver. So is any other — an agent
 * provider's verdict, or a person's review — since Graphyard cannot withdraw it as the reviewer App.
 */
export interface CappedReview { kind: 'follow-up' | 'escalate'; round: number; cap: number; reviewer: string; reviewId: number | null; sha: string; blocking: string[]; findings: string[]; reason: string }
/** The binding of the loop's rework request for a capped change request (GY-1389): an approver's to judge, never the risk lane's. */
export const cappedReworkBinding = (head: string, reviewer: string) => `${head}:capped:${reviewer}`;
export function cappedReview(work: Work, config: Partial<Pick<MasterConfig, 'reviewRoundCap' | 'reviewer'>>): CappedReview | null {
  const cap = reviewRoundCapOf(config);
  if (work.stage === 'done' || !pastReviewCap(rounds(work), cap)) return null;
  const verdict = standingVerdict(work);
  if (!verdict) return null;
  const candidate = work.candidate!, observation = work.observation!;
  const review = observation.reviews.find(entry => entry.sha === candidate.sha && entry.state === 'CHANGES_REQUESTED');
  const body = review ? review.body : observation.agentReview?.reason;
  const reviewId = review ? review.id ?? null : observation.agentReview?.verdictId ?? null;
  const blocking = review?.blocking?.length ? review.blocking : blockingFindings(body), round = reviewRound(rounds(work));
  const own = !!review && !!config.reviewer && review.reviewer.toLowerCase() === `${config.reviewer.slug}[bot]`.toLowerCase();
  const findings = followUpFindingsOf(body);
  const base = { round, cap, reviewer: verdict.reviewer, reviewId, sha: candidate.sha, blocking, findings: findings.length ? findings : [verdict.reason] };
  const past = `${work.key} is in review round ${round}, past its cap of ${cap}`;
  if (blocking.length) return { kind: 'escalate', ...base, reason: `${past}, and ${verdict.reviewer} names ${blocking.length === 1 ? 'a blocking finding' : `${blocking.length} blocking findings`} on ${candidate.sha.slice(0, 12)}: ${blocking.join('; ')}` };
  if (!own || reviewId === null) return { kind: 'escalate', ...base, reason: `${past}, and ${verdict.reviewer} requested changes on ${candidate.sha.slice(0, 12)} naming no BLOCKING: finding, but Graphyard cannot withdraw a verdict it did not obtain through its reviewer App` };
  return { kind: 'follow-up', ...base, reason: `${past}, and ${verdict.reviewer}'s change request ${reviewId} on ${candidate.sha.slice(0, 12)} names no BLOCKING: finding` };
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
/** GY-1266's former age bound on the woken observation, lifted by GY-1257 (a cycle may outlast it); the span a burst replay covers. */
export const reworkWokenObservationMaxAgeMs = 15 * 60_000;
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
 * Why a rework request must wait for a fresh observation, or null when the one on the item may be decided
 * from. The reason names the stale observation — its time and head — never its age, so it reads the same each cycle.
 */
export function reworkObservationWait(work: Work, now: number, pause: GitHubPause | null, wokenAt?: string | null): string | null {
  const observation = work.observation;
  if (!observation) return `${work.key}: rework waits for a GitHub observation of the item; there is none to decide from`;
  const seen = `the last GitHub observation (taken at ${observation.at} of head ${observation.candidate.sha.slice(0, 12)})`;
  if (pause) return `${work.key}: rework waits for a fresh GitHub observation — GitHub requests are paused until ${pause.until}, so ${seen} is a stale observation that may describe a head the branch has moved past`;
  const age = now - Date.parse(observation.at);
  // GY-1266/GY-1257. The loop's own woken observation of the submitted head is the reading it waited for: the next cycle reads it
  // an interval or a slow cycle later, past any age bound on the cycle clock, so on such a bound every landed wake was stale again,
  // re-sent, and no rework was ever requested. Its head must still be the candidate's; apply time withdraws one the item moved past.
  if (wokenAt && Date.parse(observation.at) > Date.parse(wokenAt) && observation.candidate.sha === work.candidate?.sha) return null;
  if (!(Number.isFinite(age) && age < reworkObservationMaxAgeMs)) return `${work.key}: rework waits for a fresh GitHub observation — ${seen} is a stale observation, older than two minutes, and the branch may have moved past that head`;
  return null;
}

/**
 * GY-710. A step refused for want of a fresh observation wakes the item's observation job at once and waits for that
 * observation to land, not the job's cadence. One wake stands until a newer observation lands; a wake that brought none
 * within this bound (the job failed, or the server lost it) is sent again. During a GitHub pause no wake is sent.
 */
export const observationWakeRetryMs = 5 * 60_000;
export function observationWakeDue(work: Work, wokenAt: string | null | undefined, now: number, pause: GitHubPause | null): boolean {
  if (pause || !work.submission) return false;
  const woken = wokenAt ? Date.parse(wokenAt) : Number.NaN;
  if (!Number.isFinite(woken)) return true;
  const observed = work.observation ? Date.parse(work.observation.at) : Number.NaN;
  // The woken observation landed and is already stale again: this refusal is a new one.
  if (Number.isFinite(observed) && observed > woken) return true;
  return now - woken >= observationWakeRetryMs;
}

export const routineDecisionActions = ['rework', 'recover', 'merge', 'resolve', 'requirements', 'close', 'attest'] as const;
export type RoutineDecisionAction = typeof routineDecisionActions[number];
/** `input` is what the decision names beyond what `decisionInput` derives from the item: a resolve's trigger, and the grounds binding a situated request judges (GY-407). */
/** `escalation` is the one standing escalation a resolve settles: a standing request for any other is not this decision. `scope` is the worker request a `requirements` decision answers; `input.answers` binds the decision to it. */
export interface RoutineDecision { action: RoutineDecisionAction; reason: string; binding: string; input?: Record<string, unknown>; escalation?: { trigger: string; at: string }; scope?: NonNullable<ApprovalWatch['scope']> }
/**
 * Whether two decisions answer the same scope request. Compared field by field: the ledger keeps
 * the input as jsonb, which does not keep key order, so a serialised comparison never matches.
 */
export const sameAnswers = (a: any, b: any) => !a || !b ? !a && !b : a.epoch === b.epoch && a.at === b.at;
/**
 * The input a rework or recover request carries: the routine input plus the grounds binding, so
 * the server's refusal match sees what the watch key already keys (GY-407). A refusal judged on
 * one ground — the binding is part of what it judged — never bars the same head's rework on
 * another, by the server's own match and not only by this loop's keys.
 */
export const situatedInput = (decision: Pick<RoutineDecision, 'action' | 'binding' | 'input'>): RoutineDecision['input'] =>
  decision.action === 'rework' || decision.action === 'recover'
    ? { ...(decision.input ?? {}), binding: decision.binding.slice(0, decisionBindingMax) }
    : decision.input;
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
  const { request, paths, plannedFiles, collapsed } = routable;
  let broad: string | null = null;
  try { guardBroadScope({ ...work, plannedFiles }, request.reason, { allow: false, command: 'the loop', existing: work.plannedFiles }); }
  catch (error) { broad = `${guardBroadScope({ ...work, plannedFiles }, 'the approver grants it only with a stated reason', { allow: true, command: 'the loop', existing: work.plannedFiles })} (${message(error)})`; }
  return { action: 'requirements', binding: scopeDecisionBinding(request), input: { plannedFiles, answers: { epoch: request.epoch, at: request.at } }, reason: scopeDecisionReason(work.key, request, work.criteria, paths, broad, undefined, collapsed),
    scope: { epoch: request.epoch, at: request.at, requestedBy: request.requestedBy, paths: paths.slice(0, 50).map(path => path.slice(0, 500)) } };
}
/**
 * GY-1008. A planned-file-scope blocker — a worker's blocker naming the files its change needs and
 * the commit it needs them for — as the same additive `requirements` decision a routed scope request
 * becomes, requested by the master's operator-agent identity and judged by the independent
 * approver, with no master session involved. The recorded blocker already ended its attempt, so
 * nothing about a worker is attested; the approver judges the widening alone. Null when the
 * blocker is anything else, when plannedFiles already cover every file it names (the blocker step
 * then clears it), or when no fold represents the widening under the plannedFiles cap.
 */
export function blockerScopeDecision(work: Work): RoutineDecision | null {
  if (work.stage === 'done' || !work.blocker || work.scopeRequest || work.blocker.startsWith(scopeRefusalBlocker)) return null;
  const classification = itemBlockerClass(work);
  if (classification?.class !== 'planned-file-scope' || (work.blockerProbe?.clears ?? 0) >= maxAutomaticClears) return null;
  const paths = uncoveredBlockerPaths(work, classification);
  if (!paths.length) return null;
  const widened = widenedPlannedFiles(work, paths);
  if (!widened.representable) return null;
  let broad: string | null = null;
  try { guardBroadScope({ ...work, plannedFiles: widened.plannedFiles }, work.blocker, { allow: false, command: 'the loop', existing: work.plannedFiles }); }
  catch (error) { broad = `${guardBroadScope({ ...work, plannedFiles: widened.plannedFiles }, 'the approver grants it only with a stated reason', { allow: true, command: 'the loop', existing: work.plannedFiles })} (${message(error)})`; }
  const asked = `${work.key}: its worker recorded a planned-file-scope blocker naming ${paths.join(', ')} for commit ${classification.commit}, which ended its attempt: "${work.blocker.slice(0, 500)}". `
    + 'Approve the additive plannedFiles widening if the item\'s criteria justify those files, refuse with the reason otherwise; the loop clears the blocker once plannedFiles cover them. '
    + (broad ? `${broad.slice(0, 300)} It needs the broad-scope flag: grant it only with a stated reason why narrower paths will not do. ` : '');
  const named = `Criteria: ${work.criteria.map(criterion => `${criterion.id}: ${criterion.text}`).join(' | ')}`;
  return { action: 'requirements', binding: `blocker-scope:${classification.commit}:${paths.join(',')}`.slice(0, decisionBindingMax), input: { plannedFiles: widened.plannedFiles },
    reason: (asked + named).slice(0, 2000) };
}
/**
 * The decision one item needs right now, or null. Rework returns a head nothing can carry forward
 * — a standing verdict, or a base branch Graphyard could not merge in — to a fresh attempt.
 * Recovery releases a delivered item whose supervisor is still quarantined. A merge decision is
 * needed only where automatic merging is off, and then for the exact candidate that is mergeable.
 */
export function routineDecision(work: Work, config: ReviewCapConfig, now: number, assessment?: ContainmentAssessment | null, baseFailed?: ReadonlySet<string>, exhausted: readonly ExhaustedProof[] = [], mechanical: readonly MechanicalFixRequest[] = []): RoutineDecision | null {
  const needed = neededDecision(work, config, baseFailed, exhausted, mechanical);
  if (!needed) return null;
  // None attests anything about a worker: a merge is of a mergeable candidate, a triage closure of an unreleased backlog item,
  // and an attestation's approver judges the proof.
  if (needed.action === 'merge' || needed.action === 'close' || needed.action === 'attest') return needed;
  const stopped = workerStopped(work, now, assessment);
  // The grounds travel with the request: the approver cannot verify this host, so it is told
  // exactly what the requester verified and judges the attestation on that. A situated request
  // also names its binding in the input, so the server's refusal match refuses a repeat only of
  // the same head, base and grounds (GY-407) — not of every request the item ever carried.
  return stopped.stopped ? { ...needed, input: situatedInput(needed), reason: `${needed.reason} The previous worker is stopped: ${stopped.grounds}.` } : null;
}
/**
 * What the item calls for, before asking whether the loop may attest that its worker is stopped.
 * `baseFailed` names required checks the base head fails too (GY-528); `exhausted`, spent producer requests (GY-496).
 */
export function neededDecision(work: Work, config: ReviewCapConfig, baseFailed?: ReadonlySet<string>, exhausted: readonly ExhaustedProof[] = [], mechanical: readonly MechanicalFixRequest[] = []): RoutineDecision | null {
  if (work.stage === 'done') {
    return work.containmentQuarantine
      ? { action: 'recover', reason: `${work.key} is delivered and still fenced by its epoch ${work.containmentQuarantine.epoch} containment quarantine; recovery releases it without touching the delivery.`, binding: String(work.containmentQuarantine.epoch) } : null;
  }
  // A triage closure the triage agent proposed for a machine-filed item (GY-402) is applied only
  // once the independent approver agrees; the decision binds the judgement it applies.
  const closure = work.triage?.state === 'proposed' ? triageClosure(work.triage.judgement) : null;
  if (closure) return { action: 'close', reason: `${work.key} is a machine-filed backlog item the triage agent judged should be closed (${closure.kind}${closure.ref ? ` of ${closure.ref}` : ''}): ${closure.reason}`.slice(0, 2000),
    binding: `triage:${work.triage!.at}`, input: { ...closure, triageAt: work.triage!.at } };
  // Like a verdict, a conflict keeps matching the head it was found on until a new one is pushed,
  // and the engine's `rework` does not clear it: once the round is requested the item needs a
  // worker, not a second decision, even when that round's worker dies before pushing.
  const conflict = work.reworkRequested ? null : baseRefreshConflict(work);
  // A rework binding names its grounds as well as the head: a refused request on one ground (the
  // approver judged it premature) must not bar the same head's rework on another. On 2026-09-24
  // GY-163's thread rework was refused before its reviewer had judged the head; the reviewer then
  // requested changes, and the loop never asked again because both keyed on the head alone. Since
  // GY-407 the binding rides the request's input, so the server's refusal match sees it too.
  if (conflict) return { action: 'rework', reason: `${work.key}: ${conflict}. Only a fresh attempt can resolve it, so the candidate returns to a worker.`, binding: `${work.candidate!.sha}:conflict` };
  // A head GitHub reports conflicting with the base is not waited on either (GY-191): nothing but a sync can move it,
  // so the loop asks for that round at once, naming the base tip it conflicts with.
  const sync = work.reworkRequested ? null : syncConflict(work);
  if (sync) return { action: 'rework', reason: `${work.key}: ${sync.reason}. Only a sync can resolve it (graphyard sync ${work.key}: merge the base, resolve, push), so the candidate returns to a worker.`, binding: sync.binding };
  // Past the review-round cap (GY-1118) no review finding sends the item back: a change request is
  // filed as follow-ups or escalated by the review-cap step (cappedReview), and threads are only
  // the reviewer's inputs. Proofs, CI, conflicts and refused merges still return the head below.
  const capped = pastReviewCap(rounds(work), reviewRoundCapOf(config));
  const verdict = capped ? null : standingVerdict(work);
  if (verdict) return { action: 'rework', reason: `${work.key}: ${verdict.reason}. The verdict stands against the current head, so the item returns to a worker for the next round.`, binding: `${work.candidate!.sha}:verdict:${verdict.reviewer}` };
  // Past the cap a change request that escalates — a blocking finding, or one Graphyard cannot withdraw —
  // is the independent approver's to judge (GY-1118). The loop requests that one round itself, kept for
  // the approver it launches rather than its risk lane (GY-1389): the review-cap escalation had a master
  // request it by hand, and each was then counted as a coordinator stepping in.
  const escalated = capped && !work.reworkRequested ? cappedReview(work, config) : null;
  if (escalated?.kind === 'escalate') return { action: 'rework', binding: cappedReworkBinding(work.candidate!.sha, escalated.reviewer),
    reason: `${escalated.reason.replace(/\.$/, '')}. Past the review-round cap only an independent approver sends the head back: approve for one more round fixing exactly that finding, or refuse it as non-blocking: the loop then requests it no more and escalates the refusal for the master to answer.`.slice(0, 2000) };
  // A failed trusted proof, or evidence the producer found does not exercise its criterion, returns
  // the head before any review (GY-193): no review comes for such a head, so the thread rule below —
  // which waits for one — must not hold this rework.
  const proofs = proofRework(work);
  if (proofs) return { action: 'rework', ...proofs };
  const ci = failedCheckRework(work, baseFailed);
  if (ci) return { action: 'rework', ...ci };
  const spent = exhaustedProofRework(work, exhausted);
  if (spent) return { action: 'rework', ...spent };
  // The operator answered a product question the head was built on provisionally, and the answer
  // differs from that recommendation (GY-259): the head no longer builds what was asked.
  const research = researchRework(work);
  if (research) return { action: 'rework', ...research };
  // No merge refusal returns a head (GY-1391): the guarded merge that recorded them is gone (GY-1236),
  // and a refusal a document still carries from before re-binds nothing a worker could change.
  // An unexercised `manual:` proof is answered by an attestation carrying its exercise record
  // (GY-523), never by rework: nothing in the change is wrong, only the record of the attestation.
  const attestation = attestationDecision(work);
  if (attestation) return attestation;
  // Unresolved review threads block no merge: the reviewer's verdict on the head is the review
  // gate and the threads are its inputs. A thread still open once the review of the current head
  // has settled — one it was not shown, or a policy with no review — is a finding the loop sends
  // back for, early on. The review judges threads first: its approval names the ones fixed or
  // overridden and the loop resolves them, so a rework requested before it settles would invalidate
  // the review that clears them. After `botThreadReworkRounds` rework rounds a bot's thread is
  // advisory: bot findings alone had kept items cycling round after round on the same head family.
  const threads = !capped && !work.reworkRequested && work.candidate && !threadsAwaitReview(work, Date.parse(work.observation?.at ?? '')) ? reworkThreads(work) : [];
  if (threads.length) return { action: 'rework', reason: `${work.key}: ${threadReworkSummary(work.candidate!.sha, threads)}. The findings stand against the current head, so the item returns to a worker to address them; the next review names the threads it verified fixed and the loop resolves them.`,
    binding: `${work.candidate!.sha}:threads:${threads.map(thread => thread.id ?? `${thread.path}:${thread.line}`).sort().join(',')}` };
  // An otherwise-approved head whose approval raised findings classified mechanical (GY-971) returns
  // to a worker-class bot round for one commit that fixes exactly those, before the fresh read.
  const fix = mechanicalRework(work, mechanical);
  if (fix) return { action: 'rework', ...fix };
  // A lease-loss the control plane raised is not the loop's to ask about: once the lost attempt can
  // no longer act, reconciliation settles it on the record (GY-1393, `endedLeaseLoss`). It had been
  // a routine two-party resolve (GY-161), and 28 approver rounds in 7 days confirmed only what the
  // control plane already held.
  return null;
}
/**
 * The attestation decisions one item needs right now, one per `manual:` proof no producer session
 * may run (`unproducedManualProofs`, GY-521), or none. Each binds the proof, the exact head, its base
 * and the policy revision — the attest input names all four, so an approval can never apply to a
 * later head — and asks the approver to verify the criterion on that head before approving. Like a
 * merge decision it attests nothing about a worker, so it is requested whatever the lease says.
 */
export function attestDecisions(work: Work, all: Work[], now: number): RoutineDecision[] {
  const candidate = work.candidate;
  if (!candidate || work.stage === 'done') return [];
  return unproducedManualProofs(work, all, new Date(now)).map(proof => {
    const criteria = work.criteria.filter(criterion => criterion.proofs.includes(proof));
    const named = criteria.length ? criteria.map(criterion => `${criterion.id} ("${boundDetail(criterion.text, 600)}")`).join('; ') : 'an inherited bootstrap obligation';
    return { action: 'attest', binding: `${proof}:${candidate.sha}:${candidate.baseSha}`, input: { proof },
      reason: `${work.key}: every gate before acceptance passes for candidate ${candidate.sha.slice(0, 12)} (base ${candidate.baseSha.slice(0, 12)}, policy revision ${work.policyRevision}), and ${proof}, required by ${named}, is a manual proof no producer session may run, so only this two-party attestation satisfies it. Approve only after verifying on that exact head that the criterion holds; refuse naming what is missing otherwise.` };
  });
}
/**
 * The withdrawal reason for a merge or attest decision standing on `work` that can never apply to
 * the one now needed, or null when it is this decision (or another action). Only a merge decision
 * and an attest decision (GY-521) name what they bind: one for an earlier head is taken back if it
 * is still requested; one for another proof on this head is judged first, one attest at a time. An approval of any action the item moved past, or one stalled, is settled by the withdrawal, never adopted (GY-1297).
 */
export function overtakenDecision(work: Work, decision: RoutineDecision, standing: { id: string; state: string; input?: any; action?: string; approvedBy?: string | null; approvedAt?: string | null; situation?: DecisionSituation | null }, canWithdraw: boolean, now = Date.now()): string | null {
  const settle = unsettledApproval(work, { action: decision.action, ...standing }, now); if (settle) { if (!canWithdraw) throw new Error(`${settle}, and this loop has no way to settle it: graphyard master decisions ${work.key}`); return settle; }
  if (decision.action !== 'merge' && decision.action !== 'attest') return null;
  const head = standing.input?.sha === work.candidate?.sha && standing.input?.baseSha === work.candidate?.baseSha && standing.input?.policyRevision === work.policyRevision;
  if (head && (decision.action === 'merge' || standing.input?.proof === decision.input?.proof)) return null;
  const merge = decision.action === 'merge', sha = merge ? decision.binding : work.candidate?.sha ?? '';
  const other = merge
    ? `merge decision ${standing.id} is ${standing.state} for candidate ${String(standing.input?.sha).slice(0, 12)}, not the current ${sha.slice(0, 12)}`
    : `attest decision ${standing.id} is ${standing.state} for ${String(standing.input?.proof)} on ${String(standing.input?.sha).slice(0, 12)}, not ${String(decision.input?.proof)} on ${sha.slice(0, 12)}`;
  if (head) throw new Error(`${other}; the control plane holds one attest decision at a time, so this one is requested once it settles: graphyard master decisions ${work.key}`);
  if (standing.state !== 'requested' || !canWithdraw) throw new Error(`${other}, and ${canWithdraw ? 'only a requested decision can be withdrawn' : 'this loop has no way to withdraw it'}: graphyard master decisions ${work.key}`);
  return `The candidate moved to ${sha.slice(0, 12)}; ${other}, so it can never apply and is withdrawn for a request that names the current ${merge ? 'candidate' : 'head'}`;
}
/**
 * The rework a required CI check that failed on exactly the current head calls for, or null. The
 * next action for such a head is already `request-rework` (refusal-mapping.ts), but nothing asked
 * for the round: GY-245 sat in Test for four hours after its refreshed head's `test` failed. The latest attempt of each check decides, so a rerun that is still
 * going or passed asks for nothing; the binding names the head and the failed checks. A candidate
 * failed only on what the base broke and its tip fixed is refreshed onto that tip instead (GY-793).
 */
export function failedCheckRework(work: Work, baseFailed?: ReadonlySet<string>): { reason: string; binding: string } | null {
  const candidate = work.candidate, observation = work.observation;
  if (!work.submission || work.reworkRequested || !candidate || !observation || work.stage === 'done') return null;
  if (observation.candidate.sha !== candidate.sha || observation.merged || observation.prState === 'closed' || baseBreakHold(work)) return null;
  // A check the base head fails too is no worker's to fix (GY-528): the loop raises it against the base once.
  // The policy's checks and the base branch's other required checks alike (GY-430): PR #221's
  // `secrets` scan failed, GitHub blocked the merge, and nothing asked for the round. A policy
  // check's run is read through the test gate's trust boundary (GY-731); a protection-only
  // check's through the app protection binds it to, or any app with the CI apps preferred (GY-1060).
  const failed = requiredChecksOf(work).filter(required => {
    if (baseFailed?.has(required.name)) return false;
    const latest = required.policy ? requiredCheck(work, required.name) : requiredCheckRun(required, observation.checks, ciAppIdsOf(work));
    // A failure awaiting its one rerun (GY-516) is not yet the worker's: a rework round would push a
    // new head and lose the queue position, approval and proofs the rerun keeps.
    // A run GitHub cancelled is no failure of the head (GY-1109): the check is rerun, never reworked.
    return !!latest && ['failure', 'timed_out', 'action_required', ...(required.policy ? [] : ['startup_failure'])].includes(latest.result) && !checkRerunHeld(work, required.name);
  }).map(required => required.name).sort();
  if (!failed.length) return null;
  return { reason: `${work.key}: required CI check${failed.length === 1 ? '' : 's'} ${failed.join(', ')} failed on candidate ${candidate.sha.slice(0, 12)}. No gate passes a head whose required checks failed, so the item returns to a worker to fix what CI found.`,
    binding: `${candidate.sha}:ci:${failed.join(',')}` };
}
/**
 * GY-496. A producer request the loop stopped attempting: every automatic session it launched for
 * the head's proof group ended without trusted evidence (auto-dispatch.ts `abandon`). Before this,
 * nothing followed: GY-421 waited over seventy minutes in review with its proofs missing, no
 * producer would be launched for the head again, and the master had to ask for a rework by hand.
 */
export interface ExhaustedProof { requestId: string; work: string; sha: string; group: string | null; proofs: string[]; attempts: string[]; reason: string }
/** The escalation that raises an exhausted request; the rework is requested only on a later cycle. */
export const exhaustedProofKey = (entry: Pick<ExhaustedProof, 'work' | 'requestId'>) => `escalation:proof-exhausted:${entry.work}:${entry.requestId}`;
const groupName = (entry: ExhaustedProof) => `the ${entry.group ?? 'producer'} proof group${entry.proofs.length ? ` (${entry.proofs.join(', ')})` : ''}`;
const quoteAttempts = (entry: ExhaustedProof, limit = 1600) => { const text = entry.attempts.map(attempt => `"${attempt}"`).join('; '); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text || 'no attempt recorded'; };
/** The attention the loop raises the cycle it first sees the request spent: group, every attempt's outcome, and the next step's owner. */
export function exhaustedProofEscalation(entry: ExhaustedProof) {
  const unacted = unactedProducerAttempts(entry.attempts);
  if (unacted) {
    const runtimesOrAccounts = extractProducerAccountsOrRuntimes(entry.attempts);
    const target = runtimesOrAccounts.length ? runtimesOrAccounts.join(', ') : 'producer runtime or account';
    return boundDetail(`${entry.work}: producer attempts for ${groupName(entry)} on ${entry.sha.slice(0, 12)} are used up (${entry.reason}); no producer is launched for this head until an eligible account exists. Attempts: ${quoteAttempts(entry)}. Next step, owned by the master loop: no rework is requested for ${entry.work}; the attempts name a producer-runtime fault on ${target}; the loop relaunches the request once an eligible producer account exists`);
  }
  return boundDetail(`${entry.work}: producer attempts for ${groupName(entry)} on ${entry.sha.slice(0, 12)} are used up (${entry.reason}); no producer is launched for this head again. Attempts: ${quoteAttempts(entry)}. Next step, owned by the master loop: on its next cycle it requests a rework decision for ${entry.work} quoting these attempts, and the independent approver judges it; the master fixes a launcher fault (a producer profile or its credential) if the attempts name one`);
}
/** The rework an item whose proof requests are spent calls for, once the escalation has stood a cycle, or null. */
export function exhaustedProofRework(work: Work, exhausted: readonly ExhaustedProof[]): { reason: string; binding: string } | null {
  const candidate = work.candidate;
  if (!work.submission || work.reworkRequested || !candidate || work.stage === 'done' || work.observation?.merged) return null;
  const spent = exhausted.filter(entry => entry.work === work.key && entry.sha === candidate.sha);
  if (!spent.length) return null;
  // GY-1153: When every spent producer attempt on a head ended without the session acting (never
  // started, profile busy, account exhausted or launch refused), the loop requests no rework for the head.
  // A head whose producer attempts include at least one session that acted and failed to produce
  // evidence still gets the GY-496 rework, and so does a spent entry with no recorded attempt
  // (GY-1227), exactly as `exhaustedProofEscalation` announced it.
  const acted = spent.filter(entry => !unactedProducerAttempts(entry.attempts));
  if (!acted.length) return null;
  const each = Math.max(200, Math.floor(1600 / acted.length));
  return { reason: `${work.key}: the producer attempts for ${acted.map(entry => `${groupName(entry)} on ${candidate.sha.slice(0, 12)} ended without trusted evidence — ${quoteAttempts(entry, each)}`).join('. And ')}. No producer is launched for this head again, so it cannot pass its proofs; the item returns to a worker to fix what the attempts name and push a fresh head the producers are requested for.`,
    // Keyed on the head alone: a second group spent on the same head asks for no second rework.
    binding: `${candidate.sha}:proof-exhausted` };
}
/**
 * GY-193. The rework a head's own proofs call for, or null. A trusted proof that failed on the head
 * (the build gate returns it to its worker before review) and evidence the producer recorded as not
 * exercising its criterion (the proof also passed with the change removed) both leave a head no
 * review will ever judge, so the rework is asked for now, whatever threads stand open on it: the
 * rule that waits for a review to judge the threads first would wait for a review that never comes.
 * GY-868: a manual: proof a producer session may run and recorded as failed with cases executed is
 * a trusted proof failed like any other — the producer judged the change and found it inadequate —
 * so it returns the head to its worker too. A manual record with executed = 0 judged nothing and
 * goes to attestationDecision instead, and a manual proof no producer may run is never the
 * worker's: both stay out of this rework.
 * The reason quotes each finding and names the open threads, so the worker takes both in one round.
 */
export function proofRework(work: Work): { reason: string; binding: string } | null {
  const candidate = work.candidate;
  if (!work.submission || work.reworkRequested || !candidate || work.stage === 'done' || work.observation?.merged) return null;
  const now = new Date();
  const failed = [...mechanicalVerdicts(work, [work], now).filter(verdict => verdict.outcome === 'failed'), ...producerManualFailures(work, [work], now)];
  // An unexercised `manual:` proof is not the worker's to fix: see attestationDecision.
  const unexercised = unexercisedFindings(work).filter(entry => !entry.proof.startsWith('manual:'));
  if (!failed.length && !unexercised.length) return null;
  const threads = work.observation?.candidate.sha === candidate.sha ? work.observation.conversations?.unresolved ?? [] : [];
  const findings = [
    ...(failed.length ? [`a trusted proof failed: ${failed.map(verdict => mechanicalProof(verdict.proof) ? mechanicalFailure(verdict, candidate.sha) : producerManualFailure(verdict, candidate.sha)).join('; ')}`] : []),
    ...(unexercised.length ? [`the producer recorded evidence that does not exercise its criterion on ${candidate.sha.slice(0, 12)} — ${unexercised.map(entry => `${entry.proof}: "${entry.finding.length > 400 ? `${entry.finding.slice(0, 399)}…` : entry.finding}"`).join('; ')}`] : []),
  ];
  const named = threads.slice(0, 5).map(thread => { const text = describeThread(thread); return text.length > 120 ? `${text.slice(0, 119)}…` : text; });
  const open = threads.length ? ` ${threads.length} review thread${threads.length === 1 ? ' is' : 's are'} also unresolved on the pull request (${named.join('; ')}${threads.length > named.length ? `; and ${threads.length - named.length} more` : ''}); address them in the same round.` : '';
  return { reason: `${work.key}: ${findings.join('. ')}. No review judges a head whose proof did not pass, so the item returns to a worker now to fix what the proof found.${open}`,
    binding: `${candidate.sha}:proof:${[...failed.map(verdict => verdict.proof), ...unexercised.map(entry => `unexercised:${entry.proof}`)].sort().join(',')}` };
}

/**
 * GY-523. The attestation an unexercised `manual:` proof on the current head calls for, or null.
 * On 2026-09-26 GY-374's and GY-393's attestations were approved — GY-393's approver had run the
 * proof against the base and the candidate — but carried no exercise record, so the control plane
 * stored each pass as not exercising its criterion, and the loop asked for rework: the wrong
 * remedy, which the GY-393 approver refused. The change was never at fault, only the record, so the
 * loop asks for the attestation again, carrying the exercise record (`attestationExercise`) its
 * approver confirms by running the proof against the candidate base.
 * GY-868: a trusted manual record with executed = 0 is an unexercised finding too — no case ran, so
 * the criterion was never judged — and is answered here as well, never through rework or an
 * operator escalation.
 */
export function attestationDecision(work: Work): RoutineDecision | null {
  const candidate = work.candidate;
  if (!work.submission || work.reworkRequested || !candidate || work.stage === 'done' || work.observation?.merged) return null;
  const entry = unexercisedFindings(work).filter(finding => finding.proof.startsWith('manual:')).sort((a, b) => a.proof.localeCompare(b.proof))[0];
  if (!entry) return null;
  const criterion = work.criteria.find(each => each.proofs.includes(entry.proof));
  if (!criterion) return null;
  const finding = entry.finding.length > 300 ? `${entry.finding.slice(0, 299)}…` : entry.finding;
  return { action: 'attest', input: { proof: entry.proof }, binding: `${candidate.sha}:attest:${entry.proof}`,
    reason: `${work.key}: the attestation of ${entry.proof} on ${candidate.sha.slice(0, 12)} was recorded as not exercising ${criterion.id} ("${finding}"). The change is not at fault, so rework is the wrong remedy: this attestation carries the exercise record — ${entry.proof} fails against the candidate base ${candidate.baseSha.slice(0, 12)}, the tree without the change — and the approver confirms it by running the proof there and against the candidate before approving.` };
}

/**
 * The conflict with the base that only a sync round can resolve, for exactly the current head, or
 * null: GitHub computed a merge conflict for the open pull request (its `mergeable` is false, not
 * merely uncomputed). While the control plane's own test merge of the head onto that tip is
 * pending, it decides first. The binding names the head and the base tip, so a base that moves on
 * is a fresh ground.
 */
export function syncConflict(work: Work): { reason: string; binding: string } | null {
  const candidate = work.candidate, observation = work.observation;
  if (!work.submission || work.reworkRequested || !candidate || !observation || work.stage === 'done') return null;
  if (observation.candidate.sha !== candidate.sha || observation.merged || observation.prState === 'closed') return null;
  const tip = observation.baseTip ?? candidate.baseSha;
  // While the control plane's own test merge of the head onto that tip is pending, it decides: a
  // confirmed conflict is `baseRefreshConflict`'s, routed to a docs-sync session when it is confined
  // to docs pages (GY-566), and a clean one costs no round at all.
  if (observation.conflicting && !pendingBaseRefresh(work))
    return { reason: `GitHub reports that candidate ${candidate.sha.slice(0, 12)} conflicts with base branch tip ${tip.slice(0, 12)}`, binding: `${candidate.sha}:sync:${tip}` };
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
  return reworkRoundsOf(work) >= botThreadReworkRounds ? threads.filter(thread => !botThread(thread)) : threads;
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
export function reworkDecisionReason(prefix: string, grounds: string, refused: string[], action: 'rework' | 'recover' = 'rework'): string | null {
  if (!refused.length) return fitDecisionReason(prefix, grounds, '');
  const prose = ` This rests on different grounds from refused ${action} decision${refused.length === 1 ? '' : 's'} ${refused.join(', ')}, which ${refused.length === 1 ? 'was' : 'were'} judged on earlier grounds.`;
  const bare = ` Answers refused ${action} decisions ${refused.join(' ')}.`;
  const suffix = [prose, bare].find(text => decisionReasonMax - prefix.length - text.length >= Math.min(reworkGroundsMin, grounds.length));
  return suffix === undefined ? null : fitDecisionReason(prefix, grounds, suffix);
}
/** How many standing refusals the server names that a rework or recover request answers by citing them before it gives up. */
export const maxRefusalAnswers = 3;
const decisionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * The refused decision of `action` the server's refusal of a request names as standing against it,
 * or null. The server returns it as a field of the 409 body (`standingRefusal`, GY-265), so the
 * loop's retry does not depend on how the message is worded. Only a server that predates the field
 * is read from its message, and a rewording there fails closed: the refusal is recorded, not retried.
 */
export function refusalNamedIn(error: unknown, action: 'rework' | 'recover' = 'rework'): string | null {
  const field = error instanceof RefusedResponse ? (error.body as any)?.standingRefusal : undefined;
  if (field && typeof field === 'object') return field.action === action && typeof field.decision === 'string' && decisionId.test(field.decision) ? field.decision : null;
  const text = error instanceof Error ? error.message : String(error);
  return new RegExp(`Decision ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) \\(${action}\\) with this input\\b`).exec(text)?.[1] ?? null;
}
/**
 * The actions whose standing request the loop adopts on the server's word alone (GY-1374): they bind
 * nothing a standing one could disagree with, unlike a merge or attest (its candidate), a resolve (its
 * trigger) or a requirements decision (its scope request), each of which the history read must judge.
 */
export const adoptedOnRefusal: readonly RoutineDecisionAction[] = ['rework', 'recover', 'close'];
/**
 * The requested decision of `action` a refused request names as already standing on the item, or
 * null (GY-1374). The server keeps one request per action and refuses a second "Decision ID (ACTION)
 * is already requested on GY-N; wait for it". The loop's history read can miss it — a rework or
 * recover read that failed is taken as empty — and GY-1352's rework round was then logged failed
 * while the very decision it asked for stood, requested and awaiting its approver.
 */
export function standingNamedIn(error: unknown, action: RoutineDecisionAction): string | null {
  const text = error instanceof Error ? error.message : String(error);
  return new RegExp(`Decision ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) \\(${action}\\) is already requested on `).exec(text)?.[1] ?? null;
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
export function withheldDecision(work: Work, config: ReviewCapConfig, now: number, assessment?: ContainmentAssessment | null): { action: RoutineDecisionAction; reason: string } | null {
  const needed = neededDecision(work, config);
  if (!needed || needed.action === 'merge' || needed.action === 'attest') return null;
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
/**
 * GY-1346. The master session's turn: the loop wakes it on a changed subject and its heartbeat is
 * 30 minutes at most by default, so a judgement only the master moves — asking for a decision and
 * putting it to an approver, or resolving an escalation — is in motion for this long after the
 * product hands it over, and counts as a decision fault only once it outlasts it.
 */
export const masterTurnWaitBoundMs = 30 * 60_000;
/**
 * A headless approver run lost to something outside the loop (GY-453: killed, recording no exit)
 * judged nothing, so its launch is given back — but only this many times per decision. Past it, a
 * lost run spends its launch like any other ended session, so a decision whose approver keeps
 * being killed still reaches `maxApproverLaunches` and its escalation: at most
 * `maxApproverLaunches + maxLostApproverRuns` launches per decision.
 */
export const maxLostApproverRuns = 3;
/** Whether the watch's last run was lost and its launch is still given back (see `maxLostApproverRuns`). */
export const lostRunRefunded = (watch: Pick<ApprovalWatch, 'run' | 'lostRuns'>) =>
  watch.run?.result?.ok === false && watch.run.result.reason === 'lost' && watch.lostRuns < maxLostApproverRuns;
export type ApprovalStep =
  | { step: 'wait'; detail: string }
  | { step: 'settled'; detail: string }
  | { step: 'refused'; detail: string }
  | { step: 'rerequest'; detail: string }
  | { step: 'relaunch'; detail: string }
  | { step: 'exhausted'; detail: string }
  | { step: 'apply'; detail: string };
export function approvalStep(watch: ApprovalWatch, decision: { id?: string; action?: string; state: string; outcome?: string | null; refusal?: { approver: string; reason: string } | null; approvedBy?: string | null; approvedAt?: string | null; situation?: DecisionSituation | null } | null | undefined,
  sessions: { agents: HerdrAgent[]; available: boolean }, now: number): ApprovalStep {
  const label = `${watch.action} decision ${watch.decision} on ${watch.work}`;
  // `undefined`: the history could not be read this cycle. Nothing is concluded from that.
  if (decision === undefined) return { step: 'wait', detail: `The decision history of ${watch.work} could not be read; ${label} is looked at again next cycle` };
  if (decision === null) return { step: 'rerequest', detail: `The control plane no longer holds ${label}` };
  if (decision.state === 'applied') return { step: 'settled', detail: `The approver applied ${label}` };
  // A refusal is the approver's considered judgement (GY-141), not a session to replace or a request to repeat: the server refuses the same request unchanged, and answering it is the master's.
  if (decision.state === 'refused') return { step: 'refused', detail: `${label} was refused by ${decision.refusal?.approver ?? 'its approver'}: ${decision.refusal?.reason ?? decision.outcome ?? 'no reason recorded'}` };
  // An approved decision is already judged (GY-1300): no approver session is waited on, relaunched or spent for it. A session
  // still working on it is left its own call within the grace, and past it is put down while the server settles it (GY-1297);
  // once the session has ended, the loop asks the control plane to apply what was approved.
  if (decision.state === 'approved') {
    const working = sessions.available && sessions.agents.some(agent => agent.name === watch.agentName && agent.agent_status === 'working');
    const settle = working ? unsettledApproval({ key: watch.work }, { id: watch.decision, action: watch.action, ...decision }, now) : null;
    if (settle) return { step: 'rerequest', detail: settle };
    return working ? { step: 'wait', detail: `${label} is approved; approver session ${watch.agentName} is still applying it` }
      : { step: 'apply', detail: `${label} is ${approvedUnapplied} ${decision.approvedAt ?? 'an unrecorded time'} (approved by ${decision.approvedBy ?? 'its approver'}); the loop asks the control plane to apply it` };
  }
  if (decision.state !== 'requested') return { step: 'rerequest', detail: `${label} ended ${decision.state}${decision.outcome ? ` (${decision.outcome})` : ''}` };
  if (!sessions.available) return { step: 'wait', detail: `Herdr could not be read, so the approver session of ${label} is unknown this cycle` };
  const session = watch.agentName ? sessions.agents.find(agent => agent.name === watch.agentName) : undefined;
  const launchedAt = watch.launchedAt ? Date.parse(watch.launchedAt) : Number.NaN, age = Number.isFinite(launchedAt) ? now - launchedAt : 0;
  const ended = !session ? `approver session ${watch.agentName ?? '(never launched)'} is gone without judging it`
    : ['idle', 'done', 'blocked'].includes(session.agent_status ?? '') && age >= approverSettleMs ? `approver session ${watch.agentName} ended ${session.agent_status} without approving it — declined, or its prompt was dropped`
      : age > approverJudgeBoundMs ? `approver session ${watch.agentName} has not judged it for ${Math.round(age / 60_000)} minutes, past the ${Math.round(approverJudgeBoundMs / 60_000)}-minute bound`
        : null;
  if (!ended) return { step: 'wait', detail: `${label} is with approver session ${watch.agentName} (launch ${watch.launches} of ${maxApproverLaunches})` };
  // A lost run whose launch is given back is relaunched even from the last launch (GY-453).
  return watch.launches - (!session && lostRunRefunded(watch) ? 1 : 0) < maxApproverLaunches ? { step: 'relaunch', detail: `${label}: ${ended}` } : { step: 'exhausted', detail: `${label}: ${ended}` };
}
/** Every gate green on a submitted candidate: what "mergeable" means to the cycle and its budget. */
export const mergeableCandidate = (work: Work) => work.stage === 'merge' && !!work.candidate && !work.violations.length && work.gates.every(gate => gate.passed);
export const approvedUnapplied = 'approved but unapplied since'; // An approved decision with no outcome recorded (GY-1300); metrics reads it back from the watch.
/** The launcher key of the approver launch for a decision (GY-616). */
export const approverLaunchKey = (decision: string) => `launch:approver:${decision}`;
/** The approval-watch key of an approver session no request of the loop's launched (GY-403). */
export const handWatchPrefix = 'hand:';
/** The name prefixes every approver session for `key` starts with (see `approverSessionName`). */
export const approverPrefixes = (key: string) => ['graphyard-approver', 'gy-approver'].map(prefix => `${sessionName(prefix, key)}-`);

/** Record how a watch's session ended (GY-551). */
export function recordWatchEnded(watch: ApprovalWatch, detail: string) {
  const entry = `${watch.agentName ? `session ${watch.launches}: ` : ''}${detail}`.slice(0, 300);
  if (watch.ended.at(-1) !== entry) watch.ended = [...watch.ended, entry].slice(-10);
}


