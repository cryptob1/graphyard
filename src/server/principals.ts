import { z } from 'zod';

/** The principal roster the deployment declares in GRAPHYARD_PRINCIPALS: one credential per role-scoped identity. */
export const principalSchema = z.array(z.object({ id: z.string().min(1), role: z.enum(['admin', 'coordinator', 'slice-lead', 'worker', 'producer', 'reader']), token: z.string().min(32), proofs: z.array(z.string()).optional(), deploymentProviders: z.array(z.string().trim().min(1).max(40)).max(20).optional(), displayName: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/).optional(), runtime: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/).optional(), slice: z.enum(['product', 'infrastructure', 'docs-experience']).optional(), sessionKind: z.enum(['human', 'ai']).optional() }).strict()).min(1);
