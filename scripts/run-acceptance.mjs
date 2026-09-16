// This controller stays outside the untrusted candidate container and receives no producer token.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { exercise, requiredCases } from './acceptance-contract.mjs';

const [metadataFile, image, output] = process.argv.slice(2);
if (!metadataFile || !image || !output) throw new Error('Usage: run-acceptance metadata.json image output.json');
const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
const scratch = await mkdtemp(join(tmpdir(), 'graphyard-acceptance-'));
const suffix = randomBytes(6).toString('hex'), network = `gy-${suffix}`, db = `${network}-db`, app = `${network}-app`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let result = { ...metadata, schema: 1, proof: 'integration:claim-safety', result: 'fail', cases: requiredCases.map(id => ({ id, result: 'skipped' })), executed: 0, skipped: requiredCases.length };
try {
  docker('network', 'create', network);
  docker('run', '-d', '--name', db, '--network', network, '--network-alias', 'database', '-e', 'POSTGRES_PASSWORD=acceptance-only', '-e', 'POSTGRES_DB=graphyard', 'postgres:17-alpine');
  let databaseReady = false;
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', db, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) { databaseReady = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!databaseReady) throw new Error('Isolated database did not become ready');
  const principals = [{ id: 'probe-operator', role: 'admin', token: randomBytes(32).toString('hex') }, ...Array.from({ length: 32 }, (_, i) => ({ id: `probe-worker-${i}`, role: 'worker', token: randomBytes(32).toString('hex') }))];
  const envFile = join(scratch, 'candidate.env');
  await writeFile(envFile, `DATABASE_URL=postgres://postgres:acceptance-only@database:5432/graphyard\nHOST=0.0.0.0\nPORT=4310\nGRAPHYARD_PRINCIPALS=${JSON.stringify(principals)}\n`, { mode: 0o600 });
  docker('run', '-d', '--name', app, '--network', network, '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=1g', '--cpus=2', '--pids-limit=256', '--env-file', envFile, '-p', '127.0.0.1::4310', image);
  const port = docker('port', app, '4310/tcp');
  if (!/^127\.0\.0\.1:\d+$/.test(port)) throw new Error('Unexpected container port');
  const url = `http://${port}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) }); if (r.ok) { ready = true; break; } } catch { /* startup */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!ready) throw new Error('Candidate did not become healthy');
  const cases = await exercise(url, principals);
  result = { ...result, result: 'pass', cases, executed: cases.length, skipped: 0 }; console.log(`Trusted acceptance completed: ${cases.length} cases passed.`);
} catch { console.error('Trusted acceptance failed. No passing evidence was produced.'); process.exitCode = 1; }
finally {
  // Do not print candidate logs: candidate-controlled output may contain test credentials.
  spawnSync('docker', ['rm', '-f', app, db], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  await rm(scratch, { recursive: true, force: true });
  await writeFile(resolve(output), JSON.stringify(result, null, 2));
}
