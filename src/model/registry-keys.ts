import type { z } from 'zod';
import type { accountKeySchema, smokeObservationSchema } from '../model-boundary/registry-keys.js';
/**
 * What the agent registry keeps about credentials, which is only ever where they are (GY-446):
 * the check that refuses a pasted credential in any registry write, an API-key account's key
 * reference, and what executors report about whether an account can actually answer — its smoke
 * test, and how each headless run on it ended.
 */

// What a pasted credential looks like: provider key prefixes, a bearer header, a PEM block, a JWT.
const secretValue = /^(sk-|ghp_|gho_|ghs_|github_pat_|xox[abp]-|Bearer\s)|-----BEGIN|^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;
// A z.ai key has no prefix: 32 hex digits, a dot, and a 16-character id — anywhere in the text (GY-463).
const zaiKey = /(^|[^A-Za-z0-9])[0-9a-f]{32}\.[A-Za-z0-9]{16}($|[^A-Za-z0-9])/;
/**
 * A prefixless key of another provider: one token of at least 32 key characters mixing letters and
 * digits, random enough that it is no word, identifier or hash. Hex digests and UUIDs stay below the
 * bar (at most 17 distinct characters), and so do names made of words, which repeat their letters.
 * A provider model id can pass that bar, so a token built only of words, numbers and short version
 * parts — `anthropic.claude-3-5-sonnet-20241022-v2`, `Llama-3.3-70B-Instruct-Turbo-Free` — is no key
 * (GY-463): a random key's parts mix letters and digits over far more than six characters.
 */
const modelIdPart = (part: string) => /^[A-Za-z]*$/.test(part) || /^[0-9]*$/.test(part) || part.length <= 6;
const randomToken = (token: string) => {
  if (token.length < 32 || !/^[A-Za-z0-9_\-+=.]+$/.test(token) || !/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) return false;
  if (token.split(/[-_.+=]/).every(modelIdPart)) return false;
  const counts = new Map<string, number>();
  for (const character of token) counts.set(character, (counts.get(character) ?? 0) + 1);
  const entropy = [...counts.values()].reduce((sum, count) => sum - (count / token.length) * Math.log2(count / token.length), 0);
  return entropy >= 4.2;
};
// Text and URL punctuation split tokens apart, so a key in a query string or path is tested alone (GY-463).
const secretLike = (value: string) => secretValue.test(value) || zaiKey.test(value) || value.split(/[\s,;:'"`()<>[\]{}/?&#@%|\\!*=]+/).some(randomToken);
export const notSecret = (value: string) => !secretLike(value);
/** Whether a value looks like a pasted credential: the dashboard refuses to send one, and the registry to store one. */
export const looksLikeSecret = (value: string) => secretLike(value.trim());
/** The paths of every string in `value` that looks like a pasted credential. */
export function secretPaths(value: unknown, path = 'input'): string[] {
  if (typeof value === 'string') return looksLikeSecret(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => secretPaths(entry, `${path}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => secretPaths(entry, `${path}.${key}`));
  return [];
}
export type AccountKey = z.infer<typeof accountKeySchema>;

/**
 * The last one-prompt smoke test of an account, run by an executor on the account's host before
 * the account is first chosen and again after any registry change to it: a failure holds the
 * reason the runtime itself gave, and the account takes no session until it is changed or it
 * passes the retest its executor runs once `smokeRetestMs` has passed.
 */
export interface AccountSmoke { result: 'pass' | 'fail'; reason: string | null; at: string; by: string }
export type SmokeObservation = z.infer<typeof smokeObservationSchema>;

/** How a headless run of a narrow role ended, reported with its session's end: with a result, or without one. */
export const runOutcomes = ['result', 'no-result'] as const;
export type RunOutcome = typeof runOutcomes[number];
/** Consecutive headless runs of one role on an account that ended without a result, and the hold they set. */
export interface UnjudgedRuns { runs: number; until: string | null; reason: string | null }
