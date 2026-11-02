import { exhaustionNoticeMaxLength, exhaustionTailLines, type ExhaustionSignal } from './model/capacity.js';
/** A stopped session's last `exhaustionTailLines` non-empty lines, ANSI stripped, trailing borders trimmed and padding collapsed: the tail every limit-notice judge reads. */
export function exhaustionTail(output: string): string[] {
  return output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').split('\n')
    .map(line => line.replace(/[│┃|]\s*$/, '').trim().replace(/\s{2,}/g, ' ')).filter(Boolean).slice(-exhaustionTailLines);
}
/**
 * Claude Code's out-of-usage-credits screen, as the runtime draws it and nothing else (GY-1889): the
 * notice leading its line — behind at most a two-word runtime label such as `API Error ·`, never an
 * agent's sentence — and the runtime's own hint ending the screen, its model name the only free text.
 */
const outOfCreditsShape = /^(?:[A-Za-z]+(?: [A-Za-z]+)? ?[·:] ?)?You(?:'|\u2019)re out of usage credits\. ?Run \/usage-credits to keep using \S.{0,80}? or \/model to switch models\.$/i;
/** How many physical lines the screen may span: a narrow pane wraps both the notice and the hint. */
const outOfCreditsScreenLines = 6;
/**
 * Claude Code's out-of-usage-credits screen (GY-1889). With the account's credits spent, Claude
 * Code stops on `You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model
 * to switch models.` and waits for a person nobody will send, so the session never acknowledges its
 * request: the loop read it as never started, counted the attempt against the request, and
 * relaunched onto the same spent account. The screen is matched whole, over the physical lines a
 * narrow pane wraps it onto (joined, wherever the wrap falls — inside the notice as inside the
 * hint), and only in the runtime's shape (`outOfCreditsShape`): the notice starts its line and the
 * hint ends one, so an agent's sentence quoting either or both is not the screen. It is read on the
 * tail the limit notices scan (`exhaustionTailLines`): what the session scrolled away is worked
 * past, not stopped on. The screen names no reset, so the account it spends is held for the bounded
 * unknown-reset window (`recordObservedExhaustion`).
 */
export function outOfCreditsScreen(output: string): ExhaustionSignal | null {
  const lines = exhaustionTail(output);
  for (let first = lines.length - 1; first >= 0; first--) {
    // What the terminal drew before the notice is not part of it; a wrapped line keeps a leading `/usage-credits`.
    let screen = lines[first].replace(/^[^A-Za-z0-9]+/, '');
    for (let last = first; last < Math.min(lines.length, first + outOfCreditsScreenLines); last++) {
      if (last > first) screen = `${screen} ${lines[last].replace(/^[^A-Za-z0-9/]+/, '')}`;
      if (screen.length > exhaustionNoticeMaxLength) break;
      if (outOfCreditsShape.test(screen)) return { reason: screen.slice(0, 300), resetsAt: null };
    }
  }
  return null;
}
