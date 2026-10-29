import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { MERGE_PROTOCOL } from '../src/protocol-version.js';
import type { Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-2934: since GY-2876 a coordinator's roster entry may carry --proof patterns (the install's master
 * carries manual:*), and the loop refused every such credential, so it never started. The loop now runs
 * on it; evidence submission still refuses the coordinator whatever its patterns.
 */
const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master', role: 'coordinator', proofs: ['manual:*'] };
let pg: EmbeddedPostgres, store: Store, engine: Engine;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2934;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('coordinator-proofs-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('coordinator_proofs');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/coordinator_proofs`); await store.init();
  engine = new Engine(store, 120, 'owner/project'); engine.submissionObserver = null; engine.directMergeEnvironment = null;
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

test('unit:loop-accepts-coordinator-proof-patterns — master run --once runs a cycle on a coordinator credential whose roster entry carries a proof pattern, and that credential\'s evidence submission is refused', async () => {
  const root = await temporaryDirectory('coordinator-proofs-run');
  const credentialDirectory = await temporaryDirectory('coordinator-proofs-credentials');
  const credentialFile = join(credentialDirectory, 'coordinator.token');
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/status') return res.end(JSON.stringify({ actor: coordinator, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, build: { commit: null, protocol: MERGE_PROTOCOL } }));
    if (req.url === '/api/work-snapshot') return res.end(JSON.stringify({ now: new Date().toISOString(), work: [] }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  try {
    await exec('git', ['init', '-q'], { cwd: root });
    await exec('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    await mkdir(join(root, '.graphyard'));
    await writeFile(join(root, '.graphyard/master.json'), JSON.stringify({ version: 1, url, credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { intervalSeconds: 5, deploymentShaField: 'commit' } }), { mode: 0o600 });
    const env = { ...process.env, GRAPHYARD_URL: url, GRAPHYARD_TOKEN: undefined, GRAPHYARD_TOKEN_FILE: undefined };
    const run = JSON.parse((await exec(process.execPath, [launcher, 'master', 'run', '--once'], { cwd: root, env })).stdout);
    assert.equal(run.coordinator, 'master');
    assert.equal(run.cycles, 1, 'the cycle ran');
    assert.equal(run.failedCycles, 0);
  } finally {
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true });
  }

  let w = await engine.execute(operator, 'create', null, { type: 'chore',  title: 'Proven by hand', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['manual:checked'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  await assert.rejects(engine.execute(coordinator, 'evidence', w.id, { proof: 'manual:checked', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: w.policyRevision, result: 'pass', executed: 1, skipped: 0 }, randomUUID()),
    /Evidence submission is not permitted/, 'a coordinator never submits evidence, whatever its patterns');
});
