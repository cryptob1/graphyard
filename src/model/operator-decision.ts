import { reconciliationRefusalPrefix } from '../merge-queue.js';
import type { Decision } from './approval.js';
import type { Work } from './work.js';

// ---------------------------------------------------------------------------
// Decisions no pair of agent identities can complete (GY-102).
//
// Almost every two-party decision in approval.ts is settled by agents alone: one agent identity requests
// it, a second independent one approves it, and the control plane applies it. One is not. A
// post-merge `merge` decision whose reason cites a reconciliation the record refused is an
// override of the record itself, and the control plane delivers such a merge only when an admin
// credential — the operator's own, not the master's agent pair — stands on one side of the
// decision (engine.ts `operatorAuthorizing`). Approved by two agent identities it applies and
// then delivers nothing: the next observation records a second refusal naming exactly that.
//
// Stating the requirement here is what lets the human surface list such an approval as a request
// only the operator can answer (model/human-request.ts), instead of leaving it to be discovered
// by a delivery that refuses. tests/human-only-surface.test.ts pins this rule to the refusal the
// engine actually records, so the two cannot drift apart.
// ---------------------------------------------------------------------------

/** The role the operator's own credential carries; every agent identity the master runs is an `operator-agent`. */
export const operatorCredentialRole = 'admin';
/** One side of a decision, as the ledger recorded it: an identity and the role it held. */
export interface DecisionParty { id?: string; role?: string | null }
/** Why this identity cannot stand as the operator on a decision that needs one, or null when it can. */
export const operatorCredentialRefusal = (party: DecisionParty): string | null => party.role === operatorCredentialRole ? null
  : `an operator-authorized delivery needs an admin credential as requester or approver; ${party.id ?? 'this session'} is ${party.role ?? 'of unrecorded role'}`;

/**
 * The refused reconciliations an item carries, newest violation last, as the engine wrote them:
 * `<reconciliationRefusalPrefix><decision id> refused: <reasons>`.
 */
export const refusedReconciliations = (work: Pick<Work, 'violations'>) => work.violations
  .filter(entry => entry.startsWith(reconciliationRefusalPrefix))
  .map(entry => entry.slice(reconciliationRefusalPrefix.length).split(' ')[0]);

/**
 * The decision's own party requirement, or null when any independent agent identity may complete
 * it: a merge decision that cites one of this item's refused reconciliations needs the operator's
 * admin credential, and names the refusal it overrides.
 */
export function operatorOnlyDecision(decision: Pick<Decision, 'action' | 'reason'>, work: Pick<Work, 'key' | 'violations'>): { overrides: string; needed: string } | null {
  if (decision.action !== 'merge') return null;
  const overrides = refusedReconciliations(work).find(id => decision.reason.includes(id));
  return overrides ? { overrides, needed: `Authorize the delivery of ${work.key}, overriding refused reconciliation ${overrides}` } : null;
}
