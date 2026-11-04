import type { Work, Stage, Gate } from '../model/work.js';
import { type PostMergeReviewState, sensitiveReviewRefusal, postMergeReviewMark } from '../model/post-merge-review.js';
import { filingRefusal } from './user-facing.js';
import { evaluateLandability } from './landability.js';
import { landabilityRefusals, landabilityAudit } from '../model/landability.js';
import { exactApproval } from '../model/review.js';
import { carriedApproval } from '../model/carry.js';
import { riskOf } from './risk-class.js';
import { reviewedBeforeMerge } from '../model/risk-class.js';
import { productReviewRefusal } from './product-review.js';
import { humanProofHolds } from '../model/human-proof.js';
import { mergeLedgerRefusals, unobservedCandidateRefusal } from '../model/gates.js';
import { leadHoldRefusal } from '../model/delegation.js';
/**
 * The item's stage and gates, judged from the record alone. The merge writer merges each
 * candidate whose gates pass (docs/delivery.md); nothing here places it in a queue of Graphyard's own.
 */
export function evaluate(work: Work, all: Work[], now: Date): { stage: Stage; gates: Gate[]; violations: string[]; postMergeReview?: PostMergeReviewState | null } {
  const gates: Gate[] = [];
  const add = (name: string, reasons: string[]) => gates.push({ name, passed: reasons.length === 0, reasons });
  const dependencies = work.dependencies.filter(id => all.find(w => w.id === id)?.stage !== 'done');
  // GY-2981: open items catch up to the filing rules an upgrade adds. An item written straight to
  // the store keeps its filed criteria forever, so the ready gate re-runs create's filing
  // validation (model/user-facing.ts) against the item's current criteria and the install's
  // current policy: what today's rules would refuse is refused here with create's own message, and
  // the master answers it with master requirements. Only an open item nobody holds is judged: a
  // claimed item keeps its lease, and a submitted one is its attempt's to carry, so neither is
  // refused mid-flight; a delivered item's gates are history.
  const filed = work.stage !== 'done' && !work.submission && !(work.lease && Date.parse(work.lease.expiresAt) > now.getTime())
    ? filingRefusal({ type: work.type, description: work.description, criteria: work.criteria }) : null;
  add('ready', [...(!work.ready ? ['Not released from backlog'] : []), ...dependencies.map(id => `Dependency ${all.find(w => w.id === id)?.key ?? id} is unfinished`),
    ...(work.blocker ? [work.blocker] : []), ...(filed ? [filed] : [])]);
  const candidate = work.candidate;
  const obs = work.observation;
  const current = !!candidate && !!obs && obs.candidate.sha === candidate.sha && obs.candidate.baseSha === candidate.baseSha;
  // Whether the candidate can land is one verdict (GY-878): the build and acceptance gates are its
  // two families, word for word. A candidate that reverts, deletes or rewrites shipped files
  // outside its planned scope, sits on a base the control plane cannot merge in cleanly, or
  // failed a mechanical proof (GY-115) is refused by the build family; an
  // unproven proof, inherited obligation or dependent producer by the acceptance family.
  const verdict = evaluateLandability(work, all, now);
  const family = (name: 'build' | 'acceptance') => {
    const reasons = landabilityRefusals(verdict, name);
    // A refusal records the verdict version and its inputs in the audit trail (the gate itself).
    gates.push({ name, passed: reasons.length === 0, reasons, ...(reasons.length ? { verdict: landabilityAudit(verdict) } : {}) });
  };
  family('build');
  const reviews = current ? obs!.reviews : [];
  const changesRequested = reviews.some(r => r.state === 'CHANGES_REQUESTED');
  // An approval binds the exact commit: the one the provider approved (see exactApproval), or the
  // one Graphyard carried it to across its own authored base refresh (see carry.ts). Nothing else counts.
  const reviewPassed = !!exactApproval(work) || !!carriedApproval(work);
  const reviewRefusal = work.formalReviewResetRequired ? 'A new independent approval after the requirement-review baseline is required' : 'Independent approval of the current commit is required';
  // The one merge rule (GY-1525): a head the merge writer observed is judged by the class of its
  // merge delta (model/risk-class.ts). A sensitive delta needs the exact-head approval before it
  // merges; any other passes here and owes one post-merge review (model/post-merge-review.ts), which
  // the evaluation marks on the item. A pull-request-era observation still needs its approval.
  const byRisk = current && obs!.source === 'control-plane' ? riskOf(work) : null;
  const beforeMerge = byRisk ? reviewedBeforeMerge(byRisk.risk) : true;
  const riskRefusal = reviewPassed || !beforeMerge ? [] : byRisk?.risk === 'sensitive' ? [sensitiveReviewRefusal(byRisk.reasons)] : [reviewRefusal];
  const postMerge = byRisk ? postMergeReviewMark(work, beforeMerge ? 'sensitive' : byRisk.risk, reviewPassed) : {};
  // A change request holds only where the approval is needed before merge. A normal-risk change
  // request is attention for the post-merge pass, never a merge gate (GY-1525).
  const changeRequestHold = changesRequested && beforeMerge
    ? ['Outstanding change requests must be resolved through a new review'] : [];
  // A user-facing feature owes its product review before the merge, whichever side the risk class
  // puts the code review on (GY-2989): an approval of the exact head (or one carried across a
  // non-UI delta) lets it pass; a change request reworks; a reject never merges.
  const productHold = productReviewRefusal(work);
  // A `human:` proof holds the head here until a person passes it on this commit (GY-2986).
  add('review', [...riskRefusal, ...changeRequestHold, ...(productHold ? [productHold] : []), ...humanProofHolds(work, now)]);
  // GY-2010: gates never read GitHub. The merge writer's ledger stands for the test and merge
  // gates for every observed candidate — including a document that still carries pull-request-era
  // checks, PR numbers and mergeability. Those fields load; they do not refuse progression.
  const ledger = current ? mergeLedgerRefusals(work.mergeLedger, obs!.candidate) : null;
  const checkReasons = ledger ? ledger.test : current ? [] : [unobservedCandidateRefusal];
  gates.push({ name: 'test', reasons: checkReasons, passed: checkReasons.length === 0 });
  // A lead hold is a refusal to deliver, and its own reason is reported.
  // Unresolved review threads are the reviewer's inputs, not merge blockers.
  const delivery = leadHoldRefusal(work) ? [leadHoldRefusal(work)!] : [];
  add('merge', [...(!current ? [unobservedCandidateRefusal] : []), ...(ledger ? ledger.merge : []), ...delivery]);
  const first = gates.find(g => !g.passed);
  const violations = [...work.violations];
  let stage: Stage = !work.ready ? 'backlog' : !work.submission ? (work.lease && Date.parse(work.lease.expiresAt) > now.getTime() ? 'build' : 'ready') : (first?.name === 'ready' ? 'build' : first?.name as Stage ?? 'merge');
  // Delivery history stays complete; later observations cannot rewrite it.
  if (work.stage === 'done') stage = 'done';
  return { stage, gates, violations, ...postMerge };
}
