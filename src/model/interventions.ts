import { z } from 'zod';
import { stages, type Stage } from './work.js';
import { faultClassOriginSchema } from './fault-classes.js';
import { reviewFollowUpsOriginSchema } from './machine-backlog.js';

// work.ts spreads the origin schema into createSchema, so both modules reference each other; the
// stage enum is resolved at parse time to keep that cycle free of evaluation order.
const stageSchema = z.lazy(() => z.enum(stages));

// ---------------------------------------------------------------------------
// Interventions as product feedback (GY-98).
//
// Graphyard measures correctness and latency and, until now, nothing about whether it is a good
// product to use. The one signal that says so already flows through it: every time a human or a
// coordinator has to step in — a rework decision, a scope widening, a merge outside the guarded
// path, a containment fence somebody had to settle, a session nudged by hand, an escalation, a
// decision only a human may make — the product failed to handle something itself. Each of those
// is a typed signal here: its kind, what was blocked, how long it waited, which item and stage,
// and what resolved it. The signals are read from the ledger's own typed events (never from
// prose), reported as a product surface (rate per delivery, breakdown, trend, the items that cost
// the most attention), and turned into work when one kind at one stage keeps recurring.
// ---------------------------------------------------------------------------

export const interventionKinds = ['rework', 'scope-widening', 'bypass', 'containment-settlement', 'session-nudge', 'escalation', 'human-only-decision', 'misclassified-finding'] as const;
export type InterventionKind = typeof interventionKinds[number];
export const interventionKindLabel = {
  'rework': 'rework decision',
  'scope-widening': 'scope widening',
  'bypass': 'merge outside the guarded path',
  'containment-settlement': 'containment settlement',
  'session-nudge': 'session nudge',
  'escalation': 'escalation',
  'human-only-decision': 'human-only decision',
  'misclassified-finding': 'finding misclassified as mechanical',
} as const satisfies Record<InterventionKind, string>;

/** How a signal reached the record: read from the ledger's typed events, or recorded by a session that intervened by hand. */
export type InterventionSource = 'ledger' | 'recorded';

/**
 * One intervention. `requestedAt` is when the product first needed somebody to step in and
 * `resolvedAt` when they had; `waitedMs` is the attention the wait cost, and an open signal
 * (`resolvedAt` null) is measured up to the report's own instant. `sources` names the ledger
 * rows the signal was read from, so every figure in a report can be traced to history.
 */
export interface Intervention {
  id: string; kind: InterventionKind; source: InterventionSource;
  work: { id: string; key: string; title: string } | null;
  /** The stage the item was in when the intervention was needed; null for a signal about no item. */
  stage: Stage | null;
  /** What was blocked: the candidate, the paths, the fence, the session, the decision. */
  blocked: string;
  /** A finer classification inside the kind: the escalation trigger, the human decision, the settlement path. */
  trigger?: string;
  requestedAt: string; resolvedAt: string | null; waitedMs: number;
  resolvedBy: string | null; resolution: string | null;
  sources: { seq: number; kind: string }[];
}

/**
 * The operator's judgement about delivered work (AC-4): that something is confusing, wrong for
 * its user, or not good enough, against the item or the page it concerns. It is first-class
 * backlog input: it appears in the report beside the interventions and becomes an item on request.
 */
export const judgementVerdicts = ['confusing', 'wrong-for-user', 'not-good-enough'] as const;
export type JudgementVerdict = typeof judgementVerdicts[number];
export const judgementVerdictLabel = { 'confusing': 'confusing', 'wrong-for-user': 'wrong for its user', 'not-good-enough': 'not good enough' } as const satisfies Record<JudgementVerdict, string>;
export const judgementSchema = z.object({
  /** The delivered item the judgement is about, by key or id, and/or the page (a docs path, a dashboard view, a URL). */
  work: z.string().trim().min(1).max(200).optional(),
  page: z.string().trim().min(1).max(500).optional(),
  verdict: z.enum(judgementVerdicts),
  text: z.string().trim().min(1).max(4000),
}).strict().refine(data => data.work || data.page, 'A judgement names the item or the page it concerns');
export type JudgementInput = z.infer<typeof judgementSchema>;
export interface Judgement {
  id: string; verdict: JudgementVerdict; text: string;
  work: { id: string; key: string; title: string } | null; page: string | null;
  by: string; at: string;
  /** The work item the judgement was turned into, once it was. */
  item: { id: string; key: string; stage: Stage } | null;
  seq: number;
}

/**
 * A session recording an intervention it performed by hand — the loop's re-prompt of a quiet
 * session, a nudge a person typed, a settlement done outside the API — so the signal is on the
 * record with the same fields as one read from the ledger. `since` is when the product first
 * needed the intervention; without it the wait is measured from nothing.
 */
export const interventionRecordSchema = z.object({
  kind: z.enum(interventionKinds),
  work: z.string().trim().min(1).max(200).optional(),
  stage: stageSchema.optional(),
  blocked: z.string().trim().min(1).max(2000),
  trigger: z.string().trim().min(1).max(200).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  resolution: z.string().trim().min(1).max(2000),
}).strict();
export type InterventionRecordInput = z.infer<typeof interventionRecordSchema>;

/** The recurrence rule (AC-3): interventions of one kind at one stage in a window become work at `count`. */
export interface InterventionPolicy { threshold: number; windowDays: number }
export const interventionPolicyDefaults: InterventionPolicy = { threshold: 3, windowDays: 7 };
export const interventionPolicyVariables = { threshold: 'GRAPHYARD_INTERVENTION_PATTERN_THRESHOLD', windowDays: 'GRAPHYARD_INTERVENTION_PATTERN_WINDOW_DAYS' } as const;
export function interventionPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): InterventionPolicy {
  const read = (name: string, fallback: number) => { const value = Number(env[name]); return Number.isInteger(value) && value > 0 ? value : fallback; };
  return { threshold: read(interventionPolicyVariables.threshold, interventionPolicyDefaults.threshold), windowDays: read(interventionPolicyVariables.windowDays, interventionPolicyDefaults.windowDays) };
}

/**
 * Where a work item came from when Graphyard opened it from feedback rather than an operator's
 * intent: a recurring intervention pattern, with the instances it links as evidence, or an
 * operator's judgement about delivered work. Recorded on the item at creation and never edited, but for a review follow-up item's findings, which a later approval of its parent appends to.
 */
export interface InterventionPattern {
  kind: InterventionKind; stage: Stage | null;
  window: { from: string; to: string; days: number }; threshold: number; count: number;
  /** Attention the linked instances cost in total, and the items they affected. */
  waitedMs: number; items: string[];
  /** The linked instances: each intervention's id and the ledger rows it was read from. */
  instances: { id: string; work: string | null; requestedAt: string; resolvedAt: string | null; waitedMs: number; sources: { seq: number; kind: string }[] }[];
  detectedAt: string;
}
export const workOriginSchema = z.object({
  pattern: z.object({
    kind: z.enum(interventionKinds), stage: stageSchema.nullable(),
    window: z.object({ from: z.string(), to: z.string(), days: z.number().int().positive() }).strict(), threshold: z.number().int().positive(), count: z.number().int().nonnegative(),
    waitedMs: z.number().nonnegative(), items: z.array(z.string()).max(500),
    instances: z.array(z.object({ id: z.string(), work: z.string().nullable(), requestedAt: z.string(), resolvedAt: z.string().nullable(), waitedMs: z.number().nonnegative(), sources: z.array(z.object({ seq: z.number(), kind: z.string() }).strict()).max(20) }).strict()).max(500),
    detectedAt: z.string(),
  }).strict().optional(),
  judgement: z.object({ id: z.string().uuid(), verdict: z.enum(judgementVerdicts), work: z.string().nullable(), page: z.string().nullable(), by: z.string(), at: z.string() }).strict().optional(),
  // A recurring fault class the master loop filed the item for (GY-173): the class the item closes.
  faultClass: faultClassOriginSchema.optional(),
  // The parent a review follow-up item collects findings for (GY-402), and their union: the one
  // origin that grows, as a later approval of the parent appends to it (model/machine-backlog.ts).
  reviewFollowUps: reviewFollowUpsOriginSchema.optional(),
}).strict();
export type WorkOrigin = z.infer<typeof workOriginSchema>;

export const interventionWindows = [7, 30, 90] as const;
export type InterventionWindow = typeof interventionWindows[number];

/** One pattern row of the report: see InterventionReport.patterns. */
export interface PatternRow {
  kind: InterventionKind; stage: Stage | 'none'; count: number; unlinked: number; threshold: number; crossed: boolean;
  work: { id: string; key: string; stage: Stage } | null;
  /** The items that own counted instances, each with its share, the causes its instances show and the rework rounds their items carried (GY-1682). */
  accounted: PatternOwner[];
  /** The whole pattern's causes and rework rounds (each item once), recorded against the item that stands for it, `work` (GY-1682 AC-2). */
  causes: Partial<Record<PatternCause, number>>; reworkRounds: number;
  instances: PatternInstance[];
  underThreshold: UnderThreshold;
}
/** One owner on a pattern row: `causes` tallies its instances by `patternCause`, `reworkRounds` sums its instances' items' rounds (each item once). */
export interface PatternOwner { id: string; key: string; stage: Stage; count: number; causes: Partial<Record<PatternCause, number>>; reworkRounds: number }
/**
 * A counted instance as the pattern row names it: the intervention, its item, what triggered it, the
 * item that owns it, its cause (GY-1682, `patternCause`) and the rework rounds its item carried
 * (`pipeline.reworkRounds`; null for an item the snapshot does not hold), the cost the cause is
 * visible as.
 */
export interface PatternInstance { id: string; work: { id: string; key: string } | null; requestedAt: string; resolvedAt: string | null; trigger: string | null; owner: string | null; cause: PatternCause | null; reworkRounds: number | null }
/** How many counted instances a pattern row names, newest first; `count` is the whole. */
export const patternInstancesShown = 100;
/**
 * GY-1682: the cause a counted scope widening shows in its trigger, the typed half the record holds.
 * A worker's ask for files the plan did not carry (`scope-request`, or one the rule refused,
 * `refused-by-loop`) is a requirement the plan left ambiguous; a master's own revision of the plan
 * with no ask before it (`operator-widening`) is a triage scope decision. A widening recorded by hand
 * with another trigger, or any other kind of intervention, carries no cause the record types.
 */
export const patternCauses = ['requirements-ambiguity', 'triage-scope-decision'] as const;
export type PatternCause = typeof patternCauses[number];
export const patternCauseLabel = { 'requirements-ambiguity': 'from requirements the plan left ambiguous', 'triage-scope-decision': 'from triage scope decisions' } as const satisfies Record<PatternCause, string>;
export function patternCause(kind: InterventionKind, trigger: string | null | undefined): PatternCause | null {
  if (kind !== 'scope-widening') return null;
  if (trigger === 'scope-request' || trigger === 'refused-by-loop') return 'requirements-ambiguity';
  return trigger === 'operator-widening' ? 'triage-scope-decision' : null;
}
/**
 * GY-1682: the pair against its threshold over every rolling window the ledger's reach establishes,
 * so the days a pattern has stayed under the rule are read off the row rather than asserted. It counts
 * every instance of the pair, linked to an item or not: linking an instance owns it, it does not undo
 * the intervention, and the rate the rule judges is the rate people were made to intervene at. `reach`
 * is where the record the reading reads is whole: an instance recorded before it is outside the
 * report. A rolling window of the policy's days is whole only once every instant it spans lies inside
 * the record, so the reading is established from `established` — the reach plus the policy's window —
 * and never claims a window the omitted rows before the reach may still belong to. `since` is the
 * instant from which every rolling window held fewer instances than the threshold — `established`
 * when none ever crossed, null while the current window is at or past it, and null while
 * `established` lies past the report's own instant (no window is whole yet; the row's count still says
 * what the record shows) — `days` the whole days since then, `holdDays` the days the pair must hold
 * before its pattern is read as under the rule (patternHoldDays), `peak` the most one established
 * window held, and `projected` the instant the streak would begin if no further instance is recorded:
 * when the current window is under the threshold but not yet whole, `established`; when it is at or
 * past the threshold, the instant it falls under it, fixed by the recorded instants (null once `since`
 * is set). The days themselves pass on the serving release; the reading says how many have.
 */
export interface UnderThreshold { since: string | null; days: number; holdDays: number; peak: number; projected: string | null; reach: string; established: string }
/** The consecutive days a pair must hold under the threshold in every rolling window before its pattern item's reading is met (GY-1682 AC-2). */
export const patternHoldDays = 14;

/**
 * GY-1682: a pattern item filed by hand. The scan opens an item with `origin.pattern` for a pair that
 * crossed the threshold, and only that origin stood for the pair; the master filed GY-1682 by hand
 * for an `intervention-pattern` fault (a fault-class origin, which carries no kind or stage), so the
 * report named no owner for a pattern an open item owned, and the scan would have opened a second
 * item beside it at the next crossing. What a hand filing keeps of the fault is the control plane's
 * own sentence (cli/intervention-status.ts): `N KIND interventions at the STAGE stage`. An open
 * machine-filed fault item quoting it in its title or description stands for that pair while it is
 * open; it links no instance — the unlinked ones are what it stands for — and an item the scan
 * opened for the pair stands first. Read only from items the loop filed (`origin.faultClass`): an
 * operator's own item that mentions a pattern is its author's, never the pattern's owner. Every pair
 * the item quotes is its: a fault-class item lists each recent instance of its class
 * (fault-class-recurrence.ts faultClassItem), so one quoting two patterns' faults stands for both,
 * and the scan opens nothing beside it for either.
 */
export function handFiledPatterns(work: { origin?: WorkOrigin | null; title: string; description?: string | null }): { kind: InterventionKind; stage: Stage | null }[] {
  if (!work.origin?.faultClass || work.origin.pattern) return [];
  const pairs = new Map<string, { kind: InterventionKind; stage: Stage | null }>();
  for (const match of `${work.title}\n${work.description ?? ''}`.matchAll(patternFaultLine())) {
    const pair = { kind: match[1] as InterventionKind, stage: match[2] && match[2] !== 'none' ? match[2] as Stage : null };
    pairs.set(`${pair.kind}|${pair.stage ?? 'none'}`, pair);
  }
  return [...pairs.values()];
}
let faultLine: RegExp | null = null;
/** The fault's own line, built on first use: `stages` resolves after this module in the import cycle (see stageSchema). A pattern at no stage reads `at no stage` (the scan's item) or `at the none stage` (the fault). */
const patternFaultLine = () => faultLine ??= new RegExp(`\\b\\d+ (${interventionKinds.join('|')}) interventions at (?:the (${stages.join('|')}|none) stage|no stage)\\b`, 'g');

/** Aggregation over the signals inside a window: the answer to "what is this product making people do by hand, and where". */
export interface InterventionReport {
  window: { days: number; from: string; to: string };
  policy: InterventionPolicy;
  /** Items delivered in the window: the denominator of the rate. */
  deliveries: number;
  /** Signals needed inside the window (opened or resolved in it), how many are still open, and the attention they cost. */
  total: number; open: number; waitedMs: number;
  /** Interventions per delivery; null while nothing was delivered in the window. */
  ratePerDelivery: number | null;
  byKind: { kind: InterventionKind; count: number; open: number; waitedMs: number }[];
  byStage: { stage: Stage | 'none'; count: number; open: number; waitedMs: number }[];
  byKindAndStage: { kind: InterventionKind; stage: Stage | 'none'; count: number; waitedMs: number }[];
  /** One bucket per day (7-day window) or per week, oldest first. */
  trend: { from: string; to: string; interventions: number; deliveries: number; waitedMs: number }[];
  /** The items that cost the most attention, most first. */
  costliest: { key: string; title: string; stage: Stage; count: number; waitedMs: number; kinds: Partial<Record<InterventionKind, number>> }[];
  /**
   * Every kind-at-stage pair against the recurrence rule, and the item that stands for it: the one the
   * scan opened when it crossed, or an open item filed by hand for the pattern's fault (handFiledPattern).
   * `count` is every instance in the window; `unlinked` is what the threshold judges — the instances no
   * delivered or open pattern item links — and `accounted` names the items that own the instances, with
   * each one's stage and share: the items whose pattern links them, and the standing item for the
   * unlinked rest (GY-1682), so a count past the threshold with no crossing reads as owned, not unfiled.
   * `instances` names the counted instances themselves (the newest `patternInstancesShown` of them),
   * each with its item, trigger, owner, cause and rework rounds, so the board shows the fold the row
   * was judged on and the causes are recorded against the item that owns them, and `causes` and
   * `reworkRounds` tally the whole pattern against the standing item; `underThreshold` reads how
   * long every rolling window has held under the rule over every instance, linked or not. A pair
   * whose instances have all left the policy window but not the ledger's reach keeps a row at count
   * 0, so that reading stays readable.
   */
  patterns: PatternRow[];
  judgements: Judgement[];
  /** The signals themselves, newest first. */
  interventions: Intervention[];
}
