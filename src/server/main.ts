import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../store.js';
import { Engine } from '../engine.js';
import { demand, parseReviewerApps } from '../model.js';
import { githubFromEnv, installationFingerprint, processJob, type AppPermissionReport, type GitHub } from '../github.js';
import { Validation } from '../validation.js';
import { Delivery } from '../delivery.js';
import { ProofGrants } from '../proof-grants.js';
import { artifactBackendFromEnv, artifactCapacityFromEnv } from '../artifacts.js';
import { projectFlow } from '../flow-analytics.js';
import { openPatternItems, startPatternScan } from '../interventions.js';
import { startRetroIndexWatch, synthesizeRetro } from '../retro-synthesis.js';
import { principalSchema, server } from './index.js';
import { buildIdentity } from '../protocol-version.js';
import { ProductionWatch, observationLine, productionProvider, startProductionWatch } from '../production-watch.js';
import { productionBranch } from '../release-candidate.js';
import { configuredGeneratedFiles } from '../generated-files.js';
import { generatedFilesVariable } from '../install/generated-files.js';
import { startDirectMerge } from '../direct-merge.js';
import { GitHubCacheStore } from '../github-cache.js';
import { pruneReceipts, receiptPruneIntervalMs } from '../store/receipts.js';
import { compactLedger, configuredLedgerRetentionMs, ledgerCompactionIntervalMs } from '../store/compaction.js';

/** Overrides for tests that start the process entry in-process; the deployment reads PORT and HOST. */
export interface MainOptions { port?: number; host?: string }

/** Process entry: configuration, migration, the HTTP server and the reconciliation tick. */
export async function main(options: MainOptions = {}) {
  try { process.loadEnvFile(); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  // An unparseable generated-files declaration refuses start-up with a clear message instead of
  // silently exempting nothing; the regression guard runs with exactly this parsed set.
  const generatedFiles = configuredGeneratedFiles();
  const credentials = principalSchema.parse(JSON.parse(process.env.GRAPHYARD_PRINCIPALS ?? '[]'));
  demand(new Set(credentials.map(p => p.id)).size === credentials.length && new Set(credentials.map(p => p.token)).size === credentials.length, 'Principal IDs and tokens must be unique');
  // The pool and the observation workers are sized together (GY-1114): workers at most half the pool.
  const capacity = observationCapacity();
  const store = new Store(process.env.DATABASE_URL ?? 'postgres://graphyard:graphyard@localhost:5438/graphyard', { max: capacity.poolMax });
  const startedAt = Date.now(); const mark = (step: string) => console.log(`startup ${step} at ${Date.now() - startedAt} ms`);
  mark('store.init'); await store.init(); mark('store.init done');
  // Built CONCURRENTLY beside startup, never awaited: a plain build in the migration would hold the ledger's writes (GY-1048).
  // When another replica is building it re-checks periodically, and on error backs off, until present (follow-up 26, GY-1189).
  const retroIndex = startRetroIndexWatch(store.pool, {
    announce: outcome => console.log(`Retro index events_retro_id: ${outcome}`),
    failed: error => console.error('Retro index events_retro_id was not built; will retry:', error instanceof Error ? error.message : 'unknown'),
  });
  const engine = new Engine(store, (process.env.GITHUB_CI_APP_IDS ?? '15368').split(',').map(Number));
  engine.reconcileBatchMs = reconcileBatchMs(process.env.GRAPHYARD_RECONCILE_BATCH_MS);
  engine.reviewerApps = parseReviewerApps(process.env.GRAPHYARD_REVIEWER_APPS);
  mark('github'); const github = await githubFromEnv();
  // GitHub answers persist across restarts, so a deploy starts warm instead of re-spending the budget.
  const githubCache = github ? new GitHubCacheStore(store.pool, String(github.config.installationId)) : null;
  if (github && githubCache) void github.attachCache(githubCache);
  // Startup preflight: a permission shortfall is announced before the first job can run
  // into it, and the jobs that need the missing permission are held rather than retried.
  // A passing preflight (startup or periodic) releases holds decided against a different
  // installation, including holds left by an earlier process; a hold decided against this same
  // installation (a 403 the declaration does not explain) keeps its bounded expiry.
  const announcePreflight = async (report: AppPermissionReport) => {
    for (const line of report.attention) console.error(`GitHub App permissions: ${line}`);
    if (!report.error && !report.suspended && !report.missing.length) await store.releaseHeldJobs(installationFingerprint(report));
  };
  mark('github.preflight'); if (github) await announcePreflight(await github.preflight()); mark('github.preflight done');
  const artifacts = { backend: artifactBackendFromEnv(), capacityBytes: artifactCapacityFromEnv() };
  // The producers this installation already ran with. An over-limit roster of these starts
  // with a warning; only a principal added beyond the limit refuses, naming the variable.
  const knownPrincipals = (await store.pool.query('SELECT principal_id FROM proof_grants')).rows.map(row => String(row.principal_id));
  const build = buildIdentity();
  // Railway's API when a Railway token is set, else the GitHub deployments Railway reports (GY-1327).
  const provider = productionProvider(process.env, github);
  // Production deploys the release branch when the release pipeline owns it (GY-1207); GRAPHYARD_PRODUCTION_BRANCH names another.
  const production = new ProductionWatch(store, { provider, github, build, baseBranch: github?.config.base ?? process.env.GITHUB_BASE_BRANCH ?? 'main', releaseBranch: process.env.GRAPHYARD_PRODUCTION_BRANCH?.trim() || productionBranch });
  const http = server(engine, credentials, github, artifacts, { knownPrincipals, production });
  // The deployed-variables record the status route reports gains the generated-files variable the
  // installers set beside GRAPHYARD_PRINCIPALS, so master status can compare what the deployment
  // runs with against the managed repository's manifest and name the command that fixes it.
  http.services.delegationLimits.deployed[generatedFilesVariable] = process.env.GRAPHYARD_GENERATED_FILES ?? null;
  for (const line of http.services.delegationLimits.attention) console.error(`Delegation limits: ${line}`);
  console.log(`Generated files: ${generatedFiles.length ? generatedFiles.join(', ') : 'none declared; the regression guard exempts nothing'}`);
  console.log(`Build ${build.commit ?? 'commit unknown'} (merge protocol ${build.protocol}); ${observationLine(provider, build)}`);

  const validation = new Validation(engine, credentials.map(({ token, ...actor }) => actor), github?.config.repository ?? process.env.GITHUB_REPOSITORY ?? '');
  validation.artifactBackend = artifacts.backend; validation.artifactCapacityBytes = artifacts.capacityBytes;
  const delivery = new Delivery(validation);
  console.log(`Artifact storage: ${artifacts.backend?.label ?? 'postgres'}; capacity ${artifacts.capacityBytes} bytes`);

  // Startup validation (GY-1127): artifact expiry and the full validation reconcile took minutes
  // against a busy database and held http.listen past the deploy's 120 s healthcheck. The port now
  // opens first; until startup validation completes, /healthz reports `readiness: false`, every
  // mutation that could act on unvalidated state is refused with a retryable 503, and the
  // observation workers and production watch are not started. A failed attempt is logged and the
  // reconciliation tick retries it.
  let ready = false, validating = false, prepared = false, closing = false;
  let watching: ReturnType<typeof startProductionWatch> | null = null;
  let scanning: ReturnType<typeof startPatternScan> | null = null;
  let observing: ReturnType<typeof startObservationWorkers> | null = null;
  let validationTask: Promise<void> | null = null;
  const services: typeof http.services & { readiness?: boolean } = http.services;
  services.readiness = false;
  const runStartupValidation = async () => {
    if (ready || validating || closing) return;
    validating = true;
    const task = (async () => {
      try {
        if (!prepared) {
          mark('production.load'); await production.load().catch(error => { if (!closing) console.error('production incidents could not be loaded', error instanceof Error ? error.message : 'unknown'); });
          if (closing) return;
          // One-time materialization of the deployment allowlist. Operators manage proof authority
          // inside Graphyard from here on; a later environment edit no longer changes authority.
          mark('proofGrants.seed'); const seeded = await new ProofGrants(store, credentials.map(({ token, ...actor }) => actor)).seed();
          if (seeded.length) console.log(`Seeded proof grants for ${seeded.map(grant => grant.principalId).join(', ')}`);
          if (closing) return;
          mark('directMerge'); await startDirectMerge(store, engine.directMergeEnvironment);
          prepared = true;
        }
        if (closing) return;
        mark('validation.expireArtifacts'); await validation.expireArtifacts();
        if (closing) return;
        mark('validation.reconcile'); await validation.reconcile(true); mark('startup done');
        if (closing) return;
        ready = true; services.readiness = true;
        startBackground();
      } catch (error) {
        if (!closing) console.error('startup validation failed; the reconciliation tick retries it', error instanceof Error ? error.message : 'unknown');
      } finally {
        validating = false;
        validationTask = null;
      }
    })();
    validationTask = task;
    await task;
  };
  const startBackground = () => {
    if (closing) return;
    // The production watch runs beside the tick, never in it: a deploy used to hold the tick for
    // minutes while it re-compared every delivery (GY-186), and observations and merges stalled behind it.
    // Incidents it raises land in the ledger and in /api/status, and are announced here once each.
    watching = startProductionWatch(production, {
      announce: incident => console.error(`Deployment incident ${incident.key} (${incident.status}): ${incident.reason}`),
      failed: error => console.error('production watch failed', error instanceof Error ? error.message : 'unknown'),
    });
    // The observation workers run beside the tick, never in it: a queue of due jobs is drained at
    // the concurrency the installation sets, whatever the rest of the tick is doing (GY-492).
    observing = github ? startObservationWorkers(engine, github, capacity.concurrency) : null;
    console.log(`Observation workers: ${observing?.concurrency ?? 0} (database pool ${capacity.poolMax})`);
    // A recurring intervention becomes work on its own (GY-98), once a minute and beside the tick,
    // never in it (GY-1381): its ledger read held the whole tick on 2026-09-23. On unless
    // GRAPHYARD_INTERVENTION_PATTERNS=0.
    scanning = startPatternScan(async () => {
      for (const work of (await openPatternItems(engine, http.services.interventionPolicy)).opened) console.log(`Opened ${work.key} for a recurring intervention pattern: ${work.title}`);
      // The same window read by cause (GY-970): drafts for independent approval, never work items.
      for (const artefact of (await synthesizeRetro(engine.store, http.services.interventionPolicy)).drafted) console.log(`Drafted retro artefact ${artefact.id} (${artefact.kind}) for ${artefact.pattern.label}`);
    }, { failed: error => console.error('intervention pattern scan failed', error instanceof Error ? error.message : 'unknown') });
  };
  const [handle] = http.listeners('request') as ((req: IncomingMessage, res: ServerResponse) => void)[];
  http.removeAllListeners('request');
  http.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (!ready && refusedBeforeReady(req.method, req.url)) {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
      res.end(JSON.stringify({ error: 'Startup validation has not completed; retry shortly', retryable: true }));
      return;
    }
    handle(req, res);
  });

  let receiptsPrunedAt = 0, ledgerCompactedAt = 0;
  const reconciliation = startReconciliation(async step => {
    if (!ready) { await step('validation.startup', () => runStartupValidation()); if (!ready) return; }
    // The delivery sweep is bounded per tick and resumes from its persisted cursor, so a
    // backlog of observations drains across ticks without ever skipping one.
    await step('validation.expireArtifacts', () => validation.expireArtifacts()); await step('validation.reconcile', () => validation.reconcile());
    await step('engine.reconcile', () => engine.reconcile()); await step('delivery.sweep', () => delivery.sweep());
    await step('projectFlow', () => projectFlow(engine.store, { batches: 4 }));
    // Bounded, on the pool, never under the coordination lock: receipts past the replay window go.
    if (Date.now() - receiptsPrunedAt >= receiptPruneIntervalMs) { receiptsPrunedAt = Date.now(); await step('pruneReceipts', () => pruneReceipts(store.pool).catch(error => { console.error('receipt pruning failed', error instanceof Error ? error.message : 'unknown'); return 0; })); }
    // Routine ledger rows past the retention window go in bounded, audited batches (store/compaction.ts).
    if (Date.now() - ledgerCompactedAt >= ledgerCompactionIntervalMs) { ledgerCompactedAt = Date.now(); await step('compactLedger', () => compactLedger(store.pool, { retentionMs: configuredLedgerRetentionMs() }).catch(error => { console.error('ledger compaction failed', error instanceof Error ? error.message : 'unknown'); return null; })); }
    if (github) {
      const preflight = await step('github.preflight', () => github.preflightIfDue());
      if (preflight) await announcePreflight(preflight);
    }
  }, 2000);
  http.listen(options.port ?? Number(process.env.PORT ?? 4310), options.host ?? process.env.HOST ?? '127.0.0.1', () => console.log(`Graphyard listening on port ${(http.address() as AddressInfo).port}; GitHub ${github ? 'connected' : 'not configured'}`));
  await once(http, 'listening');
  void runStartupValidation();

  const close = async () => {
    closing = true;
    reconciliation.stop(); watching?.stop(); watching = null; await observing?.stop(); observing = null; await scanning?.stop(); scanning = null; retroIndex.stop();
    process.off('SIGTERM', shutdown); process.off('SIGINT', shutdown);
    await new Promise<void>(resolve => http.close(() => resolve()));
    await Promise.resolve(githubCache?.close());
    await store.close();
  };
  const shutdown = () => { void close().then(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  return { http, store, validation, runStartupValidation, isReady: () => ready, close };
}

/**
 * Whether a request is refused while startup validation runs (GY-1127): every mutation under /api
 * except a GitHub webhook delivery, which only wakes durable jobs, and a work lease heartbeat,
 * which reads no validation state and would otherwise lapse leases for the whole startup window.
 * Reads stay open, and /healthz answers liveness throughout.
 */
export function refusedBeforeReady(method = 'GET', url = '/'): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  const path = new URL(url, 'http://localhost').pathname;
  return path.startsWith('/api/') && path !== '/api/github/webhook' && !/^\/api\/work\/[^/]+\/heartbeat$/.test(path);
}

export type ReconciliationStep = <T>(name: string, run: () => Promise<T>) => Promise<T>;

/**
 * The database pool and the observation workers, configured together (GY-492, GY-1114):
 * `GRAPHYARD_DATABASE_POOL_SIZE` connections (default 16) and `GRAPHYARD_OBSERVATION_CONCURRENCY`
 * workers (default 8), never more than half the pool — the background share; a worker beyond it
 * only queues on a connection the API and the tick need. Naming only the workers grows the pool to
 * fit them; naming the pool caps the workers at half of it. The default keeps the merge and review
 * bands inside their freshness bounds at 100 open items (tests/observation-capacity.test.ts), and
 * every worker waits for the one shared pace before it claims (GY-567), so extra workers raise
 * throughput only as far as GitHub's budget to the reset allows.
 */
export const defaultDatabasePoolSize = 16, defaultObservationConcurrency = 8;
export function observationCapacity(env: Record<string, string | undefined> = process.env) {
  const count = (value: string | undefined) => { const parsed = Number(value); return value && Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null; };
  const workers = count(env.GRAPHYARD_OBSERVATION_CONCURRENCY), pool = count(env.GRAPHYARD_DATABASE_POOL_SIZE);
  const poolMax = Math.max(2, pool ?? Math.max(defaultDatabasePoolSize, 2 * (workers ?? 0)));
  return { poolMax, concurrency: Math.max(1, Math.min(workers ?? defaultObservationConcurrency, Math.floor(poolMax / 2))) };
}
/** The worker count for a pool of `poolMax` connections, from the environment's configured workers. */
export const observationConcurrency = (poolMax = defaultDatabasePoolSize) => observationCapacity({ GRAPHYARD_OBSERVATION_CONCURRENCY: process.env.GRAPHYARD_OBSERVATION_CONCURRENCY, GRAPHYARD_DATABASE_POOL_SIZE: String(poolMax) }).concurrency;

/**
 * The observation workers (GY-492): `concurrency` long-lived loops beside the reconciliation tick,
 * as the production watch is. Each claims one due job at a time — SKIP LOCKED in `takeJob` means
 * two workers never hold the same job — processes it, and looks for the next at once, waiting
 * `idleMs` only when nothing is due. The tick's four-jobs-per-tick batch used to serialise behind
 * its slowest job, so a queue thirty entries deep left the merge-queue head minutes without an
 * observation; workers that keep claiming while jobs are due are what drains a backlog and keeps
 * the head observed at its twenty-second cadence.
 *
 * Before each claim a worker takes a slot from the shared pace (`GitHub.paceObservation`, GY-567)
 * and waits when there is none, so all of them together spend the budget above the merge-path
 * reserve evenly until its reset; the slot is returned with what the job actually charged.
 */
export async function observationWorkers(engine: Engine, github: GitHub, concurrency: number, stopped: () => boolean = () => false, idleMs = 1000): Promise<void> {
  const worker = async () => {
    while (!stopped()) {
      const slot = github.paceObservation?.();
      if (slot && !slot.settle) { await new Promise(resolve => setTimeout(resolve, Math.min(slot.wait, idleMs * 5))); continue; }
      let claimed = false, charged: number | undefined;
      try { claimed = await processJob(engine, github, cost => { charged = cost; }); }
      catch (error) { console.error('observation worker job failed', error instanceof Error ? error.message : 'unknown'); }
      // An unclaimed slot charged nothing; a job that failed before its cost was known keeps its estimate.
      finally { slot?.settle(claimed ? charged : 0, Date.now()); }
      if (!claimed) await new Promise(resolve => setTimeout(resolve, idleMs));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.floor(concurrency)) }, worker));
}

/** Start the observation workers for the process's lifetime; `stop` resolves once each has finished its current job. */
export function startObservationWorkers(engine: Engine, github: GitHub, concurrency = observationConcurrency(engine.store.pool.options.max)) {
  let stopped = false;
  const done = observationWorkers(engine, github, concurrency, () => stopped)
    .catch(error => console.error('observation workers stopped', error instanceof Error ? error.message : 'unknown'));
  return { concurrency, stop: () => { stopped = true; return done; } };
}

/**
 * The serial reconciliation tick: one run at a time every `intervalMs`, each named step timed, and a
 * tick that never finishes reported with the step it is stuck in. Anything that may wait on a slow
 * provider for minutes (the production watch) runs on its own timer instead of as a step here.
 */
export function startReconciliation(tick: (step: ReconciliationStep) => Promise<void>, intervalMs = 2000) {
  let running = false, tickStartedAt = 0, stallReportedAt = 0, tickStep = 'idle';
  const timer = setInterval(async () => {
    if (running) {
      // A tick that never finishes stops every later one, so name the step it is stuck in.
      if (Date.now() - tickStartedAt > 60_000 && Date.now() - stallReportedAt > 60_000) { stallReportedAt = Date.now(); console.error(`reconciliation tick stuck ${Math.round((Date.now() - tickStartedAt) / 1000)}s in ${tickStep}`); }
      return;
    }
    running = true; tickStartedAt = Date.now();
    const step: ReconciliationStep = async (name, run) => { tickStep = name; const started = Date.now(); try { return await run(); } finally { if (Date.now() - started > 10_000) console.error(`reconciliation step ${name} took ${Date.now() - started} ms`); } };
    try { await tick(step); }
    catch (error) { console.error('reconciliation failed', error instanceof Error ? error.message : 'unknown'); }
    finally { running = false; tickStep = 'idle'; }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}

/**
 * How long one reconcile batch may run before it yields (default 250 ms). Each batch re-reads the
 * fleet (GY-392), so a large installation reads less with longer batches, at the cost of a lease
 * renewal waiting up to one batch. Bounded to 100..5000 ms; anything else keeps the default.
 */
export function reconcileBatchMs(value: string | undefined, fallback = 250): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 5000 ? parsed : fallback;
}
