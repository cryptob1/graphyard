import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal } from '../src/model.js';
import { checkoutRepositoryPolicy, defaultRepositoryPolicy, setRepositoryPolicy } from '../src/model/repository-policy.js';
import { defineScenario } from '../src/scenarios.js';
import { parseCase } from '../src/e2e/case.js';
import { projectCaseSuite } from '../src/release-project.js';
import type { E2eReport } from '../src/e2e/runner.js';
import { trialEnvironment } from '../src/merge-writer/trial.js';

// GY-2969: Graphyard's own graphyard.json declares e2e.serve, so its user-facing items can carry
// e2e: proofs. AC-1: the declared command serves this head's control plane and create-work-item
// passes against it; stopping it removes its database directory. AC-2: create accepts a feature
// carrying e2e:create-work-item under this head's policy.

const checkout = process.cwd();
const policy = checkoutRepositoryPolicy(checkout);

test('unit:graphyard-repo-serves-its-head-for-e2e — the declared serve command answers, create-work-item passes against it, and stopping it removes its database directory', { timeout: 240_000 }, async () => {
  const serve = policy.e2e.serve;
  assert.ok(serve, 'graphyard.json declares e2e.serve');
  const scratch = await temporaryDirectory('e2e-serve');
  const token = `trial-${randomUUID()}`;
  // The trial's environment: no credential, TMPDIR the trial's own.
  const child = spawn('sh', ['-c', serve.command], { cwd: checkout, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...trialEnvironment(process.env), TMPDIR: scratch, GRAPHYARD_E2E_TOKEN: token } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(accept => child.once('exit', accept));
  try {
    const deadline = Date.now() + serve.readySeconds * 1000;
    let answered = false;
    while (!answered && Date.now() < deadline && child.exitCode === null) {
      answered = await fetch(serve.url, { signal: AbortSignal.timeout(2_000) }).then(response => response.ok, () => false);
      if (!answered) await new Promise(accept => setTimeout(accept, 500));
    }
    assert.ok(answered, `${serve.url} answered within ${serve.readySeconds}s: ${output.slice(-2000)}`);
    const databases = readdirSync(scratch).filter(name => name.startsWith('graphyard-e2e-serve-'));
    assert.equal(databases.length, 1, 'the database lives in one temporary directory under TMPDIR');

    const file = 'e2e/cases/create-work-item.json';
    let report: E2eReport | null = null;
    await projectCaseSuite(checkout, token, { cases: [{ file, definition: parseCase(file, readFileSync(join(checkout, file), 'utf8')) }], select: () => true,
      withholdSecrets: true, artifactsDirectory: join(scratch, 'artifacts'), signal: AbortSignal.timeout(60_000), report: value => { report = value; } })
      .run(new URL(serve.url).origin, null);
    const outcome = (report as E2eReport | null)?.cases.find(entry => entry.id === 'create-work-item');
    assert.equal(outcome?.verdict, 'passed', JSON.stringify(outcome?.failingStep ?? outcome));

    process.kill(-child.pid!, 'SIGTERM');
    await exited;
    assert.deepEqual(readdirSync(scratch).filter(name => name.startsWith('graphyard-e2e-serve-')), [], 'stopping the command removes its database directory');
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
  }
});

let pg: InstanceType<typeof EmbeddedPostgres>, store: Store, engine: Engine;
const operator: Principal = { id: 'operator', role: 'admin' };

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2969;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('graphyard-e2e-serve'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('graphyard_e2e_serve_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_e2e_serve_test`); await store.init();
  engine = new Engine(store, 120, 'cryptob1/graphyard');
  engine.operatorAuthorizer = async (_db, _now, actor) => actor;
});
after(async () => { setRepositoryPolicy(defaultRepositoryPolicy); if (store) await store.close(); if (pg) await pg.stop(); });

test('unit:graphyard-feature-with-e2e-proof-accepted — create accepts a feature for cryptob1/graphyard whose criterion carries e2e:create-work-item under this head’s policy', async () => {
  setRepositoryPolicy(policy);
  await defineScenario(store, operator, { id: 'create-work-item', title: 'An operator creates a work item and finds it in the work list', purpose: 'An operator creates a work item',
    steps: ['POST /api/work', 'GET /api/work'], expected: ['the item is listed'], environment: 'any', runner: 'graphyard-e2e', testPath: 'e2e/cases/create-work-item.json' }, randomUUID());
  const work = await engine.execute(operator, 'create', null, { title: 'A user-visible change', type: 'feature',
    criteria: [{ id: 'AC-1', text: 'An operator creates a work item', proofs: ['e2e:create-work-item'] }] }, randomUUID());
  assert.equal(work.type, 'feature');
  assert.deepEqual(work.criteria[0].proofs, ['e2e:create-work-item']);
});
