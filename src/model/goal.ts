import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { caseDirectory, caseId, caseSchema, contractFile, type ReleaseContract } from '../e2e/case.js';
import { applyPlanCommand, isPlanCommand, planCommandSchemas, planNext, type GoalPlan } from './goal-plan.js';
import { demand } from './refusal.js';
import type { Observation, Principal, ScopeFile, Work } from './work.js';

/**
 * Goals and their acceptance (GY-1417). A goal is what the operator (or the master, on the
 * operator's behalf) wants: a short statement, the users it is for, its constraints and where it is
 * deployed. Before any code is written the `acceptance` role (src/daemon/acceptance.ts) turns it
 * into plain-language customer outcomes, one required uat E2E case per outcome (the GY-1351 case
 * format) and the release-contract bindings in e2e/contract.json, opened as one pull request linked
 * to the goal. An approver on another identity approves that draft — its author never can — and
 * once the pull request merges the goal's cases and bindings are protected: an implementation
 * candidate that modifies or deletes one is refused at `complete`, and a change to one goes only
 * through an approved case change whose approver is neither its requester nor an implementer of
 * the item that asked. People who write the tests are not the people who write the code.
 *
 * Once the acceptance pull request merged, the `planner` role (GY-1418, src/daemon/planner.ts) turns the
 * goal into a short architecture note and a dependency-ordered set of work items with file
 * boundaries; an approver who is not its author approves the plan, and only then are its items
 * created and released, so the goal moves planned → delivering → delivered.
 *
 * A goal lives in the event ledger (work_id NULL, kinds `goal.*`): each event carries the whole goal
 * after the change, so the newest event per goal is its record and the rest is its history.
 */
export const goalStages = ['acceptance-drafting', 'awaiting-approval', 'accepted', 'planning', 'plan-review', 'planned', 'delivering', 'delivered'] as const;
export type GoalStage = typeof goalStages[number];
/** The stages a goal's cases are protected in: its acceptance pull request merged. */
export const protectingStages: readonly GoalStage[] = ['planning', 'plan-review', 'planned', 'delivering', 'delivered'];
/** Drafts the loop writes for one goal; past them a refused or closed draft is the master's to answer. */
export const maxDraftRounds = 3;
/** An approved acceptance pull request not merged this long after its approval is the master's to answer. */
export const acceptanceStuckMs = 24 * 60 * 60_000;

const line = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value), 'Control characters are not allowed');
const reason = line(2000);
export const goalKeyPattern = /^GOAL-\d{1,9}$/;

/** What `graphyard goal FILE` reads: the goal as the operator states it. */
export const goalInputSchema = z.object({
  statement: line(2000),
  users: z.array(line(200)).min(1).max(20),
  constraints: z.array(line(500)).max(30).default([]),
  deployTarget: line(200),
}).strict();
export type GoalInput = z.infer<typeof goalInputSchema>;

/** One customer outcome, in the customer's words, with the one required uat case that proves it. */
export const acceptanceOutcomeSchema = z.object({
  id: caseId,
  title: line(200),
  criteria: z.array(line(500)).min(1).max(20),
  case: caseSchema,
}).strict();
export type AcceptanceOutcome = z.infer<typeof acceptanceOutcomeSchema>;
/** The acceptance role's draft: every outcome with its case, each case required and targeting uat. */
export const acceptanceDraftSchema = z.object({ outcomes: z.array(acceptanceOutcomeSchema).min(1).max(30) }).strict().superRefine((draft, context) => {
  draft.outcomes.forEach((outcome, index) => {
    if (!outcome.case.required) context.addIssue({ code: 'custom', path: ['outcomes', index, 'case', 'required'], message: `the case for outcome ${outcome.id} must be required` });
    if (outcome.case.target !== 'uat') context.addIssue({ code: 'custom', path: ['outcomes', index, 'case', 'target'], message: `the case for outcome ${outcome.id} must target uat` });
    if (draft.outcomes.findIndex(other => other.id === outcome.id) !== index) context.addIssue({ code: 'custom', path: ['outcomes', index, 'id'], message: `outcome ${outcome.id} is drafted twice` });
    if (draft.outcomes.findIndex(other => other.case.id === outcome.case.id) !== index) context.addIssue({ code: 'custom', path: ['outcomes', index, 'case', 'id'], message: `case ${outcome.case.id} proves two outcomes; one case per outcome` });
  });
});
export type AcceptanceDraft = z.infer<typeof acceptanceDraftSchema>;
const sha = z.string().regex(/^[0-9a-f]{40}$/);
/** A posted draft: the outcomes and the pull request the loop opened them as, at its head. */
export const draftInputSchema = z.object({ outcomes: z.unknown(), pr: z.number().int().positive(), branch: line(200), head: sha }).strict()
  .transform(({ outcomes, pr, branch, head }) => ({ ...acceptanceDraftSchema.parse({ outcomes }), pr, branch, head }));

export const goalCommandSchemas = {
  approve: z.object({ reason }).strict(),
  refuse: z.object({ reason }).strict(),
  merged: z.object({ pr: z.number().int().positive(), mergeSha: sha.nullable().default(null) }).strict(),
  land: z.object({}).strict(),
  closed: z.object({ pr: z.number().int().positive(), reason }).strict(),
  deliver: z.object({ items: z.array(z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/)).min(1).max(100), reason }).strict(),
  ...planCommandSchemas,
  'case-change': z.object({ work: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/), cases: z.array(caseId).min(1).max(50), reason }).strict(),
  'case-change-approve': z.object({ change: z.string().uuid(), reason }).strict(),
  'case-change-refuse': z.object({ change: z.string().uuid(), reason }).strict(),
} as const;
export type GoalCommand = 'record' | 'draft' | keyof typeof goalCommandSchemas;

/** A request to change protected cases for one implementation item, and its independent judgement. */
export interface CaseChange {
  id: string; work: string; cases: string[]; reason: string; requestedBy: string; requestedAt: string;
  state: 'requested' | 'approved' | 'refused'; judgedBy: string | null; judgedAt: string | null; judgement: string | null;
}
export interface Goal extends GoalInput {
  id: string; key: string; stage: GoalStage; revision: number;
  recordedBy: string; recordedAt: string; updatedAt: string;
  /** The acceptance role's draft: who wrote it, its pull request at its head, and its outcomes with their cases. */
  acceptance: { author: string; pr: number; branch: string; head: string; draftedAt: string; outcomes: AcceptanceOutcome[] } | null;
  /** The approval binds the head it judged: the pull request merges only at that head. */
  approval: { by: string; at: string; reason: string; head: string } | null;
  /** The last refused (or closed unmerged) draft, so the next draft can answer it and the loop closes its pull request. */
  refusal: { by: string; at: string; reason: string; pr: number; branch: string } | null;
  /** How many drafts were posted; the loop drafts at most maxDraftRounds. */
  drafts: number;
  merged: { at: string; by: string; pr: number; mergeSha: string | null } | null;
  /** What stays protected once the acceptance pull request merged: the case ids and outcome ids it added. */
  protected: { cases: string[]; outcomes: string[] };
  caseChanges: CaseChange[];
  /** The planner's plan (GY-1418): who wrote it, its architecture note and its items; null until one is drafted (absent on a goal recorded before planning existed). */
  plan?: (GoalPlan & { author: string; draftedAt: string }) | null;
  /** The plan's approval, by an identity other than its author. */
  planApproval?: { by: string; at: string; reason: string } | null;
  /** The last refused plan's reason, so the next plan answers it. */
  planRefusal?: { by: string; at: string; reason: string } | null;
  /** How many plans were drafted; the loop drafts at most maxPlanRounds. */
  planDrafts?: number;
  /** The work items created and released for the approved plan, in dependency order. */
  items?: { ref: string; key: string; id: string }[];
}

/** The contract bindings a draft adds to e2e/contract.json: one outcome, its criteria and its one case. */
export const contractBindings = (draft: Pick<AcceptanceDraft, 'outcomes'>): ReleaseContract['outcomes'] =>
  draft.outcomes.map(outcome => ({ id: outcome.id, title: outcome.title, criteria: outcome.criteria, cases: [outcome.case.id] }));
/** Each file a draft adds: its cases under e2e/cases/, and the contract with its bindings appended. */
export function draftFiles(draft: Pick<AcceptanceDraft, 'outcomes'>, contract: ReleaseContract | null): { path: string; content: string }[] {
  const existing = contract?.outcomes ?? [];
  const clash = draft.outcomes.filter(outcome => existing.some(entry => entry.id === outcome.id)).map(outcome => outcome.id);
  demand(!clash.length, `${contractFile} already declares outcome${clash.length === 1 ? '' : 's'} ${clash.join(', ')}; the draft must name new outcomes`, 422);
  return [
    ...draft.outcomes.map(outcome => ({ path: `${caseDirectory}/${outcome.case.id}.json`, content: `${JSON.stringify(outcome.case, null, 2)}\n` })),
    { path: contractFile, content: `${JSON.stringify({ outcomes: [...existing, ...contractBindings(draft)] }, null, 2)}\n` },
  ];
}

/**
 * What landing an approved acceptance pull request found (POST /api/goals/:key/land, src/server/routes/goals.ts).
 * `unapproved`: GitHub merged a head or base no approver judged, so nothing is protected and the goal is drafted again.
 */
export interface Landing { state: 'merged' | 'waiting' | 'conflicting' | 'moved' | 'closed' | 'unapproved'; detail: string; mergeSha: string | null }
/** Everyone who has implemented an item: every identity assigned it, its lease owner and its last assignee. */
export const implementersOf = (work: Partial<Pick<Work, 'implementers' | 'lease' | 'lastAssignment'>> | null | undefined): string[] =>
  [...new Set([...(work?.implementers ?? []), ...(work?.lease ? [work.lease.owner] : []), ...(work?.lastAssignment ? [work.lastAssignment.owner] : [])])];

export interface GoalContext {
  actor: Principal; at: string;
  /** Every other goal, to refuse a draft naming a case or outcome another goal already protects. */
  others?: readonly Goal[];
  /** For a case-change judgement: who has implemented the item the change is for. */
  implementers?: readonly string[];
  /** For a delivery: the named items that are not delivered (the route reads them); delivery waits on every one. */
  undelivered?: readonly string[];
  /** For a release: what is wrong with the created items (missing, unreleased, a dependency not carried); the route reads them. */
  unreleased?: readonly string[];
}

/** A new goal, in acceptance drafting. */
export function recordGoal(input: unknown, key: string, context: GoalContext): Goal {
  const data = goalInputSchema.parse(input);
  return { id: randomUUID(), key, ...data, stage: 'acceptance-drafting', revision: 1, recordedBy: context.actor.id, recordedAt: context.at, updatedAt: context.at,
    acceptance: null, approval: null, refusal: null, drafts: 0, merged: null, protected: { cases: [], outcomes: [] }, caseChanges: [],
    plan: null, planApproval: null, planRefusal: null, planDrafts: 0, items: [] };
}

/**
 * Pure: one command applied to a goal, every rule checked, returning the goal after it. The author
 * of a draft never judges it, and a case change is judged by neither its requester nor any
 * implementer of its item; each refusal names who may act instead.
 */
export function applyGoalCommand(goal: Goal, command: Exclude<GoalCommand, 'record' | 'land' | 'release'>, input: unknown, context: GoalContext): Goal {
  const next: Goal = structuredClone(goal);
  const { actor, at } = context;
  if (command === 'draft') {
    const data = draftInputSchema.parse(input);
    demand(goal.stage === 'acceptance-drafting', `${goal.key} is ${goal.stage}; a draft is accepted only while acceptance is being drafted`);
    const owned = new Map<string, string>((context.others ?? []).filter(other => other.id !== goal.id).flatMap(other => [...other.protected.cases.map(id => [`case ${id}`, other.key] as const),
      ...(other.acceptance?.outcomes ?? []).flatMap(outcome => [[`outcome ${outcome.id}`, other.key] as const, [`case ${outcome.case.id}`, other.key] as const])]));
    const taken = data.outcomes.flatMap(outcome => [`outcome ${outcome.id}`, `case ${outcome.case.id}`]).filter(name => owned.has(name));
    demand(!taken.length, `${taken.map(name => `${name} belongs to ${owned.get(name)}`).join('; ')}; a draft names its own outcomes and cases`, 422);
    next.acceptance = { author: actor.id, pr: data.pr, branch: data.branch, head: data.head, draftedAt: at, outcomes: data.outcomes };
    next.approval = null; next.stage = 'awaiting-approval'; next.drafts = (goal.drafts ?? 0) + 1;
  } else if (command === 'approve' || command === 'refuse') {
    const data = goalCommandSchemas[command].parse(input);
    demand(goal.stage === 'awaiting-approval' && goal.acceptance, `${goal.key} is ${goal.stage}; only a draft awaiting approval is judged`);
    demand(actor.id !== goal.acceptance.author, `Self-approval refused: ${actor.id} authored the acceptance draft of ${goal.key}; an approver on a different identity judges it`, 403);
    if (command === 'approve') { next.approval = { by: actor.id, at, reason: data.reason, head: goal.acceptance.head }; next.stage = 'accepted'; }
    else { next.refusal = { by: actor.id, at, reason: data.reason, pr: goal.acceptance.pr, branch: goal.acceptance.branch }; next.acceptance = null; next.stage = 'acceptance-drafting'; }
  } else if (command === 'closed') {
    // A draft's pull request closed unmerged: the goal goes back to drafting with the reason recorded, so it is never left accepted.
    const data = goalCommandSchemas.closed.parse(input);
    demand((goal.stage === 'awaiting-approval' || goal.stage === 'accepted') && goal.acceptance, `${goal.key} is ${goal.stage}; only an open acceptance draft is recorded closed`);
    demand(data.pr === goal.acceptance.pr, `${goal.key}'s acceptance pull request is #${goal.acceptance.pr}, not #${data.pr}`, 422);
    next.refusal = { by: actor.id, at, reason: data.reason, pr: data.pr, branch: goal.acceptance.branch };
    next.acceptance = null; next.approval = null; next.stage = 'acceptance-drafting';
  } else if (command === 'merged') {
    const data = goalCommandSchemas.merged.parse(input);
    demand(goal.stage === 'accepted' && goal.acceptance && goal.approval, `${goal.key} is ${goal.stage}; only an approved acceptance draft is recorded merged`);
    demand(data.pr === goal.acceptance.pr, `${goal.key}'s acceptance pull request is #${goal.acceptance.pr}, not #${data.pr}`, 422);
    next.merged = { at, by: actor.id, pr: data.pr, mergeSha: data.mergeSha };
    next.protected = { cases: goal.acceptance.outcomes.map(outcome => outcome.case.id), outcomes: goal.acceptance.outcomes.map(outcome => outcome.id) };
    // The planner turns the merged acceptance into the items that deliver it (GY-1418).
    next.stage = 'planning'; next.plan = null; next.planApproval = null; next.planDrafts = 0; next.items = [];
  } else if (isPlanCommand(command)) {
    applyPlanCommand(goal, next, command, input, context);
  } else if (command === 'deliver') {
    const data = goalCommandSchemas.deliver.parse(input);
    demand(goal.stage === 'delivering', `${goal.key} is ${goal.stage}; only a goal being delivered is recorded delivered`);
    const unnamed = (goal.items ?? []).map(item => item.key).filter(key => !data.items.includes(key));
    demand(!unnamed.length, `${goal.key} is delivered by every item of its plan: name ${unnamed.join(', ')} too`, 422);
    // Delivery is the named implementation items' own: each must exist and have merged, never a bare assertion.
    demand(context.undelivered && !context.undelivered.length, `${goal.key} is delivered only by delivered work: ${(context.undelivered ?? data.items).join(', ')} ${(context.undelivered ?? data.items).length === 1 ? 'is' : 'are'} not delivered`, 422);
    next.stage = 'delivered';
  } else if (command === 'case-change') {
    const data = goalCommandSchemas['case-change'].parse(input);
    demand(protectingStages.includes(goal.stage), `${goal.key} protects no case yet; its acceptance pull request has not merged`);
    const unknown = data.cases.filter(id => !goal.protected.cases.includes(id));
    demand(!unknown.length, `${goal.key} does not protect ${unknown.join(', ')}; it protects ${goal.protected.cases.join(', ')}`, 422);
    demand(next.caseChanges.length < 100, `${goal.key} holds 100 case changes; no more can be requested`, 422);
    next.caseChanges.push({ id: randomUUID(), work: data.work, cases: [...new Set(data.cases)], reason: data.reason, requestedBy: actor.id, requestedAt: at, state: 'requested', judgedBy: null, judgedAt: null, judgement: null });
  } else {
    const data = goalCommandSchemas[command].parse(input);
    const change = next.caseChanges.find(entry => entry.id === data.change);
    demand(change, `${goal.key} has no case change ${data.change}`, 404);
    demand(change.state === 'requested', `Case change ${change.id} is already ${change.state}`);
    demand(actor.id !== change.requestedBy, `${actor.id} requested case change ${change.id}; an approver who is neither its requester nor an implementer of ${change.work} judges it`, 403);
    demand(!(context.implementers ?? []).includes(actor.id), `${actor.id} implemented ${change.work}; an approver who is neither the requester nor an implementer of ${change.work} judges its case change`, 403);
    Object.assign(change, { state: command === 'case-change-approve' ? 'approved' : 'refused', judgedBy: actor.id, judgedAt: at, judgement: data.reason });
  }
  next.revision = goal.revision + 1; next.updatedAt = at;
  return next;
}

/** Who acts next on a goal, and with which command; null once it is delivered. */
export function goalNext(goal: Goal, now = Date.now()): { who: string; command: string } | null {
  if (goal.stage === 'acceptance-drafting' && (goal.drafts ?? 0) >= maxDraftRounds) return { who: `master: ${maxDraftRounds} acceptance drafts were refused or closed (last: ${goal.refusal?.reason ?? 'none recorded'}); the loop drafts no more`, command: `graphyard goal draft ${goal.key} DRAFT.json` };
  if (goal.stage === 'acceptance-drafting') return { who: 'acceptance role (the master loop launches it once its operator-agent and approver identities are provisioned)', command: `graphyard goal draft ${goal.key} DRAFT.json` };
  if (goal.stage === 'awaiting-approval') return { who: `an approver other than ${goal.acceptance!.author}`, command: `graphyard goal approve ${goal.key} -- REASON (or goal refuse)` };
  if (goal.stage === 'accepted' && goal.approval && now - Date.parse(goal.approval.at) > acceptanceStuckMs)
    return { who: `master: acceptance pull request #${goal.acceptance!.pr} was approved ${goal.approval.at} and has not merged; read why on the pull request, then close it (the loop drafts again) or land it`, command: `graphyard goal closed ${goal.key} ${goal.acceptance!.pr} -- REASON` };
  if (goal.stage === 'accepted') return { who: `the loop: Graphyard publishes its gate verdicts on acceptance pull request #${goal.acceptance!.pr} and merges it at its approved head, once its required checks pass`, command: `graphyard goal land ${goal.key}` };
  const planning = planNext(goal);
  if (planning) return planning;
  if (goal.stage === 'delivering') return { who: 'master: create and deliver the implementation items, then name them once every one has merged', command: `graphyard goal deliver ${goal.key} GY-N... -- REASON` };
  return null;
}
/** A goal as `master status` lists it. */
export const goalSummary = (goal: Goal, now = Date.now()) => ({ key: goal.key, stage: goal.stage, statement: goal.statement, deployTarget: goal.deployTarget, pr: goal.acceptance?.pr ?? null,
  outcomes: goal.acceptance?.outcomes.map(outcome => outcome.id) ?? [], updatedAt: goal.updatedAt, next: goalNext(goal, now) });

/** Every protected-case refusal starts so: the observation path replaces its own violations by this prefix. */
export const protectedCasePrefix = 'Protected case: ';
/** The case id a path names when it is a case file: `e2e/cases/board.json` → `board`. */
const caseOf = (path: string) => path.startsWith(`${caseDirectory}/`) && path.endsWith('.json') && !path.slice(caseDirectory.length + 1).includes('/') ? path.slice(caseDirectory.length + 1, -5) : null;
/** Whether the candidate changes or removes what the base holds at `path` (a new file changes nothing protected). */
const touches = (file: Pick<ScopeFile, 'status' | 'baseSha' | 'sha'>) => file.status !== 'unchanged' && file.status !== 'added' && file.status !== 'copied' && file.baseSha !== null && !(file.baseSha && file.sha && file.baseSha === file.sha && file.status !== 'removed');

/**
 * Pure, at `complete` (and on every observation that re-derives it): the protected cases and
 * contract bindings the candidate modifies or deletes, each refusal naming the case, the outcome and
 * the goal. A change the item holds an approved case change for passes, unless that change's
 * approver has since implemented the item. e2e/contract.json — changed, deleted or renamed away —
 * passes only when the item's approved case changes cover every case the goal protects, since the
 * observation carries no contents to tell which binding moved.
 */
export function protectedCaseRefusals(work: Pick<Work, 'key'> & Partial<Pick<Work, 'implementers' | 'lease' | 'lastAssignment'>>, observation: Pick<Observation, 'files' | 'scopeFiles'> | null, goals: readonly Goal[]): string[] {
  if (!observation) return [];
  const guarding = goals.filter(goal => protectingStages.includes(goal.stage) && goal.protected.cases.length);
  if (!guarding.length) return [];
  const files: Pick<ScopeFile, 'path' | 'status' | 'baseSha' | 'sha' | 'previousPath'>[] = observation.scopeFiles ?? observation.files.map(path => ({ path, status: 'changed' as const, sha: null }));
  // A grant whose approver has since implemented the item is void: they would be approving their own change.
  const implementers = implementersOf(work);
  const granted = (goal: Goal, id: string) => goal.caseChanges.some(change => change.state === 'approved' && change.work === work.key && change.cases.includes(id) && !!change.judgedBy && !implementers.includes(change.judgedBy));
  const refusals: string[] = [];
  const how = (goal: Goal) => `change it only through an approved case change: graphyard goal case-change ${goal.key} ${work.key} CASE -- REASON, judged by an approver who is neither the requester nor an implementer of ${work.key}`;
  for (const file of files) {
    for (const path of [file.path, ...(file.status === 'renamed' && file.previousPath ? [file.previousPath] : [])]) {
      const id = caseOf(path);
      const moved = path !== file.path;
      if (!id || (!moved && !touches(file))) continue;
      for (const goal of guarding) if (goal.protected.cases.includes(id) && !granted(goal, id)) {
        const outcome = goal.acceptance?.outcomes.find(entry => entry.case.id === id)?.id ?? 'its outcome';
        refusals.push(`${protectedCasePrefix}${path} ${file.status === 'removed' || moved ? 'deletes' : 'modifies'} required case ${id} (outcome ${outcome} of ${goal.key}); ${how(goal)}`);
      }
    }
    const renamedAway = file.status === 'renamed' && file.previousPath === contractFile && file.path !== contractFile;
    if ((file.path === contractFile && touches(file)) || renamedAway) for (const goal of guarding) {
      const ungranted = goal.protected.cases.filter(id => !granted(goal, id));
      if (ungranted.length) refusals.push(`${protectedCasePrefix}${contractFile} ${file.status === 'removed' || renamedAway ? 'deletes' : 'modifies'} the contract binding${goal.protected.outcomes.length === 1 ? '' : 's'} ${goal.protected.outcomes.join(', ')} of ${goal.key}, and no approved case change covers ${ungranted.join(', ')}; ${how(goal)}`);
    }
  }
  return refusals;
}

// ---- The ledger: one event per change, each carrying the whole goal ------------------------------
export const goalEventKinds = ['goal.recorded', 'goal.draft', 'goal.approve', 'goal.refuse', 'goal.closed', 'goal.merged', 'goal.deliver', 'goal.case-change', 'goal.case-change-approve', 'goal.case-change-refuse',
  'goal.plan', 'goal.plan-approve', 'goal.plan-refuse', 'goal.plan-invalid', 'goal.released'] as const;
/** A goal recorded before planning existed (GY-1418) said `planned` for an approved, unmerged acceptance draft: that stage is `accepted` now. */
export const currentGoal = (goal: Goal): Goal => goal.stage === 'planned' && !goal.merged ? { ...goal, stage: 'accepted' } : goal;
interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }
/** Every goal's record, newest first: the newest event of each. */
export async function readGoals(db: Queryable): Promise<Goal[]> {
  const rows = (await db.query(`SELECT DISTINCT ON (payload->'goal'->>'id') payload->'goal' AS goal, seq FROM events
    WHERE work_id IS NULL AND kind = ANY($1::text[]) ORDER BY payload->'goal'->>'id', seq DESC`, [goalEventKinds])).rows;
  return rows.sort((a, b) => Number(b.seq) - Number(a.seq)).map(row => currentGoal(row.goal as Goal));
}
/** The goals whose cases are protected: read by the submit path under the coordination lock. */
export const readProtectingGoals = async (db: Queryable) => (await readGoals(db)).filter(goal => protectingStages.includes(goal.stage));
/** One goal's history: every event, oldest first, with who made each change. */
export async function goalHistory(db: Queryable, id: string) {
  const rows = (await db.query(`SELECT seq, actor, kind, created_at, payload->'goal'->>'stage' AS stage, payload->'change' AS change FROM events
    WHERE work_id IS NULL AND kind = ANY($1::text[]) AND payload->'goal'->>'id' = $2 ORDER BY seq`, [goalEventKinds, id])).rows;
  return rows.map(row => ({ seq: String(row.seq), at: new Date(row.created_at).toISOString(), actor: row.actor, kind: row.kind, stage: row.stage, change: row.change ?? null }));
}
/** Append a goal's new record. */
export async function appendGoal(db: Queryable, actor: string, command: GoalCommand, goal: Goal, change: unknown) {
  await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor, command === 'record' ? 'goal.recorded' : `goal.${command}`, JSON.stringify({ goal, change })]);
}
