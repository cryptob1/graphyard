import { repeatingPaths as loopRepeatingPaths, touchesRepeatingPath } from './model/repeating-paths.js';
import { verificationMapDigest, type VerificationMap } from './verification-maps.js';
import { declaredPostDeploy, pinnedCases } from './model.js';
export type ReviewCriterion = { id: string; text: string; proofs?: readonly string[] };
/**
 * The shared simplicity paragraph (GY-1999): defined once here and interpolated verbatim into every
 * role prompt — worker (dispatch.ts), reviewer, planner, acceptance and master — and put at the top
 * of AGENTS.md, so agents build the simplest thing that meets the criteria instead of machinery.
 */
export const simplicityParagraph = 'Keep it simple. Build the simplest thing that meets the criteria and gives users a good experience. Do not over-engineer: no defensive layers, extra gates, permission checks or tests for hypothetical cases. Prefer deleting code to adding it. Agents are capable: do not build process around corner cases. ';
/** The blocking standard (GY-2000): the only findings a review may hold a head with, stated beside the simplicity paragraph in both review prompts; anything else is at most a Nit. */
export const blockingStandardSection = 'A BLOCKING finding must name a real defect a user or operator would hit with this change, a criterion that is not met, a leaked secret, or lost or corrupted data; anything else is at most a Nit. ';
/**
 * How the reviewer judges declared post-deploy verifications (GY-1660): on the head's pre-merge
 * evidence, never holding the merge for the live observation, which is read on the serving
 * release after delivery. Empty when no criterion is declared, so every
 * other review request stays byte-identical.
 */
export function postDeployReviewSection(criteria?: readonly ReviewCriterion[]) {
  const declared = (criteria ?? []).filter(criterion => criterion.proofs && declaredPostDeploy({ proofs: criterion.proofs })).map(criterion => criterion.id);
  if (!declared.length) return '';
  return `${declared.join(', ')} ${declared.length === 1 ? 'is a declared post-deploy verification' : 'are declared post-deploy verifications'}: the live install can only show ${declared.length === 1 ? 'its' : 'their'} outcome after this change is merged and deployed. `
    + 'Judge each on this head\'s pre-merge evidence — the change that should produce the outcome, and what the head shows before merge — and never request changes or hold the merge because the live install or deployed release has not shown it yet; '
    + 'it is read on the serving release after delivery, and a failure is a follow-up naming the delivered item. ';
}
/**
 * Review a criterion pinned to one input for generality through code and coverage, within the
 * reviewer's read-only role. Execution belongs to the automated merge trial.
 * Empty when no criterion pins one, so every other review request stays byte-identical.
 */
export function singleCaseReviewSection(criteria?: readonly ReviewCriterion[]) {
  const flagged = (criteria ?? []).filter(criterion => pinnedCases(criterion.text).length === 1).map(criterion => criterion.id);
  if (!flagged.length) return '';
  return `${flagged.join(', ')} ${flagged.length === 1 ? 'checks' : 'check'} one case: a head can pass by tuning to that case. For each, inspect the implementation and test coverage for other seeds or inputs, and request changes if the code only handles the pinned case or the coverage does not establish the required generality. `;
}
/**
 * The criteria rule (GY-166). GY-164 took 19 attempts: its reviewer confirmed both
 * criteria met around round 16 and kept requesting changes for new edge cases. The reviewer judges
 * the item's acceptance criteria; anything worth fixing is BLOCKING and fixed on the same head,
 * and the rest are nits, never filed as work items (GY-1249). `criteria` are the item's own, written by its operator.
 * GY-2972: the finding classification and verdict rules moved to `guide review`; the brief names
 * that topic beside the criteria instead of restating them.
 */
export function criteriaRuleSection(key: string, sha: string, criteria: { id: string; text: string }[] = []) {
  // Each criterion verbatim: a condition cut from its tail would be judged FOLLOW-UP and silently
  // dropped, and collapsed whitespace changes an indented fragment or exact output it quotes.
  const listed = criteria.map(criterion => `[${criterion.id}] ${criterion.text}`).join(' ');
  return `Review against the acceptance criteria of ${key}${listed ? `: ${listed}` : ''}. `
    + `Judge every criterion met or unmet at head ${sha} from code and test coverage, including bound E2E cases; state each judgement in the review body. Do not run builds, tests or servers. Post APPROVE or REQUEST_CHANGES before the automated merge trial: missing later trusted results do not block review; missing or inadequate test implementation can. The merge writer must pass every required exact-head test/E2E proof before updating main. Never waive gates or ask workers for trusted evidence; no human step. `;
}

/** The paths whose changes run on every loop cycle (GY-404), shared with the scope rule's soak companion (GY-1892). */
export const repeatingPaths = loopRepeatingPaths;
export { touchesRepeatingPath };
/**
 * The question the review asks of a change to a repeating path: what it does across many cycles,
 * heads and items, and whether that behaviour stays bounded — asked, never required: the review
 * must not demand new soak-suite coverage of a repeating change (GY-2000). Files unknown (no
 * observation of this head), the question is asked conditionally.
 */
export function repetitionReviewSection(files?: readonly string[] | null) {
  if (files && !touchesRepeatingPath(files)) return '';
  const question = 'ask what it does when repeated across many cycles, heads and items: one follow-up per approval becomes 170 for 40 parents, one refresh per merge becomes one per merge for every open candidate, one session per decision stays open unless something closes it. '
    + 'Ask whether that repeated behaviour stays bounded; never require new soak-suite coverage of it — lacking tests/soak-*.test.ts coverage is at most a Nit. ';
  return files ? `This change touches ${files.filter(file => touchesRepeatingPath([file])).slice(0, 5).join(', ')}, which run on every loop cycle: ${question}`
    : `If this change touches ${repeatingPaths.join(', ')}, which run on every loop cycle, ${question}`;
}


/**
 * The judging part of a control-plane review request (GY-1987): what the diff is read with, the
 * criteria rule, the declared post-deploy rule, the BLOCKING/Nit rule, the repetition section and
 * the verification maps — everything a diff is judged by, and none of the session, posting and
 * credential instructions around it. `review self`
 * prints this for the worker's own head, so a worker applies the standard the independent reviewer
 * will apply to the same diff before it submits. `context` carries the request's project-memory and
 * review-round sections through their exact pre-factoring positions inside this span, so the
 * request stays byte-identical whatever a session's history and memory hold; a self-review passes
 * none, and judges the diff by the shared standard alone.
 */
export function reviewStandard(binding: { key: string; head: string; base: string }, criteria?: ReviewCriterion[], files?: readonly string[] | null, verification?: { maps: readonly VerificationMap[]; paths: readonly string[] } | null, context?: { memory?: string; round?: string } | null) {
  return `Read the change with: git diff ${binding.base} ${binding.head} (both commits are in this session's object store; git show --stat ${binding.head} lists its files). `
    + (context?.memory ?? '')
    + verificationMapDigest(verification?.maps, verification?.paths, 'reviewer')
    + (context?.round ?? '')
    + criteriaRuleSection(binding.key, binding.head, criteria)
    + postDeployReviewSection(criteria)
    + singleCaseReviewSection(criteria)
    + controlPlaneFindingSection
    + blockingStandardSection
    + repetitionReviewSection(files);
}

/** Nits stay advisory and are kept for later workers. */
export const controlPlaneFindingSection = 'Name each nit on its own "Nit: PATH:LINE — FINDING" line. Nits are advisory in control-plane mode: Graphyard keeps them in project memory for later workers, and no bot fixes them, so put anything that must be fixed on a BLOCKING: line instead. ';
