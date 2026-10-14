// Concern: the pinning-test rule — a test file is granted when it quotes an assertion a planned file holds.
import { testFile } from './scope.js';

/** The shortest quote the rule accepts: shorter text is too common to tie a test to a file. */
export const pinnedQuoteMin = 8;
/**
 * The texts a request's reason quotes, as written and as the file would hold them: backtick and
 * double-quoted segments as they are, and a regular-expression literal (`/Old text\./`) both as its
 * source (the test holds that) and unescaped (the planned file holds that).
 */
export function quotedTexts(reason: string): { raw: string; text: string }[] {
  const quotes: { raw: string; text: string }[] = [];
  for (const match of reason.matchAll(/`([^`\n]+)`|"([^"\n]+)"|(?:^|[\s(,=:])\/((?:\\.|[^/\\\n])+)\/[dgimsuyv]*/g)) {
    const raw = match[1] ?? match[2] ?? match[3];
    const text = match[3] ? raw.replace(/\\(.)/g, '$1') : raw;
    if (text.trim().length >= pinnedQuoteMin) quotes.push({ raw, text });
  }
  return quotes;
}
/**
 * The grounds a test file is granted on, or null. The request's reason quotes the failing assertion;
 * the quote must be in the test file (it is that test's assertion) and in a file the item already
 * plans (the text the item changes). Anything else — a quote only one of them holds, a file that is
 * not a test — is refused and goes to the approver.
 */
export function pinningTestGround(path: string, reason: string, testText: string | null, planned: readonly { path: string; text: string | null }[]): string | null {
  if (!testFile(path) || !testText) return null;
  for (const quote of quotedTexts(reason)) {
    if (!testText.includes(quote.raw) && !testText.includes(quote.text)) continue;
    const holder = planned.find(file => file.path !== path && !!file.text && file.text.includes(quote.text));
    if (holder) return `${path} pins "${quote.text.length > 80 ? `${quote.text.slice(0, 79)}…` : quote.text}", which planned file ${holder.path} holds`;
  }
  return null;
}
