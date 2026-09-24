import { deliveryState, type Gate, type Work } from '../src/model';
import { latestCheck } from '../src/merge-queue';
import { deliveredAt, servedAt } from '../src/flow-analytics';
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

export interface PrStep { id: StepId; label: string; state: StepState }
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

/** What the current step waits on, and who acts next, in plain words. */
function waitsOn(step: StepId, gate: Gate | undefined, work: Work, now: number): { detail: string; who: string } {
  const reasons = gate?.reasons ?? [];
  switch (step) {
    case 'build':
      if (work.reworkRequested || changesRequested(work)) return assignment(work, now).active ? { detail: 'the builder is making the requested changes', who: 'Builder agent' } : { detail: 'sent back for changes, waiting for a builder', who: 'Graphyard (assigns a builder)' };
      return assignment(work, now).active ? { detail: 'the builder is writing the code', who: 'Builder agent' } : { detail: 'waiting for a builder', who: 'Graphyard (assigns a builder)' };
    case 'validate': {
      const first = reasons[0] ?? '';
      if (/^(Candidate changes \d+ files? outside|Out-of-scope regression)/.test(first)) return { detail: 'it changes files outside its plan', who: 'Builder agent' };
      if (/^No workspace registered$/.test(first)) return { detail: 'waiting for the builder to say where the code lives', who: 'Builder agent' };
      if (/^Pull request has not been independently observed$/.test(first)) return { detail: 'waiting to see the pull request on GitHub', who: 'Graphyard (automatic)' };
      return { detail: 'checking which files it changes', who: 'Graphyard (automatic)' };
    }
    case 'test': {
      const required = work.policy.checks ?? [];
      // The test gate counts only runs from the trusted CI Apps, which the dashboard is not told. So
      // its own reasons decide which checks have not passed: a check it does not name has passed, and
      // no run from another App with the same name can make a named one read done.
      const named = (name: string) => reasons.includes(`Required CI check ${name} has not passed on the current candidate`);
      const unpassed = gate ? required.filter(named) : required;
      // A named check reads failed once every App's latest run of it has finished and one of them did
      // not succeed; while any is still running it stays pending. Only each App's latest run counts,
      // as in the test gate: a re-run replaces an old failure or success.
      const failed = unpassed.filter(name => {
        const runs = (work.observation?.checks ?? []).filter(check => check.name === name);
        const latest = [...new Set(runs.map(check => check.appId))].map(app => latestCheck(runs.filter(check => check.appId === app))?.result ?? '');
        return latest.length > 0 && latest.every(result => !pendingCheck.has(result)) && latest.some(result => result !== 'success');
      });
      if (failed.length) return { detail: `the check ${failed.join(', ')} failed`, who: 'Builder agent' };
      return { detail: `${required.length - unpassed.length} of ${required.length} checks done`, who: 'Automated checks' };
    }
    case 'review':
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
      const queued = reasons.map(reason => reason.match(/^Merge queue position (\d+) of \d+: (\S+) is ahead$/)).find(Boolean);
      if (queued) return { detail: `${ordinal(Number(queued[1]))} in line, after ${queued[2]}`, who: 'Graphyard (automatic)' };
      const stuck = reasons.map(reason => plainReason(reason, 'merge')).find(plain => plain.stuck);
      return stuck ? { detail: stuck.text.replace(/^./, c => c.toLowerCase()), who: 'Builder agent' } : { detail: 'Graphyard is merging it', who: 'Graphyard (automatic)' };
    }
    case 'deploy': {
      const state = deliveryState(work);
      return state === 'delivered-with-failure' ? { detail: 'the check after deploying failed', who: 'Master agent' }
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
 * not passed, which keeps it at Deploy.
 */
export function prSteps(work: Work, now: number): PrSteps {
  const make = (state: (id: StepId) => StepState, current: StepId | null, detail: string, who: string): PrSteps => ({
    steps: stepIds.map(id => ({ id, label: stepLabel[id], state: state(id) })), current,
    label: current ? `${stepVerb[current]} · ${detail}` : detail, detail, who,
  });
  if (work.stage === 'done') {
    // Delivered once merged, unless its policy asks for a post-deployment check that has not passed
    // (web/groups.ts reads the same `deliveredAt`). "Live" only once the release is observed serving it.
    if (!work.delivery || deliveredAt(work)) return servedAt(work) ? make(() => 'done', null, 'Live', 'Nobody — it is live')
      : make(() => 'done', null, 'Merged', 'Nobody — it has merged');
    const { detail, who } = waitsOn('deploy', undefined, work, now);
    return make(id => id === 'deploy' ? 'current' : 'done', 'deploy', detail, who);
  }
  // A change request sends the work back to its builder, so it waits at Build, not at Review.
  const handedIn = !!work.submission && !work.reworkRequested && !changesRequested(work);
  if (!handedIn) {
    const { detail, who } = waitsOn('build', undefined, work, now);
    return make(id => id === 'build' ? 'current' : 'pending', 'build', detail, who);
  }
  const byName = new Map(work.gates.map(gate => [gate.name, gate]));
  // A gate the item does not carry has nothing to refuse, so its step reads done.
  const passed = (id: StepId) => id === 'build' || (id !== 'merge' && id !== 'deploy' && byName.get(stepGate[id]!)?.passed !== false);
  const current = stepIds.find(id => id !== 'deploy' && !passed(id)) ?? 'merge';
  const { detail, who } = waitsOn(current, stepGate[current] ? byName.get(stepGate[current]!) : undefined, work, now);
  return make(id => id === current ? 'current' : passed(id) ? 'done' : 'pending', current, detail, who);
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
export function stepSince(work: Work, now: number, moves?: readonly StepTransition[] | null): string {
  const current = prSteps(work, now).current;
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
 * (web/duration.ts). Merged work has arrived, as in `statusHeld`: it is never overdue.
 */
export function stepHeld(work: Work, now: number, moves?: readonly StepTransition[] | null): StatusDuration {
  return statusDuration(stepSince(work, now, moves), now, work.stage === 'done');
}
