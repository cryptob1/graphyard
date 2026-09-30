import { createHash } from 'node:crypto';
import { z } from 'zod';
import { gateRefusalCatalogue } from './refusal-catalogue.js';
import { faultClasses, type FaultClass } from './fault-classes.js';
import type { Intervention, InterventionPolicy } from './interventions.js';

// ---------------------------------------------------------------------------
// Retro synthesis (GY-970).
//
// The intervention detector (GY-98) notices that the same kind of intervention keeps recurring and
// opens an item to remove its cause. What it does not do is say what would have prevented the
// cause: every time a reviewer asks for the same change, a worker trips the same scope refusal or a
// candidate is sent back for the same reason, the fix is typed into a session by hand, and the next
// session repeats the mistake. Here the same signal — a refusal diagnosis or rework cause recurring
// past the detector's threshold inside its window — is read one level finer, by *cause*, and turned
// into drafted prevention artefacts: a coding-standards or criteria wording update, a new mechanical
// check, a producer-method correction, or a fault-catalogue entry.
//
// A draft is a proposal and nothing else. It is recorded in the ledger (`retro.drafted`), never
// applied on its own and never filed as a work item, so no loop dispatches it. It takes effect
// only when an independent agent identity approves it; the approval applies it through its governed
// path — a revision of the standing requirements, a check registration, or a catalogue update — and
// records the recurring pattern it closes, so the instances it names never produce a second draft.
// ---------------------------------------------------------------------------

export const retroArtefactKinds = ['standards-update', 'mechanical-check', 'producer-method', 'fault-catalogue-entry'] as const;
export type RetroArtefactKind = typeof retroArtefactKinds[number];
export const retroArtefactKindLabel = {
  'standards-update': 'coding-standards or criteria wording update',
  'mechanical-check': 'new mechanical check',
  'producer-method': 'producer-method correction',
  'fault-catalogue-entry': 'fault-catalogue entry',
} as const satisfies Record<RetroArtefactKind, string>;

/** The governed registry each kind is applied to, and the path that applies it. */
export const retroRegistries = ['requirements', 'checks', 'catalogue'] as const;
export type RetroRegistry = typeof retroRegistries[number];
export const retroRegistryOf = {
  'standards-update': 'requirements', 'producer-method': 'requirements', 'mechanical-check': 'checks', 'fault-catalogue-entry': 'catalogue',
} as const satisfies Record<RetroArtefactKind, RetroRegistry>;
export const retroGovernedPath = { requirements: 'requirements revision', checks: 'check registration', catalogue: 'catalogue update' } as const satisfies Record<RetroRegistry, string>;

/** What a standards update revises: the coding standards workers follow, or the wording of the criteria items are written with. */
export type RetroTarget = 'coding-standards' | 'criteria-wording' | 'producer-method' | 'checks' | 'fault-catalogue';

/**
 * The cause an intervention points at, when it is a refusal or a rework. `cause` is the grouping
 * key: a declared refusal shape (`build/out-of-scope-count`), the trigger of a refusal the loop
 * recorded (`trigger/refused-by-loop`), or — for a rework whose reason matches no declared shape — a
 * fingerprint of its reason with the item-specific parts (heads, keys, numbers) taken out, so the
 * same reason given for different items groups as one cause.
 */
export interface RetroCause { family: 'refusal' | 'rework'; cause: string; gate: string | null; shape: string | null; label: string }

/** A reason with the parts that differ between instances of the same cause taken out. */
export function normalizeCauseText(text: string) {
  return text.toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/\b[a-z][a-z0-9]*-\d+\b/g, '<item>')
    .replace(/#\d+/g, '#<n>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
}
const fingerprint = (value: string, length = 16) => createHash('sha256').update(value).digest('hex').slice(0, length);

/** The declared refusal shape a reason names, trying the whole reason and each of its clauses; free-text shapes never count. */
function declaredShape(text: string) {
  const parts = [text, ...text.split(/(?<=[.;])\s+|:\s+/)].map(part => part.trim()).filter(Boolean);
  for (const shape of gateRefusalCatalogue) {
    if (shape.free) continue;
    if (parts.some(part => shape.match.test(part))) return shape;
  }
  return null;
}

/** The refusal or rework cause of one intervention, or null for an intervention that is neither. */
export function retroCause(entry: Pick<Intervention, 'kind' | 'blocked' | 'resolution' | 'trigger'>): RetroCause | null {
  const reason = entry.resolution ?? '', blocked = entry.blocked ?? '';
  const shape = declaredShape(reason) ?? declaredShape(blocked);
  const family = entry.kind === 'rework' ? 'rework' : 'refusal';
  if (shape) return { family, cause: `${shape.gate}/${shape.id}`, gate: shape.gate, shape: shape.id, label: `${shape.gate} refusal “${shape.id}”` };
  if (entry.kind !== 'rework' && entry.trigger && /refus/.test(entry.trigger)) return { family: 'refusal', cause: `trigger/${entry.trigger}`, gate: null, shape: null, label: `refusal “${entry.trigger}”` };
  if (entry.kind !== 'rework') return null;
  const normalized = normalizeCauseText(reason);
  if (!normalized || normalized === 'rework authorized') return null;
  return { family: 'rework', cause: `reason/${fingerprint(normalized)}`, gate: null, shape: null, label: `rework for “${normalized.slice(0, 120)}”` };
}

export interface RetroInstance { id: string; work: string | null; requestedAt: string; reason: string; sources: { seq: number; kind: string }[] }
/** One recurring cause as the synthesis saw it: the threshold it crossed and the instances that crossed it. */
export interface RetroPattern {
  cause: string; family: RetroCause['family']; gate: string | null; shape: string | null; label: string;
  threshold: number; count: number; window: { from: string; to: string; days: number };
  /** Stable over the linked instances: two syntheses of the same instances name the same pattern. */
  fingerprint: string;
  instances: RetroInstance[];
  /** Applied artefacts for this cause that it recurred after: the prevention did not hold. */
  recurredAfter: string[];
}
export const retroPatternSchema = z.object({
  cause: z.string().min(1).max(200), family: z.enum(['refusal', 'rework']), gate: z.string().nullable(), shape: z.string().nullable(), label: z.string().max(400),
  threshold: z.number().int().positive(), count: z.number().int().nonnegative(), window: z.object({ from: z.string(), to: z.string(), days: z.number().int().positive() }).strict(),
  fingerprint: z.string().regex(/^[0-9a-f]{32}$/),
  instances: z.array(z.object({ id: z.string(), work: z.string().nullable(), requestedAt: z.string(), reason: z.string().max(2000), sources: z.array(z.object({ seq: z.number(), kind: z.string() }).strict()).max(20) }).strict()).max(500),
  recurredAfter: z.array(z.string()).max(50),
}).strict();

/** A drafted prevention artefact, before anybody has judged it. */
export interface RetroDraft {
  kind: RetroArtefactKind; registry: RetroRegistry; target: RetroTarget; title: string; proposal: string;
  /** A mechanical check's registration: its id and what it verifies before a submission. */
  check?: { id: string; verifies: string };
  /** A catalogue entry: the cause it recognises and the fault class it files instances under. */
  entry?: { id: string; cause: string; faultClass: FaultClass; meaning: string };
}
export const retroDraftSchema = z.object({
  kind: z.enum(retroArtefactKinds), registry: z.enum(retroRegistries), target: z.enum(['coding-standards', 'criteria-wording', 'producer-method', 'checks', 'fault-catalogue']),
  title: z.string().min(1).max(200), proposal: z.string().min(1).max(4000),
  check: z.object({ id: z.string().min(1).max(120), verifies: z.string().min(1).max(1000) }).strict().optional(),
  entry: z.object({ id: z.string().min(1).max(120), cause: z.string().min(1).max(200), faultClass: z.enum(faultClasses), meaning: z.string().min(1).max(1000) }).strict().optional(),
}).strict();

/**
 * One artefact through its life: drafted by the synthesis, then either applied by an independent
 * approval or refused. Folded from the `retro.*` rows of the ledger.
 */
export type RetroState = 'drafted' | 'applied' | 'refused';
export interface RetroArtefact extends RetroDraft {
  id: string; seq: number; state: RetroState;
  draftedBy: string; draftedAt: string;
  pattern: RetroPattern;
  /** The independent approval, and the recurring pattern it records as closed. */
  approval: { by: string; at: string; reason: string; closes: { cause: string; fingerprint: string; instances: string[] } } | null;
  /** Where the approval applied it: the registry, its new revision, and the governed path. */
  application: { registry: RetroRegistry; revision: number; path: string } | null;
  refusal: { by: string; at: string; reason: string } | null;
}

/** The ledger kinds the fold reads. */
export const retroLedgerKinds = ['retro.drafted', 'retro.applied', 'retro.refused'] as const;
export interface RetroLedgerRow { seq: number; actor: string; kind: string; at: string; payload: any }

/** Fold the retro rows, in ledger order, into the artefacts they describe. */
export function foldRetroArtefacts(rows: readonly RetroLedgerRow[]): RetroArtefact[] {
  const artefacts = new Map<string, RetroArtefact>();
  for (const row of rows) {
    const payload = row.payload ?? {};
    if (row.kind === 'retro.drafted') {
      artefacts.set(payload.id, { ...(payload.draft as RetroDraft), id: payload.id, seq: row.seq, state: 'drafted', draftedBy: row.actor, draftedAt: payload.at ?? row.at, pattern: payload.pattern, approval: null, application: null, refusal: null });
      continue;
    }
    const artefact = artefacts.get(payload.id);
    if (!artefact || artefact.state !== 'drafted') continue;
    if (row.kind === 'retro.applied') { artefact.state = 'applied'; artefact.approval = payload.approval; artefact.application = payload.application; }
    else if (row.kind === 'retro.refused') { artefact.state = 'refused'; artefact.refusal = payload.refusal; }
  }
  return [...artefacts.values()];
}

/** What each governed registry stands at: its revision and the applied artefacts in force, oldest first. */
export interface RetroStanding { registry: RetroRegistry; path: string; revision: number; entries: RetroArtefact[] }
export function retroStanding(artefacts: readonly RetroArtefact[]): RetroStanding[] {
  return retroRegistries.map(registry => {
    const entries = artefacts.filter(artefact => artefact.state === 'applied' && artefact.application?.registry === registry).sort((a, b) => a.application!.revision - b.application!.revision);
    return { registry, path: retroGovernedPath[registry], revision: entries.at(-1)?.application?.revision ?? 0, entries };
  });
}

/** The applied catalogue entry that recognises a cause, if one does: its instances are filed under that entry's fault class. */
export function cataloguedCause(cause: string, artefacts: readonly RetroArtefact[]) {
  return artefacts.find(artefact => artefact.state === 'applied' && artefact.kind === 'fault-catalogue-entry' && artefact.entry?.cause === cause) ?? null;
}

const day = 86_400_000;
/**
 * The recurring causes the synthesis drafts for. Instances are the refusal and rework
 * interventions needed inside the detector's window, grouped by cause; a cause crosses at the
 * detector's own threshold. An instance any earlier artefact already names — drafted, applied or
 * refused — never counts again, so the same feedback is never delivered twice, and a cause with a
 * draft still waiting for its judgement is not drafted a second time. A cause that crosses again
 * after an artefact for it was applied names that artefact: the prevention did not hold.
 */
export function detectRecurringCauses(interventions: readonly Intervention[], artefacts: readonly RetroArtefact[], policy: InterventionPolicy, now: string): RetroPattern[] {
  const from = new Date(Date.parse(now) - policy.windowDays * day).toISOString();
  const linked = new Set(artefacts.flatMap(artefact => artefact.pattern.instances.map(instance => instance.id)));
  const waiting = new Set(artefacts.filter(artefact => artefact.state === 'drafted').map(artefact => artefact.pattern.cause));
  const groups = new Map<string, { cause: RetroCause; entries: Intervention[] }>();
  for (const entry of interventions) {
    if (entry.requestedAt < from || entry.requestedAt >= now || linked.has(entry.id)) continue;
    const cause = retroCause(entry);
    if (!cause) continue;
    const group = groups.get(cause.cause) ?? { cause, entries: [] };
    group.entries.push(entry);
    groups.set(cause.cause, group);
  }
  const patterns: RetroPattern[] = [];
  for (const { cause, entries } of groups.values()) {
    if (entries.length < policy.threshold || waiting.has(cause.cause)) continue;
    const sorted = [...entries].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id));
    patterns.push({
      ...cause, threshold: policy.threshold, count: sorted.length, window: { from, to: now, days: policy.windowDays },
      fingerprint: fingerprint(`${cause.cause}|${sorted.map(entry => entry.id).sort().join(',')}`, 32),
      instances: sorted.map(entry => ({ id: entry.id, work: entry.work?.key ?? null, requestedAt: entry.requestedAt, reason: (entry.resolution ?? entry.blocked ?? '').slice(0, 2000), sources: entry.sources.slice(0, 20) })),
      recurredAfter: artefacts.filter(artefact => artefact.state === 'applied' && artefact.pattern.cause === cause.cause).map(artefact => artefact.id),
    });
  }
  return patterns.sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));
}

/** The fault class a recurring cause is filed under in the catalogue. */
function faultClassOfCause(pattern: Pick<RetroPattern, 'gate' | 'shape' | 'cause'>): FaultClass {
  if (pattern.cause.startsWith('trigger/') && /scope/.test(pattern.cause)) return 'scope';
  if (pattern.shape && /scope|landing|carried/.test(pattern.shape)) return 'scope';
  switch (pattern.gate) {
    case 'review': return 'review-convergence';
    case 'acceptance': return 'proof';
    case 'merge': return 'merge';
    case 'test': return 'stalled-gate';
    case 'ready': return 'decision';
    case 'build': return pattern.shape === 'mechanical-proof-failed' ? 'proof' : 'stalled-gate';
    default: return 'unclassified';
  }
}

/**
 * The artefacts that would prevent a recurring cause, drafted from what the cause is. Each
 * recurring cause gets the prevention its shape calls for and, always, a catalogue entry so later
 * instances are recognised as this cause rather than read afresh. Nothing here is applied.
 */
export function draftPrevention(pattern: RetroPattern): RetroDraft[] {
  const evidence = `${pattern.count} instances of ${pattern.label} in ${pattern.window.days} days (threshold ${pattern.threshold}): ${pattern.instances.slice(0, 5).map(instance => `${instance.work ?? 'no item'} (${instance.id})`).join(', ')}${pattern.instances.length > 5 ? ', …' : ''}.`
    + (pattern.recurredAfter.length ? ` It recurred after ${pattern.recurredAfter.join(', ')} was applied, so the earlier prevention did not hold.` : '');
  const sample = pattern.instances[0]?.reason ?? '';
  const slug = pattern.cause.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 80);
  const drafts: RetroDraft[] = [];
  const standards = (target: 'coding-standards' | 'criteria-wording', text: string) => drafts.push({ kind: 'standards-update', registry: 'requirements', target, title: `${target === 'criteria-wording' ? 'Criteria wording' : 'Coding standard'}: prevent ${pattern.label}`.slice(0, 200), proposal: `${text} ${evidence}`.slice(0, 4000) });
  const check = (verifies: string) => drafts.push({ kind: 'mechanical-check', registry: 'checks', target: 'checks', title: `Check before submit: ${pattern.label}`.slice(0, 200), proposal: `Register a mechanical check that ${verifies}, run before a worker submits, so the refusal is met by the worker instead of the gate. ${evidence}`.slice(0, 4000), check: { id: `retro-${slug}`.slice(0, 120), verifies: verifies.slice(0, 1000) } });
  const method = (text: string) => drafts.push({ kind: 'producer-method', registry: 'requirements', target: 'producer-method', title: `Producer method: prevent ${pattern.label}`.slice(0, 200), proposal: `${text} ${evidence}`.slice(0, 4000) });
  const shape = pattern.shape ?? '';
  if (pattern.cause.startsWith('trigger/') || /out-of-scope|landing|carried/.test(shape)) {
    standards('criteria-wording', 'Word each criterion so the files it implies are named in plannedFiles, and state in the criteria when a test, doc or registry file outside the obvious module must change.');
    check('compares the candidate diff with plannedFiles and names every path outside them');
  } else if (shape === 'base-conflict' || shape === 'not-mergeable' || shape === 'ejected') {
    standards('coding-standards', 'Bring the branch onto the current base with graphyard sync immediately before complete, and resolve conflicts keeping both sides of every edit that belongs to another item.');
    check('confirms the head merges cleanly onto the current base tip');
  } else if (shape === 'mechanical-proof-failed' || shape === 'check-not-passed') {
    standards('coding-standards', 'Run the required CI checks and every test file an item\'s unit or integration proofs name, on the final head, before complete.');
    check('runs the required checks and the proof-named test files against the head');
  } else if (pattern.gate === 'acceptance') {
    method('Producers exercise the criterion against the exact candidate head and base, report executed and skipped cases honestly, and name the probe that would fail if the behaviour were absent.');
  } else if (pattern.gate === 'review' || pattern.family === 'rework') {
    standards('coding-standards', `Address this recurring review finding before submitting: “${sample.slice(0, 600)}”.`);
  }
  const faultClass = faultClassOfCause(pattern);
  drafts.push({ kind: 'fault-catalogue-entry', registry: 'catalogue', target: 'fault-catalogue', title: `Catalogue ${pattern.label} as a ${faultClass} fault`.slice(0, 200),
    proposal: `Add a fault-catalogue entry that recognises ${pattern.label} (cause ${pattern.cause}) and files later instances under ${faultClass}, so they are counted against this pattern rather than diagnosed afresh. ${evidence}`.slice(0, 4000),
    entry: { id: `retro-${slug}`.slice(0, 120), cause: pattern.cause, faultClass, meaning: `${pattern.label}${sample ? `, e.g. “${sample.slice(0, 300)}”` : ''}`.slice(0, 1000) } });
  return drafts;
}

export const retroJudgementSchema = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();

/** Separation of duties for a retro approval: null when the approver is independent of the draft. */
export function retroApprovalConflict(artefact: Pick<RetroArtefact, 'id' | 'draftedBy'>, approver: { id: string }): string | null {
  if (approver.id === artefact.draftedBy) return `Self-approval refused: ${approver.id} drafted retro artefact ${artefact.id}; a second, independent agent identity must approve it`;
  return null;
}
