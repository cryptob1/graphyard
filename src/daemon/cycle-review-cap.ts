// Concern: the review-round cap step (GY-1118) — a change request past the cap is withdrawn, or escalated; nothing is filed (GY-1249).
import { cappedReview, detailChanged, refusedCappedRework, type CappedReview } from './decisions.js';
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

/** The cursor key of the re-review an approver's refusal of a capped rework asks for (GY-1575): one per head. */
export const cappedRereviewKey = (work: Pick<Work, 'id'>, sha: string) => `review-cap:rereview:${work.id}:${sha}`;
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
export function refusedCapRereview(capped: Pick<CappedReview, 'round' | 'cap' | 'sha'>, refusal: { id: string; approver: string; reason: string }, followUps: readonly string[]) {
  return `Graphyard withdrew this change request: review round ${capped.round} is past the cap of ${capped.cap}, and independent approver ${refusal.approver} refused the rework it asked for as non-blocking (decision ${refusal.id}): ${refusal.reason}\n\n`
    + `Re-review head ${capped.sha} and list these findings as FOLLOW-UP threads, not as a change request${followUps.length ? `; the follow-up ${followUps.length === 1 ? 'item' : 'items'} filed for them: ${followUps.join(', ')}` : ''}. `
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
  const refused = refusedCappedRework(history, { sha, reviewer: `${config.reviewer.slug}[bot]` }, work.policyRevision);
  if (!refused) return null;
  const refusal = capRefusalOf(refused);
  return refusedCapRereview({ round: reviewRound(work), cap: reviewRoundCapOf(config), sha }, refusal, refusalFollowUps(work, refusal, all));
}

/**
 * Whether `capped` was submitted after the approver refused its head's capped rework (GY-1575): the change
 * request that refusal judged predates it, so a later one is the re-review's. Read from the decision history
 * and the review itself, this is the once-per-head guard the cursor's rows cannot keep: those are resolved
 * actions, and pruneDaemonState retires them oldest first on a busy fleet.
 */
export const requestedSinceRefusal = (capped: Pick<CappedReview, 'submittedAt'>, refusal: Pick<CapRefusal, 'at'>) =>
  Date.parse(capped.submittedAt ?? '') > Date.parse(refusal.at ?? '');

/** The escalation's detail: the round, the cap, the findings, and the decision the independent approver is asked for. */
export function cappedEscalation(work: Pick<Work, 'key'>, capped: CappedReview, why = capped.reason, refused = false) {
  // GY-1575: after a refusal and its re-review the approver has judged the round; nothing is to be requested again by hand.
  if (refused) return `${why}. The review-round cap requests no further rework or withdrawal for ${work.key}: the master answers it — read the refusal with graphyard master decisions ${work.key}, `
    + 'then either have the change request answered as FOLLOW-UP on this head or ask for what the item needs with a reason that cites that refusal and what the re-review found beyond it';
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
    const escalate = async (why?: string, refused = false) => {
      const key = cappedEscalationKey(item, capped.sha), detail = cappedEscalation(item, capped, why, refused);
      if (detailChanged(state.actions[key], detail))
        performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
    };
    const key = cappedFilingKey(item, capped), previous = state.actions[key];
    if (previous?.state === 'done') return;
    const head = cappedHeadKey(item, capped.sha);
    const earlier = Object.keys(state.actions).find(other => other !== key && other.startsWith(head) && state.actions[other]?.state === 'done');
    let refusal: CapRefusal | null = null;
    const again = `${capped.reason}, after the independent approver refused its capped rework as non-blocking and Graphyard withdrew the change request on the same head; its re-review requested changes again, so it is not withdrawn a second time`;
    const decisionHistory = () => effects.decisions ? effects.decisions(item).then(result => result.decisions, () => null) : Promise.resolve(null);
    if (capped.kind === 'escalate') {
      // A loop that requests decisions asks its approver for this round itself (neededDecision, GY-1389).
      if (!effects.decide || !effects.approver) return escalate();
      // GY-1575: the head an approver's refusal already had withdrawn and re-reviewed requested changes again; that escalates, never loops.
      if (state.actions[cappedRereviewKey(item, capped.sha)]?.state === 'done') return escalate(again, true);
      // Until the approver refuses the rework the loop requested, the round is the approver's to judge.
      const history = await decisionHistory();
      const refused = history ? refusedCappedRework(history, capped, item.policyRevision) : null;
      if (!refused) return;
      refusal = capRefusalOf(refused);
      // The cursor's row may be pruned; a change request submitted after the refusal is the re-review's all the same.
      if (requestedSinceRefusal(capped, refusal)) return escalate(again, true);
      const own = !!config.reviewer && capped.reviewer.toLowerCase() === `${config.reviewer.slug}[bot]`.toLowerCase();
      if (!own || capped.reviewId === null)
        return escalate(`${capped.reason}; the independent approver refused its capped rework as non-blocking (decision ${refusal.id}), but Graphyard cannot withdraw a verdict it did not obtain through its reviewer App`);
    }
    // A head is withdrawn once: its re-review requesting changes again escalates rather than repeating the withdrawal (GY-1118 review).
    if (earlier) return escalate(`${capped.reason}, after change request ${earlier.slice(head.length)} on the same head was already withdrawn; its re-review requested changes again, so it is not withdrawn a second time`);
    if (!effects.withdrawReview)
      return escalate(`${capped.reason}, and this loop runs without the reviewer App it needs to withdraw the request`);
    if (previous && previous.attempts >= maxCappedFilingAttempts) return escalate(`${capped.reason}; withdrawing it failed ${previous.attempts} times (${previous.detail.slice(0, 300)})`);
    if (!readyToRetry(previous, state.cycle)) return;
    if (closing.has(item.key) || await closeStanding(reads, item, cycle.snapshot.work, closing)) return;
    // GY-1575: a re-review's nits-only change request, after a refusal the pruned rows no longer record, is escalated too.
    if (!refusal) {
      const history = await decisionHistory(), refused = history ? refusedCappedRework(history, capped, item.policyRevision) : null;
      if (refused && requestedSinceRefusal(capped, capRefusalOf(refused))) return escalate(again, true);
    }
    const followUps = refusal ? refusalFollowUps(item, refusal, cycle.snapshot.work) : [];
    const reason = refusal
      ? `Review round ${capped.round} of ${item.key} is past its cap of ${capped.cap}: independent approver ${refusal.approver} refused the capped rework (decision ${refusal.id}) as non-blocking, so ${capped.reviewer}'s change request ${capped.reviewId} on ${capped.sha.slice(0, 12)} is withdrawn and the head re-reviewed with its findings as FOLLOW-UP`
      : `Review round ${capped.round} of ${item.key} is past its cap of ${capped.cap}: ${capped.reviewer}'s change request ${capped.reviewId} on ${capped.sha.slice(0, 12)} names no BLOCKING: finding, so its findings are nits, not filed, and the item proceeds toward merge without another rework`;
    const request = refusal ? refusedCapRereview(capped, refusal, followUps)
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
    performed.push(await record(state, cappedRereviewKey(item, capped.sha), { kind: 'review', work: item.key, principal: null, state: 'done', detail: `Requested a fresh review of ${item.key} on ${capped.sha.slice(0, 12)}: ${request}`,
      attempts: 1, cycle: state.cycle }, now(), effects.persist));
  });
}
