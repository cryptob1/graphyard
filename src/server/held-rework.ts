// Concern: the rework an item already holds (GY-1579): a request it answers is refused at creation, and a request
// re-authorizing it lapses once a worker's submission clears it.
import { Refusal, type Work } from '../model.js';
import { decisionSituation, type Decision, type DecisionSituation } from '../model/approval.js';
import type { StaleRace } from './decision-ledger.js';

/**
 * GY-1579. The applied rework decision the item's live state still holds, or null: `reworkRequested`
 * stands (no worker has submitted since) and the item's newest applied rework is the one that set it.
 * On GY-1522 a hand rework was put to an approver while 8da1e201 already held the item, and the
 * approver's session was spent saying so; the held state answers such a request on the record.
 */
export function heldRework<D extends Pick<Decision, 'id' | 'action'> & { state: string; situation?: Decision['situation'] }>(work: Pick<Work, 'reworkRequested'>, history: readonly D[]): D | null {
  if (!work.reworkRequested) return null;
  return [...history].reverse().find(decision => decision.action === 'rework' && decision.state === 'applied') ?? null;
}
/**
 * Whether a request judges the grounds the held rework already answers: no binding other than the held one's, on the same
 * candidate head and base (a rework recorded before situations were kept judged an unnamed one, so it holds every such request).
 * A binding the held rework did not carry names newer grounds, such as the retry cap's after attempts that never submitted (GY-885).
 */
export const heldSameGrounds = (held: { input?: any; situation?: Decision['situation'] }, situation: Decision['situation'], input: { binding?: unknown }) =>
  (input.binding === undefined || input.binding === held.input?.binding)
  && (!held.situation || ((held.situation.sha ?? null) === (situation?.sha ?? null) && (held.situation.baseSha ?? null) === (situation?.baseSha ?? null)));
/**
 * GY-1579. Why a rework requested to re-authorize applied rework `situation.reauthorizes` no longer applies, or null:
 * the item no longer holds that rework (a worker submitted, clearing `reworkRequested`, or a newer rework holds it).
 */
export function lapsedReauthorization(decision: Pick<Decision, 'id' | 'action'> & { situation?: Decision['situation'] }, work: Pick<Work, 'key' | 'reworkRequested'>, history: Parameters<typeof heldRework>[1]): { reason: string; race: StaleRace } | null {
  const reauthorizes = decision.action === 'rework' ? decision.situation?.reauthorizes : undefined;
  if (!reauthorizes) return null;
  const held = heldRework(work, history);
  if (held?.id === reauthorizes) return null;
  return { reason: `Rework decision ${decision.id} was requested to re-authorize applied rework ${reauthorizes}, but ${work.key} no longer holds it (${held ? `rework ${held.id} holds it now` : 'a worker has submitted since'}), so it judged a hold that has cleared`,
    race: { expected: { reauthorizes }, current: { held: held?.id ?? null } } };
}
export const heldReworkRefusal = (work: Pick<Work, 'key'>, held: Pick<Decision, 'id'> & { situation?: Decision['situation'] }) =>
  `${work.key} already holds rework: decision ${held.id} was applied${held.situation?.sha ? ` for head ${held.situation.sha.slice(0, 12)}` : ''} and no worker has submitted since, so the item waits for a worker on it and a second rework authorizes nothing. `
  + `If no worker takes it, what holds its dispatch (an unfinished dependency, a blocker, a fenced launch) is the lever, not another rework`;
/**
 * The situation a request records: a rework or recover refusal judged the candidate and base it was requested against, and
 * stands only for those (GY-229). For a rework (GY-1579 AC-3, AC-4), one the item's held rework already answers is refused, naming that
 * decision, before an approver is asked; one on newer grounds records the applied rework it would re-authorize beside its situation.
 */
export function reworkSituation(action: string, work: Pick<Work, 'key' | 'reworkRequested' | 'candidate'>, history: Parameters<typeof heldRework>[1], input: { binding?: unknown }): DecisionSituation | null {
  const situation = decisionSituation(action, work);
  const held = action === 'rework' ? heldRework(work, history) : null;
  if (held && heldSameGrounds(held, situation, input)) throw new Refusal(heldReworkRefusal(work, held), 409, { heldRework: { decision: held.id } });
  return situation && held ? { ...situation, reauthorizes: held.id } : situation;
}
