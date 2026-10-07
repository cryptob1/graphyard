import { z } from 'zod';
import { caseDirectory, caseId, contractFile } from '../e2e/case.js';
import { criterionSchema } from './policy.js';
import { demand } from './refusal.js';
import type { Goal, GoalContext } from './goal.js';

/**
 * The plan of a goal (GY-1418): once its acceptance pull request merged, the `planner` role
 * (src/daemon/planner.ts) writes a short architecture note and a dependency-ordered set of work
 * items with file boundaries. A plan that leaves an approved outcome uncovered, names no case,
 * lets parallel items share a file or touches a required case is refused with the reason before
 * any approver sees it; an approver who is not its author approves it, and only then are its
 * items created and released (src/server/routes/goals.ts releasePlan).
 */
const line = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value), 'Control characters are not allowed');
const reason = line(2000);

/** The architecture note's bound, in words. */
export const planNoteMaxWords = 400;
/** Plans the loop drafts for one goal; past them a refused plan is the master's to answer. */
export const maxPlanRounds = 3;
const planRef = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'A plan item ref is lower-case letters, digits and -, starting with a letter');
/** One planned work item: the outcomes it serves, the required cases it must make pass, its criteria, its file boundary and the items it lands after. */
export const planItemSchema = z.object({
  ref: planRef,
  title: line(200),
  description: z.string().trim().max(20000).default(''),
  type: z.enum(['feature', 'bug', 'chore']).default('feature'),
  priority: z.number().int().min(0).max(4).default(2),
  outcomes: z.array(caseId).min(1).max(30),
  cases: z.array(caseId).min(1).max(30),
  criteria: z.array(criterionSchema).min(1).max(20),
  plannedFiles: z.array(line(500)).min(1).max(100),
  dependsOn: z.array(planRef).max(20).default([]),
}).strict();
export type PlanItem = z.infer<typeof planItemSchema>;
export const goalPlanSchema = z.object({ note: line(6000), items: z.array(planItemSchema).min(1).max(30) }).strict();
export type GoalPlan = z.infer<typeof goalPlanSchema>;
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
/** Whether one planned path covers the other: the same file, or a directory (ending in /) holding it. */
const pathsMeet = (a: string, b: string) => a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b));
/** Every item ref each item lands after, directly or through another. */
function reaches(plan: Pick<GoalPlan, 'items'>) {
  const direct = new Map(plan.items.map(item => [item.ref, item.dependsOn]));
  const closure = new Map<string, Set<string>>();
  const walk = (ref: string, seen: Set<string>) => { for (const next of direct.get(ref) ?? []) if (!seen.has(next)) { seen.add(next); walk(next, seen); } return seen; };
  for (const item of plan.items) closure.set(item.ref, walk(item.ref, new Set()));
  return closure;
}

/**
 * Pure: every reason a plan cannot go to approval, each naming what to change. The note is at most
 * planNoteMaxWords words; every approved outcome is served by at least one item; each item names
 * the goal's required cases it must make pass (at least the case of every outcome it serves);
 * dependencies name items of the plan without a cycle; two items neither of which lands after the
 * other share no planned file; and no item plans a change to a protected case or the contract.
 */
export function planRefusals(goal: Pick<Goal, 'key' | 'protected' | 'acceptance'>, plan: GoalPlan): string[] {
  const refusals: string[] = [];
  const noteWords = words(plan.note);
  if (noteWords > planNoteMaxWords) refusals.push(`the architecture note is ${noteWords} words; it is at most ${planNoteMaxWords}`);
  const refs = plan.items.map(item => item.ref);
  const twice = [...new Set(refs.filter((ref, index) => refs.indexOf(ref) !== index))];
  if (twice.length) refusals.push(`item ref${twice.length === 1 ? '' : 's'} ${twice.join(', ')} ${twice.length === 1 ? 'is' : 'are'} planned twice`);
  const caseOfOutcome = new Map((goal.acceptance?.outcomes ?? []).map(outcome => [outcome.id, outcome.case.id]));
  for (const item of plan.items) {
    const strange = item.outcomes.filter(id => !goal.protected.outcomes.includes(id));
    if (strange.length) refusals.push(`item ${item.ref} serves ${strange.join(', ')}, which ${goal.key} did not approve; its outcomes are ${goal.protected.outcomes.join(', ')}`);
    const unknown = item.cases.filter(id => !goal.protected.cases.includes(id));
    if (unknown.length) refusals.push(`item ${item.ref} names case${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}, which ${goal.key} does not require; its cases are ${goal.protected.cases.join(', ')}`);
    const owed = item.outcomes.map(id => caseOfOutcome.get(id)).filter((id): id is string => !!id && !item.cases.includes(id));
    if (owed.length) refusals.push(`item ${item.ref} serves an outcome without naming the case that proves it: add ${owed.join(', ')} to its cases`);
    const missing = item.dependsOn.filter(ref => !refs.includes(ref) || ref === item.ref);
    if (missing.length) refusals.push(`item ${item.ref} depends on ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not another item of this plan`);
    const guarded = item.plannedFiles.filter(path => path === contractFile || goal.protected.cases.some(id => pathsMeet(path, `${caseDirectory}/${id}.json`)));
    if (guarded.length) refusals.push(`item ${item.ref} plans ${guarded.join(', ')}: no item edits or weakens a required case or its contract binding`);
  }
  const uncovered = goal.protected.outcomes.filter(id => !plan.items.some(item => item.outcomes.includes(id)));
  if (uncovered.length) refusals.push(`no item serves approved outcome${uncovered.length === 1 ? '' : 's'} ${uncovered.join(', ')}; every outcome is covered by at least one item`);
  const closure = reaches(plan);
  const cyclic = plan.items.filter(item => closure.get(item.ref)!.has(item.ref)).map(item => item.ref);
  if (cyclic.length) refusals.push(`items ${cyclic.join(', ')} depend on each other in a cycle`);
  for (const [index, a] of plan.items.entries()) for (const b of plan.items.slice(index + 1)) {
    if (a.ref === b.ref || closure.get(a.ref)!.has(b.ref) || closure.get(b.ref)!.has(a.ref)) continue;
    const shared = a.plannedFiles.filter(path => b.plannedFiles.some(other => pathsMeet(path, other)));
    if (shared.length) refusals.push(`items ${a.ref} and ${b.ref} may run in parallel yet both plan ${shared.join(', ')}: give them separate files or make one depend on the other`);
  }
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
  'plan-approve': z.object({ reason }).strict(),
  'plan-refuse': z.object({ reason }).strict(),
  release: z.object({}).strict(),
  released: z.object({ items: z.array(releasedItemSchema).min(1).max(30) }).strict(),
} as const;
export type PlanCommand = keyof typeof planCommandSchemas;
export const isPlanCommand = (command: string): command is Exclude<PlanCommand, 'release'> => command !== 'release' && command in planCommandSchemas;

/** Pure: one plan command applied to `next` (a copy of `goal`): its author never judges it, and a release is recorded only once every item is released. */
export function applyPlanCommand(goal: Goal, next: Goal, command: Exclude<PlanCommand, 'release'>, input: unknown, context: GoalContext) {
  const { actor, at } = context;
  if (command === 'plan') {
    const data = planCommandSchemas.plan.parse(input);
    demand(goal.stage === 'planning', `${goal.key} is ${goal.stage}; a plan is accepted only while the goal is being planned`);
    const refusals = planRefusals(goal, data);
    demand(!refusals.length, `Plan refused for ${goal.key}: ${refusals.join('; ')}`, 422);
    next.plan = { ...data, author: actor.id, draftedAt: at }; next.planApproval = null; next.stage = 'plan-review'; next.planDrafts = (goal.planDrafts ?? 0) + 1;
  } else if (command === 'plan-approve' || command === 'plan-refuse') {
    const data = planCommandSchemas[command].parse(input);
    demand(goal.stage === 'plan-review' && goal.plan, `${goal.key} is ${goal.stage}; only a plan awaiting approval is judged`);
    demand(actor.id !== goal.plan.author, `Self-approval refused: ${actor.id} authored the plan of ${goal.key}; an approver on a different identity judges it`, 403);
    if (command === 'plan-approve') { next.planApproval = { by: actor.id, at, reason: data.reason }; next.stage = 'planned'; }
    else { next.planRefusal = { by: actor.id, at, reason: data.reason }; next.plan = null; next.stage = 'planning'; }
  } else if (command === 'released') {
    // Recorded by the release route once every planned item exists, carries its dependencies and is released.
    const data = planCommandSchemas.released.parse(input);
    demand(goal.stage === 'planned' && goal.plan && goal.planApproval, `${goal.key} is ${goal.stage}; only an approved plan is released`);
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
  if (goal.stage === 'planning') return { who: 'planner role (the master loop launches it once its operator-agent and approver identities are provisioned)', command: `graphyard goal plan ${goal.key} PLAN.json` };
  if (goal.stage === 'plan-review') return { who: `an approver other than ${goal.plan!.author}`, command: `graphyard goal plan-approve ${goal.key} -- REASON (or goal plan-refuse)` };
  if (goal.stage === 'planned') return { who: 'the loop: Graphyard creates and releases the approved plan\'s items, carrying their dependencies', command: `graphyard goal release ${goal.key}` };
  if (goal.stage === 'delivering' && goal.items?.length) return { who: `the loop: the dispatcher delivers ${goal.items.map(item => item.key).join(', ')} in dependency order; the goal is delivered once every one is done and production serves it`, command: `graphyard goal deliver ${goal.key} ${goal.items.map(item => item.key).join(' ')} -- REASON` };
  return null;
}

/** What creating one approved plan item sends: its criteria and file boundary, the dependencies already created, and the goal, outcomes, required cases and architecture note it serves. */
export function planItemInput(goal: Pick<Goal, 'key' | 'statement' | 'acceptance'> & { plan: GoalPlan & { author: string }; planApproval: { by: string } }, item: PlanItem, created: ReadonlyMap<string, { id: string }>) {
  const outcomes = (goal.acceptance?.outcomes ?? []).filter(outcome => item.outcomes.includes(outcome.id));
  const description = [item.description, '',
    `Planned for ${goal.key} (${goal.statement}) by ${goal.plan.author}; the plan was approved by ${goal.planApproval.by}.`,
    `It serves outcome${outcomes.length === 1 ? '' : 's'} ${outcomes.map(outcome => `${outcome.id} (${outcome.title})`).join(', ') || item.outcomes.join(', ')}, and must make the required uat case${item.cases.length === 1 ? '' : 's'} ${item.cases.map(id => `${caseDirectory}/${id}.json`).join(', ')} pass. Those cases are protected: never edit or weaken them; a needed change goes through graphyard goal case-change.`,
    '', `Architecture note for ${goal.key}:`, goal.plan.note].join('\n').trim();
  return {
    title: `${goal.key}: ${item.title}`.slice(0, 200), description: description.length > 20000 ? `${description.slice(0, 19999)}…` : description,
    type: item.type, priority: item.priority, criteria: item.criteria, plannedFiles: item.plannedFiles,
    dependencies: item.dependsOn.map(ref => { const dependency = created.get(ref); if (!dependency) throw new Error(`${item.ref} depends on ${ref}, which is not created yet`); return dependency.id; }),
    reason: `${goal.key}'s approved plan item ${item.ref}`,
  };
}
