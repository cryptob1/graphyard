/**
 * A fault's wording less the figures that move while it stands: ages, counts, times and commit
 * hashes. trackFaults (fault-record.ts) keys a standing fault by it, so a line restating the same
 * fault with new figures — a base branch tip advancing under a standing merge-base dismissal — is
 * the same instance, not a new one (GY-486). Browser-safe.
 */
export const wording = (text: string) => (text.toLowerCase().replace(/\b(?=[a-f]*\d)[0-9a-f]{7,40}\b/g, '#').replace(/\d+/g, '#').match(/[a-z]+|#/g) ?? []).map(word => word.replace(/s$/, ''))
  .filter(word => !/^(|i|are|wa|were|ha|have|m|h|d|w|second|minute|hour|day|week)$/.test(word)).join(' ').replace(/#( #)+/g, '#').slice(0, 300);
