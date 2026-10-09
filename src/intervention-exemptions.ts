import type pg from 'pg';
import { endedLeaseLoss, leaseLossSettleMs, type Escalation, type Stage, type Work } from './model.js';
import { containmentGraceMs, containmentSettleWaitBoundMs } from './model/containment.js';
import { laneApprover, mergeWriterApprover } from './model/rework-ground.js';
import { routedWideningDecision, wideningSettlement } from './model/scope-provenance.js';
import { reworkGroundFields, routineReworkGround as routineGround, type ReworkGroundsWork } from './rework-grounds.js';
import { applyWorkDelta, type DeltaOp } from './store/snapshot-delta.js';

/**
 * The fold's exemption rules (GY-1427): the cases where the ledger records a step that looks like
 * somebody stepping in but was the control plane doing its own job, so `foldInterventions` reports
 * no intervention for it. Each rule is one named predicate over the moment the fold is judging,
 * and the fold consults them through one ordered list (`interventionExemptions`), so a fix to one
 * pattern adds or edits one rule here rather than a condition inside the fold.
 */

/** A worker's open ask: a scope request or a blocked report, until something answers it. */
export interface Ask { seq: number; at: string; stage: Stage | null; kind: 'scope-request' | 'blocked-report'; blocked: string; paths: string[]; trigger?: string; sources: { seq: number; kind: string }[] }
/** A rework decision the fold has seen requested and not yet settled. */
export interface ReworkDecision { seq: number; at: string; id: string; stage: Stage | null; binding: string | null; loopRequested: boolean; approvedBy: string | null; self?: boolean }

/** The moment the fold is judging: the row (or, past the last row, the open need) a rule may exempt. */
export type ExemptionMoment =
  /** An `autoscope` row deciding the item's open scope request. */
  | { at: 'autoscope'; decision: { state?: unknown } }
  /** A `requirements` row that widens the plan (`widened`), with whether it answers open asks (`asked`). */
  | { at: 'requirements'; details: Record<string, any>; reason: string; widened: boolean; asked: boolean; routed: readonly string[]; stage: Stage | null; work: { epoch?: number | null; blocker?: string | null } | null; blockerBefore: string | null | undefined }
  /** A `rework` row (`rework`), or a rework decision still open past the last row (`open-rework`). */
  | { at: 'rework' | 'open-rework'; decision: ReworkDecision | null; asked: boolean; grounds: ReworkGroundsWork | null; candidate: { sha: string } | null | undefined }
  /** A `merge.operator-authorized` or `merge.reconciled` row. */
  | { at: 'merge'; details: Record<string, any> }
  /** An `autosettle` or `recover` row lowering the item's containment fence. */
  | { at: 'settlement'; kind: string; details: Record<string, any>; when: string }
  /** An ask still open past the last row, on the item as the current record holds it. */
  | { at: 'open-ask'; ask: Ask; item: Work }
  /** An escalation still standing on the item past the last row. */
  | { at: 'open-escalation'; item: Work; escalation: Escalation; now: string }
  /** An `escalation.resolved` row: the trigger, the escalation it resolved and the decision that resolved it. */
  | { at: 'escalation-resolved'; details: Record<string, any> };

/**
 * Whether an `autosettle` row is the loop's own settlement inside the settle bound: the loop marked
 * it (`origin: 'loop'`) and it landed within the grace window and `containmentSettleWaitBoundMs` of
 * the fence's lapse, which the control plane recorded from the record it lowered. A row with no
 * lapse to date it, or one by hand, stays a signal.
 */
export function loopSettledInBound(details: { origin?: unknown; lapsedAt?: unknown } | null | undefined, at: string) {
  const lapsed = typeof details?.lapsedAt === 'string' ? Date.parse(details.lapsedAt) : Number.NaN;
  return details?.origin === 'loop' && Number.isFinite(lapsed) && Date.parse(at) - lapsed <= containmentGraceMs + containmentSettleWaitBoundMs;
}

/** The loop's own grounded round (GY-1389): its operator-agent identity requested it on recorded grounds, and its own approver applied it. */
export const loopRound = (decision: ReworkDecision | null) => !!decision?.binding && decision.loopRequested && !!decision.approvedBy;
/**
 * Whether a rework decision is the loop's own round for required checks that failed on the head
 * it returns (GY-1387): its grounds binding names that head and the failed checks
 * (`failedCheckRework`, `<sha>:ci:<checks>`), and the head is the candidate the rework sent back.
 */
export const failedCheckBinding = (binding: string | null, candidate: { sha: string } | null | undefined) => {
  const match = binding ? /^([a-f0-9]{40}):ci:.+$/.exec(binding) : null;
  return !!match && match[1] === candidate?.sha;
};

const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
/**
 * Whether a requirements revision re-plans work no attempt has started (GY-1396), judged from the
 * item as the revision found it. An operator agent's row records that whole document as `before`:
 * the item is unstarted when it was never claimed, or when every attempt lapsed leaving nothing on
 * the record (no submission, candidate, scope ask or decision, human request, kept commit). Any
 * other row records only the planned files, so only an item never claimed (epoch 0) is unstarted.
 * A blocker standing before the revision is always something the revision answers.
 */
export function unstarted(before: unknown, epochAfter: number | null | undefined, blockerBefore: string | null | undefined): boolean {
  if (!isObject(before) || !('epoch' in before)) return epochAfter === 0 && !blockerBefore;
  if (before.blocker) return false;
  if (!before.epoch) return true;
  const attempts = before.pipeline?.attempts, exhaustions = before.capacity?.exhaustions;
  return !before.submission && !before.candidate && !before.scopeRequest && !before.scopeDecision && !before.humanRequest
    && Array.isArray(attempts) && attempts.every((attempt: { end?: unknown }) => attempt?.end === 'expired')
    && !(Array.isArray(exhaustions) && exhaustions.some((entry: { role?: unknown; partialWork?: { commit?: unknown } }) => entry?.role === 'worker' && entry.partialWork?.commit));
}

/**
 * The rework decision a `decision.requested` row opens, or null. A request carrying a grounds
 * binding names the recorded fact it rests on (GY-407): a standing change request, a failed check,
 * a base conflict, a mechanical finding, a capped change request. Only the loop's operator-agent
 * identity sends one as its own round: a binding a person's credential sent (the requester the
 * decide route records) is not the loop's provenance. A row with no recorded requester predates the
 * provenance field, when only the loop sent bindings.
 */
export function requestedRework(row: { seq: number; at: string; payload?: any }, stage: Stage | null): ReworkDecision | null {
  if (row.payload?.action !== 'rework') return null;
  const loopRequested = !row.payload.requester || row.payload.requester.role === 'operator-agent';
  return { seq: row.seq, at: row.at, id: row.payload.id, stage, binding: typeof row.payload.input?.binding === 'string' && row.payload.input.binding ? row.payload.input.binding : null, loopRequested, approvedBy: null };
}
/** The reason of a requirements decision the loop routed to the approver (GY-1388), or null. */
export const routedReason = (payload: any): string | null => routedWideningDecision(payload) && typeof payload.reason === 'string' ? payload.reason : null;
/**
 * Record on an open rework decision who approved it. Approved by the control plane on a ground the
 * record shows on the exact head (GY-1394), it is `self`: a lane approval with no recorded ground
 * still counts, and so does the merge writer's on its failed trial (GY-1524). `approvedBy` names the
 * product's own approvers — the risk lane (GY-883), the merge writer and an
 * operator agent the loop launched; a person approving the loop's request did the approver's job,
 * and leaves it unset.
 */
export function approvedRework(decision: ReworkDecision | null, row: { actor: string; payload?: any }) {
  if (!decision || decision.id !== row.payload?.id) return;
  if ((row.actor === laneApprover || row.actor === mergeWriterApprover) && typeof row.payload?.ground === 'string' && row.payload.ground) decision.self = true;
  const approver = row.payload?.approver ?? {};
  if (approver.role === 'risk-lane' || approver.role === 'merge-writer' || approver.role === 'operator-agent') decision.approvedBy = row.actor;
}

/**
 * How far before a window's start its decision rows are read (GY-1389): a rework applied inside
 * the window is judged by the decision that asked for it, which may have been requested and
 * approved before the window opened. Without it such a rework read as one nobody requested.
 */
export const interventionDecisionReachMs = 24 * 60 * 60_000;
/** The instant each kind's rows are read from, for a window starting at `since`: decision rows reach back. */
export const interventionLedgerSince = (kind: string, since: string) =>
  kind.startsWith('decision.') ? new Date(Date.parse(since) - interventionDecisionReachMs).toISOString() : new Date(Date.parse(since)).toISOString();

/**
 * The rows a window starting at `since` folds, in ledger order: every row inside it, and a decision
 * row of the reach before it only when a row inside names the same decision — the `decision.applied`
 * an in-window rework is recorded with, or its approval or settlement (GY-1389). One that only
 * waited, or whose rework settled before the window opened, is no signal of it, and is never
 * associated with a later rework of the same item.
 */
export function windowOutcomes<R extends { created_at: string | Date; kind: string; work_id: string | null; top?: { id?: unknown } | null }>(rows: R[], since: string): R[] {
  const opened = Date.parse(since), inside = (row: R) => new Date(row.created_at).getTime() >= opened;
  const linked = new Set(rows.filter(row => inside(row) && row.kind.startsWith('decision.')).map(row => `${row.work_id}:${row.top?.id}`));
  return rows.filter(row => inside(row) || linked.has(`${row.work_id}:${row.top?.id}`));
}

/**
 * The window's rows with the decisions it acts on but whose request lies beyond the reach — one
 * that waited longer than a day — read by their id (`columns` as the window was read), in ledger
 * order, so the rework such a decision applies is still judged by its request (GY-1389).
 */
export async function withDecisionsBeyondReach(db: { query: pg.Pool['query'] }, window: any[], columns: string): Promise<any[]> {
  const requested = new Set(window.filter(row => row.kind === 'decision.requested').map(row => `${row.work_id}:${row.top?.id}`));
  const missing = [...new Map(window.filter(row => row.work_id && row.kind.startsWith('decision.') && typeof row.top?.id === 'string' && !requested.has(`${row.work_id}:${row.top.id}`))
    .map(row => [`${row.work_id}:${row.top.id}`, { work: row.work_id as string, id: row.top.id as string, before: Number(row.seq) }])).values()];
  if (!missing.length) return window;
  const earlier = await db.query(`SELECT found.* FROM unnest($1::uuid[], $2::text[], $3::bigint[]) AS s(work, id, before)
      CROSS JOIN LATERAL (SELECT ${columns} FROM events WHERE work_id = s.work AND seq < s.before AND kind IN ('decision.requested', 'decision.approved') AND payload->>'id' = s.id) found`,
  [missing.map(entry => entry.work), missing.map(entry => entry.id), missing.map(entry => entry.before)]);
  const seen = new Set(window.map(row => String(row.seq)));
  return [...window, ...earlier.rows.filter(row => !seen.has(String(row.seq)))].sort((a, b) => Number(a.seq) - Number(b.seq));
}

/**
 * A `rework` row's grounds fields (GY-1386), the input of `routine-rework-ground`, projected from a
 * whole document in SQL; a delta row's are its base's, extended by the delta's ops on them
 * (`extendedGrounds`). The observation keeps only what the grounds read, so a few hundred rework
 * rows a week cost no review bodies or threads.
 */
export const reworkGroundsSql = (document: string) => `jsonb_build_object(${reworkGroundFields.filter(field => field !== 'observation').map(field => `'${field}', ${document}->'${field}'`).join(', ')},
  'observation', CASE WHEN jsonb_typeof(${document}->'observation')='object' THEN jsonb_build_object(${['candidate', 'baseTip', 'conflicting', 'merged', 'checks', 'requiredChecks', 'agentReview'].map(field => `'${field}', ${document}->'observation'->'${field}'`).join(', ')},
    'reviews', COALESCE((SELECT jsonb_agg(jsonb_build_object('sha', review->'sha', 'state', review->'state')) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${document}->'observation'->'reviews')='array' THEN ${document}->'observation'->'reviews' ELSE '[]'::jsonb END) review), '[]'::jsonb)) END)`;
/** A delta rework row's grounds: its base's projected grounds, extended by the delta's ops on those fields. */
export function extendedGrounds(base: Record<string, any>, delta: { ops?: unknown }): Record<string, any> {
  const fields = new Set<unknown>(reworkGroundFields);
  return applyWorkDelta(base as Work, (Array.isArray(delta.ops) ? { ...delta, ops: delta.ops.filter((op: DeltaOp) => fields.has(op[0]?.[0])) } : delta) as Parameters<typeof applyWorkDelta>[1]) as unknown as Record<string, any>;
}

/** One exemption rule: a name the fold and its readers cite, and the predicate over a moment. */
export interface InterventionExemption { name: string; exempts: (moment: ExemptionMoment) => boolean }
const rule = (name: string, exempts: (moment: ExemptionMoment) => boolean): InterventionExemption => ({ name, exempts });
const reworkMoment = (moment: ExemptionMoment) => moment.at === 'rework' || moment.at === 'open-rework' ? moment : null;

/** An autoscope the control plane approved itself: nobody stepped in. */
export const approvedAutoscope = rule('approved-autoscope', moment => moment.at === 'autoscope' && moment.decision.state === 'approved');
/**
 * The loop's own re-plan onto the successors of files the base split or renamed (GY-1397) is the
 * control plane doing its job, as an approved autoscope is: nobody stepped in, so neither it nor an
 * ask it covers is a signal. Rows written before the rule was recorded carry the re-plan's own
 * wording (successorStep). Only an operator agent's row carries `intent`.
 */
export const successorReplan = rule('successor-replan', moment => moment.at === 'requirements' && moment.widened && isObject(moment.details.intent)
  && (moment.details.intent.rule === 'successor' || /^Re-planned \S+ onto the successors of the files it plans/.test(moment.reason)));
/**
 * A widening the loop granted on its audited grounds (GY-1388) is no signal, as an approved
 * autoscope is not. It answers the asks it covers; a partly widened ask stays open, so the rest is
 * one signal when somebody does step in, never a second one beside this.
 */
export const auditedScopeWidening = rule('audited-scope-widening', moment => moment.at === 'requirements' && moment.widened && wideningSettlement(moment.details, moment.routed) === 'loop-rule');
/** A widening the independent approver settled on an ask the loop routed to it (GY-1388): it answers the blocked report beside the ask as well. */
export const routedScopeWidening = rule('routed-scope-widening', moment => moment.at === 'requirements' && moment.widened && wideningSettlement(moment.details, moment.routed) === 'routed-approver');
/**
 * An item at backlog or ready that no attempt has worked on, that nobody asked about and that
 * nothing blocked is being planned, not rescued: its coordinator revising the scope of work no
 * worker has started waited on no one, so it is no intervention (GY-1396). A blocker it answers, or
 * an item an attempt holds, released, submitted or was reworked from, still is. `liveScopeWidening`
 * says only that the revision is additive, not that a lease was live, so the item as the revision
 * found it decides.
 */
export const unstartedReplan = rule('unstarted-replan', moment => moment.at === 'requirements' && moment.widened && !moment.asked && (moment.stage === 'backlog' || moment.stage === 'ready')
  && !!moment.work && unstarted(moment.details.before, moment.work.epoch, moment.blockerBefore === undefined ? moment.work.blocker : moment.blockerBefore));
/**
 * A round answering a ground the loop's own rule acts on needed nobody (GY-1386, rework-grounds.ts):
 * whoever asked for it first, the product handled it, and the asks it ended went with it.
 */
export const routineReworkGround = rule('routine-rework-ground', moment => { const rework = reworkMoment(moment); return !!rework && !!routineGround(rework.grounds, rework.decision?.binding); });
/** A rework the control plane approved on a ground it recorded (GY-1394), when no ask preceded it. */
export const laneReworkGround = rule('lane-rework-ground', moment => { const rework = reworkMoment(moment); return !!rework && !rework.asked && !!rework.decision?.self; });
/** The loop's own round for required checks that failed on the head it returns (GY-1387), when no ask preceded it. */
export const failedCheckRound = rule('failed-check-round', moment => { const rework = reworkMoment(moment); return !!rework && !rework.asked && failedCheckBinding(rework.decision?.binding ?? null, rework.candidate); });
/**
 * A round the loop requested on its recorded grounds that its own approver applied (GY-1389): the
 * reviewer asked for changes, CI failed, the base moved, the review cap put a finding to the
 * approver — nobody stepped in. Still open, the loop's grounded request waits on its own approver;
 * a stalled one is a decision fault, not an intervention.
 */
export const loopReworkRound = rule('loop-rework-round', moment => {
  const rework = reworkMoment(moment);
  if (!rework || rework.asked) return false;
  return rework.at === 'rework' ? loopRound(rework.decision) : !!rework.decision?.binding && rework.decision.loopRequested;
});
/** A merge inside a direct-merge window is the operator's standing policy, not a one-off intervention. */
export const directMergeWindow = rule('direct-merge-window', moment => moment.at === 'merge' && !!moment.details.directMerge);
/**
 * GY-1392: the loop settling a verified-dead fence within the settle bound is the product doing its
 * own job, as the faults pass reads it (containmentInMotion); only a settlement by hand, a recovery,
 * or a loop settlement that came past the bound is an intervention.
 */
export const loopAutosettleInBound = rule('loop-autosettle-in-bound', moment => moment.at === 'settlement' && moment.kind === 'autosettle' && loopSettledInBound(moment.details, moment.when));
/**
 * An ask whose item no longer carries a blocker or a scope request was met by a command the fold
 * does not read, so it is not reported as waiting.
 */
export const answeredOffLedger = rule('answered-off-ledger', moment => moment.at === 'open-ask' && !moment.item.blocker && !moment.item.scopeRequest);
/** An undecided scope request is the loop's to answer within minutes; only one the loop refused waits on a person. */
export const undecidedScopeRequest = rule('undecided-scope-request', moment => moment.at === 'open-ask' && moment.ask.kind === 'scope-request' && !moment.ask.trigger);
/** A lease-loss reconciliation will settle on the record once its bound passes waits on nobody (GY-1393). */
export const leaseLossResolve = rule('lease-loss-resolve', moment => moment.at === 'open-escalation' && !!endedLeaseLoss(moment.item, moment.escalation)
  && Date.parse(moment.now) - Date.parse(moment.escalation.at) < leaseLossSettleMs);

/**
 * GY-1570: a requirement-weakening an approved requirements decision raised (the engine stamps it
 * with that decision, GY-1347) and the approval of that same decision resolved (GY-1348) waited on
 * nobody: the two-party decision was the independent judgement, and the escalation is its audit
 * line, settled in the approval's own flow. One resolved by any other decision, or raised by a
 * writer no approved decision names, was somebody stepping in and stays a signal.
 */
export const approvedDecisionWeakening = rule('approved-decision-weakening', moment => moment.at === 'escalation-resolved' && moment.details.trigger === 'requirement-weakening'
  && typeof moment.details.decision === 'string' && !!moment.details.decision && isObject(moment.details.escalation) && moment.details.escalation.decision === moment.details.decision);

/** Every exemption rule, in the order the fold consults them: the first that holds names the exemption. */
export const interventionExemptions: readonly InterventionExemption[] = [
  approvedAutoscope, successorReplan, auditedScopeWidening, routedScopeWidening, unstartedReplan,
  routineReworkGround, laneReworkGround, failedCheckRound, loopReworkRound,
  directMergeWindow, loopAutosettleInBound, answeredOffLedger, undecidedScopeRequest, leaseLossResolve, approvedDecisionWeakening,
];

/** The name of the first rule that exempts the moment, or null when it is a signal. */
export const exemption = (moment: ExemptionMoment): string | null => interventionExemptions.find(entry => entry.exempts(moment))?.name ?? null;
