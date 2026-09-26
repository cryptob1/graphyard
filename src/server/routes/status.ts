import { z } from 'zod';
import { demand, type Work } from '../../model.js';
import type { IntegrationJob } from '../../coordination.js';
import { parseEventHistoryQuery, readEventHistory } from '../../events-history.js';
import { catchUpPipelineTimelines, pipelineBackfillState } from '../../pipeline-backfill.js';
import { delegationSnapshot } from '../../delegation.js';
import { describeUnserved, executorRegistry, executorReport } from '../../model/executor-presence.js';
import { installationSettingsUrl } from '../../github.js';
import { controlPlanePermissions, requiredPermissions } from '../../github-permissions.js';
import { releaseInfo, schemaVersion } from '../../release.js';
import { openHumanOnly } from '../../model/human-request.js';
import { humanOnlySubjects } from '../waits.js';
import { defineRoutes, parseJson } from '../routes.js';
import { coordinationSnapshot, coordinationViewHeader } from '../work-view.js';
import { executorHost } from './agent-registry.js';
import { directMergeStatus } from '../../direct-merge.js';
import { maxMergeBatchSize, mergeBatchSizeEvent } from '../../merge-queue.js';
import { eventStats } from '../../store/snapshot-delta.js';
import { productionEnvironmentEvent, productionEnvironmentName, resolvedProductionEnvironment } from '../../flow-analytics.js';
import { boardFromStatus } from '../../model/board.js';
import { boundedSnapshot, workDocument } from '../../store/bounded-snapshot.js';

/** Control-plane status and the work reads every client polls. */
export const statusRoutes = defineRoutes('status', [
  {
    method: 'GET', path: '/api/status',
    async handle({ actor, req, url, services, operatorVisible }) {
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
      const work = await engine.store.list();
      const visibleWork = operatorVisible(work);
      // What waits on the operator, derived from the human-only rule table (model/human-request.ts)
      // and carried on the read every client already polls, so the dashboard's Needs you page is
      // a renderer of that table rather than a second opinion about it (GY-102).
      // The production environment the master verifies deployments under, as it last published it
      // (else this process's own setting), so the dashboard reads a release as live under the same
      // name `master verify-deployment` and the flow report's production phase use.
      const productionEnvironment = await resolvedProductionEnvironment(engine.store.pool);
      const humanOnly = openHumanOnly(await humanOnlySubjects(services, visibleWork), observedAt.getTime());
      // The GitHub request budget and the observation schedule spending it (GY-117): what is
      // left, how fast it goes, the pause in force, what each observation cost; and whether the
      // webhook is delivering at all, against the pull requests that are open to be woken.
      const githubBudget = github?.budget?.(observedAt.getTime()) ?? null;
      const webhooks = { ...await engine.store.webhookLiveness(), configured: !!process.env.GITHUB_WEBHOOK_SECRET, settingsUrl: github?.webhookSettingsUrl?.() ?? null,
        openPullRequests: work.filter(item => item.stage !== 'done' && !!item.submission && !!item.observation && !item.observation.merged && item.observation.prState !== 'closed').length };
      // The fleet as the dashboard needs it (GY-105): how many executors are alive, and each kind
      // of pending action none of them serves, with its wait and what to start.
      const executors = executorReport(visibleWork, executorRegistry(engine), observedAt);
      return { actor, humanOnly, delegation: delegationSnapshot(principals.map(p => p.actor), visibleWork, observedAt.getTime(), limits), repository: repository || null,
        executors: { live: executors.live.length, liveMs: executors.liveMs, served: executors.served, unserved: executors.unserved, attention: describeUnserved(executors) }, baseBranch: github?.config.base ?? process.env.GITHUB_BASE_BRANCH ?? 'main', github: !!github, check: 'Graphyard / merge', reviewProviders: ['github', ...(dispatchAvailable ? ['codex'] : []), ...(dispatchAvailable && engine.reviewerApps.length ? ['agent'] : [])], reviewerApps: engine.reviewerApps, githubPermissions, githubRepository, githubAppId: github?.config.appId ?? null, githubInstallationId: github?.config.installationId ?? null, appPermissions, heldJobs, jobs, githubBudget, webhooks,
        // The installation facts the master and doctor raise as attention: capacity variables
        // that no longer cover the roster, what production serves against the base branch, and
        // the build/protocol the CLI checks before brokering a merge. Production names work
        // items across the repository, so a scoped operator agent does not see it.
        delegationLimits: services.delegationLimits, build, production: actor.role === 'operator-agent' ? null : production?.status() ?? null, productionEnvironment, ciAppIds: engine.ciAppIds, mergeQueue: { batchSize: engine.mergeBatchSize },
        // The documentation policy this control plane stamps on new items, which doctor compares
        // with the checkout's committed graphyard.json (GY-293).
        documentation: engine.documentation,
        // What the timeline reconstruction has done in this process, and any failure it hit.
        pipelineBackfill: pipelineBackfillState(observedAt.getTime()),
        // The fleet as the registry holds it: each account's runtime, model, role eligibility, live
        // sessions, quota and reset time, and why it is ineligible when it is. `?host=` (or the executor-host header) judges
        // placement for the executor asking. It names hosts and login homes, so identities that
        // only implement or produce do not read it.
        fleet: ['admin', 'coordinator', 'reader', 'slice-lead'].includes(actor.role) ? await services.agentRegistry.snapshot(executorHost(url, req)) : null,
        // Direct-merge mode (direct-merge.ts): the open windows and the one line master status shows while any is.
        directMerge: await directMergeStatus(engine.store.pool, engine.directMergeEnvironment, observedAt),
        // Heartbeat latency and the renewals refused or failed server-side, this process, last 10 minutes (GY-558).
        leaseHealth: engine.leaseHealth.report(),
        now: observedAt.toISOString(), release: releaseInfo(), schema: schemaVersion };
    },
  },
  {
    // The board (GY-200): every open item in its group with who acts next, the command that acts,
    // since when and whether it is overdue — the classification the Work page renders and
    // `master status` lists its owed items from, over the same human-only rows and production
    // view /api/status carries, so no client derives groups of its own.
    method: 'GET', path: '/api/board',
    async handle({ actor, services, operatorVisible }) {
      const { engine, production } = services;
      const now = ((await engine.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).getTime();
      const work = operatorVisible(await engine.store.list());
      return boardFromStatus(work, now, { humanOnly: openHumanOnly(await humanOnlySubjects(services, work), now), productionEnvironment: await resolvedProductionEnvironment(engine.store.pool),
        production: actor.role === 'operator-agent' ? null : production?.status() ?? null, ciAppIds: engine.ciAppIds });
    },
  },
  {
    // The master loop publishes the production environment it resolves from its own configuration
    // (`graphyard master config productionEnvironment=…`), which lives only on the master's host.
    // Recorded once per change in the installation ledger; every status and flow read uses it.
    method: 'POST', path: '/api/production-environment',
    async handle(context) {
      const { actor, services: { engine } } = context;
      demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
      const environment = productionEnvironmentName((await parseJson(context, 4096, '{}'))?.environment);
      demand(environment, 'environment must name a deployment-provider environment (1-100 characters)', 400);
      const latest = (await engine.store.pool.query('SELECT payload->>\'environment\' AS environment FROM events WHERE work_id IS NULL AND kind=$1 ORDER BY seq DESC LIMIT 1', [productionEnvironmentEvent])).rows[0];
      if (latest?.environment === environment) return { productionEnvironment: environment, recorded: false };
      await engine.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, productionEnvironmentEvent, JSON.stringify({ environment, previous: latest?.environment ?? null })]);
      return { productionEnvironment: environment, recorded: true };
    },
  },
  {
    // The master loop publishes `mergeQueue.batchSize` from its own configuration (GY-330), which
    // lives only on the master's host: how many consecutive queue entries one combined tip
    // validates. Recorded once per change in the installation ledger and applied to every
    // evaluation from then on; a restarted server reads it back from there.
    method: 'POST', path: '/api/merge-queue',
    async handle(context) {
      const { actor, services: { engine } } = context;
      demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
      const batchSize = (await parseJson(context, 4096, '{}'))?.batchSize;
      demand(Number.isSafeInteger(batchSize) && batchSize >= 1 && batchSize <= maxMergeBatchSize, `batchSize must be an integer from 1 to ${maxMergeBatchSize}`, 400);
      const previous = await engine.loadMergeBatchSize();
      const latest = (await engine.store.pool.query('SELECT 1 FROM events WHERE work_id IS NULL AND kind=$1 LIMIT 1', [mergeBatchSizeEvent])).rowCount;
      engine.mergeBatchSize = batchSize;
      if (latest && previous === batchSize) return { mergeQueue: { batchSize }, recorded: false };
      await engine.store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, mergeBatchSizeEvent, JSON.stringify({ batchSize, previous: latest ? previous : null })]);
      return { mergeQueue: { batchSize }, recorded: true };
    },
  },
  {
    method: 'GET', path: '/api/work-snapshot',
    async handle({ actor, req, url, services, operatorVisible }) {
      // Three views. The default (GY-422) is what every reader uses: open items whole, and each
      // settled delivery as its summary (key, stage, delivery; store/summary-sql.ts), whose history
      // `GET /api/work/:id` answers per item. The coordination view is the bounded read the master
      // loop and dispatcher poll (work-view.ts). `view=full` carries every document whole, for an
      // export; no product reader asks for it, as it grows with the ledger.
      const requested = url.searchParams.get('view') ?? req.headers[coordinationViewHeader.toLowerCase()];
      const view = z.enum(['bounded', 'full', 'coordination']).parse(Array.isArray(requested) ? requested[0] : requested ?? 'bounded');
      // Bounded catch-up: items that predate the per-item timeline gain one from their own
      // ledger before the snapshot every speed report is derived from is read. The ledger is read
      // outside the coordination lock, one run at a time; it converges and then costs one small
      // query per settle window; a failure is reported through /api/status, never here.
      //
      // It rides the default and full reads, which are the reads its output is for: master status
      // derives every speed report from their timelines. The coordination view is the inverted loop's
      // poll — the cycle, the dispatcher and every stateless executor ask for it every few
      // seconds — and a ledger reconstruction in front of those reads would sit in the path of
      // every claim, so a fleet that polls harder would pay reconstruction latency to act.
      if (view !== 'coordination') await catchUpPipelineTimelines(services.engine.store);
      const scope = <T extends { work: Work[]; jobs: IntegrationJob[] }>(snapshot: T) => {
        const visibleWork = operatorVisible(snapshot.work);
        return { ...snapshot, work: visibleWork, jobs: actor.role === 'operator-agent' ? snapshot.jobs.filter(job => visibleWork.some(work => work.id === job.work_id)) : snapshot.jobs };
      };
      if (view === 'bounded') return { ...scope(await boundedSnapshot(services.engine.store.pool)), view };
      if (view === 'full') return scope(await services.engine.store.workSnapshot());
      // The coordination view is trimmed in the database (GY-185): the histories it bounds never
      // leave it whole, and what the SQL cut is added to what the view says it left out.
      const { trimmed, ...snapshot } = await services.engine.store.coordinationSnapshot();
      const trimmedView = coordinationSnapshot(scope(snapshot));
      for (const work of trimmedView.work) {
        const cut = trimmed.get(work.id);
        if (cut) { trimmedView.omitted.evidence += cut.evidence; trimmedView.omitted.dispatchHistory += cut.dispatchHistory; trimmedView.omitted.queueHistory += cut.queueHistory; trimmedView.omitted.actionHistory += cut.actionHistory; trimmedView.omitted.sessions += cut.sessions; }
      }
      return trimmedView;
    },
  },
  { method: 'GET', path: '/api/work', handle: async ({ services, operatorVisible }) => operatorVisible(await services.engine.store.list()) },
  {
    // One item's whole document, history included, by id or display key (GY-422): what a reader
    // asks for when the snapshot's summary of a settled delivery is not enough.
    method: 'GET', path: /^\/api\/work\/([^/]+)$/,
    async handle({ services, operatorVisible }, [id]) {
      const work = await workDocument(services.engine.store.pool, decodeURIComponent(id));
      demand(work && operatorVisible([work]).length, 'Work item not found', 404);
      return work;
    },
  },
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
  {
    // The ledger's growth over the last hour (or `minutes`, up to a day): rows, stored payload
    // bytes and delta rows by kind, read through the created_at index.
    method: 'GET', path: '/api/events/stats',
    async handle({ actor, url, services }) {
      demand(['admin', 'coordinator', 'reader'].includes(actor.role), 'An admin, coordinator or reader identity is required to read ledger growth', 403);
      const minutes = z.coerce.number().int().min(1).max(1440).default(60).parse(url.searchParams.get('minutes') ?? undefined);
      return eventStats(services.engine.store.pool, minutes);
    },
  },
]);
