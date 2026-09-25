import { createHash } from 'node:crypto';
import { actionAccount } from './next-action.js';
import { reconcileActions, actionId, type ActionRow, type ActionTransition } from './actions.js';
import { actionIdleMs, actionSettleMs, actionStall, claimLive, settling, waitingToRetry } from './action-progress.js';
import { nextActionLlmRoles, type NextAction, type NextActionInputs, type NextActionKind } from './action-kinds.js';
import type { ActionAccount, WaitKind } from './action-account.js';
import type { Work } from './work.js';

/**
 * The liveness invariant (GY-201): every open item always has exactly one owned next step with a
 * deadline, and the server — not a loop re-deriving the world — keeps it so.
 *
 * Correctness is enforced transactionally: every guard refuses what must not happen. Nothing
 * guaranteed that anybody then owned what happens next, so a correct refusal could become a
 * terminal state in disguise — a merge stranded with its PR open and no execution, a failed proof
 * nobody asked to rework, a refused scope request nobody decides, a wait nobody ever ends. This
 * module names, for every open item, the one obligation that moves it:
 *
 * - `session` — a live lease: the worker holding it owes the next step by the lease's expiry.
 * - `action` — a durable action row (`actions.ts`) someone claims, runs or is still settling.
 * - `wait` — a named wait on an event outside the item (`action-account.ts`), with its `dueAt`.
 *
 * An open item with none of the three is a liveness violation. The engine repairs one within the
 * reconciliation tick that sees it (`livenessNext`): it synthesizes the successor action for the
 * state the item is in, bound to the violation's reason so the same violation never queues a
 * second row, and a successor that keeps failing for one unchanged reason is converted to an
 * escalation instead of being retried forever. `master status` counts what is left, with ages.
 *
 * Backlog is not open work: an item nobody released waits on the operator's goals-and-priorities
 * call, which carries no deadline this control plane may impose (the same rule `computeAccount`
 * applies). Done items have no next step here; a delivery's deployment is `verify-deployment`'s.
 */

/** How long a wait the item itself names — a session the control plane owes, a merge whose record follows — may stand. */
export const livenessWaitBoundMs = 60 * 60_000;
/** How many identical failures turn a successor into an escalation: the same threshold that classifies a stall. */
export { actionStallThreshold as livenessFailureLimit } from './action-progress.js';

export type Obligation =
  | { kind: 'session'; owner: string; epoch: number; dueAt: string }
  | { kind: 'action'; id: string; action: NextActionKind; state: ActionRow['state']; dueAt: string }
  | { kind: 'wait'; wait: WaitKind; on: string | null; detail: string; dueAt: string | null };

/** What an open item with no obligation is stuck in, which decides the successor that repairs it. */
export const livenessStates = ['refused-scope', 'failed-proof', 'stranded-merge', 'stale-wait', 'unowned'] as const;
export type LivenessState = typeof livenessStates[number];
/** The repair each state gets; `reconcile-merge` is the guarded `merge` (or a `resync` of a merge already landed). */
export const livenessRepairs: Record<LivenessState, 'scope-decision' | 'request-rework' | 'reconcile-merge' | 'escalate'> = {
  'refused-scope': 'scope-decision', 'failed-proof': 'request-rework', 'stranded-merge': 'reconcile-merge', 'stale-wait': 'escalate', unowned: 'escalate',
};

export interface LivenessViolation {
  work: string; key: string; state: LivenessState;
  /** Why the item has no owned next step, worded without times so the same violation always reads the same. */
  reason: string;
  /** Since when nothing has owned it, as well as the record can tell, and how long ago that was. */
  since: string; ageMs: number;
}

/** Released and not done: the items the invariant is about. */
export const openItem = (work: Pick<Work, 'ready' | 'stage'>) => work.ready && work.stage !== 'done';
const liveLease = (work: Work, now: Date) => !!work.lease && Date.parse(work.lease.expiresAt) > now.getTime();
const short = (sha: string | null | undefined) => sha ? sha.slice(0, 12) : 'none';
const iso = (ms: number) => new Date(ms).toISOString();
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const latest = (...stamps: (string | null | undefined)[]) => {
  const times = stamps.map(stamp => stamp ? Date.parse(stamp) : NaN).filter(Number.isFinite);
  return times.length ? iso(Math.max(...times)) : null;
};

/**
 * The obligation a durable row stands for, and its deadline: a live claim's expiry, a backoff's
 * retry, a completed action's settle window, or the idle bound from the row's last transition. A
 * completed row whose settle window passed is history waiting to be reopened, not an obligation.
 */
function rowObligation(row: ActionRow, now: Date): Obligation | null {
  const at = (dueAt: string): Obligation => ({ kind: 'action', id: row.id, action: row.kind, state: row.state, dueAt });
  if (row.state === 'done') return settling(row, now) ? at(iso(Date.parse(row.resolvedAt!) + actionSettleMs)) : null;
  if (row.state === 'claimed' && claimLive(row, now)) return at(row.claim!.expiresAt);
  if (waitingToRetry(row, now)) return at(row.retryAt!);
  return at(iso(Date.parse(row.history.at(-1)?.at ?? row.requestedAt) + actionIdleMs));
}

interface WaitDue { dueAt: string | null; stale: boolean }
/**
 * When a named wait is due, and whether it already is.
 *
 * A wait on another item — a dependency, the entry ahead in the merge queue — is owned by that
 * item, so it is due when that item's own obligation is and is never stale while that item is
 * open: a violation there is reported, and repaired, once, on the item that holds it. A wait on an
 * item that is done or gone should have cleared, so it is stale. A wait the item names for itself
 * (a session the control plane owes it, a merge whose delivery record follows) is due
 * `livenessWaitBoundMs` after it began. A wait with no deadline at all — a person's decision — is
 * not an obligation this control plane can hold anybody to.
 */
function waitDue(work: Work, account: ActionAccount, all: Work[], now: Date, seen: Set<string>): WaitDue | null {
  const wait = account.wait;
  if (!wait) return null;
  if (wait.kind === 'dependency' || wait.kind === 'queue') {
    const upstream = all.find(entry => entry.key === wait.on || entry.id === wait.on);
    // Stale since the item it names finished, or since this item began waiting on it, if later.
    if (!upstream || !openItem(upstream)) return { dueAt: latest(upstream?.stage === 'done' ? upstream.stageEnteredAt : null, account.heldSince) ?? now.toISOString(), stale: true };
    const held = obligationOf(upstream, all, now, seen);
    return { dueAt: held?.dueAt ?? null, stale: false };
  }
  if (wait.kind === 'human') return null;
  const began = wait.kind === 'settled' ? latest(work.observation?.mergedAt, account.heldSince) : latest(account.heldSince, work.candidate?.createdAt);
  const dueAt = iso(Date.parse(began ?? now.toISOString()) + livenessWaitBoundMs);
  return { dueAt, stale: Date.parse(dueAt) <= now.getTime() };
}

/**
 * The one obligation that owns an open item's next step, or null when nothing does. A live lease
 * comes first — the worker holding it owes the step — then the item's oldest durable row, then
 * the named wait its account gives, while that wait is not past its deadline.
 */
export function obligationOf(work: Work, all: Work[], now: Date, seen = new Set<string>()): Obligation | null {
  if (liveLease(work, now)) return { kind: 'session', owner: work.lease!.owner, epoch: work.lease!.epoch, dueAt: work.lease!.expiresAt };
  for (const row of work.actionQueue?.actions ?? []) { const held = rowObligation(row, now); if (held) return held; }
  if (seen.has(work.id)) return null;
  seen.add(work.id);
  const account = actionAccount(work, all, now);
  const due = waitDue(work, account, all, now, seen);
  if (!due || due.stale) return null;
  return { kind: 'wait', wait: account.wait!.kind, on: account.wait!.on, detail: account.wait!.detail, dueAt: due.dueAt };
}

/** The failing proofs trusted evidence recorded against the current head. */
const failedProofs = (work: Work) => work.candidate ? [...new Set(work.evidence.filter(entry => entry.trusted && entry.result === 'fail' && !entry.revocation
  && entry.sha === work.candidate!.sha && entry.policyRevision === work.policyRevision).map(entry => entry.proof))] : [];

/**
 * What an item with no obligation is stuck in, in the order the states unblock: a refused scope
 * request first (the worker's ask is what everything else waits on), then a failed proof (a head
 * that failed can never merge), then a merge with its pull request still to land or to record,
 * then a wait that outlived its deadline, and last an item nothing names at all.
 */
export function livenessState(work: Work, account: ActionAccount, stale: boolean): { state: LivenessState; reason: string } {
  const key = work.key;
  const scope = work.scopeRequest?.decision?.state === 'refused' ? work.scopeRequest : null;
  if (scope || (work.scopeDecision?.state === 'refused' && work.blocker)) {
    const paths = scope?.paths ?? work.scopeDecision!.paths, why = scope?.decision?.reason ?? work.scopeDecision!.reason;
    return { state: 'refused-scope', reason: `${key}'s request for ${paths.join(', ')} outside plannedFiles was refused (${why}) and nobody owns deciding it` };
  }
  const failed = failedProofs(work);
  if (failed.length && !work.reworkRequested) return { state: 'failed-proof', reason: `${key} failed ${failed.join(', ')} on ${short(work.candidate?.sha)} and no rework is requested` };
  const observed = work.observation;
  if (work.candidate && observed && !work.mergeExecution && observed.prState !== 'closed' && (observed.merged || work.stage === 'merge' || !!work.queue || account.action?.kind === 'merge'))
    return { state: 'stranded-merge', reason: observed.merged ? `${key}'s PR #${work.candidate.pr} merged as ${short(observed.mergeSha)} and its delivery is not recorded`
      : `${key}'s PR #${work.candidate.pr} is open on ${short(work.candidate.sha)} with no merge execution and nothing driving its merge` };
  if (stale && account.wait) return { state: 'stale-wait', reason: `${key} waits on ${account.wait.kind}${account.wait.on ? ` ${account.wait.on}` : ''} past its deadline: ${account.wait.detail}` };
  return { state: 'unowned', reason: `${key} has no live session, no action row and no named wait: ${account.defect ?? account.action?.reason ?? 'nothing names its next step'}` };
}

/**
 * Every open item with no owned next step, oldest first. `since` is the latest moment the record
 * shows something owning the item — a lease that lapsed, a row that was retired, a wait's deadline
 * — or the moment it entered its stage, when nothing ever did.
 */
export function livenessViolations(all: Work[], now: Date): LivenessViolation[] {
  return all.filter(openItem).flatMap(work => {
    if (obligationOf(work, all, now)) return [];
    const account = actionAccount(work, all, now);
    const due = waitDue(work, account, all, now, new Set([work.id]));
    const { state, reason } = livenessState(work, account, !!due?.stale);
    const lapsed = work.lease && !liveLease(work, now) ? work.lease.expiresAt : null;
    const retired = latest(...(work.actionQueue?.history ?? []).map(row => row.resolvedAt));
    const since = latest(lapsed, retired, due?.stale ? due.dueAt : null) ?? account.heldSince;
    return [{ work: work.id, key: work.key, state, reason, since, ageMs: Math.max(0, now.getTime() - Date.parse(since)) }];
  }).sort((a, b) => b.ageMs - a.ageMs);
}

/** The count and ages `master status` reports. */
export function livenessReport(all: Work[], now: Date) {
  const violations = livenessViolations(all, now);
  return { violations: violations.length, oldestMs: violations[0]?.ageMs ?? null, items: violations };
}

/**
 * The successor action that repairs a violation, bound to its reason: the same violation always
 * names the same row (`actionId` is a hash of the binding), so a tick that sees it again finds
 * the row it already queued instead of adding a second.
 */
export function successorAction(work: Work, state: LivenessState, reason: string): NextAction {
  const binding = `liveness:${state}:${digest(reason)}`;
  const make = (kind: NextActionKind, inputs: NextActionInputs): NextAction =>
    ({ kind, work: work.id, key: work.key, gate: null, refusal: null, reason: `${livenessRepairs[state]}: ${reason}`, inputs, llmRole: nextActionLlmRoles[kind], binding });
  const candidate = work.candidate;
  if (state === 'stranded-merge' && candidate) return work.observation?.merged
    ? make('resync', { kind: 'resync', pr: candidate.pr, sha: candidate.sha, baseSha: candidate.baseSha, baseTip: work.observation.baseTip ?? null, observedAt: work.observation.at })
    : make('merge', { kind: 'merge', pr: candidate.pr, sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: work.policyRevision, queuePosition: work.queue?.sequence ?? null });
  if (state === 'failed-proof') return make('request-rework', { kind: 'request-rework', pr: candidate?.pr ?? null, sha: candidate?.sha ?? null, detail: reason });
  if (state === 'refused-scope') return make('escalate', { kind: 'escalate', trigger: 'scope', detail: `decide the refused scope request: graphyard master decide ${work.key} requirements REASON, or unblock it; ${reason}` });
  return make('escalate', { kind: 'escalate', trigger: state === 'stale-wait' ? 'stale-wait' : 'liveness', detail: reason });
}

/**
 * The row a successor already has — open, or retired into the history — carrying a stall: its
 * last `livenessFailureLimit` attempts failed for one unchanged reason. Only a successor is
 * converted. An ordinary action that stalls is waiting on a condition somebody else clears (a busy
 * resource, a provider pause), so it rechecks and retries the moment it clears (GY-110); a
 * successor exists because nothing else owned the item, so nothing else will clear it either.
 */
function stalledSuccessor(work: Work, action: NextAction) {
  if (!action.binding.startsWith('liveness:') || action.kind === 'escalate') return null;
  const id = actionId(action.kind, work.id, action.binding), queue = work.actionQueue;
  const rows = [...(queue?.actions ?? []), ...[...(queue?.history ?? [])].reverse()].filter(row => row.id === id);
  for (const row of rows) { const stall = row.stall ?? actionStall(row); if (stall) return stall; }
  return null;
}

/**
 * What the item needs next once the invariant is enforced: the computed action when there is one,
 * nothing while a live lease or a named wait inside its deadline owns the step, and otherwise the
 * successor for the item's state — or, once that successor has failed the same way
 * `livenessFailureLimit` times, the escalation that replaces it. Pure over the item, its graph and
 * the clock, and independent of the rows it will produce, so every tick names the same answer.
 */
export function livenessNext(work: Work, all: Work[], now: Date, account = actionAccount(work, all, now)): NextAction | null {
  if (!openItem(work) || account.action) return account.action;
  if (liveLease(work, now)) return null;
  const due = waitDue(work, account, all, now, new Set([work.id]));
  if (due && !due.stale) return null;
  const { state, reason } = livenessState(work, account, !!due?.stale);
  const successor = successorAction(work, state, reason);
  const stall = stalledSuccessor(work, successor);
  if (!stall) return successor;
  const detail = `${successor.kind} for ${work.key} failed ${stall.failures} times for one unchanged reason (${stall.reason}); it is escalated rather than retried`;
  return { kind: 'escalate', work: work.id, key: work.key, gate: null, refusal: null, reason: `${livenessRepairs[state]}: ${detail}`,
    inputs: { kind: 'escalate', trigger: 'liveness', detail: `${detail}; ${reason}` }, llmRole: nextActionLlmRoles.escalate, binding: `liveness:escalate:${digest(`${successor.binding}\0${stall.reason}`)}` };
}

/**
 * One reconciliation pass over the invariant, as the engine's evaluation runs it for each item:
 * name each open item's next step with `livenessNext` and bring its rows in line. Returns what
 * changed, per item, so a caller can see every successor it queued.
 */
export function livenessTick(all: Work[], now: Date): { key: string; transitions: ActionTransition[] }[] {
  return all.filter(openItem).map(work => {
    const next = livenessNext(work, all, now);
    const transitions = reconcileActions(work, all, now, { next });
    work.nextAction = next;
    return { key: work.key, transitions };
  });
}
