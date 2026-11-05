import type { ActionRow } from './actions.js';
import { type NextAction, nextActionLlmRoles } from './action-kinds.js';
import type { ActionAccount, ActionWait } from './action-account.js';
import type { Work } from './work.js';
import { claimLive, actionSettleMs, waitingToRetry, actionIdleMs, actionStall, actionStallMaxMs } from './action-progress.js';
import { roleSessionMaximumMs } from './sessions.js';
import { producerGroupDecisions } from './mechanical-proofs.js';
/**
 * The liveness invariant (GY-201): every open item always has exactly one owned next step with a
 * deadline, and the server — not a loop re-deriving the world — keeps it that way.
 *
 * Correctness is enforced transactionally everywhere; liveness used to be left to whoever happened
 * to look next, so a guard that correctly refused became a terminal state in disguise: a merge
 * whose provider outcome was retained and never re-read, a failed proof nobody reworked, a dispatch
 * attempted 782 times for one unchanged reason. An item's
 * obligation is one of three things:
 *
 * - `session` — a live leased session doing what the item waits for, due when its lease expires;
 * - `action` — an open row on the durable action queue for the step the item needs, due by the
 *   row's claim, retry, settle window or idle bound;
 * - `wait` — a named wait on an event outside this item, due at a bound (`livenessWaitBoundMs`),
 *   or, for a wait on another item, when that item's own obligation is due.
 *
 * An open item with none of these is a violation. The reconciliation tick (`Engine.reconcile`)
 * repairs each one in its own transaction by opening the successor the item's state calls for,
 * with an id derived from its reason so repeating the repair never queues a second row.
 */

/** Consecutive failures with one unchanged reason after which a row is escalated rather than retried. */
export const livenessRetryLimit = 8;
/** How long an item may wait on an event nobody else is named as owing before the wait is stale. */
export const livenessWaitBoundMs = 30 * 60_000;

export type ObligationKind = 'session' | 'action' | 'wait';
export interface Obligation { kind: ObligationKind; owner: string | null; dueAt: string; detail: string; action?: { id: string; kind: ActionRow['kind']; state: ActionRow['state'] } }
export const violationClasses = ['stranded-merge', 'failed-proof', 'stale-wait', 'stalled-action', 'unaccounted', 'unowned-action'] as const;
export type ViolationClass = typeof violationClasses[number];
export interface LivenessViolation {
  work: string; key: string; class: ViolationClass;
  /** When the item last had an obligation, as near as the record says, and how long ago that was. */
  since: string; ageMs: number;
  detail: string;
  /** The step the repair opens; null only when no rule names one. */
  successor: NextAction | null;
}
export interface Liveness { work: string; key: string; obligation: Obligation | null; violation: LivenessViolation | null }

export type Computed = Pick<ActionAccount, 'gate' | 'refusal' | 'action' | 'wait' | 'defect'>;
export const iso = (ms: number) => new Date(ms).toISOString();
export const heldSince = (work: Work) => work.stageEnteredAt ?? work.updatedAt;
export const liveLease = (work: Work, now: Date) => !!work.lease && Date.parse(work.lease.expiresAt) > now.getTime();
export const attend = (work: Work, trigger: string, reason: string, detail: string, binding: string, gate: string | null = null, refusal: string | null = null): NextAction =>
  ({ kind: 'attention', work: work.id, key: work.key, gate, refusal, reason, inputs: { kind: 'attention', trigger, detail }, llmRole: nextActionLlmRoles.attention, binding });

// ---- Rows as obligations ----------------------------------------------------------------------

/**
 * When a row on the queue is due. Every row there is owed by somebody — pending (or its claim
 * lapsed, so it is claimable), claimed, or settling — and one whose settle window has passed is
 * overdue rather than gone: the next evaluation reopens it while the item still needs it.
 *
 * Exported for the reconciliation's due instants (GY-1873): an evaluation keeps the earliest
 * instant its outcome could change with no write, and a row's claim, retry and settle window are
 * exactly such instants.
 */
export function rowDueAt(row: ActionRow, now: Date) {
  if (row.state === 'claimed' && claimLive(row, now)) return row.claim!.expiresAt;
  if (row.state === 'done') return iso(Date.parse(row.resolvedAt!) + actionSettleMs);
  if (waitingToRetry(row, now)) return row.retryAt!;
  return iso(Date.parse(row.requestedAt) + actionIdleMs);
}
export const openRow = (work: Work, id: string) => (work.actionQueue?.actions ?? []).find(row => row.id === id) ?? null;
/** The newest record of a row: the open one, else the last retired copy. */
export const latestRow = (work: Work, id: string) => (work.actionQueue?.actions ?? []).find(row => row.id === id)
  ?? [...(work.actionQueue?.history ?? [])].reverse().find(row => row.id === id) ?? null;
/**
 * The unchanged run of failures an action ended on, read across every copy of its row: a
 * conversion retires the row and a lifted one opens it afresh, so the retired copies and the open
 * one are one history, their cancellations and fresh requests set aside.
 */
export function failureRun(work: Work, id: string) {
  const copies = [...(work.actionQueue?.history ?? []), ...(work.actionQueue?.actions ?? [])].filter(row => row.id === id);
  if (!copies.length) return null;
  const history = copies.flatMap(row => row.history).filter(entry => entry.event !== 'cancelled' && entry.event !== 'requested');
  const run = actionStall({ ...copies.at(-1)!, history });
  return run && { ...run, lastAt: history.filter(entry => entry.event === 'failed').at(-1)!.at };
}

/**
 * When each stalled action on the item lifts back to its plain retry (GY-1873): the widest backoff
 * past the last failure of every run long enough to be escalated at all. While a stall stands the
 * derived action is the escalation itself, so the due reads the queue — open rows and retired
 * copies, which is where a stalled row lives — rather than the action; a run that has moved on (its
 * row completed, reopened, the situation changed) is no run, so only lifts still ahead come back.
 */
export function stalledActionLifts(work: Work): number[] {
  const lifts: number[] = [];
  for (const row of [...(work.actionQueue?.actions ?? []), ...(work.actionQueue?.history ?? [])]) {
    if (row.kind === 'attention') continue;
    const run = failureRun(work, row.id);
    if (run && run.failures >= livenessRetryLimit) lifts.push(Date.parse(run.lastAt) + actionStallMaxMs);
  }
  return lifts;
}

/**
 * When a wait is due, or null when what it names is gone. A wait on another item is due when that item's own step is.
 *
 * Exported for the reconciliation's due instants (GY-1873): the bound a held wait runs to is the
 * earliest instant the item's outcome could change with no write, beside the ones its lease and
 * queue rows name.
 */
export function waitDueAt(work: Work, wait: ActionWait, all: Work[], now: Date): string | null {
  if (wait.kind === 'session' && liveLease(work, now) && wait.on === work.lease!.owner) return work.lease!.expiresAt;
  if (wait.kind === 'dependency') {
    const other = all.find(item => item.key === wait.on);
    if (!other || other.stage === 'done') return null;
    if (liveLease(other, now)) return other.lease!.expiresAt;
    const rows = (other.actionQueue?.actions ?? []).map(row => rowDueAt(row, now)).sort();
    return rows[0] ?? now.toISOString();
  }
  if (wait.kind === 'human') return iso(Date.parse(heldSince(work)) + 24 * 60 * 60_000);
  // An observation window is due at its instant (GY-1698): past it the account names the dispatch, so the wait never stales.
  // GY-1779: a wait on the loop's own reading is owned by the loop, which records it or why it cannot each cycle; it is due a bound ahead of every evaluation and never stales.
  if (wait.kind === 'window') return wait.on === 'loop' ? iso(now.getTime() + livenessWaitBoundMs) : work.observationWindow?.notBefore ?? null;
  return iso(Math.max(Date.parse(heldSince(work)) + livenessWaitBoundMs, ...sessionObligations(work).map(entry => Date.parse(entry.at) + roleSessionMaximumMs[entry.role])));
}

/**
 * The review and proof obligations the head holds while the item waits: a request pending for it
 * and a session running on it. Each has its own clock — from the request or the session's start,
 * due by that role's session maximum (a producer's `producerTimeoutMinutes`) — so a wait they own
 * is not stale merely because the item entered its stage more than `livenessWaitBoundMs` ago.
 */
function sessionObligations(work: Work): { at: string; role: 'review' | 'proof' }[] {
  const head = work.candidate?.sha ?? null;
  const requests = [work.autoDispatch?.review, work.autoDispatch?.product, ...(work.autoDispatch?.producers ?? [])]
    .filter(request => !!request && request.state === 'requested' && request.sha === head)
    .map(request => ({ at: request!.requestedAt, role: request!.kind === 'producer' ? 'proof' as const : 'review' as const }));
  const sessions = (work.sessions ?? []).filter(handle => handle.state === 'running' && (handle.kind === 'review' || handle.kind === 'proof') && (!handle.head || handle.head === head))
    .map(handle => ({ at: handle.startedAt, role: handle.kind as 'review' | 'proof' }));
  return [...requests, ...sessions].filter(entry => Number.isFinite(Date.parse(entry.at)));
}
export const ownedWait = (wait: ActionWait) => wait.kind !== 'dependency';

// ---- Detection --------------------------------------------------------------------------------

export function classify(work: Work, all: Work[], now: Date, successor: NextAction | null): ViolationClass {
  if (!successor) return 'unaccounted';
  if (successor.kind === 'merge') return 'stranded-merge';
  if (successor.binding.startsWith('stalled:')) return 'stalled-action';
  if (successor.inputs.kind === 'attention' && successor.inputs.trigger === 'stale-wait') return 'stale-wait';
  if (successor.inputs.kind === 'attention' && successor.inputs.trigger === 'unaccounted') return 'unaccounted';
  if (work.candidate && producerGroupDecisions(work, all, now).some(decision => decision.state === 'failed')) return 'failed-proof';
  return 'unowned-action';
}

/** When the item last had an obligation, as near as the record says: the latest fact that could have ended one. */
export function lapsedAt(work: Work, now: Date) {
  const facts = [work.updatedAt, work.lease?.expiresAt, ...(work.actionQueue?.history ?? []).map(row => row.resolvedAt),
    ...(work.actionQueue?.actions ?? []).filter(row => row.state === 'done').map(row => row.resolvedAt && iso(Date.parse(row.resolvedAt) + actionSettleMs))]
    .filter((fact): fact is string => !!fact && Date.parse(fact) <= now.getTime());
  return facts.sort().at(-1) ?? now.toISOString();
}
