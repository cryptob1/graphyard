// Concern: the fold's rule for each ledger event kind — what one row opens, answers or settles in an item's state.
import { pathScopeContains, type Stage } from '../model.js';
import type { InterventionKind, Intervention } from '../model/interventions.js';
import type { Work } from '../model/work.js';
import { approvedRework, exemption, requestedRework, routedReason, type Ask, type ReworkDecision } from '../intervention-exemptions.js';
import { routedWideningDecision } from '../model/scope-provenance.js';
import { instant, type InterventionLedgerRow } from './ledger.js';
import { impliedWidening } from './implied-widening.js';

/**
 * One rule per ledger event kind (GY-1447): a fix to how the fold reads one kind edits that kind's
 * rule, and a new kind adds a rule and a line in `foldRules`, so concurrent items change separate
 * blocks rather than rewording a shared switch. A rule reads the row and the state the item's
 * earlier rows left, updates that state, and emits the interventions the row resolves; which steps
 * are the control plane's own job and no intervention is `exemption`'s (src/intervention-exemptions.ts).
 */

/** What the fold remembers of one item between its rows. */
export interface WorkState {
  key: string | null; title: string | null; stage: Stage | null; plannedFiles: string[] | null;
  /** The blocker as the previous row left it; undefined until a row with a document is seen. */
  blocker?: string | null;
  asks: Ask[];
  reworkDecision: ReworkDecision | null;
  bypass: { seq: number; at: string; mergeSha: string; blocked: string; stage: Stage | null } | null;
  quarantine: { seq: number; at: string; epoch: number; concernAt: string | null; stage: Stage | null } | null;
  escalations: Map<string, { seq: number; at: string; reason: string; actor: string; stage: Stage | null }>;
  human: { seq: number; at: string; id: string; kind: string; needed: string; stage: Stage | null } | null;
  /** The reasons of the requirements decisions the loop routed to the approver (GY-1388), newest last. */
  routed: string[];
}
/** The fields of one intervention a rule emits; the fold adds the row's item and the wait. */
export interface EmitFields { requestedAt: string; blocked: string; stage: Stage | null; resolvedAt: string | null; resolvedBy: string | null; resolution: string | null; trigger?: string; sources: { seq: number; kind: string }[]; id?: string; source?: Intervention['source'] }
export type Emit = (row: InterventionLedgerRow, kind: InterventionKind, fields: EmitFields) => void;
/** What a rule reads: the row, its item's state, and what the previous row left. */
export interface FoldStep {
  row: InterventionLedgerRow; entry: WorkState; details: any;
  /** The stage the item was in when the row's command ran. */
  stage: Stage | null;
  source: { seq: number; kind: string };
  /** The planned scope and blocker as the previous row left them. */
  plannedBefore: string[] | null; blockerBefore: string | null | undefined;
  /** The item as the current snapshot holds it (its documentation rule and review follow-up provenance), and the plan of every item closed as its duplicate (GY-1719). */
  record?: { documentation?: Work['documentation']; origin?: Work['origin']; description?: Work['description'] } | null; absorbed?: () => string[];
  emit: Emit;
}
export type FoldRule = (step: FoldStep) => void;
export const text = (value: unknown, fallback = '') => typeof value === 'string' && value ? value : fallback;

/** A worker's blocked report opens an ask; a later report replaces it. */
const blocked: FoldRule = ({ row, entry, details, stage, source }) => {
  entry.asks = entry.asks.filter(ask => ask.kind !== 'blocked-report');
  if (typeof details.reason === 'string' && details.reason) entry.asks.push({ seq: row.seq, at: row.at, stage, kind: 'blocked-report', blocked: details.reason, paths: [], sources: [source] });
};

/** A scope request opens an ask naming the files outside plannedFiles, or a requirements change. */
const scope: FoldRule = ({ row, entry, details, stage, source }) => {
  const asks = Array.isArray(details.paths) && details.paths.length || details.remove?.length || details.criteria?.length;
  entry.asks = entry.asks.filter(ask => ask.kind !== 'scope-request');
  if (asks) entry.asks.push({ seq: row.seq, at: row.at, stage, kind: 'scope-request', blocked: details.paths?.length ? `files outside plannedFiles: ${details.paths.join(', ')}` : 'a requirements change', paths: Array.isArray(details.paths) ? details.paths : [], epoch: typeof details.epoch === 'number' ? details.epoch : null, sources: [source] });
};

/**
 * The loop's decision on the open scope request: an exempt approval answers it, a refusal marks it
 * refused by the loop. The refusal names the request's own instant (`decision.requestedAt`, the
 * server's `scopeRequest.at`, engine applyScopeDecision): the ask keeps it as `askedAt`, the identity
 * a routed decision answers by (GY-1682, decisionRequested).
 */
const autoscope: FoldRule = ({ entry, details, source }) => {
  const decision = details.decision ?? {};
  const ask = entry.asks.find(candidate => candidate.kind === 'scope-request');
  if (exemption({ at: 'autoscope', decision })) entry.asks = entry.asks.filter(candidate => candidate !== ask);
  else if (ask) { ask.trigger = 'refused-by-loop'; ask.askedAt = typeof decision.requestedAt === 'string' ? decision.requestedAt : null; ask.sources.push(source); }
};

/** A requirements revision: a widening answers the scope requests it covers, a cleared blocker the asks beside them. */
const requirements: FoldRule = ({ row, entry, details, stage, source, plannedBefore, blockerBefore, record, absorbed, emit }) => {
  const after: string[] | null = Array.isArray(row.work?.plannedFiles) ? row.work!.plannedFiles! : Array.isArray(details.intent?.plannedFiles) ? details.intent.plannedFiles : Array.isArray(details.plannedFiles) ? details.plannedFiles : null;
  const before: string[] | null = Array.isArray(details.before?.plannedFiles) ? details.before.plannedFiles : plannedBefore;
  const covers = (path: string) => !!after && after.some(planned => pathScopeContains(planned, path));
  const widened = details.liveScopeWidening === true || (!!after && !!before && after.some(path => !before.includes(path)))
    || entry.asks.some(ask => ask.kind === 'scope-request' && ask.paths.length > 0 && ask.paths.every(covers));
  if (after) entry.plannedFiles = after;
  const reason = text(details.reason ?? details.intent?.reason, 'requirements revised');
  const cleared = row.work ? !row.work.blocker : true;
  // A widening the control plane settled on its own answers the asks it covers, and nothing is a signal.
  const added = after && before ? after.filter(path => !before.includes(path)) : [];
  const documentation = details.before?.documentation ?? record?.documentation ?? null;
  const implied = widened && !!before && impliedWidening({ added, before, criteria: details.intent?.criteria ?? details.criteria, documentation, origin: record?.origin ?? null, description: details.before?.description ?? record?.description ?? null, absorbed: absorbed?.() ?? [] });
  const exempt = exemption({ at: 'requirements', details, reason, widened, implied, asked: entry.asks.length > 0 && (widened || cleared), routed: entry.routed, stage, work: row.work ?? null, blockerBefore });
  if (exempt) {
    entry.asks = entry.asks.filter(ask => !(ask.kind === 'scope-request' && ask.paths.length > 0 && ask.paths.every(covers)) && !(exempt === 'routed-scope-widening' && ask.kind === 'blocked-report'));
    return;
  }
  if (entry.asks.length && (widened || cleared)) {
    // A widening answers the scope request; a blocker it clears beside one was an escalation of its own.
    const scopeAsked = entry.asks.some(ask => ask.kind === 'scope-request');
    const widens = (ask: Ask) => widened && (ask.kind === 'scope-request' || !scopeAsked);
    for (const ask of entry.asks) if (widens(ask) || cleared) emit(row, widens(ask) ? 'scope-widening' : 'escalation', { requestedAt: ask.at, blocked: ask.blocked, stage: ask.stage, resolvedAt: row.at, resolvedBy: row.actor, resolution: reason, trigger: widens(ask) ? ask.trigger ?? ask.kind : ask.kind, sources: [...ask.sources, source] });
    entry.asks = entry.asks.filter(ask => !widens(ask) && !cleared);
  } else if (widened) emit(row, 'scope-widening', { requestedAt: row.at, blocked: `files outside plannedFiles: ${(after ?? []).filter((path: string) => !(before ?? []).includes(path)).join(', ')}`, stage, resolvedAt: row.at, resolvedBy: row.actor, resolution: reason, trigger: 'operator-widening', sources: [source] });
};

/** An unblock answers every open ask as an escalation. */
const unblock: FoldRule = ({ row, entry, details, stage, source, emit }) => {
  for (const ask of entry.asks) emit(row, 'escalation', { requestedAt: ask.at, blocked: ask.blocked, stage: ask.stage, resolvedAt: row.at, resolvedBy: row.actor, resolution: text(details.reason, 'blocker cleared'), trigger: ask.kind, sources: [...ask.sources, source] });
  entry.asks = [];
};

/**
 * A rework decision requested, and the reason of a requirements decision the loop routed to the
 * approver. A routed widening names the ask it answers (`input.answers`, daemon/decisions.ts: the
 * ask's epoch and instant, `askIdentity`); the open refused ask of that exact identity is marked as
 * the approver's while the decision stands (GY-1682, approverHoldsScopeRequest). The instant is
 * matched as the server matches it (engine `requirements`, `answers.at === scopeRequest.at`): a
 * worker that adds paths to its refused ask in the same attempt gets a merged ask with a new instant
 * (mergedScopeRequest), and a decision for the earlier one, landing after it, answers nothing on the
 * record — the new ask is the loop's to route (scope-refusal-within-bound) and counted once it outlasts the loop's bound.
 */
const decisionRequested: FoldRule = ({ row, entry, stage }) => {
  entry.reworkDecision = requestedRework(row, stage) ?? entry.reworkDecision;
  const routed = routedReason(row.payload);
  if (routed) entry.routed = [...entry.routed.slice(-4), routed];
  if (!routedWideningDecision(row.payload) || typeof row.payload?.id !== 'string') return;
  const answers = row.payload.input?.answers;
  if (!answers || typeof answers.at !== 'string') return;
  const ask = entry.asks.find(candidate => candidate.kind === 'scope-request' && candidate.trigger === 'refused-by-loop' && candidate.epoch === answers.epoch && candidate.askedAt === answers.at);
  if (ask) ask.routed = { seq: row.seq, at: row.at, decision: row.payload.id };
};

/** The approval of the open rework decision. */
const decisionApproved: FoldRule = ({ row, entry }) => {
  approvedRework(entry.reworkDecision, row);
};

/** A settled decision closes the open rework decision it names; a routed widening settled without applying (declined, stale, withdrawn, failed, superseded) hands its ask back to the loop's bound (scope-refusal-within-bound). */
const settledDecision: FoldRule = ({ row, entry }) => {
  if (entry.reworkDecision?.id === row.payload?.id) entry.reworkDecision = null;
  if (row.kind === 'decision.applied') return;
  for (const ask of entry.asks) if (ask.routed?.decision === row.payload?.id) ask.routed = null;
};

/** A rework: one intervention for the asks and decision it answers, unless exempt; a fence it discards is a settlement. */
const rework: FoldRule = ({ row, entry, details, stage, source, emit }) => {
  const candidate = row.work?.candidate, submission = row.work?.submission;
  if (!exemption({ at: 'rework', decision: entry.reworkDecision, asked: entry.asks.length > 0, grounds: row.grounds ?? null, candidate })) {
    const sources = [...entry.asks.flatMap(ask => ask.sources), ...(entry.reworkDecision ? [{ seq: entry.reworkDecision.seq, kind: 'decision.requested' }] : []), source];
    const opened = [entry.reworkDecision?.at, ...entry.asks.map(ask => ask.at)].filter((at): at is string => !!at).sort()[0] ?? row.at;
    const blocked = candidate ? `candidate ${candidate.sha.slice(0, 12)} (PR #${candidate.pr})` : submission ? `PR #${submission.pr}` : `attempt ${row.work?.epoch ?? '?'}`;
    emit(row, 'rework', { id: entry.reworkDecision ? `rework:${row.workId}:${entry.reworkDecision.id}` : undefined, requestedAt: opened, blocked, stage: entry.asks[0]?.stage ?? entry.reworkDecision?.stage ?? stage, resolvedAt: row.at, resolvedBy: row.actor, resolution: text(details.reason ?? details.intent?.reason, 'rework authorized'), trigger: entry.asks[0]?.kind ?? (entry.reworkDecision ? 'decision' : 'direct'), sources });
  }
  entry.asks = []; entry.reworkDecision = null;
  if (entry.quarantine && row.work && !row.work.quarantine) {
    emit(row, 'containment-settlement', { requestedAt: entry.quarantine.concernAt ?? entry.quarantine.at, blocked: `containment fence of epoch ${entry.quarantine.epoch}`, stage: entry.quarantine.stage, resolvedAt: row.at, resolvedBy: row.actor, resolution: 'fence discarded by rework', trigger: 'rework', sources: [{ seq: entry.quarantine.seq, kind: 'quarantine' }, source] });
    entry.quarantine = null;
  }
};

/** A guarded merge the record refused opens a bypass. */
const mergeReconciliationRefused: FoldRule = ({ row, entry, details, stage }) => {
  const mergeSha = text(details.mergeSha, 'unknown');
  entry.bypass = { seq: row.seq, at: instant(details.mergedAt, row.at), mergeSha, stage, blocked: `guarded merge of ${mergeSha.slice(0, 12)}: ${Array.isArray(details.reasons) ? details.reasons.join('; ') : 'the record refused the reconciliation'}` };
};

/** A merge delivered past the record: a bypass, unless exempt. */
const deliveredMerge: FoldRule = ({ row, entry, details, stage, source, emit }) => {
  if (exemption({ at: 'merge', kind: row.kind, details })) { entry.bypass = null; return; }
  const mergedAt = instant(details.mergedAt, row.at);
  const open = entry.bypass;
  const operator = row.kind === 'merge.operator-authorized';
  emit(row, 'bypass', { requestedAt: open?.at ?? mergedAt, blocked: open?.blocked ?? `guarded merge of ${text(details.mergeSha, 'unknown').slice(0, 12)}: ${Array.isArray(details.unmet) && details.unmet.length ? details.unmet.join('; ') : 'merged without a merge execution'}`, stage: open?.stage ?? stage,
    resolvedAt: row.at, resolvedBy: operator ? text(details.operator, row.actor) : `${text(details.requestedBy, row.actor)} approved by ${text(details.approvedBy, 'an approver')}`, resolution: text(details.judgement ?? details.reason, operator ? 'operator-authorized delivery' : 'reconciled delivery'), trigger: operator ? 'operator-authorized' : 'reconciled',
    sources: [...(open ? [{ seq: open.seq, kind: 'merge.reconciliation.refused' }] : []), source] });
  entry.bypass = null;
};

/** A containment fence raised. */
const quarantine: FoldRule = ({ row, entry, details, stage }) => {
  entry.quarantine = { seq: row.seq, at: row.at, epoch: Number(details.epoch), concernAt: null, stage };
};

/** A fenced lease that lapsed without a submission is the moment the fence became somebody's problem. */
const leaseExpired: FoldRule = ({ row, entry, details }) => {
  if (entry.quarantine && Number(details.epoch) === entry.quarantine.epoch && details.cause !== 'submitted') entry.quarantine.concernAt ??= row.at;
};

/** A fence settled by its own attempt. */
const settle: FoldRule = ({ entry }) => {
  entry.quarantine = null;
};

/** A fence settled by the loop or recovered by hand: a settlement, unless exempt. */
const settledFence: FoldRule = ({ row, entry, details, stage, source, emit }) => {
  if (entry.quarantine && !exemption({ at: 'settlement', kind: row.kind, details, when: row.at })) emit(row, 'containment-settlement', { requestedAt: entry.quarantine.concernAt ?? entry.quarantine.at, blocked: `containment fence of epoch ${entry.quarantine.epoch}`, stage: entry.quarantine.stage, resolvedAt: row.at, resolvedBy: row.actor, resolution: text(details.reason, row.kind === 'autosettle' ? 'verified dead and settled' : 'recovered'), trigger: row.kind === 'autosettle' ? 'verified-dead' : 'recovered', sources: [{ seq: entry.quarantine.seq, kind: 'quarantine' }, source] });
  entry.quarantine = null;
};

/** A standing escalation resolved: an escalation, unless exempt. */
const escalationResolved: FoldRule = ({ row, entry, details, stage, source, emit }) => {
  const escalation = details.escalation ?? {};
  const key = `${details.trigger}@${escalation.at}`;
  const open = entry.escalations.get(key);
  if (details.trigger === 'lease-loss' && entry.quarantine) entry.quarantine.concernAt ??= text(escalation.at, row.at);
  if (!exemption({ at: 'escalation-resolved', details })) emit(row, 'escalation', { id: `escalation:${row.workId}:${key}`, requestedAt: text(escalation.at, open?.at ?? row.at), blocked: text(escalation.reason, open?.reason ?? String(details.trigger)), stage: open?.stage ?? stage, resolvedAt: row.at, resolvedBy: details.approvedBy ? `${text(details.resolvedBy, row.actor)} approved by ${details.approvedBy}` : text(details.resolvedBy, row.actor), resolution: text(details.reason, 'resolved'), trigger: String(details.trigger), sources: [...(open ? [{ seq: open.seq, kind: 'raised' }] : []), source] });
  entry.escalations.delete(key);
};

/** A human-only request opened. */
const humanRequested: FoldRule = ({ row, entry, details, stage }) => {
  const request = details.request ?? {};
  entry.human = { seq: row.seq, at: text(request.at, row.at), id: request.id, kind: text(request.kind), needed: text(request.needed, text(details.decision, 'a human-only decision')), stage };
};

/** A human-only request answered. */
const humanAnswered: FoldRule = ({ row, entry, details, stage, source, emit }) => {
  const request = details.request ?? {}, answer = request.answer ?? {};
  const open = entry.human && entry.human.id === request.id ? entry.human : null;
  emit(row, 'human-only-decision', { id: `human-only-decision:${row.workId}:${request.id}`, requestedAt: text(request.at, open?.at ?? row.at), blocked: text(request.needed, open?.needed ?? 'a human-only decision'), stage: open?.stage ?? stage, resolvedAt: text(answer.at, row.at), resolvedBy: text(answer.by, row.actor), resolution: `${text(answer.outcome, 'answered')}: ${text(answer.text)}`.trim(), trigger: text(request.kind, open?.kind), sources: [...(open ? [{ seq: open.seq, kind: 'human.requested' }] : []), source] });
  entry.human = null;
};

/**
 * GY-1815: a human-only request closed as superseded by observation — a two-party decision, never the
 * operator's answer. It resolves the request like an answer does, credited to its requester and approver.
 */
const humanSuperseded: FoldRule = context => {
  const { details } = context, request = details.request ?? {}, answer = request.answer ?? {};
  const by = text(details.requestedBy, text(answer.by, context.row.actor)), approvedBy = text(details.approvedBy, text(answer.approvedBy));
  humanAnswered({ ...context, row: { ...context.row, actor: by }, details: { ...details, request: { ...request, answer: { ...answer, by: approvedBy ? `${by} approved by ${approvedBy}` : by, text: text(details.reason, text(answer.text)) } } } });
};

/** The rule for each ledger event kind the fold reads; a row of any other kind changes nothing. */
export const foldRules: Readonly<Record<string, FoldRule>> = {
  'blocked': blocked,
  'scope': scope,
  'autoscope': autoscope,
  'requirements': requirements,
  'unblock': unblock,
  'decision.requested': decisionRequested,
  'decision.approved': decisionApproved,
  'decision.applied': settledDecision,
  'decision.failed': settledDecision,
  'decision.withdrawn': settledDecision,
  'decision.stale': settledDecision,
  'decision.declined': settledDecision,
  'decision.superseded': settledDecision,
  'rework': rework,
  'merge.reconciliation.refused': mergeReconciliationRefused,
  'merge.operator-authorized': deliveredMerge,
  'merge.reconciled': deliveredMerge,
  'quarantine': quarantine,
  'lease.expired': leaseExpired,
  'settle': settle,
  'autosettle': settledFence,
  'recover': settledFence,
  'escalation.resolved': escalationResolved,
  'human.requested': humanRequested,
  'human.answered': humanAnswered,
  'human.superseded': humanSuperseded,
};
