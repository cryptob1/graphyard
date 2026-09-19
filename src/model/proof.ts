import { z } from 'zod';
import type { Principal } from './work.js';

export const proofSchema = z.string().regex(/^(unit|integration|e2e|manual):[a-zA-Z0-9._/-]+$/);
/**
 * The post-deployment smoke proof. It is required through the work policy, never through an
 * acceptance criterion: a criterion gates the merge, and nothing is deployed before the merge.
 */
export const deploySmokeProof = 'e2e:deploy-smoke';
// Proof authority is granted inside Graphyard, never inferred from a deployment
// environment. A grant names either an exact proof, a whole proof kind, or a bounded
// prefix ending in `/*`; nothing else widens a producer's authority.
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
/** Roles that can never hold proof authority, however a grant is requested. */
export const ungrantableRoles = ['worker', 'reader', 'coordinator', 'operator-agent'] as const;
export interface ProofGrant {
  principalId: string; role: 'producer'; patterns: string[]; revision: number;
  createdAt: string; updatedAt: string;
  /** The environment allowlist this record was materialized from, for audit only. */
  seededFrom: string[];
  lastMutation: { kind: 'seed' | 'grant' | 'revoke'; actor: string; at: string; reason: string; patterns: string[] };
}
/** One principal's effective proof authority, with the source that currently decides it. */
export interface ProofAuthority { principalId: string; role: Principal['role']; patterns: string[]; source: 'grant' | 'environment' | 'role' }
