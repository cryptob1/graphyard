import { createHash } from 'node:crypto';
import { demand } from './refusal.js';
import { actionRetryAt, actionSettleMs, actionStall, claimable, claimLive, settling, type ActionStall } from './action-progress.js';
import { nextAction, sameAction, type NextAction, type NextActionInputs, type NextActionKind } from './next-action.js';
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
 * - **Leased claims.** An executor claims a row for a bounded time under its own identity and the
 *   credential it holds. Only that claim may settle it. An executor that dies mid-action renews
 *   nothing, its claim expires, and the next executor takes the row as a further attempt — the
 *   dead one's late settlement is refused, so the work is never counted twice. Naming another
 *   executor's identity settles nothing either: the credential on the claim has to match too.
 * - **Complete history.** Every transition records who requested it, who executed it, what the
 *   result was and why, in order, on the row itself.
 *
 * Nothing here decides a gate. A row is a fact about what is outstanding.
 */

export * from './action-progress.js';

export const actionStates = ['pending', 'claimed', 'done'] as const;
export type ActionState = typeof actionStates[number];
export type ActionEvent = 'requested' | 'claimed' | 'reclaimed' | 'completed' | 'failed' | 'cancelled' | 'reopened';

export interface ActionClaim {
  /** The executor identity and the host it runs on; two executors never share a claim. */
  executor: string; host: string;
  /**
   * The credential the claim was made with. `executor` is a name the executor asserts — several
   * executors may run behind one coordinator credential — so the identity alone cannot decide who
   * may settle. Only the same credential, naming the same executor, may report the result.
   */
  principal: string;
  claimedAt: string; expiresAt: string;
  /**
   * When the executor last said it was still running the action, and how often it has said so. A
   * claim is a short lease precisely so a dead executor loses it quickly; a live one that is
   * simply slow keeps it by renewing, which is what stops a handler outliving its lease from
   * being run a second time beside the first.
   */
  renewedAt?: string; renewals?: number;
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
  /**
   * Set while the row's last attempts failed for one unchanged reason: it is stalling rather than
   * retrying (`actionStall`). The row carries it so every reader of a row — the queue snapshot,
   * `master status`, the dashboard card — says the same thing without re-deriving it, and
   * `actionStall` recomputes it from the history so the two can never disagree.
   */
  stall?: ActionStall;
  resolvedAt?: string; result?: 'done' | 'failed'; resolution?: string;
  history: ActionRecord[];
}
export interface ActionQueue { actions: ActionRow[]; history: ActionRow[] }
export interface ActionTransition { event: ActionEvent; action: ActionRow }

export const actionHistoryLimit = 50, actionRecordLimit = 20;
/** How long a claim holds a row before another executor may take it. */
export const actionClaimMs = 120_000;
/**
 * How often an executor tells the control plane it is still inside the handler.
 *
 * The claim is deliberately short, so a dead executor's row is offered again within two minutes.
 * Handlers are not bounded by that: a dispatch prepares a worktree and waits on a runtime, and a
 * guarded merge chains several provider calls with their own timeouts. An executor that is still
 * running renews at this interval — comfortably inside the lease, so a renewal may be lost and
 * the next one still arrives in time — and one that stopped renews nothing and loses the row.
 */
export const actionRenewIntervalMs = 30_000;

export const actionId = (kind: NextActionKind, workId: string, binding: string) =>
  createHash('sha256').update(['action', kind, workId, binding].join('\0')).digest('hex').slice(0, 32);

const record = (row: ActionRow, entry: ActionRecord) => { row.history = [...row.history, entry].slice(-actionRecordLimit); };

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
export function reconcileActions(work: Work, all: Work[], now: Date, options: { requester?: string; next?: NextAction | null } = {}): ActionTransition[] {
  const requester = options.requester ?? 'graphyard';
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
  // The caller may have computed the action already — an evaluation writes it onto the item as
  // well as reconciling the queue — and the same snapshot always names the same action, so it is
  // taken rather than computed a second time.
  const next = 'next' in options ? options.next ?? null : nextAction(work, all, now);
  const wanted = next ? actionId(next.kind, work.id, next.binding) : null;

  const kept: ActionRow[] = [];
  for (const row of queue.actions) {
    if (row.id !== wanted) {
      // An executor holding a live claim still owes a result, and running the action is itself
      // what moved the situation on. Retiring the row under it would leave that settlement with
      // nothing to land on — every completed action recorded as a failure, and the history that
      // says who ran what lost. The row is kept until it settles or its claim expires; the row
      // the item now needs is opened beside it, and `claimable` keeps this one out of the queue.
      if (row.state === 'claimed' && claimLive(row, now)) { kept.push(row); continue; }
      retire(row, next ? `${work.key} now needs ${next.kind} instead: ${next.reason}` : `${work.key} no longer needs this action`);
      continue;
    }
    // The claim of an executor that stopped renewing is released; the row stays open.
    if (row.state === 'claimed' && !claimLive(row, now)) {
      const executor = row.claim!.executor;
      row.state = 'pending'; row.claim = null;
      record(row, { at, event: 'reclaimed', requester: row.requestedBy, executor, result: null, reason: `claim by ${executor} expired without a result; the action is open for another executor` });
      transitions.push({ event: 'reclaimed', action: row });
    }
    // A completed action whose situation outlived its settle window did not fix it; owe another.
    if (row.state === 'done' && !settling(row, now)) {
      row.state = 'pending'; row.claim = null; delete row.retryAt; delete row.stall;
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

/**
 * Bring a delivered item's queue in line with what it still owes (GY-185).
 *
 * An item becomes done inside the transaction that observed its merge, after that transaction's
 * evaluation named the merge it was about to need; nothing evaluated it again, so it kept that
 * action, its merge and dispatch rows and its merge-queue entry, and executors retried them against
 * a delivery that refuses every one. Every path that delivers an item calls this in the same
 * transaction: the next action is recomputed — the deployment it owes, or nothing — every row that
 * is not that action is retired, and the queue entry, which only an undelivered candidate holds, is
 * cleared. A row an executor holds a live claim on is kept until it settles, as everywhere else,
 * and the settlement calls this again. Returns whether anything changed, including a completed row
 * retired to history, which reports no transition.
 */
export function settleDelivered(work: Work, all: Work[], now: Date): boolean {
  if (work.stage !== 'done') return false;
  const computed = nextAction(work, all, now);
  // A completed row is moved to history without a transition, so the rows themselves are compared:
  // a cleanup that only retires completed rows must still be saved, or every pass repeats it.
  const rows = (work.actionQueue?.actions ?? []).map(row => row.id).join();
  let changed = reconcileActions(work, all, now, { next: computed }).length > 0 || actionQueue(work).actions.map(row => row.id).join() !== rows;
  if (work.nextAction === undefined || !sameAction(work.nextAction, computed)) { work.nextAction = computed; changed = true; }
  if (work.queue) { work.queue = null; changed = true; }
  return changed;
}

/**
 * The ids of the items holding a row an executor may take now, found in SQL without loading a
 * document: the SQL form of `openActions` (`claimable`, the delivered-item rule, the kinds and the
 * item filter) over the stored rows, read at the database clock. An idle poll answers from this
 * alone; a poll that finds candidates loads only those documents, and `claimAction` decides again
 * under the lock, so a row that changed in between is simply not taken.
 */
export const claimCandidatesSql = `SELECT w.id FROM work_items w
  WHERE ($1::text IS NULL OR w.id::text = $1 OR w.document->>'key' = $1)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.document->'actionQueue'->'actions') = 'array' THEN w.document->'actionQueue'->'actions' ELSE '[]'::jsonb END) AS a(entry)
      WHERE (w.document->>'stage' IS DISTINCT FROM 'done' OR entry->>'kind' = 'verify-deployment')
        AND ($2::text[] IS NULL OR entry->>'kind' = ANY($2::text[]))
        AND (entry->>'retryAt' IS NULL OR (entry->>'retryAt')::timestamptz <= clock_timestamp())
        AND NOT (entry->>'state' = 'done' AND entry->>'resolvedAt' IS NOT NULL AND (entry->>'resolvedAt')::timestamptz > clock_timestamp() - make_interval(secs => $3::double precision / 1000))
        AND (entry->>'state' = 'pending' OR jsonb_typeof(entry->'claim') IS DISTINCT FROM 'object' OR (entry->'claim'->>'expiresAt')::timestamptz <= clock_timestamp()))
  ORDER BY w.number`;
export const claimCandidatesParams = (work: string | undefined, kinds: readonly NextActionKind[] | undefined) => [work ?? null, kinds ? [...kinds] : null, actionSettleMs];

/**
 * Every row an executor may take now, oldest request first, so the queue is served fairly.
 *
 * A delivered item owes nothing an executor can run but the deployment that carries it: whatever
 * else it still holds is left over from before it was delivered, and running it is refused every
 * time (GY-185). Only its `verify-deployment` row is offered; the rest wait to be retired.
 */
export function openActions(all: Work[], now: Date, kinds?: readonly NextActionKind[]): { work: Work; row: ActionRow }[] {
  return all.flatMap(work => (work.actionQueue?.actions ?? [])
    .filter(row => work.stage !== 'done' || row.kind === 'verify-deployment')
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
export function claimAction(all: Work[], executor: { id: string; host: string; principal: string }, now: Date, options: { kinds?: readonly NextActionKind[]; leaseMs?: number; work?: string } = {}): { work: Work; row: ActionRow } | null {
  const entry = openActions(all, now, options.kinds).find(candidate => !options.work || candidate.work.id === options.work || candidate.work.key === options.work);
  if (!entry) return null;
  const { work, row } = entry;
  const at = now.toISOString();
  const superseded = row.state === 'claimed' ? row.claim?.executor ?? null : null;
  if (superseded) record(row, { at, event: 'reclaimed', requester: row.requestedBy, executor: superseded, result: null, reason: `claim by ${superseded} expired without a result` });
  row.attempts += 1;
  row.state = 'claimed';
  delete row.retryAt;
  row.claim = { executor: executor.id, host: executor.host, principal: executor.principal, claimedAt: at, expiresAt: new Date(now.getTime() + (options.leaseMs ?? actionClaimMs)).toISOString(), attempt: row.attempts };
  record(row, { at, event: 'claimed', requester: row.requestedBy, executor: executor.id, result: null, reason: `attempt ${row.attempts} claimed by ${executor.id} on ${executor.host}` });
  return { work, row };
}

/**
 * Extend the live claim of the executor that is still running the action.
 *
 * The same ownership rules as settling: only the executor named on the claim, holding the
 * credential the claim was made with, while the claim is still live. A renewal is a statement
 * that the handler has not finished, so it never changes the attempt, the state or the history —
 * the claim simply holds for another lease.
 */
export function renewClaim(work: Work, id: string, renewer: { executor: string; principal: string }, now: Date, leaseMs = actionClaimMs): ActionRow {
  const { executor, principal } = renewer;
  const row = work.actionQueue?.actions.find(entry => entry.id === id);
  demand(row, 'Action is not open on this work item', 404);
  demand(row!.state === 'claimed' && row!.claim, 'Action is not claimed', 409);
  demand(row!.claim!.executor === executor, `Action is claimed by ${row!.claim!.executor}; a superseded executor cannot renew it`, 409);
  demand((row!.claim!.principal ?? principal) === principal, `Action was claimed with the credential of ${row!.claim!.principal}; another credential cannot renew it`, 409);
  // A claim that already expired may have been taken by another executor; renewing it here would
  // put two executors inside one action, which is the thing the lease exists to prevent.
  demand(claimLive(row!, now), 'Action claim expired; another executor may already be running it', 409);
  row!.claim!.expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  row!.claim!.renewedAt = now.toISOString();
  row!.claim!.renewals = (row!.claim!.renewals ?? 0) + 1;
  return row!;
}

/**
 * Record what an executor's attempt did. Only the live claim may settle its row: a claim that
 * expired and was taken by another executor can no longer report a result, so an executor that
 * comes back from the dead cannot overwrite the attempt that replaced it, and no action is
 * counted twice.
 */
export function settleAction(work: Work, id: string, settler: { executor: string; principal: string }, result: 'done' | 'failed', reason: string, now: Date): ActionTransition {
  const { executor, principal } = settler;
  const row = work.actionQueue?.actions.find(entry => entry.id === id);
  demand(row, 'Action is not open on this work item', 404);
  demand(row!.state === 'claimed' && row!.claim, 'Action is not claimed', 409);
  demand(row!.claim!.executor === executor, `Action is claimed by ${row!.claim!.executor}; a superseded executor cannot settle it`, 409);
  // The credential that claimed is the one that reports. An executor identity is self-asserted,
  // so without this any coordinator could settle another executor's claim by naming it.
  demand((row!.claim!.principal ?? principal) === principal, `Action was claimed with the credential of ${row!.claim!.principal}; another credential cannot settle it`, 409);
  demand(claimLive(row!, now), 'Action claim expired; another executor may already be running it', 409);
  const at = now.toISOString();
  const event: ActionEvent = result === 'done' ? 'completed' : 'failed';
  row!.state = result === 'done' ? 'done' : 'pending';
  row!.claim = null;
  row!.resolvedAt = at; row!.result = result; row!.resolution = reason;
  // The attempt is on the history before the row is judged: what it failed with is part of what
  // says whether this row is retrying or stalling.
  record(row!, { at, event, requester: row!.requestedBy, executor, result, reason });
  // A completed action holds its situation while its effect lands; a failed one backs off — on a
  // widening interval while its failures change, on a fixed recheck once they stop changing.
  if (result === 'failed') {
    const stall = actionStall(row!);
    if (stall) row!.stall = stall; else delete row!.stall;
    row!.retryAt = actionRetryAt(row!, now);
  } else { delete row!.retryAt; delete row!.stall; }
  return { event, action: row! };
}
