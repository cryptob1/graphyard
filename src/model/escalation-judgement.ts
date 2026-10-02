import type { EscalationContext, PrecedentEntry, RequirementRevision } from './escalation-context.js';
import { escalationAction } from './escalation-context.js';
import type { EscalationTrigger } from './work.js';

/**
 * A handler's judgement: the resolve decision it requests, the reason, and the precedent it relied
 * on. `followPrecedent` is the built-in judgement: adopt the newest applied decision of the same
 * trigger and cite it. A decision's reason is a claim about one item — its criteria or its code —
 * so the reason is never copied: for any other trigger the judgement states this item's own facts
 * (its key, epoch) and cites the precedent by id and item as the rule it followed (GY-873 AC-2);
 * for requirement-weakening it is `followOwnRevision`, which judges this item's own revision
 * (GY-873 AC-1). For the security-concern trigger it returns null — a security reason is a claim
 * about one item's code that no precedent supplies, so a judging session decides it — and an
 * applied decision of another trigger is no line to follow either: it stays in the context for a
 * judging session to weigh. With no applied precedent of its own trigger the judgement declines
 * rather than invent a line.
 */
export interface EscalationJudgement { trigger: EscalationTrigger; reason: string; precedent: string[]; followed: PrecedentEntry | null }
export function followPrecedent(context: EscalationContext): EscalationJudgement | null {
  if (context.escalation.trigger === 'security-concern') return null;
  // A requirement-weakening reason is a claim about one item's criteria, so the judgement is made
  // from this item's own revision and copies no precedent's reason (GY-873 AC-1).
  if (context.escalation.trigger === 'requirement-weakening') return followOwnRevision(context);
  const followed = context.precedent.detail.find(entry => entry.state === 'applied' && entry.trigger === context.escalation.trigger);
  if (!followed) return null;
  // The precedent is cited by id and item as the rule followed; the claims in the reason are this
  // item's own — its key and epoch — never the precedent's (GY-873 AC-2).
  const reason = `Following precedent ${followed.id} on ${followed.work} (${followed.trigger ?? context.action}, ${followed.state}): ${context.key} (epoch ${context.item.epoch}) — this ${context.escalation.trigger.replace('-', ' ')} is judged on this item's own facts; the precedent is the rule followed, never a reason copied`;
  return { trigger: context.escalation.trigger, precedent: [followed.id], followed,
    reason: reason.slice(0, 2000) };
}

/**
 * The requirement-weakening judgement (GY-873 AC-1): a narrowing is a claim about THIS item's
 * criteria, so the judgement is made from this item's own revision — each criterion whose text or
 * proofs changed, before and after, from the item's requirements history, and the decision that
 * applied it. The newest applied requirement-weakening resolution is still cited, as the rule
 * followed; its reason, a claim about the item it was taken on, is never quoted. With no applied
 * precedent of the trigger to cite the judgement declines, as `followPrecedent` does.
 */
export function followOwnRevision(context: EscalationContext): EscalationJudgement | null {
  const followed = context.precedent.detail.find(entry => entry.state === 'applied' && entry.trigger === 'requirement-weakening');
  if (!followed) return null;
  const changed = (revision: RequirementRevision) => revision.changed.map(entry => entry.before === null ? `${entry.id} added as '${entry.after!.text}'`
    : entry.after === null ? `${entry.id} retired (was '${entry.before!.text}')`
    : `${entry.id} from '${entry.before.text}' to '${entry.after.text}'${JSON.stringify(entry.before.proofs) === JSON.stringify(entry.after.proofs) ? '' : ` (proofs ${entry.before.proofs.join(', ') || 'none'} to ${entry.after.proofs.join(', ') || 'none'})`}`);
  const revisions = (context.item.requirementRevisions ?? []).filter(revision => revision.changed.length).slice(0, 3)
    .map(revision => `${revision.decision ? `decision ${revision.decision}` : `requirements ${revision.seq} by ${revision.actor}`}: ${changed(revision).join(', ')}`);
  const own = revisions.length ? `${context.key} revision ${context.item.revision} — ${revisions.join('; ')}`
    : `${context.key} revision ${context.item.revision}: ${context.escalation.reason}`;
  const reason = `Following precedent ${followed.id} on ${followed.work} (requirement-weakening, applied): ${own}. The narrowing is judged on this item's own revision; precedent ${followed.id} is the rule followed, never a reason copied.`;
  return { trigger: 'requirement-weakening', precedent: [followed.id], followed, reason: reason.slice(0, 2000) };
}
export type EscalationJudge = (context: EscalationContext) => Promise<EscalationJudgement | null> | EscalationJudgement | null;
export interface DecisionRequest { action: typeof escalationAction; input: { trigger: EscalationTrigger; expectedRevision: number }; reason: string; precedent: string[]; context: string }
export interface HandledEscalation { key: string; trigger: EscalationTrigger; fingerprint: string; judgement: EscalationJudgement | null; request: DecisionRequest | null; decision: unknown; declined: string | null }
/**
 * Run one handler: it sees the assembled context and nothing else, judges, and records its decision
 * request with the reason, the precedent it cites and the fingerprint of the context it judged
 * from, so a later handler can follow the same line and an auditor can rebuild what it saw.
 */
export async function handleEscalation(context: EscalationContext, judge: EscalationJudge, record: (request: DecisionRequest) => Promise<unknown>): Promise<HandledEscalation> {
  const judgement = await judge(context);
  const base = { key: context.key, trigger: context.escalation.trigger, fingerprint: context.fingerprint, judgement };
  if (!judgement) return { ...base, request: null, decision: null, declined: `No applied ${context.action} precedent of the ${context.escalation.trigger} trigger to follow among ${context.precedent.total} recorded decision(s); a judging session decides this escalation` };
  const request: DecisionRequest = { action: escalationAction, input: { trigger: judgement.trigger, expectedRevision: context.item.revision }, reason: judgement.reason, precedent: judgement.precedent, context: context.fingerprint };
  return { ...base, request, decision: await record(request), declined: null };
}
