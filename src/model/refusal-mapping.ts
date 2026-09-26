import { queueSequencingReason } from '../merge-queue.js';
import { reviewNeed } from './dispatch.js';
import { standingEscalations } from './escalation.js';
import { leadHoldRefusal } from './delegation.js';
import type { Work } from './work.js';
import type { NextActionKind } from './action-kinds.js';

/**
 * From a gate's refusal to the one action kind that answers it.
 *
 * This is the whole classification, and nothing else in the control plane classifies a refusal.
 * It is kept apart from the computation in `next-action.ts` because the two are read for
 * different reasons: this answers "what kind of thing is this refusal", and that answers "what
 * does this item need". The mapping is total by construction — the last rule matches everything
 * — and `refusal-catalogue.ts` is what makes that totality provable over the refusals the gates
 * can actually word, rather than only over the rules written here.
 */

/**
 * Every refusal maps to exactly one action kind. The rules are ordered and the first match wins,
 * so the mapping is a function; the last rule matches everything, so it is total. A refusal that
 * matches no earlier rule is an escalation by construction — the control plane never drops one on
 * the floor because nobody wrote a rule for it.
 */
export const refusalRules: { gate: string | null; match: RegExp; kind: NextActionKind }[] = [
  // ready
  { gate: 'ready', match: /^Not released from backlog$/, kind: 'escalate' },
  // An unfinished dependency is answered by dispatching that dependency, not by anything on this item.
  { gate: 'ready', match: /^Dependency .+ is unfinished$/, kind: 'dispatch' },
  // build
  { gate: 'build', match: /^Worker has not submitted implementation for this attempt$/, kind: 'dispatch' },
  { gate: 'build', match: /^No workspace registered$/, kind: 'dispatch' },
  { gate: 'build', match: /^Pull request has not been independently observed$/, kind: 'resync' },
  { gate: 'build', match: /has not been compared against the base branch tip/, kind: 'resync' },
  { gate: 'build', match: /^(Candidate changes|Out-of-scope regression)/, kind: 'request-rework' },
  // A mechanical proof that failed on the head returns it to its worker before review (GY-115).
  { gate: 'build', match: /the head returns to its worker before review$/, kind: 'request-rework' },
  // The same judgment passed on the commit the candidate would actually land on: the base has
  // gained work this head would revert. Only a new head answers it, exactly as for the diff
  // against the bound base — without this rule the refusal fell through to the catch-all and
  // said "no executor step answers it" about the one thing rework is for.
  { gate: 'build', match: /^Landing (the candidate on|regression:)/, kind: 'request-rework' },
  // A base the control plane cannot merge in cleanly is the worker's to resolve, on a fresh head:
  // the refusal itself says to run `graphyard sync`, resolve it and push, and that approval and
  // proofs do not survive the resolution. Re-reading the pull request cannot produce that head, so
  // a conflict is rework — the one kind that says a judgment owes this item a new commit.
  { gate: 'build', match: /conflict/i, kind: 'request-rework' },
  // review
  { gate: 'review', match: /^Outstanding change requests/, kind: 'request-rework' },
  { gate: 'review', match: /.*/, kind: 'request-review' },
  // test: a check that failed needs a new head; one that has not answered yet needs a fresh read.
  { gate: 'test', match: /^Required CI check .+ has not passed on the current candidate$/, kind: 'resync' },
  // A check only the base branch's protection requires (GY-430) is named only once it failed.
  { gate: 'test', match: /^Required check .+ failed on the current candidate$/, kind: 'request-rework' },
  // acceptance
  { gate: 'acceptance', match: /is no longer independent:/, kind: 'escalate' },
  { gate: 'acceptance', match: /needs trusted passing evidence/, kind: 'dispatch' },
  // merge
  { gate: 'merge', match: /^GitHub observation missing or older than two minutes$/, kind: 'resync' },
  { gate: 'merge', match: /^Pull request is not mergeable against the current base$/, kind: 'resync' },
  { gate: 'merge', match: /branch protection have not been verified$/, kind: 'escalate' },
  { gate: 'merge', match: /^Ejected from the merge queue:/, kind: 'request-rework' },
  // Unresolved review threads never refuse a merge in Graphyard's gate; a branch that still requires
  // conversation resolution is protection drift, reconciled with graphyard master protection --apply.
  { gate: 'merge', match: /^Branch protection still requires conversation resolution, which Graphyard's review gate does not use: /, kind: 'escalate' },
  { gate: 'merge', match: /^Candidate has not entered the merge queue$/, kind: 'merge' },
  { gate: null, match: /.*/, kind: 'escalate' },
];

/**
 * What a review-gate refusal is really waiting on, when the head's own record already answers it,
 * or null when a review an executor can ask for is genuinely what is missing.
 *
 * Whatever stands behind it, the review gate refuses with a sentence that reads as "a review is
 * required": an approval for `github`, a verified Codex review, a verdict from a reviewer profile.
 * But `reviewNeed` — the same function auto-dispatch uses to decide whether to raise a review
 * request — may already have answered that no *launched* review can be asked for this head, and
 * each of those answers is a different action:
 *
 * - a reviewer requested changes on exactly this head, so the item owes a new one;
 * - the head does not contain the base tip, so any approval would be dismissed;
 * - the provider's review is dispatched by the control plane's own observation job, which a fresh
 *   reading wakes (`Engine.resyncWork`): it posts the request the reviewer answers and reads the
 *   verdict back, and no session exists for an executor to launch;
 * - every configured reviewer profile is exhausted, so there is nobody left to ask and adding
 *   capacity or changing provider is the operator's call.
 *
 * Naming `request-review` for any of them asks for something no executor can ever complete: no
 * review request is raised (`reconcileAutoDispatch` opens one only while `reviewNeed().needed`),
 * the handler refuses for want of one, and the row fails, backs off to the retry cap and is
 * claimed again every tick forever, while the item is never shown as owing a judgment. That is
 * the silence AC-1 exists to end, and it has to end for every provider, not just the one whose
 * reviews a session answers — so this mapping is exhaustive over `ReviewState` and the only state
 * it leaves to `request-review` is the one a launched reviewer can actually answer.
 */
export function reviewStandstill(work: Work, all: Work[] = [work], now = new Date()): { kind: NextActionKind; reason: string } | null {
  if (!work.candidate || !work.observation) return null;
  const need = reviewNeed(work, all, now);
  switch (need.state) {
    // Mechanical proofs precede review (GY-115): producers first; a failed proof owes a new head.
    case 'proofs-pending': return { kind: 'dispatch', reason: need.reason };
    case 'proof-failed': return { kind: 'request-rework', reason: need.reason };
    // Changes requested on this exact head — as a GitHub review, or as the verdict an agent
    // reviewer records — means the item needs a new commit, which is a judgment's to make.
    case 'changes-requested': return { kind: 'request-rework', reason: need.reason };
    // A head that does not contain the base tip is answered by a fresh reading and base refresh.
    case 'base-not-contained': return { kind: 'resync', reason: need.reason };
    // The control plane dispatches this provider's review itself: the fresh reading that wakes its
    // observation job is both how the request is posted and how the verdict arrives.
    case 'provider-dispatched': return { kind: 'resync', reason: need.reason };
    // Nobody is left to ask. An executor cannot add reviewer capacity or change the provider.
    case 'provider-exhausted': return { kind: 'escalate', reason: need.reason };
    // `required` is the one state a launched reviewer answers, and the three remaining states
    // raise no review refusal at all: without a review the policy requires, an approval or a
    // carried approval, the gate passes (or refuses only its outstanding change requests).
    case 'required': case 'not-required': case 'approved': case 'carried': return null;
  }
}

/**
 * The single action kind a refusal maps to. `work` decides the three cases the refusal text cannot:
 * a CI check that reported a failure (rework) rather than one still to answer (re-read), a
 * merge-gate refusal raised by a standing escalation or lead hold rather than by the queue, and a
 * review refusal standing over a head no review can be asked for (`reviewStandstill`).
 */
export function refusalAction(work: Work, gate: string, refusal: string, all: Work[] = [work], now = new Date()): NextActionKind {
  if (gate === 'test' && /^Required CI check (.+) has not passed on the current candidate$/.test(refusal)) {
    const name = refusal.match(/^Required CI check (.+) has not passed on the current candidate$/)![1];
    const runs = (work.observation?.checks ?? []).filter(check => check.name === name);
    const latest = runs.length ? runs.reduce((newest, check) => (check.attempt ?? 0) >= (newest.attempt ?? 0) ? check : newest) : null;
    return latest && ['failure', 'timed_out', 'action_required', 'cancelled'].includes(latest.result) ? 'request-rework' : 'resync';
  }
  if (gate === 'review') {
    const standstill = reviewStandstill(work, all, now);
    if (standstill) return standstill.kind;
  }
  if (gate === 'merge') {
    if (standingEscalations(work).some(entry => refusal.includes(entry.reason)) || leadHoldRefusal(work) === refusal) return 'escalate';
    // The queue's own sequencing — waiting a turn, waiting for a speculative tip — is the merge
    // action making progress, not a refusal anyone acts on differently.
    if (queueSequencingReason(refusal)) return 'merge';
  }
  const rule = refusalRules.find(candidate => (candidate.gate === null || candidate.gate === gate) && candidate.match.test(refusal));
  return rule!.kind;
}

/** Every rule in the mapping, exposed so a test can prove each one is reachable from a declared refusal. */
export const refusalRuleIndex = refusalRules.map((rule, index) => ({ index, gate: rule.gate, source: String(rule.match), kind: rule.kind }));
/** Which rule classified a refusal: the mapping's own `find`, reported rather than repeated. */
export function refusalRuleFor(gate: string, refusal: string) {
  const index = refusalRules.findIndex(candidate => (candidate.gate === null || candidate.gate === gate) && candidate.match.test(refusal));
  return refusalRuleIndex[index];
}
