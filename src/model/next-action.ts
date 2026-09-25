import { queueSequencingReason } from '../merge-queue.js';
import { dispatchIneligibility, openProducerRequest, producerGroupDecisions, reviewNeed, type ProducerGroupDecision } from './dispatch.js';
import { mechanicalProof } from './mechanical-proofs.js';
import { producerLaunchStop } from './action-progress.js';
import { standingEscalations } from './escalation.js';
import { deliveryState } from './delivery.js';
import { openAgentRequests } from './agent-requests.js';
import { refusalAction, reviewStandstill } from './refusal-mapping.js';
import type { Work } from './work.js';
import { nextActionLlmRoles, type NextAction, type NextActionInputs, type NextActionKind } from './action-kinds.js';
import type { ActionAccount, ActionWait } from './action-account.js';
import { carriedAction, type OpenAction } from './concerns.js';

// The vocabulary lives in `action-kinds.ts`, the classification in `refusal-mapping.ts`, the
// declared refusals in `refusal-catalogue.ts` and the accounting vocabulary in
// `action-account.ts`; each is re-exported here so what an item needs next is still read from
// one place. `action-account.ts` is the one exception: it imports the computation below, so it
// is imported from directly rather than re-exported through the module it depends on.
export { actionJudgment, executorRunnableKinds, llmRoles, mechanicalActionKinds, nextActionKinds, nextActionLlmRoles } from './action-kinds.js';
export type { LlmRole, NextAction, NextActionInputs, NextActionKind } from './action-kinds.js';
export { refusalAction, refusalRuleFor, refusalRuleIndex, refusalRules, reviewStandstill } from './refusal-mapping.js';
export { gateRefusalCatalogue, refusalShape, type RefusalShape } from './refusal-catalogue.js';
// What stands beside an action lives in `concerns.ts`, re-exported here likewise.
export { carriedAction, dispatchHold, escalationResolution, humanNeeded, humanNeededActions, openAction } from './concerns.js';
export type { CarriedConcern, HumanNeeded, HumanNeededRow, OpenAction } from './concerns.js';

/**
 * The typed next action.
 *
 * Coordination is inverted here: instead of a master session reading a status report and
 * deciding what to do about each item, the control plane names it. Every read already evaluates
 * the gates (model/gates.ts); this turns that evaluation into one typed instruction per open
 * item — what to do, and the exact inputs whoever runs it needs — so execution can be stateless.
 *
 * Three properties make that safe to build on:
 *
 * - **Totality.** Every refusal a gate can produce maps to exactly one action kind, or to
 *   `escalate`. `refusalAction` is that mapping, and nothing else classifies a refusal. A
 *   refusal nobody thought about becomes an escalation rather than silence. `refusalRules` makes
 *   that total over *rules*; `gateRefusalCatalogue` is what makes it provable over *outcomes*.
 * - **Accountability.** An item that needs nothing says which nothing it is. `actionAccount`
 *   answers for every item with an action, or a named wait — another item's action, a live
 *   session, a decision reserved for a person — and, when neither could be produced, with the
 *   defect that says so. Nothing is left as a bare `null` for a reader to guess at, because an
 *   item holding a failing gate with no action and nobody told is the one failure typed actions
 *   exist to prevent (GY-103, GY-106).
 * - **Purity.** `nextAction` is a function of the work item, its graph and the clock. The same
 *   snapshot always names the same action, so two executors reading it independently agree
 *   without talking to each other.
 *
 * Nothing here authorizes progression. An action says what is missing; the gates still decide
 * from evidence and verdicts alone. And nothing here invents an action to fill a gap: a
 * synthesised action nobody can complete is a row that fails forever, which is worse than the
 * silence it replaces — a state nobody wrote a rule for is reported, not answered.
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

const dispatchInputs = (work: Work): NextActionInputs => ({ kind: 'dispatch', target: 'implementation', epoch: work.epoch, priority: work.priority, plannedFiles: [...(work.plannedFiles ?? [])] });

/**
 * What the proof groups of the head call for, read from the decision `reconcileAutoDispatch`
 * makes (`producerGroupDecisions`), so the planner never names a producer the reconciler will not
 * request (GY-188):
 *
 * - `dispatch` — a group the reconciler requests, holding its open request. Nothing else is a
 *   proof dispatch, so every one an executor claims has a request to launch against.
 * - `failed` — trusted evidence failed for a group: this head can never pass, whatever else is
 *   still unproven on it, so the step is a new head (or the operator, for a manual proof).
 * - `wait` — a group is left to prove but no request is open for it: the reconciler opens one on
 *   the next reading, or no request may stand for the head yet. Nobody's action, never a dispatch.
 * - `stopped` — every group left to prove holds a request whose launch an executor was refused for
 *   good (`producerLaunchStop`): no executor launches it again, so the step is the attestation.
 * - null — every proof left is one no producer session may run.
 */
type ProofStep = { step: 'dispatch'; inputs: NextActionInputs } | { step: 'failed'; decision: ProducerGroupDecision } | { step: 'wait'; detail: string } | { step: 'stopped'; detail: string };
function proofStep(work: Work, all: Work[], now: Date): ProofStep | null {
  if (!work.candidate) return null;
  const candidate = work.candidate;
  const decisions = producerGroupDecisions(work, all, now);
  const failed = decisions.find(decision => decision.state === 'failed');
  if (failed) return { step: 'failed', decision: failed };
  let stopped: string | null = null;
  for (const decision of decisions.filter(entry => entry.state === 'request')) {
    const request = openProducerRequest(work, decision.group);
    if (!request) continue;
    // A request an executor's launcher has refused for good is never offered again, to any
    // executor on any host (`producerLaunchStop`); its proofs are left to the attestation.
    const stop = producerLaunchStop(work, request.id);
    if (stop) {
      const remedy = decision.unproven.every(proof => proof.startsWith('manual:')) ? `only a two-party attestation (master decide ${work.key} attest) satisfies them now` : 'a new head or the operator answers them now';
      stopped ??= `${decision.group} proofs ${decision.unproven.join(', ')} on ${short(candidate.sha)} get no further producer launch from any executor — ${stop.reason}; ${remedy}`;
      continue;
    }
    return { step: 'dispatch', inputs: { kind: 'dispatch', target: 'proof', group: decision.group, proofs: decision.unproven, requestId: request.id, pr: candidate.pr, sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: work.policyRevision } };
  }
  if (stopped) return { step: 'stopped', detail: stopped };
  const pending = decisions.find(decision => decision.state === 'request' || decision.state === 'ineligible');
  if (!pending) return null;
  return { step: 'wait', detail: pending.state === 'ineligible' ? `${pending.group} proofs ${pending.unproven.join(', ')} wait: ${pending.reason}`
    : `no ${pending.group} producer request is open yet for ${short(candidate.sha)} (${pending.unproven.join(', ')}); the control plane's reconciliation opens it` };
}

const resyncInputs = (work: Work): NextActionInputs => ({ kind: 'resync', pr: work.candidate?.pr ?? work.submission?.pr ?? null, sha: work.candidate?.sha ?? null, baseSha: work.candidate?.baseSha ?? null, baseTip: work.observation?.baseTip ?? null, observedAt: work.observation?.at ?? null });



type Computed = Pick<ActionAccount, 'gate' | 'refusal' | 'action' | 'wait' | 'defect'>;

/**
 * What this item needs next, or null when it needs nothing from anybody: it is delivered and
 * verified, a session is already doing what the gate waits for, or every refusal standing against
 * it belongs to another item (an unfinished dependency is that item's dispatch, not this one's),
 * with every standing concern beside it (`concerns.ts`).
 *
 * This is `actionAccount` with everything but the action dropped, kept because every caller that
 * only wants the instruction — the queue, the API, the executor — should not have to know about
 * the accounting. A caller that has to tell an idle item from a stalled one calls `actionAccount`.
 */
export function nextAction(work: Work, all: Work[], now: Date): OpenAction | null {
  return carriedAction(work, computeAccount(work, all, now).action, all, now);
}

/**
 * What this item needs next, or why it needs nothing — with the failing gate it answers and how
 * long the item has held it.
 *
 * The order is the order a delivery actually unblocks in: a typed request an agent left behind
 * first, because a session gave up its lease waiting for that answer; then the deployment a
 * delivered item still owes; then an assignment nobody holds any more; then a live worker blocked
 * on a scope answer; then the first refusing gate; and finally the merge a fully proven candidate
 * is authorized for. A standing escalation is not in that order at all: it refuses delivery, the
 * merge gate carries its refusal like any other, and `carriedAction` (concerns.ts) decides what it
 * does to the step named here — which, for everything before delivery, is nothing.
 */
export function actionAccount(work: Work, all: Work[], now: Date): ActionAccount {
  const heldSince = work.stageEnteredAt ?? work.updatedAt ?? now.toISOString();
  const held = Date.parse(heldSince);
  const computed = computeAccount(work, all, now);
  // A standing escalation turns an item with nothing else to do into an `escalate` (concerns.ts).
  const action = carriedAction(work, computed.action, all, now);
  return { work: work.id, key: work.key, ...computed, action, ...(action && !computed.action ? { wait: null, defect: null } : {}),
    heldSince, heldMs: Number.isFinite(held) ? Math.max(0, now.getTime() - held) : 0 };
}

function computeAccount(work: Work, all: Work[], now: Date): Computed {
  const key = work.key, id = work.id;
  const make = (kind: NextActionKind, reason: string, inputs: NextActionInputs, binding: string, gate: string | null = null, refusal: string | null = null): Computed =>
    ({ gate, refusal, wait: null, defect: null,
      action: { kind, work: id, key, gate, refusal, reason, inputs, llmRole: inputs.kind === 'dispatch' && inputs.target === 'proof' ? 'produce-evidence' : nextActionLlmRoles[kind], binding } });
  const waits = (wait: ActionWait, gate: string | null = null, refusal: string | null = null): Computed => ({ gate, refusal, action: null, wait, defect: null });
  /** No rule named anything for this state. Reported as the defect it is; never papered over with an action nobody can run. */
  const unaccounted = (detail: string, gate: string | null = null, refusal: string | null = null): Computed => ({ gate, refusal, action: null, wait: null, defect: detail });

  // Backlog is not open work: an item nobody has released is waiting on the operator deciding it
  // is ready, which is a goal-setting call and not an action anyone runs. Its refusal still maps
  // (to `escalate`); the item simply raises none until it is released.
  if (!work.ready) return waits({ kind: 'human', on: 'operator', detail: `${key} has not been released from the backlog; releasing it is a goals-and-priorities decision, which is the operator's` },
    'ready', 'Not released from backlog');

  // A typed request an agent recorded instead of blocking on a prose question. A scope ask is the
  // control plane's own deterministic rule to apply; a two-party decision is somebody else's
  // judgment, so it leaves the executor loop by the only door that exists for that — escalate.
  const decision = openAgentRequests(work, now).find(ask => ask.type === 'decision');
  if (decision) return make('escalate', `${decision.requestedBy} recorded a decision request on ${key} for ${decision.action ?? 'an action'}: ${decision.reason} — decided by ${decision.decider.who}`,
    { kind: 'escalate', trigger: 'decision', detail: decision.decider.command ?? decision.reason }, `request:${decision.id}`);

  if (work.stage === 'done' && work.closure) return waits({ kind: 'settled', on: null, detail: `${key} was closed as ${work.closure.kind}${work.closure.ref ? ` (${work.closure.ref})` : ''} by ${work.closure.by}: ${work.closure.reason}` });
  if (work.stage === 'done') {
    const state = deliveryState(work);
    if (state === 'awaiting-deployment' && work.delivery) return make('verify-deployment', `${key} merged as ${short(work.delivery.mergeSha)} and no deployment carrying it has been observed`,
      { kind: 'verify-deployment', mergeSha: work.delivery.mergeSha, mergedAt: work.delivery.mergedAt, state }, `delivery:${work.delivery.mergeSha}`);
    return waits({ kind: 'settled', on: null, detail: `${key} is delivered (${state}); its gates are history and no gate refuses it` });
  }

  const liveLease = !!work.lease && Date.parse(work.lease.expiresAt) > now.getTime();
  // A containment quarantine outlives the attempt that raised it, and no executor step lowers one:
  // reconciliation clears a lapsed lease — the other half of `reclaim`, and the half that works —
  // but a fence comes down only on the worker's settlement capability, a verified containment
  // assessment or an operator's stopped-worker recovery, each resting on somebody judging that the
  // worker really stopped. Naming `reclaim` handed an executor a row whose handler re-read the
  // item, called it free while it was still fenced, and came back every settle window for as long
  // as the fence stood. This is `provider-exhausted` again: no executor step answers it.
  if (work.containmentQuarantine && !liveLease) {
    const quarantine = work.containmentQuarantine;
    return make('escalate', `${key} is fenced by unverified containment from epoch ${quarantine.epoch} and nothing may be assigned to it; no executor step lowers a quarantine`,
      { kind: 'escalate', trigger: 'containment', detail: `verify that ${quarantine.owner}'s worker stopped and settle the epoch ${quarantine.epoch} quarantine (graphyard master settle-containment ${key} REASON), or recover it as a stopped worker` },
      `quarantine:${quarantine.epoch}:${quarantine.settlementHash}`);
  }
  // An assignment whose lease has lapsed without a submission is held by a session that cannot
  // act, and nothing fences the item. Reclaiming it is mechanical: the reconciliation the control
  // plane already runs clears the lapse, and the executor only asks for it.
  if (!liveLease && work.lease && !work.submission) {
    const lease = work.lease;
    return make('reclaim', `${key} is held by ${lease.owner} under epoch ${lease.epoch}, whose lease expired at ${lease.expiresAt} with nothing submitted`,
      { kind: 'reclaim', epoch: lease.epoch, owner: lease.owner, leaseExpiresAt: lease.expiresAt }, `lease:${lease.epoch}:${lease.expiresAt}`);
  }

  // A worker that asked for scope is idle until it is answered, whatever the gates say. A request
  // the rule has already decided is not waiting on anybody: an approved one is applied and gone,
  // and a refused one carries its refusal as the item's blocker, which the ready gate reports.
  const scope = work.scopeRequest;
  if (scope && !scope.decision && liveLease && work.lease!.epoch === scope.epoch) {
    return make('approve-scope', `${scope.requestedBy} needs files outside plannedFiles for ${key}: ${scope.paths.join(', ')} — ${scope.reason}`,
      { kind: 'approve-scope', epoch: scope.epoch, paths: [...scope.paths], requestedBy: scope.requestedBy, detail: scope.reason }, `scope:${scope.epoch}:${scope.at}`);
  }

  const failing = work.gates.find(gate => !gate.passed);
  if (failing) {
    // Which of the gate's refusals this item acts on. A refusal that belongs to another item — an
    // unfinished dependency, a turn behind somebody else in the merge queue — answers this item
    // only while it is the *only* thing the gate says: a blocker recorded beside a dependency used
    // to disappear behind it until the dependency landed, which is this same silence in a smaller
    // room. So the first refusal that is this item's own is the one acted on, and a gate that says
    // nothing but deferred refusals is the wait it looks like.
    const deferred = (entry: string) => /^Dependency .+ is unfinished$/.test(entry) || !!queueSequencingReason(entry);
    const refusal = failing.reasons.find(entry => !deferred(entry)) ?? failing.reasons[0];
    // A gate that refuses without saying why is the defect in its purest form: nothing can be
    // computed from it, and before this it produced exactly no action and no word to anybody.
    if (refusal === undefined) return unaccounted(`the ${failing.name} gate refuses with no reason recorded, so nothing can be computed from it`, failing.name, null);
    // A live lease is a session already doing exactly what the build gate is waiting for. Naming
    // a dispatch here would offer the item to a second worker while the first still holds it.
    if (failing.name === 'build' && liveLease) return waits({ kind: 'session', on: work.lease!.owner,
      detail: `${work.lease!.owner} holds epoch ${work.lease!.epoch} until ${work.lease!.expiresAt} and is producing what the build gate waits for: ${refusal}` }, failing.name, refusal);
    // An unfinished dependency is the dependency's dispatch, not this item's; nothing waits here.
    const dependency = failing.name === 'ready' ? refusal.match(/^Dependency (.+) is unfinished$/) : null;
    if (dependency) return waits({ kind: 'dependency', on: dependency[1], detail: `${key} waits on ${dependency[1]}: ${refusal}` }, failing.name, refusal);
    const kind = refusalAction(work, failing.name, refusal, all, now);
    const binding = `${failing.name}:${work.policyRevision}:${short(work.candidate?.sha)}:${short(work.candidate?.baseSha)}:${refusal}`;
    if (kind === 'dispatch') {
      // A review refusal is a dispatch only while the head's mechanical proofs have not run (GY-115).
      if (failing.name === 'acceptance' || failing.name === 'review') {
        const proof = proofStep(work, all, now);
        // Every unproven proof is a manual one the operator holds: the control plane cannot
        // dispatch it, and saying so is an escalation rather than a dispatch nobody can run.
        if (!proof) return make('escalate', `${key} waits on proof no producer session may run: ${failing.reasons.join('; ')}`,
          { kind: 'escalate', trigger: 'operator-proof', detail: refusal }, binding, failing.name, refusal);
        // A failed proof holds the head at this gate for good: a unit or integration failure is the
        // worker's to fix on a new head, and a manual one is the operator's judgement to make.
        if (proof.step === 'failed') {
          const detail = proof.decision.reason;
          if (proof.decision.failed.every(entry => mechanicalProof(entry.proof))) return make('request-rework', `${key} needs a new head: ${detail}`,
            { kind: 'request-rework', pr: work.candidate?.pr ?? null, sha: work.candidate?.sha ?? null, detail }, binding, failing.name, refusal);
          return make('escalate', `${key} failed a proof no producer session may re-run on this head: ${detail}`,
            { kind: 'escalate', trigger: 'operator-proof', detail }, binding, failing.name, refusal);
        }
        if (proof.step === 'stopped') return make('escalate', `${key}: ${proof.detail}`,
          { kind: 'escalate', trigger: 'operator-proof', detail: proof.detail }, binding, failing.name, refusal);
        if (proof.step === 'wait') return waits({ kind: 'session', on: 'graphyard', detail: `${key}: ${proof.detail}` }, failing.name, refusal);
        const inputs = proof.inputs;
        return make('dispatch', `${key} needs ${inputs.kind === 'dispatch' && inputs.target === 'proof' ? inputs.proofs.join(', ') : refusal} on ${short(work.candidate?.sha)}`, inputs, binding, failing.name, refusal);
      }
      return make('dispatch', `${key} is ready and unassigned: ${refusal}`, dispatchInputs(work), `dispatch:${work.epoch}`, failing.name, refusal);
    }
    // A review refusal the reviewer's own reading already answered says "approval is required"
    // while the item is actually waiting for a new head or a base refresh; the reason and the
    // detail name what it is waiting for rather than the refusal that classified it.
    const standstill = failing.name === 'review' ? reviewStandstill(work, all, now) : null;
    const detail = standstill?.reason ?? refusal;
    if (kind === 'request-review') {
      // Nothing may be asked of a head the control plane has not observed as a live candidate;
      // reviewNeed reads that observation, so ineligibility is decided before it is consulted.
      const ineligible = dispatchIneligibility(work);
      if (ineligible) return make('resync', `${key} cannot be reviewed yet: ${ineligible}`, resyncInputs(work), binding, failing.name, refusal);
      const need = reviewNeed(work, all, now);
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
    if (kind === 'merge' && failing.reasons.every(entry => queueSequencingReason(entry))) {
      const ahead = refusal.match(/^Merge queue position \d+ of \d+: (\S+) is ahead$/);
      if (ahead) return waits({ kind: 'queue', on: ahead[1], detail: `${key} waits behind ${ahead[1]} in the merge queue: ${refusal}` }, failing.name, refusal);
    }
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
  if (work.candidate) return waits({ kind: 'settled', on: null, detail: `${key} merged as ${short(work.observation?.mergeSha)} and no gate refuses it; the delivery record follows on the next reading` });
  // Open, released, nothing refusing and no candidate: the gates have not been evaluated at all.
  // Every other path above named something, so there is no rule left to reach — the item would
  // simply sit here, which is precisely what must never happen quietly.
  return unaccounted(`${key} is open with no gate refusing it and no candidate to merge: its gates (${work.gates.length}) name nothing to do and nothing to wait for`);
}

