// Concern: what a change request names as blocking, where, and what it leaves as follow-up.

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
 * The `PATH:LINE` a finding opens with (the form BLOCKING: and Nit: lines name a finding by), or none: a
 * bare number is a time or a count, not a path. GY-1988 reads it to judge a finding against the hunks
 * changed since the earlier head.
 */
export function findingLocation(finding: string): { path: string; line: number } | null {
  const match = /^`?([^\s`:]+):(\d+)`?\s*(?:[—–-]|$)/.exec(finding.trim());
  const line = match ? Number(match[2]) : NaN;
  return match && !/^\d+$/.test(match[1]!) && Number.isSafeInteger(line) ? { path: match[1]!, line } : null;
}
/**
 * The blocking findings a change request names, one per `BLOCKING:` line; a line naming none ("BLOCKING: none")
 * names nothing. Prose that merely mentions the word is not a finding: the reviewer is told the form at the cap.
 */
export function blockingFindings(body: unknown): string[] {
  if (typeof body !== 'string') return [];
  return body.split('\n')
    .map(line => { const match = blockingLine.exec(line); return match ? unwrapFinding(match) : ''; })
    .filter(text => text && !noneNamed.test(text))
    .map(text => text.slice(0, 300))
    .slice(0, 10);
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
