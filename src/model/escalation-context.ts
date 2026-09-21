import { createHash } from 'node:crypto';
import type { Decision } from './approval.js';
import { standingEscalations } from './escalation.js';
import type { Escalation, EscalationTrigger, Work } from './work.js';

/**
 * The context a spawned escalation handler decides from (GY-90). A long-lived master accumulates
 * the project's rules, the item's history and the precedent of earlier decisions in its own
 * window; a handler spawned per escalation has none of that, so the control plane assembles it
 * from data it already holds, in four layers: the repository's own operating rules and the
 * item's policy, the operator's goals and priorities as the work graph records them, the item
 * slice (requirements, the standing refusal, the candidate, a typed history summary), and
 * precedent (recent decisions of the same action with their reasons and outcomes).
 *
 * Assembly is a pure function of those inputs, so the same escalation and graph state yield a
 * byte-identical document, and it is bounded: when the document exceeds its budget the history
 * and precedent layers are summarised further — fewer rows in detail, every row still counted —
 * never cut mid-way. The rules layer is never shortened; a budget too small for it is reported.
 */
export const contextVersion = 1;
export const defaultContextBudget = 32_000;
export const contextBudgetRange = { min: 4_000, max: 1_000_000 } as const;
export const contextBudgetVariable = 'GRAPHYARD_ESCALATION_CONTEXT_BUDGET';
export function contextBudget(env: NodeJS.ProcessEnv, requested?: string | null): number {
  const value = requested ?? env[contextBudgetVariable];
  if (value === undefined || value === null || value === '') return defaultContextBudget;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < contextBudgetRange.min || parsed > contextBudgetRange.max) throw new RangeError(`An escalation context budget is a whole number of bytes between ${contextBudgetRange.min} and ${contextBudgetRange.max}`);
  return parsed;
}

/** What the repository under review says about itself, read at a pinned ref; never a template. */
export interface RulesSource { path: string; ref: string; sha: string | null; text: string | null; unavailable: string | null }
export interface LedgerKindCount { kind: string; count: number; firstSeq: string; lastSeq: string; firstAt: string; lastAt: string }
export interface LedgerRow { seq: string; at: string; actor: string; kind: string; details: unknown }
/** A decision as precedent: the fold, plus the item it was taken on and the ledger position of its request. */
export interface PrecedentDecision extends Decision { workKey: string; seq: number; precedent: string[]; context: string | null }
export interface ContextInputs {
  repository: string; work: Work; trigger: EscalationTrigger; rules: RulesSource; graph: Work[];
  /** The item's own ledger: every kind counted, the newest non-routine rows, and the intent rows. */
  history: { total: number; kinds: LedgerKindCount[]; recent: LedgerRow[]; intents: LedgerRow[] };
  /** Every decision of the escalation's action across the graph. */
  decisions: PrecedentDecision[];
  budget: number;
}

// The summarisation ladder: how many history rows and precedent decisions are shown in full at
// each level. Assembly walks it until the document fits; the floor keeps counts alone.
export const contextLadder: readonly { recent: number; detail: number }[] = [
  { recent: 40, detail: 20 }, { recent: 30, detail: 15 }, { recent: 20, detail: 10 }, { recent: 12, detail: 6 },
  { recent: 8, detail: 4 }, { recent: 4, detail: 2 }, { recent: 2, detail: 1 }, { recent: 0, detail: 1 }, { recent: 0, detail: 0 },
];
/** Rows the summary counts but never lists: the two kinds the control plane writes continuously. */
export const routineLedgerKinds = ['github.observed', 'heartbeat'] as const;
export const intentLedgerKinds = ['create', 'intake.created', 'ready', 'requirements', 'unblock'] as const;
/** The action every escalation handler decides: which standing concern to clear, and why. */
export const escalationAction = 'resolve' as const;

export interface HistoryEntry { seq: string; at: string; actor: string; kind: string; summary: Record<string, unknown> }
export interface PrecedentEntry {
  id: string; work: string; trigger: string | null; state: string; requestedBy: string; requestedAt: string; reason: string;
  approvedBy: string | null; approvalReason: string | null; outcome: string | null; refusals: number; precedent: string[]; context: string | null;
}
export interface EscalationContext {
  version: number; repository: string; key: string; action: typeof escalationAction;
  escalation: Escalation;
  rules: { source: { path: string; ref: string; sha: string | null }; text: string | null; unavailable: string | null; policy: Work['policy'] };
  goals: {
    priority: number; intents: HistoryEntry[];
    graph: { key: string; priority: number; stage: string; title: string }[]; graphOmitted: { stage: string; count: number }[];
    dependencies: string[]; dependents: string[];
  };
  item: {
    key: string; title: string; type: string; description: string; stage: string; ready: boolean; revision: number; policyRevision: number; epoch: number; createdAt: string;
    criteria: Work['criteria']; retiredCriterionIds: string[]; plannedFiles: string[]; producerProofs: string[]; exclusiveResources: unknown[]; dependencies: string[];
    refusal: { escalation: Escalation; standing: Escalation[]; gates: Work['gates']; blocker: string | null; violations: string[] };
    candidate: Work['candidate']; submission: Work['submission']; lease: Work['lease']; implementers: string[];
    history: { total: number; kinds: LedgerKindCount[]; recent: HistoryEntry[]; omitted: number };
  };
  precedent: { action: typeof escalationAction; total: number; matching: number; detail: PrecedentEntry[]; summary: { trigger: string | null; state: string; count: number }[]; omitted: number };
  budget: { limit: number; level: { recent: number; detail: number }; exceeded: string | null };
  fingerprint: string;
}

/** jsonb does not keep key order, so everything read back from it is serialised in a canonical form. */
export const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : 1).map(([key, entry]) => [key, canonical(entry)]))
  : value;
export const serialiseContext = (context: unknown) => JSON.stringify(canonical(context));
export const contextFingerprint = (document: unknown) => createHash('sha256').update(serialiseContext(document)).digest('hex');

// The typed fields a ledger row is summarised to: what happened, never the embedded work snapshot.
const summaryFields = ['reason', 'trigger', 'epoch', 'pr', 'action', 'id', 'decision', 'proof', 'result', 'owner', 'note', 'cause', 'conflict', 'outcome', 'error'] as const;
export function summariseLedgerRow(row: LedgerRow): HistoryEntry {
  const details = (row.details && typeof row.details === 'object' && !Array.isArray(row.details) ? row.details : {}) as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const field of summaryFields) {
    const value = details[field];
    if (typeof value === 'string') summary[field] = value.slice(0, 500);
    else if (typeof value === 'number' || typeof value === 'boolean') summary[field] = value;
  }
  if (typeof details.sha === 'string') summary.sha = details.sha.slice(0, 12);
  return { seq: row.seq, at: row.at, actor: row.actor, kind: row.kind, summary };
}

const precedentEntry = (decision: PrecedentDecision): PrecedentEntry => ({
  id: decision.id, work: decision.workKey, trigger: typeof decision.input?.trigger === 'string' ? decision.input.trigger : null, state: decision.state,
  requestedBy: decision.requestedBy, requestedAt: decision.requestedAt, reason: decision.reason, approvedBy: decision.approvedBy, approvalReason: decision.approvalReason,
  outcome: decision.outcome, refusals: decision.refusals.length, precedent: [...decision.precedent].sort(), context: decision.context,
});
/** Same trigger first, newest first within each group; the order every level of the ladder cuts from. */
export function orderPrecedent(decisions: PrecedentDecision[], trigger: EscalationTrigger) {
  const rank = (decision: PrecedentDecision) => decision.input?.trigger === trigger ? 0 : 1;
  return [...decisions].filter(decision => decision.action === escalationAction).sort((a, b) => rank(a) - rank(b) || b.seq - a.seq || (a.id < b.id ? -1 : 1));
}
const byStage = (work: Work[]) => {
  const counts = new Map<string, number>();
  for (const item of work) counts.set(item.stage, (counts.get(item.stage) ?? 0) + 1);
  return [...counts].map(([stage, count]) => ({ stage, count })).sort((a, b) => a.stage < b.stage ? -1 : 1);
};

/** One level of the ladder, without the fingerprint. */
export function assembleAt(inputs: ContextInputs, level: { recent: number; detail: number }): Omit<EscalationContext, 'fingerprint'> {
  const { work, graph, trigger } = inputs;
  const escalation = standingEscalations(work).find(entry => entry.trigger === trigger);
  if (!escalation) throw new Error(`No standing ${trigger} escalation on ${work.key}`);
  const keyOf = (id: string) => graph.find(item => item.id === id)?.key ?? id;
  const open = graph.filter(item => item.stage !== 'done').sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key, 'en'));
  const shown = open.slice(0, 30);
  const recentRows = inputs.history.recent.slice(0, level.recent);
  const nonRoutine = inputs.history.kinds.filter(entry => !(routineLedgerKinds as readonly string[]).includes(entry.kind)).reduce((sum, entry) => sum + entry.count, 0);
  const ordered = orderPrecedent(inputs.decisions, trigger);
  const detail = ordered.slice(0, level.detail);
  const summary = new Map<string, { trigger: string | null; state: string; count: number }>();
  for (const decision of ordered.slice(level.detail)) {
    const entryTrigger = typeof decision.input?.trigger === 'string' ? decision.input.trigger : null;
    const id = `${entryTrigger ?? ''}\0${decision.state}`;
    summary.set(id, { trigger: entryTrigger, state: decision.state, count: (summary.get(id)?.count ?? 0) + 1 });
  }
  return {
    version: contextVersion, repository: inputs.repository, key: work.key, action: escalationAction, escalation,
    rules: { source: { path: inputs.rules.path, ref: inputs.rules.ref, sha: inputs.rules.sha }, text: inputs.rules.text, unavailable: inputs.rules.unavailable, policy: work.policy },
    goals: {
      priority: work.priority, intents: inputs.history.intents.map(summariseLedgerRow),
      graph: shown.map(item => ({ key: item.key, priority: item.priority, stage: item.stage, title: item.title })), graphOmitted: byStage(open.slice(30)),
      dependencies: work.dependencies.map(keyOf), dependents: graph.filter(item => item.dependencies.includes(work.id)).map(item => item.key).sort(),
    },
    item: {
      key: work.key, title: work.title, type: work.type, description: work.description, stage: work.stage, ready: work.ready, revision: work.revision, policyRevision: work.policyRevision, epoch: work.epoch, createdAt: work.createdAt,
      criteria: work.criteria, retiredCriterionIds: work.retiredCriterionIds ?? [], plannedFiles: work.plannedFiles, producerProofs: work.producerProofs ?? [], exclusiveResources: work.exclusiveResources ?? [], dependencies: work.dependencies.map(keyOf),
      refusal: { escalation, standing: standingEscalations(work), gates: work.gates, blocker: work.blocker, violations: work.violations },
      candidate: work.candidate, submission: work.submission, lease: work.lease, implementers: work.implementers ?? [],
      history: { total: inputs.history.total, kinds: inputs.history.kinds, recent: recentRows.map(summariseLedgerRow), omitted: Math.max(0, nonRoutine - recentRows.length) },
    },
    precedent: { action: escalationAction, total: ordered.length, matching: ordered.filter(decision => decision.input?.trigger === trigger).length, detail: detail.map(precedentEntry),
      summary: [...summary.values()].sort((a, b) => (a.trigger ?? '').localeCompare(b.trigger ?? '', 'en') || a.state.localeCompare(b.state, 'en')), omitted: ordered.length - detail.length },
    budget: { limit: inputs.budget, level, exceeded: null },
  };
}

/** The bounded, deterministic document: the first level of the ladder that fits, fingerprinted. */
export function assembleEscalationContext(inputs: ContextInputs): EscalationContext {
  const fits = (document: Omit<EscalationContext, 'fingerprint'>) => Buffer.byteLength(serialiseContext({ ...document, fingerprint: 'f'.repeat(64) })) <= inputs.budget;
  let document = assembleAt(inputs, contextLadder[0]);
  for (const level of contextLadder.slice(1)) { if (fits(document)) break; document = assembleAt(inputs, level); }
  if (!fits(document)) {
    const rules = Buffer.byteLength(document.rules.text ?? '');
    document.budget.exceeded = `The context is ${Buffer.byteLength(serialiseContext(document))} bytes at the summary floor (every history row and precedent decision counted, none listed) against a ${inputs.budget}-byte budget; the repository rules alone are ${rules} bytes and are never shortened. Raise ${contextBudgetVariable} or the budget parameter`;
  }
  return { ...document, fingerprint: contextFingerprint(document) };
}

/** Where the rules layer is read: the base tip the item was observed against, else its bound base, else the base branch name. */
export function rulesRef(work: Work, baseBranch: string) {
  return work.observation?.baseTip ?? work.candidate?.baseSha ?? baseBranch;
}

// ---- The spawned handler -----------------------------------------------------------------------
/**
 * A handler's judgement: the resolve decision it requests, the reason, and the precedent it relied
 * on. `followPrecedent` is the built-in judgement: adopt the newest applied decision of the same
 * trigger and cite it. A decision's reason is a claim about one kind of incident, so an applied
 * decision of another trigger is never adopted — it stays in the context for a judging session to
 * weigh — and with no applied precedent of its own trigger the judgement declines rather than
 * invent a line.
 */
export interface EscalationJudgement { trigger: EscalationTrigger; reason: string; precedent: string[]; followed: PrecedentEntry | null }
export function followPrecedent(context: EscalationContext): EscalationJudgement | null {
  const followed = context.precedent.detail.find(entry => entry.state === 'applied' && entry.trigger === context.escalation.trigger);
  if (!followed) return null;
  const line = followed.reason.replace(/^Following precedent [0-9a-f-]+ on GY-\d+ \([^)]*\): /, '');
  return { trigger: context.escalation.trigger, precedent: [followed.id], followed,
    reason: `Following precedent ${followed.id} on ${followed.work} (${followed.trigger ?? context.action}, ${followed.state}): ${line}`.slice(0, 2000) };
}
export type EscalationJudge = (context: EscalationContext) => Promise<EscalationJudgement | null> | EscalationJudgement | null;
export interface DecisionRequest { action: typeof escalationAction; input: { trigger: EscalationTrigger; expectedRevision: number }; reason: string; precedent: string[]; context: string }
export interface HandledEscalation { key: string; trigger: EscalationTrigger; fingerprint: string; judgement: EscalationJudgement | null; request: DecisionRequest | null; decision: unknown; declined: string | null }
/**
 * Run one handler: it sees the assembled context and nothing else, judges, and records its decision
 * request with the reason, the precedent it cites and the fingerprint of the context it judged
 * from, so a later handler can follow the same line and an auditor can rebuild what it saw.
 */
export async function handleEscalation(context: EscalationContext, judge: EscalationJudge, record: (request: DecisionRequest) => Promise<unknown>): Promise<HandledEscalation> {
  const judgement = await judge(context);
  const base = { key: context.key, trigger: context.escalation.trigger, fingerprint: context.fingerprint, judgement };
  if (!judgement) return { ...base, request: null, decision: null, declined: `No applied ${context.action} precedent of the ${context.escalation.trigger} trigger to follow among ${context.precedent.total} recorded decision(s); a judging session decides this escalation` };
  const request: DecisionRequest = { action: escalationAction, input: { trigger: judgement.trigger, expectedRevision: context.item.revision }, reason: judgement.reason, precedent: judgement.precedent, context: context.fingerprint };
  return { ...base, request, decision: await record(request), declined: null };
}
