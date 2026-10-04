import type { ProducerGroup } from './dispatch.js';
import { endedRuntimeStates } from './sessions.js';

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
 * raises its attention item naming the item and that condition — at once for a held, failed or
 * missing job, and for a job merely scheduled only once the run outlasts `observationWaitBoundMs`.
 */
export const resyncUnobservedPrefix = 'no observation newer than the claim was saved';
/** The item's durable observation job, as `POST /api/work/:id/resync` reports it. */
export interface ObservationJobState {
  availableAt: string | null; lockedUntil: string | null; attempts: number;
  error: string | null; heldUntil: string | null; heldReason: string | null;
}
/** The clause for a job the claim woke that is scheduled with no hold and no error: due, and waiting for an observation worker. */
export const observationJobScheduled = 'its observation job is scheduled and records no error, yet saved no observation';
/** The observation job's condition in one clause, identical for as long as the condition stands. */
export function describeObservationJob(job: ObservationJobState | null | undefined, now: number): string {
  if (!job) return 'the item has no observation job, so nothing observes it';
  if (job.heldUntil && Date.parse(job.heldUntil) > now) return `its observation job is held${job.heldReason ? `: ${job.heldReason}` : ''}`;
  if (job.error) return `its observation job last failed: ${job.error}`;
  return observationJobScheduled;
}

/**
 * How long a woken observation job may take to save its observation before a `resync` waiting on
 * it is stalled rather than waiting (GY-1090).
 *
 * The claim that wakes the job makes it due at once, and the observation workers claim a job due
 * for longer than `observationStarvedAfterMs` (src/store/store.ts) ahead of every other priority;
 * how fast they get through the queue is the observation pipeline's own reading (`githubBudget.
 * throughput`, the queue head's observation lag), not this row's. Every resync row that failed on a
 * job scheduled with no hold and no error on 1 October 2026 — 44 of the 61 stalled-gate faults
 * GY-1090 was filed for — completed on the observation it woke, the slowest thirteen minutes after
 * its first claim, yet three identical failures inside those minutes read as a stall. The bound is
 * the one the liveness rules give any wait on an event (`livenessWaitBoundMs`, src/model/liveness.ts):
 * a wait that outlasts it is a stall again, whatever it waits for.
 */
export const observationWaitBoundMs = 30 * 60_000;

/**
 * How long a dispatch may wait for an available worker profile before a `dispatch` waiting for a
 * slot is stalled rather than waiting (GY-1108).
 *
 * When all launch profiles are occupied by active agent sessions (working, done or idle awaiting
 * teardown) or reserved by concurrent dispatches, the attempt has nowhere to place the work until
 * a running session finishes and its slot frees. The bound matches the liveness rule for any wait
 * on an external event (`livenessWaitBoundMs`, src/model/liveness.ts): a wait that outlasts it
 * stalls again.
 */
export const workerSlotWaitBoundMs = 30 * 60_000;

/** Agent states that end a session, so a profile reporting one is not busy (GY-1141). */
const terminatedAgentStates = new Set([...endedRuntimeStates, 'terminated', 'exited-error']);

/**
 * Whether a dispatch refusal names a wait for a worker profile to free (GY-1108).
 *
 * When every healthy profile is reserved by another dispatch, or configured launch profiles are busy
 * with active agent sessions (alongside any profiles dedicated to unsupervised observation), the refusal is a wait for
 * capacity. A configuration fault (no launch profiles configured or only existing profiles), an unavailable credential, or a
 * profile cooling off after a failed launch is not a wait and stalls on the standard threshold.
 */
export function workerSlotWait(reason: string): boolean {
  const match = reason.match(/^no worker profile can take \S+: (.+)$/);
  if (!match) return false;
  const detail = match[1];
  if (detail.startsWith('every healthy profile is reserved by another dispatch')) return true;
  if (detail === 'no launch profile is configured') return false;
  const entries = [...detail.matchAll(/([a-zA-Z0-9._-]+) \(([^)]+)\)/g)];
  if (!entries.length) return false;
  let busyLaunchProfiles = 0;
  for (const [, , r] of entries) {
    if (r === 'Existing sessions are observed only; Graphyard will not inject new work into an unsupervised process') continue;
    const statusMatch = r.match(/^(\S+ )?agent \S+ is (\S+)$/);
    if (statusMatch && !terminatedAgentStates.has(statusMatch[2])) {
      busyLaunchProfiles++;
      continue;
    }
    return false;
  }
  return busyLaunchProfiles > 0;
}

/**
 * The bound of a failure reason that names a handoff still in progress — the attempt did its part
 * and waits for the effect another component is bound to deliver — or null for any other reason.
 * A run of such failures is a stall only once it outlasts the bound (`actionStall`); a held job, a
 * failed job or a missing one is not in progress, and stalls on the ordinary threshold.
 */
export function handoffWaitBound(reason: string): number | null {
  if (reason.includes(`${resyncUnobservedPrefix}; ${observationJobScheduled};`)) return observationWaitBoundMs;
  if (workerSlotWait(reason)) return workerSlotWaitBoundMs;
  return null;
}
