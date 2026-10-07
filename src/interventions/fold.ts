// Concern: folding the ledger rows into interventions and judgements — the walk in ledger order and the needs still open at its end.
import { standingEscalations, type Stage, type Work } from '../model.js';
import type { Intervention, InterventionKind, Judgement } from '../model/interventions.js';
import { exemption } from '../intervention-exemptions.js';
import type { InterventionLedgerRow } from './ledger.js';
import { foldRules, text, type Emit, type EmitFields, type WorkState } from './fold-rules.js';

const stageOf = (value: unknown): Stage | null => typeof value === 'string' ? value as Stage : null;
export const ms = (from: string, to: string) => Math.max(0, Date.parse(to) - Date.parse(from));
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
    if (!entry) { const item = items.get(id); entry = { key: item?.key ?? null, title: item?.title ?? null, stage: null, plannedFiles: null, asks: [], reworkDecision: null, bypass: null, quarantine: null, escalations: new Map(), human: null, routed: [] }; states.set(id, entry); }
    return entry;
  };
  const interventions: Intervention[] = [], judgements: Judgement[] = [];
  const named = (id: string | null) => { if (!id) return null; const item = items.get(id), entry = states.get(id); return { id, key: item?.key ?? entry?.key ?? id, title: item?.title ?? entry?.title ?? '' }; };
  const emit: Emit = (row, kind, fields) => {
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
    const blockerBefore = entry.blocker;
    if (row.work) entry.blocker = row.work.blocker ?? null;
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
    if (Object.hasOwn(foldRules, row.kind)) foldRules[row.kind]({ row, entry, details, stage, source, plannedBefore, blockerBefore, emit });
  }
  // What is still open, settled against the current record so a need met by a command the fold
  // does not read is never reported as waiting.
  for (const [id, entry] of states) {
    const item = items.get(id);
    if (!item || item.stage === 'done') continue;
    const row = { seq: 0, workId: id, actor: '', kind: 'open', at: now, details: {} };
    const open = (kind: InterventionKind, fields: EmitFields) => emit(row, kind, { ...fields, resolvedAt: null, resolvedBy: null, resolution: null });
    for (const ask of entry.asks) if (!exemption({ at: 'open-ask', ask, item })) open(ask.kind === 'scope-request' ? 'scope-widening' : 'escalation', { requestedAt: ask.at, blocked: ask.blocked, stage: ask.stage, resolvedAt: null, resolvedBy: null, resolution: null, trigger: ask.trigger ?? ask.kind, sources: ask.sources });
    if (entry.reworkDecision && !exemption({ at: 'open-rework', decision: entry.reworkDecision, asked: false, grounds: item, candidate: item.candidate })) open('rework', { id: `rework:${id}:${entry.reworkDecision.id}`, requestedAt: entry.reworkDecision.at, blocked: item.candidate ? `candidate ${item.candidate.sha.slice(0, 12)} (PR #${item.candidate.pr})` : `attempt ${item.epoch}`, stage: entry.reworkDecision.stage, resolvedAt: null, resolvedBy: null, resolution: null, trigger: 'decision', sources: [{ seq: entry.reworkDecision.seq, kind: 'decision.requested' }] });
    if (entry.bypass) open('bypass', { requestedAt: entry.bypass.at, blocked: entry.bypass.blocked, stage: entry.bypass.stage, resolvedAt: null, resolvedBy: null, resolution: null, trigger: 'refused-reconciliation', sources: [{ seq: entry.bypass.seq, kind: 'merge.reconciliation.refused' }] });
    if (entry.quarantine?.concernAt && item.containmentQuarantine) open('containment-settlement', { requestedAt: entry.quarantine.concernAt, blocked: `containment fence of epoch ${entry.quarantine.epoch}`, stage: entry.quarantine.stage, resolvedAt: null, resolvedBy: null, resolution: null, trigger: 'unsettled', sources: [{ seq: entry.quarantine.seq, kind: 'quarantine' }] });
    for (const escalation of standingEscalations(item).filter(escalation => !exemption({ at: 'open-escalation', item, escalation, now }))) {
      const known = entry.escalations.get(`${escalation.trigger}@${escalation.at}`);
      open('escalation', { id: `escalation:${id}:${escalation.trigger}@${escalation.at}`, requestedAt: escalation.at, blocked: escalation.reason, stage: known?.stage ?? entry.stage, resolvedAt: null, resolvedBy: null, resolution: null, trigger: escalation.trigger, sources: known ? [{ seq: known.seq, kind: 'raised' }] : [] });
    }
    if (entry.human && item.humanRequest?.id === entry.human.id) open('human-only-decision', { id: `human-only-decision:${id}:${entry.human.id}`, requestedAt: entry.human.at, blocked: entry.human.needed, stage: entry.human.stage, resolvedAt: null, resolvedBy: null, resolution: null, trigger: entry.human.kind, sources: [{ seq: entry.human.seq, kind: 'human.requested' }] });
  }
  interventions.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || (b.sources[0]?.seq ?? 0) - (a.sources[0]?.seq ?? 0));
  return { interventions, judgements };
}
