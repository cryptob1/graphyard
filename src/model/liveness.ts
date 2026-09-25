import { actionId, actionIdleMs, actionSettleMs, actionStall, claimLive, reconcileActions, waitingToRetry, type ActionRow } from './actions.js';
import { actionAccount } from './next-action.js';
import { nextActionLlmRoles, type NextAction, type NextActionInputs } from './action-kinds.js';
import type { ActionAccount, ActionWait } from './action-account.js';
import { producerGroupDecisions } from './mechanical-proofs.js';
import { redecidableScopeRefusal, routableScopeRequest, scopeRefusalBlocker } from './scope.js';
import type { Work } from './work.js';

/**
 * The liveness invariant (GY-201): every open item always has exactly one owned next step with a
 * deadline, and the server — not a loop re-deriving the world — keeps it that way.
 *
 * Correctness is enforced transactionally everywhere; liveness used to be left to whoever happened
 * to look next, so a guard that correctly refused became a terminal state in disguise: a merge
 * whose provider outcome was retained and never re-read, a failed proof nobody reworked, a scope
 * refusal nobody decided, a dispatch attempted 782 times for one unchanged reason. An item's
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
export const violationClasses = ['stranded-merge', 'failed-proof', 'refused-scope', 'stale-wait', 'stalled-action', 'unaccounted', 'unowned-action'] as const;
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

type Computed = Pick<ActionAccount, 'gate' | 'refusal' | 'action' | 'wait' | 'defect'>;
const iso = (ms: number) => new Date(ms).toISOString();
const heldSince = (work: Work) => work.stageEnteredAt ?? work.updatedAt;
const liveLease = (work: Work, now: Date) => !!work.lease && Date.parse(work.lease.expiresAt) > now.getTime();
const escalate = (work: Work, trigger: string, reason: string, detail: string, binding: string, gate: string | null = null, refusal: string | null = null): NextAction =>
  ({ kind: 'escalate', work: work.id, key: work.key, gate, refusal, reason, inputs: { kind: 'escalate', trigger, detail }, llmRole: nextActionLlmRoles.escalate, binding });

// ---- Rows as obligations ----------------------------------------------------------------------

/**
 * When a row on the queue is due. Every row there is owed by somebody — pending (or its claim
 * lapsed, so it is claimable), claimed, or settling — and one whose settle window has passed is
 * overdue rather than gone: the next evaluation reopens it while the item still needs it.
 */
function rowDueAt(row: ActionRow, now: Date) {
  if (row.state === 'claimed' && claimLive(row, now)) return row.claim!.expiresAt;
  if (row.state === 'done') return iso(Date.parse(row.resolvedAt!) + actionSettleMs);
  if (waitingToRetry(row, now)) return row.retryAt!;
  return iso(Date.parse(row.requestedAt) + actionIdleMs);
}
const openRow = (work: Work, id: string) => (work.actionQueue?.actions ?? []).find(row => row.id === id) ?? null;
/** The newest record of a row: the open one, else the last retired copy. */
const latestRow = (work: Work, id: string) => (work.actionQueue?.actions ?? []).find(row => row.id === id)
  ?? [...(work.actionQueue?.history ?? [])].reverse().find(row => row.id === id) ?? null;
/** The unchanged run of failures a row ended on, read past the cancellation that retired it. */
function failureRun(row: ActionRow) {
  const history = [...row.history];
  while (history.length && history[history.length - 1].event === 'cancelled') history.pop();
  return actionStall({ ...row, history });
}

// ---- The derivation's liveness rules ----------------------------------------------------------

/**
 * A row that failed `livenessRetryLimit` times for one unchanged reason is escalated instead of
 * retried. The escalation holds while the situation is the one that failed (same action id); it
 * lifts once its own row is completed after that run, or once the situation moves on.
 */
function stalledConversion(work: Work, action: NextAction): NextAction | null {
  const id = actionId(action.kind, work.id, action.binding);
  const row = latestRow(work, id);
  const run = row && action.kind !== 'escalate' ? failureRun(row) : null;
  if (!run || run.failures < livenessRetryLimit) return null;
  const binding = `stalled:${id}:${run.reason}`;
  const answered = latestRow(work, actionId('escalate', work.id, binding));
  if (answered?.result === 'done' && Date.parse(answered.resolvedAt!) >= Date.parse(row!.history.filter(entry => entry.event === 'failed').at(-1)!.at)) return null;
  return escalate(work, 'stalled-action', `${work.key}'s ${action.kind} failed ${run.failures} times in a row for one unchanged reason and is escalated rather than retried: ${run.reason}`,
    `${action.kind} failed ${run.failures} times since ${run.since}: ${run.reason}`, binding, action.gate, action.refusal);
}

/**
 * A refused scope request is owed a scope decision: the rule again when it would now approve;
 * otherwise one escalation row, the only one. For an additive request of the live attempt the loop
 * routes that row's judgement to an independent approver as a requirements decision (GY-176), so it
 * names that owner rather than a master; anything else is the master's.
 */
function scopeDecision(work: Work, action: NextAction, now: Date): NextAction | null {
  const request = work.scopeRequest;
  if (action.kind !== 'escalate' || action.gate !== 'ready' || !action.refusal?.startsWith(scopeRefusalBlocker) || request?.decision?.state !== 'refused') return null;
  if (redecidableScopeRefusal(work) && liveLease(work, now) && work.lease!.epoch === request.epoch)
    return { ...action, kind: 'approve-scope', reason: `${work.key}'s refused scope request would be approved by the rules as they stand; the control plane decides it again`,
      inputs: { kind: 'approve-scope', epoch: request.epoch, paths: [...request.paths], requestedBy: request.requestedBy, detail: request.reason }, llmRole: null, binding: `scope:${request.epoch}:${request.at}:redecide` };
  const decides = routableScopeRequest(work, now.getTime()) ? `the independent approver judges the requirements decision the loop requests for it (graphyard master decisions ${work.key}), which` : `graphyard master scope ${work.key}`;
  return escalate(work, 'scope', `${request.requestedBy}'s scope request on ${work.key} was refused and is owed a scope decision: ${request.decision.reason}`,
    `${decides} decides ${request.paths.join(', ')} (${request.reason}); refused because ${request.decision.reason}`, `scope-refused:${request.epoch}:${request.at}`, action.gate, action.refusal);
}

/** When a wait is due, or null when what it names is gone. A wait on another item is due when that item's own step is. */
function waitDueAt(work: Work, wait: ActionWait, all: Work[], now: Date): string | null {
  if (wait.kind === 'session' && liveLease(work, now) && wait.on === work.lease!.owner) return work.lease!.expiresAt;
  if (wait.kind === 'dependency' || wait.kind === 'queue') {
    const other = all.find(item => item.key === wait.on);
    if (!other || other.stage === 'done' || (wait.kind === 'queue' && !other.queue)) return null;
    if (liveLease(other, now)) return other.lease!.expiresAt;
    const rows = (other.actionQueue?.actions ?? []).map(row => rowDueAt(row, now)).sort();
    return rows[0] ?? now.toISOString();
  }
  return iso(Date.parse(heldSince(work)) + (wait.kind === 'human' ? 24 * 60 * 60_000 : livenessWaitBoundMs));
}
const ownedWait = (wait: ActionWait) => wait.kind !== 'dependency' && wait.kind !== 'queue';

/**
 * The liveness rules applied to what the derivation computed (`actionAccount` calls this): a
 * stalled row becomes an escalation and a refused scope request a scope decision. Everything else
 * passes through; a wait or a defect is judged by `livenessFallback`, which only the engine queues.
 */
export function livenessCarry(work: Work, computed: Computed, _all: Work[], now: Date): Computed {
  if (!computed.action) return computed;
  const next = stalledConversion(work, computed.action) ?? scopeDecision(work, computed.action, now);
  return next ? { ...computed, action: next } : computed;
}

/**
 * The successor for an open item the derivation names no action for and nothing moves: a defect,
 * a wait on an item that no longer holds it up, or a wait on an event nobody else owes that is
 * past its due time. The engine queues it beside the null action (`Engine.evaluate`), so the state
 * is owned by an escalation rather than reported and left; the derivation itself still reports
 * the wait or the defect it found, so every reader of `actionAccount` sees what the item is in.
 */
export function livenessFallback(work: Work, all: Work[], now: Date): NextAction | null {
  if (work.stage === 'done' || !work.ready) return null;
  const account = actionAccount(work, all, now);
  if (account.action) return null;
  if (account.defect) return escalate(work, 'unaccounted', `${work.key} has no rule naming its next step: ${account.defect}`, account.defect, `liveness:unaccounted:${account.defect}`, account.gate, account.refusal);
  const wait = account.wait;
  if (!wait || wait.kind === 'settled' && !work.candidate) return null;
  const due = waitDueAt(work, wait, all, now);
  if (due === null) return escalate(work, 'stale-wait', `${work.key} waits on ${wait.on}, which no longer holds it up: ${wait.detail}`, wait.detail, `liveness:stale-wait:${wait.kind}:${wait.on}`, account.gate, account.refusal);
  if (!ownedWait(wait) || Date.parse(due) > now.getTime()) return null;
  return escalate(work, 'stale-wait', `${work.key} has waited past ${due} on ${wait.on ?? 'nobody named'}: ${wait.detail}`,
    `${wait.kind} wait on ${wait.on ?? 'nobody named'} due ${due}: ${wait.detail}`, `liveness:stale-wait:${wait.kind}:${wait.on}:${heldSince(work)}`, account.gate, account.refusal);
}

// ---- Detection --------------------------------------------------------------------------------

/** A merge the broker committed to the provider and never saw observed: a fresh reading reconciles it. */
export function reconcileMergeAction(work: Work): NextAction {
  const execution = work.mergeExecution!;
  const inputs: NextActionInputs = { kind: 'resync', pr: work.candidate?.pr ?? work.submission?.pr ?? null, sha: execution.sha, baseSha: execution.baseSha, baseTip: work.observation?.baseTip ?? null, observedAt: work.observation?.at ?? null };
  return { kind: 'resync', work: work.id, key: work.key, gate: 'merge', refusal: null, llmRole: null, inputs, binding: `reconcile-merge:${execution.id}`,
    reason: `${work.key}'s merge execution ${execution.id} committed ${execution.sha.slice(0, 12)} to the provider and expired at ${execution.expiresAt} with the pull request still open; a fresh reading reconciles the provider outcome` };
}

function classify(work: Work, all: Work[], now: Date, successor: NextAction | null): ViolationClass {
  if (!successor) return 'unaccounted';
  if (successor.binding.startsWith('reconcile-merge:') || successor.kind === 'merge') return 'stranded-merge';
  if (successor.binding.startsWith('stalled:')) return 'stalled-action';
  if (successor.inputs.kind === 'escalate' && successor.inputs.trigger === 'stale-wait') return 'stale-wait';
  if (successor.inputs.kind === 'escalate' && successor.inputs.trigger === 'unaccounted') return 'unaccounted';
  if (work.scopeRequest?.decision?.state === 'refused' && work.blocker?.startsWith(scopeRefusalBlocker)) return 'refused-scope';
  if (work.candidate && producerGroupDecisions(work, all, now).some(decision => decision.state === 'failed')) return 'failed-proof';
  return 'unowned-action';
}

/** When the item last had an obligation, as near as the record says: the latest fact that could have ended one. */
function lapsedAt(work: Work, now: Date) {
  const facts = [work.updatedAt, work.lease?.expiresAt, ...(work.actionQueue?.history ?? []).map(row => row.resolvedAt),
    ...(work.actionQueue?.actions ?? []).filter(row => row.state === 'done').map(row => row.resolvedAt && iso(Date.parse(row.resolvedAt) + actionSettleMs))]
    .filter((fact): fact is string => !!fact && Date.parse(fact) <= now.getTime());
  return facts.sort().at(-1) ?? now.toISOString();
}

/** The one obligation an open item has now, or the violation that says it has none. */
export function livenessOf(work: Work, all: Work[], now: Date): Liveness {
  const base = { work: work.id, key: work.key };
  if (work.stage === 'done' || !work.ready) return { ...base, obligation: null, violation: null };
  const violation = (successor: NextAction | null, detail: string, since = lapsedAt(work, now)): Liveness =>
    ({ ...base, obligation: null, violation: { ...base, class: classify(work, all, now, successor), since, ageMs: Math.max(0, now.getTime() - Date.parse(since)), detail, successor } });
  const owned = (next: NextAction): Liveness | null => {
    const row = openRow(work, actionId(next.kind, work.id, next.binding));
    return row ? { ...base, violation: null, obligation: { kind: 'action', owner: row.claim?.executor ?? null, dueAt: rowDueAt(row, now), detail: next.reason, action: { id: row.id, kind: row.kind, state: row.state } } } : null;
  };
  // A merge execution is the broker's step while it holds; a committed one that outlived its
  // authority with the pull request still open is re-read, never guessed at (GY-195).
  const execution = work.mergeExecution;
  if (execution && (execution.committingAt || Date.parse(execution.expiresAt) > now.getTime())) {
    if (Date.parse(execution.expiresAt) > now.getTime() || work.observation?.merged)
      return { ...base, violation: null, obligation: { kind: 'wait', owner: execution.owner, dueAt: execution.expiresAt, detail: `merge execution ${execution.id} on ${execution.sha.slice(0, 12)}` } };
    const next = reconcileMergeAction(work);
    return owned(next) ?? violation(next, next.reason, execution.expiresAt);
  }
  // A lease that lapsed since the last tick is overdue, not gone: the reconciliation that runs
  // next clears it and names the step after it, exactly as it always has.
  if (work.lease && !liveLease(work, now))
    return { ...base, violation: null, obligation: { kind: 'session', owner: work.lease.owner, dueAt: work.lease.expiresAt, detail: `${work.lease.owner}'s lapsed epoch ${work.lease.epoch}, reclaimed by the next reconciliation` } };
  const account = actionAccount(work, all, now);
  if (account.action) return owned(account.action) ?? violation(account.action, `${work.key} needs ${account.action.kind} and no open row owns it: ${account.action.reason}`);
  const fallback = livenessFallback(work, all, now);
  if (fallback) return owned(fallback) ?? violation(fallback, fallback.reason);
  if (account.defect || !account.wait) return violation(null, account.defect ?? `${work.key} names no action and no wait`);
  const wait = account.wait;
  const dueAt = waitDueAt(work, wait, all, now)!;
  const session = wait.kind === 'session' && liveLease(work, now) && wait.on === work.lease!.owner;
  return { ...base, violation: null, obligation: { kind: session ? 'session' : 'wait', owner: wait.on, dueAt, detail: wait.detail } };
}

/** Every open item's violation, oldest first. */
export function livenessViolations(all: Work[], now: Date): LivenessViolation[] {
  return all.map(work => livenessOf(work, all, now).violation).filter((entry): entry is LivenessViolation => !!entry).sort((a, b) => b.ageMs - a.ageMs);
}

// ---- Repair -----------------------------------------------------------------------------------

/**
 * Keep the fresh reading owed by a committed merge execution that outlived its authority with the
 * pull request open (GY-195) on the queue, inside the caller's transaction. The reconciliation does
 * not re-evaluate an item a merge execution holds, so this is the only thing that opens the row,
 * and reopens it after each settle window until GitHub's observation reconciles the execution.
 */
export function repairLiveness(work: Work, all: Work[], now: Date) {
  const execution = work.mergeExecution;
  if (!execution?.committingAt || Date.parse(execution.expiresAt) > now.getTime() || work.observation?.merged) return [];
  return reconcileActions(work, all, now, { next: reconcileMergeAction(work) });
}

/** The ledger entry for a violation found at the start of a tick, judged against the item after it. */
export function livenessRepairEntry(found: LivenessViolation, work: Work, all: Work[], now: Date) {
  const after = livenessOf(work, all, now);
  const repaired = !after.violation && after.obligation;
  return { kind: repaired ? 'liveness.repaired' : 'liveness.violation', details: { class: found.class, since: found.since, ageMs: found.ageMs, detail: found.detail,
    successor: found.successor ? { kind: found.successor.kind, id: actionId(found.successor.kind, work.id, found.successor.binding), binding: found.successor.binding } : null,
    obligation: repaired ? after.obligation : null } };
}
