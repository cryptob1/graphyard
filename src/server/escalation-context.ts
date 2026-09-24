import type pg from 'pg';
import { z } from 'zod';
import { Refusal, demand, escalationTriggers, operatorScopeIncludes, standingEscalations, type Principal, type Work } from '../model.js';
import { foldDecisions } from '../model/approval.js';
import { assembleEscalationContext, canonical, contextBudget, escalationAction, intentLedgerKinds, contextLadder, routineLedgerKinds, rulesRef, type ContextInputs, type LedgerKindCount, type LedgerRow, type PrecedentDecision, type RulesSource } from '../model/escalation-context.js';
import type { Services } from './routes.js';

/**
 * `GET /api/work/:id/context?trigger=&budget=`: the assembled escalation context (GY-90). The
 * rules layer is read from the repository under review through the control plane's own App —
 * `AGENTS.md` at the base tip the item was last observed against — never from a template, so an
 * installation managing another codebase escalates against that codebase's rules. Every ledger
 * read runs in one repeatable-read snapshot so the four layers describe the same graph state; the
 * provider read stays outside it.
 */
export const rulesPath = 'AGENTS.md';
const querySchema = z.object({ trigger: z.enum(escalationTriggers).optional(), budget: z.string().regex(/^\d{1,7}$/).optional() }).strict();

async function readRules(services: Services, work: Work): Promise<RulesSource> {
  const { github } = services;
  if (!github) return { path: rulesPath, ref: rulesRef(work, ''), sha: null, text: null, unavailable: `GitHub integration is not configured, so ${rulesPath} of ${services.repository} cannot be read; the handler decides without the repository's rules and must say so` };
  const ref = rulesRef(work, github.config.base);
  try {
    const entry = await github.request(`/contents/${rulesPath}?ref=${encodeURIComponent(ref)}`);
    demand(entry && !Array.isArray(entry) && entry.type === 'file' && typeof entry.sha === 'string', `${rulesPath} at ${ref} is not a readable file`, 502);
    const text = entry.encoding === 'base64' && typeof entry.content === 'string' ? Buffer.from(entry.content.replace(/\s+/g, ''), 'base64').toString('utf8') : typeof entry.content === 'string' ? entry.content : null;
    demand(text !== null, `GitHub returned no readable content for ${rulesPath} at ${ref}`, 502);
    return { path: rulesPath, ref, sha: entry.sha, text, unavailable: null };
  } catch (error) {
    if (error instanceof Refusal && /\(404\)/.test(error.message)) return { path: rulesPath, ref, sha: null, text: null, unavailable: `${services.repository} has no ${rulesPath} at ${ref}; the repository states no operating rules there` };
    return { path: rulesPath, ref, sha: null, text: null, unavailable: `${rulesPath} at ${ref} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const detailsColumn = "CASE WHEN payload ? 'details' THEN payload->'details' ELSE payload - 'work' - 'delta' END AS details";
const row = (entry: any): LedgerRow => ({ seq: String(entry.seq), at: new Date(entry.created_at).toISOString(), actor: entry.actor, kind: entry.kind, details: entry.details ?? null });

export async function readEscalationContext(services: Services, actor: Principal, id: string, params: URLSearchParams, env: NodeJS.ProcessEnv = process.env) {
  demand(['admin', 'coordinator', 'operator-agent', 'reader'].includes(actor.role), 'Escalation context is not available to this role', 403);
  const query = querySchema.parse(Object.fromEntries(params));
  const budget = (() => { try { return contextBudget(env, query.budget); } catch (error) { throw new Refusal((error as Error).message, 400); } })();
  const graph = await services.engine.store.list();
  const work = graph.find(item => item.id === id || item.key === id);
  demand(work, 'Work item not found', 404);
  demand(actor.role !== 'operator-agent' || operatorScopeIncludes(actor, work!), 'Work item is outside this operator-agent scope', 403);
  const standing = standingEscalations(work!);
  const trigger = query.trigger ?? standing[0]?.trigger;
  demand(trigger && standing.some(entry => entry.trigger === trigger), `No standing ${query.trigger ?? ''} escalation on ${work!.key}; standing: ${standing.map(entry => entry.trigger).join(', ') || 'none'}`, 404);
  // Provider I/O first, outside the snapshot.
  const rules = await readRules(services, work!);
  const db = await services.engine.store.pool.connect();
  let inputs: ContextInputs;
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(entry => entry.document);
    const current = snapshot.find(item => item.id === work!.id)!;
    demand(standingEscalations(current).some(entry => entry.trigger === trigger), `The ${trigger} escalation on ${current.key} was resolved before the context was assembled`, 409);
    const kinds: LedgerKindCount[] = (await db.query('SELECT kind, count(*)::int AS count, min(seq) AS first_seq, max(seq) AS last_seq, min(created_at) AS first_at, max(created_at) AS last_at FROM events WHERE work_id=$1 GROUP BY kind ORDER BY kind', [current.id])).rows
      .map(entry => ({ kind: entry.kind, count: Number(entry.count), firstSeq: String(entry.first_seq), lastSeq: String(entry.last_seq), firstAt: new Date(entry.first_at).toISOString(), lastAt: new Date(entry.last_at).toISOString() }));
    const recent = (await db.query(`SELECT seq, actor, kind, created_at, ${detailsColumn} FROM events WHERE work_id=$1 AND NOT (kind=ANY($2::text[])) ORDER BY seq DESC LIMIT $3`, [current.id, [...routineLedgerKinds], contextLadder[0].recent])).rows.map(row);
    const intents = (await db.query(`SELECT seq, actor, kind, created_at, ${detailsColumn} FROM events WHERE work_id=$1 AND kind=ANY($2::text[]) ORDER BY seq ASC LIMIT 50`, [current.id, [...intentLedgerKinds]])).rows.map(row);
    // Every decision event across the graph, folded per item; only the escalation's action is precedent.
    const decisionRows = (await db.query("SELECT seq, work_id, actor, kind, payload, created_at FROM events WHERE kind LIKE 'decision.%' ORDER BY seq")).rows;
    const decisions: PrecedentDecision[] = [];
    for (const workId of new Set<string>(decisionRows.map(entry => entry.work_id))) {
      const events = decisionRows.filter(entry => entry.work_id === workId);
      const requested = new Map<string, number>(events.filter(entry => entry.kind === 'decision.requested').map(entry => [entry.payload?.id as string, Number(entry.seq)]));
      const key = snapshot.find(item => item.id === workId)?.key ?? workId;
      for (const decision of foldDecisions(workId, events.map(entry => ({ kind: entry.kind, actor: entry.actor, at: new Date(entry.created_at).toISOString(), payload: entry.payload }))))
        if (decision.action === escalationAction) decisions.push({ ...decision, workKey: key, seq: requested.get(decision.id) ?? 0 });
    }
    await db.query('COMMIT');
    inputs = { repository: services.repository, work: current, trigger, rules, graph: snapshot, history: { total: kinds.reduce((sum, entry) => sum + entry.count, 0), kinds, recent, intents }, decisions, budget };
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { db.release(); }
  // Canonical key order on the wire: the body's bytes are what the fingerprint covers.
  return canonical(assembleEscalationContext(inputs));
}

/** What a request citing no precedent is recorded with: whether any applied decision of its action (and trigger) existed to cite. */
export async function precedentAvailability(db: pg.PoolClient, action: string, input: any) {
  const trigger = action === 'resolve' && typeof input?.trigger === 'string' ? input.trigger as string : null;
  const applied = Number((await db.query(`SELECT count(*)::int AS count FROM events requested WHERE requested.kind='decision.requested' AND requested.payload->>'action'=$1 AND ($2::text IS NULL OR requested.payload->'input'->>'trigger'=$2)
    AND EXISTS (SELECT 1 FROM events applied WHERE applied.kind='decision.applied' AND applied.payload->>'id'=requested.payload->>'id')`, [action, trigger])).rows[0].count);
  const of = `${action} decision${trigger ? ` of the ${trigger} trigger` : ''}`;
  return applied ? `No precedent cited, though ${applied} applied ${of}${applied === 1 ? ' was' : 's were'} recorded` : `No precedent was available: no applied ${of} had been recorded, so this decision was taken on the facts alone`;
}
