import { z } from 'zod';
import type { Principal } from '../model.js';

/**
 * The grants a configured principal holds beside its role (GY-1879). Each names one lane and
 * authorizes nothing else: a grant is never a proof pattern, so it feeds no evidence authority
 * (model/proof.ts reads `proofs` only), as `deploymentProviders` is kept apart from `proofs`.
 */
export const principalGrants = ['external-runs:import', 'delivery:observe-sha'] as const;
export type PrincipalGrant = (typeof principalGrants)[number];
/** Importing an external test run (POST /api/validation/import): a producer holds it explicitly, and it grants no proof evidence. */
export const externalRunsImportGrant: PrincipalGrant = 'external-runs:import';
/**
 * Recording which commit production serves (POST /api/delivery/observe-sha, GY-1912). Its holder is
 * a dedicated principal: the grant is held alone, never beside another lane, so an observer is a
 * separate credential and an import lane is never widened into one.
 */
export const observeShaGrant: PrincipalGrant = 'delivery:observe-sha';
/**
 * A lane-only producer: role producer whose only authority is its lane grants, with
 * no proof authority and no deployment scope. It reviews nothing and produces no proof evidence, so
 * it holds no reviewer slot (delegation.ts) and the server holds it to its lane's routes (auth.ts).
 * Proof authority is the roster's own `proofs` patterns.
 */
export const laneOnlyProducer = (p: Pick<Principal, 'role' | 'grants' | 'proofs' | 'deploymentProviders'>) =>
  p.role === 'producer' && !!p.grants?.length && p.grants.every(grant => (principalGrants as readonly string[]).includes(grant)) && !p.proofs?.length && !p.deploymentProviders?.length;

/** The principal roster a deployment is configured with: who the server authenticates, and in which role. */
export const principalSchema = z.array(z.object({ id: z.string().min(1), role: z.enum(['admin', 'coordinator', 'slice-lead', 'worker', 'producer', 'reader']), token: z.string().min(32), proofs: z.array(z.string()).optional(), grants: z.array(z.enum(principalGrants)).max(20).optional(), deploymentProviders: z.array(z.string().trim().min(1).max(40)).max(20).optional(), displayName: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/).optional(), runtime: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/).optional(), slice: z.enum(['product', 'infrastructure', 'docs-experience']).optional(), sessionKind: z.enum(['human', 'ai']).optional() }).strict()
  .refine(p => !p.grants?.includes(observeShaGrant) || p.grants.length === 1, { message: `${observeShaGrant} is held by a dedicated principal, beside no other grant`, path: ['grants'] })).min(1);
export type Credential = Principal & { token: string };
