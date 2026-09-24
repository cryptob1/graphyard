import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Engine } from './engine.js';
import { demand, pathScopeContains, standingEscalations, type Principal, type Stage, type Work } from './model.js';
import { interventionKindLabel, interventionKinds, interventionWindows, judgementVerdictLabel, type Intervention, type InterventionKind, type InterventionPattern, type InterventionPolicy, type InterventionReport, type InterventionRecordInput, type InterventionWindow, type Judgement, type JudgementInput } from './model/interventions.js';
import type { Store } from './store.js';

/**
 * Interventions read from the ledger (GY-98; see model/interventions.ts for the concept).
 *
 * The control plane already writes a typed event for every step somebody takes on its behalf:
 * a rework decision, a scope request and the revision that widened it, a merge the record
 * refused and an operator authorized, a containment fence a coordinator settled, an escalation
 * and its resolution, a human-only request and its answer. The fold below reads those events in
 * ledger order and pairs each need with what met it, so a signal's wait is measured from the
 * moment the product needed someone to the moment they acted, and never estimated. Sessions that
 * intervene by hand — the loop's re-prompt of a quiet session, a nudge a person typed — record
 * the signal explicitly (`recordIntervention`) with the same fields.
 *
 * Nothing here decides a gate. The report is a reading of history; the one thing it writes is a
 * work item when a kind of intervention at a stage keeps recurring (`openPatternItems`).
 */

/** The event kinds the fold reads. Every other row of the ledger is left unread. */
export const interventionLedgerKinds = [
  'rework', 'decision.requested', 'decision.failed', 'decision.withdrawn', 'decision.stale',
  'scope', 'autoscope', 'requirements', 'blocked', 'unblock',
  'merge.reconciliation.refused', 'merge.operator-authorized', 'merge.reconciled',
  'quarantine', 'settle', 'autosettle', 'recover', 'lease.expired', 'escalation.resolved',
  'human.requested', 'human.answered', 'intervention.recorded', 'judgement.recorded',
] as const;
/** The newest rows of those kinds a reading folds; older signals are outside the report's reach and the report says so. */
export const interventionLedgerLimit = 20_000;

/** One ledger row as the fold reads it: the typed details, and the few document paths the row embeds. */
export interface InterventionLedgerRow {
  seq: number; workId: string | null; actor: string; kind: string; at: string;
  details: any; payload?: any;
  /** The stage the item's latest earlier row recorded: the stage the item was in when this row's command ran. */
  stageBefore?: string | null;
  work?: { key?: string | null; stage?: string | null; title?: string | null; epoch?: number | null; blocker?: string | null; plannedFiles?: string[] | null; quarantine?: unknown; escalations?: { trigger: string; at: string; reason: string; actor: string }[] | null; candidate?: { sha: string; pr: number } | null; submission?: { epoch: number; pr: number } | null } | null;
}
type Db = { query: pg.Pool['query'] };
/** A provider or ledger instant in the one form the report compares: ISO with milliseconds. */
const instant = (value: unknown, fallback: string) => { const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN; return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback; };
const ledgerColumns = `seq, work_id, actor, kind, created_at, payload->'work'->>'updatedAt' AS updated_at, payload->'details' AS details,
  CASE WHEN kind LIKE 'decision.%' OR kind IN ('intervention.recorded','judgement.recorded') THEN payload ELSE NULL END AS top,
  CASE WHEN payload ? 'work' THEN jsonb_build_object('key', payload->'work'->'key', 'stage', payload->'work'->'stage', 'title', payload->'work'->'title', 'epoch', payload->'work'->'epoch', 'blocker', payload->'work'->'blocker',
    'plannedFiles', payload->'work'->'plannedFiles', 'quarantine', payload->'work'->'containmentQuarantine', 'escalations', payload->'work'->'escalations', 'candidate', payload->'work'->'candidate', 'submission', payload->'work'->'submission') ELSE NULL END AS work,
  CASE WHEN work_id IS NULL THEN NULL ELSE (SELECT earlier.payload->'work'->>'stage' FROM events earlier WHERE earlier.work_id=events.work_id AND earlier.seq<events.seq AND earlier.payload ? 'work' ORDER BY earlier.seq DESC LIMIT 1) END AS stage_before`;
/** The newest `limit` rows of the kinds the fold reads, in ledger order. */
export async function readInterventionLedger(db: Db, options: { limit?: number; workId?: string | null } = {}): Promise<{ rows: InterventionLedgerRow[]; truncated: boolean }> {
  const limit = options.limit ?? interventionLedgerLimit;
  const result = await db.query(`SELECT ${ledgerColumns} FROM events WHERE kind = ANY($1) AND ($3::uuid IS NULL OR work_id=$3) ORDER BY seq DESC LIMIT $2`, [[...interventionLedgerKinds], limit + 1, options.workId ?? null]);
  const truncated = result.rows.length > limit;
  // A row written with the document carries the transaction instant the document's own
  // timestamps use (`updatedAt`); a raw row has only its insertion instant.
  const rows = result.rows.slice(0, limit).reverse().map(row => ({ seq: Number(row.seq), workId: row.work_id, actor: row.actor, kind: row.kind, at: instant(row.updated_at, new Date(row.created_at).toISOString()), details: row.details, payload: row.top ?? undefined, work: row.work ?? null, stageBefore: row.stage_before ?? null }));
  return { rows, truncated };
}

interface Ask { seq: number; at: string; stage: Stage | null; kind: 'scope-request' | 'blocked-report'; blocked: string; paths: string[]; trigger?: string; sources: { seq: number; kind: string }[] }
interface WorkState {
  key: string | null; title: string | null; stage: Stage | null; plannedFiles: string[] | null;
  asks: Ask[];
  reworkDecision: { seq: number; at: string; id: string; stage: Stage | null } | null;
  bypass: { seq: number; at: string; mergeSha: string; blocked: string; stage: Stage | null } | null;
  quarantine: { seq: number; at: string; epoch: number; concernAt: string | null; stage: Stage | null } | null;
  escalations: Map<string, { seq: number; at: string; reason: string; actor: string; stage: Stage | null }>;
  human: { seq: number; at: string; id: string; kind: string; needed: string; stage: Stage | null } | null;
}
const stageOf = (value: unknown): Stage | null => typeof value === 'string' ? value as Stage : null;
const ms = (from: string, to: string) => Math.max(0, Date.parse(to) - Date.parse(from));
const text = (value: unknown, fallback = '') => typeof value === 'string' && value ? value : fallback;

/**
 * Fold the ledger rows into interventions and judgements. `work` is the current snapshot: it
 * names items, decides the stage of a row that embeds no document, and settles what is still
 * open — an ask the fold saw opened but whose item no longer carries a blocker was met by a
 * command the fold does not read, so it is not reported as waiting.
 */
export function foldInterventions(rows: InterventionLedgerRow[], work: readonly Work[], now: string): { interventions: Intervention[]; judgements: Judgement[] } {
  const items = new Map(work.map(item => [item.id, item]));
  const states = new Map<string, WorkState>();
  const state = (id: string): WorkState => {
    let entry = states.get(id);
    if (!entry) { const item = items.get(id); entry = { key: item?.key ?? null, title: item?.title ?? null, stage: null, plannedFiles: null, asks: [], reworkDecision: null, bypass: null, quarantine: null, escalations: new Map(), human: null }; states.set(id, entry); }
    return entry;
  };
  const interventions: Intervention[] = [], judgements: Judgement[] = [];
  const named = (id: string | null) => { if (!id) return null; const item = items.get(id), entry = states.get(id); return { id, key: item?.key ?? entry?.key ?? id, title: item?.title ?? entry?.title ?? '' }; };
  const emit = (row: InterventionLedgerRow, kind: InterventionKind, fields: { requestedAt: string; blocked: string; stage: Stage | null; resolvedAt: string | null; resolvedBy: string | null; resolution: string | null; trigger?: string; sources: { seq: number; kind: string }[]; id?: string; source?: Intervention['source'] }) => {
    const resolvedAt = fields.resolvedAt;
    interventions.push({ id: fields.id ?? `${kind}:${row.workId ?? 'global'}:${fields.sources[0]?.seq ?? fields.requestedAt}`, kind, source: fields.source ?? 'ledger', work: named(row.workId), stage: fields.stage, blocked: fields.blocked, ...(fields.trigger ? { trigger: fields.trigger } : {}),
      requestedAt: fields.requestedAt, resolvedAt, waitedMs: ms(fields.requestedAt, resolvedAt ?? now), resolvedBy: fields.resolvedBy, resolution: fields.resolution, sources: fields.sources });
  };
  for (const row of rows) {
    const details = row.details ?? {};
    if (row.kind === 'judgement.recorded') {
      const judged = row.payload ?? {};
      const item = work.find(candidate => candidate.origin?.judgement?.id === judged.id);
      judgements.push({ id: judged.id, verdict: judged.verdict, text: judged.text, work: judged.work ? { id: judged.work.id, key: judged.work.key, title: items.get(judged.work.id)?.title ?? judged.work.title ?? '' } : null, page: judged.page ?? null, by: row.actor, at: judged.at ?? row.at, item: item ? { id: item.id, key: item.key, stage: item.stage } : null, seq: row.seq });
      continue;
    }
    if (row.kind === 'intervention.recorded') {
      const recorded = row.payload ?? {};
      const requestedAt = text(recorded.since, recorded.at ?? row.at);
      interventions.push({ id: recorded.id ?? `recorded:${row.seq}`, kind: recorded.kind, source: 'recorded', work: recorded.work ? named(recorded.work.id) ?? { id: recorded.work.id, key: recorded.work.key, title: '' } : null, stage: stageOf(recorded.stage), blocked: text(recorded.blocked), ...(recorded.trigger ? { trigger: recorded.trigger } : {}),
        requestedAt, resolvedAt: recorded.at ?? row.at, waitedMs: ms(requestedAt, recorded.at ?? row.at), resolvedBy: row.actor, resolution: typeof recorded.resolution === 'string' ? recorded.resolution : null, sources: [{ seq: row.seq, kind: row.kind }] });
      continue;
    }
    if (!row.workId) continue;
    const entry = state(row.workId);
    if (row.work?.key) entry.key = row.work.key;
    if (row.work?.title) entry.title = row.work.title;
    // The stage the item was in when the command ran: what the previous row left, not what this
    // row's own mutation moved it to (a park or a rework moves the stage it was needed at).
    const stage = stageOf(row.stageBefore) ?? entry.stage ?? stageOf(row.work?.stage);
    entry.stage = stageOf(row.work?.stage) ?? stage;
    // The planned scope as the previous row left it, so a revision is judged against what it changed.
    const plannedBefore = entry.plannedFiles;
    if (Array.isArray(row.work?.plannedFiles)) entry.plannedFiles = row.work!.plannedFiles!;
    const source = { seq: row.seq, kind: row.kind };
    // Standing escalations, as every embedded document shows them: a trigger not seen before was
    // raised since the last row; one that vanished without a resolution row was auto-settled.
    if (row.work && Array.isArray(row.work.escalations)) {
      const standing = new Set(row.work.escalations.map(escalation => `${escalation.trigger}@${escalation.at}`));
      for (const escalation of row.work.escalations) {
        if (entry.escalations.has(`${escalation.trigger}@${escalation.at}`)) continue;
        entry.escalations.set(`${escalation.trigger}@${escalation.at}`, { seq: row.seq, at: escalation.at, reason: escalation.reason, actor: escalation.actor, stage });
        // A lost lease under a standing fence is the moment the fence became somebody's problem.
        if (escalation.trigger === 'lease-loss' && entry.quarantine) entry.quarantine.concernAt ??= escalation.at;
      }
      for (const key of [...entry.escalations.keys()]) if (!standing.has(key) && row.kind !== 'escalation.resolved') entry.escalations.delete(key);
    }
    switch (row.kind) {
      case 'blocked': {
        entry.asks = entry.asks.filter(ask => ask.kind !== 'blocked-report');
        if (typeof details.reason === 'string' && details.reason) entry.asks.push({ seq: row.seq, at: row.at, stage, kind: 'blocked-report', blocked: details.reason, paths: [], sources: [source] });
        break;
      }
      case 'scope': {
        const asks = Array.isArray(details.paths) && details.paths.length || details.remove?.length || details.criteria?.length;
        entry.asks = entry.asks.filter(ask => ask.kind !== 'scope-request');
        if (asks) entry.asks.push({ seq: row.seq, at: row.at, stage, kind: 'scope-request', blocked: details.paths?.length ? `files outside plannedFiles: ${details.paths.join(', ')}` : 'a requirements change', paths: Array.isArray(details.paths) ? details.paths : [], sources: [source] });
        break;
      }
      case 'autoscope': {
        const decision = details.decision ?? {};
        const ask = entry.asks.find(candidate => candidate.kind === 'scope-request');
        // Approved by the control plane itself: nobody stepped in, so nothing is a signal.
        if (decision.state === 'approved') entry.asks = entry.asks.filter(candidate => candidate !== ask);
        else if (ask) { ask.trigger = 'refused-by-loop'; ask.sources.push(source); }
        break;
      }
      case 'requirements': {
        const after: string[] | null = Array.isArray(row.work?.plannedFiles) ? row.work!.plannedFiles! : Array.isArray(details.intent?.plannedFiles) ? details.intent.plannedFiles : Array.isArray(details.plannedFiles) ? details.plannedFiles : null;
        const before: string[] | null = Array.isArray(details.before?.plannedFiles) ? details.before.plannedFiles : plannedBefore;
        const covers = (path: string) => !!after && after.some(planned => pathScopeContains(planned, path));
        const widened = details.liveScopeWidening === true || (!!after && !!before && after.some(path => !before.includes(path)))
          || entry.asks.some(ask => ask.kind === 'scope-request' && ask.paths.length > 0 && ask.paths.every(covers));
        if (after) entry.plannedFiles = after;
        const reason = text(details.reason ?? details.intent?.reason, 'requirements revised');
        const cleared = row.work ? !row.work.blocker : true;
        if (entry.asks.length && (widened || cleared)) {
          // A widening answers the scope request; a blocker it clears beside one was an escalation of its own.
          const scopeAsked = entry.asks.some(ask => ask.kind === 'scope-request');
          const widens = (ask: Ask) => widened && (ask.kind === 'scope-request' || !scopeAsked);
          for (const ask of entry.asks) if (widens(ask) || cleared) emit(row, widens(ask) ? 'scope-widening' : 'escalation', { requestedAt: ask.at, blocked: ask.blocked, stage: ask.stage, resolvedAt: row.at, resolvedBy: row.actor, resolution: reason, trigger: widens(ask) ? ask.trigger ?? ask.kind : ask.kind, sources: [...ask.sources, source] });
          entry.asks = entry.asks.filter(ask => !widens(ask) && !cleared);
        } else if (widened) emit(row, 'scope-widening', { requestedAt: row.at, blocked: `files outside plannedFiles: ${(after ?? []).filter((path: string) => !(before ?? []).includes(path)).join(', ')}`, stage, resolvedAt: row.at, resolvedBy: row.actor, resolution: reason, trigger: 'operator-widening', sources: [source] });
        break;
      }
      case 'unblock': {
        for (const ask of entry.asks) emit(row, 'escalation', { requestedAt: ask.at, blocked: ask.blocked, stage: ask.stage, resolvedAt: row.at, resolvedBy: row.actor, resolution: text(details.reason, 'blocker cleared'), trigger: ask.kind, sources: [...ask.sources, source] });
        entry.asks = [];
        break;
      }
      case 'decision.requested': {
        if (row.payload?.action === 'rework') entry.reworkDecision = { seq: row.seq, at: row.at, id: row.payload.id, stage };
        break;
      }
      case 'decision.failed': case 'decision.withdrawn': case 'decision.stale': {
        if (entry.reworkDecision?.id === row.payload?.id) entry.reworkDecision = null;
        break;
      }
      case 'rework': {
        const sources = [...entry.asks.flatMap(ask => ask.sources), ...(entry.reworkDecision ? [{ seq: entry.reworkDecision.seq, kind: 'decision.requested' }] : []), source];
        const opened = [entry.reworkDecision?.at, ...entry.asks.map(ask => ask.at)].filter((at): at is string => !!at).sort()[0] ?? row.at;
        const candidate = row.work?.candidate, submission = row.work?.submission;
        const blocked = candidate ? `candidate ${candidate.sha.slice(0, 12)} (PR #${candidate.pr})` : submission ? `PR #${submission.pr}` : `attempt ${row.work?.epoch ?? '?'}`;
        emit(row, 'rework', { id: entry.reworkDecision ? `rework:${row.workId}:${entry.reworkDecision.id}` : undefined, requestedAt: opened, blocked, stage: entry.asks[0]?.stage ?? entry.reworkDecision?.stage ?? stage, resolvedAt: row.at, resolvedBy: row.actor, resolution: text(details.reason ?? details.intent?.reason, 'rework authorized'), trigger: entry.asks[0]?.kind ?? (entry.reworkDecision ? 'decision' : 'direct'), sources });
        entry.asks = []; entry.reworkDecision = null;
        if (entry.quarantine && row.work && !row.work.quarantine) {
          emit(row, 'containment-settlement', { requestedAt: entry.quarantine.concernAt ?? entry.quarantine.at, blocked: `containment fence of epoch ${entry.quarantine.epoch}`, stage: entry.quarantine.stage, resolvedAt: row.at, resolvedBy: row.actor, resolution: 'fence discarded by rework', trigger: 'rework', sources: [{ seq: entry.quarantine.seq, kind: 'quarantine' }, source] });
          entry.quarantine = null;
        }
        break;
      }
      case 'merge.reconciliation.refused': {
        const mergeSha = text(details.mergeSha, 'unknown');
        entry.bypass = { seq: row.seq, at: instant(details.mergedAt, row.at), mergeSha, stage, blocked: `guarded merge of ${mergeSha.slice(0, 12)}: ${Array.isArray(details.reasons) ? details.reasons.join('; ') : 'the record refused the reconciliation'}` };
        break;
      }
      case 'merge.operator-authorized': case 'merge.reconciled': {
        // A merge inside a direct-merge window is the operator's standing policy, not a one-off intervention.
        if (details.directMerge) { entry.bypass = null; break; }
        const mergedAt = instant(details.mergedAt, row.at);
        const open = entry.bypass;
        const operator = row.kind === 'merge.operator-authorized';
        emit(row, 'bypass', { requestedAt: open?.at ?? mergedAt, blocked: open?.blocked ?? `guarded merge of ${text(details.mergeSha, 'unknown').slice(0, 12)}: ${Array.isArray(details.unmet) && details.unmet.length ? details.unmet.join('; ') : 'merged without a merge execution'}`, stage: open?.stage ?? stage,
          resolvedAt: row.at, resolvedBy: operator ? text(details.operator, row.actor) : `${text(details.requestedBy, row.actor)} approved by ${text(details.approvedBy, 'an approver')}`, resolution: text(details.judgement ?? details.reason, operator ? 'operator-authorized delivery' : 'reconciled delivery'), trigger: operator ? 'operator-authorized' : 'reconciled',
          sources: [...(open ? [{ seq: open.seq, kind: 'merge.reconciliation.refused' }] : []), source] });
        entry.bypass = null;
        break;
      }
      case 'quarantine': entry.quarantine = { seq: row.seq, at: row.at, epoch: Number(details.epoch), concernAt: null, stage }; break;
      case 'lease.expired': {
        if (entry.quarantine && Number(details.epoch) === entry.quarantine.epoch && details.cause !== 'submitted') entry.quarantine.concernAt ??= row.at;
        break;
      }
      case 'settle': entry.quarantine = null; break;
      case 'autosettle': case 'recover': {
        if (entry.quarantine) emit(row, 'containment-settlement', { requestedAt: entry.quarantine.concernAt ?? entry.quarantine.at, blocked: `containment fence of epoch ${entry.quarantine.epoch}`, stage: entry.quarantine.stage, resolvedAt: row.at, resolvedBy: row.actor, resolution: text(details.reason, row.kind === 'autosettle' ? 'verified dead and settled' : 'recovered'), trigger: row.kind === 'autosettle' ? 'verified-dead' : 'recovered', sources: [{ seq: entry.quarantine.seq, kind: 'quarantine' }, source] });
        entry.quarantine = null;
        break;
      }
      case 'escalation.resolved': {
        const escalation = details.escalation ?? {};
        const key = `${details.trigger}@${escalation.at}`;
        const open = entry.escalations.get(key);
        if (details.trigger === 'lease-loss' && entry.quarantine) entry.quarantine.concernAt ??= text(escalation.at, row.at);
        emit(row, 'escalation', { id: `escalation:${row.workId}:${key}`, requestedAt: text(escalation.at, open?.at ?? row.at), blocked: text(escalation.reason, open?.reason ?? String(details.trigger)), stage: open?.stage ?? stage, resolvedAt: row.at, resolvedBy: details.approvedBy ? `${text(details.resolvedBy, row.actor)} approved by ${details.approvedBy}` : text(details.resolvedBy, row.actor), resolution: text(details.reason, 'resolved'), trigger: String(details.trigger), sources: [...(open ? [{ seq: open.seq, kind: 'raised' }] : []), source] });
        entry.escalations.delete(key);
        break;
      }
      case 'human.requested': {
        const request = details.request ?? {};
        entry.human = { seq: row.seq, at: text(request.at, row.at), id: request.id, kind: text(request.kind), needed: text(request.needed, text(details.decision, 'a human-only decision')), stage };
        break;
      }
      case 'human.answered': {
        const request = details.request ?? {}, answer = request.answer ?? {};
        const open = entry.human && entry.human.id === request.id ? entry.human : null;
        emit(row, 'human-only-decision', { id: `human-only-decision:${row.workId}:${request.id}`, requestedAt: text(request.at, open?.at ?? row.at), blocked: text(request.needed, open?.needed ?? 'a human-only decision'), stage: open?.stage ?? stage, resolvedAt: text(answer.at, row.at), resolvedBy: text(answer.by, row.actor), resolution: `${text(answer.outcome, 'answered')}: ${text(answer.text)}`.trim(), trigger: text(request.kind, open?.kind), sources: [...(open ? [{ seq: open.seq, kind: 'human.requested' }] : []), source] });
        entry.human = null;
        break;
      }
    }
  }
  // What is still open, settled against the current record so a need met by a command the fold
  // does not read is never reported as waiting.
  for (const [id, entry] of states) {
    const item = items.get(id);
    if (!item || item.stage === 'done') continue;
    const row = { seq: 0, workId: id, actor: '', kind: 'open', at: now, details: {} };
    const open = (kind: InterventionKind, fields: Parameters<typeof emit>[2]) => emit(row, kind, { ...fields, resolvedAt: null, resolvedBy: null, resolution: null });
    // An undecided scope request is the loop's to answer within minutes; only one the loop refused waits on a person.
    if (item.blocker || item.scopeRequest) for (const ask of entry.asks) {
      if (ask.kind === 'scope-request' && !ask.trigger) continue;
      open(ask.kind === 'scope-request' ? 'scope-widening' : 'escalation', { requestedAt: ask.at, blocked: ask.blocked, stage: ask.stage, resolvedAt: null, resolvedBy: null, resolution: null, trigger: ask.trigger ?? ask.kind, sources: ask.sources });
    }
    if (entry.reworkDecision) open('rework', { id: `rework:${id}:${entry.reworkDecision.id}`, requestedAt: entry.reworkDecision.at, blocked: item.candidate ? `candidate ${item.candidate.sha.slice(0, 12)} (PR #${item.candidate.pr})` : `attempt ${item.epoch}`, stage: entry.reworkDecision.stage, resolvedAt: null, resolvedBy: null, resolution: null, trigger: 'decision', sources: [{ seq: entry.reworkDecision.seq, kind: 'decision.requested' }] });
    if (entry.bypass) open('bypass', { requestedAt: entry.bypass.at, blocked: entry.bypass.blocked, stage: entry.bypass.stage, resolvedAt: null, resolvedBy: null, resolution: null, trigger: 'refused-reconciliation', sources: [{ seq: entry.bypass.seq, kind: 'merge.reconciliation.refused' }] });
    if (entry.quarantine?.concernAt && item.containmentQuarantine) open('containment-settlement', { requestedAt: entry.quarantine.concernAt, blocked: `containment fence of epoch ${entry.quarantine.epoch}`, stage: entry.quarantine.stage, resolvedAt: null, resolvedBy: null, resolution: null, trigger: 'unsettled', sources: [{ seq: entry.quarantine.seq, kind: 'quarantine' }] });
    for (const escalation of standingEscalations(item)) {
      const known = entry.escalations.get(`${escalation.trigger}@${escalation.at}`);
      open('escalation', { id: `escalation:${id}:${escalation.trigger}@${escalation.at}`, requestedAt: escalation.at, blocked: escalation.reason, stage: known?.stage ?? entry.stage, resolvedAt: null, resolvedBy: null, resolution: null, trigger: escalation.trigger, sources: known ? [{ seq: known.seq, kind: 'raised' }] : [] });
    }
    if (entry.human && item.humanRequest?.id === entry.human.id) open('human-only-decision', { id: `human-only-decision:${id}:${entry.human.id}`, requestedAt: entry.human.at, blocked: entry.human.needed, stage: entry.human.stage, resolvedAt: null, resolvedBy: null, resolution: null, trigger: entry.human.kind, sources: [{ seq: entry.human.seq, kind: 'human.requested' }] });
  }
  interventions.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || (b.sources[0]?.seq ?? 0) - (a.sources[0]?.seq ?? 0));
  return { interventions, judgements };
}

const day = 86_400_000;
const deliveredAt = (item: Work) => item.stage === 'done' ? item.delivery?.mergedAt ?? item.observation?.mergedAt ?? item.stageEnteredAt : null;
const stageKey = (stage: Stage | null): Stage | 'none' => stage ?? 'none';

/** The report over a window ending now (AC-2): what the product made people do by hand, and where. */
export function computeInterventionReport(folded: { interventions: Intervention[]; judgements: Judgement[] }, work: readonly Work[], policy: InterventionPolicy, options: { days: InterventionWindow; now: string; kind?: InterventionKind | null; stage?: Stage | null; work?: string | null }): InterventionReport {
  const to = options.now, from = new Date(Date.parse(to) - options.days * day).toISOString();
  const inWindow = (intervention: Intervention) => intervention.requestedAt < to && (intervention.resolvedAt === null || intervention.resolvedAt >= from);
  const all = folded.interventions.filter(inWindow);
  const filtered = all.filter(intervention => (!options.kind || intervention.kind === options.kind) && (!options.stage || intervention.stage === options.stage) && (!options.work || intervention.work?.key === options.work || intervention.work?.id === options.work));
  const deliveries = work.filter(item => { const at = deliveredAt(item); return !!at && at >= from && at < to; });
  const sum = (list: Intervention[]) => list.reduce((total, entry) => total + entry.waitedMs, 0);
  const group = <K extends string>(list: Intervention[], key: (entry: Intervention) => K) => {
    const buckets = new Map<K, Intervention[]>();
    for (const entry of list) { const bucket = buckets.get(key(entry)) ?? []; bucket.push(entry); buckets.set(key(entry), bucket); }
    return [...buckets].map(([name, entries]) => ({ name, entries, count: entries.length, open: entries.filter(entry => entry.resolvedAt === null).length, waitedMs: sum(entries) })).sort((a, b) => b.count - a.count || b.waitedMs - a.waitedMs);
  };
  const bucketMs = options.days === 7 ? day : 7 * day;
  const trend = Array.from({ length: Math.ceil(options.days * day / bucketMs) }, (_, index) => {
    const end = Date.parse(to) - index * bucketMs, start = end - bucketMs;
    const within = (at: string | null) => !!at && Date.parse(at) >= start && Date.parse(at) < end;
    const entries = filtered.filter(entry => within(entry.requestedAt));
    return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), interventions: entries.length, deliveries: deliveries.filter(item => within(deliveredAt(item))).length, waitedMs: sum(entries) };
  }).reverse();
  const costliest = group(filtered.filter(entry => entry.work), entry => entry.work!.id).slice(0, 10).map(bucket => {
    const item = work.find(candidate => candidate.id === bucket.name);
    const kinds: Partial<Record<InterventionKind, number>> = {};
    for (const entry of bucket.entries) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
    return { key: item?.key ?? bucket.entries[0].work!.key, title: item?.title ?? bucket.entries[0].work!.title, stage: item?.stage ?? 'done', count: bucket.count, waitedMs: bucket.waitedMs, kinds };
  }).sort((a, b) => b.waitedMs - a.waitedMs || b.count - a.count);
  const patterns = detectPatterns(folded.interventions, work, policy, to).map(pattern => ({ kind: pattern.kind, stage: stageKey(pattern.stage), count: pattern.count, threshold: policy.threshold, crossed: pattern.item !== null || pattern.unlinked.length >= policy.threshold, work: pattern.item ? { id: pattern.item.id, key: pattern.item.key, stage: pattern.item.stage } : null }));
  return {
    window: { days: options.days, from, to }, policy, deliveries: deliveries.length,
    total: filtered.length, open: filtered.filter(entry => entry.resolvedAt === null).length, waitedMs: sum(filtered),
    ratePerDelivery: deliveries.length ? Number((filtered.length / deliveries.length).toFixed(2)) : null,
    byKind: group(filtered, entry => entry.kind).map(({ name, count, open, waitedMs }) => ({ kind: name, count, open, waitedMs })),
    byStage: group(filtered, entry => stageKey(entry.stage)).map(({ name, count, open, waitedMs }) => ({ stage: name, count, open, waitedMs })),
    byKindAndStage: group(filtered, entry => `${entry.kind}|${stageKey(entry.stage)}` as `${InterventionKind}|${Stage | 'none'}`).map(({ name, count, waitedMs }) => { const [kind, stage] = name.split('|') as [InterventionKind, Stage | 'none']; return { kind, stage, count, waitedMs }; }),
    trend, costliest, patterns,
    judgements: folded.judgements.filter(judgement => judgement.at >= from && judgement.at < to && (!options.work || judgement.work?.key === options.work || judgement.work?.id === options.work)).sort((a, b) => b.at.localeCompare(a.at)),
    interventions: filtered.slice(0, 500),
  };
}

/** Every kind-at-stage pair with at least one instance needed inside the policy window, with the item that stands for it. */
export function detectPatterns(interventions: Intervention[], work: readonly Work[], policy: InterventionPolicy, now: string) {
  const from = new Date(Date.parse(now) - policy.windowDays * day).toISOString();
  const linked = new Set(work.flatMap(item => item.origin?.pattern?.instances.map(instance => instance.id) ?? []));
  const recent = interventions.filter(entry => entry.requestedAt >= from && entry.requestedAt < now);
  const groups = new Map<string, Intervention[]>();
  for (const entry of recent) { const key = `${entry.kind}|${stageKey(entry.stage)}`; groups.set(key, [...(groups.get(key) ?? []), entry]); }
  return [...groups].map(([key, entries]) => {
    const [kind, stage] = key.split('|') as [InterventionKind, Stage | 'none'];
    const item = work.find(candidate => candidate.origin?.pattern && candidate.origin.pattern.kind === kind && stageKey(candidate.origin.pattern.stage) === stage && candidate.stage !== 'done') ?? null;
    return { kind, stage: stage === 'none' ? null : stage, count: entries.length, entries, unlinked: entries.filter(entry => !linked.has(entry.id)), item, from };
  }).sort((a, b) => b.count - a.count);
}

/** The control plane acting as itself when it opens work from feedback; the ledger names it as every other control-plane write is named. */
export const controlPlaneActor: Principal = { id: 'graphyard', role: 'admin', sessionKind: 'ai' };
const minutes = (value: number) => `${Math.round(value / 60_000)} min`;

/**
 * A recurring intervention becomes work without a human noticing it (AC-3): a kind at a stage
 * that crossed the threshold inside the window opens one item naming the pattern, its frequency,
 * the items it affected and the attention it cost, and linking the instances as evidence. While
 * that item is open nothing is opened again for the pattern; instances an item already links
 * never count towards a second one.
 */
export async function openPatternItems(engine: Engine, policy: InterventionPolicy, options: { now?: string; actor?: Principal; limit?: number } = {}) {
  const snapshot = await engine.store.workSnapshot();
  const now = options.now ?? snapshot.now;
  const { rows, truncated } = await readInterventionLedger(engine.store.pool, { limit: options.limit });
  const folded = foldInterventions(rows, snapshot.work, now);
  const opened: Work[] = [];
  for (const pattern of detectPatterns(folded.interventions, snapshot.work, policy, now)) {
    if (pattern.item || pattern.unlinked.length < policy.threshold) continue;
    const instances = pattern.unlinked;
    const items = [...new Set(instances.map(entry => entry.work?.key).filter((key): key is string => !!key))];
    const waitedMs = instances.reduce((total, entry) => total + entry.waitedMs, 0);
    const label = interventionKindLabel[pattern.kind], where = pattern.stage ? `the ${pattern.stage} stage` : 'no stage';
    const origin: InterventionPattern = { kind: pattern.kind, stage: pattern.stage, window: { from: pattern.from, to: now, days: policy.windowDays }, threshold: policy.threshold, count: instances.length, waitedMs, items,
      instances: instances.map(entry => ({ id: entry.id, work: entry.work?.key ?? null, requestedAt: entry.requestedAt, resolvedAt: entry.resolvedAt, waitedMs: entry.waitedMs, sources: entry.sources.slice(0, 20) })), detectedAt: now };
    const description = [
      `Graphyard opened this item itself: ${instances.length} ${label} interventions were needed at ${where} between ${pattern.from} and ${now} (threshold ${policy.threshold} in ${policy.windowDays} days). Every intervention is an admission that the product asked a person or a coordinator to do its job; this one recurs.`,
      `Frequency: ${instances.length} in ${policy.windowDays} days, ${(instances.length / policy.windowDays).toFixed(2)} per day. Attention cost: ${minutes(waitedMs)} waited in total, ${minutes(waitedMs / instances.length)} per intervention.`,
      `Items affected: ${items.length ? items.join(', ') : 'none named'}.`,
      'Instances (the evidence; each is read from the ledger rows it names):',
      ...instances.map(entry => `- ${entry.id}: ${entry.work?.key ?? 'no item'} — blocked ${entry.blocked}; waited ${minutes(entry.waitedMs)}${entry.resolvedBy ? `; resolved by ${entry.resolvedBy}` : '; still open'}${entry.resolution ? ` (${entry.resolution})` : ''}; ledger ${entry.sources.map(source => `${source.kind}#${source.seq}`).join(', ')}`),
      'Find what makes this intervention necessary and remove it, so the product handles the case itself.',
    ].join('\n\n');
    const stageSlug = pattern.stage ?? 'none';
    const key = `intervention-pattern:${pattern.kind}:${stageSlug}:${createHash('sha256').update(instances.map(entry => entry.id).sort().join(',')).digest('hex').slice(0, 32)}`;
    const work = await engine.execute(options.actor ?? controlPlaneActor, 'create', null, {
      title: `Recurring ${label} interventions at ${where}: ${instances.length} in ${policy.windowDays} days`.slice(0, 200), description: description.slice(0, 20000), type: 'bug', priority: 1,
      criteria: [{ id: 'AC-1', text: `The cause of the recurring ${label} interventions at ${where} is found and removed: the intervention report shows the ${pattern.kind} rate at ${where} below ${policy.threshold} per ${policy.windowDays} days after the change ships, and the linked instances could not recur`, proofs: [`manual:intervention-pattern-${pattern.kind}-${stageSlug}`] }],
      origin: { pattern: origin }, reason: `Recurring ${label} interventions at ${where} crossed the threshold (${instances.length} ≥ ${policy.threshold} in ${policy.windowDays} days)`,
    }, key);
    opened.push(work);
    snapshot.work.push(work);
  }
  return { opened, truncated };
}

/** The signal a session records for an intervention it performed by hand. */
export async function recordIntervention(store: Store, actor: Principal, input: InterventionRecordInput, key: string) {
  demand(['coordinator', 'admin', 'operator-agent'].includes(actor.role), 'Coordinator or operator permission required', 403);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  return store.transaction(async (db, now) => {
    const receipt = (await db.query('SELECT result FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
    if (receipt) return receipt.result as Intervention;
    const work = input.work ? (await db.query("SELECT id, document->>'key' AS key, document->>'title' AS title, document->>'stage' AS stage FROM work_items WHERE id::text=$1 OR document->>'key'=$1", [input.work])).rows[0] : null;
    demand(!input.work || work, 'Work item not found', 404);
    const at = now.toISOString(), since = input.since ? new Date(input.since).toISOString() : at;
    demand(Date.parse(since) <= now.getTime(), 'since must not lie in the future');
    const recorded = { id: randomUUID(), kind: input.kind, work: work ? { id: work.id, key: work.key, title: work.title } : null, stage: input.stage ?? work?.stage ?? null, blocked: input.blocked, ...(input.trigger ? { trigger: input.trigger } : {}), since, at, resolution: input.resolution, recordedBy: actor.id };
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work?.id ?? null, actor.id, 'intervention.recorded', JSON.stringify(recorded)]);
    const result: Intervention = { id: recorded.id, kind: recorded.kind, source: 'recorded', work: recorded.work, stage: recorded.stage, blocked: recorded.blocked, ...(input.trigger ? { trigger: input.trigger } : {}), requestedAt: since, resolvedAt: at, waitedMs: ms(since, at), resolvedBy: actor.id, resolution: input.resolution, sources: [] };
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, 'intervention', JSON.stringify(result)]);
    return result;
  });
}

/** The operator's judgement about delivered work, recorded against the item or the page it concerns (AC-4). */
export async function recordJudgement(store: Store, actor: Principal, input: JudgementInput, key: string) {
  demand(['admin', 'coordinator', 'operator-agent'].includes(actor.role), 'Operator permission required', 403);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  return store.transaction(async (db, now) => {
    const receipt = (await db.query('SELECT result FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
    if (receipt) return receipt.result as Judgement;
    const work = input.work ? (await db.query("SELECT id, document->>'key' AS key, document->>'title' AS title FROM work_items WHERE id::text=$1 OR document->>'key'=$1", [input.work])).rows[0] : null;
    demand(!input.work || work, 'Work item not found', 404);
    const recorded = { id: randomUUID(), verdict: input.verdict, text: input.text, work: work ? { id: work.id, key: work.key, title: work.title } : null, page: input.page ?? null, by: actor.id, at: now.toISOString() };
    const inserted = await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4) RETURNING seq', [work?.id ?? null, actor.id, 'judgement.recorded', JSON.stringify(recorded)]);
    const result: Judgement = { ...recorded, item: null, seq: Number(inserted.rows[0].seq) };
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, 'judgement', JSON.stringify(result)]);
    return result;
  });
}

/**
 * Turn a recorded judgement into a work item: the same standing as a failed gate, as an item
 * the loop dispatches. The judgement's own words become the description; the caller may name
 * the criteria and planned files, and otherwise the item asks for the judgement to be addressed
 * and reviewed by hand. One item per judgement: a second call returns the first.
 */
export async function judgementToWork(engine: Engine, actor: Principal, judgementId: string, input: { title?: string; criteria?: { id: string; text: string; proofs: string[] }[]; plannedFiles?: string[]; priority?: number }, key: string) {
  demand(actor.role === 'admin' || actor.role === 'operator-agent', 'Operator permission required', 403);
  const row = (await engine.store.pool.query("SELECT seq, actor, payload FROM events WHERE kind='judgement.recorded' AND payload->>'id'=$1", [judgementId])).rows[0];
  demand(row, 'Judgement not found', 404);
  const judgement = row.payload as Omit<Judgement, 'item' | 'seq'>;
  const existing = (await engine.store.list()).find(item => item.origin?.judgement?.id === judgementId);
  if (existing) return existing;
  const subject = judgement.work ? `${judgement.work.key} (${judgement.work.title})` : judgement.page!;
  const verdict = judgementVerdictLabel[judgement.verdict];
  return engine.execute(actor, 'create', null, {
    title: (input.title ?? `${subject} is ${verdict}: ${judgement.text}`).slice(0, 200),
    description: `Operator judgement recorded by ${judgement.by} at ${judgement.at} about ${subject}: ${verdict}.\n\n${judgement.text}\n\nThis item carries the judgement into the backlog with the same standing as a failed gate; it was not typed into a chat.`,
    type: 'bug', priority: input.priority ?? 1, plannedFiles: input.plannedFiles ?? [],
    criteria: input.criteria ?? [{ id: 'AC-1', text: `The judgement about ${judgement.work?.key ?? judgement.page} (${verdict}) is addressed: ${judgement.text}`, proofs: [`manual:judgement-${judgementId.slice(0, 8)}-review`] }],
    origin: { judgement: { id: judgement.id, verdict: judgement.verdict, work: judgement.work?.key ?? null, page: judgement.page ?? null, by: judgement.by, at: judgement.at } },
    reason: `Operator judgement ${judgementId}: ${subject} is ${verdict}`,
  }, key);
}

/** The full read behind the API and the CLI: the ledger folded against the current snapshot, then reported over the window. */
export async function readInterventionReport(store: Store, policy: InterventionPolicy, options: { days?: InterventionWindow; kind?: InterventionKind | null; stage?: Stage | null; work?: string | null; limit?: number } = {}) {
  const snapshot = await store.workSnapshot();
  const { rows, truncated } = await readInterventionLedger(store.pool, { limit: options.limit });
  const folded = foldInterventions(rows, snapshot.work, snapshot.now);
  const report = computeInterventionReport(folded, snapshot.work, policy, { days: options.days ?? 30, now: snapshot.now, kind: options.kind, stage: options.stage, work: options.work });
  return { ...report, ledger: { rows: rows.length, truncated, oldest: rows[0]?.at ?? null }, kinds: interventionKinds, windows: interventionWindows };
}
