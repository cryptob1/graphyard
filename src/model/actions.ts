import { createHash } from 'node:crypto';
import { demand } from './refusal.js';
import { nextAction, type NextActionInputs, type NextActionKind } from './next-action.js';
import type { Work } from './work.js';

/**
 * The durable action queue.
 *
 * `nextAction` says what an item needs; this is the row that says whether anybody is doing it.
 * Rows live on the work aggregate, so they are written inside the same advisory-locked
 * coordination transaction as every other decision and inherit its durability, its ordering and
 * its idempotency receipts — there is no second store to keep consistent with the first.
 *
 * Three properties make stateless execution safe:
 *
 * - **Derived identity.** A row's id is a hash of what it binds (kind, item, binding), never of
 *   when it was made. The same situation always produces the same id, so a re-derivation after a
 *   restart recognises the row it already has instead of queueing a second one.
 * - **Leased claims.** An executor claims a row for a bounded time under its own identity. Only
 *   that claim may settle it. An executor that dies mid-action renews nothing, its claim expires,
 *   and the next executor takes the row as a further attempt — the dead one's late settlement is
 *   refused, so the work is never counted twice.
 * - **Complete history.** Every transition records who requested it, who executed it, what the
 *   result was and why, in order, on the row itself.
 *
 * Nothing here decides a gate. A row is a fact about what is outstanding.
 */

export const actionStates = ['pending', 'claimed', 'done'] as const;
export type ActionState = typeof actionStates[number];
export type ActionEvent = 'requested' | 'claimed' | 'reclaimed' | 'completed' | 'failed' | 'cancelled' | 'reopened';

export interface ActionClaim {
  /** The executor identity and the host it runs on; two executors never share a claim. */
  executor: string; host: string;
  claimedAt: string; expiresAt: string;
  /** Which attempt this claim is: a reclaimed row is claimed again as the next attempt. */
  attempt: number;
}
export interface ActionRecord {
  at: string; event: ActionEvent;
  requester: string; executor: string | null;
  result: string | null; reason: string;
}
export interface ActionRow {
  id: string; kind: NextActionKind;
  /** The item the action is about, by id and key. */
  work: string; key: string;
  inputs: NextActionInputs;
  gate: string | null; refusal: string | null; reason: string; binding: string;
  requestedBy: string; requestedAt: string;
  state: ActionState; claim: ActionClaim | null; attempts: number;
  /** A failed attempt waits this long before the row is offered again. */
  retryAt?: string;
  resolvedAt?: string; result?: 'done' | 'failed'; resolution?: string;
  history: ActionRecord[];
}
export interface ActionQueue { actions: ActionRow[]; history: ActionRow[] }
export interface ActionTransition { event: ActionEvent; action: ActionRow }

export const actionHistoryLimit = 50, actionRecordLimit = 20;
/** How long a claim holds a row before another executor may take it. */
export const actionClaimMs = 120_000;
/**
 * How long a completed action holds its situation before the row is offered again. An action's
 * effect is not instant — a launched session has to claim, a provider call has to be observed —
 * and re-running it inside that window would double the effect. After it, a situation that still
 * stands is a situation the action did not fix, and another attempt is owed.
 */
export const actionSettleMs = 10 * 60_000;
/** A failed attempt backs off on a widening interval, never below the first step or above the last. */
export const actionRetryMinMs = 30_000, actionRetryMaxMs = 10 * 60_000;
/** A row nobody has claimed for longer than this is idle while it is actionable; see `idleActionable`. */
export const actionIdleMs = 5 * 60_000;

export const actionId = (kind: NextActionKind, workId: string, binding: string) =>
  createHash('sha256').update(['action', kind, workId, binding].join('\0')).digest('hex').slice(0, 32);
export const actionRetryDelay = (attempts: number) => Math.min(actionRetryMinMs * 2 ** Math.max(0, attempts - 1), actionRetryMaxMs);

const record = (row: ActionRow, entry: ActionRecord) => { row.history = [...row.history, entry].slice(-actionRecordLimit); };
const claimLive = (row: ActionRow, now: Date) => !!row.claim && Date.parse(row.claim.expiresAt) > now.getTime();
const settling = (row: ActionRow, now: Date) => row.state === 'done' && !!row.resolvedAt && now.getTime() - Date.parse(row.resolvedAt) < actionSettleMs;
const waitingToRetry = (row: ActionRow, now: Date) => !!row.retryAt && Date.parse(row.retryAt) > now.getTime();
/** A row an executor may take now: open, out of backoff, and not inside a completed action's settle window. */
export const claimable = (row: ActionRow, now: Date) => !settling(row, now) && !waitingToRetry(row, now) && (row.state === 'pending' || !claimLive(row, now));

/** The queue as it stands, created on first use so legacy documents gain one at their next evaluation. */
export function actionQueue(work: Work): ActionQueue {
  work.actionQueue ??= { actions: [], history: [] };
  work.actionQueue.actions ??= [];
  work.actionQueue.history ??= [];
  return work.actionQueue;
}

/**
 * Bring the item's rows in line with what it needs now, and say what changed.
 *
 * Pure over the item, its graph and the clock. A situation that has not changed reconciles to the
 * same row; one that has retires the row that no longer applies — naming what moved — and opens
 * the row that does. An expired claim returns its row to `pending` without losing the attempt
 * count, which is what makes a dead executor cost one attempt rather than the action.
 */
export function reconcileActions(work: Work, all: Work[], now: Date, requester = 'graphyard'): ActionTransition[] {
  const queue = actionQueue(work);
  const at = now.toISOString();
  const transitions: ActionTransition[] = [];
  const retire = (row: ActionRow, reason: string) => {
    const resolved: ActionRow = { ...row, claim: null, resolvedAt: row.resolvedAt ?? at, resolution: row.resolution ?? reason };
    queue.history = [...queue.history, resolved].slice(-actionHistoryLimit);
    // A row that completed is history the moment its situation moves on; only an unfinished
    // one is cancelled, and then the reason says what replaced it.
    if (row.state === 'done') return;
    record(resolved, { at, event: 'cancelled', requester: row.requestedBy, executor: row.claim?.executor ?? null, result: null, reason });
    transitions.push({ event: 'cancelled', action: resolved });
  };
  const next = nextAction(work, all, now);
  const wanted = next ? actionId(next.kind, work.id, next.binding) : null;

  const kept: ActionRow[] = [];
  for (const row of queue.actions) {
    if (row.id !== wanted) { retire(row, next ? `${work.key} now needs ${next.kind} instead: ${next.reason}` : `${work.key} no longer needs this action`); continue; }
    // The claim of an executor that stopped renewing is released; the row stays open.
    if (row.state === 'claimed' && !claimLive(row, now)) {
      const executor = row.claim!.executor;
      row.state = 'pending'; row.claim = null;
      record(row, { at, event: 'reclaimed', requester: row.requestedBy, executor, result: null, reason: `claim by ${executor} expired without a result; the action is open for another executor` });
      transitions.push({ event: 'reclaimed', action: row });
    }
    // A completed action whose situation outlived its settle window did not fix it; owe another.
    if (row.state === 'done' && !settling(row, now)) {
      row.state = 'pending'; row.claim = null; delete row.retryAt;
      const reason = `${row.kind} completed at ${row.resolvedAt} (${row.resolution ?? 'no result recorded'}) and ${work.key} still needs it`;
      record(row, { at, event: 'reopened', requester: row.requestedBy, executor: null, result: null, reason });
      transitions.push({ event: 'reopened', action: row });
    }
    kept.push(row);
  }
  queue.actions = kept;

  if (next && !queue.actions.some(row => row.id === wanted)) {
    const row: ActionRow = {
      id: wanted!, kind: next.kind, work: work.id, key: work.key, inputs: next.inputs,
      gate: next.gate, refusal: next.refusal, reason: next.reason, binding: next.binding,
      requestedBy: requester, requestedAt: at, state: 'pending', claim: null, attempts: 0, history: [],
    };
    record(row, { at, event: 'requested', requester, executor: null, result: null, reason: next.reason });
    queue.actions.push(row);
    transitions.push({ event: 'requested', action: row });
  }
  return transitions;
}

/** Every row an executor may take now, oldest request first, so the queue is served fairly. */
export function openActions(all: Work[], now: Date, kinds?: readonly NextActionKind[]): { work: Work; row: ActionRow }[] {
  return all.flatMap(work => (work.actionQueue?.actions ?? [])
    .filter(row => claimable(row, now) && (!kinds || kinds.includes(row.kind)))
    .map(row => ({ work, row })))
    .sort((a, b) => Date.parse(a.row.requestedAt) - Date.parse(b.row.requestedAt) || a.row.id.localeCompare(b.row.id));
}

/**
 * Claim the oldest open row this executor can run, under a bounded lease.
 *
 * Called inside the coordination transaction, so two executors reading the same queue at the same
 * instant are serialized: the first writes the claim, the second sees it and takes the next row.
 * Neither knows the other exists, which is the point — executors coordinate through the record.
 */
export function claimAction(all: Work[], executor: { id: string; host: string }, now: Date, options: { kinds?: readonly NextActionKind[]; leaseMs?: number; work?: string } = {}): { work: Work; row: ActionRow } | null {
  const entry = openActions(all, now, options.kinds).find(candidate => !options.work || candidate.work.id === options.work || candidate.work.key === options.work);
  if (!entry) return null;
  const { work, row } = entry;
  const at = now.toISOString();
  const superseded = row.state === 'claimed' ? row.claim?.executor ?? null : null;
  if (superseded) record(row, { at, event: 'reclaimed', requester: row.requestedBy, executor: superseded, result: null, reason: `claim by ${superseded} expired without a result` });
  row.attempts += 1;
  row.state = 'claimed';
  delete row.retryAt;
  row.claim = { executor: executor.id, host: executor.host, claimedAt: at, expiresAt: new Date(now.getTime() + (options.leaseMs ?? actionClaimMs)).toISOString(), attempt: row.attempts };
  record(row, { at, event: 'claimed', requester: row.requestedBy, executor: executor.id, result: null, reason: `attempt ${row.attempts} claimed by ${executor.id} on ${executor.host}` });
  return { work, row };
}

/**
 * Record what an executor's attempt did. Only the live claim may settle its row: a claim that
 * expired and was taken by another executor can no longer report a result, so an executor that
 * comes back from the dead cannot overwrite the attempt that replaced it, and no action is
 * counted twice.
 */
export function settleAction(work: Work, id: string, executor: string, result: 'done' | 'failed', reason: string, now: Date): ActionTransition {
  const row = work.actionQueue?.actions.find(entry => entry.id === id);
  demand(row, 'Action is not open on this work item', 404);
  demand(row!.state === 'claimed' && row!.claim, 'Action is not claimed', 409);
  demand(row!.claim!.executor === executor, `Action is claimed by ${row!.claim!.executor}; a superseded executor cannot settle it`, 409);
  demand(claimLive(row!, now), 'Action claim expired; another executor may already be running it', 409);
  const at = now.toISOString();
  const event: ActionEvent = result === 'done' ? 'completed' : 'failed';
  row!.state = result === 'done' ? 'done' : 'pending';
  row!.claim = null;
  row!.resolvedAt = at; row!.result = result; row!.resolution = reason;
  // A completed action holds its situation while its effect lands; a failed one backs off.
  if (result === 'failed') row!.retryAt = new Date(now.getTime() + actionRetryDelay(row!.attempts)).toISOString();
  else delete row!.retryAt;
  record(row!, { at, event, requester: row!.requestedBy, executor, result, reason });
  return { event, action: row! };
}

export interface QueueSnapshot {
  pending: number; claimed: number; settling: number; completed: number;
  byKind: Record<string, number>;
  /** Rows nobody is running, oldest first, with how long they have waited. */
  waiting: { key: string; work: string; id: string; kind: NextActionKind; reason: string; waitedMs: number; attempts: number; lastFailure: string | null }[];
  /** The longest an open row has gone unclaimed; null when nothing is open. */
  oldestPendingMs: number | null;
  executors: { executor: string; host: string; actions: number }[];
}

/** What the queue holds right now, for master status, the dashboard and the throughput measurement. */
export function queueSnapshot(all: Work[], now: Date): QueueSnapshot {
  const rows = all.flatMap(work => (work.actionQueue?.actions ?? []).map(row => ({ work, row })));
  const byKind: Record<string, number> = {};
  for (const { row } of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
  const waiting = rows.filter(({ row }) => claimable(row, now))
    .map(({ row }) => ({ key: row.key, work: row.work, id: row.id, kind: row.kind, reason: row.reason, waitedMs: Math.max(0, now.getTime() - Date.parse(row.requestedAt)), attempts: row.attempts, lastFailure: row.result === 'failed' ? row.resolution ?? null : null }))
    .sort((a, b) => b.waitedMs - a.waitedMs);
  const executors = new Map<string, { executor: string; host: string; actions: number }>();
  for (const { row } of rows) {
    if (!claimLive(row, now)) continue;
    const key = `${row.claim!.executor}@${row.claim!.host}`;
    const entry = executors.get(key) ?? { executor: row.claim!.executor, host: row.claim!.host, actions: 0 };
    entry.actions += 1; executors.set(key, entry);
  }
  return {
    pending: waiting.length,
    claimed: rows.filter(({ row }) => claimLive(row, now)).length,
    settling: rows.filter(({ row }) => settling(row, now)).length,
    completed: all.reduce((total, work) => total + (work.actionQueue?.history ?? []).filter(row => row.result === 'done').length, 0)
      + rows.filter(({ row }) => row.state === 'done').length,
    byKind, waiting, oldestPendingMs: waiting.length ? waiting[0].waitedMs : null,
    executors: [...executors.values()].sort((a, b) => a.executor.localeCompare(b.executor)),
  };
}

/**
 * Items that have something to do and nobody doing it, for longer than the bound.
 *
 * This is the measurement the inversion is for: under a master session an item sat idle whenever
 * the loop had no step for its situation. With the control plane naming the action, an idle item
 * is always an unclaimed row, and this reports exactly those.
 */
export function idleActionable(all: Work[], now: Date, thresholdMs = actionIdleMs) {
  return queueSnapshot(all, now).waiting.filter(entry => entry.waitedMs > thresholdMs);
}
