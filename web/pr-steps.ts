import { deliveryState, type Gate, type Work } from '../src/model';
import { latestCheck } from '../src/merge-queue';
import { assignment } from './assignment';
import { plainReason } from './plain-status';

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

/** What the current step waits on, and who acts next, in plain words. */
function waitsOn(step: StepId, gate: Gate | undefined, work: Work, now: number): { detail: string; who: string } {
  const reasons = gate?.reasons ?? [];
  switch (step) {
    case 'build':
      if (work.reworkRequested) return assignment(work, now).active ? { detail: 'the builder is making the requested changes', who: 'Builder agent' } : { detail: 'sent back for changes, waiting for a builder', who: 'Graphyard (assigns a builder)' };
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
      // Only each check's latest run counts, as in the test gate: a re-run replaces an old failure or success.
      const result = (name: string) => latestCheck((work.observation?.checks ?? []).filter(check => check.name === name))?.result ?? '';
      const finished = (name: string) => !pendingCheck.has(result(name));
      const failed = required.filter(name => finished(name) && result(name) !== 'success');
      if (failed.length) return { detail: `the check ${failed.join(', ')} failed`, who: 'Builder agent' };
      return { detail: `${required.filter(finished).length} of ${required.length} checks done`, who: 'Automated checks' };
    }
    case 'review':
      return reasons.some(reason => reason.startsWith('Outstanding change requests')) ? { detail: 'the reviewer asked for changes', who: 'Builder agent' } : { detail: 'waiting for the reviewer', who: 'Reviewer agent' };
    case 'prove': {
      const total = work.criteria.filter(c => !c.bootstrap).flatMap(c => c.proofs).length;
      const open = reasons.filter(reason => /^AC-\d+:/.test(reason)).length;
      return { detail: total ? `${total - open} of ${total} proofs passed` : 'waiting for proof', who: 'Prover agent' };
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
 * every gate passes the item is merging. A merged item is at Deploy until the release serves it,
 * and every step is done after.
 */
export function prSteps(work: Work, now: number): PrSteps {
  const make = (state: (id: StepId) => StepState, current: StepId | null, detail: string, who: string): PrSteps => ({
    steps: stepIds.map(id => ({ id, label: stepLabel[id], state: state(id) })), current,
    label: current ? `${stepVerb[current]} · ${detail}` : detail, detail, who,
  });
  if (work.stage === 'done') {
    const state = deliveryState(work);
    if (!state || state === 'delivered' || state === 'smoke-passed') return make(() => 'done', null, 'Live', 'Nobody — it has shipped');
    const { detail, who } = waitsOn('deploy', undefined, work, now);
    return make(id => id === 'deploy' ? 'current' : 'done', 'deploy', detail, who);
  }
  const handedIn = !!work.submission && !work.reworkRequested;
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
