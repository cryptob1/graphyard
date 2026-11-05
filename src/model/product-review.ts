import type { Work } from './work.js';
export const productVerdicts = ['approved', 'changes-requested', 'rejected'] as const;
export type ProductVerdict = typeof productVerdicts[number];

/** One product review, bound to the exact head (and its merge base) the session judged. */
export interface ProductReview {
  sha: string; baseSha: string;
  verdict: ProductVerdict;
  reviewer: string;
  /** The reviewer's whole verdict body: the findings of a change request, the reason for a reject. */
  findings: string;
  /** The screenshots the reviewer captured, as the verdict named them (paths or URLs). */
  screenshots: string[];
  at: string;
}

declare module './work.js' {
  interface Work {
    /** GY-2989: the standing product review of a user-facing feature, replaced by each fresh verdict. */
    productReview?: ProductReview | null;
  }
  interface Observation {
    /** The paths that changed between the standing product review's head and this head, when the observer read them; without it a new head is reviewed afresh. */
    headDelta?: string[];
  }
}

/** Who owes one: a feature a user can see — it carries an `e2e:` proof, which every item must (GY-3037). */
export function needsProductReview(work: Pick<Work, 'type' | 'criteria'>): boolean {
  return work.type === 'feature' && work.criteria.some(criterion => criterion.proofs.some(proof => proof.startsWith('e2e:')));
}

export const short = (sha: string) => sha.slice(0, 12);

const productGlobCache = new Map<string, RegExp>();
/** One anchored glob over path segments (`web/**` names the tree; `web/*` its own files). */
export function productGlob(glob: string): RegExp {
  let compiled = productGlobCache.get(glob);
  if (!compiled) {
    const source = (glob.endsWith('/') ? `${glob}**` : glob).split(/(\*\*\/?|\*|\?)/)
      .map(part => part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
    productGlobCache.set(glob, compiled = new RegExp(`^(?:${source})$`));
  }
  return compiled;
}
