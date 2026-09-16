import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { demand, sliceIds, type Principal, type SliceId, type Work } from './model.js';
import { save, type Store } from './store.js';
import { fileConflicts, resourceConflicts } from './coordination.js';

export interface DelegationLimits { maxLeads: number; maxEngineersPerLead: number; minReviewers: number; maxReviewers: number }
export const defaultDelegationLimits: DelegationLimits = { maxLeads: 3, maxEngineersPerLead: 2, minReviewers: 1, maxReviewers: 2 };
export const slices = [
  { id: 'product', name: 'Product' },
  { id: 'infrastructure', name: 'Infrastructure' },
  { id: 'docs-experience', name: 'Docs/experience' },
] as const;
const rulingSchema = z.object({
  action: z.enum(['approve-plan', 'reject-plan', 'classify-failure', 'request-rerun', 'send-back', 'escalate']),
  ruleId: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(2000),
}).strict();
export const routineIntakeOrigins = ['explicit-feedback', 'defect', 'unfinished-dependency', 'verification-finding'] as const;
export const humanOnlyIntakeOrigins = ['goal', 'priority', 'policy-change', 'requirement-change', 'evidence-definition-change', 'waiver', 'exceptional-promotion', 'destructive-promotion', 'ambiguity-resolution'] as const;
const intakeSchema = z.object({ origin: z.enum([...routineIntakeOrigins, ...humanOnlyIntakeOrigins]), title: z.string().trim().min(1).max(200), description: z.string().trim().max(20000).default(''), sourceWorkId: z.string().uuid().optional() }).strict();
export function classifyIntake(origin: string) { return routineIntakeOrigins.includes(origin as any) ? 'routine' : humanOnlyIntakeOrigins.includes(origin as any) ? 'human-only' : 'unknown'; }

export function delegationLimits(env: NodeJS.ProcessEnv = process.env): DelegationLimits {
  const integer = (name: string, fallback: number) => { const value = Number(env[name] ?? fallback); demand(Number.isInteger(value) && value > 0, `${name} must be a positive integer`, 500); return value; };
  const result = { maxLeads: integer('GRAPHYARD_MAX_SLICE_LEADS', 3), maxEngineersPerLead: integer('GRAPHYARD_MAX_ENGINEERS_PER_LEAD', 2), minReviewers: integer('GRAPHYARD_MIN_REVIEWERS', 1), maxReviewers: integer('GRAPHYARD_MAX_REVIEWERS', 2) };
  demand(result.minReviewers <= result.maxReviewers, 'Reviewer minimum cannot exceed maximum', 500);
  return result;
}

export function validateDelegationPrincipals(principals: Principal[], limits = defaultDelegationLimits) {
  const leads = principals.filter(p => p.role === 'slice-lead');
  demand(leads.length <= limits.maxLeads, `Slice lead limit exceeded: ${leads.length}/${limits.maxLeads}`);
  for (const lead of leads) demand(lead.sessionKind === 'ai' && lead.slice && sliceIds.includes(lead.slice), 'Slice leads must be AI sessions assigned to a formal slice');
  demand(new Set(leads.map(p => p.id)).size === leads.length, 'Slice leads require distinct principals and credentials');
  for (const slice of sliceIds) demand(leads.filter(p => p.slice === slice).length <= 1, `Slice ${slice} already has a lead`);
  const reviewers = principals.filter(p => p.role === 'producer');
  demand(reviewers.length <= limits.maxReviewers, `Independent review/proof agent limit exceeded: ${reviewers.length}/${limits.maxReviewers}`);
}

export function delegationSnapshot(principals: Principal[], work: Work[], now: number, limits = defaultDelegationLimits) {
  const leads = principals.filter(p => p.role === 'slice-lead');
  return { limits, slices: slices.map(slice => {
    const lead = leads.find(p => p.slice === slice.id);
    const items = work.filter(w => w.slice === slice.id);
    const workers = items.filter(w => w.lease && Date.parse(w.lease.expiresAt) > now);
    return { ...slice, lead: lead ? { id: lead.id, displayName: lead.displayName, sessionKind: lead.sessionKind } : null,
      workers: workers.map(w => ({ key: w.key, principal: w.lease!.owner })), bottlenecks: items.filter(w => w.blocker || w.escalation || w.gates.some(g => !g.passed)).map(w => w.key) };
  }), reviewers: principals.filter(p => p.role === 'producer').map(p => ({ id: p.id, displayName: p.displayName, sessionKind: p.sessionKind ?? 'ai' })) };
}

export function enforceLeadCapacity(actor: Principal, work: Work[], now: number, limits: DelegationLimits) {
  demand(actor.role === 'slice-lead' && actor.slice, 'Slice lead permission required', 403);
  const active = work.filter(w => w.slice === actor.slice && w.lease && Date.parse(w.lease.expiresAt) > now);
  demand(active.length < limits.maxEngineersPerLead, `Engineer limit for ${actor.slice} exceeded: ${active.length}/${limits.maxEngineersPerLead}`);
}

export async function recordLeadRuling(store: Store, actor: Principal, id: string, input: unknown) {
  demand(actor.role === 'slice-lead' && actor.slice, 'Slice lead permission required', 403);
  const data = rulingSchema.parse(input);
  return store.transaction(async (db, now) => {
    const work = (await db.query("SELECT document FROM work_items WHERE id::text=$1 OR document->>'key'=$1", [id])).rows[0]?.document as Work | undefined;
    demand(work, 'Work item not found', 404); demand(work.slice === actor.slice, 'Slice leads may coordinate only their own slice', 403);
    const ruling = { id: randomUUID(), workId: work.id, leadId: actor.id, slice: actor.slice, ...data, at: now.toISOString() };
    await db.query('INSERT INTO lead_rulings(id,work_id,lead_id,slice_id,action,rule_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)', [ruling.id, work.id, actor.id, actor.slice, data.action, data.ruleId, data.reason]);
    if (data.action === 'escalate') work.escalation = { trigger: 'security-concern', reason: data.reason, at: ruling.at, actor: actor.id };
    await save(db, work, actor.id, `lead.${data.action}`, now, { ruleId: data.ruleId, reason: data.reason });
    return { ruling, work };
  });
}

export async function recordLeadViolation(store: Store, actor: Principal, id: string, attemptedAction: string) {
  demand(actor.role === 'slice-lead', 'Slice lead permission required', 403);
  await store.transaction(async (db, now) => {
    const work = (await db.query("SELECT document FROM work_items WHERE id::text=$1 OR document->>'key'=$1", [id])).rows[0]?.document as Work | undefined;
    demand(work, 'Work item not found', 404);
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor.id, 'lead.action.refused', JSON.stringify({ attemptedAction, slice: actor.slice ?? null, reason: 'Action exceeds slice-lead authority', at: now.toISOString() })]);
  });
}

export async function recordIntake(store: Store, actor: Principal, input: unknown) {
  const data = intakeSchema.parse(input);
  demand(actor.role === 'admin' || actor.role === 'operator-agent' || actor.role === 'slice-lead', 'Intake permission required', 403);
  if (actor.role !== 'admin') demand(classifyIntake(data.origin) === 'routine', `${data.origin} intake is human-only`, 403);
  return store.transaction(async (db, now) => {
    if (data.sourceWorkId) demand((await db.query('SELECT 1 FROM work_items WHERE id=$1', [data.sourceWorkId])).rowCount, 'Source work item not found', 404);
    const item = { id: randomUUID(), ...data, submittedBy: actor.id, state: 'backlog', createdAt: now.toISOString() };
    await db.query('INSERT INTO intake_items(id,origin,title,description,source_work_id,submitted_by) VALUES($1,$2,$3,$4,$5,$6)', [item.id, data.origin, data.title, data.description, data.sourceWorkId ?? null, actor.id]);
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [data.sourceWorkId ?? null, actor.id, 'intake.created', JSON.stringify({ intake: item })]);
    return item;
  });
}

export function mergeOrder(work: Work[], now = Date.now()) {
  const open = work.filter(w => w.stage !== 'done');
  const depth = (w: Work, seen = new Set<string>()): number => seen.has(w.id) ? 0 : Math.max(0, ...w.dependencies.map(id => { const dep = work.find(x => x.id === id); return dep ? 1 + depth(dep, new Set([...seen, w.id])) : 0; }));
  return [...open].sort((a, b) => {
    const aBlocked = a.dependencies.some(id => work.find(w => w.id === id)?.stage !== 'done'), bBlocked = b.dependencies.some(id => work.find(w => w.id === id)?.stage !== 'done');
    if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
    const conflicts = (w: Work) => fileConflicts(w, work).length + resourceConflicts(w, work, now).length;
    return depth(b) - depth(a) || conflicts(a) - conflicts(b) || a.priority - b.priority || a.key.localeCompare(b.key);
  }).map(w => w.key);
}
