// The head's control plane for the merge trial's E2E cases (GY-2969), as graphyard.json's
// e2e.serve declares it:
//
//   node --import tsx scripts/e2e-serve.mjs
//
// It starts the local runtime (src/install/local-runtime.ts: embedded Postgres, migrations, the
// control plane) against a fresh database under TMPDIR — its cluster a copy of the warm template
// cluster and its database a clone of the migrated template (src/e2e/warm-postgres.ts) — serving
// 127.0.0.1:4391 with one admin principal whose token is GRAPHYARD_E2E_TOKEN (the token the trial's cases authenticate with; one
// is made and printed when unset). On SIGTERM or SIGINT it stops the server and the database and
// removes the database directory. No credential is read. A case that seeds its own records
// (scripts/e2e-seed-plain-status.mjs) reads the database URL from .graphyard/e2e-serve.json.
// The loop's item-preview step runs beside it (GY-3193), so a preview case's items gain their previews.
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localPaths, startLocalRuntime } from '../src/install/local-runtime.ts';
import { copyTemplateCluster, templateDatabase, warmPassword } from '../src/e2e/warm-postgres.ts';
import { deliveryFixture } from './e2e-delivery-fixture.mjs';
import { startPreviewLoop } from './e2e-preview-loop.mjs';

const e2eServePort = 4391;

const freePort = () => new Promise((accept, reject) => {
  const server = createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => accept(port)); });
});

const token = process.env.GRAPHYARD_E2E_TOKEN || randomBytes(24).toString('hex');
if (!process.env.GRAPHYARD_E2E_TOKEN) console.log(`GRAPHYARD_E2E_TOKEN unset; the admin token is ${token}`);
const directory = await mkdtemp(join(tmpdir(), 'graphyard-e2e-serve-'));
const seedFile = join('.graphyard', 'e2e-serve.json');
const removeDirectory = () => Promise.all([rm(directory, { recursive: true, force: true }), rm(seedFile, { force: true })]);
const paths = localPaths(directory);
let runtime, previews;
try {
  const delivery = await deliveryFixture(directory);
  const workerToken = randomBytes(24).toString('hex'), coordinatorToken = randomBytes(24).toString('hex');
  const databasePort = await freePort();
  await mkdir(paths.postgres, { recursive: true, mode: 0o700 });
  await copyTemplateCluster(paths.data, databasePort);
  await writeFile(paths.passwordFile, warmPassword, { mode: 0o600 });
  await writeFile(paths.portFile, String(databasePort));
  await writeFile(paths.environment, JSON.stringify({
    PORT: String(e2eServePort), HOST: '127.0.0.1',
    GITHUB_REPOSITORY: 'cryptob1/graphyard',
    GRAPHYARD_REPOSITORY_ROOT: delivery.root,
    GRAPHYARD_PRINCIPALS: JSON.stringify([
      { id: 'e2e-operator', role: 'admin', sessionKind: 'human', token },
      { id: 'e2e-worker', role: 'worker', token: workerToken },
      { id: 'e2e-coordinator', role: 'coordinator', token: coordinatorToken },
    ]),
  }), { mode: 0o600 });
  runtime = await startLocalRuntime(directory, { template: templateDatabase });
  await mkdir('.graphyard', { recursive: true });
  await writeFile(seedFile, JSON.stringify({ databaseUrl: runtime.databaseUrl, delivery: { ...delivery, workerToken, coordinatorToken } }), { mode: 0o600 });
  previews = startPreviewLoop({ url: runtime.url, token: coordinatorToken, root: delivery.root, base: join(directory, 'previews') });
  // The trial waits for /healthz?ready to answer 200: mutations are refused until startup validation completes.
  console.log(`Graphyard e2e serve at ${runtime.url} on a database in ${directory}`);
} catch (error) {
  await removeDirectory();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let stopping = null;
const shutdown = () => {
  stopping ??= previews.stop().then(() => runtime.stop()).catch(error => console.error(error instanceof Error ? error.message : String(error)))
    .finally(() => removeDirectory()).finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 30_000).unref();
};
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
runtime.cluster.process.once('exit', code => { if (stopping) return; console.error(`Postgres exited (${code})`); shutdown(); });
