// Concern: GY-1606 rework grounds — whether a refused rework judged another binding's grounds, and the watch a failed-check binding adopted.
import type { ApprovalWatch } from './state.js';
import { handWatchPrefix } from './decisions.js';

/** The head, grounds kind and grounds a routine rework binding names (`${sha}:${kind}:…`), or null for any other binding. */
const reworkGrounds = (binding: unknown) => {
  const match = typeof binding === 'string' ? /^([0-9a-f]{40}:[^:]+)(?::(.*))?$/.exec(binding) : null;
  return match ? { kind: match[1], rest: match[2] ?? '' } : null;
};
/**
 * GY-1606. Whether a refused rework judged other grounds than `binding`'s: both name a head and a grounds kind, and
 * either the kind differs or, for a failed-check binding, `binding` names a check the refused one did not. GY-1598's
 * failed-check rework adopted capped review rework a5116d00 while it stood requested; its refusal settled the CI
 * binding's watch, and no failed-check rework was requested for 24 minutes. A refused `ci:test` adopted under
 * `ci:lint` judged nothing of lint either. A binding whose thread set moved is the same grounds.
 */
export const refusedOnOtherGrounds = (refused: unknown, binding: string) => {
  const judged = reworkGrounds(refused), needed = reworkGrounds(binding);
  if (!judged || !needed) return false;
  if (judged.kind !== needed.kind) return true;
  if (!/:ci$/.test(needed.kind)) return false;
  const checks = new Set(judged.rest.split(','));
  return needed.rest.split(',').some(check => !checks.has(check));
};
/**
 * GY-1606. The unsettled watch, under another key of `work`'s, whose decision was requested on `binding` itself: a capped
 * review rework a failed-check binding adopted, once that failure has cleared. It is this binding's to supervise.
 */
export function adoptedWatch(approvals: Record<string, ApprovalWatch>, history: readonly { id: string; input?: { binding?: unknown } | null }[], work: string, action: string, binding: string, key: string) {
  return Object.entries(approvals).find(([other, watch]) => other !== key && watch.work === work && watch.action === action && !watch.settledAt
    && !other.startsWith(handWatchPrefix) && history.find(entry => entry.id === watch.decision)?.input?.binding === binding) ?? null;
}
