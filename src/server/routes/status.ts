import { z } from 'zod';
import { demand } from '../../model.js';
import { parseEventHistoryQuery, readEventHistory } from '../../events-history.js';
import { catchUpPipelineTimelines, pipelineBackfillState } from '../../pipeline-backfill.js';
import { delegationSnapshot } from '../../delegation.js';
import { installationSettingsUrl } from '../../github.js';
import { controlPlanePermissions, requiredPermissions } from '../../github-permissions.js';
import { releaseInfo, schemaVersion } from '../../release.js';
import { defineRoutes } from '../routes.js';
import { coordinationSnapshot, coordinationViewHeader } from '../work-view.js';

/** Control-plane status and the work reads every client polls. */
export const statusRoutes = defineRoutes('status', [
  {
    method: 'GET', path: '/api/status',
    async handle({ actor, services, operatorVisible }) {
      const { engine, github, repository, principals, limits, build, production } = services;
      const jobs = actor.role === 'operator-agent' ? [] : (await engine.store.pool.query('SELECT work_id,available_at,locked_until,attempts,error,held_until FROM jobs WHERE error IS NOT NULL ORDER BY available_at LIMIT 50')).rows;
      const githubRepository = github ? await github.reviewRepository() : null;
      const githubPermissions = github ? await github.reviewPermissions() : {};
      const dispatchAvailable = !!githubRepository && githubPermissions.pull_requests === 'write' && ['read', 'write'].includes(githubPermissions.issues) && githubPermissions.checks === 'write';
      // The declared-permission preflight: what the installation grants against what every
      // feature needs, with the operator sentences the dashboard and master status raise.
      const appPermissions = github ? github.permissionReport() ?? { appId: github.config.appId, installationId: github.config.installationId, app: String(github.config.appId), account: null, installationUrl: installationSettingsUrl(github.config.installationId), observedAt: null, verifiedAt: null, error: 'Permission preflight has not run yet', suspended: false, required: requiredPermissions(controlPlanePermissions), granted: null, missing: [], blockedFeatures: [], attention: ['GitHub App permissions have not been verified yet; the preflight runs at startup and every five minutes'] } : null;
      const heldJobs = actor.role === 'operator-agent' ? 0 : (await engine.store.heldJobs()).length;
      const observedAt = (await engine.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      return { actor, delegation: delegationSnapshot(principals.map(p => p.actor), operatorVisible(await engine.store.list()), observedAt.getTime(), limits), repository: repository || null, baseBranch: github?.config.base ?? process.env.GITHUB_BASE_BRANCH ?? 'main', github: !!github, check: 'Graphyard / merge', reviewProviders: ['github', ...(dispatchAvailable ? ['codex'] : []), ...(dispatchAvailable && engine.reviewerApps.length ? ['agent'] : [])], reviewerApps: engine.reviewerApps, githubPermissions, githubRepository, githubAppId: github?.config.appId ?? null, githubInstallationId: github?.config.installationId ?? null, appPermissions, heldJobs, jobs,
        // The installation facts the master and doctor raise as attention: capacity variables
        // that no longer cover the roster, what production serves against the base branch, and
        // the build/protocol the CLI checks before brokering a merge. Production names work
        // items across the repository, so a scoped operator agent does not see it.
        delegationLimits: services.delegationLimits, build, production: actor.role === 'operator-agent' ? null : production?.status() ?? null,
        // What the timeline reconstruction has done in this process, and any failure it hit.
        pipelineBackfill: pipelineBackfillState(observedAt.getTime()),
        now: observedAt.toISOString(), release: releaseInfo(), schema: schemaVersion };
    },
  },
  {
    method: 'GET', path: '/api/work-snapshot',
    async handle({ actor, req, url, services, operatorVisible }) {
      // The coordination view is the bounded read the master loop and dispatcher poll
      // (work-view.ts); without it the snapshot carries every document whole.
      const requested = url.searchParams.get('view') ?? req.headers[coordinationViewHeader.toLowerCase()];
      const view = z.enum(['full', 'coordination']).parse(Array.isArray(requested) ? requested[0] : requested ?? 'full');
      // Bounded catch-up: items that predate the per-item timeline gain one from their own
      // ledger before the snapshot every speed report is derived from is read. The ledger is read
      // outside the coordination lock, one run at a time; it converges and then costs one small
      // query per settle window; a failure is reported through /api/status, never here.
      await catchUpPipelineTimelines(services.engine.store);
      const snapshot = await services.engine.store.workSnapshot(); const visibleWork = operatorVisible(snapshot.work);
      const scoped = { ...snapshot, work: visibleWork, jobs: actor.role === 'operator-agent' ? snapshot.jobs.filter(job => visibleWork.some(work => work.id === job.work_id)) : snapshot.jobs };
      return view === 'coordination' ? coordinationSnapshot(scoped) : scoped;
    },
  },
  { method: 'GET', path: '/api/work', handle: async ({ services, operatorVisible }) => operatorVisible(await services.engine.store.list()) },
  {
    // The history read: filtered by kind and time, paged by ledger sequence, with the routine
    // rows the control plane writes continuously summarised instead of paged through. `rows`
    // answers with the event array every existing client reads; `view=history` adds the cursor
    // and the disclosure of what the filter left out, and `view=page` the cursor alone, for the
    // later pages of one walk. All share one set of defaults.
    method: 'GET', path: '/api/events',
    async handle({ actor, url, services, operatorVisible }) {
      const query = parseEventHistoryQuery(url.searchParams);
      if (actor.role === 'operator-agent') { demand(query.work, 'Operator-agent history reads require a scoped work item', 403); const item = (await services.engine.store.list()).find(w => w.id === query.work); demand(item && operatorVisible([item]).length, 'Work item is outside this operator-agent scope', 403); }
      const history = await readEventHistory(services.engine.store.pool, query);
      return query.view === 'rows' ? history.events : history;
    },
  },
]);
