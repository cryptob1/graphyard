/**
 * Hex-shaped tokens: 7–40 characters of 0–9 and a–f with a digit among them. That is every commit
 * hash Graphyard prints, and also any other id shaped like one (`beef1234`); both move while a
 * fault stands, as its digits do, so neither is part of its wording. A word with no digit
 * (`facade`, `deadbeef`) is not one.
 */
export const hexTokens = (text: string) => text.replace(/\b(?=[a-f]*\d)[0-9a-f]{7,40}\b/gi, '#');
/** Wording less ages, counts and times: the key trackFaults read before GY-486. */
export const figureless = (text: string) => (text.toLowerCase().replace(/\d+/g, '#').match(/[a-z]+|#/g) ?? []).map(word => word.replace(/s$/, ''))
  .filter(word => !/^(|i|are|wa|were|ha|have|m|h|d|w|second|minute|hour|day|week)$/.test(word)).join(' ').replace(/#( #)+/g, '#').slice(0, 300);
/**
 * A fault's wording less the figures that move while it stands: ages, counts, times, and commit
 * hashes with any other hex-shaped token (hexTokens). trackFaults (fault-record.ts) keys a standing
 * fault by it, so a line restating the same fault with new figures — a base branch tip advancing
 * under a standing merge-base dismissal — is the same instance, not a new one (GY-486). Browser-safe.
 */
export const wording = (text: string) => figureless(hexTokens(text));
