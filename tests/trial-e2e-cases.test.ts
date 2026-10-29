import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { evaluateLandability } from '../src/model/landability.js';
import { runMergeTrial, trialFailureReason } from '../src/merge-writer/executor.js';
import { trialMerge } from '../src/merge-writer/trial.js';
import { defaultChildRun } from '../src/child-runner.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import type { Principal, Work } from '../src/model.js';
import { defaultRepositoryPolicy, setRepositoryPolicy } from '../src/model/repository-policy.js';
import { mergeRecordBodySchema } from '../src/server/merge-record.js';
import { defaultMergeBatch } from '../src/merge-writer/batch.js';
import { runTrialE2eCases } from '../src/merge-writer/e2e-trial.js';
import { linkedCases } from '../src/model/test-cases.js';

// GY-2965 AC-2: the merge trial serves the head and runs its bound case. A head carrying
// e2e:home-shows-change is refused when e2e/cases/home-shows-change.json is absent, naming the
// path; when the case passes against the head served by the repository's e2e.serve, the item is
// landable and the run is a trusted run of the case on /api/tests; a failing step refuses the
// head naming the case and the step.

const identity = {
  GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com',
  GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();

const servePort = 20000 + (process.pid % 20_000);
const serveUrl = `http://127.0.0.1:${servePort}`;
const passingCase = {
  id: 'home-shows-change', title: 'The home page shows the change', target: 'any', required: false,
  steps: [{ kind: 'http', method: 'GET', path: '/', status: 200, expect: [{ path: 'message', equals: 'served' }] }],
};
const failingCase = { ...passingCase, steps: [{ kind: 'http', method: 'GET', path: '/', status: 200, expect: [{ path: 'message', equals: 'never said' }] }] };
const serveScript = `require('node:http').createServer((request, response) => { response.writeHead(200, {'Content-Type':'application/json'}); response.end(JSON.stringify({ message: 'served' })); }).listen(${servePort}, '127.0.0.1');\n`;

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator' };
const principals = [operator, worker, coordinator];
const tokens = new Map(principals.map(entry => [entry.id, `${entry.id}-${'t'.repeat(32)}`]));

let pg: InstanceType<typeof EmbeddedPostgres>, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let fixtureRoot: string, root: string, base: string, baseTip: string, head: string, branch: string;

const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
/** Commits `files` on the worker branch and answers the new head. */
async function commitFiles(files: Record<string, string>) {
  gitIn(root, 'checkout', '-q', '--detach', head);
  for (const [path, content] of Object.entries(files)) { write(path, content); gitIn(root, 'add', '-A'); }
  gitIn(root, 'commit', '-q', '-m', 'case');
  const next = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'checkout', '-q', 'main');
  head = next;
  return next;
}

before(async () => {
  setRepositoryPolicy({ ...defaultRepositoryPolicy, e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: serveUrl, readySeconds: 1 } } });
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 403;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('trial-e2e-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('trial_e2e_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/trial_e2e_test`); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.submissionObserver = null; engine.directMergeEnvironment = null;

  fixtureRoot = await temporaryDirectory('trial-e2e-fixture', tmpdir());
  root = join(fixtureRoot, 'repo');
  mkdirSync(root, { recursive: true });
  gitIn(root, 'init', '-q', '-b', 'main');
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { test: 'node --eval 0' } }));
  write('graphyard.json', JSON.stringify({ e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'node serve.js', url: serveUrl, readySeconds: 10 } } }));
  write('serve.js', serveScript);
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'base');
  baseTip = gitIn(root, 'rev-parse', 'HEAD');
  // The worker head: a branch holding the change; the serve declaration is the base's own.
  const worktree = join(root, 'head');
  gitIn(root, 'worktree', 'add', '-q', '-b', branch = 'graphyard/gy-2965-1', worktree, baseTip);
  write('src/change.ts', 'export const change = 1;\n');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'change');
  head = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'worktree', 'remove', '--force', worktree);
  base = join(fixtureRoot, 'managed');

  engine.gitRunner = gitRunnerFor(root);
  engine.baseBranch = 'main';
  http = server(engine, principals.map(entry => ({ ...entry, token: tokens.get(entry.id)! })), null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  if (pg) await pg.stop();
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

const gitOfRoot = (args: readonly string[]) => defaultChildRun('git', ['-C', root, ...args]);

const trial = async (mergeSha: string, changed: string[]) => runMergeTrial({
  root, base, mergeSha, changedFiles: changed, proofs: [], e2eProofs: ['e2e:home-shows-change'], proofFiles: [],
  timeoutMs: 120_000, key: 'GY-2965', environment: { PATH: process.env.PATH!, HOME: process.env.HOME! }, retries: 0,
});

async function call(path: string, actor: Principal, data?: unknown, key = randomUUID()) {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, body: await response.json() as any };
}

test('unit:trial-serves-head-and-runs-bound-cases — a head whose bound case is absent is refused naming the missing path', async () => {
  const merged = await trialMerge(gitOfRoot, { head, baseTip });
  assert.ok('mergeSha' in merged);
  const run = await trial(merged.mergeSha, ['src/change.ts']);
  assert.equal(run.build, 'pass');
  assert.deepEqual(run.proofs['e2e:home-shows-change'], { executed: 0, failed: 1 });
  assert.match(trialFailureReason({ run })!, /^trial failed: e2e:home-shows-change has no case at e2e\/cases\/home-shows-change\.json$/);
});

test('unit:trial-serves-head-and-runs-bound-cases — a passing case makes the item landable and records a trusted run of the case on /api/tests', async () => {
  const withCase = await commitFiles({ 'e2e/cases/home-shows-change.json': JSON.stringify(passingCase) });
  const merged = await trialMerge(gitOfRoot, { head: withCase, baseTip });
  assert.ok('mergeSha' in merged);
  const run = await trial(merged.mergeSha, ['src/change.ts', 'e2e/cases/home-shows-change.json']);
  assert.equal(run.build, 'pass');
  assert.deepEqual(run.proofs['e2e:home-shows-change'], { executed: 1, failed: 0 }, run.logTail);
  assert.equal(trialFailureReason({ run }), null);

  // The item: the trial record rides its ledger, and the verdict makes it landable.
  const defined = await call('scenarios', operator, { id: 'home-shows-change', title: 'The home page shows the change', purpose: 'The home page shows the change',
    steps: ['open /'], expected: ['the change is shown'], environment: 'any', runner: 'graphyard-e2e', testPath: 'e2e/cases/home-shows-change.json' });
  assert.equal(defined.status, 200, JSON.stringify(defined.body));
  let work = await engine.execute(operator, 'create', null, { title: 'The home page shows the change', criteria: [{ id: 'AC-1', text: 'The home page shows the change', proofs: ['e2e:home-shows-change'] }] }, randomUUID()) as Work;
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'machine-a', path: '/tmp/trial-e2e', branch }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, head: withCase }, randomUUID());
  const at = new Date().toISOString();
  const intent = await call(`work/${work.id}/merge-record`, coordinator, { kind: 'intent', head: withCase, baseTip, mergeSha: merged.mergeSha, risk: 'normal', at });
  assert.equal(intent.status, 200, JSON.stringify(intent.body));
  const recorded = await call(`work/${work.id}/merge-record`, coordinator, { kind: 'trial', head: withCase, baseTip, mergeSha: merged.mergeSha, outcome: 'verdict', build: 'pass',
    tests: { passed: 1, failed: [], files: 1 }, files: ['src/change.ts'], proofs: run.proofs, durationMs: 5, attempts: [],
    e2e: [{ proof: 'e2e:home-shows-change', case: 'home-shows-change', executed: 1, failed: 0 }] });
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  work = (await store.list()).find(entry => entry.id === work.id)!;
  assert.equal(evaluateLandability(work, [work], new Date()).verdict, 'landable');
  // The item's Tests panel shows the case as the trial of the current head ran it.
  const [shown] = linkedCases(work, null).linked;
  assert.equal(shown.head, 'pass');
  assert.deepEqual(shown.trial, { executed: 1, failed: 0 });

  // The case's run is a trusted run of that commit, listed with its history on /api/tests.
  const tests = await call('tests', operator);
  assert.equal(tests.status, 200);
  const entry = tests.body.cases.find((item: { id: string }) => item.id === 'home-shows-change');
  assert.ok(entry, JSON.stringify(tests.body.cases));
  assert.equal(entry.latest.result, 'pass');
  assert.equal(entry.latest.sha, merged.mergeSha);
  assert.equal(entry.latest.proof, 'e2e:home-shows-change');
  assert.ok(entry.runs >= 1);
  const history = await call('tests/home-shows-change/runs', operator);
  assert.equal(history.status, 200);
  assert.ok(history.body.runs.length >= 1);
  assert.equal(history.body.runs[0].run.kind, 'producer', 'the trial is the trusted producer');
});

test('unit:trial-serves-head-and-runs-bound-cases — a failing step refuses the head naming the case and the step', async () => {
  const withCase = await commitFiles({ 'e2e/cases/home-shows-change.json': JSON.stringify(failingCase) });
  const merged = await trialMerge(gitOfRoot, { head: withCase, baseTip });
  assert.ok('mergeSha' in merged);
  const run = await trial(merged.mergeSha, ['src/change.ts', 'e2e/cases/home-shows-change.json']);
  assert.deepEqual(run.proofs['e2e:home-shows-change'], { executed: 1, failed: 1 });
  assert.match(trialFailureReason({ run })!, /^trial failed: e2e case home-shows-change: step 1 GET \//);
  // The refused head's trial record, carrying the failing step, is accepted by the merge record route.
  let work = await engine.execute(operator, 'create', null, { title: 'The home page shows the failing change', criteria: [{ id: 'AC-1', text: 'The home page shows the change', proofs: ['e2e:home-shows-change'] }] }, randomUUID()) as Work;
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'machine-a', path: '/tmp/trial-e2e-failing', branch: `${branch}-failing` }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, head: withCase }, randomUUID());
  const at = new Date().toISOString();
  assert.equal((await call(`work/${work.id}/merge-record`, coordinator, { kind: 'intent', head: withCase, baseTip, mergeSha: merged.mergeSha, risk: 'normal', at })).status, 200);
  const recorded = await call(`work/${work.id}/merge-record`, coordinator, { kind: 'trial', head: withCase, baseTip, mergeSha: merged.mergeSha, outcome: 'verdict', build: run.build,
    tests: run.tests, files: run.files, proofs: run.proofs, durationMs: run.durationMs, attempts: [], e2e: run.e2e });
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  work = (await store.list()).find(entry => entry.id === work.id)!;
  assert.equal(linkedCases(work, null).linked[0].head, 'fail', 'the Tests panel shows the failing case');
});

test('unit:trial-serves-head-and-runs-bound-cases — an endpoint another application already answers is refused, never counted for the head', async () => {
  const withCase = await commitFiles({ 'e2e/cases/home-shows-change.json': JSON.stringify(passingCase) });
  const merged = await trialMerge(gitOfRoot, { head: withCase, baseTip });
  assert.ok('mergeSha' in merged);
  // Another application holds the serve URL and would pass the case on the head's behalf.
  const other = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ message: 'served' })); });
  await new Promise<void>(resolve => other.listen(servePort, '127.0.0.1', resolve));
  try {
    const run = await trial(merged.mergeSha, ['src/change.ts', 'e2e/cases/home-shows-change.json']);
    assert.deepEqual(run.proofs['e2e:home-shows-change'], { executed: 0, failed: 1 });
    assert.match(trialFailureReason({ run })!, /already answers before the serve command starts/);
  } finally { await new Promise<void>(resolve => other.close(() => resolve())); }
});

test('unit:trial-serves-head-and-runs-bound-cases — a trial record carries every e2e result a full batch of valid items can owe', () => {
  const results = Array.from({ length: defaultMergeBatch * 50 * 20 }, (_, index) => ({ proof: `e2e:case-${index}`, case: `case-${index}`, executed: 1, failed: 0 }));
  const sha = 'a'.repeat(40);
  const parsed = mergeRecordBodySchema.safeParse({ kind: 'trial', head: sha, baseTip: sha, mergeSha: sha, outcome: 'verdict', build: 'pass',
    tests: { passed: 0, failed: [], files: 0 }, files: [], proofs: {}, durationMs: 1, attempts: [], e2e: results });
  assert.ok(parsed.success, parsed.success ? '' : parsed.error.message);
});

test('unit:trial-serves-head-and-runs-bound-cases — each case runs against the application delivery.cases binds it to', async () => {
  const checkout = await temporaryDirectory('trial-e2e-applications', tmpdir());
  const put = (path: string, content: string) => { mkdirSync(dirname(join(checkout, path)), { recursive: true }); writeFileSync(join(checkout, path), content); };
  put('graphyard.json', JSON.stringify({ delivery: { mode: 'local',
    applications: [{ id: 'site', kind: 'static', directory: 'site', build: null }, { id: 'api', kind: 'static', directory: 'api', build: null }],
    cases: { 'api-answers': 'api', 'site-answers': 'site' },
  } }));
  put('site/data.json', JSON.stringify({ message: 'site' }));
  put('api/data.json', JSON.stringify({ message: 'api' }));
  const answering = (id: string, message: string) => ({ ...passingCase, id, steps: [{ kind: 'http', method: 'GET', path: '/data.json', status: 200, expect: [{ path: 'message', equals: message }] }] });
  put('e2e/cases/api-answers.json', JSON.stringify(answering('api-answers', 'api')));
  put('e2e/cases/site-answers.json', JSON.stringify(answering('site-answers', 'site')));
  put('e2e/cases/unbound.json', JSON.stringify(answering('unbound', 'site')));
  const cases = await runTrialE2eCases({
    worktree: checkout, mergeSha: 'a'.repeat(40), proofs: ['e2e:api-answers', 'e2e:site-answers', 'e2e:unbound'],
    env: { PATH: process.env.PATH!, HOME: process.env.HOME! }, scratch: checkout, budgetMs: 60_000,
    holds: async path => existsSync(join(checkout, path)), log: () => {},
  });
  const by = (name: string) => cases.find(entry => entry.case === name)!;
  assert.deepEqual([by('api-answers').executed, by('api-answers').failed], [1, 0], JSON.stringify(cases));
  assert.deepEqual([by('site-answers').executed, by('site-answers').failed], [1, 0], JSON.stringify(cases));
  assert.equal(by('unbound').failed, 1);
  assert.match(by('unbound').failingStep!, /bind it in delivery\.cases to one of site, api/);
});
