// Concern: the review-round cap step (GY-1118) — a change request past the cap is withdrawn, or escalated; nothing is filed (GY-1249).
import { cappedReview, cappedReworkBinding, cappedRevisionMark, detailChanged, type CappedReview } from './decisions.js';
import { decisionKey } from './reconcile.js';
import { decisionBindingMax, decisionSituation, uncitedRefusals, type DecisionSituation } from '../model/approval.js';
import { reviewRound, reviewRoundCapOf } from '../review-cap.js';
import { record } from './effects.js';
import { readyToRetry } from './sessions.js';
import { closeStanding, closingItems, freshReads } from './stale-closes.js';
import type { Cycle } from './cycle.js';
import type { Work } from '../model.js';
import type { MasterConfig } from '../master.js';

/** How many times the step tries to withdraw one change request before it escalates instead. */
export const maxCappedFilingAttempts = 5;
/** The cursor key of one capped change request's withdrawal: per head and review, so a later request on the same head is its own. */
export const cappedFilingKey = (work: Pick<Work, 'id'>, capped: Pick<CappedReview, 'sha' | 'reviewId'>) => `${cappedHeadKey(work, capped.sha)}${capped.reviewId}`;
const cappedHeadKey = (work: Pick<Work, 'id'>, sha: string) => `review-cap:${work.id}:${sha}:`;
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
 * GY-1577. Whether `at` falls after the item's policy revision last changed. A decision record keeps no revision and the
 * item no time of its last revision, so this reads what that revision reset: a GitHub review the requirement-review baseline
 * does not hold was submitted after it (the rule the review gate applies, src/model/review.ts), and an agent review request
 * binds the revision it was posted under. An item never revised has no earlier revision to predate. Anything else is unknown, so false.
 */
export function sinceRevision(work: Pick<Work, 'policyRevision' | 'formalReviewResetRequired' | 'formalReviewBaseline' | 'reviewRequest' | 'candidate'>, capped: Partial<Pick<CappedReview, 'reviewId' | 'submittedAt'>>, at: string | undefined): boolean {
  const time = Date.parse(at ?? '');
  if (!Number.isFinite(time)) return false;
  if (!work.formalReviewResetRequired && work.policyRevision === 1) return true;
  const baseline = work.formalReviewBaseline, request = work.reviewRequest, id = capped.reviewId;
  if (baseline && baseline.pr === work.candidate?.pr && baseline.policyRevision === work.policyRevision && Number.isSafeInteger(id) && id! > 0 && !baseline.reviewIds.includes(id!))
    return time >= Date.parse(capped.submittedAt ?? '');
  return !!request && request.policyRevision === work.policyRevision && time >= Date.parse(request.createdAt);
}
/**
 * GY-1575. The approver's refusal of the rework the loop requested for a capped change request on
 * `capped`'s head and reviewer under the item's policy revision, or null: the approver judged its findings
 * non-blocking, so the review-cap step withdraws the request and has the head re-reviewed with the
 * refusal's reasoning. A refusal judged under an earlier policy revision binds no later change request.
 * GY-1577: a refusal requested before the mark existed carries none; it counts as judged under the current
 * revision when it was refused after that revision last changed (`sinceRevision`), and binds nothing otherwise.
 */
export function refusedCappedRework<D extends { action: string; state: string; input?: any; reason?: string; requestedAt?: string; refusal?: { at?: string } | null }>(history: readonly D[],
  capped: Pick<CappedReview, 'sha' | 'reviewer'> & Partial<Pick<CappedReview, 'reviewId' | 'submittedAt'>>, work: Parameters<typeof sinceRevision>[0]): D | null {
  const mark = cappedRevisionMark(work.policyRevision);
  // The binding names the head and reviewer whose verdict was judged; a base the head later sits on does not change that verdict, so the
  // refusal's recorded base is not compared, marked or unmarked (GY-1577 review): the candidate's base follows main and would strand it.
  return refusedCappedReworks(history, capped).find(entry => entry.reason?.includes(mark)
    || !revisionMarked(entry.reason) && sinceRevision(work, capped, entry.refusal?.at ?? entry.requestedAt)) ?? null;
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
 * GY-1580 review. How the master's refused answers bear on `capped`'s change request, submitted at `submittedAt` after
 * `refused`: a withdrawal the loop made on an answer is read from the answers alone, so the guard outlives pruned rows.
 * The escalation of a first re-review's change request asks for an answer citing the capped refusal only, and that of
 * a later one for an answer citing the earlier answers too. So `answer`, the earliest answer requested after the
 * change request that cites no other answer, answers it as the first re-review's: the loop withdraws it once more.
 * `judged` holds every other refused answer the change request follows — one requested and refused before it was
 * submitted, or one citing an earlier answer — newest last, uncited ones only, as a new request must cite them; with
 * no `answer`, any of them makes this change request the one after a second withdrawal, escalated and never withdrawn.
 * An answer requested before the head's first re-review posted reads the same as one a withdrawal followed (GitHub's
 * observation keeps one review per reviewer); it never hides a later answer to the first re-review, which still withdraws.
 */
export function refusedAnswerStanding<D extends Parameters<typeof refusedCapAnswers>[0][number]>(history: readonly D[], refused: D, sha: string, submittedAt: string | undefined): { answer: D | null; judged: D[] } {
  const answers = refusedCapAnswers(history, refused, sha, refused.refusal?.at ?? refused.requestedAt), submitted = Date.parse(submittedAt ?? '');
  const cites = (entry: D, other: D) => !!entry.precedent?.includes(other.id) || !!entry.reason?.includes(other.id.slice(0, 8));
  const chained = (entry: D) => answers.some(other => other.id !== entry.id && cites(entry, other));
  const answer = answers.find(entry => Date.parse(entry.requestedAt!) > submitted && !chained(entry)) ?? null;
  const judged = answers.filter(entry => entry !== answer && (chained(entry)
    || Date.parse(entry.requestedAt!) <= submitted && Date.parse(entry.refusal?.at ?? entry.requestedAt!) < submitted));
  return { answer, judged: judged.filter(entry => !answers.some(other => other.id !== entry.id && cites(other, entry))) };
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
  // GY-1580: the master's answer to the re-review's change request was refused too; both judgements travel with the request.
  if (answer) return `Graphyard withdrew this change request: review round ${capped.round} is past the cap of ${capped.cap}. Independent approver ${refusal.approver} refused the rework it first asked for as non-blocking (decision ${refusal.id}): ${refusal.reason}\n\n`
    + `The re-review requested changes again; the master asked for that rework, and independent approver ${answer.approver} refused it as non-blocking too (decision ${answer.id}): ${answer.reason}\n\n`
    + `Re-review head ${capped.sha} and approve it, listing these findings as FOLLOW-UP threads, not as a change request${listed}. `
    + 'Only a finding that breaks a criterion neither refusal judged is BLOCKING. A change request on this head again is escalated, not withdrawn a third time.';
  return `Graphyard withdrew this change request: review round ${capped.round} is past the cap of ${capped.cap}, and independent approver ${refusal.approver} refused the rework it asked for as non-blocking (decision ${refusal.id}): ${refusal.reason}\n\n`
    + `Re-review head ${capped.sha} and list these findings as FOLLOW-UP threads, not as a change request${listed}. `
    + 'A change request on this head again is escalated, not withdrawn a second time.';
}

/** The refusal an approver gave a capped rework decision, as the re-review request names it. */
export type CapRefusal = { id: string; approver: string; reason: string; at?: string };
export function capRefusalOf(refused: { id: string; outcome?: string | null; refusal?: { approver?: string; reason?: string; at?: string } | null }): CapRefusal {
  return { id: refused.id, approver: refused.refusal?.approver ?? 'its approver', reason: refused.refusal?.reason ?? refused.outcome ?? 'no reason recorded', ...(refused.refusal?.at ? { at: refused.refusal.at } : {}) };
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
export async function reviewCapStep(cycle: Cycle) {
  const { config, state, effects, performed, isolate, now } = cycle;
  // A withdrawal spends a fresh review on the head; an item a close stands on is not reviewed again (GY-1439).
  // A close the loop already knows of holds the item without a read. Otherwise this step, which runs before the
  // decisions step drops the kept histories a hand close changed, reads the item's history afresh, and only when
  // a withdrawal is due: at most once a head.
  const closing = closingItems(cycle), reads = freshReads(cycle);
  for (const item of cycle.open) await isolate('review', item, item.key, async () => {
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
    const thrice = `${capped.reason}, after the independent approvers refused both its capped rework and the master's answer to its re-review as non-blocking, and Graphyard withdrew the change request on the same head twice; its re-review requested changes again, so it is not withdrawn a third time`;
    const decisionHistory = () => effects.decisions ? effects.decisions(item).then(result => result.decisions, () => null) : Promise.resolve(null);
    // A nits-only change request needs no approver; past a refused capped rework on the head it is judged as the escalated one is (GY-1580 review).
    const judged = capped.kind === 'escalate';
    // A loop that requests decisions asks its approver for this round itself (neededDecision, GY-1389).
    if (judged && (!effects.decide || !effects.approver)) return escalate();
    const history = await decisionHistory();
    const refused = history ? refusedCappedRework(history, capped, item) : null;
    // Until the approver refuses the rework the loop requested, the round is the approver's to judge.
    if (judged && !refused) {
      // GY-1577: a refusal of this head's capped rework the step cannot act on, with no request under this revision before
      // the approver and none still owed by the loop, would strand the change request with no actor: it escalates instead.
      const stranded = history ? strandedCappedRefusal(item, capped, history, !!state.approvals[decisionKey(item, { action: 'rework', binding: cappedReworkBinding(capped.sha, capped.reviewer) })]) : null;
      return stranded ? escalate(stranded) : undefined;
    }
    // The cursor's row may be pruned; a change request submitted after the refusal is the re-review's all the same (GY-1575).
    if (refused && (state.actions[cappedRereviewKey(item, capped.sha)]?.state === 'done' || requestedSinceRefusal(capped, capRefusalOf(refused)))) {
      refusal = capRefusalOf(refused);
      // GY-1580: the master's answer to that escalation, refused as non-blocking too, has it withdrawn once more; a
      // change request after that withdrawal escalates, never withdrawn a third time (`refusedAnswerStanding`).
      const standing = refusedAnswerStanding(history!, refused, capped.sha, capped.submittedAt);
      if (standing.answer && state.actions[answeredRereviewKey(item, capped.sha)]?.state !== 'done') answer = capRefusalOf(standing.answer);
      else return escalate(standing.answer || standing.judged.length ? thrice : again, [refusal, ...standing.judged.map(capRefusalOf)]);
    } else if (judged) refusal = capRefusalOf(refused!);
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
    if (previous && previous.attempts >= maxCappedFilingAttempts) return escalate(`${capped.reason}; withdrawing it failed ${previous.attempts} times (${previous.detail.slice(0, 300)})`);
    if (!readyToRetry(previous, state.cycle)) return;
    if (closing.has(item.key) || await closeStanding(reads, item, cycle.snapshot.work, closing)) return;
    const followUps = refusal ? capFollowUps(item, [refusal, ...answer ? [answer] : []], cycle.snapshot.work) : [];
    const reason = answer && refusal
      ? `Review round ${capped.round} of ${item.key} is past its cap of ${capped.cap}: independent approver ${answer.approver} refused the master's answer (decision ${answer.id}) to the re-review of refused capped rework ${refusal.id} as non-blocking, so ${capped.reviewer}'s change request ${capped.reviewId} on ${capped.sha.slice(0, 12)} is withdrawn once more and the head re-reviewed with both refusals' findings as FOLLOW-UP`
      : refusal
      ? `Review round ${capped.round} of ${item.key} is past its cap of ${capped.cap}: independent approver ${refusal.approver} refused the capped rework (decision ${refusal.id}) as non-blocking, so ${capped.reviewer}'s change request ${capped.reviewId} on ${capped.sha.slice(0, 12)} is withdrawn and the head re-reviewed with its findings as FOLLOW-UP`
      : `Review round ${capped.round} of ${item.key} is past its cap of ${capped.cap}: ${capped.reviewer}'s change request ${capped.reviewId} on ${capped.sha.slice(0, 12)} names no BLOCKING: finding, so its findings are nits, not filed, and the item proceeds toward merge without another rework`;
    const request = refusal ? refusedCapRereview(capped, refusal, followUps, answer ?? undefined)
      : `Graphyard withdrew this change request: review round ${capped.round} is past the cap of ${capped.cap}, and it names no BLOCKING: finding. Its findings are nits and are not filed; the head is reviewed again, and only a BLOCKING: finding holds it.`;
    try {
      await effects.withdrawReview(item, capped.reviewId!, request);
    } catch (error) {
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
    const woken = effects.wakeObservation ? await effects.wakeObservation(item).then(() => null, (error: unknown) => error instanceof Error ? error.message : String(error)) : 'this loop runs without the observation wake';
    const cancelled = woken === null ? 'its observation woken so the owed request-rework is cancelled' : `the owed request-rework is cancelled at the next observation (waking it failed: ${woken.slice(0, 200)})`;
    performed.push(await record(state, key, { kind: 'review', work: item.key, principal: null, state: 'done', detail: `${reason}: the change request withdrawn and ${cancelled}`,
      attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
    performed.push(await record(state, answer ? answeredRereviewKey(item, capped.sha) : cappedRereviewKey(item, capped.sha), { kind: 'review', work: item.key, principal: null, state: 'done', detail: `Requested a fresh review of ${item.key} on ${capped.sha.slice(0, 12)}: ${request}`,
      attempts: 1, cycle: state.cycle }, now(), effects.persist));
  });
}
