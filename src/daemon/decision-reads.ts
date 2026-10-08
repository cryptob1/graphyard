// Concern: the decision histories the decisions step reads, kept across cycles (GY-1142).
import type { Work } from '../model.js';
import { approvalApplyGraceMs, situationLabel, stalledApproval, supersededSituation, type DecisionSituation } from '../model/approval.js';
import { routableScopeRequest } from '../model/scope.js';
import type { ApprovalWatch, DaemonAction, DaemonState } from './state.js';
import type { FaultKind } from '../model/fault-classes.js';
import { planeUnavailableText } from '../model/refusal.js';
import type { DaemonEffects } from './effects.js';
import { staleReleaseCandidates } from '../model/stale-release.js';

/** Every kind the control plane folds an item's decision history from (server/decision-ledger.ts). */
export const decisionEventKinds = ['requested', 'concurred', 'refused', 'declined', 'approved', 'applied', 'failed', 'stale', 'withdrawn', 'superseded'].map(kind => `decision.${kind}`);
type DecisionHistory = Awaited<ReturnType<NonNullable<DaemonEffects['decisions']>>>['decisions'];
/** The decision histories the loop keeps across cycles, by work id, and the ledger seq they are current to. */
export interface HeldDecisions { seq: string | null; histories: Map<string, DecisionHistory>; refreshedAt: number | null }
export const emptyHeldDecisions = (): HeldDecisions => ({ seq: null, histories: new Map(), refreshedAt: null });
/** How many history reads the decisions step has in flight at once. */
export const decisionReadConcurrency = 8;
/** How long the decisions step's control-plane reads may take in all, from the step's start (GY-1241). */
export const decisionReadDeadlineMs = 10_000;
/**
 * GY-1293. A request that failed only because its history read missed the step's deadline: its
 * read was still started, so it is asked again on the next cycle, never on the widening backoff.
 */
export const lateDecisionRead = (detail: string) => / ms read deadline passed before .+ answered; it is read again next cycle/.test(detail);
/**
 * GY-1405. A decision the server refused because the item was delivered after the cycle's snapshot
 * ("Delivered work is immutable"): the item needs no decision any more, so the refusal judged
 * nothing and is no decision fault — the next snapshot shows it done (GY-1336's diagnosis rule).
 */
export const deliveredMeanwhile = (detail: string) => /Delivered work is immutable/.test(detail);
/**
 * GY-1505. A decision step failure the step itself recovers from, which judged nothing: a request
 * or launch that met a control plane that did not answer it (GY-1344's plane silence — on 8 October
 * 2026 the rework puts for GY-1491 and GY-1497 hit their 30 s timeout 30 s apart), or an approver
 * launch that lost the folder-trust race (GY-1152, GY-1306: a session sharing the account's config
 * rewrote it after the trust record was read back, and GY-1488's approver stopped at the dialog).
 * The watch relaunches next cycle and the request is asked again, so one alone is no decision fault.
 */
export const selfHealingDecisionFailure = (detail: string) => planeUnavailableText(detail) || / stopped at a workspace-trust prompt in pane .* although its launch records the folder trusted/.test(detail);
/** How many cycles back a self-healing failure of the same item still makes a run with this one (its retry is the next cycle). */
export const selfHealingRepeatCycles = 3;
/**
 * The fault kind a failed decision action of `work` is stored with (GY-1505): none for a
 * self-healing failure unless the item's decision step already failed the same way on one of the
 * last `selfHealingRepeatCycles` cycles — at this key (`previous`, the row this write replaces) or
 * at any other: the request, the watch's relaunch and the launcher's own row are one decision. A
 * repeat did not heal and counts: plane silence as `plane-unavailable`, anything else as the
 * action's own class (`undefined`). Every other failure keeps the action's own class.
 */
export function decisionFailureKind(state: Pick<DaemonState, 'actions' | 'cycle'>, work: string, detail: string, previous?: Pick<DaemonAction, 'state' | 'detail' | 'cycle' | 'kind' | 'work'>): FaultKind | null | undefined {
  if (!selfHealingDecisionFailure(detail)) return undefined;
  const earlier = (row: Pick<DaemonAction, 'state' | 'detail' | 'cycle' | 'kind' | 'work'> | undefined) => !!row && row.kind === 'decision' && row.work === work && row.state === 'failed'
    && selfHealingDecisionFailure(row.detail) && row.cycle < state.cycle && state.cycle - row.cycle <= selfHealingRepeatCycles;
  if (!earlier(previous) && !Object.values(state.actions).some(earlier)) return null;
  return planeUnavailableText(detail) ? 'plane-unavailable' : undefined;
}
/**
 * GY-1430. A rework the server refused because the candidate it was bound to — the head of this
 * cycle's snapshot — is no longer the item's ("The rework is bound to X but the current candidate is
 * Y"): a worker submitted a new head after the snapshot, so the grounds read from it describe
 * nothing any more and the next snapshot decides afresh. The refusal judged nothing and is no
 * decision fault. A rework bound to any head but the snapshot's own is still one.
 */
export function candidateMovedMeanwhile(detail: string, item: Pick<Work, 'candidate'>): boolean {
  const refused = /The rework is bound to ([0-9a-f]{12}) but the current candidate is ([0-9a-f]{12}|none)/.exec(detail);
  return !!refused && !!item.candidate && refused[1] === item.candidate.sha.slice(0, 12) && refused[2] !== refused[1];
}
/** How long a kept history may go without being read afresh, whatever the ledger says (GY-1241). */
export const decisionRefreshMs = 30 * 60_000;
/**
 * GY-1142. The decisions step read each item's decision history from the control plane once for
 * every place it looked — the request, its supervision, the moved-past sweep, the hand-launched
 * approvers — on every cycle, one at a time: at about 90 open items and hundreds of decisions that
 * was most of a three-minute cycle, and every merge, refresh and close waited behind it.
 *
 * The step now sees its effects through this. A history is read at most once per cycle, and one
 * read on an earlier cycle is kept while the ledger shows no decision of that item moved since:
 * a single `decisionChanges` read per cycle names the items that did. Its own `decide`,
 * `withdraw` and `resume` calls drop the item's history, so whatever the step wrote it reads back. The
 * items with a watch still open are read before the step reaches them, `decisionReadConcurrency`
 * at a time. Without `decisionChanges`, or when it cannot be read, nothing is kept from one cycle
 * to the next.
 *
 * GY-1241. The reads share one deadline, `decisionReadDeadlineMs` from the step's start: a read
 * still unanswered then rejects, so a slow control plane makes the histories unknown for this cycle
 * (each caller waits on an unknown history) rather than holding the step for a request timeout per
 * item. A read the step reaches after the deadline is still started, and rejected at once: what
 * answers is kept for the next cycle, so an item the step reaches late is never starved of its read
 * however long the step's other work takes. The read-ahead awaits the reads themselves, not the
 * deadline, so it stays `decisionReadConcurrency` at a time. A ledger event whose seq was taken before the cursor but committed after it is never
 * named by `decisionChanges`, so every kept history is dropped and read afresh at least every
 * `decisionRefreshMs`. A kept history is handed out as a copy: no caller can change what later
 * cycles read.
 *
 * GY-1293. The read-ahead takes first the items whose refused scope request the step may put to
 * an approver this cycle, then the open watches. A worker waits on that request, inside the scope
 * budget: read only when the step reached it, its history missed the deadline behind every slower
 * read ahead of it, cycle after cycle (GY-1287 on 5 October 2026, twice, until the budget passed).
 * The unreleased backlog items the stale-release step reads come last (GY-1315).
 */
export async function decisionReads(effects: DaemonEffects, held: HeldDecisions, open: readonly Work[], watched: readonly ApprovalWatch[], clock = Date.now(), deadlineMs = decisionReadDeadlineMs) {
  const until = performance.now() + deadlineMs;
  const late = (what: string) => new Error(`the decisions step's ${deadlineMs} ms read deadline passed before ${what} answered; it is read again next cycle`);
  const bounded = <T>(made: Promise<T>, what: string): Promise<T> => {
    const left = until - performance.now();
    if (left <= 0) { made.catch(() => undefined); return Promise.reject(late(what)); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(late(what)), left); timer.unref?.(); });
    return Promise.race([made, expired]).finally(() => clearTimeout(timer));
  };
  const ids = new Set(open.map(item => item.id));
  for (const id of held.histories.keys()) if (!ids.has(id)) held.histories.delete(id);
  if (held.refreshedAt === null || clock - held.refreshedAt >= decisionRefreshMs) { held.histories.clear(); held.refreshedAt = clock; }
  const moved = effects.decisions && effects.decisionChanges ? await bounded(effects.decisionChanges(held.seq), 'the decision ledger').catch(() => null) : null;
  if (!moved || !moved.complete) held.histories.clear();
  else for (const id of moved.work) held.histories.delete(id);
  if (moved) held.seq = moved.seq;
  const reading = new Map<string, ReturnType<NonNullable<DaemonEffects['decisions']>>>();
  const read = (item: Work): ReturnType<NonNullable<DaemonEffects['decisions']>> => {
    const kept = held.histories.get(item.id);
    if (kept) return Promise.resolve({ decisions: structuredClone(kept) });
    return bounded(start(item), `${item.key}'s decision history`);
  };
  /** The item's history read, started if none is in flight, unbounded: what answers is kept. */
  const start = (item: Work) => {
    let pending = reading.get(item.id);
    if (!pending) {
      reading.set(item.id, pending = effects.decisions!(item));
      pending.then(result => { if (reading.get(item.id) === pending) held.histories.set(item.id, structuredClone(result.decisions)); }, () => { if (reading.get(item.id) === pending) reading.delete(item.id); });
    }
    return pending;
  };
  const moves = (item: Work) => { held.histories.delete(item.id); reading.delete(item.id); };
  const writes = <A extends unknown[], R>(call: ((item: Work, ...rest: A) => Promise<R>) | undefined) =>
    call && ((item: Work, ...rest: A) => { moves(item); const made = call(item, ...rest); made.then(() => moves(item), () => moves(item)); return made; });
  const reads: DaemonEffects = new Proxy(effects, { get: (target, property, receiver) => {
    if (property === 'decisions') return target.decisions && read;
    if (property === 'decide' || property === 'withdraw') return writes(Reflect.get(target, property, receiver));
    if (property === 'resume') return writes(target.resume);
    return Reflect.get(target, property, receiver);
  } });
  // The waiting scope requests' and open watches' histories are read ahead, a bounded few at a time, while the step works.
  const keys = new Set(watched.filter(watch => !watch.settledAt).map(watch => watch.work));
  const scoped = open.filter(item => item.stage !== 'done' && !!routableScopeRequest(item, clock));
  const watching = open.filter(item => keys.has(item.key) && !scoped.includes(item));
  // Last, the unreleased backlog the stale-release step reads (GY-1315), so a cold backlog is read while the step works, not when it reaches them.
  const backlog = staleReleaseCandidates(open).filter(item => !scoped.includes(item) && !watching.includes(item));
  const ahead = effects.decisions ? [...scoped, ...watching, ...backlog].filter(item => !held.histories.has(item.id)) : [];
  const next = async (): Promise<void> => { const item = ahead.shift(); if (item) { if (!held.histories.has(item.id)) await start(item).catch(() => undefined); return next(); } };
  void Promise.all(Array.from({ length: decisionReadConcurrency }, next));
  return reads;
}

/** The control plane's answer to a withdrawal that settled a stalled approval by applying it (server/lane-rework.ts, GY-1297). */
export const resumedApplication = /its application was resumed and it is applied now/;
/**
 * Why an approved decision the loop reads must be settled rather than waited on, or null (GY-1297):
 * the item moved past the situation it was bound to, or it has stood approved and unapplied past
 * the grace its own approval had to apply it. Without the item's candidate (a watch read alone)
 * only the stall is judged; the settlement the loop sends judges the situation on the server.
 */
export function unsettledApproval(work: Pick<Work, 'key'> & Partial<Pick<Work, 'candidate'>>, decision: { id: string; action: string; state: string; approvedBy?: string | null; approvedAt?: string | null; situation?: DecisionSituation | null }, now: number): string | null {
  const moved = work.candidate === undefined ? null : supersededSituation(decision, { candidate: work.candidate });
  if (moved) return `${decision.action} decision ${decision.id} on ${work.key} was approved for ${situationLabel(moved.bound)}, but the item is now at ${situationLabel(moved.current)}; it is superseded so the current candidate's request is judged`;
  if (stalledApproval(decision, now)) return `${decision.action} decision ${decision.id} on ${work.key} was approved by ${decision.approvedBy ?? 'its approver'} at ${decision.approvedAt} and no outcome was recorded within ${Math.round(approvalApplyGraceMs / 1000)}s; its application is resumed so it settles applied or failed`;
  return null;
}
