import type { ReactNode } from 'react';
import { glossary, type GlossaryTerm } from '../glossary';
import { shortShas } from '../../src/model/format';

/**
 * A technical word with its plain-English definition on hover and focus, from the shared glossary.
 * Inside a link or a button, pass `focusable={false}`: the surrounding control is the keyboard
 * stop, and an interactive element nested in a button is exposed as presentational content.
 */
export default function Term({ term, children, focusable = true }: { term: GlossaryTerm; children?: ReactNode; focusable?: boolean }) {
  return <abbr className="term" title={glossary[term]} tabIndex={focusable ? 0 : undefined}>{children ?? term}</abbr>;
}

/**
 * A generated sentence with the two technical words it can contain explained in place: "Waiting
 * for review of PR #42" and "The proof integration:login-latency has not passed yet" keep their
 * plain wording, and the pull request and the proof name carry the glossary's definitions. A word
 * inside a sentence is hover-only: one keyboard stop per card is the card, not its prose.
 */
export function Explained({ sentence }: { sentence: string }) {
  // Commit SHAs in the sentence read as their first eight characters (GY-168).
  return <>{shortShas(sentence).split(/(PR #\d+|(?:unit|integration|e2e|manual):[A-Za-z0-9._/-]+)/).map((part, index) =>
    /^PR #\d+$/.test(part) ? <Term key={index} term="pull request" focusable={false}>{part}</Term>
      : /^(unit|integration|e2e|manual):/.test(part) ? <Term key={index} term="proof" focusable={false}>{part}</Term>
        : part)}</>;
}
