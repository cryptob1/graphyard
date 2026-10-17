import { z } from 'zod';
import type { Principal } from '../model.js';

/**
 * The grants a configured principal holds beside its role (GY-1879). Each names one lane and
 * authorizes nothing else: a grant is never a proof pattern, so it feeds no evidence authority
 * (proof-grants.ts reads `proofs` only), as `deploymentProviders` is kept apart from `proofs`.
 */
export const principalGrants = ['external-runs:import'] as const;
export type PrincipalGrant = (typeof principalGrants)[number];
/** Importing an external test run (POST /api/validation/import): a producer holds it explicitly, and it grants no proof evidence. */
export const externalRunsImportGrant: PrincipalGrant = 'external-runs:import';
/**
 * A lane-only producer: role producer whose only authority is the `external-runs:import` grant, with
 * no proof authority and no deployment scope. It reviews nothing and produces no proof evidence, so
 * it holds no reviewer slot (delegation.ts) and the server holds it to its lane's routes (auth.ts).
 * Proof authority is the effective one (proof-grants.ts `effectiveAuthority`): `recorded` is the
 * principal's persisted grant patterns when a grant record exists, which supersede the environment
 * `proofs` seed, so a lane producer later granted proofs through the grant API is a proof producer.
 */
export const laneOnlyProducer = (p: Pick<Principal, 'role' | 'grants' | 'proofs' | 'deploymentProviders'>, recorded?: readonly string[] | null) =>
  p.role === 'producer' && !!p.grants?.length && p.grants.every(grant => grant === externalRunsImportGrant) && !(recorded ?? p.proofs)?.length && !p.deploymentProviders?.length;

/** The principal roster a deployment is configured with: who the server authenticates, and in which role. */
export const principalSchema = z.array(z.object({ id: z.string().min(1), role: z.enum(['admin', 'coordinator', 'slice-lead', 'worker', 'producer', 'reader']), token: z.string().min(32), proofs: z.array(z.string()).optional(), grants: z.array(z.enum(principalGrants)).max(20).optional(), deploymentProviders: z.array(z.string().trim().min(1).max(40)).max(20).optional(), displayName: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/).optional(), runtime: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/).optional(), slice: z.enum(['product', 'infrastructure', 'docs-experience']).optional(), sessionKind: z.enum(['human', 'ai']).optional() }).strict()).min(1);
export type Credential = Principal & { token: string };
