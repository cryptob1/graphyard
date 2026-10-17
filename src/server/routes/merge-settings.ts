import { demand } from '../../model.js';
import { defineRoutes, parseJson } from '../routes.js';
import { rerunFailedChecksEvent } from '../../merge-queue.js';
import { maxRerunFailedChecks } from '../../master/profiles.js';
import { AutoMergeSettings, mergeHold } from '../../merger-mode.js';
import { workDocument } from '../../store/bounded-snapshot.js';

/** The installation's merge settings the master loop and an admin publish: the merge queue's rerun bound and automatic merging (GY-1927). */
export const mergeSettingsRoutes = defineRoutes('merge-settings', [
  {
    // The master loop publishes `mergeQueue.rerunFailedChecks` (GY-516) from its own configuration,
    // which lives only on the master's host: how many times a failed required check is rerun on its
    // sha. It is recorded once per change in the installation ledger and applied to every
    // evaluation from then on; a restarted server reads it back from there. The retired keys an
    // older master may still send — `optimistic` and `optimisticExclude` (GY-1233), `batchSize` and
    // `parallelTips` of Graphyard's removed merge queue (GY-1236) — are ignored.
    method: 'POST', path: '/api/merge-queue',
    async handle(context) {
      const { actor, services: { engine } } = context;
      demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
      const body = await parseJson(context, 16384, '{}');
      const { batchSize, parallelTips, rerunFailedChecks } = body ?? {};
      demand(batchSize !== undefined || parallelTips !== undefined || rerunFailedChecks !== undefined, 'rerunFailedChecks is required', 400);
      if (rerunFailedChecks !== undefined) demand(Number.isSafeInteger(rerunFailedChecks) && rerunFailedChecks >= 0 && rerunFailedChecks <= maxRerunFailedChecks, `rerunFailedChecks must be an integer from 0 to ${maxRerunFailedChecks}`, 400);
      let recorded = false;
      // Each value is applied only once the ledger holds it (GY-384): a failed INSERT leaves the
      // evaluation on the recorded value and the master unpublished, so its next cycle retries.
      const record = async (kind: string, field: string, value: number, previous: number, apply: () => void) => {
        const latest = (await engine.store.pool.query('SELECT 1 FROM events WHERE work_id IS NULL AND kind=$1 LIMIT 1', [kind])).rowCount;
        if (latest && JSON.stringify(previous) === JSON.stringify(value)) return apply();
        await engine.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, kind, JSON.stringify({ [field]: value, previous: latest ? previous : null })]);
        apply();
        recorded = true;
      };
      if (rerunFailedChecks !== undefined) await record(rerunFailedChecksEvent, 'rerunFailedChecks', rerunFailedChecks, await engine.loadRerunFailedChecks(), () => { engine.rerunFailedChecks = rerunFailedChecks; });
      return { mergeQueue: { rerunFailedChecks: engine.rerunFailedChecks }, recorded };
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
