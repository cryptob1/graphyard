import { z } from 'zod';
import { caseDirectory, caseId } from '../e2e/case.js';
import { criteriaSchema } from './policy.js';
import { demand } from './refusal.js';
import type { Work } from './work.js';
import type { Goal, GoalContext } from './goal.js';

/**
 * The plan of a goal (GY-1418): once its acceptance pull request merged, the `planner` role
 * (src/daemon/planner.ts) writes a short architecture note and a dependency-ordered set of work
 * items with file boundaries. A plan that leaves an outcome uncovered, names no case, lets
 * parallel items share a file or touches a required case is refused with the reason; a plan that
 * passes is recorded planned and its items are created and released (src/server/routes/goals.ts releasePlan).
 *
 * GY-2011: the plan also carries a plain `summary` (at most three sentences a person can read in a
 * minute) and each item a one-sentence `plain` description; both are required on the payload and
 * shown on the goal's picture page and each item page.
 */
const line = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value), 'Control characters are not allowed');
const reason = line(2000);

/** The architecture note's bound, in words. */
export const planNoteMaxWords = 400;
/** The plan summary's bound, in plain sentences (GY-2011). */
export const planSummaryMaxSentences = 3;
/** Plans the loop drafts for one goal; past them a refused plan is the master's to answer. */
export const maxPlanRounds = 3;
const planRef = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'A plan item ref is lower-case letters, digits and -, starting with a letter');
/** Plain sentences: split on . ! ? followed by space or end; empty text is zero sentences. */
export const plainSentences = (text: string) => text.trim().split(/(?<=[.!?])(?:\s+|$)/).map(part => part.trim()).filter(Boolean);
/** One planned work item: the outcomes it serves, the required cases it must make pass, its criteria and the items it lands after. */
export const planItemSchema = z.object({
  ref: planRef,
  title: line(200),
  /** One plain sentence a non-engineer understands (GY-2011); copied onto the work item as `summary` at release. */
  plain: line(400).refine(value => plainSentences(value).length === 1, { message: 'plain is one sentence' }),
  description: z.string().trim().max(20000).default(''),
  type: z.enum(['feature', 'bug', 'chore']).default('feature'),
  priority: z.number().int().min(0).max(4).default(2),
  outcomes: z.array(caseId).min(1).max(30),
  cases: z.array(caseId).min(1).max(30),
  criteria: criteriaSchema(20),
  // GY-1992: plannedFiles is retired; a plan drafted before then still parses, and the field is dropped.
  plannedFiles: z.unknown().transform(() => undefined).optional(),
  dependsOn: z.array(planRef).max(20).default([]),
}).strict();
export type PlanItem = z.infer<typeof planItemSchema>;
export const goalPlanSchema = z.object({
  /** At most three plain sentences: what the user gets and how it will be built (GY-2011). */
  summary: line(800),
  note: line(6000),
  items: z.array(planItemSchema).min(1).max(30),
}).strict().superRefine((plan, ctx) => {
  const count = plainSentences(plan.summary).length;
  if (count > planSummaryMaxSentences) ctx.addIssue({ code: 'custom', path: ['summary'], message: `summary is ${count} sentences; it is at most ${planSummaryMaxSentences}` });
});
export type GoalPlan = z.infer<typeof goalPlanSchema>;
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
/** Every item ref each item lands after, directly or through another. */
function reaches(plan: Pick<GoalPlan, 'items'>) {
  const direct = new Map(plan.items.map(item => [item.ref, item.dependsOn]));
  const closure = new Map<string, Set<string>>();
  const walk = (ref: string, seen: Set<string>) => { for (const next of direct.get(ref) ?? []) if (!seen.has(next)) { seen.add(next); walk(next, seen); } return seen; };
  for (const item of plan.items) closure.set(item.ref, walk(item.ref, new Set()));
  return closure;
}

/**
 * Pure: every reason a plan is refused, each naming what to change. The note is at most
 * planNoteMaxWords words; every outcome is served by at least one item; each item names
 * the goal's required cases it must make pass (at least the case of every outcome it serves);
 * each item's criterion ids are unique; and dependencies name items of the plan without a cycle.
 */
export function planRefusals(goal: Pick<Goal, 'key' | 'protected' | 'acceptance'>, plan: GoalPlan): string[] {
  const refusals: string[] = [];
  if (!('summary' in plan) || plan.summary == null || String(plan.summary).trim() === '') refusals.push('summary is missing');
  else {
    const summarySentences = plainSentences(plan.summary);
    if (summarySentences.length > planSummaryMaxSentences) refusals.push(`summary is ${summarySentences.length} sentences; it is at most ${planSummaryMaxSentences}`);
  }
  const noteWords = words(plan.note);
  if (noteWords > planNoteMaxWords) refusals.push(`the architecture note is ${noteWords} words; it is at most ${planNoteMaxWords}`);
  const refs = plan.items.map(item => item.ref);
  const twice = [...new Set(refs.filter((ref, index) => refs.indexOf(ref) !== index))];
  if (twice.length) refusals.push(`item ref${twice.length === 1 ? '' : 's'} ${twice.join(', ')} ${twice.length === 1 ? 'is' : 'are'} planned twice`);
  const caseOfOutcome = new Map((goal.acceptance?.outcomes ?? []).map(outcome => [outcome.id, outcome.case.id]));
  for (const item of plan.items) {
    if (!('plain' in item) || item.plain == null || String(item.plain).trim() === '') refusals.push(`plain is missing on item ${item.ref}`);
    else if (plainSentences(item.plain).length !== 1) refusals.push(`item ${item.ref}'s plain is ${plainSentences(item.plain).length} sentences; it is one sentence`);
    const strange = item.outcomes.filter(id => !goal.protected.outcomes.includes(id));
    if (strange.length) refusals.push(`item ${item.ref} serves ${strange.join(', ')}, which ${goal.key} did not approve; its outcomes are ${goal.protected.outcomes.join(', ')}`);
    const unknown = item.cases.filter(id => !goal.protected.cases.includes(id));
    if (unknown.length) refusals.push(`item ${item.ref} names case${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}, which ${goal.key} does not require; its cases are ${goal.protected.cases.join(', ')}`);
    const owed = item.outcomes.map(id => caseOfOutcome.get(id)).filter((id): id is string => !!id && !item.cases.includes(id));
    if (owed.length) refusals.push(`item ${item.ref} serves an outcome without naming the case that proves it: add ${owed.join(', ')} to its cases`);
    const ids = item.criteria.map(criterion => criterion.id), repeated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    if (repeated.length) refusals.push(`item ${item.ref} names criterion ${repeated.join(', ')} twice: each criterion id is unique within its item`);
    const missing = item.dependsOn.filter(ref => !refs.includes(ref) || ref === item.ref);
    if (missing.length) refusals.push(`item ${item.ref} depends on ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not another item of this plan`);
  }
  const uncovered = goal.protected.outcomes.filter(id => !plan.items.some(item => item.outcomes.includes(id)));
  if (uncovered.length) refusals.push(`no item serves approved outcome${uncovered.length === 1 ? '' : 's'} ${uncovered.join(', ')}; every outcome is covered by at least one item`);
  const closure = reaches(plan);
  const cyclic = plan.items.filter(item => closure.get(item.ref)!.has(item.ref)).map(item => item.ref);
  if (cyclic.length) refusals.push(`items ${cyclic.join(', ')} depend on each other in a cycle`);
  return refusals;
}
/** The plan's items in dependency order: each after every item it depends on, otherwise as planned. Throws on a cycle. */
export function planOrder(plan: Pick<GoalPlan, 'items'>): PlanItem[] {
  const ordered: PlanItem[] = [], placed = new Set<string>();
  while (ordered.length < plan.items.length) {
    const next = plan.items.find(item => !placed.has(item.ref) && item.dependsOn.every(ref => placed.has(ref)));
    if (!next) throw new Error(`the plan's items ${plan.items.filter(item => !placed.has(item.ref)).map(item => item.ref).join(', ')} depend on each other in a cycle`);
    ordered.push(next); placed.add(next.ref);
  }
  return ordered;
}
/** One released plan item: its plan ref and the work item created for it. */
export const releasedItemSchema = z.object({ ref: planRef, key: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/), id: z.string().uuid() }).strict();

export const planCommandSchemas = {
  plan: goalPlanSchema,
  // A plan the loop refused (planRefusals, or a 422 on posting it): it counts toward maxPlanRounds.
  'plan-invalid': z.object({ reason }).strict(),
  release: z.object({}).strict(),
  released: z.object({ items: z.array(releasedItemSchema).min(1).max(30) }).strict(),
} as const;
export type PlanCommand = keyof typeof planCommandSchemas;
export const isPlanCommand = (command: string): command is Exclude<PlanCommand, 'release'> => command !== 'release' && command in planCommandSchemas;

/** Pure: one plan command applied to `next` (a copy of `goal`): a release is recorded only once every item is released. */
export function applyPlanCommand(goal: Goal, next: Goal, command: Exclude<PlanCommand, 'release'>, input: unknown, context: GoalContext) {
  const { actor, at } = context;
  if (command === 'plan') {
    const data = planCommandSchemas.plan.parse(input);
    demand(goal.stage === 'planning', `${goal.key} is ${goal.stage}; a plan is accepted only while the goal is being planned`);
    const refusals = planRefusals(goal, data);
    demand(!refusals.length, `Plan refused for ${goal.key}: ${refusals.join('; ')}`, 422);
    next.plan = { ...data, author: actor.id, draftedAt: at }; next.stage = 'planned'; next.planDrafts = (goal.planDrafts ?? 0) + 1;
  } else if (command === 'plan-invalid') {
    const data = planCommandSchemas[command].parse(input);
    demand(goal.stage === 'planning', `${goal.key} is ${goal.stage}; only a plan being drafted is refused`);
    next.planRefusal = { by: actor.id, at, reason: data.reason }; next.planDrafts = (goal.planDrafts ?? 0) + 1;
  } else if (command === 'released') {
    // Recorded by the release route once every planned item exists, carries its dependencies and is released.
    const data = planCommandSchemas.released.parse(input);
    demand(goal.stage === 'planned' && goal.plan, `${goal.key} is ${goal.stage}; only a recorded plan is released`);
    const named = data.items.map(item => item.ref);
    const missing = goal.plan.items.map(item => item.ref).filter(ref => !named.includes(ref));
    demand(!missing.length && named.length === goal.plan.items.length, `${goal.key}'s release names ${named.join(', ')}; its plan has ${goal.plan.items.map(item => item.ref).join(', ')}`, 422);
    demand(context.unreleased && !context.unreleased.length, `${goal.key}'s plan is not released: ${(context.unreleased ?? ['its items were not read']).join('; ')}`, 422);
    next.items = data.items; next.stage = 'delivering';
  }
}

/** Who acts next on a goal past its acceptance, while the plan is its; null otherwise. */
export function planNext(goal: Goal): { who: string; command: string } | null {
  if (goal.stage === 'planning' && (goal.planDrafts ?? 0) >= maxPlanRounds) return { who: `master: ${maxPlanRounds} plans were refused (last: ${goal.planRefusal?.reason ?? 'none recorded'}); the loop plans no more`, command: `graphyard goal plan ${goal.key} PLAN.json` };
  if (goal.stage === 'planning') return { who: 'planner role (the master loop launches it once its operator-agent identity is provisioned)', command: `graphyard goal plan ${goal.key} PLAN.json` };
  if (goal.stage === 'planned') return { who: 'the loop: Graphyard creates and releases the plan\'s items, carrying their dependencies', command: `graphyard goal release ${goal.key}` };
  if (goal.stage === 'delivering' && goal.items?.length) return { who: `the loop: the dispatcher delivers ${goal.items.map(item => item.key).join(', ')} in dependency order; the goal is delivered once every one is merged`, command: `graphyard goal deliver ${goal.key} ${goal.items.map(item => item.key).join(' ')} -- REASON` };
  return null;
}

/** An item delivers its goal once it is merged (GY-1981: done = merged). Read by the deliver route and the loop alike. */
export const mergedItem = (work: Work | undefined) => !!work && work.stage === 'done' && !work.closure && !!work.delivery;
/** The first line of a released plan item's description: the durable mark a retried release finds it by, whatever receipts expired. */
export const planItemMark = (goal: Pick<Goal, 'key'>, plan: { draftedAt: string }, item: Pick<PlanItem, 'ref'>) => `Plan item ${item.ref} of ${goal.key}'s plan drafted ${plan.draftedAt}.`;
/** What creating one plan item sends: its criteria, the dependencies already created, and the goal, outcomes, required cases and architecture note it serves. */
export function planItemInput(goal: Pick<Goal, 'key' | 'statement' | 'acceptance'> & { plan: GoalPlan & { author: string; draftedAt: string } }, item: PlanItem, created: ReadonlyMap<string, { id: string }>) {
  const outcomes = (goal.acceptance?.outcomes ?? []).filter(outcome => item.outcomes.includes(outcome.id));
  const description = [planItemMark(goal, goal.plan, item), item.description, '',
    `Planned for ${goal.key} (${goal.statement}) by ${goal.plan.author}.`,
    `It serves outcome${outcomes.length === 1 ? '' : 's'} ${outcomes.map(outcome => `${outcome.id} (${outcome.title})`).join(', ') || item.outcomes.join(', ')}, and must make the required uat case${item.cases.length === 1 ? '' : 's'} ${item.cases.map(id => `${caseDirectory}/${id}.json`).join(', ')} pass. Those cases are protected: never edit or weaken them; a needed change is the master's to grant (graphyard goal case-change).`,
    '', `Architecture note for ${goal.key}:`, goal.plan.note].join('\n').trim();
  return {
    title: `${goal.key}: ${item.title}`.slice(0, 200), description: description.length > 20000 ? `${description.slice(0, 19999)}…` : description,
    // The item page opens on this plain sentence (GY-2011); master create may set the same field by hand.
    summary: item.plain,
    type: item.type, priority: item.priority, criteria: item.criteria,
    dependencies: item.dependsOn.map(ref => { const dependency = created.get(ref); if (!dependency) throw new Error(`${item.ref} depends on ${ref}, which is not created yet`); return dependency.id; }),
    reason: `${goal.key}'s plan item ${item.ref}`,
  };
}
