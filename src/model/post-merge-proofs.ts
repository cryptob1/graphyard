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
  // A declared post-deploy verification (GY-1660) may say "After deploy": that is what it declares.
  const offending = byName.length ? byName : postMergeCriterionText(criterion.text) && !declaredPostDeploy(criterion) ? criterion.proofs.filter(proof => proof !== deploySmokeProof) : [];
  if (!offending.length) return null;
  const what = byName.length ? `${offending.join(', ')} ${offending.length === 1 ? 'is a post-merge proof' : 'are post-merge proofs'}`
    : `${criterion.id} is a post-merge criterion, so ${offending.join(', ')} can only pass after merge`;
  return `${criterion.id}: ${what}, and a pre-merge gate cannot hold it — it can never pass before the merge it gates, so it would hold the item at Prove until removed by hand. `
    + `Require it as a delivery obligation instead: policy.deploySmoke for ${deploySmokeProof}, checked against the deployment that serves the merge, or a follow-up work item that depends on this one and proves it after delivery.`;
}

/**
 * Post-deploy verification criteria (GY-1660). A criterion whose outcome is an observation of the
 * live install — the restarted loop, the deployed release, the shipped change's report, production — can only
 * be shown after merge and deploy, yet a criterion gates the merge: the reviewer holds the merge
 * until the observation exists and no worker can make it, so the item deadlocks until a person
 * rewords it (GY-1652 AC-3, GY-1657 AC-1..4). `criterionSchema` therefore accepts one — at create,
 * at a requirements revision and in a requirements decision alike — only when declared, by naming
 * a `manual:post-deploy/NAME` proof. A declared proof is never a pre-merge gate: the reviewer judges
 * the criterion on the head's pre-merge evidence, and `master verify-deployment` checks it on the
 * serving release and files a follow-up naming the delivered item when it is not observed there.
 *
 * Detection reads the text whatever the proof family, so a unit-proven wording of a live outcome
 * is caught too; only a criterion anchored to the head ("from this head against the live install",
 * "before merge") or to a stub is a pre-merge observation.
 */
export const postDeployProofPrefix = 'manual:post-deploy/';
const liveObservation = new RegExp([
  /\blive\s+(?:install(?:ation)?|loop|daemon|server|service|deployment|system|environment|release|traffic)\b/, /\bon\s+this\s+installation\b/,
  /\brestarted\s+(?:master\s+)?loop\b/, /\bthe\s+master\s+loop\s+restarts\b/,
  // The release that serves the merge, however it is named: deployed, serving, running, production.
  /\b(?:on|in|against|from|by)\s+the\s+(?:deployed|serving|running|live)\s+(?:release|install(?:ation)?|loop|daemon|server|service|control\s+plane|system|deployment)\b/,
  /(?<![\/\w-])production\b(?!\s+(?:code|paths?|branch(?:es)?|builds?|bundles?|dependenc(?:y|ies)|modules?|sources?|files?)\b)/,
  /\b(?:after|once)\s+(?:the\s+(?:change|fix|merge)\s+(?:is\s+|has\s+)?)?(?:deploy(?:ed|ment)?|merged\s+and\s+deployed|ships|shipped|is\s+shipped|goes\s+live)\b/,
  /\bpost[-\s]?ship(?:ping|ped)?\b/, /\bonce\s+the\s+fix\s+is\s+running\b/, /\bobservation\s+after\s+deploy/,
  // A path of the coordinator's own checkout is an operator act on the install, not a head's.
  /(?:^|\s|`)\/home\//,
].map(part => part.source).join('|'), 'i');
const headAnchored = /\b(?:from|on|at)\s+(?:this|the)\s+(?:pull\s+request's\s+)?head\b|\bthis\s+head(?:'s)?\b|\bthe\s+candidate(?:'s)?\s+head\b|\bbefore\s+merge\b|\bstub(?:bed)?\b/i;
type CriterionProofs = { id: string; text: string; proofs: readonly string[] };
/** The criterion's declared post-deploy proofs; a criterion naming one is a declared post-deploy verification. */
export const postDeployProof = (proof: string) => proof.startsWith(postDeployProofPrefix);
export const postDeployProofs = (criterion: Pick<CriterionProofs, 'proofs'>) => criterion.proofs.filter(postDeployProof);
export const declaredPostDeploy = (criterion: Pick<CriterionProofs, 'proofs'>) => postDeployProofs(criterion).length > 0;
/** The phrase that makes this criterion's outcome a live-install or post-deploy observation, or null. */
export function liveObservationPhrase(criterion: Pick<CriterionProofs, 'text'> & Partial<CriterionProofs>): string | null {
  // The anchor covers only its own clause: "Before merge test the stub; after deployment verify
  // production traffic" still carries an unanchored live observation in its second clause.
  for (const clause of criterion.text.split(/[;\n]|\.\s+/)) {
    const phrase = !headAnchored.test(clause) && liveObservation.exec(clause)?.[0].trim();
    if (phrase) return phrase;
  }
  return null;
}
/** Why these criteria cannot be recorded, naming each undeclared live-observation criterion; null when none is. */
export function postDeployCriterionRefusal(criteria: readonly CriterionProofs[]): string | null {
  const undeclared = criteria.flatMap(criterion => { const phrase = !declaredPostDeploy(criterion) && liveObservationPhrase(criterion); return phrase ? [`${criterion.id} ("${phrase}")`] : []; });
  if (!undeclared.length) return null;
  return `${undeclared.join(', ')} ${undeclared.length === 1 ? 'is a live-install or post-deploy observation' : 'are live-install or post-deploy observations'} that no head can show before the merge it gates, so the reviewer would hold the merge on it while no worker can make it. `
    + `Declare it a post-deploy verification by naming its proof ${postDeployProofPrefix}NAME — the reviewer judges it on the head's pre-merge evidence and master verify-deployment checks it on the serving release, filing a follow-up when it is not observed there — or reword it to an observation this head can show before merge (from this head against the live install)`;
}
