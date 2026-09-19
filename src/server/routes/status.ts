import { z } from 'zod';
import { demand } from '../../model.js';
import { delegationSnapshot } from '../../delegation.js';
import { defineRoutes } from '../routes.js';

/** Control-plane status and the work reads every client polls. */
export const statusRoutes = defineRoutes('status', [
  {
    method: 'GET', path: '/api/status',
    async handle({ actor, services, operatorVisible }) {
      const { engine, github, repository, principals, limits } = services;
      const jobs = actor.role === 'operator-agent' ? [] : (await engine.store.pool.query('SELECT work_id,available_at,locked_until,attempts,error FROM jobs WHERE error IS NOT NULL ORDER BY available_at LIMIT 50')).rows;
      const githubRepository = github ? await github.reviewRepository() : null;
      const githubPermissions = github ? await github.reviewPermissions() : {};
      const dispatchAvailable = !!githubRepository && githubPermissions.pull_requests === 'write' && ['read', 'write'].includes(githubPermissions.issues) && githubPermissions.checks === 'write';
      const observedAt = (await engine.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      return { actor, delegation: delegationSnapshot(principals.map(p => p.actor), operatorVisible(await engine.store.list()), observedAt.getTime(), limits), repository: repository || null, baseBranch: github?.config.base ?? process.env.GITHUB_BASE_BRANCH ?? 'main', github: !!github, check: 'Graphyard / merge', reviewProviders: ['github', ...(dispatchAvailable ? ['codex'] : []), ...(dispatchAvailable && engine.reviewerApps.length ? ['agent'] : [])], reviewerApps: engine.reviewerApps, githubPermissions, githubRepository, githubAppId: github?.config.appId ?? null, githubInstallationId: github?.config.installationId ?? null, jobs, now: observedAt.toISOString() };
    },
  },
  {
    method: 'GET', path: '/api/work-snapshot',
    async handle({ actor, services, operatorVisible }) {
      const snapshot = await services.engine.store.workSnapshot(); const visibleWork = operatorVisible(snapshot.work);
      return { ...snapshot, work: visibleWork, jobs: actor.role === 'operator-agent' ? snapshot.jobs.filter(job => visibleWork.some(work => work.id === job.work_id)) : snapshot.jobs };
    },
  },
  { method: 'GET', path: '/api/work', handle: async ({ services, operatorVisible }) => operatorVisible(await services.engine.store.list()) },
  {
    method: 'GET', path: '/api/events',
    async handle({ actor, url, services, operatorVisible }) {
      const id = url.searchParams.get('work') ?? undefined;
      if (id) z.string().uuid().parse(id);
      if (actor.role === 'operator-agent') { demand(id, 'Operator-agent history reads require a scoped work item', 403); const item = (await services.engine.store.list()).find(w => w.id === id); demand(item && operatorVisible([item]).length, 'Work item is outside this operator-agent scope', 403); }
      return services.engine.store.events(id);
    },
  },
]);
