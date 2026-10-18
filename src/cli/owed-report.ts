import { reviewRoundCapOf, withReviewRounds } from '../review-cap.js';
import { agentOwner, type AttentionItem, type AttentionOwner } from '../master.js';
import type { Work } from '../model.js';
import { humanNeededActions, type HumanNeededRow } from '../model/next-action.js';
import { decideScopeRequest, scopeRefusalBlocker } from '../model/scope.js';
import { scopeAskCommand } from '../model/scope-provenance.js';
import { elapsed } from '../model/sessions.js';
import { maxDecisionRequests } from '../daemon/decisions.js';
import { trialRefusal } from '../model/gates.js';
import { openAction } from '../model/concerns.js';
import type { MergeWriterSummary } from '../daemon/cycle-merge-writer.js';
import { staleRelease, staleReleaseWaitBoundMs, unappliedReleases, type DecisionHistoryRow } from '../model/stale-release.js';

/**
 * What `master status` says about work that is waiting on a judgement rather than on capacity
 * (GY-104).
 *
 * `escalate` and `request-rework` are judgments made in the step itself, so no executor holds a
 * handler for either: their rows are never claimed, never fail, and never appear as a refused
 * launch. Counted with the queue they were indistinguishable from work an executor was about to
 * take, and noticed only if somebody read the idle list five minutes later. Here they are their
 * own population — named, owed, and counted apart.
 */

/**
 * One attention item per open worker scope request that somebody actually has to decide.
 *
 * A request the item's own criteria — or this repository's documentation rule — already imply is
 * nobody's decision: the control plane computes `approve-scope` for it and an executor applies the
 * widening, with no master session and no command. Naming those here asked a master to run
 * `master scope` for a verdict already determined, and an item one file short of finishing waited
 * on that line being read. The verdict is recomputed from the item itself, never taken from the
 * request; a request from a lease that ended is never surfaced. Nor is one the independent approver
 * holds or has decided (GY-176, GY-1388): routed (the loop's `approvals` watch on it is unsettled),
 * or refused by the rule within the bound before the loop routes it. That is being decided, the
 * engine refuses `master scope` for it, and the worker reads the outcome; `scopeAskCommand` names what the master runs once
 * the hold ends — `master requirements` for a terminal over-cap refusal, whose revision can fold or
 * split the ask, never the plain union `master scope` posts past the same bound (GY-936).
 */
export function scopeRequestAttention(snapshot: { work: Work[]; now: string }, approvals: readonly RoutedWatch[] = []): AttentionItem[] {
  const now = Date.parse(snapshot.now);
  return snapshot.work.flatMap(work => {
    const request = work.scopeRequest;
    const live = request && work.lease && work.lease.epoch === request.epoch && Date.parse(work.lease.expiresAt) > now;
    if (!live) return [];
    const decision = request.decision ?? decideScopeRequest(work, request);
    if (decision.state === 'approved') return [];
    const watches = approvals.filter(watch => watch.work === work.key && watch.action === 'requirements' && watch.scope?.epoch === request.epoch && watch.scope.at === request.at);
    // The approver's own verdict on a routed ask stands: the worker reads it and stays inside plannedFiles.
    if (watches.length && request.decision && request.decision.decidedBy !== 'graphyard') return [];
    const command = scopeAskCommand(work, now, watches.map(watch => ({ id: watch.decision, ended: !!watch.settledAt })));
    if (command === `graphyard master decisions ${work.key}`) return [];
    return [{ subject: work.key, text: `${request.requestedBy} needs files outside plannedFiles: ${request.paths.join(', ')} — ${request.reason}. The widening rule refuses it: ${decision.reason}`,
      ...agentOwner('master', command) }];
  });
}

type RoutedWatch = { work: string; action: string; decision: string; settledAt?: string | null; scope?: { epoch: number; at: string } | null };

/**
 * A request the loop has routed to the independent approver (GY-176) is being decided. While its
 * watch is unsettled and only the rule has refused it, the item's row says so and names the
 * decision, rather than the rule refusal's gate and `master unblock`, which would send a master to
 * widen or unblock what the approver is already judging. `routedScope` marks the row, so its owed
 * action is named the same way (`owedAttention`).
 */
export function routedScopeStatus<S extends { work: { key: string; attention: string | null; attentionOwner: AttentionOwner | null }[]; attentionItems: AttentionItem[] }>(status: S, work: readonly Work[], approvals: readonly RoutedWatch[] = [], config?: { reviewRoundCap?: number }): S {
  const judging = new Map(approvals.filter(watch => watch.action === 'requirements' && watch.scope && !watch.settledAt).map(watch => [`${watch.work}:${watch.scope!.epoch}:${watch.scope!.at}`, watch.decision]));
  let rows = status.work.map(row => {
    const item = work.find(entry => entry.key === row.key), request = item?.scopeRequest;
    const decision = request && judging.get(`${row.key}:${request.epoch}:${request.at}`);
    if (!decision || !row.attention || request.decision?.decidedBy !== 'graphyard' || !item!.blocker?.startsWith(scopeRefusalBlocker)) return row;
    const next = `Nothing to run: the approver judges requirements decision ${decision} (graphyard master decisions ${row.key}); ${request.requestedBy} reads the outcome with scope-request ${row.key} ${request.epoch} --wait`;
    return { ...row, routedScope: next, attention: `${row.key}'s scope request for ${request.paths.join(', ')} is with the independent approver: the rule refused it and the loop routed it as requirements decision ${decision}`, attentionOwner: agentOwner('control plane', next, 'approver') };
  });
  const routed = new Map(rows.flatMap((row, index) => row !== status.work[index] ? [[row.key, { from: status.work[index].attention, row }]] : []));
  // `master status` also shows each item's review round against the configured cap (GY-1118).
  if (config) rows = withReviewRounds(rows, work, reviewRoundCapOf(config));
  return { ...status, work: rows, attentionItems: status.attentionItems.map(entry => {
    const change = routed.get(entry.subject);
    return change && entry.text === change.from ? { subject: entry.subject, text: change.row.attention!, ...change.row.attentionOwner! } : entry;
  }) };
}

/**
 * One attention item per action nobody in the executor loop may run, and per concern carried
 * beside an action that is running. Each names what is waiting, how long it has waited and the
 * command that answers it.
 */
export function humanNeededAttention(snapshot: { work: Work[]; now: string }, writer?: MergeWriterSummary | null): AttentionItem[] {
  const now = Date.parse(snapshot.now);
  return humanNeededActions(snapshot.work, new Date(snapshot.now)).flatMap(row => {
    // GY-2015: a test-gate trial refusal whose head the merge writer's queue holds is the writer's
    // own serial work — the line's only answerer is the writer reaching the head, not a judgment
    // nobody takes — so while the writer moves the line carries `inMotionUntil` past its newest
    // movement's bound (GY-1315), and when the writer itself cannot move past that bound the
    // queue's one stall line (mergeWriterStallAttention) stands instead of it and of every
    // per-item line beside it. A trial refusal whose head the queue does not hold, and every
    // other owed line, stand as they did.
    const work = row.source === 'action' ? snapshot.work.find(entry => entry.key === row.key) : undefined;
    const held = work ? mergeWriterHoldsTrial(work, writer, now) : null;
    if (held === 'stalled') return [];
    const item: AttentionItem = { subject: row.key,
      text: `${row.reason} — no executor may run it; ${row.decision} has been owed for ${elapsed(row.waitedMs)}`,
      ...agentOwner('master', row.resolve, 'approver') };
    if (held === 'moving') item.inMotionUntil = new Date(mergeWriterMovement(writer)!.at + mergeWriterMotionBoundMs).toISOString();
    return [item];
  });
}

/**
 * GY-2015. How long a merge writer's newest demonstrated movement may stand before a trial wait it
 * owns counts as a decision fault. The writer's trials are one at a time (mergeQueue: oldest first,
 * an open intent blocks the queue), each bounded by the shadow gate's timeout, so a head refused
 * `merge writer has not trialled …` waits for the writer to reach it, not for a judgment; the
 * bound covers a settled trial plus the next cycle's start at the default timeout, and an install
 * that lengthens the timeout keeps a trial in flight, which is movement on its own.
 */
export const mergeWriterMotionBoundMs = 30 * 60_000;

/**
 * The writer's newest demonstrated step — a trial begun, a delivery, a refusal recorded, a trial
 * failure whose rework was requested — or null when it names none (GY-2015, the GY-1966 reading):
 * the newest of the facts the writer's own summary holds, in the reader's words, so the stall it
 * bounds names what the loop last saw the writer do.
 */
export function mergeWriterMovement(writer: MergeWriterSummary | null | undefined): { at: number; what: string } | null {
  if (!writer) return null;
  let at = Number.NaN, what = '';
  const consider = (instant: string | null | undefined, text: () => string) => {
    const parsed = instant ? Date.parse(instant) : Number.NaN;
    if (Number.isFinite(parsed) && (Number.isNaN(at) || parsed >= at)) { at = parsed; what = text(); }
  };
  const flight = writer.inFlight;
  consider(flight?.startedAt, () => `the trial of ${flight!.key}'s head ${flight!.head.slice(0, 12)} started ${flight!.startedAt} and is in flight`);
  consider(writer.lastMergeAt, () => `the last merge was delivered ${writer.lastMergeAt}`);
  const refusal = writer.refusals.at(-1);
  consider(refusal?.at, () => `the newest refusal was recorded ${refusal!.at}: ${refusal!.key} ${refusal!.reason.slice(0, 120)}`);
  const rework = writer.reworks.at(-1);
  consider(rework?.refusedAt, () => `the newest trial failure was recorded ${rework!.refusedAt}: ${rework!.key}'s rework is requested`);
  return Number.isNaN(at) ? null : { at, what };
}

/**
 * Whether the writer holds the head an item's trial refusal names: its test-gate refusal is that
 * candidate's exact `merge writer has not trialled …`, and the writer's queue holds the head —
 * the writer knows it and will trial it. Held and moving (a trial in flight, or any recorded
 * movement inside the bound), it is the writer's work; held with no trial in flight and no
 * movement past the bound, the writer itself cannot move and the queue's one stall stands for it.
 * A trial refusal whose head the queue does not hold is a genuine unanswered decision: the writer
 * will never reach that head on its own.
 */
export function mergeWriterHoldsTrial(work: Work, writer: MergeWriterSummary | null | undefined, now: number): 'moving' | 'stalled' | null {
  if (!writer) return null;
  const candidate = work.candidate, action = openAction(work);
  if (!candidate || !action || action.gate !== 'test' || action.refusal !== trialRefusal(candidate.sha, candidate.baseSha)) return null;
  if (!writer.queue.some(entry => entry.key === work.key && entry.head === candidate.sha.toLowerCase())) return null;
  const movement = mergeWriterMovement(writer);
  return !writer.inFlight && (!movement || now - movement.at > mergeWriterMotionBoundMs) ? 'stalled' : 'moving';
}

/**
 * GY-2015: the one writer-level stall that stands for a queue the merge writer cannot move, in
 * place of an owed decision per held head. It counts only past the movement bound — the ordinary
 * pace of a serial trial backlog is movement, however long the whole queue takes — and its text
 * names the writer's newest movement or its absence, and the front head's wait, so the master
 * reads what stopped rather than a symptom per item.
 */
export function mergeWriterStallAttention(writer: MergeWriterSummary | null | undefined, now: number): AttentionItem | null {
  if (!writer || !writer.queue.length || writer.inFlight) return null;
  const movement = mergeWriterMovement(writer);
  if (movement && now - movement.at <= mergeWriterMotionBoundMs) return null;
  const front = writer.queue[0]!;
  const since = movement
    ? `its newest movement is ${movement.what}, ${Math.max(0, Math.round((now - movement.at) / 60_000))} minutes ago`
    : 'it names no movement at all';
  return { subject: 'merge-writer', kind: 'stalled-step',
    text: `The merge writer's queue holds ${writer.queue.length} head(s) it cannot move: no trial is in flight and ${since}; ${front.key}'s head ${front.head.slice(0, 12)} has waited ${Math.round(front.waitingMs / 60_000)} minutes at the front. One stall stands for the queue instead of an owed decision per head`,
    ...agentOwner('master', 'Nothing to run per item: the queue\'s only mover is the loop\'s merge-writer step. Check the loop is cycling (master status names its liveness; systemctl --user restart graphyard-master.service restarts a stopped loop) and file the merge-writer defect that left its queue unmoved') };
}

/**
 * The action report with the two populations separated: rows an executor will take, and rows only
 * a judgment settles. `waiting` and `idle` are what the queue offers executors, so a row nobody
 * may claim is taken out of both — it would otherwise age into the idle list as though an
 * executor were late to it.
 */
export function needsHumanActions<T extends { waiting: { id: string }[]; idle: { id: string }[] }>(report: T, owed: HumanNeededRow[]) {
  const rows = new Set(owed.map(entry => entry.action).filter((id): id is string => !!id));
  return { ...report, needsHuman: owed, waiting: report.waiting.filter(entry => !rows.has(entry.id)), idle: report.idle.filter(entry => !rows.has(entry.id)) };
}

/**
 * What `master status` adds for work waiting on a judgment: every owed row (counted apart from the
 * queue), the attention items for items whose row does not already carry an attention line — an
 * item says this once, and the rest would be named nowhere at all — and how many attention lines
 * the owed items and scope requests add to the total.
 */
export function owedAttention(snapshot: { work: Work[]; now: string }, rows: { key: string; attention: string | null; routedScope?: string }[], scopeRequests: AttentionItem[], writer?: MergeWriterSummary | null) {
  const now = Date.parse(snapshot.now);
  const rowAttention = (key: string) => !!rows.find(row => row.key === key)?.attention;
  // GY-2015: the writer stall stands for a queue the writer cannot move, beside the per-item owed
  // lines it replaces (held heads are dropped from humanNeededAttention while it stands).
  const stall = mergeWriterStallAttention(writer, now);
  const items = [...(stall ? [stall] : []), ...humanNeededAttention(snapshot, writer).filter(item => !rowAttention(item.subject))];
  // The rule refusal's escalation of a request the approver is judging is answered by that decision.
  const routed = (key: string) => rows.find(row => row.key === key)?.routedScope;
  return { rows: humanNeededActions(snapshot.work, new Date(snapshot.now)).map(row => row.source === 'action' && routed(row.key)
    ? { ...row, decision: `the independent approver's judgement of ${row.key}'s routed scope request`, resolve: routed(row.key)! } : row), items,
    counted: items.length + scopeRequests.filter(item => !rowAttention(item.subject)).length };
}

/**
 * GY-1294. A release decision the server settled `stale` — the item revision moved between the
 * request and its approver's read — releases nothing, and an item in backlog shows no other sign
 * that it waits: five diagnosed root-cause fixes sat there for 2–23 hours, each behind a stale
 * release nobody asked for again. While the item is still in backlog and that stale release is
 * its latest — no later release requested, approved or applied — the release is owed, and it is
 * named so, as owed decision attention with how long it has waited, never left silent. Null for
 * any other item.
 */
export function staleReleaseAttention(work: { key: string; stage: string; ready?: boolean }, decisions: readonly DecisionHistoryRow[], now: number): AttentionItem | null {
  const release = staleRelease(work, decisions);
  if (!release) return null;
  const waited = release.requestedAt ? Math.max(0, now - Date.parse(release.requestedAt)) : 0;
  const next = `graphyard master release ${work.key}, or graphyard master decide ${work.key} release REASON then graphyard master approver ${work.key} DECISION`;
  // GY-1315: the loop requests it again itself (staleReleaseStep, and the diagnosis step for its own fixes) while requests are left,
  // so inside the wait bound the line is a step in motion: GY-1313 and GY-1314 counted 3 minutes after going stale, 3 minutes before the re-request.
  const requested = release.requestedAt ? Date.parse(release.requestedAt) : Number.NaN;
  const inMotionUntil = Number.isFinite(requested) && unappliedReleases(decisions) < maxDecisionRequests ? new Date(requested + staleReleaseWaitBoundMs).toISOString() : undefined;
  return { subject: work.key, text: `${work.key} sits in backlog behind release decision ${release.id}, which went stale: ${release.outcome ?? 'the item revision moved before its approver read it'} — no executor may run it; the release of ${work.key} has been owed for ${elapsed(waited)}`,
    ...agentOwner('master', next, 'approver'), ...(inMotionUntil ? { inMotionUntil } : {}) };
}
export { staleReleaseWaitBoundMs };
