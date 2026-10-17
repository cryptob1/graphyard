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

/** The principal roster a deployment is configured with: who the server authenticates, and in which role. */
export const principalSchema = z.array(z.object({ id: z.string().min(1), role: z.enum(['admin', 'coordinator', 'slice-lead', 'worker', 'producer', 'reader']), token: z.string().min(32), proofs: z.array(z.string()).optional(), grants: z.array(z.enum(principalGrants)).max(20).optional(), deploymentProviders: z.array(z.string().trim().min(1).max(40)).max(20).optional(), displayName: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/).optional(), runtime: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/).optional(), slice: z.enum(['product', 'infrastructure', 'docs-experience']).optional(), sessionKind: z.enum(['human', 'ai']).optional() }).strict()).min(1);
export type Credential = Principal & { token: string };
