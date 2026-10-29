import type { Criterion } from './policy.js';

/**
 * GY-2975: a criterion whose proof pins exactly one case — one seed, one fixture path, one sample
 * input — is flagged when the item is created and when its requirements are revised, and the
 * reviewer's brief is told to try one other case, so a head cannot pass by tuning to the single
 * case the proof checks. A warning and a review instruction: no new gate, no refusal.
 */

/** The seed numbers a text pins: `seed 42`, `seeds 42, 7 and 1`, `seed=42`, `?seed=42`, `seed: 42`. */
const seedList = /\bseeds?\s*[=:]?\s*(\d+(?:\s*,\s*\d+)*(?:\s*,?\s*and\s*\d+)?)/gi;
/** A fixture or sample-input path: a slash path ending in a data-file extension. */
const fixturePath = /\b[\w-]+(?:\/[\w.-]+)+\.(?:json|ya?ml|toml|csv|tsv|xml|txt|ndjson)\b/gi;

/** Every distinct case the criterion's text pins: its seed numbers and its fixture paths. */
export function pinnedCases(text: string): string[] {
  const cases = new Set<string>();
  for (const [, list] of text.matchAll(seedList)) for (const seed of list.match(/\d+/g) ?? []) cases.add(seed);
  for (const path of text.match(fixturePath) ?? []) cases.add(path);
  return [...cases];
}

/** The single-case warning for a criterion whose text pins exactly one case, or null. */
export function singleCaseWarning(criterion: Pick<Criterion, 'id' | 'text'>): string | null {
  return pinnedCases(criterion.text).length === 1
    ? `${criterion.id} checks one case; a head can pass it by tuning to that case — name at least three, or say why one is enough.`
    : null;
}

/** One warning per criterion that pins exactly one case, in criterion order. */
export function singleCaseWarnings(criteria: readonly Pick<Criterion, 'id' | 'text'>[]): string[] {
  return criteria.map(singleCaseWarning).filter((warning): warning is string => warning !== null);
}
