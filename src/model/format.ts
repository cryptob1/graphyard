import type { EvidenceArtifact } from '../model.js';
import type { Work } from './work.js';
import { deliveryState } from './delivery.js';
import { formatAge } from './duration.js';

export function age(time: string) { return formatAge(time, Date.now()); }
/** How many characters of a commit SHA the dashboard shows (the operator's review of PR #156). */
export const shaChars = 8;
/**
 * Commit SHAs (and other long hex ids) in recorded text, shown as their first `shaChars`
 * characters (GY-168). A run of digits alone is a number — a review or run id — and is left whole,
 * as is a UUID, which names a record rather than a commit and is quoted whole to act on it.
 */
export const shortShas = (text: string) => text.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[0-9a-f]{9,64}\b/gi, hex => hex.includes('-') || !/[a-f]/i.test(hex) ? hex : hex.slice(0, shaChars));
export function artifactLabel(artifact: EvidenceArtifact) {
  const size = artifact.size === undefined ? '' : ` · ${artifact.size < 1024 ? `${artifact.size} B` : `${(artifact.size / 1024).toFixed(1)} KiB`}`;
  return `${artifact.kind} · ${artifact.mediaType ?? 'type unknown'}${size}`;
}
export function safeExternalUrl(value?: string) {
  if (!value) return undefined;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : undefined; } catch { return undefined; }
}
/**
 * Each delivery state's own headline (GY-1845): the production state, never the word Done, and
 * never Merged alone, so merged code cannot read as shipped. A policy that asks for no
 * post-deployment check is `delivered` at its merge; the other labels name how far production has
 * carried it and what, if anything, still stands between the merge and a verified release.
 */
export const deliveryLabel: Record<NonNullable<ReturnType<typeof deliveryState>>, string> = {
  delivered: 'Delivered', 'awaiting-deployment': 'Merged, awaiting deployment', 'awaiting-smoke': 'Deployed, awaiting verification', 'smoke-passed': 'Production verified', 'delivered-with-failure': 'Deployed with a failure',
};

/**
 * A done item's outcome, as every surface headlines it (GY-1845): the delivery state's own label,
 * with the observed release that serves the merge named beside it when the delivery carries its
 * deployment record (`delivery.deployment`, the commit production was seen serving). Null until
 * the item has merged.
 */
export function deliveryOutcome(work: Work): string | null {
  const state = deliveryState(work);
  if (!state) return null;
  const serving = work.delivery?.deployment ? ` — release ${shortShas(work.delivery.deployment.sha)} serving it` : '';
  return `${deliveryLabel[state]}${serving}`;
}
