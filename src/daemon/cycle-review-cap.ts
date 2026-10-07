// Concern: the review-round cap step (GY-1118) — a change request past the cap is withdrawn, or escalated; nothing is filed (GY-1249).
import { cappedReview, detailChanged, type CappedReview } from './decisions.js';
import { record } from './effects.js';
import { readyToRetry } from './sessions.js';
import { closeStanding, closingItems } from './stale-closes.js';
import type { Cycle } from './cycle.js';
import type { Work } from '../model.js';

/** How many times the step tries to withdraw one change request before it escalates instead. */
export const maxCappedFilingAttempts = 5;
/** The cursor key of one capped change request's withdrawal: per head and review, so a later request on the same head is its own. */
export const cappedFilingKey = (work: Pick<Work, 'id'>, capped: Pick<CappedReview, 'sha' | 'reviewId'>) => `${cappedHeadKey(work, capped.sha)}${capped.reviewId}`;
const cappedHeadKey = (work: Pick<Work, 'id'>, sha: string) => `review-cap:${work.id}:${sha}:`;
/** The cursor key of the escalation a blocking finding past the cap raises: one per head, re-recorded only when its findings change. */
export const cappedEscalationKey = (work: Pick<Work, 'id'>, sha: string) => `escalation:review-cap:${work.id}:${sha}`;

/** The escalation's detail: the round, the cap, the findings, and the decision the independent approver is asked for. */
export function cappedEscalation(work: Pick<Work, 'key'>, capped: CappedReview, why = capped.reason) {
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
  const closing = closingItems(cycle);
  for (const item of cycle.open) await isolate('review', item, item.key, async () => {
    const capped = cappedReview(item, config);
    if (!capped || await closeStanding(effects, item, cycle.snapshot.work, closing)) return;
    const escalate = async (why?: string) => {
      const key = cappedEscalationKey(item, capped.sha), detail = cappedEscalation(item, capped, why);
      if (detailChanged(state.actions[key], detail))
        performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
    };
    // A loop that requests decisions asks its approver for this round itself (neededDecision, GY-1389).
    if (capped.kind === 'escalate') return effects.decide && effects.approver ? undefined : escalate();
    const key = cappedFilingKey(item, capped), previous = state.actions[key];
    if (previous?.state === 'done') return;
    // A head is withdrawn once: its re-review requesting changes again escalates rather than repeating the withdrawal (GY-1118 review).
    const head = cappedHeadKey(item, capped.sha);
    const earlier = Object.keys(state.actions).find(other => other !== key && other.startsWith(head) && state.actions[other]?.state === 'done');
    if (earlier) return escalate(`${capped.reason}, after change request ${earlier.slice(head.length)} on the same head was already withdrawn; its re-review requested changes again, so it is not withdrawn a second time`);
    if (!effects.withdrawReview)
      return escalate(`${capped.reason}, and this loop runs without the reviewer App it needs to withdraw the request`);
    if (previous && previous.attempts >= maxCappedFilingAttempts) return escalate(`${capped.reason}; withdrawing it failed ${previous.attempts} times (${previous.detail.slice(0, 300)})`);
    if (!readyToRetry(previous, state.cycle)) return;
    const reason = `Review round ${capped.round} of ${item.key} is past its cap of ${capped.cap}: ${capped.reviewer}'s change request ${capped.reviewId} on ${capped.sha.slice(0, 12)} names no BLOCKING: finding, so its findings are nits, not filed, and the item proceeds toward merge without another rework`;
    try {
      await effects.withdrawReview(item, capped.reviewId!, `Graphyard withdrew this change request: review round ${capped.round} is past the cap of ${capped.cap}, and it names no BLOCKING: finding. Its findings are nits and are not filed; the head is reviewed again, and only a BLOCKING: finding holds it.`);
    } catch (error) {
      performed.push(await record(state, key, { kind: 'review', work: item.key, principal: null, state: 'failed', detail: `${reason}, but withdrawing it failed: ${error instanceof Error ? error.message : String(error)}`,
        attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      return;
    }
    performed.push(await record(state, key, { kind: 'review', work: item.key, principal: null, state: 'done', detail: `${reason}: ${capped.findings.length} finding${capped.findings.length === 1 ? '' : 's'} left as nits, nothing filed, and the change request withdrawn`,
      attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  });
}
