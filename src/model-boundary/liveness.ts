import type { Work } from '../model/work.js';
import type { NextAction } from '../model/action-kinds.js';
import { actionId } from './actions.js';
import { failureRun, livenessRetryLimit, latestRow, attend, iso, type Computed, waitDueAt, ownedWait, heldSince, type Liveness, lapsedAt, classify, openRow, rowDueAt, liveLease, type LivenessViolation } from '../model/liveness.js';
import { actionStallMaxMs } from '../model/action-progress.js';
import type { ActionAccount } from '../model/action-account.js';
import { actionAccount } from './next-action.js';
// ---- The derivation's liveness rules ----------------------------------------------------------

/**
 * A row that failed `livenessRetryLimit` times for one unchanged reason is escalated instead of
 * retried. The escalation holds while the situation is the one that failed (same action id) and its
 * last failure is younger than the longest stall backoff (`actionStallMaxMs`); it lifts once its
 * own row is completed after that run, once the situation moves on, or once that backoff has
 * passed. A lifted conversion retries the action once: an identical failure escalates it again at
 * once, anything else ends the run. So an escalated action is still attempted on the widest
 * backoff, and a condition that clears — a deployment incident ending — is found by the retry.

 */
function stalledConversion(work: Work, action: NextAction, now: Date): NextAction | null {
  if (action.kind === 'attention') return null;
  const id = actionId(action.kind, work.id, action.binding);
  const run = failureRun(work, id);
  if (!run) return null;
  if (run.failures < livenessRetryLimit || now.getTime() - Date.parse(run.lastAt) >= actionStallMaxMs) return null;
  const binding = `stalled:${id}:${run.reason}`;
  const answered = latestRow(work, actionId('attention', work.id, binding));
  if (answered?.result === 'done' && Date.parse(answered.resolvedAt!) >= Date.parse(run.lastAt)) return null;
  return attend(work, 'stalled-action', `${work.key}'s ${action.kind} failed ${run.failures} times in a row for one unchanged reason and is escalated rather than retried until ${iso(Date.parse(run.lastAt) + actionStallMaxMs)}: ${run.reason}`,
    `${action.kind} failed ${run.failures} times since ${run.since}: ${run.reason}`, binding, action.gate, action.refusal);
}

/**
 * The liveness rules applied to what the derivation computed (`actionAccount` calls this): a
 * stalled row becomes an escalation. Everything else
 * passes through; a wait or a defect is judged by `livenessFallback`, which only the engine queues.
 */
export function livenessCarry(work: Work, computed: Computed, _all: Work[], now: Date): Computed {
  if (!computed.action) return computed;
  const next = stalledConversion(work, computed.action, now);
  return next ? { ...computed, action: next } : computed;
}

/**
 * The successor for an open item the derivation names no action for and nothing moves: a defect,
 * a wait on an item that no longer holds it up, or a wait on an event nobody else owes that is
 * past its due time. The engine queues it beside the null action (`Engine.evaluate`), so the state
 * is owned by an escalation rather than reported and left; the derivation itself still reports
 * the wait or the defect it found, so every reader of `actionAccount` sees what the item is in.
 * `computed` hands over the account the caller already ran (GY-1873): the engine's evaluation runs
 * the derivation once, and the fallback judges that account rather than computing it again.
 */
export function livenessFallback(work: Work, all: Work[], now: Date, computed?: ActionAccount): NextAction | null {
  if (work.stage === 'done' || !work.ready) return null;
  const account = computed ?? actionAccount(work, all, now);
  if (account.action) return null;
  if (account.defect) return attend(work, 'unaccounted', `${work.key} has no rule naming its next step: ${account.defect}`, account.defect, `liveness:unaccounted:${account.defect}`, account.gate, account.refusal);
  const wait = account.wait;
  if (!wait || wait.kind === 'settled' && !work.candidate) return null;
  const due = waitDueAt(work, wait, all, now);
  if (due === null) return attend(work, 'stale-wait', `${work.key} waits on ${wait.on}, which no longer holds it up: ${wait.detail}`, wait.detail, `liveness:stale-wait:${wait.kind}:${wait.on}`, account.gate, account.refusal);
  if (!ownedWait(wait) || Date.parse(due) > now.getTime()) return null;
  return attend(work, 'stale-wait', `${work.key} has waited past ${due} on ${wait.on ?? 'nobody named'}: ${wait.detail}`,
    `${wait.kind} wait on ${wait.on ?? 'nobody named'} due ${due}: ${wait.detail}`, `liveness:stale-wait:${wait.kind}:${wait.on}:${heldSince(work)}`, account.gate, account.refusal);
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

// ---- Repair -----------------------------------------------------------------------------------

/** The ledger entry for a violation found at the start of a tick, judged against the item after it. */
export function livenessRepairEntry(found: LivenessViolation, work: Work, all: Work[], now: Date) {
  const after = livenessOf(work, all, now);
  const repaired = !after.violation && after.obligation;
  return { kind: repaired ? 'liveness.repaired' : 'liveness.violation', details: { class: found.class, since: found.since, ageMs: found.ageMs, detail: found.detail,
    successor: found.successor ? { kind: found.successor.kind, id: actionId(found.successor.kind, work.id, found.successor.binding), binding: found.successor.binding } : null,
    obligation: repaired ? after.obligation : null } };
}
