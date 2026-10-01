import type { ProducerGroup } from './dispatch.js';

/**
 * The action vocabulary: the kinds themselves, the typed inputs each carries, and where the
 * judgment for each one happens.
 *
 * It is separated from the computation in `next-action.ts` because everything downstream reads
 * it without computing anything — the executor decides which kinds it may hold a handler for, the
 * queue rows are typed by it, the API publishes it — and because adding a kind means answering
 * every question in this file at once: what inputs it needs, which judgment it starts, and
 * whether an executor may run it at all.
 */

export const nextActionKinds = ['dispatch', 'request-review', 'request-rework', 'approve-scope', 'resync', 'reclaim', 'merge', 'verify-deployment', 'escalate'] as const;
export type NextActionKind = typeof nextActionKinds[number];

/**
 * Where a language model is required, per action kind. The executor step itself never needs one:
 * an executor launches a session, calls the provider, or records a fact. `llmRole` names the
 * judgment that happens *inside* what the action starts, which is the only place a model belongs
 * (see AGENTS.md: agents implement, review, approve, produce evidence and resolve escalations).
 * A kind whose role is `null` is mechanical end to end. `dispatch` carries the one distinction the
 * kind alone cannot make: dispatching a worker starts an implementation, dispatching a producer
 * starts evidence production, and the computed action names which (`llmRole` on the action).
 */
export type LlmRole = 'implement' | 'review' | 'produce-evidence' | 'approve-decision' | 'resolve-escalation';
export const nextActionLlmRoles: Record<NextActionKind, LlmRole | null> = {
  dispatch: 'implement', 'request-review': 'review', 'request-rework': 'approve-decision',
  'approve-scope': null, resync: null, reclaim: null, merge: null, 'verify-deployment': null,
  escalate: 'resolve-escalation',
};
export const llmRoles: readonly LlmRole[] = ['implement', 'review', 'produce-evidence', 'approve-decision', 'resolve-escalation'];
/** The action kinds an executor can drive to completion with no language model anywhere in the loop. */
export const mechanicalActionKinds = nextActionKinds.filter(kind => nextActionLlmRoles[kind] === null);

/**
 * Where the judgment for a kind happens, which is what decides whether an executor may run it:
 *
 * - `none` — mechanical end to end; the step is a provider call or a record.
 * - `in-session` — the step launches a session and walks away; the model works inside that
 *   session, under its own credential, never inside the loop.
 * - `in-step` — running the action *is* the judgment. An executor must never have a handler for
 *   one of these: configuring one would be the loop quietly deciding what the project reserves
 *   for an agent, and the row would stop being visible as something a judgment still owes.
 *
 * This is the rule `executor.ts` checks when handlers are configured, so adding a kind cannot
 * silently widen what an executor runs.
 */
export const actionJudgment: Record<NextActionKind, 'none' | 'in-session' | 'in-step'> = {
  dispatch: 'in-session', 'request-review': 'in-session',
  'request-rework': 'in-step', escalate: 'in-step',
  'approve-scope': 'none', resync: 'none', reclaim: 'none', merge: 'none', 'verify-deployment': 'none',
};
/** Every kind an executor may hold a handler for: everything but the judgments made in the step itself. */
export const executorRunnableKinds = nextActionKinds.filter(kind => actionJudgment[kind] !== 'in-step');

export type NextActionInputs =
  | { kind: 'dispatch'; target: 'implementation'; epoch: number; priority: number; plannedFiles: string[] }
  | { kind: 'dispatch'; target: 'proof'; group: ProducerGroup; proofs: string[]; requestId: string | null; pr: number; sha: string; baseSha: string; policyRevision: number }
  | { kind: 'request-review'; provider: string; requestId: string | null; pr: number; sha: string; baseSha: string; policyRevision: number }
  | { kind: 'request-rework'; pr: number | null; sha: string | null; detail: string }
  | { kind: 'approve-scope'; epoch: number; paths: string[]; requestedBy: string; detail: string }
  | { kind: 'resync'; pr: number | null; sha: string | null; baseSha: string | null; baseTip: string | null; observedAt: string | null }
  | { kind: 'reclaim'; epoch: number; owner: string | null; leaseExpiresAt: string | null }
  | { kind: 'merge'; pr: number; sha: string; baseSha: string; policyRevision: number; queuePosition: number | null }
  | { kind: 'verify-deployment'; mergeSha: string; mergedAt: string; state: string }
  | { kind: 'escalate'; trigger: string; detail: string };

export interface NextAction {
  kind: NextActionKind;
  /** The item the action is about: its id and key, so an executor needs no second lookup. */
  work: string; key: string;
  /** The gate whose refusal named this action, and that refusal verbatim; null for actions no gate raised. */
  gate: string | null; refusal: string | null;
  reason: string;
  inputs: NextActionInputs;
  /** The judgment inside what this action starts, or null when running it needs no language model. */
  llmRole: LlmRole | null;
  /**
   * What binds this action to the state that asked for it. Two evaluations of the same situation
   * produce the same binding, which is what lets the queue recognise an action it already holds.
   */
  binding: string;
}

/**
 * A `resync` is satisfied by a fresh observation, never by a re-read that saves nothing (GY-607).
 *
 * The executor asks the control plane to wake the item's observation job and waits for an
 * observation newer than its claim. One that does not arrive fails the attempt with a reason
 * beginning `resyncUnobservedPrefix` and naming the job's condition (`describeObservationJob`),
 * worded without instants or counters so that the same condition gives the same reason on every
 * claim: the third such claim in a row marks the row stalled (`actionStall`), and `master status`
 * raises its attention item naming the item and that condition.
 */
export const resyncUnobservedPrefix = 'no observation newer than the claim was saved';
/** The item's durable observation job, as `POST /api/work/:id/resync` reports it. */
export interface ObservationJobState {
  availableAt: string | null; lockedUntil: string | null; attempts: number;
  error: string | null; heldUntil: string | null; heldReason: string | null;
}
/** The observation job's condition in one clause, identical for as long as the condition stands. */
export function describeObservationJob(job: ObservationJobState | null | undefined, now: number): string {
  if (!job) return 'the item has no observation job, so nothing observes it';
  if (job.heldUntil && Date.parse(job.heldUntil) > now) return `its observation job is held${job.heldReason ? `: ${job.heldReason}` : ''}`;
  if (job.error) return `its observation job last failed: ${job.error}`;
  return 'its observation job is scheduled and records no error, yet saved no observation';
}
