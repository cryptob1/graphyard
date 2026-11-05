import { z } from 'zod';
import { notSecret } from '../model/registry-keys.js';
/**
 * Where an API-key runtime's provider key lives and how the runtime reads it: a file inside the
 * account's login home (mode 0600) and the environment variable the runtime reads the key from. A
 * headless launch reads the file when it starts and passes the variable to that run alone; the
 * registry holds only this reference, so a key never enters a registry document or the ledger.
 */
export const accountKeySchema = z.object({
  file: z.string().trim().min(1).max(200).refine(value => !/^(\/|[A-Za-z]:[\\/])/.test(value) && !value.split('/').includes('..'), 'A key file is a path inside the account home').refine(notSecret, 'Name the key file, never the key'),
  variable: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'An environment variable name: capitals, digits and underscores').max(100)
    .refine(name => !name.startsWith('GRAPHYARD_'), 'GRAPHYARD_ variables are owned by the launcher'),
}).strict();
/** An executor's smoke test of an account it holds the login of: the runtime's own error when it failed. */
export const smokeObservationSchema = z.object({ result: z.enum(['pass', 'fail']), reason: z.string().trim().min(1).max(500).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed').nullable().default(null) }).strict();
