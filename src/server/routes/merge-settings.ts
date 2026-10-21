import { demand } from '../../model.js';
import { defineRoutes, parseJson } from '../routes.js';
import { AutoMergeSettings, mergeHold } from '../../merger-mode.js';
import { workDocument } from '../../store/bounded-snapshot.js';

/** The installation's merge settings the master loop and an admin publish: automatic merging (GY-1927). */
export const mergeSettingsRoutes = defineRoutes('merge-settings', [
  {
    // The master loop still publishes `mergeQueue.rerunFailedChecks` (GY-516) from its own
    // configuration. Nothing reads it since the merge writer reruns a trial's failing files itself:
    // the setting, like the retired `optimistic`, `optimisticExclude`, `batchSize` and `parallelTips`
    // keys (GY-1233, GY-1236), is accepted and ignored.
    method: 'POST', path: '/api/merge-queue',
    async handle(context) {
      const { actor } = context;
      demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
      const { rerunFailedChecks } = await parseJson(context, 16384, '{}') ?? {};
      demand(rerunFailedChecks !== undefined, 'rerunFailedChecks is required', 400);
      return { mergeQueue: { rerunFailedChecks }, recorded: false };
    },
  },
  {
    // Automatic merging (merger-mode.ts, GY-1927): read like the merger, set with an admin or
    // coordinator credential only. `?work=ID` adds that item's standing hold, read now: the
    // control-plane merge writer asks it before it opens a merge and again before it pushes, so a
    // snapshot read before the hold was recorded lands nothing.
    method: 'GET', path: '/api/auto-merge',
    async handle({ actor, url, services, operatorVisible }) {
      const status = await new AutoMergeSettings(services.engine.store).status(actor), id = url.searchParams.get('work');
      if (id === null) return status;
      const work = await workDocument(services.engine.store.pool, id);
      demand(work && operatorVisible([work]).length, 'Work item not found', 404);
      return { ...status, work: work!.key, hold: await mergeHold(services.engine.store.pool, work!) };
    },
  },
  { method: 'POST', path: '/api/auto-merge', handle: async context => new AutoMergeSettings(context.services.engine.store).change(context.actor, await parseJson(context), context.idempotencyKey()) },
]);
