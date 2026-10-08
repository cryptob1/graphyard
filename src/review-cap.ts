// Concern: the review-round cap (GY-1118) — which round an item's review is in, and what a change request names as blocking.

/*
 * On 2026-10-02 GY-1094 went build → review → rework → review again, and nothing bounded how many
 * times an independent reviewer's CHANGES_REQUESTED could send an item back. The rounds are now
 * counted (`work.pipeline.reworkRounds`) and capped: past the cap only a blocking finding — an
 * acceptance criterion not met, wrong behaviour, a security defect — stands against the head, and
 * then it is escalated to an independent approver rather than reworked; every other finding is
 * filed as the item's follow-up batch and the item goes on toward merge (daemon/cycle-review-cap.ts).
 */

/**
 * What the round is read from: the pipeline timeline's rework rounds (pipeline-speed.ts `recordRework`),
 * or — on the coordination view the loop reads, which drops the timeline — the count that view keeps
 * beside it (`reworkRounds`, server/work-view.ts `CoordinationRounds`). Every cap reader goes through
 * here: one that read only the timeline saw each head as round 1 on the loop (GY-1389).
 */
type Rounds = { pipeline?: { reworkRounds?: number } | null; reworkRounds?: number };
/** The rework rounds an item has taken, from whichever record of them it carries. */
export const reworkRoundsOf = (work: Rounds) => work.pipeline?.reworkRounds ?? work.reworkRounds ?? 0;
/** The review rounds an item takes before only a blocking finding stands against it: master.json `reviewRoundCap`. */
export const defaultReviewRoundCap = 3;
export const reviewRoundCapOf = (config?: { reviewRoundCap?: number } | null) => config?.reviewRoundCap ?? defaultReviewRoundCap;
/** The review round the item's current head is in: its first review is round 1, and each rework round starts the next. */
export const reviewRound = (work: Rounds) => reworkRoundsOf(work) + 1;
/** Whether the item's current review is past the cap: rounds 1..cap are ordinary, every later one is capped. */
export const pastReviewCap = (work: Rounds, cap: number) => reviewRound(work) > cap;
export interface ReviewRoundStatus { round: number; cap: number; capped: boolean }
/** What `master status` shows per item: its review round and the cap it is judged against. */
export const reviewRoundStatus = (work: Rounds, cap: number): ReviewRoundStatus => ({ round: reviewRound(work), cap, capped: pastReviewCap(work, cap) });
/** `master status` rows with each item's `reviewRound` set; a row whose item the snapshot does not hold gets null. */
export function withReviewRounds<R extends { key: string }>(rows: R[], work: readonly (Rounds & { key: string })[], cap: number): (R & { reviewRound: ReviewRoundStatus | null })[] {
  const items = new Map(work.map(item => [item.key, item]));
  return rows.map(row => { const item = items.get(row.key); return { ...row, reviewRound: item ? reviewRoundStatus(item, cap) : null }; });
}

/** How much of a change request's body an observation keeps: enough to file its findings, bounded like a decision reason. */
export const reviewBodyMax = 2000;
/**
 * The line that names one blocking finding in a change request: `BLOCKING: <finding>`, optionally as a list item.
 * It captures the bold markers before the label, after it (after `BLOCKING` or after `finding`) and after its
 * colon, so the finding loses only the Markdown wrapper the line actually opened (GY-1169: a finding ending
 * `foo_` or `.` keeps it; GY-1220: `**BLOCKING finding**: x` is a finding too).
 */
const blockingLine = /^\s*(?:-\s*|\*\s+)?(\**)BLOCKING(\**)(?:\s*finding(\**))?\s*[:\-–—](\**)\s*(.+?)\s*$/i;
/** The line that names one non-blocking finding: `Follow-up finding: <finding>`, as the reviewer prompt asks for it. */
const followUpLine = /^\s*(?:[-*]\s*)?\**FOLLOW-?UP\**\s*(?:finding)?\**\s*[:\-–—]\**\s*(.+)$/i;
const noneNamed = /^(none|n\/a|no blocking findings?)\.?$/i;
/**
 * A blocking finding without its Markdown wrapper: the bold the label left open, then a `**…**` or `_…_` pair
 * around the whole text. A pair is a wrapper only when its inside holds no further marker of it, so
 * `**a** and **b**` keeps both pairs, and an `_` pair only around words, so an identifier like `__init__` is kept (GY-1220).
 */
function unwrapFinding([, opened = '', closedLabel = '', closedFinding = '', afterColon = '', text = '']: RegExpExecArray): string {
  const open = Math.abs(opened.length - closedLabel.length - closedFinding.length - afterColon.length);
  let finding = open && text.endsWith('*'.repeat(open)) ? text.slice(0, -open).trimEnd() : text;
  const wrapper = /^[*_]+/.exec(finding)?.[0];
  const inner = wrapper && finding.length > 2 * wrapper.length && finding.endsWith([...wrapper].reverse().join('')) ? finding.slice(wrapper.length, -wrapper.length) : null;
  if (inner !== null && !inner.includes(wrapper!) && (!wrapper!.includes('_') || /\s/.test(inner.trim()))) finding = inner;
  return finding.trim();
}
/**
 * The verdict's own scaffolding, which is no finding: headings, the per-criterion judgements, the
 * "Review of #N" preamble, the findings-classification lines and the closing thread summary.
 */
const scaffold = /^(?:#{1,6}\s|(?:[-*]\s*)?\**\[(?:AC-\d+|DOCS)\]|(?:[-*]\s*)?\**(?:Judgement|BLOCKING findings?|Open review threads|Resolved threads|Follow-up threads|Overridden threads)\**\s*:|Review of (?:pull request )?#\d+)/i;
/**
 * The blocking findings a change request names, one per `BLOCKING:` line; a line naming none ("BLOCKING: none")
 * names nothing. Prose that merely mentions the word is not a finding: the reviewer is told the form at the cap.
 */
export function blockingFindings(body: unknown, limit = 10): string[] {
  if (typeof body !== 'string') return [];
  return body.split('\n')
    .map(line => { const match = blockingLine.exec(line); return match ? unwrapFinding(match) : ''; })
    .filter(text => text && !noneNamed.test(text))
    .map(text => text.slice(0, 300))
    .slice(0, limit);
}
/**
 * The non-blocking findings of a change request, as the follow-up batch records them: its
 * `Follow-up finding:` lines when it has any; otherwise each list item or paragraph that is neither
 * a `BLOCKING:` line nor the verdict's scaffolding, bounded; the whole body when it has no structure.
 */
export function followUpFindingsOf(body: unknown, limit = 20): string[] {
  if (typeof body !== 'string' || !body.trim()) return [];
  const named = body.split('\n').map(line => followUpLine.exec(line)?.[1]?.trim() ?? '').filter(text => text && !noneNamed.test(text));
  if (named.length) return named.map(text => text.slice(0, 2000)).slice(0, limit);
  const blocks = body.split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/).map(block => block.trim()).filter(block => block && !blockingLine.test(block.split('\n')[0]!) && !scaffold.test(block));
  return blocks.map(block => block.slice(0, 2000)).slice(0, limit);
}
/**
 * What an observation keeps of a change request's body (github.ts): the whole body when it fits
 * `reviewBodyMax`; otherwise its `BLOCKING:` and `Follow-up finding:` lines first, then the rest,
 * cut to the bound, so a finding named late in a long verdict is never cut off. `blocking` is
 * read from the whole body before any cut (GY-1118 review: a BLOCKING: line past character 2000
 * was classed a follow-up).
 */
export function observedReviewBody(body: string): { body: string; blocking?: string[] } {
  const blocking = blockingFindings(body);
  const kept = body.length <= reviewBodyMax ? body : (() => {
    const lines = body.split('\n'), named = lines.filter(line => blockingLine.test(line) || followUpLine.test(line));
    return [...named, '', ...lines.filter(line => !named.includes(line))].join('\n').slice(0, reviewBodyMax);
  })();
  return { body: kept, ...(blocking.length ? { blocking } : {}) };
}
