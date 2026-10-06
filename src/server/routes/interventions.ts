import { z } from 'zod';
import { demand, stages } from '../../model.js';
import { plannedFilesMax } from '../../model/scope.js';
import { interventionKinds, interventionRecordSchema, interventionWindows, judgementSchema, type InterventionWindow } from '../../model/interventions.js';
import { interventionScan, judgementToWork, openPatternItems, readInterventionReport, recordIntervention, recordJudgement } from '../../interventions.js';
import { classifyIntervention, retroJudgementSchema, retroStanding, type RetroClassification } from '../../model/retro-synthesis.js';
import { judgeRetroArtefact, readRetroArtefacts, readRetroReport, synthesizeRetro } from '../../retro-synthesis.js';
import { defineRoutes, parseJson } from '../routes.js';

/** The recurrence policy the server reads at boot, beside the routes that apply it. */
export { interventionPolicyFromEnv } from '../../model/interventions.js';

const reportQuerySchema = z.object({
  window: z.coerce.number().int().refine(value => (interventionWindows as readonly number[]).includes(value), 'Window must be 7, 30, or 90 days').default(30),
  kind: z.enum(interventionKinds).nullish(), stage: z.enum(stages).nullish(), work: z.string().max(200).nullish(),
}).strict();
const workFromJudgementSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  criteria: z.array(z.object({ id: z.string().min(1).max(20), text: z.string().min(1).max(4000), proofs: z.array(z.string()).min(1).max(20) }).strict()).min(1).max(50).optional(),
  plannedFiles: z.array(z.string().min(1).max(500)).max(plannedFilesMax).optional(),
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
      const [report, artefacts] = await Promise.all([
        readInterventionReport(services.engine.store, services.interventionPolicy, { days: query.window as InterventionWindow, kind: query.kind, stage: query.stage, work: query.work }),
        readRetroArtefacts(services.engine.store.reportPool),
      ]);
      // The fault catalogue the approved retro entries extend (GY-970): a refusal or rework whose
      // cause an applied entry recognises is filed under that entry and its fault class.
      const catalogued = new Map<string, RetroClassification & { count: number }>();
      const interventions = report.interventions.map(entry => {
        const filed = classifyIntervention(entry, artefacts);
        if (!filed) return entry;
        const tally = catalogued.get(filed.entry) ?? { ...filed, count: 0 };
        tally.count++; catalogued.set(filed.entry, tally);
        return { ...entry, catalogue: filed };
      });
      // Whether the tick opens an item for a crossed pattern on its own (GY-1372).
      return { ...report, scan: interventionScan(), interventions, catalogued: [...catalogued.values()].sort((a, b) => b.count - a.count || a.entry.localeCompare(b.entry)) };
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
  // Retro synthesis (GY-970): prevention artefacts drafted from recurring refusal and rework
  // causes, judged by an independent agent identity, and the governed registries they apply to.
  {
    method: 'GET', path: '/api/retro',
    handle: ({ services }) => readRetroReport(services.engine.store),
  },
  {
    // What every session reads before it works: the applied requirements, checks and catalogue entries.
    method: 'GET', path: '/api/retro/standing',
    async handle({ services }) {
      const standing = retroStanding(await readRetroArtefacts(services.engine.store.reportPool));
      return { standing: standing.map(registry => ({ ...registry, entries: registry.entries.map(({ id, kind, target, title, proposal, check, entry, application }) => ({ id, kind, target, title, proposal, ...(check ? { check } : {}), ...(entry ? { entry } : {}), revision: application!.revision })) })) };
    },
  },
  {
    method: 'POST', path: '/api/retro/synthesize',
    async handle({ actor, services }) {
      demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
      // Drafted under the requesting identity, so the same identity cannot then approve its own drafts.
      const { drafted, truncated } = await synthesizeRetro(services.engine.store, services.interventionPolicy, { actor });
      return { drafted, truncated, policy: services.interventionPolicy };
    },
  },
  {
    method: 'POST', path: /^\/api\/retro\/([0-9a-f-]{36})\/(approve|refuse)$/,
    handle: async (context, [id, verdict]) => judgeRetroArtefact(context.services.engine.store, context.actor, context.services.repository, id, verdict as 'approve' | 'refuse', retroJudgementSchema.parse(await parseJson(context)).reason, context.services.engine.operatorAuthorizer),
  },
]);
