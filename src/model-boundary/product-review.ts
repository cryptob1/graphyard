import type { Work } from '../model/work.js';
import type { RepositoryPolicy } from '../model/repository-policy.js';
import { repositoryPolicy } from './repository-policy.js';
import { productGlob, type ProductReview, needsProductReview, short } from '../model/product-review.js';
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
