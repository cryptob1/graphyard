import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { runMergeTrial, trialFailureReason } from '../src/merge-writer/executor.js';
import { trialMerge } from '../src/merge-writer/trial.js';
import { defaultChildRun } from '../src/child-runner.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import type { Principal, Work } from '../src/model.js';
import { defaultRepositoryPolicy, setRepositoryPolicy } from '../src/model/repository-policy.js';
import { defineScenario } from '../src/scenarios.js';

// GY-2973: an item may carry an e2e: proof whose case it adds itself; create and requirements
// require no registration first. AC-1: a feature item created on a repository that declares
// e2e.serve with a criterion carrying e2e:brand-new-case, unregistered, is accepted; the trial
// refuses a head without e2e/cases/brand-new-case.json naming the missing case, and a head that
// adds the case runs it.

const identity = {
  GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com',
  GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();

const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2973;
const serveUrl = `http://127.0.0.1:${port + 1}`;
const servePolicy = { ...defaultRepositoryPolicy, e2e: { pendingOutcomes: 'non-blocking' as const, serve: { command: 'true', url: serveUrl, readySeconds: 1 } } };
const serveScript = `require('node:http').createServer((request, response) => { response.writeHead(200, {'Content-Type':'application/json'}); response.end(JSON.stringify({ message: 'served' })); }).listen(${port + 1}, '127.0.0.1');\n`;
const passingCase = {
  id: 'brand-new-case', title: 'The brand-new case runs', target: 'any', required: false,
  steps: [{ kind: 'http', method: 'GET', path: '/', status: 200, expect: [{ path: 'message', equals: 'served' }] }],
};

const operator: Principal = { id: 'operator', role: 'admin' };

let pg: InstanceType<typeof EmbeddedPostgres>, store: Store, engine: Engine;
let fixtureRoot: string, root: string, base: string, head: string, baseTip: string;

const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
const gitOfRoot = (args: readonly string[]) => defaultChildRun('git', ['-C', root, ...args]);
const trial = (mergeSha: string, changed: string[]) => runMergeTrial({
  root, base, mergeSha, changedFiles: changed, proofs: [], e2eProofs: ['e2e:brand-new-case'], proofFiles: [],
  timeoutMs: 120_000, key: 'GY-2973', environment: { PATH: process.env.PATH!, HOME: process.env.HOME! }, retries: 0,
});

before(async () => {
  setRepositoryPolicy(servePolicy);
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('create-added-case-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('create_added_case_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/create_added_case_test`); await store.init();
  engine = new Engine(store, 120, 'owner/project');

  // The fixture repository, whose head an e2e.serve declaration serves for the trial.
  fixtureRoot = await temporaryDirectory('create-added-case-fixture', tmpdir());
  root = join(fixtureRoot, 'repo');
  mkdirSync(root, { recursive: true });
  gitIn(root, 'init', '-q', '-b', 'main');
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { test: 'node --eval 0' } }));
  write('graphyard.json', JSON.stringify({ e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'node serve.js', url: serveUrl, readySeconds: 10 } } }));
  write('serve.js', serveScript);
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'base');
  baseTip = gitIn(root, 'rev-parse', 'HEAD');
  write('src/change.ts', 'export const change = 1;\n');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'change');
  head = gitIn(root, 'rev-parse', 'HEAD');
  base = join(fixtureRoot, 'managed');
  engine.gitRunner = gitRunnerFor(root);
  engine.baseBranch = 'main';
});
after(async () => {
  setRepositoryPolicy(defaultRepositoryPolicy);
  if (store) await store.close();
  if (pg) await pg.stop();
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

test('unit:create-accepts-e2e-case-the-item-adds — create accepts an unregistered e2e: proof, the trial refuses a head without the case, and a head that adds it runs it', async () => {
  // The scenario registry holds no brand-new-case (this repository ships no revisions and none
  // was defined): create accepts the item anyway, pinning nothing.
  const work = await engine.execute(operator, 'create', null, {
    title: 'A user-visible change with a case of its own',
    criteria: [{ id: 'AC-1', text: 'The brand-new case runs', proofs: ['e2e:brand-new-case'] }],
  }, randomUUID()) as Work;
  assert.deepEqual(work.scenarioRequirements, [], 'the unregistered scenario pins nothing');
  // A registered scenario still pins: the same create citing one the registry holds.
  await defineScenario(store, operator, { id: 'registered-now', title: 'Registered mid-flight', purpose: 'Registered mid-flight',
    steps: ['open /'], expected: ['it holds'], environment: 'any', runner: 'graphyard-e2e', testPath: 'e2e/cases/registered-now.json' }, randomUUID());
  const pinned = await engine.execute(operator, 'create', null, {
    title: 'Another user-visible change',
    criteria: [{ id: 'AC-1', text: 'Holds', proofs: ['e2e:registered-now'] }],
  }, randomUUID()) as Work;
  assert.equal(pinned.scenarioRequirements.length, 1, 'a registered scenario pins as before');

  // The trial refuses the head that does not carry the case, naming it.
  const merged = await trialMerge(gitOfRoot, { head, baseTip });
  assert.ok('mergeSha' in merged);
  const missing = await trial(merged.mergeSha, ['src/change.ts']);
  assert.match(trialFailureReason({ run: missing })!, /^trial failed: e2e:brand-new-case has no case at e2e\/cases\/brand-new-case\.json$/);

  // The head that adds the case the item cited: the trial serves the head and runs the case.
  gitIn(root, 'checkout', '-q', '--detach', head);
  write('e2e/cases/brand-new-case.json', JSON.stringify(passingCase));
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'the case the item adds');
  const withCase = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'checkout', '-q', 'main');
  const added = await trialMerge(gitOfRoot, { head: withCase, baseTip });
  assert.ok('mergeSha' in added);
  const ran = await trial(added.mergeSha, ['src/change.ts', 'e2e/cases/brand-new-case.json']);
  assert.deepEqual(ran.proofs['e2e:brand-new-case'], { executed: 1, failed: 0 }, ran.logTail);
  assert.equal(trialFailureReason({ run: ran }), null);
});
