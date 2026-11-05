import { z } from 'zod';
export const proofSchema = z.string().regex(/^(unit|integration|e2e|manual|human):[a-zA-Z0-9._/-]+$/);
// Proof authority is the roster's (GY-2876): a principal may prove exactly the --proof patterns its
// roster entry carries, and nothing is granted at runtime. A pattern names an exact proof, a whole
// proof kind, or a bounded prefix ending in `/*`; nothing else widens a producer's authority.
export const grantPatternSchema = z.string().max(150).regex(/^(unit|integration|e2e|manual):(?:\*|[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*(?:\/\*)?)$/);
