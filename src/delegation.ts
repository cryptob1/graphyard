import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, escalationTriggers, operatorScopeIncludes, raiseEscalation, sliceIds, type Principal, type SliceId, type Work } from './model.js';
import { save, type Store } from './store.js';
import { fileConflicts, resourceConflicts } from './coordination.js';

export interface DelegationLimits { maxLeads: number; maxEngineersPerLead: number; minReviewers: number; maxReviewers: number }
export const defaultDelegationLimits: DelegationLimits = { maxLeads: 3, maxEngineersPerLead: 2, minReviewers: 1, maxReviewers: 2 };
export const slices = [
  { id: 'product', name: 'Product' },
  { id: 'infrastructure', name: 'Infrastructure' },
  { id: 'docs-experience', name: 'Docs/experience' },
] as const;
// Coordination actions a lead may take. Anything absent is refused and recorded.
export const leadRulingActions = ['approve-plan', 'reject-plan', 'classify-failure', 'request-rerun', 'send-back', 'escalate'] as const;
export const leadPermittedActions = ['coordinate', ...leadRulingActions] as const;
export function leadMay(action: string) { return (leadPermittedActions as readonly string[]).includes(action); }
const rulingSchema = z.object({
  action: z.enum(leadRulingActions),
  ruleId: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(2000),
  trigger: z.enum(escalationTriggers).optional(),
}).strict().superRefine((data, ctx) => {
  if (data.action === 'escalate' && !data.trigger) ctx.addIssue({ code: 'custom', message: 'An escalation must name its trigger' });
  if (data.action !== 'escalate' && data.trigger) ctx.addIssue({ code: 'custom', message: 'Only escalations carry a trigger' });
});
export const routineIntakeOrigins = ['explicit-feedback', 'defect', 'unfinished-dependency', 'verification-finding'] as const;
export const humanOnlyIntakeOrigins = ['goal', 'priority', 'policy-change', 'requirement-change', 'evidence-definition-change', 'waiver', 'exceptional-promotion', 'destructive-promotion', 'ambiguity-resolution'] as const;
const intakeSchema = z.object({ origin: z.enum([...routineIntakeOrigins, ...humanOnlyIntakeOrigins]), title: z.string().trim().min(1).max(200), description: z.string().trim().max(20000).default(''), sourceWorkId: z.string().uuid().optional() }).strict();
export type SessionKind = 'human' | 'ai' | 'undeclared';
// Undeclared is reported as undeclared: an unlabelled session must never be
// displayed or treated as human.
export function sessionKind(principal?: { sessionKind?: 'human' | 'ai' }): SessionKind { return principal?.sessionKind ?? 'undeclared'; }
export function classifyIntake(origin: string) { return routineIntakeOrigins.includes(origin as any) ? 'routine' : humanOnlyIntakeOrigins.includes(origin as any) ? 'human-only' : 'unknown'; }

// The same receipt/fingerprint contract the engine and validation routes use: a
// lost response must never duplicate an immutable intake item or lead ruling.
async function once<T>(store: Store, actor: Principal, key: string, fingerprintInput: unknown, run: (db: pg.PoolClient, now: Date) => Promise<T>): Promise<T> {
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const fingerprint = createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex');
  return store.transaction(async (db, now) => {
    const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
    if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result as T; }
    const result = await run(db, now);
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
    return result;
  });
}

export function delegationLimits(env: NodeJS.ProcessEnv = process.env): DelegationLimits {
  const integer = (name: string, fallback: number) => { const value = Number(env[name] ?? fallback); demand(Number.isInteger(value) && value > 0, `${name} must be a positive integer`, 500); return value; };
  const result = { maxLeads: integer('GRAPHYARD_MAX_SLICE_LEADS', 3), maxEngineersPerLead: integer('GRAPHYARD_MAX_ENGINEERS_PER_LEAD', 2), minReviewers: integer('GRAPHYARD_MIN_REVIEWERS', 1), maxReviewers: integer('GRAPHYARD_MAX_REVIEWERS', 2) };
  demand(result.minReviewers <= result.maxReviewers, 'Reviewer minimum cannot exceed maximum', 500);
  return result;
}

export function validateDelegationPrincipals(principals: (Principal & { token?: string })[], limits = defaultDelegationLimits) {
  const leads = principals.filter(p => p.role === 'slice-lead');
  demand(leads.length <= limits.maxLeads, `Slice lead limit exceeded: ${leads.length}/${limits.maxLeads}`);
  for (const lead of leads) demand(lead.sessionKind === 'ai' && lead.slice && sliceIds.includes(lead.slice), 'Slice leads must be AI sessions assigned to a formal slice');
  demand(new Set(leads.map(p => p.id)).size === leads.length, 'Slice leads require distinct principals and credentials');
  const leadTokens = leads.map(p => p.token).filter((token): token is string => !!token);
  demand(new Set(leadTokens).size === leadTokens.length, 'Slice leads require distinct principals and credentials');
  for (const slice of sliceIds) demand(leads.filter(p => p.slice === slice).length <= 1, `Slice ${slice} already has a lead`);
  const reviewers = principals.filter(p => p.role === 'producer');
  demand(reviewers.length <= limits.maxReviewers, `Independent review/proof agent limit exceeded: ${reviewers.length}/${limits.maxReviewers}`);
  // Review/proof agents are shared and independent: never a lead identity, never
  // bound to one slice. Co-located credentials are not a separation of duties.
  const leadIds = new Set(leads.map(p => p.id));
  for (const reviewer of reviewers) {
    demand(!leadIds.has(reviewer.id), `Producer ${reviewer.id} cannot also hold slice-lead authority`);
    demand(!reviewer.slice, `Producer ${reviewer.id} must remain independent of every slice`);
  }
  // Bootstrap (no leads) keeps working without any producer configured.
  if (leads.length) demand(reviewers.length >= limits.minReviewers, `Slice delegation requires at least ${limits.minReviewers} independent review/proof agent(s): ${reviewers.length} configured`);
}

// Every identity that has held an assignment on this item, including superseded
// epochs and legacy documents that predate the append-only list.
export function implementerIdentities(work: Work): string[] {
  return [...new Set([
    ...(work.implementers ?? []),
    ...work.workspaces.map(workspace => workspace.owner),
    ...(work.lastAssignment ? [work.lastAssignment.owner] : []),
    ...(work.lease ? [work.lease.owner] : []),
  ])];
}

// AC-4 independence, decided from the work item's own history and the configured
// roster, so trust cannot be minted by an implementer or by lead authority.
export function producerIndependenceRefusal(actor: Principal, work: Work, roster: Principal[] = []): string | null {
  const identities = [actor, ...roster.filter(p => p.id === actor.id)];
  if (implementerIdentities(work).includes(actor.id))
    return `Evidence for ${work.key} requires a producer identity distinct from its implementers; ${actor.id} has held an assignment on it`;
  if (identities.some(p => p.role === 'slice-lead'))
    return `Slice leads coordinate and never produce evidence; ${actor.id} holds slice-lead authority`;
  if (work.slice && identities.some(p => p.slice === work.slice))
    return `Evidence for slice ${work.slice} requires a producer independent of that slice; ${actor.id} is bound to it`;
  return null;
}

// Capacity is measured in engineers. Two items held by one worker are two worker
// rows but a single occupied seat under the slice lead.
export function activeEngineers(work: Work[], slice: SliceId, now: number): Set<string> {
  return new Set(work.filter(w => w.slice === slice && w.lease && Date.parse(w.lease.expiresAt) > now).map(w => w.lease!.owner));
}

// Every identity the dashboard renders carries its own declared session kind, so
// the human/AI distinction is read from data instead of assumed from a role.
export function delegationSnapshot(principals: Principal[], work: Work[], now: number, limits = defaultDelegationLimits) {
  const leads = principals.filter(p => p.role === 'slice-lead');
  const identify = (id: string) => {
    const principal = principals.find(p => p.id === id);
    return { id, displayName: principal?.displayName ?? null, role: principal?.role ?? null, sessionKind: sessionKind(principal) };
  };
  return { limits, slices: slices.map(slice => {
    const lead = leads.find(p => p.slice === slice.id);
    const items = work.filter(w => w.slice === slice.id);
    const workers = items.filter(w => w.lease && Date.parse(w.lease.expiresAt) > now);
    return { ...slice, lead: lead ? identify(lead.id) : null,
      engineers: [...activeEngineers(items, slice.id, now)].map(identify),
      workers: workers.map(w => ({ key: w.key, ...identify(w.lease!.owner) })),
      bottlenecks: items.filter(w => w.blocker || w.escalation || w.gates.some(g => !g.passed))
        .map(w => ({ key: w.key, reason: w.blocker ?? w.escalation?.reason ?? w.gates.find(g => !g.passed)?.reasons[0] ?? 'Awaiting a gate decision' })) };
  }), reviewers: principals.filter(p => p.role === 'producer').map(p => identify(p.id)) };
}

export function enforceLeadCapacity(actor: Principal, work: Work[], now: number, limits: DelegationLimits) {
  demand(actor.role === 'slice-lead' && actor.slice, 'Slice lead permission required', 403);
  const engineers = activeEngineers(work, actor.slice!, now);
  demand(engineers.size < limits.maxEngineersPerLead, `Engineer limit for ${actor.slice} exceeded: ${engineers.size}/${limits.maxEngineersPerLead}`);
}

export async function recordLeadRuling(store: Store, actor: Principal, id: string, input: unknown, key: string) {
  demand(actor.role === 'slice-lead' && actor.slice, 'Slice lead permission required', 403);
  const data = rulingSchema.parse(input);
  return once(store, actor, key, { command: 'lead.ruling', id, data }, async (db, now) => {
    const work = (await db.query("SELECT document FROM work_items WHERE id::text=$1 OR document->>'key'=$1", [id])).rows[0]?.document as Work | undefined;
    demand(work, 'Work item not found', 404); demand(work.slice === actor.slice, 'Slice leads may coordinate only their own slice', 403);
    // Delivery is an immutable snapshot. A ruling must never bump a delivered
    // item's revision or attach new escalation state to it; use a follow-up task.
    demand(work.stage !== 'done', 'Delivered work is immutable; rulings cannot rewrite it, so create a follow-up task', 409);
    const ruling = { id: randomUUID(), workId: work.id, leadId: actor.id, slice: actor.slice, ...data, at: now.toISOString() };
    await db.query('INSERT INTO lead_rulings(id,work_id,lead_id,slice_id,action,rule_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)', [ruling.id, work.id, actor.id, actor.slice, data.action, data.ruleId, data.reason]);
    // Append-only: a later ruling never overwrites or clears a standing escalation,
    // and raising one refuses the merge gate in this same transaction.
    if (data.action === 'escalate') raiseEscalation(work, { trigger: data.trigger!, reason: data.reason, at: ruling.at, actor: actor.id });
    await save(db, work, actor.id, `lead.${data.action}`, now, { ruleId: data.ruleId, reason: data.reason, ...(data.trigger ? { trigger: data.trigger } : {}) });
    return { ruling, work };
  });
}

// Refusals are recorded outside the mutation transaction, which rolls back.
// `scoped` false writes an unscoped ledger entry: the attempt is still history,
// but it never appends to a work item the actor has no authority over.
async function recordRefusal(store: Store, actor: Principal, id: string, kind: string, payload: (work: Work) => Record<string, unknown>, scoped: (work: Work) => boolean = () => true) {
  await store.transaction(async (db, now) => {
    const work = (await db.query("SELECT document FROM work_items WHERE id::text=$1 OR document->>'key'=$1", [id])).rows[0]?.document as Work | undefined;
    demand(work, 'Work item not found', 404);
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [scoped(work) ? work.id : null, actor.id, kind, JSON.stringify({ ...payload(work), at: now.toISOString() })]);
  });
}

export async function recordLeadViolation(store: Store, actor: Principal, id: string, attemptedAction: string) {
  demand(actor.role === 'slice-lead', 'Slice lead permission required', 403);
  // The same slice check rulings use. A forbidden request aimed at another slice
  // is recorded against no ledger, with both the target and the source named, so
  // a lead cannot write into a slice it does not coordinate.
  await recordRefusal(store, actor, id, 'lead.action.refused', work => ({
    attemptedAction, slice: actor.slice ?? null, targetKey: work.key, targetSlice: work.slice ?? null,
    reason: work.slice === actor.slice ? 'Action exceeds slice-lead authority' : 'Action exceeds slice-lead authority and targets another slice',
  }), work => work.slice === actor.slice);
}

export async function recordEvidenceRefusal(store: Store, actor: Principal, id: string, proof: unknown, reason: string) {
  await recordRefusal(store, actor, id, 'evidence.producer.refused', () => ({ proof: typeof proof === 'string' ? proof : null, producer: actor.id, role: actor.role, reason }));
}

export async function recordIntake(store: Store, actor: Principal, input: unknown, key: string) {
  const data = intakeSchema.parse(input);
  demand(actor.role === 'admin' || actor.role === 'operator-agent' || actor.role === 'slice-lead', 'Intake permission required', 403);
  if (actor.role !== 'admin') demand(classifyIntake(data.origin) === 'routine', `${data.origin} intake is human-only`, 403);
  return once(store, actor, key, { command: 'intake', data }, async (db, now) => {
    if (data.sourceWorkId) {
      // Existence is not authority: the cited source must be inside the actor's
      // own scope, or its history would gain an entry from outside that scope.
      const source = (await db.query('SELECT document FROM work_items WHERE id=$1', [data.sourceWorkId])).rows[0]?.document as Work | undefined;
      demand(source, 'Source work item not found', 404);
      demand(operatorScopeIncludes(actor, source), 'Source work item is outside this operator-agent scope', 403);
      demand(actor.role !== 'slice-lead' || source.slice === actor.slice, 'Slice leads may cite only their own slice', 403);
    }
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
