import { z } from 'zod';
import { demand, dropRetiredScopeFields, type Work } from '../../model.js';
import type { IntegrationJob } from '../../coordination.js';
import { parseEventHistoryQuery, readEventHistory } from '../../events-history.js';
import { catchUpPipelineTimelines, pipelineBackfillState, readPipelineTimelines } from '../../pipeline-backfill.js';
import { delegationSnapshot } from '../../delegation.js';
import { loopPresenceHeader, loopPresenceInterval, loopPanes, loopPanesHeader, loopPanesRegistry, loopRegistry, loopSupervision, loopSupervisionHeader, reportedLoopMerger } from '../../model/loop-presence.js';
import { releaseInfo, schemaVersion } from '../../release.js';
import { openHumanOnly } from '../../model/human-request.js';
import { humanOnlySubjects } from '../waits.js';
import { defineRoutes, parseJson } from '../routes.js';
import { coordinationSnapshot, coordinationViewHeader } from '../work-view.js';
import { executorHost } from './agent-registry.js';
import { directMergeStatus } from '../../direct-merge.js';
import { autoMergeStatus, mergeHolds, mergeWriterStatus } from '../../merger-mode.js';
import { projectDelivery } from '../../project-applications.js';
import { eventStats } from '../../store/snapshot-delta.js';
import { repositoryPolicy } from '../../model/repository-policy.js';
import { productionEnvironmentEvent, productionEnvironmentName, resolvedProductionEnvironment, leadTimeReport } from '../../flow-analytics.js';
import { boardFromStatus } from '../../model/board.js';
import { boundedSnapshot, workDocument } from '../../store/bounded-snapshot.js';
import { snapshotPage } from '../../store/paged-snapshot.js';


/** Control-plane status and the work reads every client polls. */
export const statusRoutes = defineRoutes('status', [
  {
    method: 'GET', path: '/api/status',
    async handle({ actor, req, url, services, operatorVisible }) {
      const { engine, repository, principals, limits, build, production } = services;
      const jobs = actor.role === 'operator-agent' ? [] : (await engine.store.pool.query('SELECT work_id,available_at,locked_until,attempts,error,held_until FROM jobs WHERE error IS NOT NULL ORDER BY available_at LIMIT 50')).rows;
      const heldJobs = actor.role === 'operator-agent' ? 0 : (await engine.store.heldJobs()).length;
      // Observation jobs rescheduled three times in a row without an observation (GY-506): the
      // merge-queue deadlock shape, raised by master status rather than left for someone to diagnose.
      const starvedJobs = actor.role === 'operator-agent' ? [] : await engine.store.starvedJobs();
      const observedAt = (await engine.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      // Settled deliveries as the work index's summary (GY-1376): this read never loads every document.
      const work = await engine.store.fleet();
      const visibleWork = operatorVisible(work);
      // The one speed number (GY-1989), read from the items' own release records; a failed read is
      // absent, never an error: the status every client polls keeps answering. It names work items
      // across the repository, so a scoped operator agent does not read it, exactly as production.
      const eventsReader = (path: string) => readEventHistory(services.engine.store.pool, parseEventHistoryQuery(new URLSearchParams(path.startsWith('events?') ? path.slice('events?'.length) : path)));
      const leadTime = actor.role === 'operator-agent' ? null : await leadTimeReport(visibleWork, eventsReader).catch(() => null);
      // What waits on the operator, derived from the human-only rule table (model/human-request.ts)
      // on the read every client polls, so the Needs you page renders that table (GY-102).
      // The production environment the master publishes (else this process's own setting), so the
      // dashboard reads a release as live under the same name the flow report's production phase uses.
      const productionEnvironment = await resolvedProductionEnvironment(engine.store.pool);
      const humanOnly = openHumanOnly(await humanOnlySubjects(services, visibleWork), observedAt.getTime());
      const loop = await reportedLoopMerger(loopRegistry(engine), (text, values) => engine.store.pool.query(text, values), observedAt);
      return { actor, humanOnly, delegation: delegationSnapshot(principals.map(p => p.actor), visibleWork, observedAt.getTime(), limits), repository: repository || null,
        baseBranch: process.env.GITHUB_BASE_BRANCH ?? 'main', reviewerApps: engine.reviewerApps, heldJobs, starvedJobs, jobs,
        // The installation facts the master and doctor raise as attention: capacity variables
        // that no longer cover the roster, what production serves against the base branch, and
        // the build/protocol the CLI checks before brokering a merge. Production names work
        // items across the repository, so a scoped operator agent does not see it.
        delegationLimits: services.delegationLimits, build, repositoryPolicy: repositoryPolicy(), production: actor.role === 'operator-agent' ? null : production?.status() ?? null, productionEnvironment,
        // The documentation policy this control plane stamps on new items, which doctor compares
        // with the checkout's committed graphyard.json (GY-293).
        documentation: engine.documentation,
        // What the timeline reconstruction has done in this process, and any failure it hit.
        pipelineBackfill: pipelineBackfillState(observedAt.getTime()),
        // The fleet as the registry holds it: each account's runtime, model, eligibility, sessions,
        // quota and reset time. `?host=` (or the executor-host header) judges placement for that
        // executor. It names hosts and login homes, so implementers and producers do not read it.
        fleet: ['admin', 'coordinator', 'reader', 'slice-lead'].includes(actor.role) ? await services.agentRegistry.snapshot(executorHost(url, req)) : null,
        // Direct-merge mode (direct-merge.ts): the open windows and the one line master status shows while any is.
        directMerge: await directMergeStatus(engine.store.pool, engine.directMergeEnvironment, observedAt),
        // The merge writer (merger-mode.ts): always the control plane.
        mergeWriter: mergeWriterStatus,
        // Automatic merging (GY-1927): off, a gate-passing candidate is held until a merge decision releases it.
        autoMerge: await autoMergeStatus(engine.store.pool),
        // Delivery defaults, applications and case bindings (GY-1901).
        project: projectDelivery(),
        // Median lead time, released to merged, over the last 10 merges (GY-1989).
        leadTime,
        // Heartbeat latency and the renewals refused or failed server-side, this process, last 10 minutes (GY-558).
        leaseHealth: engine.leaseHealth.report(),
        // The first-run facts the Setup page and `graphyard up` read beside the App and the fleet (GY-1419):
        // whether a master loop is live, and who reviews and merges as the live loop names it (GY-1501):
        // `supervised` drops the reviewer App and reviewing account from the Setup checklist.
        setup: { loop: !!loop?.live, supervision: loopRegistry(engine).live(observedAt)?.supervision ?? null,
          // and the pane server its agents run in as that loop last named it (GY-1511).
          panes: loopRegistry(engine).live(observedAt) ? loopPanesRegistry(engine).latest : null },
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
      const work = operatorVisible(await engine.store.fleet());
      return boardFromStatus(work, now, { humanOnly: openHumanOnly(await humanOnlySubjects(services, work), now), productionEnvironment: await resolvedProductionEnvironment(engine.store.pool),
        production: actor.role === 'operator-agent' ? null : production?.status() ?? null });
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
    method: 'GET', path: '/api/work-snapshot',
    async handle({ actor, req, url, services, operatorVisible }) {
      // Three views. The default (GY-422) is what every reader uses: open items whole, and each
      // settled delivery as its summary (key, stage, delivery; store/summary-sql.ts), whose history
      // `GET /api/work/:id` answers per item. The coordination view is the bounded read the master
      // loop and dispatcher poll (work-view.ts). `view=full` carries every document whole, for an
      // export; no product reader asks for it, as it grows with the ledger.
      const requested = url.searchParams.get('view') ?? req.headers[coordinationViewHeader.toLowerCase()];
      const view = z.enum(['bounded', 'full', 'coordination']).parse(Array.isArray(requested) ? requested[0] : requested ?? 'bounded');
      // The loop's own read is its presence (GY-916): it merges while it lives, however long nothing is mergeable.
      const loopInterval = actor.role === 'coordinator' ? loopPresenceInterval(req.headers[loopPresenceHeader.toLowerCase()]) : null;
      if (loopInterval !== null) loopRegistry(services.engine).observe({ principal: actor.id, intervalSeconds: loopInterval, supervision: loopSupervision(req.headers[loopSupervisionHeader.toLowerCase()]) }, new Date());
      if (loopInterval !== null) loopPanesRegistry(services.engine).observe(loopPanes(req.headers[loopPanesHeader.toLowerCase()]));
      // Bounded catch-up: items that predate the per-item timeline gain one from their own
      // ledger before the snapshot every speed report is derived from is read. The ledger is read
      // outside the coordination lock, one run at a time; it converges and then costs one small
      // query per settle window; a failure is reported through /api/status, never here.
      //
      // It rides the default and full reads, which are the reads its output is for: master status
      // derives every speed report from their timelines. The coordination view is the inverted loop's
      // poll — the cycle and the dispatcher ask for it every few seconds — and a ledger
      // reconstruction in front of those reads would sit in the path of every step.
      if (view !== 'coordination') await catchUpPipelineTimelines(services.engine.store);
      const scope = <T extends { work: Work[]; jobs: IntegrationJob[] }>(snapshot: T) => {
        const visibleWork = operatorVisible(snapshot.work);
        return { ...snapshot, work: visibleWork, jobs: actor.role === 'operator-agent' ? snapshot.jobs.filter(job => visibleWork.some(work => work.id === job.work_id)) : snapshot.jobs };
      };
      // Paging (GY-864): a reader that must still walk every document — an export, a migration —
      // asks for `cursor` (the number of the work item it last saw, the suffix of its key) and
      // `pageSize`, and streams page by page. The page is chosen in the database, so a page reads
      // only its own documents, never the whole ledger. Only a request that names one of the two
      // is paged; every other response is what it always was, so no reader is truncated
      // silently. The coordination view, the loop's own bounded poll, is not paged.
      const cursorParam = url.searchParams.get('cursor'), pageSizeParam = url.searchParams.get('pageSize');
      const maxPageSize = 1000, defaultPageSize = 100;
      if (cursorParam !== null || pageSizeParam !== null) {
        const cursor = cursorParam === null ? undefined : Number(cursorParam);
        const pageSize = pageSizeParam === null ? defaultPageSize : Number(pageSizeParam);
        demand(cursor === undefined || Number.isSafeInteger(cursor) && cursor >= 0, 'cursor must be a work item number', 400);
        demand(Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= maxPageSize, `pageSize must be an integer from 1 to ${maxPageSize}`, 400);
        demand(view !== 'coordination', 'the coordination view is not paged; it is the bounded read the loop polls', 400);
        // A scoped operator agent's page is chosen from its own work, so the cursor and `hasMore`
        // disclose nothing of the items outside its scope.
        const visible = actor.role === 'operator-agent' && !actor.scope?.workItems.includes('*') ? actor.scope?.workItems ?? [] : undefined;
        const page = scope(await snapshotPage(services.engine.store.pool, view as 'bounded' | 'full', { cursor, pageSize, visible }));
        return view === 'bounded' ? { ...page, view } : page;
      }
      if (view === 'bounded') return { ...scope(await boundedSnapshot(services.engine.store.pool)), view };
      if (view === 'full') return scope(await services.engine.store.workSnapshot());
      // The coordination view is trimmed in the database (GY-185): the histories it bounds never
      // leave it whole, and what the SQL cut is added to what the view says it left out.
      const { trimmed, ...snapshot } = await services.engine.store.coordinationSnapshot();
      const trimmedView = coordinationSnapshot(scope(snapshot));
      // GY-1927: each held candidate names its hold, so the control-plane merge writer starts no merge for it.
      const holds = await mergeHolds(services.engine.store.pool, trimmedView.work);
      for (const work of trimmedView.work) {
        if (holds.get(work.id)) work.mergeHold = holds.get(work.id);
        const cut = trimmed.get(work.id);
        if (cut) { trimmedView.omitted.evidence += cut.evidence; trimmedView.omitted.dispatchHistory += cut.dispatchHistory; trimmedView.omitted.queueHistory += cut.queueHistory; trimmedView.omitted.actionHistory += cut.actionHistory; trimmedView.omitted.sessions += cut.sessions; }
      }
      return trimmedView;
    },
  },
  {
    // Every item's timeline alone (GY-1489): `master status` reads the coordination view, which
    // drops them, and attaches these to measure speed. The same bounded catch-up runs first.
    method: 'GET', path: '/api/pipeline-timelines',
    async handle({ services, operatorVisible }) {
      await catchUpPipelineTimelines(services.engine.store);
      return { timelines: operatorVisible(await readPipelineTimelines(services.engine.store)) };
    },
  },
  {
    // The work list is the bounded fleet read (GY-1778): every open item whole and each settled
    // delivery as the work index's stored summary (store.fleet, GY-1376). `?pr=N` narrows it to
    // the item whose candidate or submission names pull request N, which is all the CI plan step
    // needs. store.list() served every document whole here:
    // 134 MB on a 1,777-item ledger, past the plan's abort on every acceptance run.
    method: 'GET', path: '/api/work',
    async handle({ url, services, operatorVisible }) {
      const requested = url.searchParams.get('pr');
      if (requested === null) return operatorVisible(await services.engine.store.fleet());
      demand(/^[1-9]\d{0,14}$/.test(requested), 'pr must be a pull request number', 400);
      return operatorVisible(await services.engine.store.workForPullRequest(Number(requested)));
    },
  },
  {
    // One item's whole document, history included, by id or display key (GY-422): what a reader
    // asks for when the snapshot's summary of a settled delivery is not enough.
    method: 'GET', path: /^\/api\/work\/([^/]+)$/,
    async handle({ services, operatorVisible }, [id]) {
      const work = await workDocument(services.engine.store.pool, decodeURIComponent(id));
      demand(work && operatorVisible([work]).length, 'Work item not found', 404);
      // A document no evaluation has rewritten since GY-1992 reads without the retired scope fields.
      return dropRetiredScopeFields({ ...work! });
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
      // An approver judges decisions resting on the ledger (GY-642), so one scoped to every item
      // reads it whole; the read grants nothing, and every other operator agent names its item.
      const wholeLedger = actor.role === 'operator-agent' && !!actor.capabilities?.includes('decision:approve') && !!actor.scope?.workItems.includes('*');
      if (actor.role === 'operator-agent' && !wholeLedger) { demand(query.work, 'Operator-agent history reads require a scoped work item', 403); const item = await services.engine.store.workDocument(query.work!); demand(item && item.id === query.work && operatorVisible([item]).length, 'Work item is outside this operator-agent scope', 403); }
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
