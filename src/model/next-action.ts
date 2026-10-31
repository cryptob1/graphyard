import { dispatchIneligibility, reviewNeed } from './dispatch.js';
import { leadHoldRefusal } from './delegation.js';
import { mergeWriterPushPattern, mergeWriterRefusal, mergeWriterTrialPattern } from './gates.js';
import { attestationWait } from './unproduced-attestation.js';
import { humanProofWaiting } from './human-proof.js';
import { proofStep } from './action-proof-step.js';
import { loopObservation, loopObservationProofs, observationWindowHold, type Work } from './work.js';
import { observationPass } from './loop-observation.js';
import { nextActionLlmRoles, type NextAction, type NextActionInputs, type NextActionKind } from './action-kinds.js';
import type { ActionAccount, ActionWait } from './action-account.js';
import { carriedAction, type OpenAction } from './concerns.js';
import { livenessCarry } from './liveness.js';
import { baseBreakWait } from '../master/base-break-refresh.js';

// The vocabulary lives in `action-kinds.ts` and the accounting vocabulary in
// `action-account.ts`; each is re-exported here so what an item needs next is still read from
// one place. `action-account.ts` is the one exception: it imports the computation below, so it
// is imported from directly rather than re-exported through the module it depends on.
export { actionJudgment, executorRunnableKinds, llmRoles, mechanicalActionKinds, nextActionKinds, nextActionLlmRoles } from './action-kinds.js';
export type { LlmRole, NextAction, NextActionInputs, NextActionKind } from './action-kinds.js';
// What stands beside an action lives in `concerns.ts`, re-exported here likewise.
export { carriedAction, dispatchHold, humanNeeded, humanNeededActions, openAction } from './concerns.js';
export type { HumanNeeded, HumanNeededRow, OpenAction } from './concerns.js';

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
 *   `attention`. `refusalAction` is that mapping, and nothing else classifies a refusal. A
 *   refusal nobody thought about becomes an escalation rather than silence.
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

const dispatchInputs = (work: Work): NextActionInputs => ({ kind: 'dispatch', target: 'implementation', epoch: work.epoch, priority: work.priority });

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
  return actionAccount(work, all, now).action;
}

/**
 * What this item needs next, or why it needs nothing — with the failing gate it answers and how
 * long the item has held it.
 *
 * The order is the order a delivery actually unblocks in: a typed request an agent left behind
 * first, because a session gave up its lease waiting for that answer; then a delivered item, which
 * owes nothing; then an assignment nobody holds any more; then the first refusing gate; and finally the merge a fully proven candidate
 * is authorized for. `carriedAction` (concerns.ts) names who owes an action no executor may run.
 */
export function actionAccount(work: Work, all: Work[], now: Date): ActionAccount {
  const heldSince = work.stageEnteredAt ?? work.updatedAt ?? now.toISOString();
  const held = Date.parse(heldSince);
  // The liveness rules (liveness.ts) apply to what was computed before any concern is carried.
  const computed = livenessCarry(work, computeAccount(work, all, now), all, now);
  const action = carriedAction(computed.action);
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
  // (to `attention`); the item simply raises none until it is released.
  if (!work.ready) return waits({ kind: 'human', on: 'operator', detail: `${key} has not been released from the backlog; releasing it is a goals-and-priorities decision, which is the operator's` },
    'ready', 'Not released from backlog');

  if (work.stage === 'done' && work.closure) return waits({ kind: 'settled', on: null, detail: `${key} was closed as ${work.closure.kind}${work.closure.ref ? ` (${work.closure.ref})` : ''} by ${work.closure.by}: ${work.closure.reason}` });
  // Done = merged (GY-1981): a delivery owes nothing more, whatever its smoke policy or deployment record.
  if (work.stage === 'done') return waits({ kind: 'settled', on: null, detail: `${key} is delivered; its gates are history and no gate refuses it` });

  const liveLease = !!work.lease && Date.parse(work.lease.expiresAt) > now.getTime();
  // An assignment whose lease has lapsed without a submission is held by a session that cannot
  // act. Reclaiming it is mechanical: the reconciliation the control
  // plane already runs clears the lapse, and the executor only asks for it.
  if (!liveLease && work.lease && !work.submission) {
    const lease = work.lease;
    return make('reclaim', `${key} is held by ${lease.owner} under epoch ${lease.epoch}, whose lease expired at ${lease.expiresAt} with nothing submitted`,
      { kind: 'reclaim', epoch: lease.epoch, owner: lease.owner, leaseExpiresAt: lease.expiresAt }, `lease:${lease.epoch}:${lease.expiresAt}`);
  }

  const first = work.gates.find(gate => !gate.passed);
  // GY-1606: a failed required check owes a new head that no review judgement can withdraw or refuse, so it is the rework named
  // over a review change request owing one too: on GY-1598 the review gate named a capped review rework its approver had refused,
  // and the master was asked to answer that refusal by hand while the failed-check rework the loop owed went unnamed.
  const failedCheck = first?.name === 'review' && first.reasons.length && refusalAction(work, first.name, first.reasons[0], all, now) === 'request-rework'
    ? work.gates.find(gate => gate.name === 'test' && !gate.passed && gate.reasons.some(reason => refusalAction(work, 'test', reason, all, now) === 'request-rework')) : undefined;
  const failing = failedCheck ? { ...failedCheck, reasons: failedCheck.reasons.filter(reason => refusalAction(work, 'test', reason, all, now) === 'request-rework') } : first;
  if (failing) {
    // Which of the gate's refusals this item acts on. A refusal that belongs to another item — an
    // unfinished dependency — answers this item
    // only while it is the *only* thing the gate says: a blocker recorded beside a dependency used
    // to disappear behind it until the dependency landed, which is this same silence in a smaller
    // room. So the first refusal that is this item's own is the one acted on, and a gate that says
    // nothing but deferred refusals is the wait it looks like.
    const deferred = (entry: string) => /^Dependency .+ is unfinished$/.test(entry);
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
    // GY-2010: the merge writer trials and pushes every candidate it admits, so a refusal it alone
    // answers is a wait on it, never a row an executor claims or an escalation.
    if (mergeWriterRefusal(failing.name, refusal)) return waits({ kind: 'session', on: 'merge-writer', detail: `${key} is queued for the merge writer, which trials and pushes it: ${refusal}` }, failing.name, refusal);
    if (failing.name === 'review' && humanProofWaiting(refusal)) return waits({ kind: 'human', on: 'operator', detail: `${key} waits for a person's real-world check on Needs you: ${refusal}` }, failing.name, refusal);
    const kind = refusalAction(work, failing.name, refusal, all, now);
    const binding = `${failing.name}:${work.policyRevision}:${short(work.candidate?.sha)}:${short(work.candidate?.baseSha)}:${refusal}`;
    if (kind === 'dispatch') {
      // A review refusal is a dispatch only while the head's mechanical proofs have not run (GY-115).
      if (failing.name === 'acceptance' || failing.name === 'review') {
        const proof = proofStep(work, all, now);
        // Every unproven proof is manual: the master's attestation (GY-521), else an escalate action.
        const attest = proof ? null : attestationWait(work, all, now); if (attest) return waits(attest, failing.name, refusal);
        if (!proof) return make('attention', `${key} waits on proof no producer session may run: ${failing.reasons.join('; ')}`, { kind: 'attention', trigger: 'operator-proof', detail: refusal }, binding, failing.name, refusal);
        // A failed proof holds the head at this gate for good: a unit or integration failure is the
        // worker's to fix on a new head, and a manual one is the operator's judgement to make.
        if (proof.step === 'failed') {
          const detail = proof.detail;
          if (proof.mechanical) return make('request-rework', `${key} needs a new head: ${detail}`,
            { kind: 'request-rework', pr: work.candidate?.pr ?? null, sha: work.candidate?.sha ?? null, detail }, binding, failing.name, refusal);
          return make('attention', `${key} failed a proof no producer session may re-run on this head: ${detail}`,
            { kind: 'attention', trigger: 'operator-proof', detail }, binding, failing.name, refusal);
        }
        if (proof.step === 'stopped') return make('attention', `${key}: ${proof.detail}`,
          { kind: 'attention', trigger: 'operator-proof', detail: proof.detail }, binding, failing.name, refusal);
        if (proof.step === 'wait') return waits({ kind: 'session', on: 'graphyard', detail: `${key}: ${proof.detail}` }, failing.name, refusal);
        const inputs = proof.inputs;
        return make('dispatch', `${key} needs ${inputs.kind === 'dispatch' && inputs.target === 'proof' ? inputs.proofs.join(', ') : refusal} on ${short(work.candidate?.sha)}`, inputs, binding, failing.name, refusal);
      }
      // GY-1698: a released follow-up whose reading cannot exist yet is not offered to a worker; the
      // wait is due at the recorded instant, and this same computation names the dispatch past it.
      const window = observationWindowHold(work, now);
      // A loop-owned observation item names its own wait below: it is never dispatched, at the instant or after.
      if (window && !loopObservationProofs(work)) return waits({ kind: 'window', on: null, detail: `${key} waits for its observation window: the reading it owes can first exist at ${window.notBefore} (${window.detail}); the loop dispatches it then` }, failing.name, refusal);
      // GY-1762: nothing a code worker can do; the loop's own reading ends the wait. GY-1779: due or
      // not, the wait is on the loop, whose deployment-verification step records the reading; it is
      // never an operator-proof escalation, and an unsubmitted worker candidate left on the item
      // (GY-1725) changes nothing: the loop's reading supersedes it.
      const observing = loopObservation(work, now, all);
      if (observing) return waits({ kind: 'window', on: 'loop', detail: `${key} waits for ${observing.waitingFor}; the loop records it${observing.due ? ' in its deployment-verification step' : ' once it can exist'}, and no worker is dispatched` }, failing.name, refusal);
      // The passing reading is recorded (by the loop, or by hand) and the item is still open: the same
      // step closes it on that reading's release, so the wait stays on the loop — never an operator-proof escalation.
      const pass = loopObservationProofs(work) ? observationPass(work, now, all) : null;
      if (pass) return waits({ kind: 'window', on: 'loop', detail: `${key}'s reading of ${pass.readings.map(entry => entry.proof).join(', ')} passed on release ${short(pass.release)} and the item is still open; the loop closes it as delivered-observation in its deployment-verification step, and no worker is dispatched` }, failing.name, refusal);
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
      if (!need.needed) return make('attention', `${key} cannot be reviewed and no executor step answers it: ${need.reason}`,
        { kind: 'attention', trigger: failing.name, detail: need.reason }, binding, failing.name, refusal);
      const request = work.autoDispatch?.review ?? null;
      return make('request-review', `${key}: ${need.reason}`,
        { kind: 'request-review', provider: work.policy.reviewProvider ?? 'github', requestId: request?.id ?? null, pr: work.candidate!.pr, sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: work.policyRevision },
        binding, failing.name, refusal);
    }
    if (kind === 'request-rework') { const broken = baseBreakWait(work, failing.name); if (broken) return waits(broken, failing.name, refusal); } // GY-793: refreshed onto the tip that fixed it, never reworked
    if (kind === 'request-rework') return make('request-rework', `${key} needs a new head: ${detail}`,
      { kind: 'request-rework', pr: work.candidate?.pr ?? null, sha: work.candidate?.sha ?? null, detail }, binding, failing.name, refusal);
    if (kind === 'resync') return make('resync', `${key} is waiting on a fresh reading of its pull request: ${detail}`, resyncInputs(work), binding, failing.name, refusal);
    if (kind === 'merge') return make('merge', `${key} is queued to merge: ${refusal}`,
      { kind: 'merge', pr: work.candidate!.pr, sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: work.policyRevision }, binding, failing.name, refusal);
    // `detail` again rather than the refusal: a review refusal standing over a spent reviewer
    // roster says "a review is required", and what the operator has to decide is the roster.
    return make('attention', `${key} is refused at the ${failing.name} gate and no executor step answers it: ${detail}`,
      { kind: 'attention', trigger: failing.name, detail }, binding, failing.name, refusal);
  }

  if (work.violations.length) return make('attention', `${key} carries ${work.violations.length} violation(s): ${work.violations[0]}`,
    { kind: 'attention', trigger: 'violation', detail: work.violations[0] }, `violation:${work.violations[0]}`);
  // Every gate passed: the merge writer pushed and reconciled the head (GY-2010), and its
  // reconciled record delivers the item; nothing is left for an executor.
  if (work.candidate) return waits({ kind: 'settled', on: null, detail: `${key} has passed every gate on ${short(work.candidate.sha)}; the merge writer merged it${work.mergeLedger?.mergeSha ? ` as ${short(work.mergeLedger.mergeSha)}` : ''} and its delivery record follows` });
  // Open, released, nothing refusing and no candidate: the gates have not been evaluated at all.
  // Every other path above named something, so there is no rule left to reach — the item would
  // simply sit here, which is precisely what must never happen quietly.
  return unaccounted(`${key} is open with no gate refusing it and no candidate to merge: its gates (${work.gates.length}) name nothing to do and nothing to wait for`);
}

/**
 * Every refusal maps to exactly one action kind. The rules are ordered and the first match wins,
 * so the mapping is a function; the last rule matches everything, so it is total. A refusal that
 * matches no earlier rule is an escalation by construction — the control plane never drops one on
 * the floor because nobody wrote a rule for it.
 */
const refusalRules: { gate: string | null; match: RegExp; kind: NextActionKind }[] = [
  // ready
  { gate: 'ready', match: /^Not released from backlog$/, kind: 'attention' },
  // An unfinished dependency is answered by dispatching that dependency, not by anything on this item.
  { gate: 'ready', match: /^Dependency .+ is unfinished$/, kind: 'dispatch' },
  // build
  { gate: 'build', match: /^Worker has not submitted implementation for this attempt$/, kind: 'dispatch' },
  { gate: 'build', match: /^No workspace registered$/, kind: 'dispatch' },
  { gate: 'build', match: /^Pull request has not been independently observed$/, kind: 'resync' },
  // A mechanical proof that failed on the head returns it to its worker before review (GY-115).
  { gate: 'build', match: /the head returns to its worker before review$/, kind: 'request-rework' },
  // The same judgment passed on the commit the candidate would actually land on: the base has
  // gained work this head would revert. Only a new head answers it, exactly as for the diff
  // against the bound base — without this rule the refusal fell through to the catch-all and
  // said "no executor step answers it" about the one thing rework is for.
  // A base the control plane cannot merge in cleanly is the worker's to resolve, on a fresh head:
  // the refusal itself says to run `graphyard sync`, resolve it and push, and that approval and
  // proofs do not survive the resolution. Re-reading the pull request cannot produce that head, so
  // a conflict is rework — the one kind that says a judgment owes this item a new commit.
  { gate: 'build', match: /conflict/i, kind: 'request-rework' },
  // review
  { gate: 'review', match: /^Outstanding change requests/, kind: 'request-rework' },
  // A product review's change request reworks exactly as a code review's does; its reject is a
  // judgment no executor runs — the master closes the item unmerged or files a reshaped one
  // (GY-2989) — and its missing review is asked for like any other.
  { gate: 'review', match: /^Product review requested changes/, kind: 'request-rework' },
  { gate: 'review', match: /^Product review rejected/, kind: 'attention' },
  { gate: 'review', match: /^human:\S+ failed a person's check/, kind: 'request-rework' },
  // An approval whose mechanical nits await the worker bot's round (GY-971): that round is a rework.
  { gate: 'review', match: /^Approval (\d+ )?of [0-9a-f]+ names \d+ findings? classified mechanical/, kind: 'request-rework' },
  { gate: 'review', match: /.*/, kind: 'request-review' },
  // test and merge: the merge writer trials and pushes the head itself (GY-2010); its own merge step
  // answers both. No remote check, mergeability or protection refuses a gate any more.
  { gate: 'test', match: mergeWriterTrialPattern, kind: 'merge' },
  { gate: 'test', match: /^The merge writer has not observed the current candidate$/, kind: 'resync' },
  { gate: 'merge', match: mergeWriterPushPattern, kind: 'merge' },
  // merge
  // Nothing gates the merge on the observation's age (GY-1235): only a reading of the current head.
  { gate: 'merge', match: /^The merge writer has not observed the current candidate$/, kind: 'resync' },
  { gate: null, match: /.*/, kind: 'attention' },
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
    // Changes requested on this exact head — as a reviewer session's verdict, or as the verdict an agent
    // reviewer records — means the item needs a new commit, which is a judgment's to make.
    case 'changes-requested': return { kind: 'request-rework', reason: need.reason };
    // A head that does not contain the base tip is answered by a fresh reading and base refresh.
    case 'base-not-contained': return { kind: 'resync', reason: need.reason };
    // The control plane dispatches this provider's review itself: the fresh reading that wakes its
    // observation job is both how the request is posted and how the verdict arrives.
    case 'provider-dispatched': return { kind: 'resync', reason: need.reason };
    // Nobody is left to ask. An executor cannot add reviewer capacity or change the provider.
    case 'provider-exhausted': return { kind: 'attention', reason: need.reason };
    // `required` is the one state a launched reviewer answers, and the three remaining states
    // raise no review refusal at all: without a review the policy requires, an approval or a
    // carried approval, the gate passes (or refuses only its outstanding change requests).
    case 'required': case 'not-required': case 'approved': case 'carried': return null;
  }
}

/**
 * The single action kind a refusal maps to. `work` decides the cases the refusal text cannot: a
 * pull-request-era CI refusal, a merge-gate refusal raised by a lead hold rather than by the merge writer,
 * and a review refusal standing over a head no review can be asked for (`reviewStandstill`).
 */
export function refusalAction(work: Work, gate: string, refusal: string, all: Work[] = [work], now = new Date()): NextActionKind {
  if (gate === 'review') {
    const standstill = reviewStandstill(work, all, now);
    if (standstill) return standstill.kind;
  }
  if (gate === 'merge') {
    if (leadHoldRefusal(work) === refusal) return 'attention';
  }
  const rule = refusalRules.find(candidate => (candidate.gate === null || candidate.gate === gate) && candidate.match.test(refusal));
  return rule!.kind;
}
