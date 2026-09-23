import { Store } from '../store.js';
import { Engine } from '../engine.js';
import { demand, parseReviewerApps } from '../model.js';
import { githubFromEnv, installationFingerprint, processJob, type AppPermissionReport } from '../github.js';
import { Validation } from '../validation.js';
import { Delivery } from '../delivery.js';
import { ProofGrants } from '../proof-grants.js';
import { artifactBackendFromEnv, artifactCapacityFromEnv } from '../artifacts.js';
import { projectFlow } from '../flow-analytics.js';
import { openPatternItems } from '../interventions.js';
import { principalSchema, server } from './index.js';
import { buildIdentity } from '../protocol-version.js';
import { ProductionWatch, railwayProvider } from '../production-watch.js';
import { configuredGeneratedFiles } from '../generated-files.js';
import { generatedFilesVariable } from '../install/generated-files.js';

/** Process entry: configuration, migration, the HTTP server and the reconciliation tick. */
export async function main() {
  try { process.loadEnvFile(); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  // An unparseable generated-files declaration refuses start-up with a clear message instead of
  // silently exempting nothing; the regression guard runs with exactly this parsed set.
  const generatedFiles = configuredGeneratedFiles();
  const credentials = principalSchema.parse(JSON.parse(process.env.GRAPHYARD_PRINCIPALS ?? '[]'));
  demand(new Set(credentials.map(p => p.id)).size === credentials.length && new Set(credentials.map(p => p.token)).size === credentials.length, 'Principal IDs and tokens must be unique');
  const store = new Store(process.env.DATABASE_URL ?? 'postgres://graphyard:graphyard@localhost:5438/graphyard');
  await store.init();
  const engine = new Engine(store, (process.env.GITHUB_CI_APP_IDS ?? '15368').split(',').map(Number));
  engine.reviewerApps = parseReviewerApps(process.env.GRAPHYARD_REVIEWER_APPS);
  const github = await githubFromEnv();
  // Startup preflight: a permission shortfall is announced before the first job can run
  // into it, and the jobs that need the missing permission are held rather than retried.
  // A passing preflight (startup or periodic) releases holds decided against a different
  // installation, including holds left by an earlier process; a hold decided against this same
  // installation (a 403 the declaration does not explain) keeps its bounded expiry.
  const announcePreflight = async (report: AppPermissionReport) => {
    for (const line of report.attention) console.error(`GitHub App permissions: ${line}`);
    if (!report.error && !report.suspended && !report.missing.length) await store.releaseHeldJobs(installationFingerprint(report));
  };
  if (github) await announcePreflight(await github.preflight());
  const artifacts = { backend: artifactBackendFromEnv(), capacityBytes: artifactCapacityFromEnv() };
  // The producers this installation already ran with. An over-limit roster of these starts
  // with a warning; only a principal added beyond the limit refuses, naming the variable.
  const knownPrincipals = (await store.pool.query('SELECT principal_id FROM proof_grants')).rows.map(row => String(row.principal_id));
  const build = buildIdentity();
  const provider = railwayProvider();
  const production = new ProductionWatch(store, { provider, github, build, baseBranch: github?.config.base ?? process.env.GITHUB_BASE_BRANCH ?? 'main' });
  const http = server(engine, credentials, github, artifacts, { knownPrincipals, production });
  // The deployed-variables record the status route reports gains the generated-files variable the
  // installers set beside GRAPHYARD_PRINCIPALS, so master status can compare what the deployment
  // runs with against the managed repository's manifest and name the command that fixes it.
  http.services.delegationLimits.deployed[generatedFilesVariable] = process.env.GRAPHYARD_GENERATED_FILES ?? null;
  for (const line of http.services.delegationLimits.attention) console.error(`Delegation limits: ${line}`);
  console.log(`Generated files: ${generatedFiles.length ? generatedFiles.join(', ') : 'none declared; the regression guard exempts nothing'}`);
  console.log(`Build ${build.commit ?? 'commit unknown'} (merge protocol ${build.protocol}); production observation ${provider ? `via ${provider.description}` : build.commit ? 'from the build identity only; set RAILWAY_API_TOKEN or RAILWAY_TOKEN to read the deployment list' : 'unavailable: set GRAPHYARD_BUILD_SHA or RAILWAY_GIT_COMMIT_SHA'}`);
  await production.load().catch(error => console.error('production incidents could not be loaded', error instanceof Error ? error.message : 'unknown'));
  // One-time materialization of the deployment allowlist. Operators manage proof authority
  // inside Graphyard from here on; a later environment edit no longer changes authority.
  const seeded = await new ProofGrants(store, credentials.map(({ token, ...actor }) => actor)).seed();
  if (seeded.length) console.log(`Seeded proof grants for ${seeded.map(grant => grant.principalId).join(', ')}`);
  const validation = new Validation(engine, credentials.map(({ token, ...actor }) => actor), github?.config.repository ?? process.env.GITHUB_REPOSITORY ?? '');
  validation.artifactBackend = artifacts.backend; validation.artifactCapacityBytes = artifacts.capacityBytes;
  const delivery = new Delivery(validation);
  console.log(`Artifact storage: ${artifacts.backend?.label ?? 'postgres'}; capacity ${artifacts.capacityBytes} bytes`);
  await validation.expireArtifacts();
  await validation.reconcile(true);
  let running = false;
  // A recurring intervention becomes work on its own (GY-98): the detection reads the ledger, so
  // it runs once a minute rather than every tick.
  let patternsAt = 0;
  const timer = setInterval(async () => {
    if (running) return; running = true;
    // The delivery sweep is bounded per tick and resumes from its persisted cursor, so a
    // backlog of observations drains across ticks without ever skipping one.
    try {
      await validation.expireArtifacts(); await validation.reconcile(); await engine.reconcile(); await delivery.sweep();
      await projectFlow(engine.store, { batches: 4 });
      if (Date.now() - patternsAt >= 60_000) {
        patternsAt = Date.now();
        for (const work of (await openPatternItems(engine, http.services.interventionPolicy)).opened) console.log(`Opened ${work.key} for a recurring intervention pattern: ${work.title}`);
      }
      // Provider polling is bounded inside the watch to once a minute; incidents it raises
      // land in the ledger and in /api/status, and are announced here once each.
      const before = production.status().incidents.map(incident => incident.id);
      for (const incident of (await production.tick()).incidents) if (!before.includes(incident.id)) console.error(`Deployment incident ${incident.key} (${incident.status}): ${incident.reason}`);
      if (github) {
        const preflight = await github.preflightIfDue();
        if (preflight) await announcePreflight(preflight);
        await Promise.all(Array.from({ length: 4 }, () => processJob(engine, github)));
      }
    }
    catch (error) { console.error('reconciliation failed', error instanceof Error ? error.message : 'unknown'); }
    finally { running = false; }
  }, 2000);
  http.listen(Number(process.env.PORT ?? 4310), process.env.HOST ?? '127.0.0.1', () => console.log(`Graphyard listening on port ${process.env.PORT ?? 4310}; GitHub ${github ? 'connected' : 'not configured'}`));
  const shutdown = () => { clearInterval(timer); http.close(() => { void store.close().then(() => process.exit(0)); }); setTimeout(() => process.exit(1), 10_000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
