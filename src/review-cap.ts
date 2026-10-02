// Concern: the review-round cap (GY-1118) — which round an item's review is in, and what a change request names as blocking.

/*
 * On 2026-10-02 GY-1094 went build → review → rework → review again, and nothing bounded how many
 * times an independent reviewer's CHANGES_REQUESTED could send an item back. The rounds are now
 * counted (`work.pipeline.reworkRounds`) and capped: past the cap only a blocking finding — an
 * acceptance criterion not met, wrong behaviour, a security defect — stands against the head, and
 * then it is escalated to an independent approver rather than reworked; every other finding is
 * filed as the item's follow-up batch and the item goes on toward merge (daemon/cycle-review-cap.ts).
 */

/** What the round is read from: the pipeline timeline's rework rounds (pipeline-speed.ts `recordRework`). */
type Rounds = { pipeline?: { reworkRounds?: number } | null };
/** The review rounds an item takes before only a blocking finding stands against it: master.json `reviewRoundCap`. */
export const defaultReviewRoundCap = 3;
export const reviewRoundCapOf = (config?: { reviewRoundCap?: number } | null) => config?.reviewRoundCap ?? defaultReviewRoundCap;
/** The review round the item's current head is in: its first review is round 1, and each rework round starts the next. */
export const reviewRound = (work: Rounds) => (work.pipeline?.reworkRounds ?? 0) + 1;
/** Whether the item's current review is past the cap: rounds 1..cap are ordinary, every later one is capped. */
export const pastReviewCap = (work: Rounds, cap: number) => reviewRound(work) > cap;
export interface ReviewRoundStatus { round: number; cap: number; capped: boolean }
/** What `master status` shows per item: its review round and the cap it is judged against. */
export const reviewRoundStatus = (work: Rounds, cap: number): ReviewRoundStatus => ({ round: reviewRound(work), cap, capped: pastReviewCap(work, cap) });
/** `master status` rows with each item's `reviewRound` set; a row whose item the snapshot does not hold gets null. */
export function withReviewRounds<R extends { key: string }>(rows: R[], work: readonly (Rounds & { key: string })[], cap: number): (R & { reviewRound: ReviewRoundStatus | null })[] {
  const items = new Map(work.map(item => [item.key, item]));
  return rows.map(row => { const item = items.get(row.key); return Object.assign(row, { reviewRound: item ? reviewRoundStatus(item, cap) : null }); });
}

/** How much of a change request's body an observation keeps: enough to file its findings, bounded like a decision reason. */
export const reviewBodyMax = 2000;
/** The line that names one blocking finding in a change request: `BLOCKING: <finding>`, optionally as a list item. */
const blockingLine = /^\s*(?:[-*]\s*)?\**BLOCKING\**\s*(?:finding)?\s*[:\-–—]\s*(.+)$/i;
const noneNamed = /^(none|n\/a|no blocking findings?)\.?$/i;
/**
 * The blocking findings a change request names, one per `BLOCKING:` line; a line naming none ("BLOCKING: none")
 * names nothing. Prose that merely mentions the word is not a finding: the reviewer is told the form at the cap.
 */
export function blockingFindings(body: unknown): string[] {
  if (typeof body !== 'string') return [];
  return body.split('\n').map(line => blockingLine.exec(line)?.[1]?.trim() ?? '').filter(text => text && !noneNamed.test(text)).map(text => text.slice(0, 300)).slice(0, 10);
}
/**
 * The non-blocking findings of a change request, as the follow-up batch records them: each list
 * item or paragraph that is not a `BLOCKING:` line, bounded; the whole body when it has no structure.
 */
export function followUpFindingsOf(body: unknown, limit = 20): string[] {
  if (typeof body !== 'string' || !body.trim()) return [];
  const blocks = body.split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/).map(block => block.trim()).filter(block => block && !blockingLine.test(block.split('\n')[0]!));
  return blocks.map(block => block.slice(0, 2000)).slice(0, limit);
}
