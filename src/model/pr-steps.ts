import { isClosed, type Gate, type Work } from '../model.js';
import { noRelease, servedFor, type ReleaseView } from './release.js';
import type { PipelineTimeline } from '../pipeline-speed.js';
import { assignment } from './assignment.js';
import { ciCheckRefusalPattern, mergeWriterTrialPattern } from './gates.js';
import { statusDuration, type StatusDuration } from './duration.js';
import { plainReason, statusSince } from './plain-status.js';
import { noServe, plainStage, type ServeView } from './plain-stage.js';

/**
 * The four item states the dashboard draws (GY-1979): Todo (not started — no lease and nothing
 * handed in), Doing (a worker holds it and has not handed in), Checking (handed in — the validate,
 * test, review, proof and merge gates folded into one step whose label names what it waits on) and
 * Done (merged). The board lists Todo, Doing and Checking; a merged item is Done, off the board,
 * and the release line on the top bar carries the deployment instead of a per-item Deploy step.
 */
export const stateIds = ['todo', 'doing', 'checking', 'done'] as const;
export type StateId = typeof stateIds[number];
/** The bar's segments in the plain stage words (GY-2988): the third folds Testing, In review and Merging. */
export const stateLabel: Record<StateId, string> = { todo: 'Not started', doing: 'Building', checking: 'Testing, review, merge', done: 'Done' };

/**
 * The recorded flow's own steps (GY-161): Build, Validate, Test, Review, Prove, Merge, in the
 * order a change travels; they end at the merge (GY-1981). The board and the item page no longer draw them — items show the
 * four states above — but a recorded step move keeps this vocabulary, so it says exactly which
 * gate changed.
 */
export const stepIds = ['build', 'validate', 'test', 'review', 'prove', 'merge'] as const;
export type StepId = typeof stepIds[number];
/** One recorded move of an item between recorded steps. */
export interface StepTransition { key: string; from: StepId | null; to: StepId | null; at: string }
export type StepState = 'done' | 'current' | 'pending';
/** The gate each recorded step after Build reads. */
export const stepGate: Partial<Record<StepId, string>> = { validate: 'build', test: 'test', review: 'review', prove: 'acceptance', merge: 'merge' };
/** The recorded steps folded into the Checking state, in the order the control plane evaluates them. */
const checkingSteps: StepId[] = ['validate', 'test', 'review', 'prove', 'merge'];

/** One of the four states as the bar draws it: done, current or pending. */
export interface PrStep { id: StateId; label: string; state: StepState }
export interface PrSteps {
  steps: PrStep[];
  /** The current state: todo, doing or checking while it moves, done once merged; null for work closed without merging. */
  current: StateId | null;
  /** The item's plain stage (GY-2988), naming what it waits on while it moves: "In review · 1 of 2 checks done". */
  label: string;
  /** What the current state waits on, without the state's name. */
  detail: string;
  /** Who acts next, as a role, never a code name. */
  who: string;
}

/** True while the review gate refuses on a reviewer's request for changes. */
export const changesRequested = (work: Work) => !!work.gates.find(gate => gate.name === 'review')?.reasons.some(reason => reason.startsWith('Outstanding change requests'));

export type CheckState = 'passed' | 'failed' | 'running';
/**
 * Each policy check as the test gate reads it. The merge writer's trial builds and tests the merge
 * commit (GY-2010): until it records a passing trial of this head every check is running, a refused
 * trial of this head failed them, and a check the gate no longer names has passed. The Checking
 * state's label and the item page's Checks line both read this.
 */
export function checkStates(work: Work): { name: string; state: CheckState }[] {
  const gate = work.gates.find(entry => entry.name === 'test');
  const reasons = gate?.reasons ?? [];
  const named = (name: string) => !gate || reasons.some(reason => ciCheckRefusalPattern.exec(reason)?.[1] === name);
  if (reasons.some(reason => mergeWriterTrialPattern.test(reason))) {
    const refused = work.mergeLedger?.state === 'refused' && !!work.candidate && work.mergeLedger.head === work.candidate.sha;
    return (work.policy.checks ?? []).map(name => ({ name, state: refused ? 'failed' : 'running' }));
  }
  return (work.policy.checks ?? []).map(name => ({ name, state: named(name) ? 'running' : 'passed' }));
}

/** The review refusal no reviewer can answer: every configured reviewer profile is exhausted. */
const reviewersExhausted = /^Every configured reviewer profile is exhausted/;
/**
 * Merge refusals only the master agent clears — unverified branch protection, a standing
 * escalation, a slice lead's hold — and those a new head from the builder clears: a conflict with
 * the base, unresolved review threads, an ejection from the queue. The same refusals
 * src/model/next-action.ts maps to `attention` and `request-rework`.
 */
const mergeMasterClears = /branch protection have not been verified$|^Slice lead \S+ ruled /;
const mergeBuilderClears = /^Pull request is not mergeable against the current base$|^Branch protection requires conversation resolution and \d+ review threads? (is|are) unresolved|^Ejected from the merge queue:/;

/** What the checked work waits on, and who acts next, in plain words, per recorded step. */
export function waitsOn(step: StepId, gate: Gate | undefined, work: Work, now: number, release: ReleaseView): { detail: string; who: string } {
  const reasons = gate?.reasons ?? [];
  switch (step) {
    case 'build': {
      // Handed in, but the ready gate refuses (a recorded blocker, or a dependency a requirements
      // revision added): the control plane holds it there, so it waits on that, not on a builder.
      const ready = work.submission ? work.gates.find(gate => gate.name === 'ready' && !gate.passed)?.reasons[0] : undefined;
      if (ready !== undefined) {
        // A dependency waits for the other item to ship; a blocker is named, never restated: the row's
        // own line carries its one-sentence summary (GY-1739), the item page's details its text.
        if (/^Dependency /.test(ready)) return { detail: plainReason(ready, 'ready').text.replace(/^./, c => c.toLowerCase()), who: 'Graphyard (automatic)' };
        return { detail: 'held by a recorded blocker', who: 'Master agent' };
      }
      if (work.reworkRequested || changesRequested(work)) return assignment(work, now).active ? { detail: 'the builder is making the requested changes', who: 'Builder agent' } : { detail: 'sent back for changes, waiting for a builder', who: 'Graphyard (assigns a builder)' };
      return assignment(work, now).active ? { detail: 'the builder is writing the code', who: 'Builder agent' } : { detail: 'waiting for a builder', who: 'Graphyard (assigns a builder)' };
    }
    case 'validate': {
      const first = reasons[0] ?? '';
      if (/^No workspace registered$/.test(first)) return { detail: 'waiting for the builder to say where the code lives', who: 'Builder agent' };
      if (/^Pull request has not been independently observed$/.test(first)) return { detail: 'waiting for the control plane to read the candidate', who: 'Graphyard (automatic)' };
      return { detail: 'checking which files it changes', who: 'Graphyard (automatic)' };
    }
    case 'test': {
      const checks = checkStates(work);
      const failed = checks.filter(check => check.state === 'failed').map(check => check.name);
      if (failed.length) return { detail: `the check ${failed.join(', ')} failed`, who: 'Builder agent' };
      return { detail: `${checks.filter(check => check.state === 'passed').length} of ${checks.length} checks done`, who: 'Automated checks' };
    }
    case 'review':
      // Every reviewer profile exhausted: no reviewer can act, and adding capacity or changing the
      // provider is the master agent's decision (src/model/next-action.ts escalates it).
      if (reasons.some(reason => reviewersExhausted.test(reason))) return { detail: 'no reviewer is available', who: 'Master agent' };
      // The gate says "approval is required" even while no reviewer can be asked about this head
      // (src/model/next-action.ts `reviewStandstill`); the action the control plane computed
      // from that standstill names who actually moves it.
      switch (work.nextAction?.gate === 'review' ? work.nextAction.kind : null) {
        case 'dispatch': return { detail: 'the proofs run before the review', who: 'Prover agent' };
        case 'resync': return { detail: 'waiting for a fresh reading of the pull request before the review', who: 'Graphyard (automatic)' };
        case 'attention': return { detail: 'no reviewer can be asked about this head', who: 'Master agent' };
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
      const stuck = reasons.map(reason => plainReason(reason, 'merge')).find(plain => plain.stuck);
      return stuck ? { detail: stuck.text.replace(/^./, c => c.toLowerCase()), who: 'Builder agent' } : { detail: 'Graphyard is merging it', who: 'Graphyard (automatic)' };
    }
  }
}

/**
 * The four states for one item (GY-1979). Todo while nothing is handed in and no worker holds it;
 * Doing while a worker holds it and has not handed in; Checking from the hand-in until the merge;
 * Done once merged. The label leads with the item's plain stage (GY-2988) and, while it moves,
 * names what it waits on. Work closed without merging has no current state, and nobody acts.
 */
export function prSteps(work: Work, now: number, release: ReleaseView = noRelease, serve: ServeView = noServe): PrSteps {
  const plain = plainStage(work, release, serve);
  const make = (state: (id: StateId) => StepState, current: StateId | null, detail: string, who: string): PrSteps => ({
    steps: stateIds.map(id => ({ id, label: stateLabel[id], state: state(id) })), current,
    label: current && current !== 'done' ? `${plain} · ${detail}` : detail, detail, who,
  });
  // Closed without merging (src/model/closure.ts): no state is done or current, and nobody acts.
  if (isClosed(work)) return make(() => 'pending', null, `Closed as ${work.closure!.kind}, not merged`, 'Nobody — it was closed');
  if (work.stage === 'done') {
    // The plain stage names how far a merged item got: Merged, not live yet / Live* / Done (GY-2988).
    return make(() => 'done', 'done', plain, servedFor(work, release) ? 'Nobody — it is live' : 'Nobody — it has merged');
  }
  if (!work.submission) {
    const { detail, who } = waitsOn('build', undefined, work, now, release);
    // Doing: a worker holds it and has not handed in. Todo: not started — no lease, nothing handed in.
    return assignment(work, now).active ? make(id => id === 'doing' ? 'current' : id === 'todo' ? 'done' : 'pending', 'doing', detail, who)
      : make(id => id === 'todo' ? 'current' : 'pending', 'todo', detail, who);
  }
  // Checking: handed in, until the merge. The validate, test, review, proof and merge gates fold
  // into this one state, and the label names the gate it waits on. A recorded blocker, a
  // dependency a requirements revision added, a requested rework or a change request says so here
  // rather than sending the item back to Todo: the hand-in stands until the merge.
  const byName = new Map(work.gates.map(gate => [gate.name, gate]));
  const sentBack = work.reworkRequested || changesRequested(work) || byName.get('ready')?.passed === false;
  const phase = sentBack ? 'build' : checkingSteps.find(id => byName.get(stepGate[id]!)?.passed === false) ?? 'merge';
  const gate = phase === 'build' ? undefined : byName.get(stepGate[phase]!);
  const { detail, who } = waitsOn(phase, gate, work, now, release);
  const at = stateIds.indexOf('checking');
  return make(id => {
    const index = stateIds.indexOf(id);
    return index < at ? 'done' : index === at ? 'current' : 'pending';
  }, 'checking', detail, who);
}

/**
 * When the item entered the state `prSteps` shows it at: the Work row's "In step" clock and the
 * item page's. Checking began when the work was handed in — the recorded move out of Build into
 * the folded steps, or the hand-in instant on the item's own timeline — and a later move between
 * the folded steps does not restart it; a return to Build and a fresh hand-in does. Doing keeps
 * the builder's clock (`statusSince`: the claim), Done starts at the merge, and anything the moves
 * cannot say falls back to the item's own record (`statusSince`). The move list is the board's
 * — one list for the whole board (web/main.tsx `useStepMoves`) — so a move counts for this clock
 * only when it is this item's own (`move.key === work.key`): another item's move into Checking
 * must never start this item's clock or its overdue flag.
 */
export function stepSince(work: Work, now: number, moves?: readonly StepTransition[] | null, release: ReleaseView = noRelease): string {
  const current = prSteps(work, now, release).current;
  const own = statusSince(work, now);
  if (!current || current === 'todo' || current === 'doing') return own;
  const at = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now ? Date.parse(value) : null;
  if (current === 'done') return work.delivery?.mergedAt ?? work.observation?.mergedAt ?? own;
  const intoChecking = (moves ?? []).filter(move => {
    if (move.key !== work.key) return false; // the board's list is board-wide: only this item's own moves count
    const to = at(move.at) !== null && (stepIds as readonly string[]).includes(String(move.to)) ? move.to : null;
    const from = move.from !== null && (stepIds as readonly string[]).includes(String(move.from)) ? move.from : null;
    return to !== null && (checkingSteps as StepId[]).includes(to) && (from === null || from === 'build');
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
  if (intoChecking) return intoChecking.at;
  const pipeline = (work as Work & { pipeline?: PipelineTimeline }).pipeline;
  const handedIn = at(pipeline?.resubmittedAt ?? pipeline?.submittedAt);
  if (handedIn !== null) return new Date(handedIn).toISOString();
  return own;
}

/**
 * How long the item has held its current state, and whether that is past the one threshold
 * (src/model/duration.ts). Work that has arrived (merged, `done`) is never overdue.
 */
export function stepHeld(work: Work, now: number, moves?: readonly StepTransition[] | null, release: ReleaseView = noRelease): StatusDuration {
  return statusDuration(stepSince(work, now, moves, release), now, prSteps(work, now, release).current === 'done');
}
