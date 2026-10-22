import { agentOwner, type AttentionItem } from '../master.js';
import type { Work } from '../model.js';
import { humanNeededActions, type HumanNeededRow } from '../model/next-action.js';
import { elapsed } from '../model/sessions.js';
import { pushRefusal, trialRefusal } from '../model/gates.js';
import { openAction } from '../model/concerns.js';
import type { MergeWriterSummary } from '../daemon/cycle-merge-writer.js';
import { baseFailureHoldMs, baseFailurePrefix } from '../merge-writer/executor.js';

/**
 * What `master status` says about work that is waiting on a judgement rather than on capacity
 * (GY-104).
 *
 * `attention` and `request-rework` are judgments made in the step itself, so no executor holds a
 * handler for either: their rows are never claimed, never fail, and never appear as a refused
 * launch. Counted with the queue they were indistinguishable from work an executor was about to
 * take, and noticed only if somebody read the idle list five minutes later. Here they are their
 * own population — named, owed, and counted apart.
 */

/**
 * One attention item per action nobody in the executor loop may run, and per concern carried
 * beside an action that is running. Each names what is waiting, how long it has waited and the
 * command that answers it.
 */
export function humanNeededAttention(snapshot: { work: Work[]; now: string }, writer?: MergeWriterSummary | null): AttentionItem[] {
  const now = Date.parse(snapshot.now);
  return humanNeededActions(snapshot.work, new Date(snapshot.now)).flatMap(row => {
    // GY-2015: a control-plane refusal whose head the merge writer's queue holds or has in flight is the writer's
    // own serial work — the line's only answerer is the writer reaching the head, not a judgment nobody takes — so
    // while the writer moves the line carries `inMotionUntil` past its newest movement's bound (GY-1315), and when
    // the writer itself cannot move past that bound the queue's one stall line (mergeWriterStallAttention) stands
    // instead of it and of every per-item line beside it. A refusal whose head the queue does not hold, and every
    // other owed line, stand as they did.
    const work = row.source === 'action' ? snapshot.work.find(entry => entry.key === row.key) : undefined;
    const held = work ? mergeWriterHolds(work, writer, now) : null;
    if (held === 'stalled') return [];
    const item: AttentionItem = { subject: row.key,
      text: `${row.reason} — no executor may run it; ${row.decision} has been owed for ${elapsed(row.waitedMs)}`,
      ...agentOwner('master', row.resolve) };
    // GY-2053: a live flight is movement on its own, so its hold is dated from this reading, never from a movement aged past the bound.
    if (held === 'moving') item.inMotionUntil = new Date((writer!.inFlight ? now : mergeWriterMovement(writer)!.at) + mergeWriterMotionBound(writer)).toISOString();
    // GY-2174: a head the writer's own base-failure hold parks is out of the queue by the writer's
    // design, so the hold above cannot see it; the ledger's hold of the exact head bounds the line
    // itself, to the instant the queue re-enters the head on whatever the base tip then is.
    else if (work) {
      const until = baseFailureHoldUntil(work, now);
      if (until !== null) item.inMotionUntil = new Date(until).toISOString();
    }
    return [item];
  });
}

/**
 * GY-2015. How long a merge writer's newest demonstrated movement may stand before a trial wait it
 * owns counts as a decision fault. The writer's trials are one at a time (mergeQueue: oldest first,
 * an open intent blocks the queue), each bounded by the trial timeout, so a head refused
 * `merge writer has not trialled …` waits for the writer to reach it, not for a judgment; the bound
 * covers a settled trial plus the next cycle's start at the default timeout, and an install
 * that lengthens the timeout keeps a trial in flight, which is movement on its own.
 *
 * GY-2053: the bound the readers judge inside is the writer's own (below), not this default.
 */
export const mergeWriterMotionBoundMs = 30 * 60_000;

/**
 * GY-2053: the motion bound a held head is judged inside, as the writer's own summary holds it —
 * the configured worst case for one flight, (retrials + 1) × the trial timeout plus a cycle
 * (state.mergeWriter.motionBoundMs, `mergeWriterFlightBoundMs`) — so a hold lasts through however
 * long a legal flight runs, however the install configures it, and expires only when no flight is
 * in progress and no movement stands inside that bound. A summary that names no bound (an older
 * loop, a writer that never ran) falls back to the flat default bound above.
 */
export const mergeWriterMotionBound = (writer: MergeWriterSummary | null | undefined) =>
  typeof writer?.motionBoundMs === 'number' && writer.motionBoundMs > 0 ? writer.motionBoundMs : mergeWriterMotionBoundMs;

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
  // GY-2053: the newest attempt step — a retrial's intent, a trial verdict, a push, a reconcile — recorded beside every
  // ledger write a flight makes, so a multi-attempt flight keeps its movement advancing while it works.
  consider(writer.progress?.at, () => `the newest attempt step was recorded ${writer.progress!.at}: ${writer.progress!.what}`);
  return Number.isNaN(at) ? null : { at, what };
}

/**
 * Whether the writer holds the head an item's control-plane refusal names (GY-2015, GY-2053): the refusal is that candidate's
 * exact `merge writer has not trialled …` at the test gate or `merge writer has not pushed …` at the merge gate — the
 * writer's own next step either way, never a judgment — and the writer's queue holds the head or has it in flight, so
 * the writer knows it and will reach it. Held and moving (a trial in flight, or any recorded movement inside the
 * bound), it is the writer's work; held with no trial in flight and no movement past the bound, the writer itself
 * cannot move and the queue's one stall stands for it. A refusal whose head the queue does not hold is answered one way
 * short of a judgment: the ledger's own base-failure hold below (GY-2174). Any other refusal whose head the queue does
 * not hold is a genuine unanswered decision: the writer will never reach that head on its own.
 */
export function mergeWriterHolds(work: Work, writer: MergeWriterSummary | null | undefined, now: number): 'moving' | 'stalled' | null {
  if (!writer) return null;
  const candidate = work.candidate, action = openAction(work);
  if (!candidate || !action) return null;
  const head = candidate.sha.toLowerCase();
  const held = writer.queue.some(entry => entry.key === work.key && entry.head === head)
    || (!!writer.inFlight && writer.inFlight.key === work.key && writer.inFlight.head === head);
  if (!held) return null;
  if (action.gate === 'test') { if (action.refusal !== trialRefusal(candidate.sha, candidate.baseSha)) return null; }
  else if (action.gate === 'merge') { if (action.refusal !== pushRefusal(candidate.sha)) return null; }
  else return null;
  const movement = mergeWriterMovement(writer);
  return !writer.inFlight && (!movement || now - movement.at > mergeWriterMotionBound(writer)) ? 'stalled' : 'moving';
}

/**
 * GY-2174: the instant the writer's own base-failure hold of this item's head ends, or null when it holds nothing now.
 * A trial whose failures are the base tip's own leaves the ledger's `base failure` refusal of the exact head, and
 * `mergeQueue` drops the head on that record for `baseFailureHoldMs` from the refusal's `intentAt` (GY-1834) — the head
 * the GY-2015 hold above watches for is absent from the queue and the flight by the writer's design, so the item's
 * trial-refusal line would stand unbounded over a wait the writer itself imposed (on 19 October 2026 one red base
 * parked three heads and each counted an `owed-decision` at the 30–36m mark). The hold runs to
 * `intentAt + baseFailureHoldMs`, the instant the queue re-enters the head on whatever the base tip then is: one red
 * base parks every queued head at once, each parked head's line is the writer's motion for exactly that long — the
 * repair item's own `base-failure` line is what the cycle counts — and past the bound the head is queued again, held
 * as GY-2015 holds it. Grounded in the record alone, it bounds with no writer summary at all.
 */
export function baseFailureHoldUntil(work: Work, now: number): number | null {
  const candidate = work.candidate, action = openAction(work), state = work.mergeLedger, head = candidate?.sha.toLowerCase();
  if (!candidate || !action || !state || !head || action.gate !== 'test') return null;
  // The line bounded is the writer's trial refusal of this exact candidate, as mergeWriterHolds requires; any other
  // refusal of the item (a stale observation, a rerun) is a judgment or a step of its own, never this hold's to bound.
  if (action.refusal !== trialRefusal(candidate.sha, candidate.baseSha)) return null;
  // The same record mergeQueue drops the head on: a `base failure` refusal of the exact head, inside its hold.
  if (state.state !== 'refused' || state.head !== head || !state.refusal?.reason.startsWith(baseFailurePrefix) || !state.intentAt) return null;
  const until = Date.parse(state.intentAt) + baseFailureHoldMs;
  return Number.isFinite(until) && now <= until ? until : null;
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
  if (movement && now - movement.at <= mergeWriterMotionBound(writer)) return null;
  const front = writer.queue[0]!;
  const since = movement
    ? `its newest movement is ${movement.what}, ${Math.max(0, Math.round((now - movement.at) / 60_000))} minutes ago`
    : 'it names no movement at all';
  return { subject: 'merge-writer',
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
 * the owed items and the other request items (`requests`) add to the total.
 */
export function owedAttention(snapshot: { work: Work[]; now: string }, rows: { key: string; attention: string | null }[], requests: AttentionItem[], writer?: MergeWriterSummary | null) {
  const now = Date.parse(snapshot.now);
  const rowAttention = (key: string) => !!rows.find(row => row.key === key)?.attention;
  // GY-2015: the writer stall stands for a queue the writer cannot move, beside the per-item owed
  // lines it replaces (held heads are dropped from humanNeededAttention while it stands).
  const stall = mergeWriterStallAttention(writer, now);
  const items = [...(stall ? [stall] : []), ...humanNeededAttention(snapshot, writer).filter(item => !rowAttention(item.subject))];
  return { rows: humanNeededActions(snapshot.work, new Date(snapshot.now)), items,
    counted: items.length + requests.filter(item => !rowAttention(item.subject)).length };
}

