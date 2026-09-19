import type { ReactNode } from 'react';
import { glossary, type GlossaryTerm } from '../glossary';

/** A technical word with its plain-English definition on hover and focus, from the shared glossary. */
export default function Term({ term, children }: { term: GlossaryTerm; children?: ReactNode }) {
  return <abbr className="term" title={glossary[term]} tabIndex={0}>{children ?? term}</abbr>;
}
