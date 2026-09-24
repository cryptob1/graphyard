import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { demand, stages } from '../../model.js';
import { computeFlow, flowDrilldown, flowExport, flowWindows, productionEnvironmentFromEnv, projectFlow, readFlow, type FlowWindow } from '../../flow-analytics.js';
import { Sent, defineRoutes, parseJson } from '../routes.js';

/** Roles that may see exact pull-request, commit and evidence identities behind an aggregate. */
const auditRoles = ['admin', 'coordinator', 'producer'];
// Read once at boot so every analytics response of this process names the same environment.
const productionEnvironment = productionEnvironmentFromEnv();

const deploymentSchema = z.object({
  provider: z.string().trim().min(1).max(100), externalId: z.string().trim().min(1).max(200),
  environment: z.string().trim().min(1).max(100),
  // Preserve the provider's exact artifact identity even when it is a release commit.
  // Abbreviated identities cannot be verified or joined safely.
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  // Independently verified merge commits contained in the deployed artifact. The
  // artifact SHA need not equal any PR merge SHA (for example, a release commit).
  containedMergeShas: z.array(z.string().regex(/^[a-f0-9]{40}$/)).min(1).max(200),
  state: z.enum(['succeeded', 'failed', 'rolled_back']),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime().optional(),
  details: z.record(z.string().max(100), z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
}).strict();
const flowQuerySchema = z.object({
  window: z.coerce.number().int().refine(value => (flowWindows as readonly number[]).includes(value), 'Window must be 7, 30, or 90 days').default(30),
  type: z.enum(['feature', 'bug', 'chore']).nullish(), stage: z.enum(stages).nullish(),
  slice: z.string().max(200).nullish(), asOf: z.string().datetime().nullish(),
  metric: z.string().max(60).nullish(), key: z.string().max(200).nullish(), format: z.enum(['json', 'csv']).default('json'),
}).strict();
function flowQuery(url: URL) {
  const raw = Object.fromEntries([...url.searchParams].filter(([, value]) => value !== ''));
  const parsed = flowQuerySchema.parse(raw);
  return { ...parsed, days: parsed.window as FlowWindow, productionEnvironment };
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * The bounded flow report, its drill-downs and exports, computed from the durable flow_facts
 * projection after a bounded catch-up. These sit after the operator-agent guard, so a
 * scoped operator agent never reaches them.
 */
export const flowAnalyticsRoutes = defineRoutes('flow-analytics', [
  {
    method: 'GET', path: /^\/api\/analytics\/flow(?:\/(drilldown|export))?$/,
    async handle({ url, actor, res, services: { engine, production } }, [part]) {
      // The watch's report as this request reads it, so the flow holds merges at Deploy exactly
      // where the board (grouped by the same report on /api/status) does.
      const query = { ...flowQuery(url), production: production?.status() ?? null };
      // Bounded catch-up keeps the read current without blocking on a full backfill.
      await projectFlow(engine.store, { batches: 3 });
      const dataset = await readFlow(engine.store, query);
      const report = computeFlow(dataset, query);
      if (!part) return report;
      const drilldown = flowDrilldown(dataset, report, { metric: query.metric ?? 'bottleneck', key: query.key ?? null, authorized: auditRoles.includes(actor.role) });
      if (part === 'drilldown') return drilldown;
      const payload = flowExport(report, drilldown, query.format);
      res.writeHead(200, { 'Content-Type': query.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json', 'Content-Disposition': `attachment; filename="graphyard-flow-${drilldown.metric}-${query.days}d.${query.format}"` });
      res.end(payload);
      return Sent;
    },
  },
  {
    method: 'POST', path: '/api/deployments',
    async handle(context) {
      const { actor, services: { engine } } = context;
      demand(actor.role === 'producer' || actor.role === 'admin', 'A deployment-provider or operator credential is required to record a deployment observation', 403);
      const data = deploymentSchema.parse(await parseJson(context));
      demand(!data.finishedAt || Date.parse(data.finishedAt) >= Date.parse(data.startedAt), 'A deployment cannot finish before it starts', 400);
      const client = await engine.store.pool.connect();
      try {
        await client.query('BEGIN');
        const id = randomUUID();
        const inserted = await client.query(
          `INSERT INTO deployment_observations(id,provider,external_id,environment,sha,state,started_at,finished_at,producer,details)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (provider,external_id,state) DO NOTHING RETURNING id`,
          [id, data.provider, data.externalId, data.environment, data.sha, data.state, data.startedAt, data.finishedAt ?? null, actor.id, JSON.stringify(data.details ?? {})]);
        const existingObservation = inserted.rowCount === 0 ? (await client.query(
          'SELECT * FROM deployment_observations WHERE provider=$1 AND external_id=$2 AND state=$3', [data.provider, data.externalId, data.state])).rows[0] : null;
        const deploymentId = inserted.rows[0]?.id ?? existingObservation.id;
        const normalized = [...new Set(data.containedMergeShas)].sort();
        if (inserted.rowCount === 1) {
          for (const mergeSha of normalized) await client.query('INSERT INTO deployment_merge_observations(deployment_id,merge_sha) VALUES($1,$2)', [deploymentId, mergeSha]);
        } else {
          const existing = (await client.query('SELECT merge_sha FROM deployment_merge_observations WHERE deployment_id=$1 ORDER BY merge_sha', [deploymentId])).rows.map(row => row.merge_sha);
          const sameObservation = existingObservation.environment === data.environment && existingObservation.sha === data.sha
            && new Date(existingObservation.started_at).toISOString() === new Date(data.startedAt).toISOString()
            && (existingObservation.finished_at ? new Date(existingObservation.finished_at).toISOString() : null) === (data.finishedAt ? new Date(data.finishedAt).toISOString() : null)
            && canonicalJson(existingObservation.details ?? {}) === canonicalJson(data.details ?? {});
          demand(sameObservation && JSON.stringify(existing) === JSON.stringify(normalized), 'A duplicate deployment observation must exactly replay every immutable field', 409);
        }
        await client.query('COMMIT');
        return { recorded: inserted.rowCount === 1, id: deploymentId, duplicate: inserted.rowCount === 0 };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
  },
  {
    method: 'GET', path: '/api/deployments',
    async handle({ actor, services: { engine } }) {
      demand(auditRoles.includes(actor.role), 'An audit role is required to read deployment identifiers', 403);
      const rows = (await engine.store.pool.query(`SELECT d.provider,d.external_id,d.environment,d.sha,d.state,d.started_at,d.finished_at,d.recorded_at,
        COALESCE(array_agg(dm.merge_sha ORDER BY dm.merge_sha) FILTER (WHERE dm.merge_sha IS NOT NULL), '{}') AS contained_merge_shas
        FROM deployment_observations d LEFT JOIN deployment_merge_observations dm ON dm.deployment_id=d.id
        GROUP BY d.id ORDER BY d.started_at DESC,d.id DESC LIMIT 200`)).rows;
      return rows.map(row => ({ provider: row.provider, externalId: row.external_id, environment: row.environment, sha: row.sha, containedMergeShas: row.contained_merge_shas, state: row.state, startedAt: row.started_at, finishedAt: row.finished_at, recordedAt: row.recorded_at }));
    },
  },
]);
