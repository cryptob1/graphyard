import { z } from 'zod';
import { demand, operatorScopeIncludes, type Work } from '../../model.js';
import { attributionDrilldown, attributionHistory, attributionWindows, computeAttribution, readAttribution, releaseManifest } from '../../attribution.js';
import type { Release } from '../../delivery.js';
import { defineRoutes } from '../routes.js';

/** Roles that may see request, attempt, evidence and artifact identifiers behind an aggregate. */
const auditRoles = ['admin', 'coordinator', 'producer'];
const querySchema = z.object({
  window: z.coerce.number().int().refine(value => (attributionWindows as readonly number[]).includes(value), 'Window must be 7, 30, or 90 days').default(30),
  asOf: z.iso.datetime().nullish(), metric: z.string().max(60).nullish(), key: z.string().max(200).nullish(),
}).strict();
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).max(150);

/**
 * Attribution reads: the analytics section, its drill-downs, a release's manifest and one
 * work item's attribution history. Every route is a read; the ledger these serve is written
 * only by validation and observation ingest, so no client can move a state through here.
 */
export const attributionRoutes = defineRoutes('attribution', [
  {
    method: 'GET', path: /^\/api\/analytics\/attribution(?:\/(drilldown))?$/,
    async handle({ url, actor, services: { engine } }, [part]) {
      const query = querySchema.parse(Object.fromEntries([...url.searchParams].filter(([, value]) => value !== '')));
      const dataset = await readAttribution(engine.store, { days: query.window as 7 | 30 | 90, asOf: query.asOf ?? null });
      if (!part) return computeAttribution(dataset);
      return attributionDrilldown(dataset, { metric: query.metric ?? 'targetMismatches', key: query.key ?? null, authorized: auditRoles.includes(actor.role) });
    },
  },
  {
    // The trusted manifest of a release revision: services, digests, source, configuration revision and membership.
    method: 'GET', path: /^\/api\/attribution\/manifest\/([^/]+)\/(\d+)$/,
    async handle({ services: { engine } }, [id, revision]) {
      name.parse(id);
      const release = (await engine.store.pool.query('SELECT document FROM releases WHERE id=$1 AND revision=$2', [id, Number(revision)])).rows[0]?.document as Release | undefined;
      demand(release, 'Release revision not found', 404);
      return releaseManifest(release!);
    },
  },
  {
    // One work item's attribution history, bounded and newest last. Workers see their own item only.
    method: 'GET', path: /^\/api\/attribution\/work\/([^/]+)$/,
    async handle({ actor, services: { engine } }, [id]) {
      z.uuid().parse(id);
      const work = (await engine.store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0]?.document as Work | undefined;
      demand(work, 'Work item not found', 404);
      demand(operatorScopeIncludes(actor, work!), 'Work item is outside this operator-agent scope', 403);
      demand(actor.role !== 'worker' || work!.lastAssignment?.owner === actor.id || work!.workspaces.some(w => w.owner === actor.id), 'Workers read the attribution history of their assigned work only', 403);
      const records = await attributionHistory(engine.store, id);
      const authorized = auditRoles.includes(actor.role);
      return { workId: id, workKey: work!.key, authorized, records: authorized ? records : records.map(r => ({ ...r, requestId: null, attemptId: null, candidateId: null, details: { state: r.details.state ?? null, phase: r.details.phase ?? null, reason: r.details.reason ?? null } })) };
    },
  },
]);
