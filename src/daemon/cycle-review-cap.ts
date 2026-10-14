// Concern: the review-round cap step (GY-1118) — a change request past the cap is withdrawn, or escalated; nothing is filed (GY-1249).
import { cappedReview, cappedReworkBinding, cappedRevisionMark, detailChanged, standingVerdict, type CappedReview } from './decisions.js';
import { decisionKey } from './reconcile.js';
import { decisionBindingMax, decisionSituation, uncitedRefusals, type DecisionSituation } from '../model/approval.js';
import { defaultReviewRoundCap, pastReviewCap, reviewRound, reviewRoundCapOf } from '../review-cap.js';
import { nextAction } from '../model/next-action.js';
import { agentOwner, type AttentionItem } from '../master/attention.js';
import { record } from './effects.js';
import { readyToRetry } from './sessions.js';
import { closeStanding, closingItems, freshReads } from './stale-closes.js';
import type { Cycle } from './cycle.js';
import type { Work } from '../model.js';
import type { MasterConfig } from '../master.js';
import { carriedRow, recordCarried, stepCallCarried, withinStepBudget } from './step-budget.js';
import { message } from './state.js';

/** How many times the step tries to withdraw one change request before it escalates instead. */
export const maxCappedFilingAttempts = 5;
/** The cursor key of one capped change request's withdrawal: per head and review, so a later request on the same head is its own. */
export const cappedFilingKey = (work: Pick<Work, 'id'>, capped: Pick<CappedReview, 'sha' | 'reviewId'>) => `${cappedHeadKey(work, capped.sha)}${capped.reviewId}`;
const cappedItemPrefix = (work: Pick<Work, 'id'>) => `review-cap:${work.id}:`, cappedHeadKey = (work: Pick<Work, 'id'>, sha: string) => `${cappedItemPrefix(work)}${sha}:`;
/** The cursor key of the escalation a blocking finding past the cap raises: one per head, re-recorded only when its findings change. */
export const cappedEscalationKey = (work: Pick<Work, 'id'>, sha: string) => `escalation:review-cap:${work.id}:${sha}`;

/** Whether a capped rework request's reason carries any policy revision mark: one requested before GY-1575 carries none. */
const revisionMarked = (reason: string | undefined) => /\[Capped review under policy revision \d+\.\]/.test(reason ?? '');
/** The refused capped reworks the loop requested for `capped`'s head and reviewer, under any policy revision. */
export const refusedCappedReworks = <D extends { action: string; state: string; input?: any }>(history: readonly D[], capped: Pick<CappedReview, 'sha' | 'reviewer'>): D[] => {
  const binding = cappedReworkBinding(capped.sha, capped.reviewer).slice(0, decisionBindingMax);
  return history.filter(entry => entry.action === 'rework' && entry.state === 'refused' && entry.input?.binding === binding);
};
/**
 * GY-1577, GY-1579. Whether `at` provably falls before the item's policy revision last changed. A decision record keeps no
 * revision and the item no time of its last revision, so this reads what that revision reset: a GitHub review the
 * requirement-review baseline does not hold was submitted after it (the rule the review gate applies, src/model/review.ts),
 * and an agent review request binds the revision it was posted under. An item never revised has no earlier revision to
 * predate. Anything else is unknown, and unknown is not before: a refusal its binding names is the record's answer, mark or
 * none (GY-1579 AC-1), so only a refusal the item's own record dates before the revision is set aside.
 */
export function beforeRevision(work: Pick<Work, 'policyRevision' | 'formalReviewResetRequired' | 'formalReviewBaseline' | 'reviewRequest' | 'candidate'>, capped: Partial<Pick<CappedReview, 'reviewId' | 'submittedAt'>>, at: string | undefined): boolean {
  const time = Date.parse(at ?? '');
  if (!Number.isFinite(time)) return false;
  if (!work.formalReviewResetRequired && work.policyRevision === 1) return false;
  const baseline = work.formalReviewBaseline, request = work.reviewRequest, id = capped.reviewId;
  const before = (since: string | undefined) => { const start = Date.parse(since ?? ''); return Number.isFinite(start) && time < start; };
  if (baseline && baseline.pr === work.candidate?.pr && baseline.policyRevision === work.policyRevision && Number.isSafeInteger(id) && id! > 0 && !baseline.reviewIds.includes(id!))
    return before(capped.submittedAt);
  return !!request && request.policyRevision === work.policyRevision && before(request.createdAt);
}
/**
 * GY-1575. The approver's refusal of the rework the loop requested for a capped change request on
 * `capped`'s head and reviewer under the item's policy revision, or null: the approver judged its findings
 * non-blocking, so the review-cap step withdraws the request and has the head re-reviewed with the
 * refusal's reasoning. A refusal judged under an earlier policy revision binds no later change request.
 * GY-1577, GY-1579: a refusal requested before the mark existed carries none; its binding alone names the head and
 * reviewer it judged, so it binds unless the item's record dates it before the revision last changed (`beforeRevision`).
 */
export function refusedCappedRework<D extends { action: string; state: string; input?: any; reason?: string; requestedAt?: string; refusal?: { at?: string } | null }>(history: readonly D[],
  capped: Pick<CappedReview, 'sha' | 'reviewer'> & Partial<Pick<CappedReview, 'reviewId' | 'submittedAt'>>, work: Parameters<typeof beforeRevision>[0]): D | null {
  const mark = cappedRevisionMark(work.policyRevision);
  // The binding names the head and reviewer whose verdict was judged; a base the head later sits on does not change that verdict, so the
  // refusal's recorded base is not compared, marked or unmarked (GY-1577 review): the candidate's base follows main and would strand it.
  return refusedCappedReworks(history, capped).find(entry => entry.reason?.includes(mark)
    || !revisionMarked(entry.reason) && !beforeRevision(work, capped, entry.refusal?.at ?? entry.requestedAt)) ?? null;
}
/**
 * GY-1579. A refused capped rework on `capped`'s head that `refusedCappedReworks` cannot read, or null:
 * its binding names the head as capped (or, binding none or in another format, its situation or reason
 * names the head and the cap) but not this reviewer, and its reason carries no revision mark either. Such a refusal answers
 * the round all the same, so the review-cap step escalates it by id rather than waiting on it silently.
 * A refusal marked under a policy revision is not one: it judged that revision's change request.
 */
export function unmatchedCappedRefusal<D extends { action: string; state: string; input?: any; reason?: string; situation?: { sha: string | null } | null }>(history: readonly D[], capped: Pick<CappedReview, 'sha' | 'reviewer'>): D | null {
  const binding = cappedReworkBinding(capped.sha, capped.reviewer).slice(0, decisionBindingMax);
  return history.find(entry => {
    if (entry.action !== 'rework' || entry.state !== 'refused' || entry.input?.binding === binding || revisionMarked(entry.reason)) return false;
    // A capped binding names its head outright; any other binding, or none, leaves the head and the cap to the situation and reason.
    const bound = typeof entry.input?.binding === 'string' ? entry.input.binding as string : null;
    if (bound?.includes(':capped:')) return bound.startsWith(`${capped.sha}:capped:`);
    return (entry.situation?.sha === capped.sha || !!entry.reason?.includes(capped.sha)) && /\bpast (?:its|the) (?:review-round )?cap\b|\bcapped\b/i.test(entry.reason ?? '');
  }) ?? null;
}
/**
 * GY-1580. The master's own answers to a refused capped head's escalation, refused in turn, earliest first: the
 * hand reworks (no grounds binding) on `sha` that cite `refused` by id, as precedent or in its reason, requested
 * after `since`. An answer judges the change request it was requested after, so `since` is that change request's
 * submission (GY-1580 review), never only the first refusal's time: an answer requested before the re-review posted
 * answers nothing on it. An approver who refused it judged that finding non-blocking too, so the review-cap step
 * withdraws the change request once more. Read from the history and the review alone, the guard outlives the
 * cursor's pruned rows.
 */
export function refusedCapAnswers<D extends { id: string; action: string; state: string; input?: any; reason?: string; requestedAt?: string; precedent?: string[]; situation?: { sha: string | null } | null; refusal?: { at?: string } | null }>(
  history: readonly D[], refused: Pick<D, 'id'>, sha: string, since: string | undefined): D[] {
  const after = Date.parse(since ?? '');
  if (!Number.isFinite(after)) return [];
  const cites = (entry: D) => !!entry.precedent?.includes(refused.id) || !!entry.reason?.includes(refused.id.slice(0, 8));
  return history.filter(entry => entry.id !== refused.id && entry.action === 'rework' && entry.state === 'refused' && entry.input?.binding === undefined
    && (!entry.situation?.sha || entry.situation.sha === sha) && cites(entry) && Date.parse(entry.requestedAt ?? '') > after)
    .sort((a, b) => Date.parse(a.requestedAt!) - Date.parse(b.requestedAt!));
}
/**
 * How the refused reworks asked again on this head bear on `capped`'s change request, submitted at `submittedAt` after
 * `refused`: a withdrawal the loop made on one is read from the history alone, so the guard outlives pruned rows.
 * The escalation of a first re-review's change request asks for an answer citing the capped refusal only, and that of
 * a later one for an answer citing the earlier answers too. So `answer`, the earliest answer requested after the
 * change request that cites no other answer, answers it as the first re-review's: the loop withdraws it once more.
 * GY-1810: the loop's own capped rework on this same binding, refused as non-blocking, answers it the same way,
 * without a master answer — a low or medium lane applies a hand rework at once (src/server/lane-rework.ts), so on
 * those no refused hand answer can ever exist and this request is the only answer the round can get; the loop's
 * capped rework waits for its approver in every lane, so its refusal binds in all of them. As with a hand answer,
 * the one requested after this change request answers it, and an earlier one is `judged`, cited by what follows. `judged` holds every other refused answer the change request follows — one requested and refused before it
 * was submitted, or one citing an earlier answer — newest last, uncited ones only, as a new request must cite them; with
 * no `answer`, any of them makes this change request the one after a second withdrawal, escalated and never withdrawn.
 * GY-1813: uncited, that is, by a refusal the change request itself follows. A refusal requested after the review was
 * submitted is this round's own answer, so what it cites covers nothing for the request that answers the round: a
 * newer refused capped rework that cites the second refusal leaves that second one standing, and the escalation cites
 * the first and second refusals — the post-review refusal never takes the second one's place. One whose time the
 * record cannot place against the review keeps the older reading, as unknown is not after.
 * An answer requested before the head's first re-review posted reads the same as one a withdrawal followed (GitHub's
 * observation keeps one review per reviewer); it never hides a later answer to the first re-review, which still withdraws.
 */
export function refusedAnswerStanding<D extends Parameters<typeof refusedCapAnswers>[0][number]>(history: readonly D[], refused: D, sha: string, submittedAt: string | undefined): { answer: D | null; judged: D[] } {
  const answers = refusedCapAnswers(history, refused, sha, refused.refusal?.at ?? refused.requestedAt), submitted = Date.parse(submittedAt ?? '');
  const cites = (entry: D, other: D) => !!entry.precedent?.includes(other.id) || !!entry.reason?.includes(other.id.slice(0, 8));
  const chained = (entry: D) => answers.some(other => other.id !== entry.id && cites(entry, other));
  const asked = history.filter(entry => entry.id !== refused.id && entry.action === 'rework' && entry.state === 'refused'
    && entry.input?.binding !== undefined && entry.input?.binding === refused.input?.binding
    && Date.parse(entry.requestedAt ?? '') > Date.parse(refused.refusal?.at ?? refused.requestedAt ?? ''))
    .sort((a, b) => Date.parse(a.requestedAt!) - Date.parse(b.requestedAt!));
  const answer = answers.find(entry => Date.parse(entry.requestedAt!) > submitted && !chained(entry))
    ?? (asked.length && Date.parse(asked[0]!.requestedAt!) > submitted ? asked[0]! : null);
  const judged = [...answers, ...asked].filter(entry => entry !== answer && (chained(entry)
    || Date.parse(entry.requestedAt!) <= submitted && Date.parse(entry.refusal?.at ?? entry.requestedAt!) < submitted));
  const standing = [...answers, ...asked];
  // GY-1813: a refusal requested after the change request was submitted is this round's own answer, not one the
  // change request follows, so what it cites covers nothing for the request that answers the refusals standing when
  // the review landed: a newer refused capped rework citing the second refusal leaves the second one standing, and
  // the escalation cites it beside the first — the post-review refusal never takes the second one's place. One whose
  // time the record cannot place against the review keeps the older reading, as unknown is not after.
  const follows = (other: D) => !Number.isFinite(submitted) || Date.parse(other.requestedAt ?? '') <= submitted;
  return { answer, judged: judged.filter(entry => !standing.some(other => other.id !== entry.id && follows(other) && cites(other, entry))) };
}
/** The cursor key of the re-review an approver's refusal of a capped rework asks for (GY-1575): one per head. */
export const cappedRereviewKey = (work: Pick<Work, 'id'>, sha: string) => `review-cap:rereview:${work.id}:${sha}`;
/** The cursor key of the second re-review a refused master answer asks for (GY-1580): one per head. */
export const answeredRereviewKey = (work: Pick<Work, 'id'>, sha: string) => `${cappedRereviewKey(work, sha)}:answered`;
/**
 * The follow-up items the master filed for a refused capped rework (GY-1575): open items the refusal's
 * reasoning names, items filed from the item's review, and items filed since the refusal that name the item.
 * Every one is named: a follow-up the request left out is one the reviewer cannot list.
 */
export function refusalFollowUps(work: Pick<Work, 'key'>, refusal: { reason: string; at?: string }, all: readonly Pick<Work, 'key' | 'title' | 'description' | 'createdAt' | 'origin' | 'stage'>[]): string[] {
  const named = new Set(refusal.reason.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? []), since = Date.parse(refusal.at ?? '');
  const mentions = new RegExp(`\\b${work.key}\\b`);
  return all.filter(other => other.key !== work.key && other.stage !== 'done' && (named.has(other.key) || other.origin?.reviewFollowUps?.parent === work.key
    || Number.isFinite(since) && Date.parse(other.createdAt) >= since && mentions.test(`${other.title}\n${other.description ?? ''}`)))
    .map(other => other.key);
}

/**
 * The fresh review request a refused capped rework makes of the reviewer, posted as the withdrawal's
 * message (GY-1575): the approver's reasoning, and the follow-up items, so the reviewer lists those
 * findings as FOLLOW-UP threads on the same head rather than requesting changes again. The launched
 * reviewer's prompt carries the same text (src/reviewer.ts cappedRefusalRequest), whole: the reasoning
 * is never cut short of the bound the approval accepts.
 */
export function refusedCapRereview(capped: Pick<CappedReview, 'round' | 'cap' | 'sha'>, refusal: { id: string; approver: string; reason: string }, followUps: readonly string[], answer?: { id: string; approver: string; reason: string }) {
  const listed = followUps.length ? `; the follow-up ${followUps.length === 1 ? 'item' : 'items'} filed for them: ${followUps.join(', ')}` : '';
  // GY-1580, GY-1810: the rework asked again on the re-review's change request — the master's answer, or the loop's own
  // capped rework — was refused too; both judgements travel with the request.
  if (answer) return `Graphyard withdrew this change request: review round ${capped.round} is past the cap of ${capped.cap}. Independent approver ${refusal.approver} refused the rework it first asked for as non-blocking (decision ${refusal.id}): ${refusal.reason}\n\n`
    + `The re-review requested changes again; the rework was asked for again, and independent approver ${answer.approver} refused it as non-blocking too (decision ${answer.id}): ${answer.reason}\n\n`
    + `Re-review head ${capped.sha} and approve it, listing these findings as FOLLOW-UP threads, not as a change request${listed}. `
    + 'Only a finding that breaks a criterion neither refusal judged is BLOCKING. A change request on this head again is escalated, not withdrawn a third time.';
  return `Graphyard withdrew this change request: review round ${capped.round} is past the cap of ${capped.cap}, and independent approver ${refusal.approver} refused the rework it asked for as non-blocking (decision ${refusal.id}): ${refusal.reason}\n\n`
    + `Re-review head ${capped.sha} and list these findings as FOLLOW-UP threads, not as a change request${listed}. `
    + 'A change request on this head again is escalated, not withdrawn a second time.';
}

/** The refusal an approver gave a capped rework decision, as the re-review request names it. `binding` names the grounds the refused rework carried, when it carried any: the loop's own capped rework answers its round on it (GY-1810), a hand answer has none. */
export type CapRefusal = { id: string; approver: string; reason: string; at?: string; binding?: unknown };
export function capRefusalOf(refused: { id: string; outcome?: string | null; input?: { binding?: unknown } | null; refusal?: { approver?: string; reason?: string; at?: string } | null }): CapRefusal {
  return { id: refused.id, approver: refused.refusal?.approver ?? 'its approver', reason: refused.refusal?.reason ?? refused.outcome ?? 'no reason recorded', ...(refused.refusal?.at ? { at: refused.refusal.at } : {}),
    ...(refused.input?.binding !== undefined ? { binding: refused.input.binding } : {}) };
}

/**
 * The re-review request for `sha` when an approver refused its capped rework (GY-1575 AC-2), from the
 * item's decision history and the open items, or null when no such refusal binds the head and its
 * reviewer App. The reviewer launch puts it in the session's prompt, so the reviewer it starts lists
 * the refused findings as FOLLOW-UP threads: the same text the withdrawal posted on the pull request.
 */
export function cappedRefusalRequest(work: Work, sha: string, config: Partial<Pick<MasterConfig, 'reviewRoundCap' | 'reviewer'>>, history: readonly { id: string; action: string; state: string; input?: any; reason?: string; outcome?: string | null; refusal?: { approver?: string; reason?: string; at?: string } | null }[],
  all: Parameters<typeof refusalFollowUps>[2]): string | null {
  if (!config.reviewer) return null;
  const reviewer = `${config.reviewer.slug}[bot]`;
  // The change request the refusal judged, by which an unmarked refusal is dated against the policy revision (GY-1577).
  const judged = work.observation?.reviews.filter(review => review.sha === sha && review.reviewer.toLowerCase() === reviewer.toLowerCase()).at(-1);
  const refused = refusedCappedRework(history, { sha, reviewer, reviewId: judged?.id ?? null, ...(judged?.submittedAt ? { submittedAt: judged.submittedAt } : {}) }, work);
  if (!refused) return null;
  const refusal = capRefusalOf(refused);
  // The master's refused answer to the re-review's change request is the second re-review's (GY-1580): one requested
  // after that change request, so the first re-review, whose latest review on the head predates the refusal, carries none.
  const rereview = !!judged?.submittedAt && Date.parse(judged.submittedAt) > Date.parse(refusal.at ?? '');
  const answered = rereview ? refusedAnswerStanding(history, refused, sha, judged!.submittedAt).answer : null, answer = answered ? capRefusalOf(answered) : undefined;
  return refusedCapRereview({ round: reviewRound(work), cap: reviewRoundCapOf(config), sha }, refusal, capFollowUps(work, [refusal, ...answer ? [answer] : []], all), answer);
}

/** The follow-up items of every refusal on the head, each named once (GY-1580). */
export const capFollowUps = (work: Pick<Work, 'key'>, refusals: readonly CapRefusal[], all: Parameters<typeof refusalFollowUps>[2]) =>
  [...new Set(refusals.flatMap(refusal => refusalFollowUps(work, refusal, all)))];

/**
 * Whether `capped` was submitted after the approver refused its head's capped rework (GY-1575): the change
 * request that refusal judged predates it, so a later one is the re-review's. Read from the decision history
 * and the review itself, this is the once-per-head guard the cursor's rows cannot keep: those are resolved
 * actions, and pruneDaemonState retires them oldest first on a busy fleet.
 */
export const requestedSinceRefusal = (capped: Pick<CappedReview, 'submittedAt'>, refusal: Pick<CapRefusal, 'at'>) =>
  Date.parse(capped.submittedAt ?? '') > Date.parse(refusal.at ?? '');

/** The decision states in which a capped rework still has an actor: its approver, or the loop applying the approval. */
const pendingReworkStates = new Set(['requested', 'approved']);

/**
 * GY-1577. Why the step cannot act on a refused capped rework of `capped`'s head, or null when it can wait: the
 * history holds a refusal for the head's binding that binds no change request under the item's policy revision
 * (`refusedCappedRework`), no capped rework under that revision stands before its approver, and the loop has
 * already asked under it (`requested`: its approval watch), so nothing would request one. The reason names
 * the refused decision; the escalation (`cappedEscalation`) adds the commands that answer it.
 */
export function strandedCappedRefusal(work: Pick<Work, 'key' | 'policyRevision' | 'candidate'>, capped: CappedReview, history: readonly { id: string; action: string; state: string; input?: any; reason?: string; outcome?: string | null; refusal?: { approver?: string; reason?: string; at?: string } | null; precedent?: string[]; situation?: DecisionSituation | null }[], requested: boolean): string | null {
  const refused = refusedCappedReworks(history, capped);
  if (!refused.length || !requested) return null;
  const binding = refused[0].input.binding, mark = cappedRevisionMark(work.policyRevision);
  // Only a request still before its approver, or approved and awaiting its apply, has an actor; a superseded, failed, stale or withdrawn one has none (GY-1577 review).
  if (history.some(entry => entry.action === 'rework' && pendingReworkStates.has(entry.state) && entry.input?.binding === binding && !!entry.reason?.includes(mark))) return null;
  // A new request must answer every refusal still standing for this candidate: the server's standingRefusal follows citations from the
  // newest, so the escalation names each uncited refusal (newest last, as readDecisions lists them), never only the oldest (GY-1577 review).
  const leaves = uncitedRefusals(refused.map(entry => ({ ...entry, input: entry.input, reason: entry.reason ?? '' })), 'rework', refused[0].input, () => true, decisionSituation('rework', work));
  const cite = leaves.length ? leaves : [refused.at(-1)!.id];
  const latest = capRefusalOf(refused.find(entry => entry.id === cite.at(-1))!);
  return `${capped.reason}; independent approver ${latest.approver} refused its capped rework (decision ${latest.id}), but that refusal does not bind this change request under policy revision ${work.policyRevision} `
    + `(it predates the revision, or its time cannot be placed after it), and no capped rework under revision ${work.policyRevision} stands for an approver, so the review-cap step can neither withdraw it nor wait on a judgement; a new request cites ${cite.join(', ')} (--precedent ${cite.join(',')})`;
}

/**
 * The escalation's detail: the round, the cap, the findings, and the decision the independent approver is asked for.
 * After a refusal (GY-1575) it names only what the master may run on a system-driven item (GY-1580): a hand
 * `master review` is the loop's, so the answer is a rework citing the refusals, which the loop's withdrawal follows
 * when an approver refuses that too.
 */
export function cappedEscalation(work: Pick<Work, 'key'>, capped: CappedReview, why = capped.reason, refusals: readonly Pick<CapRefusal, 'id'>[] = []) {
  const cited = refusals.map(refusal => refusal.id).join(',');
  if (refusals.length === 1) return `${why}. The review-round cap requests no further rework for ${work.key}: the master answers it — read the refusal with graphyard master decisions ${work.key}, `
    + `then request the rework the re-review's finding needs with graphyard master decide ${work.key} rework --precedent ${cited} REASON, citing that refusal and what the re-review found beyond it. `
    + 'An approver who refuses that as non-blocking too has the loop withdraw the change request once more and the head re-reviewed with both refusals, its findings listed as FOLLOW-UP';
  if (refusals.length) return `${why}. The review-round cap requests no further rework or withdrawal for ${work.key}: the master answers it — read the refusals with graphyard master decisions ${work.key}; `
    + `a rework the finding still needs is requested with graphyard master decide ${work.key} rework --precedent ${cited} REASON, citing each and what this review found beyond them`;
  return `${why}. The review-round cap requests no further rework for ${work.key}: an independent approver decides whether the finding is blocking — `
    + `graphyard master decide ${work.key} rework REASON (one more round for exactly that finding), then graphyard master approver ${work.key} DECISION — `
    + `or, judging it non-blocking, has the reviewer re-review the head and list it as a FOLLOW-UP`;
}

/**
 * Step 4b. Each open item past its review-round cap whose head carries a change request
 * (`cappedReview`): one that names no blocking finding is withdrawn as the reviewer App — its
 * findings are nits, and nothing is filed for them (GY-1249) — so the review request is answered
 * afresh on the same head and the item goes on toward merge with no rework; one that names a
 * blocking finding, or that Graphyard cannot withdraw, is put to an independent approver: the
 * routine decisions request its rework decision for the approver the loop launches (`neededDecision`,
 * GY-1389), and only a loop without the decision effects escalates it for a master to request. Each request is
 * withdrawn once, keyed on its head and review id; a failed withdrawal is retried with backoff and escalated after
 * `maxCappedFilingAttempts`. A head is withdrawn at most once: a later change request on the same
 * head, from its re-review, is escalated instead, so a reviewer that keeps requesting changes
 * cannot keep the head re-reviewing.
 */
export const reviewCapStep = (cycle: Cycle) => withinStepBudget(cycle, 'review-cap', ['withdrawReview', 'wakeObservation', 'decisions'], reviewCapStepWithin); // GY-1774: the withdrawal, the observation wake and the decision history read are bounded
async function reviewCapStepWithin(cycle: Cycle) {
  const { config, state, effects, performed, isolate, now } = cycle;
  // A withdrawal spends a fresh review on the head; an item a close stands on is not reviewed again (GY-1439).
  // A close the loop already knows of holds the item without a read. Otherwise this step, which runs before the
  // decisions step drops the kept histories a hand close changed, reads the item's history afresh, and only when
  // a withdrawal is due: at most once a head.
  const closing = closingItems(cycle), reads = freshReads(cycle);
  for (const item of cycle.open) await isolate('review', item, item.key, async () => {
    // GY-1774: the observation wake a withdrawal owes, carried past the step's bound, is retried until it answers — joining the wake in
    // flight or consuming its answer — so the owed request-rework is cancelled. It is retried whether or not the change request still
    // stands on the snapshot: the withdrawal that owes it dismissed that request, so the next snapshot reads no capped review, and the
    // owed wake is found by its row alone; it holds nothing else on the item.
    const wake = async (wakeKey: string, what: string): Promise<string> => {
      if (!effects.wakeObservation) return 'the owed request-rework is cancelled at the next observation (this loop runs without the observation wake)';
      try { await effects.wakeObservation(item); return 'its observation woken so the owed request-rework is cancelled'; }
      catch (error) {
        if (stepCallCarried(error)) { await recordCarried(cycle, wakeKey, { kind: 'review', work: item.key }, error, what); return 'its observation wake was carried to the next cycle, which retries it so the owed request-rework is cancelled'; }
        return `the owed request-rework is cancelled at the next observation (waking it failed: ${message(error).slice(0, 200)})`;
      }
    };
    for (const [wakeKey, owedWake] of Object.entries(state.actions).filter(([rowKey, row]) => rowKey.startsWith(cappedItemPrefix(item)) && rowKey.endsWith(':wake') && carriedRow(row))) {
      const [, , sha, reviewId] = wakeKey.split(':');
      const woken = await wake(wakeKey, `Waking ${item.key}'s observation after withdrawing change request ${reviewId} on ${sha.slice(0, 12)}`);
      if (state.actions[wakeKey] === owedWake) // not carried again
        performed.push(await record(state, wakeKey, { kind: 'review', work: item.key, principal: null, state: 'done', detail: `Retried the observation wake owed since change request ${reviewId} on ${sha.slice(0, 12)} was withdrawn: ${woken}`, attempts: owedWake.attempts, cycle: state.cycle }, now(), effects.persist));
    }
    const capped = cappedReview(item, config);
    if (!capped) return;
    const escalate = async (why?: string, refusals: readonly CapRefusal[] = []) => {
      const key = cappedEscalationKey(item, capped.sha), detail = cappedEscalation(item, capped, why, refusals);
      if (detailChanged(state.actions[key], detail))
        performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
    };
    const key = cappedFilingKey(item, capped), previous = state.actions[key];
    if (previous?.state === 'done') return;
    const head = cappedHeadKey(item, capped.sha);
    const earlier = Object.keys(state.actions).find(other => other !== key && other.startsWith(head) && state.actions[other]?.state === 'done');
    let refusal: CapRefusal | null = null, answer: CapRefusal | null = null;
    const again = `${capped.reason}, after the independent approver refused its capped rework as non-blocking and Graphyard withdrew the change request on the same head; its re-review requested changes again, so it is not withdrawn a second time`;
    const thrice = `${capped.reason}, after the independent approvers refused its capped rework and the rework asked for on its re-review as non-blocking, and Graphyard withdrew the change request on the same head twice; its re-review requested changes again, so it is not withdrawn a third time`;
    const decisionHistory = () => effects.decisions ? effects.decisions(item).then(result => result.decisions, error => { if (stepCallCarried(error)) throw error; return null; }) : Promise.resolve(null); // GY-1774: a carried read is the item's carried handling, never an empty history
    // A nits-only change request needs no approver; past a refused capped rework on the head it is judged as the escalated one is (GY-1580 review).
    const judged = capped.kind === 'escalate';
    // A loop that requests decisions asks its approver for this round itself (neededDecision, GY-1389).
    if (judged && (!effects.decide || !effects.approver)) return escalate();
    // GY-1583: a nits-only change request reads the history only where it bears on the outcome — beside a withdrawal
    // already made on the head, or once a withdrawal is due — so a quiet cycle over a held item reads none.
    const history = judged || earlier ? await decisionHistory() : null;
    const refused = history ? refusedCappedRework(history, capped, item) : null;
    // Until the approver refuses the rework the loop requested, the round is the approver's to judge.
    if (judged && !refused) {
      // GY-1577: a refusal of this head's capped rework the step cannot act on, with no request under this revision before
      // the approver and none still owed by the loop, would strand the change request with no actor: it escalates instead.
      const stranded = history ? strandedCappedRefusal(item, capped, history, !!state.approvals[decisionKey(item, { action: 'rework', binding: cappedReworkBinding(capped.sha, capped.reviewer) })]) : null;
      if (stranded) return escalate(stranded);
      // GY-1579: a refusal of this head's capped round its record does not bind to this reviewer is still an answer; it is escalated by id, never left unacted.
      const unmatched = history ? unmatchedCappedRefusal(history, capped) : null;
      if (unmatched) return escalate(`${capped.reason}; independent approver ${capRefusalOf(unmatched).approver} refused capped rework decision ${unmatched.id} on ${capped.sha.slice(0, 12)}, but its record binds ${capped.reviewer}'s change request under none of its readings (binding ${String(unmatched.input?.binding ?? 'none')}, no policy revision mark), so the loop cannot withdraw the request on it`, [capRefusalOf(unmatched)]);
      return;
    }
    /** The re-review of a refused capped head (GY-1575): `'escalated'`, the refusals it is withdrawn on, or null when it is no re-review. */
    const rereviewed = async (history: NonNullable<Awaited<ReturnType<typeof decisionHistory>>>, refused: NonNullable<ReturnType<typeof refusedCappedRework<typeof history[number]>>>) => {
      // The cursor's row may be pruned; a change request submitted after the refusal is the re-review's all the same (GY-1575).
      if (state.actions[cappedRereviewKey(item, capped.sha)]?.state !== 'done' && !requestedSinceRefusal(capped, capRefusalOf(refused))) return null;
      const first = capRefusalOf(refused);
      // GY-1580: the master's answer to that escalation, refused as non-blocking too, has it withdrawn once more; a
      // change request after that withdrawal escalates, never withdrawn a third time (`refusedAnswerStanding`).
      const standing = refusedAnswerStanding(history, refused, capped.sha, capped.submittedAt);
      if (standing.answer && state.actions[answeredRereviewKey(item, capped.sha)]?.state !== 'done') return { refusal: first, answer: capRefusalOf(standing.answer) };
      await escalate(standing.answer || standing.judged.length ? thrice : again, [first, ...standing.judged.map(capRefusalOf)]);
      return 'escalated' as const;
    };
    const standing = refused ? await rereviewed(history!, refused) : null;
    if (standing === 'escalated') return;
    if (standing) ({ refusal, answer } = standing);
    else if (judged) refusal = capRefusalOf(refused!);
    if (judged) {
      const own = !!config.reviewer && capped.reviewer.toLowerCase() === `${config.reviewer.slug}[bot]`.toLowerCase();
      if (!own || capped.reviewId === null)
        return escalate(`${capped.reason}; the independent approver refused its capped rework as non-blocking (decision ${refusal!.id}), but Graphyard cannot withdraw a verdict it did not obtain through its reviewer App`);
    }
    // A head is withdrawn once: its re-review requesting changes again escalates rather than repeating the withdrawal (GY-1118 review),
    // unless an approver refused the master's answer to that escalation as well (GY-1580).
    if (earlier && !answer) return escalate(`${capped.reason}, after change request ${earlier.slice(head.length)} on the same head was already withdrawn; its re-review requested changes again, so it is not withdrawn a second time`, refusal ? [refusal] : []);
    if (!effects.withdrawReview)
      return escalate(`${capped.reason}, and this loop runs without the reviewer App it needs to withdraw the request`);
    // GY-1774: only failures count toward the cap; a withdrawal carried past the bound is still in flight, and its row counts the sends made, never the cycles waited.
    if (previous?.state === 'failed' && previous.attempts >= maxCappedFilingAttempts) return escalate(`${capped.reason}; withdrawing it failed ${previous.attempts} times (${previous.detail.slice(0, 300)})`);
    if (!readyToRetry(previous, state.cycle)) return;
    if (closing.has(item.key) || await closeStanding(reads, item, cycle.snapshot.work, closing)) return;
    if (!history) {
      const due = await decisionHistory(), refused = due ? refusedCappedRework(due, capped, item) : null, standing = refused ? await rereviewed(due!, refused) : null;
      if (standing === 'escalated') return;
      if (standing) ({ refusal, answer } = standing);
    }
    const followUps = refusal ? capFollowUps(item, [refusal, ...answer ? [answer] : []], cycle.snapshot.work) : [];
    const reason = answer && refusal
      ? `Review round ${capped.round} of ${item.key} is past its cap of ${capped.cap}: independent approver ${answer.approver} ${answer.binding !== undefined ? `refused the capped rework asked again on this binding (decision ${answer.id})` : `refused the master's answer (decision ${answer.id}) to the re-review of refused capped rework ${refusal.id}`} as non-blocking, so ${capped.reviewer}'s change request ${capped.reviewId} on ${capped.sha.slice(0, 12)} is withdrawn once more and the head re-reviewed with both refusals' findings as FOLLOW-UP`
      : refusal
      ? `Review round ${capped.round} of ${item.key} is past its cap of ${capped.cap}: independent approver ${refusal.approver} refused the capped rework (decision ${refusal.id}) as non-blocking, so ${capped.reviewer}'s change request ${capped.reviewId} on ${capped.sha.slice(0, 12)} is withdrawn and the head re-reviewed with its findings as FOLLOW-UP`
      : `Review round ${capped.round} of ${item.key} is past its cap of ${capped.cap}: ${capped.reviewer}'s change request ${capped.reviewId} on ${capped.sha.slice(0, 12)} names no BLOCKING: finding, so its findings are nits, not filed, and the item proceeds toward merge without another rework`;
    const request = refusal ? refusedCapRereview(capped, refusal, followUps, answer ?? undefined)
      : `Graphyard withdrew this change request: review round ${capped.round} is past the cap of ${capped.cap}, and it names no BLOCKING: finding. Its findings are nits and are not filed; the head is reviewed again, and only a BLOCKING: finding holds it.`;
    try {
      await effects.withdrawReview(item, capped.reviewId!, request);
    } catch (error) {
      if (stepCallCarried(error)) return recordCarried(cycle, key, { kind: 'review', work: item.key }, error, `Withdrawing ${capped.reviewer}'s change request ${capped.reviewId} on ${item.key}`);
      performed.push(await record(state, key, { kind: 'review', work: item.key, principal: null, state: 'failed', detail: `${reason}, but withdrawing it failed: ${error instanceof Error ? error.message : String(error)}`,
        attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      return;
    }
    if (!refusal) {
      performed.push(await record(state, key, { kind: 'review', work: item.key, principal: null, state: 'done', detail: `${reason}: ${capped.findings.length} finding${capped.findings.length === 1 ? '' : 's'} left as nits, nothing filed, and the change request withdrawn`,
        attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      return;
    }
    // GY-1575: the owed request-rework is the plane's row for a change request that no longer stands; a fresh
    // observation reads the withdrawal and retires it, so the head's review request is answered afresh.
    const cancelled = await wake(`${key}:wake`, `Waking ${item.key}'s observation after withdrawing ${capped.reviewer}'s change request ${capped.reviewId}`);
    performed.push(await record(state, key, { kind: 'review', work: item.key, principal: null, state: 'done', detail: `${reason}: the change request withdrawn and ${cancelled}`,
      attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
    performed.push(await record(state, answer ? answeredRereviewKey(item, capped.sha) : cappedRereviewKey(item, capped.sha), { kind: 'review', work: item.key, principal: null, state: 'done', detail: `Requested a fresh review of ${item.key} on ${capped.sha.slice(0, 12)}: ${request}`,
      attempts: 1, cycle: state.cycle }, now(), effects.persist));
  });
}

/** The loop's cursor as `master status` reads it for the review-cap hold: its action rows and its standing decision watches. */
export interface ReviewCapCursor {
  actions?: Record<string, { state: string; detail: string; attempts?: number }>;
  approvals?: Record<string, { work: string; action: string; decision: string; settledAt: string | null; agentName: string | null }>;
}

/** Whether the review-cap step holds `item`'s head with nothing that would itself relaunch a review in motion (GY-1810 AC-2): the item is system-driven, past its cap with a change request standing on its head, and it has no review request open for the head, no request-review action queued, and no withdrawal still owed or retried (a withdrawal that failed `maxCappedFilingAttempts` times is escalated, not retried). */
const reviewCapHoldsHead = (item: Work, all: readonly Work[], cursor: ReviewCapCursor | null | undefined, cap: number, now: number): boolean =>
  item.systemDriven === true && !!item.candidate && !!item.observation && pastReviewCap(item, cap)
  && !!standingVerdict(item)
  // A binding agent verdict answers the request it was recorded for, so that request is no review in motion.
  && (!(item.reviewRequest && item.reviewRequest.sha === item.candidate.sha) || !item.observation.reviews.some(review => review.sha === item.candidate!.sha && review.state === 'CHANGES_REQUESTED')) && item.autoDispatch?.review?.state !== 'requested'
  && nextAction(item, [...all], new Date(now))?.kind !== 'request-review'
  && !Object.entries(cursor?.actions ?? {}).some(([key, action]) => key.startsWith(cappedHeadKey(item, item.candidate!.sha)) && action.state !== 'done' && !(action.state === 'failed' && (action.attempts ?? 0) >= maxCappedFilingAttempts));

/** Why the step holds the head when it has escalated nothing: the round's rework decision before its approver, or the bare hold. */
const reviewCapHold = (item: Work, cursor: ReviewCapCursor | null | undefined): string => {
  const watch = Object.values(cursor?.approvals ?? {}).find(entry => entry.work === item.key && entry.action === 'rework' && !entry.settledAt);
  return watch ? `the round's rework decision ${watch.decision} stands before its independent approver${watch.agentName ? ` (${watch.agentName})` : ''}, so the change request on this head is neither withdrawn nor answered and no review is relaunched until it judges`
    : `its change request on this head stands past the review-round cap with no review request open, none queued and no withdrawal owed, so no review is relaunched`;
};

/**
 * GY-1810 AC-2. `master status` with every review-gate attention row that says the loop relaunches the review on its
 * own replaced, wherever that would be false: the item is past its review-round cap with a change request standing on
 * its head, and it has no review request open, no request-review action queued and no withdrawal owed, so the loop
 * relaunches nothing — its review-cap step holds the head. Such a row is the stalled step naming the head: the head's
 * standing escalation when the step raised one (it names the refusals and the command that answers it), else the
 * round's wait. A state any of those reads answers keeps the loop's row, and a row for another gate is never touched.
 */
export function stalledReviewCapAttention<T extends { work: Array<{ key: string; attention: string | null; attentionOwner?: { next: string } | null; refusal?: { gate?: string } | null }>; attentionItems: AttentionItem[]; counts?: { attention: number } }>(
  status: T, all: readonly Work[], cursor: ReviewCapCursor | null | undefined, cap = defaultReviewRoundCap, now = Date.now()): T {
  const held = new Map<string, { text: string; next: string; was: { text: string | null; next: string } }>();
  for (const row of status.work) {
    if (row.refusal?.gate !== 'review' || !row.attentionOwner?.next.includes('the loop relaunches the review on its own')) continue;
    const item = all.find(candidate => candidate.key === row.key);
    if (!item || !reviewCapHoldsHead(item, all, cursor, reviewRoundCapOf({ reviewRoundCap: cap }), now)) continue;
    const sha = item.candidate!.sha, escalation = cursor?.actions?.[`escalation:review-cap:${item.id}:${sha}`];
    const was = { text: row.attention, next: row.attentionOwner.next };
    held.set(row.key, escalation?.detail ? { text: `${row.key}'s review-cap step is stalled on ${sha.slice(0, 12)}: ${escalation.detail}`, next: escalation.detail, was }
      : { text: `${row.key}'s review-cap step is stalled on ${sha.slice(0, 12)}: ${reviewCapHold(item, cursor)}`, next: `graphyard master decisions ${row.key}`, was });
  }
  if (!held.size) return status;
  const rows = status.work.map(row => held.has(row.key) ? { ...row, attention: held.get(row.key)!.text, attentionOwner: agentOwner('master', held.get(row.key)!.next) } : row);
  // Only the review-gate entry the work row represents is replaced; the item's supervised, remedy and capacity entries keep their own text and next action.
  const gate = (entry: AttentionItem) => { const was = held.get(entry.subject)?.was; return !!was && entry.text === was.text && entry.next === was.next; };
  const attentionItems = status.attentionItems.map(entry => gate(entry)
    ? { ...entry, text: held.get(entry.subject)!.text, ...agentOwner('master', held.get(entry.subject)!.next) } : entry);
  return { ...status, work: rows, attentionItems };
}
