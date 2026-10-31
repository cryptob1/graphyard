import { z } from 'zod';
import type { Principal } from './work.js';

export const proofSchema = z.string().regex(/^(unit|integration|e2e|manual|human):[a-zA-Z0-9._/-]+$/);
/**
 * The post-deployment smoke proof. It is required through the work policy, never through an
 * acceptance criterion: a criterion gates the merge, and nothing is deployed before the merge.
 */
export const deploySmokeProof = 'e2e:deploy-smoke';
// Proof authority is the roster's (GY-2876): a principal may prove exactly the --proof patterns its
// roster entry carries, and nothing is granted at runtime. A pattern names an exact proof, a whole
// proof kind, or a bounded prefix ending in `/*`; nothing else widens a producer's authority.
export const grantPatternSchema = z.string().max(150).regex(/^(unit|integration|e2e|manual):(?:\*|[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*(?:\/\*)?)$/);
export function proofMatchesGrant(pattern: string, proof: string): boolean {
  const separator = pattern.indexOf(':');
  const kind = pattern.slice(0, separator), scope = pattern.slice(separator + 1);
  if (!proof.startsWith(`${kind}:`)) return false;
  const name = proof.slice(kind.length + 1);
  if (!name) return false;
  if (scope === '*') return true;
  // A bounded prefix authorizes strictly below its own path segment, never the
  // segment itself and never a sibling that merely shares a textual prefix.
  if (scope.endsWith('/*')) { const prefix = scope.slice(0, -1); return name.startsWith(prefix) && name.length > prefix.length; }
  return name === scope;
}
export const grantsAuthorize = (patterns: readonly string[], proof: string) => patterns.some(pattern => proofMatchesGrant(pattern, proof));
/** Roles that can never hold proof authority, whatever their roster entry says. */
export const ungrantableRoles = ['worker', 'reader', 'coordinator', 'operator-agent'] as const;
/** One principal's proof authority: an admin or a producer proves exactly its roster patterns, no other role proves anything. */
export interface ProofAuthority { principalId: string; role: Principal['role']; patterns: string[] }
export const proofAuthority = (principal: Pick<Principal, 'id' | 'role' | 'proofs'>): ProofAuthority => ({ principalId: principal.id, role: principal.role,
  patterns: principal.role === 'admin' || principal.role === 'producer' ? [...principal.proofs ?? []] : [] });
/** The single authorization question every trusted-evidence path asks. */
export const authorizedForProof = (actor: Pick<Principal, 'id' | 'role' | 'proofs'>, proof: string) =>
  !(ungrantableRoles as readonly string[]).includes(actor.role) && grantsAuthorize(proofAuthority(actor).patterns, proof);
export const authorizedForEveryProof = (actor: Pick<Principal, 'id' | 'role' | 'proofs'>, proofs: readonly string[]) =>
  proofs.length > 0 && proofs.every(proof => authorizedForProof(actor, proof));
/**
 * Required proof names no configured principal may produce. A manual proof the work names in
 * `producerProofs` is run by a producer session, never attested, so an admin's `manual:*` pattern does not cover it.
 */
export const unauthorizedProofs = (principals: readonly Pick<Principal, 'id' | 'role' | 'proofs'>[], proofs: readonly string[], producerProofs: readonly string[] = []) =>
  proofs.filter(proof => !proof.startsWith('human:') && !principals.some(principal => (principal.role === 'producer' || !producerProofs.includes(proof)) && authorizedForProof(principal, proof)));
