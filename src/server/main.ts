import { Store } from '../store.js';
import { Engine } from '../engine.js';
import { demand, parseReviewerApps } from '../model.js';
import { githubFromEnv, processJob } from '../github.js';
import { Validation } from '../validation.js';
import { Delivery } from '../delivery.js';
import { ProofGrants } from '../proof-grants.js';
import { artifactBackendFromEnv, artifactCapacityFromEnv } from '../artifacts.js';
import { principalSchema, server } from './index.js';

/** Process entry: configuration, migration, the HTTP server and the reconciliation tick. */
export async function main() {
  try { process.loadEnvFile(); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const credentials = principalSchema.parse(JSON.parse(process.env.GRAPHYARD_PRINCIPALS ?? '[]'));
  demand(new Set(credentials.map(p => p.id)).size === credentials.length && new Set(credentials.map(p => p.token)).size === credentials.length, 'Principal IDs and tokens must be unique');
  const store = new Store(process.env.DATABASE_URL ?? 'postgres://graphyard:graphyard@localhost:5438/graphyard');
  await store.init();
  const engine = new Engine(store, (process.env.GITHUB_CI_APP_IDS ?? '15368').split(',').map(Number));
  engine.reviewerApps = parseReviewerApps(process.env.GRAPHYARD_REVIEWER_APPS);
  const github = await githubFromEnv();
  const artifacts = { backend: artifactBackendFromEnv(), capacityBytes: artifactCapacityFromEnv() };
  const http = server(engine, credentials, github, artifacts);
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
  const timer = setInterval(async () => {
    if (running) return; running = true;
    // The delivery sweep is bounded per tick and resumes from its persisted cursor, so a
    // backlog of observations drains across ticks without ever skipping one.
    try { await validation.expireArtifacts(); await validation.reconcile(); await engine.reconcile(); await delivery.sweep(); if (github) await Promise.all(Array.from({ length: 4 }, () => processJob(engine, github))); }
    catch (error) { console.error('reconciliation failed', error instanceof Error ? error.message : 'unknown'); }
    finally { running = false; }
  }, 2000);
  http.listen(Number(process.env.PORT ?? 4310), process.env.HOST ?? '127.0.0.1', () => console.log(`Graphyard listening on port ${process.env.PORT ?? 4310}; GitHub ${github ? 'connected' : 'not configured'}`));
  const shutdown = () => { clearInterval(timer); http.close(() => { void store.close().then(() => process.exit(0)); }); setTimeout(() => process.exit(1), 10_000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
