import { carriedBindings, deliveryState, isClosed, type Gate, type Work } from '../src/model';
import { defaultMergeBatchSize, latestCheck, tipValidationPrefix } from '../src/merge-queue';
import { leftFlowAt, noRelease, servedFor, type ReleaseView } from './release';
import type { PipelineTimeline } from '../src/pipeline-speed';
import { assignment } from './assignment';
import { statusDuration, type StatusDuration } from './duration';
import type { StepTransition } from './flow-replay';
import { plainReason, statusSince } from './plain-status';

/**
 * The seven pull-request steps every moving item shows (GY-161): Build, Validate, Test, Review,
 * Prove, Merge, Deploy. Each step after Build reads one gate the control plane evaluates
 * (ready, build, review, test, acceptance, merge): Validate is the build gate once the work is
 * handed in, Test the CI checks, Review the approval, Prove the acceptance criteria and Merge the
 * merge gate; Deploy is the delivery after the merge. A step whose gate passed is done, the first
 * step (in the order a pull request travels) whose gate refuses is current, and the rest are
 * pending. The dashboard adds nothing the gates do not say; it only names the step in plain words
 * and says what it waits on and who acts next — as a role, never a worker's code name.
 */
export const stepIds = ['build', 'validate', 'test', 'review', 'prove', 'merge', 'deploy'] as const;
export type StepId = typeof stepIds[number];
export type StepState = 'done' | 'current' | 'pending';
export const stepLabel: Record<StepId, string> = { build: 'Build', validate: 'Validate', test: 'Test', review: 'Review', prove: 'Prove', merge: 'Merge', deploy: 'Deploy' };
/** The verb the live label starts with: "Testing · 3 of 5 checks done". */
export const stepVerb: Record<StepId, string> = { build: 'Building', validate: 'Validating', test: 'Testing', review: 'Reviewing', prove: 'Proving', merge: 'Merging', deploy: 'Deploying' };
/** The gate each step after Build reads. */
export const stepGate: Partial<Record<StepId, string>> = { validate: 'build', test: 'test', review: 'review', prove: 'acceptance', merge: 'merge' };
/** The control plane's gate evaluation order (src/model evaluate). */
export const gateOrder = ['ready', 'build', 'review', 'test', 'acceptance', 'merge'] as const;

/**
 * `carried` is set on a done Review or Prove step whose verdict the item holds by carry across a
 * Graphyard-authored merge rather than by a fresh one on this commit (GY-330): the ground the carry
 * rested on, such as `diff unchanged (patch-id 1a2b3c4d5e6f)`. The step's label says "carried" too,
 * so it never reads as a step that just passed ahead of the current one.
 */
export interface PrStep { id: StepId; label: string; state: StepState; carried?: string }
export interface PrSteps {
  steps: PrStep[];
  /** The current step, or null once the release serves it. */
  current: StepId | null;
  /** The current step in plain words, naming what it waits on: "Testing · 1 of 2 checks done". */
  label: string;
  /** What the current step waits on, without the verb. */
  detail: string;
  /** Who acts next, as a role, never a code name. */
  who: string;
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const pendingCheck = new Set(['', 'pending', 'queued', 'in_progress', 'waiting', 'requested', 'expected']);

/** True while the review gate refuses on a reviewer's request for changes. */
export const changesRequested = (work: Work) => !!work.gates.find(gate => gate.name === 'review')?.reasons.some(reason => reason.startsWith('Outstanding change requests'));

export type CheckState = 'passed' | 'failed' | 'running';
/**
 * Each required CI check as the test gate reads it. The gate's own reasons decide which checks
 * have not passed: a check it does not name has passed, and no run from another App with the same
 * name can make a named one read passed. A named check reads failed only on evidence that a
 * trusted CI App (status `ciAppIds`, the Apps the gate counts) failed it: the latest run of it
 * across every trusted App, the one run the test gate reads (src/model/gates.ts `latestCheck`),
 * finished without succeeding. An untrusted App's failure, no trusted run at all, or not being
 * told which Apps are trusted leaves it running — the gate says only that the trusted check has
 * not passed. A re-run replaces an old failure or success, whichever App ran it. The Test step
 * and the item page's Checks line both read this.
 */
export function checkStates(work: Work, ciAppIds: readonly number[] | null = null): { name: string; state: CheckState }[] {
  const gate = work.gates.find(entry => entry.name === 'test');
  // A queued entry's CI on its own speculative tip is refused by the merge gate instead (GY-292,
  // `tipValidation`), with the test gate's own wording after the queue's prefix.
  const reasons = [...gate?.reasons ?? [], ...tipChecks(work)];
  const named = (name: string) => !gate || reasons.includes(`Required CI check ${name} has not passed on the current candidate`);
  return (work.policy.checks ?? []).map(name => {
    if (!named(name)) return { name, state: 'passed' };
    const runs = (work.observation?.checks ?? []).filter(check => check.name === name && !!ciAppIds?.includes(check.appId));
    const latest = latestCheck(runs)?.result;
    return { name, state: latest !== undefined && !pendingCheck.has(latest) && latest !== 'success' ? 'failed' : 'running' };
  });
}

/** The test-gate refusals the merge gate carries while the queue validates the entry's speculative tip (GY-292). */
function tipChecks(work: Work): string[] {
  const reasons = work.gates.find(entry => entry.name === 'merge')?.reasons ?? [];
  return reasons.filter(reason => reason.startsWith(tipValidationPrefix)).map(reason => reason.slice(reason.indexOf(': ') + 2));
}

/** A release view that may also carry the master's `mergeQueue.batchSize`; without it the default applies. */
export type MergeBatchRelease = ReleaseView & { mergeBatchSize?: number };
/**
 * The batch a queued entry is validated in, from its own speculative tip (GY-330): the tip is built
 * behind every validated entry ahead of it, so its place in that chain gives its batch, and the
 * entries ahead of it in the same batch are the members its combined tip already holds. Null for
 * the first member of a batch, whose tip holds no other member yet.
 */
export function batchedWith(work: Work, batchSize: number): { number: number; ahead: string[] } | null {
  const ahead = work.queue?.speculation?.tip === work.candidate?.sha ? work.queue?.speculation?.predecessors ?? [] : [];
  const size = Math.max(1, Math.floor(batchSize)), start = Math.floor(ahead.length / size) * size;
  return start < ahead.length ? { number: start / size + 1, ahead: ahead.slice(start) } : null;
}

/** The review refusal no reviewer can answer: every configured reviewer profile is exhausted. */
const reviewersExhausted = /^Every configured reviewer profile is exhausted/;
/**
 * Merge refusals only the master agent clears — unverified branch protection, a standing
 * escalation, a slice lead's hold — and those a new head from the builder clears: a conflict with
 * the base, unresolved review threads, an ejection from the queue. The same refusals
 * src/model/refusal-mapping.ts maps to `escalate` and `request-rework`.
 */
const mergeMasterClears = /branch protection have not been verified$|^Unresolved \S+ escalation requires operator resolution|^Slice lead \S+ ruled /;
const mergeBuilderClears = /^Pull request is not mergeable against the current base$|^Branch protection requires conversation resolution and \d+ review threads? (is|are) unresolved|^Ejected from the merge queue:/;

/** What the current step waits on, and who acts next, in plain words. */
export function waitsOn(step: StepId, gate: Gate | undefined, work: Work, now: number, release: ReleaseView): { detail: string; who: string } {
  const reasons = gate?.reasons ?? [];
  switch (step) {
    case 'build': {
      // Handed in, but the ready gate refuses (a recorded blocker, or a dependency a requirements
      // revision added): the control plane holds it at build, so it waits there on that, not on a builder.
      const ready = work.submission ? work.gates.find(gate => gate.name === 'ready' && !gate.passed)?.reasons[0] : undefined;
      if (ready !== undefined) {
        // A dependency waits for the other item to ship; a blocker is shown as written, for the Master agent to clear.
        if (/^Dependency /.test(ready)) return { detail: plainReason(ready, 'ready').text.replace(/^./, c => c.toLowerCase()), who: 'Graphyard (automatic)' };
        return { detail: `blocked: ${ready}`, who: 'Master agent' };
      }
      if (work.reworkRequested || changesRequested(work)) return assignment(work, now).active ? { detail: 'the builder is making the requested changes', who: 'Builder agent' } : { detail: 'sent back for changes, waiting for a builder', who: 'Graphyard (assigns a builder)' };
      return assignment(work, now).active ? { detail: 'the builder is writing the code', who: 'Builder agent' } : { detail: 'waiting for a builder', who: 'Graphyard (assigns a builder)' };
    }
    case 'validate': {
      const first = reasons[0] ?? '';
      if (/^(Candidate changes \d+ files? outside|Out-of-scope regression)/.test(first)) return { detail: 'it changes files outside its plan', who: 'Builder agent' };
      if (/^No workspace registered$/.test(first)) return { detail: 'waiting for the builder to say where the code lives', who: 'Builder agent' };
      if (/^Pull request has not been independently observed$/.test(first)) return { detail: 'waiting to see the pull request on GitHub', who: 'Graphyard (automatic)' };
      return { detail: 'checking which files it changes', who: 'Graphyard (automatic)' };
    }
    case 'test': {
      const checks = checkStates(work, release.ciAppIds);
      const failed = checks.filter(check => check.state === 'failed').map(check => check.name);
      if (failed.length) return { detail: `the check ${failed.join(', ')} failed`, who: 'Builder agent' };
      return { detail: `${checks.filter(check => check.state === 'passed').length} of ${checks.length} checks done`, who: 'Automated checks' };
    }
    case 'review':
      // Every reviewer profile exhausted: no reviewer can act, and adding capacity or changing the
      // provider is the master agent's decision (src/model/refusal-mapping.ts escalates it).
      if (reasons.some(reason => reviewersExhausted.test(reason))) return { detail: 'no reviewer is available', who: 'Master agent' };
      // The gate says "approval is required" even while no reviewer can be asked about this head
      // (src/model/refusal-mapping.ts `reviewStandstill`); the action the control plane computed
      // from that standstill names who actually moves it.
      switch (work.nextAction?.gate === 'review' ? work.nextAction.kind : null) {
        case 'dispatch': return { detail: 'the proofs run before the review', who: 'Prover agent' };
        case 'resync': return { detail: 'waiting for a fresh reading of the pull request before the review', who: 'Graphyard (automatic)' };
        case 'escalate': return { detail: 'no reviewer can be asked about this head', who: 'Master agent' };
        case 'request-rework': return { detail: 'this head needs a new commit before the review', who: 'Builder agent' };
      }
      return { detail: 'waiting for the reviewer', who: 'Reviewer agent' };
    case 'prove': {
      // Every proof the acceptance gate demands: the item's own and the obligations it inherits from
      // another change's deferred proof. A proof the gate still refuses — unproven, inherited and
      // unproven, or no longer independent — is open, so the count never reads complete while it refuses.
      const own = work.criteria.filter(c => !c.bootstrap).flatMap(c => c.proofs);
      const refused = reasons.map(reason => reason.match(/^(?:AC-\d+|Bootstrap obligation inherited from \S+ \S+): (\S+) needs /)?.[1] ?? reason.match(/^Trusted (\S+) evidence from /)?.[1]);
      const open = new Set(refused.filter((proof): proof is string => !!proof));
      const total = new Set([...own, ...open]).size;
      if (!total) return { detail: 'waiting for proof', who: 'Prover agent' };
      if (!open.size && reasons.length) return { detail: 'checking the proofs', who: 'Prover agent' };
      return { detail: `${total - open.size} of ${total} proofs passed`, who: 'Prover agent' };
    }
    case 'merge': {
      // Who clears a merge refusal is decided by the refusal itself, as the control plane's
      // classification decides it: administration and decisions are the master agent's, a new head
      // is the builder's, and the queue's own work is automatic. A queue position is reported
      // beside those refusals (src/model/gates.ts), so they are read first: waiting a turn in line
      // is automatic only when nothing else holds the merge.
      const master = reasons.find(reason => mergeMasterClears.test(reason));
      if (master) return { detail: plainReason(master, 'merge').text.replace(/^./, c => c.toLowerCase()), who: 'Master agent' };
      const builder = reasons.find(reason => mergeBuilderClears.test(reason));
      if (builder) return { detail: plainReason(builder, 'merge').text.replace(/^./, c => c.toLowerCase()), who: 'Builder agent' };
      // CI on the entry's own speculative tip: the merge step validating the combined result,
      // shown here as a substate of Merge, never as a return to Test (GY-292).
      // A batched entry names the members ahead of it in its batch, whose combination its tip holds (GY-330).
      if (tipChecks(work).length) {
        const checks = checkStates(work, release.ciAppIds);
        const batch = batchedWith(work, (release as MergeBatchRelease).mergeBatchSize ?? defaultMergeBatchSize);
        return { detail: `validating the combined tip${batch ? ` of batch ${batch.number} with ${batch.ahead.join(', ')}` : ''} · ${checks.filter(check => check.state === 'passed').length} of ${checks.length} checks done`, who: 'Automated checks' };
      }
      const queued = reasons.map(reason => reason.match(/^Merge queue position (\d+) of \d+: (\S+) is ahead$/)).find(Boolean);
      if (queued) return { detail: `${ordinal(Number(queued[1]))} in line, after ${queued[2]}`, who: 'Graphyard (automatic)' };
      const stuck = reasons.map(reason => plainReason(reason, 'merge')).find(plain => plain.stuck);
      return stuck ? { detail: stuck.text.replace(/^./, c => c.toLowerCase()), who: 'Builder agent' } : { detail: 'Graphyard is merging it', who: 'Graphyard (automatic)' };
    }
    case 'deploy': {
      const state = deliveryState(work);
      return state === 'delivered-with-failure' ? { detail: 'the check after deploying failed', who: 'Master agent' }
        : release.failed.has(work.key) ? { detail: 'production has not deployed it', who: 'Master agent' }
        : state === 'awaiting-smoke' ? { detail: 'checking the live release', who: 'Prover agent' }
          : { detail: 'waiting for the live release to serve it', who: 'Graphyard (automatic)' };
    }
  }
}

/**
 * The seven steps for one item. Before the work is handed in only Build can be current. After
 * it, each step's own gate decides done, and the first step whose gate refuses is current; when
 * every gate passes the item is merging. A merged item has every step done — reading "Live" where
 * production was observed serving it — unless its policy asks for a post-deployment check that has
 * not passed, or the production watch observes production not serving it yet (web/release.ts),
 * which keeps it at Deploy. Work closed without merging has no step at all.
 */
export function prSteps(work: Work, now: number, release: ReleaseView = noRelease): PrSteps {
  const make = (state: (id: StepId) => StepState, current: StepId | null, detail: string, who: string): PrSteps => ({
    steps: stepIds.map(id => ({ id, label: stepLabel[id], state: state(id) })), current,
    label: current ? `${stepVerb[current]} · ${detail}` : detail, detail, who,
  });
  // Closed without merging (src/model/closure.ts): no step is done or current, and nobody acts.
  if (isClosed(work)) return make(() => 'pending', null, `Closed as ${work.closure!.kind}, not merged`, 'Nobody — it was closed');
  if (work.stage === 'done') {
    // Delivered once merged, unless a post-deployment check or the production watch holds it at
    // Deploy (web/groups.ts reads the same `leftFlowAt`). "Live" only once the release is observed serving it.
    if (!work.delivery || leftFlowAt(work, release)) return servedFor(work, release) ? make(() => 'done', null, 'Live', 'Nobody — it is live')
      : make(() => 'done', null, 'Merged', 'Nobody — it has merged');
    const { detail, who } = waitsOn('deploy', undefined, work, now, release);
    return make(id => id === 'deploy' ? 'current' : 'done', 'deploy', detail, who);
  }
  // A change request sends the work back to its builder, so it waits at Build, not at Review; and
  // a refusing ready gate keeps handed-in work at build, as the control plane's stage does (src/model/gates.ts).
  const readyRefused = work.gates.some(gate => gate.name === 'ready' && !gate.passed);
  const handedIn = !!work.submission && !work.reworkRequested && !changesRequested(work) && !readyRefused;
  if (!handedIn) {
    const { detail, who } = waitsOn('build', undefined, work, now, release);
    return make(id => id === 'build' ? 'current' : 'pending', 'build', detail, who);
  }
  const byName = new Map(work.gates.map(gate => [gate.name, gate]));
  // A gate the item does not carry has nothing to refuse, so its step reads done.
  const passed = (id: StepId) => id === 'build' || (id !== 'merge' && id !== 'deploy' && byName.get(stepGate[id]!)?.passed !== false);
  const current = stepIds.find(id => id !== 'deploy' && !passed(id)) ?? 'merge';
  const { detail, who } = waitsOn(current, stepGate[current] ? byName.get(stepGate[current]!) : undefined, work, now, release);
  const steps = make(id => id === current ? 'current' : passed(id) ? 'done' : 'pending', current, detail, who);
  // A Review or Prove step passed by carry reads as carried, with its ground (GY-330).
  const carried = carriedBindings(work, [work], new Date(now));
  const marks: Partial<Record<StepId, string>> = {
    ...(carried.review ? { review: carried.review.ground ?? carried.review.reason } : {}),
    ...(carried.proofs.length ? { prove: [...new Set(carried.proofs.map(entry => entry.ground ?? entry.reason))].join('; ') } : {}),
  };
  return { ...steps, steps: steps.steps.map(step => step.state === 'done' && marks[step.id] ? { ...step, label: `${step.label} · carried`, carried: marks[step.id] } : step) };
}

/**
 * When the item entered the step `prSteps` shows it at: the Work row's "In step" clock and the
 * item page's. The recorded step moves say it exactly — the same moves (`stepMoves`) the Insights
 * replay plays, read through the steps drill-down — so the clock starts at this item's latest
 * recorded move when that move put it at the step it is at now. Before the moves are read, or
 * while the record is a moment behind the gates, the item's own record gives the step's start:
 * Build keeps the builder's clock (`statusSince`: the claim, or the send-back, which is when
 * Build restarted), Validate starts at the hand-in, Deploy at the merge, and a later step at the
 * latest move the item recorded (`statusSince`).
 */
export function stepSince(work: Work, now: number, moves?: readonly StepTransition[] | null, release: ReleaseView = noRelease): string {
  const current = prSteps(work, now, release).current;
  const own = statusSince(work, now);
  if (!current || current === 'build') return own;
  const at = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now ? Date.parse(value) : null;
  const latest = (moves ?? []).filter(move => move.key === work.key && at(move.at) !== null).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
  if (latest?.to === current) return latest.at;
  if (current === 'deploy') return work.delivery?.mergedAt ?? work.observation?.mergedAt ?? own;
  if (current === 'validate') {
    const pipeline = (work as Work & { pipeline?: PipelineTimeline }).pipeline;
    const handedIn = at(pipeline?.resubmittedAt ?? pipeline?.submittedAt);
    if (handedIn !== null) return new Date(handedIn).toISOString();
  }
  return own;
}

/**
 * How long the item has held its current step, and whether that is past the one threshold
 * (web/duration.ts). Only work that has left the flow (no current step, `leftFlowAt`) has arrived
 * and is never overdue; merged work still held at Deploy keeps a running clock.
 */
export function stepHeld(work: Work, now: number, moves?: readonly StepTransition[] | null, release: ReleaseView = noRelease): StatusDuration {
  return statusDuration(stepSince(work, now, moves, release), now, prSteps(work, now, release).current === null);
}
