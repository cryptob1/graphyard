import { queueSequencingReason } from '../merge-queue.js';
import { automatableOutcomes, dispatchIneligibility, reviewNeed } from './dispatch.js';
import { standingEscalations } from './escalation.js';
import { leadHoldRefusal } from './delegation.js';
import { deliveryState } from './delivery.js';
import { openAgentRequests } from './agent-requests.js';
import type { Work } from './work.js';
import { nextActionKinds, nextActionLlmRoles, type NextAction, type NextActionInputs, type NextActionKind } from './action-kinds.js';

// The vocabulary lives in `action-kinds.ts`; it is re-exported here so that what an item needs
// next and the kinds it can need are still read from one place.
export { actionJudgment, executorRunnableKinds, llmRoles, mechanicalActionKinds, nextActionKinds, nextActionLlmRoles } from './action-kinds.js';
export type { LlmRole, NextAction, NextActionInputs, NextActionKind } from './action-kinds.js';

/**
 * The typed next action.
 *
 * Coordination is inverted here: instead of a master session reading a status report and
 * deciding what to do about each item, the control plane names it. Every read already evaluates
 * the gates (model/gates.ts); this turns that evaluation into one typed instruction per open
 * item — what to do, and the exact inputs whoever runs it needs — so execution can be stateless.
 *
 * Two properties make that safe to build on:
 *
 * - **Totality.** Every refusal a gate can produce maps to exactly one action kind, or to
 *   `escalate`. `refusalAction` is that mapping, and nothing else classifies a refusal. A
 *   refusal nobody thought about becomes an escalation rather than silence.
 * - **Purity.** `nextAction` is a function of the work item, its graph and the clock. The same
 *   snapshot always names the same action, so two executors reading it independently agree
 *   without talking to each other.
 *
 * Nothing here authorizes progression. An action says what is missing; the gates still decide
 * from evidence and verdicts alone.
 */


const short = (sha: string | null | undefined) => sha ? sha.slice(0, 12) : 'none';

const canonical = (value: unknown) => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
/**
 * Whether two computed actions mean the same thing, key order aside.
 *
 * The aggregate round-trips through Postgres `jsonb`, which re-orders object keys. A freshly
 * computed action is built in source order, so a plain string comparison against the stored one
 * always differs — and the reconciliation tick, which saves whenever the document changed, would
 * rewrite every item on every pass forever. This is what keeps a re-evaluation that decided
 * nothing new from looking like a change.
 */
export const sameAction = (left: NextAction | null | undefined, right: NextAction | null | undefined) => canonical(left ?? null) === canonical(right ?? null);

/**
 * Every refusal maps to exactly one action kind. The rules are ordered and the first match wins,
 * so the mapping is a function; the last rule matches everything, so it is total. A refusal that
 * matches no earlier rule is an escalation by construction — the control plane never drops one on
 * the floor because nobody wrote a rule for it.
 */
const refusalRules: { gate: string | null; match: RegExp; kind: NextActionKind }[] = [
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
  // acceptance
  { gate: 'acceptance', match: /is no longer independent:/, kind: 'escalate' },
  { gate: 'acceptance', match: /needs trusted passing evidence/, kind: 'dispatch' },
  // merge
  { gate: 'merge', match: /^GitHub observation missing or older than two minutes$/, kind: 'resync' },
  { gate: 'merge', match: /^Pull request is not mergeable against the current base$/, kind: 'resync' },
  { gate: 'merge', match: /branch protection have not been verified$/, kind: 'escalate' },
  { gate: 'merge', match: /^Ejected from the merge queue:/, kind: 'request-rework' },
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
export function reviewStandstill(work: Work): { kind: NextActionKind; reason: string } | null {
  if (!work.candidate || !work.observation) return null;
  const need = reviewNeed(work);
  switch (need.state) {
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
export function refusalAction(work: Work, gate: string, refusal: string): NextActionKind {
  if (gate === 'test' && /^Required CI check (.+) has not passed on the current candidate$/.test(refusal)) {
    const name = refusal.match(/^Required CI check (.+) has not passed on the current candidate$/)![1];
    const runs = (work.observation?.checks ?? []).filter(check => check.name === name);
    const latest = runs.length ? runs.reduce((newest, check) => (check.attempt ?? 0) >= (newest.attempt ?? 0) ? check : newest) : null;
    return latest && ['failure', 'timed_out', 'action_required', 'cancelled'].includes(latest.result) ? 'request-rework' : 'resync';
  }
  if (gate === 'review') {
    const standstill = reviewStandstill(work);
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

const dispatchInputs = (work: Work): NextActionInputs => ({ kind: 'dispatch', target: 'implementation', epoch: work.epoch, priority: work.priority, plannedFiles: [...(work.plannedFiles ?? [])] });

/** The proof group the acceptance gate is waiting on, with the live producer request when one stands. */
function proofInputs(work: Work, all: Work[], now: Date): NextActionInputs | null {
  const outcomes = automatableOutcomes(work, all, now).filter(entry => entry.outcome === 'unproven');
  if (!outcomes.length || !work.candidate) return null;
  const group = outcomes[0].group;
  const proofs = outcomes.filter(entry => entry.group === group).map(entry => entry.proof);
  const request = (work.autoDispatch?.producers ?? []).find(entry => entry.group === group) ?? null;
  return { kind: 'dispatch', target: 'proof', group, proofs, requestId: request?.id ?? null, pr: work.candidate.pr, sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision };
}

const resyncInputs = (work: Work): NextActionInputs => ({ kind: 'resync', pr: work.candidate?.pr ?? work.submission?.pr ?? null, sha: work.candidate?.sha ?? null, baseSha: work.candidate?.baseSha ?? null, baseTip: work.observation?.baseTip ?? null, observedAt: work.observation?.at ?? null });

/**
 * What this item needs next, or null when it needs nothing from anybody: it is delivered and
 * verified, or every refusal standing against it belongs to another item (an unfinished
 * dependency is that other item's dispatch, not this one's).
 *
 * The order is the order a delivery actually unblocks in: a standing escalation first, because
 * nothing may deliver under one; then a typed request an agent left behind, because a session
 * gave up its lease waiting for that answer; then the deployment a delivered item still owes; then
 * an assignment nobody holds any more; then a live worker blocked on a scope answer; then the
 * first refusing gate; and finally the merge a fully proven candidate is authorized for.
 */
export function nextAction(work: Work, all: Work[], now: Date): NextAction | null {
  const key = work.key, id = work.id;
  // Backlog is not open work: an item nobody has released is waiting on the operator deciding it
  // is ready, which is a goal-setting call and not an action anyone runs. Its refusal still maps
  // (to `escalate`); the item simply raises none until it is released.
  if (!work.ready) return null;
  const make = (kind: NextActionKind, reason: string, inputs: NextActionInputs, binding: string, gate: string | null = null, refusal: string | null = null): NextAction =>
    ({ kind, work: id, key, gate, refusal, reason, inputs, llmRole: inputs.kind === 'dispatch' && inputs.target === 'proof' ? 'produce-evidence' : nextActionLlmRoles[kind], binding });

  const escalation = standingEscalations(work)[0];
  if (escalation) return make('escalate', `${key} has a standing ${escalation.trigger} escalation: ${escalation.reason}`,
    { kind: 'escalate', trigger: escalation.trigger, detail: escalation.reason }, `escalation:${escalation.trigger}:${escalation.at}`);

  // A typed request an agent recorded instead of blocking on a prose question. A scope ask is the
  // control plane's own deterministic rule to apply; a two-party decision is somebody else's
  // judgment, so it leaves the executor loop by the only door that exists for that — escalate.
  const decision = openAgentRequests(work, now).find(ask => ask.type === 'decision');
  if (decision) return make('escalate', `${decision.requestedBy} recorded a decision request on ${key} for ${decision.action ?? 'an action'}: ${decision.reason} — decided by ${decision.decider.who}`,
    { kind: 'escalate', trigger: 'decision', detail: decision.decider.command ?? decision.reason }, `request:${decision.id}`);

  if (work.stage === 'done') {
    const state = deliveryState(work);
    if (state === 'awaiting-deployment' && work.delivery) return make('verify-deployment', `${key} merged as ${short(work.delivery.mergeSha)} and no deployment carrying it has been observed`,
      { kind: 'verify-deployment', mergeSha: work.delivery.mergeSha, mergedAt: work.delivery.mergedAt, state }, `delivery:${work.delivery.mergeSha}`);
    return null;
  }

  // An assignment whose lease has lapsed without a submission, or one fenced by a containment
  // quarantine nobody settled, is held by a session that cannot act. Reclaiming it is mechanical.
  const leaseExpired = !!work.lease && Date.parse(work.lease.expiresAt) <= now.getTime();
  if (leaseExpired && !work.submission) {
    const lease = work.lease!;
    return make('reclaim', `${key} is held by ${lease.owner} under epoch ${lease.epoch}, whose lease expired at ${lease.expiresAt} with nothing submitted`,
      { kind: 'reclaim', epoch: lease.epoch, owner: lease.owner, leaseExpiresAt: lease.expiresAt, quarantined: !!work.containmentQuarantine }, `lease:${lease.epoch}:${lease.expiresAt}`);
  }
  if (work.containmentQuarantine && !work.lease) {
    const quarantine = work.containmentQuarantine;
    return make('reclaim', `${key} is quarantined by unverified containment from epoch ${quarantine.epoch}; nothing may be assigned until it is settled`,
      { kind: 'reclaim', epoch: quarantine.epoch, owner: quarantine.owner, leaseExpiresAt: quarantine.leaseExpiresAt ?? null, quarantined: true }, `quarantine:${quarantine.epoch}:${quarantine.settlementHash}`);
  }

  // A worker that asked for scope is idle until it is answered, whatever the gates say. A request
  // the rule has already decided is not waiting on anybody: an approved one is applied and gone,
  // and a refused one carries its refusal as the item's blocker, which the ready gate reports.
  const scope = work.scopeRequest;
  if (scope && !scope.decision && work.lease && work.lease.epoch === scope.epoch && Date.parse(work.lease.expiresAt) > now.getTime()) {
    return make('approve-scope', `${scope.requestedBy} needs files outside plannedFiles for ${key}: ${scope.paths.join(', ')} — ${scope.reason}`,
      { kind: 'approve-scope', epoch: scope.epoch, paths: [...scope.paths], requestedBy: scope.requestedBy, detail: scope.reason }, `scope:${scope.epoch}:${scope.at}`);
  }

  const failing = work.gates.find(gate => !gate.passed);
  if (failing) {
    const refusal = failing.reasons[0];
    if (refusal === undefined) return null;
    // A live lease is a session already doing exactly what the build gate is waiting for. Naming
    // a dispatch here would offer the item to a second worker while the first still holds it.
    if (failing.name === 'build' && work.lease && Date.parse(work.lease.expiresAt) > now.getTime()) return null;
    const kind = refusalAction(work, failing.name, refusal);
    // An unfinished dependency is the dependency's dispatch, not this item's; nothing waits here.
    if (failing.name === 'ready' && /^Dependency .+ is unfinished$/.test(refusal)) return null;
    const binding = `${failing.name}:${work.policyRevision}:${short(work.candidate?.sha)}:${short(work.candidate?.baseSha)}:${refusal}`;
    if (kind === 'dispatch') {
      if (failing.name === 'acceptance') {
        const inputs = proofInputs(work, all, now);
        // Every unproven proof is a manual one the operator holds: the control plane cannot
        // dispatch it, and saying so is an escalation rather than a dispatch nobody can run.
        if (!inputs) return make('escalate', `${key} waits on proof no producer session may run: ${failing.reasons.join('; ')}`,
          { kind: 'escalate', trigger: 'operator-proof', detail: refusal }, binding, failing.name, refusal);
        return make('dispatch', `${key} needs ${inputs.kind === 'dispatch' && inputs.target === 'proof' ? inputs.proofs.join(', ') : refusal} on ${short(work.candidate?.sha)}`, inputs, binding, failing.name, refusal);
      }
      return make('dispatch', `${key} is ready and unassigned: ${refusal}`, dispatchInputs(work), `dispatch:${work.epoch}`, failing.name, refusal);
    }
    // A review refusal the reviewer's own reading already answered says "approval is required"
    // while the item is actually waiting for a new head or a base refresh; the reason and the
    // detail name what it is waiting for rather than the refusal that classified it.
    const standstill = failing.name === 'review' ? reviewStandstill(work) : null;
    const detail = standstill?.reason ?? refusal;
    if (kind === 'request-review') {
      // Nothing may be asked of a head the control plane has not observed as a live candidate;
      // reviewNeed reads that observation, so ineligibility is decided before it is consulted.
      const ineligible = dispatchIneligibility(work);
      if (ineligible) return make('resync', `${key} cannot be reviewed yet: ${ineligible}`, resyncInputs(work), binding, failing.name, refusal);
      const need = reviewNeed(work);
      // The last guard on the invariant this item exists to hold: a review request is opened only
      // while `needed`, so asking for a reviewer when it is false would hand an executor a row
      // nothing can settle. `reviewStandstill` names an action for every such state today; a state
      // added tomorrow without one escalates — visible and owed — rather than looping in the queue.
      if (!need.needed) return make('escalate', `${key} cannot be reviewed and no executor step answers it: ${need.reason}`,
        { kind: 'escalate', trigger: failing.name, detail: need.reason }, binding, failing.name, refusal);
      const request = work.autoDispatch?.review ?? null;
      return make('request-review', `${key}: ${need.reason}`,
        { kind: 'request-review', provider: work.policy.reviewProvider ?? 'github', requestId: request?.id ?? null, pr: work.candidate!.pr, sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: work.policyRevision },
        binding, failing.name, refusal);
    }
    if (kind === 'request-rework') return make('request-rework', `${key} needs a new head: ${detail}`,
      { kind: 'request-rework', pr: work.candidate?.pr ?? null, sha: work.candidate?.sha ?? null, detail }, binding, failing.name, refusal);
    if (kind === 'resync') return make('resync', `${key} is waiting on a fresh reading of its pull request: ${detail}`, resyncInputs(work), binding, failing.name, refusal);
    // Waiting a turn in the merge queue is nobody's action: the predecessor's merge is the one
    // that moves this item, exactly as an unfinished dependency is that item's dispatch.
    if (kind === 'merge' && failing.reasons.every(entry => queueSequencingReason(entry)) && /^Merge queue position /.test(refusal)) return null;
    if (kind === 'merge') return make('merge', `${key} is queued to merge: ${refusal}`,
      { kind: 'merge', pr: work.candidate!.pr, sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: work.policyRevision, queuePosition: work.queue?.sequence ?? null }, binding, failing.name, refusal);
    // `detail` again rather than the refusal: a review refusal standing over a spent reviewer
    // roster says "a review is required", and what the operator has to decide is the roster.
    return make('escalate', `${key} is refused at the ${failing.name} gate and no executor step answers it: ${detail}`,
      { kind: 'escalate', trigger: failing.name, detail }, binding, failing.name, refusal);
  }

  if (work.violations.length) return make('escalate', `${key} carries ${work.violations.length} violation(s): ${work.violations[0]}`,
    { kind: 'escalate', trigger: 'violation', detail: work.violations[0] }, `violation:${work.violations[0]}`);
  if (work.candidate && !work.observation?.merged) return make('merge', `${key} has passed every gate on ${short(work.candidate.sha)} and is authorized to merge`,
    { kind: 'merge', pr: work.candidate.pr, sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision, queuePosition: work.queue?.sequence ?? null },
    `merge:${work.candidate.sha}:${work.candidate.baseSha}:${work.policyRevision}`);
  return null;
}
