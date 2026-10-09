// Concern: the situation a rework or recover decision judged (GY-229, GY-407), how a later request or the item is compared with it
// (GY-1297), and the applied rework a request would re-authorize (GY-1579). Split from approval.ts by concern; approval.ts re-exports it.
import type { DecisionAction } from './approval.js';
import type { Work } from './work.js';

/**
 * What a rework or recover request judged: the item's candidate head and the base it was built
 * on when the request was made; the grounds it judges travel in the request's `binding` input
 * (GY-407). The server records both with the request, and a refusal stands only against a request
 * made for the same pair and the same grounds (GY-229, GY-407): their input is otherwise the bare
 * attestation `{ previousWorkerStopped: true }`, identical for every request on the item. A rework
 * requested while an applied rework still holds the item names that decision (`reauthorizes`,
 * GY-1579): it judged re-authorizing that one, so its refusal stands only against a request that would.
 */
export interface DecisionSituation { sha: string | null; baseSha: string | null; reauthorizes?: string }
export const situatedDecisionActions: readonly DecisionAction[] = ['rework', 'recover'];
export const decisionSituation = (action: string, work: Pick<Work, 'candidate'>): DecisionSituation | null =>
  situatedDecisionActions.includes(action as DecisionAction) ? { sha: work.candidate?.sha ?? null, baseSha: work.candidate?.baseSha ?? null } : null;
const sameSituation = (recorded: DecisionSituation | null | undefined, current: DecisionSituation | null | undefined) =>
  !recorded || ((recorded.sha ?? null) === (current?.sha ?? null) && (recorded.baseSha ?? null) === (current?.baseSha ?? null));
/**
 * Whether a refused decision judged the same situation as a new request. Only rework and recover
 * are situated; any other action's input already names what it binds. For a situated action the
 * grounds binding is part of that input (GY-407), so a refusal on one ground never matches a
 * request whose binding differs, whatever the head. A refusal recorded before situations were
 * kept judged a candidate nobody can name any more, so it still stands against every request
 * whose input it shares — today, one that names no binding — until one cites it, as it always
 * did; the loop cites it with its new grounds. A situated refusal also judged the applied rework its
 * request would re-authorize, or none (GY-1579): a request re-authorizing another one is new grounds.
 */
export const judgedSame = (action: DecisionAction, decision: { situation?: DecisionSituation | null }, situation: DecisionSituation | null | undefined) =>
  !situatedDecisionActions.includes(action) || (sameSituation(decision.situation, situation) && (!decision.situation || (decision.situation.reauthorizes ?? null) === (situation?.reauthorizes ?? null)));
export function supersededSituation(decision: { action: string; state: string; situation?: DecisionSituation | null }, work: Pick<Work, 'candidate'>): { bound: DecisionSituation; current: DecisionSituation } | null {
  const bound = decision.state === 'approved' ? decision.situation : null, current = bound ? decisionSituation(decision.action, work) : null;
  return !bound || !current || sameSituation(bound, current) ? null : { bound: { sha: bound.sha ?? null, baseSha: bound.baseSha ?? null }, current };
}
export const situationLabel = (situation: DecisionSituation) => situation.sha ? `head ${situation.sha.slice(0, 12)} on base ${String(situation.baseSha).slice(0, 12)}` : 'no candidate';
