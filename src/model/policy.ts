import type { z } from 'zod';
import type { bootstrapDeclarationSchema } from '../model-boundary/policy.js';
export type BootstrapDeclaration = z.infer<typeof bootstrapDeclarationSchema>;
/** Stored declaration. The audit fields are stamped by the control plane, never by the client. */
export interface BootstrapMode extends BootstrapDeclaration { declaredBy: string; declaredAt: string; policyRevision: number }
export interface Criterion { id: string; text: string; proofs: string[]; bootstrap?: BootstrapMode }
