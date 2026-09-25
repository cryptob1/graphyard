import { deploySmokeProof } from './proof.js';

/**
 * A post-merge proof is never a pre-merge gate (GY-188).
 *
 * An acceptance criterion gates the merge, and a proof that can only pass once the change is
 * merged — or deployed — can therefore never pass before the gate it sits in. GY-72 carried two
 * such proofs (`manual:speed-ci-proofs-live-postmerge`, `manual:speed-target-met-postmerge`); both
 * failed on the candidate, as they had to, and held the item at Prove for about 38 hours until
 * somebody took them out by hand. So create and requirements refuse one outright, the way they
 * already refuse `e2e:deploy-smoke` in a criterion, and name what to use instead.
 *
 * What counts is deliberately narrow, so no ordinary criterion is caught by it:
 *
 * - a proof whose *name* ends in a post-merge or post-deploy segment (`…-postmerge`,
 *   `…/post-deploy`, `…_post-deployment`) — a name that only begins with one, such as
 *   `unit:postmerge-proof-refused-premerge`, is a pre-merge test *about* post-merge proofs — and
 * - a criterion whose text *declares itself* post-merge or post-deploy — it opens with
 *   "Post-merge", "Post-deploy(ment)", "After merge" or "After deploy(ment)". A criterion that
 *   merely mentions a merge (as this item's own criteria do) is not one.
 */
const postMergeName = /(?:^|[-_./])post[-_]?(?:merge|deploy(?:ment)?)$/i;
const postMergeText = /^\W*(?:post[-\s]?(?:merge|deploy(?:ment)?)|after\s+(?:the\s+)?(?:merge|deploy(?:ment)?))\b/i;

/** True when the proof's own name says it runs after merge or deployment. */
export const postMergeProofName = (proof: string) => postMergeName.test(proof.slice(proof.indexOf(':') + 1));
/** True when the criterion text declares the criterion itself post-merge or post-deploy. */
export const postMergeCriterionText = (text: string) => postMergeText.test(text);

/**
 * Why this criterion may not gate a merge, naming the delivery or deploy-smoke obligation to use
 * instead; null when none of its proofs is post-merge. `e2e:deploy-smoke` keeps its own refusal.
 */
export function postMergeProofRefusal(criterion: { id: string; text: string; proofs: string[] }): string | null {
  const byName = criterion.proofs.filter(proof => proof !== deploySmokeProof && postMergeProofName(proof));
  const offending = byName.length ? byName : postMergeCriterionText(criterion.text) ? criterion.proofs.filter(proof => proof !== deploySmokeProof) : [];
  if (!offending.length) return null;
  const what = byName.length ? `${offending.join(', ')} ${offending.length === 1 ? 'is a post-merge proof' : 'are post-merge proofs'}`
    : `${criterion.id} is a post-merge criterion, so ${offending.join(', ')} can only pass after merge`;
  return `${criterion.id}: ${what}, and a pre-merge gate cannot hold it — it can never pass before the merge it gates, so it would hold the item at Prove until removed by hand. `
    + `Require it as a delivery obligation instead: policy.deploySmoke for ${deploySmokeProof}, checked against the deployment that serves the merge, or a follow-up work item that depends on this one and proves it after delivery.`;
}
