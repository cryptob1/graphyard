import { z } from 'zod';
import { demand, stages } from '../../model.js';
import { interventionKinds, interventionRecordSchema, interventionWindows, judgementSchema, type InterventionWindow } from '../../model/interventions.js';
import { judgementToWork, openPatternItems, readInterventionReport, recordIntervention, recordJudgement } from '../../interventions.js';
import { defineRoutes, parseJson } from '../routes.js';

const reportQuerySchema = z.object({
  window: z.coerce.number().int().refine(value => (interventionWindows as readonly number[]).includes(value), 'Window must be 7, 30, or 90 days').default(30),
  kind: z.enum(interventionKinds).nullish(), stage: z.enum(stages).nullish(), work: z.string().max(200).nullish(),
}).strict();
const workFromJudgementSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  criteria: z.array(z.object({ id: z.string().min(1).max(20), text: z.string().min(1).max(4000), proofs: z.array(z.string()).min(1).max(20) }).strict()).min(1).max(50).optional(),
  plannedFiles: z.array(z.string().min(1).max(500)).max(100).optional(),
  priority: z.number().int().min(0).max(4).optional(),
}).strict();

/**
 * Interventions as a product surface (GY-98): the report over a window, the signals a session
 * records by hand, the operator's judgement about delivered work and the item it becomes, and the
 * pattern detection the server tick runs on its own. These sit after the operator-agent guard;
 * the guard admits scoped agents to the judgement routes only (auth.ts).
 */
export const interventionRoutes = defineRoutes('interventions', [
  {
    method: 'GET', path: '/api/interventions',
    async handle({ url, actor, services }) {
      demand(actor.role !== 'operator-agent', 'Route is not available to operator agents', 403);
      const query = reportQuerySchema.parse(Object.fromEntries([...url.searchParams].filter(([, value]) => value !== '')));
      return readInterventionReport(services.engine.store, services.interventionPolicy, { days: query.window as InterventionWindow, kind: query.kind, stage: query.stage, work: query.work });
    },
  },
  {
    method: 'POST', path: '/api/interventions',
    handle: async context => recordIntervention(context.services.engine.store, context.actor, interventionRecordSchema.parse(await parseJson(context)), context.idempotencyKey()),
  },
  {
    // The detection the server runs on its own every tick, exposed so a master can run it now
    // and see what it opened. It never opens a second item for a pattern one already stands for.
    method: 'POST', path: '/api/interventions/patterns',
    async handle({ actor, services }) {
      demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
      const { opened, truncated } = await openPatternItems(services.engine, services.interventionPolicy);
      return { opened: opened.map(work => ({ id: work.id, key: work.key, title: work.title, origin: work.origin })), truncated, policy: services.interventionPolicy };
    },
  },
  {
    method: 'POST', path: '/api/judgements',
    handle: async context => recordJudgement(context.services.engine.store, context.actor, judgementSchema.parse(await parseJson(context)), context.idempotencyKey()),
  },
  {
    method: 'POST', path: /^\/api\/judgements\/([0-9a-f-]{36})\/work$/,
    handle: async (context, [id]) => judgementToWork(context.services.engine, context.actor, id, workFromJudgementSchema.parse(await parseJson(context, undefined, '{}')), context.idempotencyKey()),
  },
]);
