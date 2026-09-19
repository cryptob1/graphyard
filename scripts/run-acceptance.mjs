// This controller stays outside the untrusted candidate container and receives no producer token.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { contract } from './contracts.mjs';

const [metadataFile, image, output, proof = 'integration:claim-safety'] = process.argv.slice(2);
if (!metadataFile || !image || !output) throw new Error('Usage: run-acceptance metadata.json image output.json [proof]');
const { exercise, createInventory, candidate = httpCandidate, kind = 'integration' } = contract(proof);
if (kind !== 'integration') throw new Error(`${proof} is a ${kind} contract; run-unit-acceptance.mjs executes it against the prepared candidate checkout`);
const harness = fileURLToPath(new URL('.', import.meta.url));
const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
const scratch = await mkdtemp(join(tmpdir(), 'graphyard-acceptance-'));
const suffix = randomBytes(6).toString('hex'), network = `gy-${suffix}`, db = `${network}-db`, app = `${network}-app`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// The inventory is bound to the selected proof and filled in as cases run, so an interruption
// still reports the completed, failing and genuinely unexecuted parts instead of an all-skipped report.
const inventory = createInventory();
let passed = false;
try {
  docker('network', 'create', network);
  docker('run', '-d', '--name', db, '--network', network, '--network-alias', 'database', '-e', 'POSTGRES_PASSWORD=acceptance-only', '-e', 'POSTGRES_DB=graphyard', 'postgres:17-alpine');
  let databaseReady = false;
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', db, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) { databaseReady = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!databaseReady) throw new Error('Isolated database did not become ready');
  // Most contracts drive the image's own entrypoint over HTTP. A contract that needs provider
  // facts the candidate exposes no route for describes a protected launcher instead; either way
  // the candidate runs under the same containment and this process performs every judgement.
  const session = candidate({ harness });
  const envFile = join(scratch, 'candidate.env');
  const env = { DATABASE_URL: 'postgres://postgres:acceptance-only@database:5432/graphyard', ...session.env, GRAPHYARD_PRINCIPALS: JSON.stringify(session.principals) };
  await writeFile(envFile, Object.entries(env).map(([name, value]) => `${name}=${value}\n`).join(''), { mode: 0o600 });
  docker('run', '-d', '--name', app, '--network', network, '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=1g', '--cpus=2', '--pids-limit=256', '--env-file', envFile,
    ...Object.values(session.ports).flatMap(port => ['-p', `127.0.0.1::${port}`]), ...(session.args ?? []), image, ...(session.command ?? []));
  const urls = Object.fromEntries(Object.entries(session.ports).map(([name, port]) => {
    const bound = docker('port', app, `${port}/tcp`);
    if (!/^127\.0\.0\.1:\d+$/.test(bound)) throw new Error('Unexpected container port');
    return [name, `http://${bound}`];
  }));
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${urls.api}/healthz`, { signal: AbortSignal.timeout(1000) }); if (r.ok) { ready = true; break; } } catch { /* startup */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!ready) throw new Error('Candidate did not become healthy');
  await session.exercise(urls, inventory);
  passed = inventory.complete; console.log(`Trusted acceptance completed: ${inventory.executed} ${proof} cases passed.`);
} catch { console.error('Trusted acceptance failed. No passing evidence was produced.'); process.exitCode = 1; }
finally {
  // Do not print candidate logs: candidate-controlled output may contain test credentials.
  spawnSync('docker', ['rm', '-f', app, db], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  await rm(scratch, { recursive: true, force: true });
  const result = { ...metadata, schema: 1, proof, result: passed && inventory.complete ? 'pass' : 'fail',
    cases: inventory.cases, executed: inventory.executed, skipped: inventory.skipped };
  await writeFile(resolve(output), JSON.stringify(result, null, 2));
}

// The default candidate: the image's own entrypoint, disposable principals, HTTP only.
function httpCandidate() {
  const principals = [{ id: 'probe-operator', role: 'admin', token: randomBytes(32).toString('hex') }, ...Array.from({ length: 32 }, (_, i) => ({ id: `probe-worker-${i}`, role: 'worker', token: randomBytes(32).toString('hex') }))];
  return { principals, env: { HOST: '0.0.0.0', PORT: '4310' }, ports: { api: 4310 }, exercise: (urls, inventory) => exercise(urls.api, principals, inventory) };
}
