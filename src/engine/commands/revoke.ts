import { authorizedForProof } from '../../model/proof.js';
import { demand } from '../../model.js';
import type { Ctx } from './types.js';

export function run(c: Ctx) {
  const { actor, data, now, work } = c;
  // Producer authority is the same live grant set that decides trust at submission.
  demand(actor.role === 'admin' || actor.role === 'producer' && authorizedForProof(actor, data.proof),
    'Evidence revocation requires an operator or the trusted producer authorized for this proof', 403);
  // Revoke every applicable record for the tuple, not merely the newest: leaving an older
  // accepted run behind would silently re-authorize the same candidate.
  const direct = work.evidence.filter(item => item.trusted && !item.revocation && item.proof === data.proof
    && item.sha === data.sha && item.baseSha === data.baseSha && item.policyRevision === data.policyRevision);
  demand(direct.length, 'No trusted evidence matches this proof and candidate; reload before revoking', 404);
  // A reused record (D6) stands on the executed one it names, so withdrawing the executed
  // pass withdraws every record derived from it, for whichever later heads they cover.
  const directIds = new Set(direct.map(item => item.id));
  const withdrawn = work.evidence.filter(item => directIds.has(item.id) || item.trusted && !item.revocation && !!item.reuse && directIds.has(item.reuse.evidenceId));
  for (const item of withdrawn) item.revocation = { at: now.toISOString(), actor: actor.id, reason: data.reason };
  // No execution is recalled: the revocation withdraws the authorization, and the next
  // observation fails the 'Graphyard / merge' check and dequeues the pull request (GY-258).
}
