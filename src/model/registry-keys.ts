import { z } from 'zod';

/**
 * What the agent registry keeps about credentials, which is only ever where they are (GY-446):
 * the check that refuses a pasted credential in any registry write, an API-key account's key
 * reference, and what executors report about whether an account can actually answer — its smoke
 * test, and how each headless run on it ended.
 */

// What a pasted credential looks like: provider key prefixes, a bearer header, a PEM block, a JWT.
const secretValue = /^(sk-|ghp_|gho_|ghs_|github_pat_|xox[abp]-|Bearer\s)|-----BEGIN|^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;
export const notSecret = (value: string) => !secretValue.test(value);
/** Whether a value looks like a pasted credential: the dashboard refuses to send one, and the registry to store one. */
export const looksLikeSecret = (value: string) => secretValue.test(value.trim());
/** The paths of every string in `value` that looks like a pasted credential. */
export function secretPaths(value: unknown, path = 'input'): string[] {
  if (typeof value === 'string') return looksLikeSecret(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => secretPaths(entry, `${path}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => secretPaths(entry, `${path}.${key}`));
  return [];
}

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
export type AccountKey = z.infer<typeof accountKeySchema>;

/**
 * The last one-prompt smoke test of an account, run by an executor on the account's host before
 * the account is first chosen and again after any registry change to it: a failure holds the
 * reason the runtime itself gave, and the account takes no session until it is changed or it
 * passes the retest its executor runs once `smokeRetestMs` has passed.
 */
export interface AccountSmoke { result: 'pass' | 'fail'; reason: string | null; at: string; by: string }
/** An executor's smoke test of an account it holds the login of: the runtime's own error when it failed. */
export const smokeObservationSchema = z.object({ result: z.enum(['pass', 'fail']), reason: z.string().trim().min(1).max(500).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed').nullable().default(null) }).strict();
export type SmokeObservation = z.infer<typeof smokeObservationSchema>;

/** How a headless run of a narrow role ended, reported with its session's end: with a result, or without one. */
export const runOutcomes = ['result', 'no-result'] as const;
export type RunOutcome = typeof runOutcomes[number];
/** Consecutive headless runs of one role on an account that ended without a result, and the hold they set. */
export interface UnjudgedRuns { runs: number; until: string | null; reason: string | null }
