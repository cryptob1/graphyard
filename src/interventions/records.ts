// Concern: what sessions and the operator record by hand — an intervention, a judgement, and the work item a judgement becomes.
import { randomUUID } from 'node:crypto';
import type { Engine } from '../engine.js';
import { demand, type Principal } from '../model.js';
import { judgementVerdictLabel, type Intervention, type InterventionRecordInput, type Judgement, type JudgementInput } from '../model/interventions.js';
import type { Store } from '../store.js';
import { workIdByRef } from '../store/locked-read.js';
import { ms } from './fold.js';

/** The signal a session records for an intervention it performed by hand. */
export async function recordIntervention(store: Store, actor: Principal, input: InterventionRecordInput, key: string) {
  demand(['coordinator', 'admin', 'operator-agent'].includes(actor.role), 'Coordinator or operator permission required', 403);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  return store.transaction(async (db, now) => {
    const receipt = (await db.query('SELECT result FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
    if (receipt) return receipt.result as Intervention;
    const work = input.work ? (await db.query(`SELECT id, document->>'key' AS key, document->>'title' AS title, document->>'stage' AS stage FROM work_items WHERE id = ${workIdByRef('$1')}`, [input.work])).rows[0] : null;
    demand(!input.work || work, 'Work item not found', 404);
    const at = now.toISOString(), since = input.since ? new Date(input.since).toISOString() : at;
    demand(Date.parse(since) <= now.getTime(), 'since must not lie in the future');
    const recorded = { id: randomUUID(), kind: input.kind, work: work ? { id: work.id, key: work.key, title: work.title } : null, stage: input.stage ?? work?.stage ?? null, blocked: input.blocked, ...(input.trigger ? { trigger: input.trigger } : {}), since, at, resolution: input.resolution, recordedBy: actor.id };
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work?.id ?? null, actor.id, 'intervention.recorded', JSON.stringify(recorded)]);
    const result: Intervention = { id: recorded.id, kind: recorded.kind, source: 'recorded', work: recorded.work, stage: recorded.stage, blocked: recorded.blocked, ...(input.trigger ? { trigger: input.trigger } : {}), requestedAt: since, resolvedAt: at, waitedMs: ms(since, at), resolvedBy: actor.id, resolution: input.resolution, sources: [] };
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, 'intervention', JSON.stringify(result)]);
    return result;
  });
}

/** The operator's judgement about delivered work, recorded against the item or the page it concerns (AC-4). */
export async function recordJudgement(store: Store, actor: Principal, input: JudgementInput, key: string) {
  demand(['admin', 'coordinator', 'operator-agent'].includes(actor.role), 'Operator permission required', 403);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  return store.transaction(async (db, now) => {
    const receipt = (await db.query('SELECT result FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
    if (receipt) return receipt.result as Judgement;
    const work = input.work ? (await db.query(`SELECT id, document->>'key' AS key, document->>'title' AS title FROM work_items WHERE id = ${workIdByRef('$1')}`, [input.work])).rows[0] : null;
    demand(!input.work || work, 'Work item not found', 404);
    const recorded = { id: randomUUID(), verdict: input.verdict, text: input.text, work: work ? { id: work.id, key: work.key, title: work.title } : null, page: input.page ?? null, by: actor.id, at: now.toISOString() };
    const inserted = await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4) RETURNING seq', [work?.id ?? null, actor.id, 'judgement.recorded', JSON.stringify(recorded)]);
    const result: Judgement = { ...recorded, item: null, seq: Number(inserted.rows[0].seq) };
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, 'judgement', JSON.stringify(result)]);
    return result;
  });
}

/**
 * Turn a recorded judgement into a work item: the same standing as a failed gate, as an item
 * the loop dispatches. The judgement's own words become the description; the caller may name
 * the criteria and planned files, and otherwise the item asks for the judgement to be addressed
 * and reviewed by hand. One item per judgement: a second call returns the first.
 */
export async function judgementToWork(engine: Engine, actor: Principal, judgementId: string, input: { title?: string; criteria?: { id: string; text: string; proofs: string[] }[]; plannedFiles?: string[]; priority?: number }, key: string) {
  demand(actor.role === 'admin' || actor.role === 'operator-agent', 'Operator permission required', 403);
  const row = (await engine.store.pool.query("SELECT seq, actor, payload FROM events WHERE kind='judgement.recorded' AND payload->>'id'=$1", [judgementId])).rows[0];
  demand(row, 'Judgement not found', 404);
  const judgement = row.payload as Omit<Judgement, 'item' | 'seq'>;
  // The summary keeps `origin` (GY-1376): find the item without reading every document, then answer with its own.
  const existing = (await engine.store.fleet()).find(item => item.origin?.judgement?.id === judgementId);
  if (existing) return (await engine.store.workItem(existing.id)) ?? existing;
  const subject = judgement.work ? `${judgement.work.key} (${judgement.work.title})` : judgement.page!;
  const verdict = judgementVerdictLabel[judgement.verdict];
  return engine.execute(actor, 'create', null, {
    title: (input.title ?? `${subject} is ${verdict}: ${judgement.text}`).slice(0, 200),
    description: `Operator judgement recorded by ${judgement.by} at ${judgement.at} about ${subject}: ${verdict}.\n\n${judgement.text}\n\nThis item carries the judgement into the backlog with the same standing as a failed gate; it was not typed into a chat.`,
    type: 'bug', priority: input.priority ?? 1, plannedFiles: input.plannedFiles ?? [],
    criteria: input.criteria ?? [{ id: 'AC-1', text: `The judgement about ${judgement.work?.key ?? judgement.page} (${verdict}) is addressed: ${judgement.text}`, proofs: [`manual:judgement-${judgementId.slice(0, 8)}-review`] }],
    origin: { judgement: { id: judgement.id, verdict: judgement.verdict, work: judgement.work?.key ?? null, page: judgement.page ?? null, by: judgement.by, at: judgement.at } },
    reason: `Operator judgement ${judgementId}: ${subject} is ${verdict}`,
  }, key);
}
