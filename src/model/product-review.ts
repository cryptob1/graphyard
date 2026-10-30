// Concern: GY-2989 — the product review a user-facing feature owes before its merge. Code review
// checks that a change is correct; a product review judges in the whole app's context that it is a
// good idea: a reviewer session walks the head's preview — or the served app against the head's
// diff where no preview runs — and approves, requests changes, or rejects. Bugs, chores and "No
// user-facing change" items owe none.
import { repositoryPolicy, type RepositoryPolicy } from './repository-policy.js';
import type { Work } from './work.js';
import { optsOutOfE2e } from './user-facing.js';

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

/** Who owes one: a feature a user can see — it carries an `e2e:` proof and does not opt out. */
export function needsProductReview(work: Pick<Work, 'type' | 'description' | 'criteria'>): boolean {
  return work.type === 'feature' && work.criteria.some(criterion => criterion.proofs.some(proof => proof.startsWith('e2e:'))) && !optsOutOfE2e(work.description);
}

const short = (sha: string) => sha.slice(0, 12);

/**
 * Whether an approved review of an earlier head still stands for this one: only when the observer
 * read the delta between the two heads and every path it names is non-UI under the repository's
 * `product.ui` policy. A repository that declares no UI globs reviews every new head afresh.
 */
export function productReviewCarries(work: Work, policy: RepositoryPolicy = repositoryPolicy()): boolean {
  const review = work.productReview;
  if (!review || review.verdict !== 'approved' || !work.candidate || review.sha === work.candidate.sha) return false;
  const delta = work.observation?.headDelta;
  if (!delta) return false;
  const ui = policy.product?.ui ?? [];
  if (!ui.length) return false;
  const compiled = ui.map(glob => productGlob(glob));
  return delta.every(path => !compiled.some(pattern => pattern.test(path)));
}

const productGlobCache = new Map<string, RegExp>();
/** One anchored glob over path segments (`web/**` names the tree; `web/*` its own files). */
function productGlob(glob: string): RegExp {
  let compiled = productGlobCache.get(glob);
  if (!compiled) {
    const source = (glob.endsWith('/') ? `${glob}**` : glob).split(/(\*\*\/?|\*|\?)/)
      .map(part => part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
    productGlobCache.set(glob, compiled = new RegExp(`^(?:${source})$`));
  }
  return compiled;
}

/**
 * The standing verdict for the current head: its own review when the head is the one judged, or an
 * earlier approval carried across a non-UI delta. Changes requested and rejects bind their exact
 * head — a new head answers them by being reviewed afresh, never by carrying.
 */
export function standingProductReview(work: Work, policy: RepositoryPolicy = repositoryPolicy()): { review: ProductReview; carried: boolean } | null {
  const review = work.productReview;
  if (!review || !work.candidate) return null;
  if (review.sha === work.candidate.sha) return { review, carried: false };
  return productReviewCarries(work, policy) ? { review, carried: true } : null;
}

/**
 * The review gate's product refusal for this item, or null. A head the product review has not
 * approved does not merge: one not yet reviewed refuses; a change request returns the item to its
 * worker with the findings; a reject leaves it unmerged and owed to the master, which closes it
 * (or files a reshaped item) — it never merges.
 */
export function productReviewRefusal(work: Work): string | null {
  if (!needsProductReview(work)) return null;
  const candidate = work.candidate, observation = work.observation;
  // A product review is launched and posted through the control plane, so only a head it observed
  // owes one here; a GitHub-observed head is held by its own review rule.
  if (observation?.source !== 'control-plane') return null;
  if (!candidate || !observation || observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha) return null;
  const standing = standingProductReview(work);
  if (!standing) return 'Product review of the current commit is required';
  if (standing.review.verdict === 'approved') return null;
  if (standing.review.verdict === 'changes-requested') return `Product review requested changes on ${short(candidate.sha)}: ${standing.review.findings}`;
  return `Product review rejected ${short(candidate.sha)}: ${standing.review.findings} It never merges; the master closes the item unmerged or files a reshaped one`;
}
