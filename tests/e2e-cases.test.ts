import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import type { CaseRun } from '../src/scenarios.js';
import { caseDirectory, loadCases, parseCase, scenarioDefinition, selectCases, syncCases, type CaseFile } from '../src/e2e/case.js';
import { e2eSuite, recordRuns, releaseVerdict, runCases, summarize, type E2eLauncher, type E2ePage } from '../src/e2e/runner.js';
import { assessPromotion, assessUat, type ReleaseCandidate } from '../src/release-candidate.js';
import { acceptancesFrom, e2eRecord, holdItem } from '../src/release-holds.js';
import { commands } from '../src/cli/index.js';
import { TestsView } from '../web/pages/tests.js';

// GY-1351: the E2E case repository. Cases are files under e2e/cases/, registered as scenario
// revisions, run against a base URL by `graphyard e2e run`, and tracked on the Tests page.
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const principals = [operator, worker];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(32)}`]));
const root = new URL('..', import.meta.url).pathname;
const cli = new URL('../bin/graphyard.mjs', import.meta.url).pathname;

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1351;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('e2e-cases'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('e2e_cases_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/e2e_cases_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  http = server(engine, principals.map(p => ({ ...p, token: tokens.get(p.id)! })), null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

/** The CLI's authenticated request helper, as one principal. */
const apiAs = (actor: Principal) => async (path: string, data?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: data === undefined ? undefined : JSON.stringify(data) });
  const body = await response.json() as any;
  if (!response.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${response.status}`), { status: response.status });
  return body;
};
const call = async (path: string, actor: Principal, data?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, body: await response.json() as any };
};
/** A scratch repository holding the given case files under e2e/cases/. */
async function repository(files: Record<string, unknown>) {
  const dir = await temporaryDirectory('e2e-repo');
  await mkdir(join(dir, caseDirectory), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, caseDirectory, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return dir;
}
const http200 = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Case ${id}`, tags: ['api'], target: 'uat', steps: [{ kind: 'http', method: 'GET', path: '/api/tests', status: 200 }], ...extra });
const refusal = (file: string, value: unknown) => { try { parseCase(file, typeof value === 'string' ? value : JSON.stringify(value)); return null; } catch (error) { return (error as Error).message; } };

test('unit:e2e-case-format — a case is a JSON file under e2e/cases/ with id, title, tags, target and http and browser steps; a malformed case is refused naming the file and field', async () => {
  const shipped = await loadCases(root);
  const ids = shipped.map(entry => entry.definition.id);
  for (const id of ['sign-in', 'create-work-item', 'board', 'work-item-detail', 'tests-page']) assert.ok(ids.includes(id), `the repository ships the ${id} case`);
  assert.ok(shipped.length >= 5);
  assert.ok(shipped.every(entry => entry.file === `e2e/cases/${entry.definition.id}.json`));
  assert.ok(shipped.some(entry => entry.definition.steps.some(step => step.kind === 'browser')) && shipped.some(entry => entry.definition.steps.some(step => step.kind === 'http')), 'the shipped cases drive both the API and the dashboard');
  assert.deepEqual(selectCases(shipped, { tag: 'dashboard' }).map(entry => entry.definition.id).sort(), ['sign-in', 'tests-page', 'work-item-detail']);
  assert.equal(selectCases(shipped, { id: 'board' }).length, 1);
  assert.throws(() => selectCases(shipped, { id: 'missing' }), /No E2E case missing/);

  const file = 'e2e/cases/broken.json';
  assert.match(refusal(file, { ...http200('broken'), steps: [{ kind: 'http', method: 'GET', path: '/api/tests' }] })!, /^e2e\/cases\/broken\.json: steps\.0\.status: /);
  assert.match(refusal(file, { ...http200('broken'), target: 'production' })!, /broken\.json: target: /);
  assert.match(refusal(file, { ...http200('broken'), steps: [{ kind: 'browser', action: 'click', role: 'button' }, { kind: 'http', method: 'GET', path: '/', status: 200 }] })!, /broken\.json: steps\.0\.text: a browser click step needs text/);
  assert.match(refusal(file, { ...http200('broken'), steps: [{ kind: 'http', method: 'GET', path: '/', status: 200, expect: [{ path: 'a', equals: 1, exists: true }] }] })!, /steps\.0\.expect\.0: an assertion names exactly one/);
  assert.match(refusal(file, { ...http200('broken'), steps: [{ kind: 'browser', action: 'open', path: '/' }] })!, /broken\.json: steps: a case checks something/);
  assert.match(refusal(file, { ...http200('broken'), owner: 'me' })!, /broken\.json: \(case\): Unrecognized key/);
  assert.match(refusal(file, { ...http200('broken'), steps: [{ kind: 'shell', run: 'true' }] })!, /broken\.json: steps\.0\.kind: /);
  assert.match(refusal(file, http200('other'))!, /broken\.json: id: the case id "other" must match its file name "broken"/);
  assert.match(refusal(file, '{ not json')!, /broken\.json: \(case\): not valid JSON/);
  assert.equal(refusal(file, http200('broken')), null);
  // Loading a directory refuses every malformed file at once, each by name.
  const dir = await repository({ 'good.json': http200('good'), 'bad.json': { ...http200('bad'), tags: ['Not A Tag'] } });
  await assert.rejects(loadCases(dir), /e2e\/cases\/bad\.json: tags\.0: a tag is lower-case/);
});

test('unit:e2e-case-sync-revisions — e2e sync registers each case as a scenario revision; editing a case adds a new immutable revision and e2e:ID proofs keep their pinned revision', async () => {
  const dir = await repository({ 'sync-a.json': http200('sync-a'), 'sync-b.json': http200('sync-b', { tags: ['api', 'board'] }) });
  const cases = await loadCases(dir);
  const api = apiAs(operator);
  assert.deepEqual(await syncCases(api, cases), [{ id: 'sync-a', revision: 1, change: 'created' }, { id: 'sync-b', revision: 1, change: 'created' }]);
  assert.deepEqual((await syncCases(api, cases)).map(result => result.change), ['unchanged', 'unchanged'], 'syncing again changes nothing');
  const first = (await api('scenarios')).find((scenario: any) => scenario.id === 'sync-b');
  assert.equal(first.testPath, 'e2e/cases/sync-b.json'); assert.equal(first.environment, 'uat'); assert.equal(first.runner, 'graphyard-e2e'); assert.deepEqual(first.tags, ['api', 'board']);
  const unregistered = await loadCases(await repository({ 'sync-c.json': http200('sync-c') }));
  await assert.rejects(syncCases(apiAs(worker), unregistered), /Operator permission required/, 'only an operator registers cases');

  // An item requiring e2e:sync-a pins revision 1; editing the case publishes revision 2 and leaves revision 1 and the pin as they were.
  const pinned = await engine.execute(operator, 'create', null, { title: 'Pinned to sync-a', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'sync-a passes', proofs: ['e2e:sync-a'] }] }, randomUUID()) as Work;
  assert.equal(pinned.scenarioRequirements[0].revision, 1);
  await writeFile(join(dir, caseDirectory, 'sync-a.json'), JSON.stringify(http200('sync-a', { steps: [{ kind: 'http', method: 'GET', path: '/api/tests', status: 200, expect: [{ path: 'window', equals: 20 }] }] })));
  const edited = await loadCases(dir);
  assert.deepEqual(await syncCases(api, edited), [{ id: 'sync-a', revision: 2, change: 'revised' }, { id: 'sync-b', revision: 1, change: 'unchanged' }]);
  const revisions = (await api('scenarios')).filter((scenario: any) => scenario.id === 'sync-a');
  assert.deepEqual(revisions.map((scenario: any) => scenario.revision), [2, 1]);
  assert.equal(revisions[1].hash, (await store.pool.query('SELECT document FROM scenarios WHERE id=$1 AND revision=1', ['sync-a'])).rows[0].document.hash);
  assert.notEqual(revisions[0].hash, revisions[1].hash);
  await assert.rejects(store.pool.query("UPDATE scenarios SET document = document WHERE id='sync-a'"), /append-only/, 'a revision never changes');
  assert.equal((await engine.store.list()).find(w => w.id === pinned.id)!.scenarioRequirements[0].revision, 1, 'the existing proof keeps pinning revision 1');
  const later = await engine.execute(operator, 'create', null, { title: 'Pinned to the edit', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'sync-a passes', proofs: ['e2e:sync-a'] }] }, randomUUID()) as Work;
  assert.equal(later.scenarioRequirements[0].revision, 2, 'new work pins the edited revision');
  // The shipped cases register cleanly too.
  assert.ok((await syncCases(api, await loadCases(root))).every(result => result.revision === 1 && result.change !== 'revised'));
});

test('unit:e2e-runner-results — e2e run runs passing and failing cases against a server, prints each failing step, writes a JSON report, exits non-zero and records each run', async () => {
  const failing = { id: 'wrong-status', title: 'A case expecting the wrong answer', tags: ['api'], target: 'any', steps: [
    { kind: 'http', name: 'read the board', method: 'GET', path: '/api/board', status: 200 },
    { kind: 'http', name: 'expect a missing item', method: 'GET', path: '/api/work/NOPE-1', status: 200 },
    { kind: 'http', method: 'GET', path: '/api/tests', status: 200 }] };
  const dir = await repository({ 'wrong-status.json': failing });
  // The shipped API-only cases run for real against this control plane; their browser siblings need a built dashboard.
  for (const id of ['create-work-item', 'board']) await cp(join(root, caseDirectory, `${id}.json`), join(dir, caseDirectory, `${id}.json`));
  const cases = await loadCases(dir);
  assert.ok(cases.every(entry => entry.definition.steps.every(step => step.kind === 'http')));
  await syncCases(apiAs(operator), cases);
  const report = join(dir, 'report.json');
  const { GRAPHYARD_TOKEN_FILE: _file, ...inherited } = process.env;
  const env = { ...inherited, GRAPHYARD_URL: url, GRAPHYARD_TOKEN: tokens.get(operator.id)!, GRAPHYARD_REPOSITORY_ROOT: dir };
  const runCli = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve =>
    execFile(process.execPath, [cli, 'e2e', 'run', ...args], { cwd: dir, env, timeout: 120_000 }, (error, stdout, stderr) => resolve({ code: error ? Number((error as any).code ?? 1) : 0, stdout, stderr })));

  // The shipped API cases pass against a real control plane; the failing case makes the run exit non-zero.
  const mixed = await runCli('--tag', 'api', '--url', url, '--report', report);
  assert.equal(mixed.code, 1, 'the api tag includes the failing case');
  const all = JSON.parse(await readFile(report, 'utf8'));
  const outcome = (id: string) => all.cases.find((entry: any) => entry.id === id);
  for (const id of ['create-work-item', 'board']) assert.equal(outcome(id).outcome, 'pass', `${id}: ${JSON.stringify(outcome(id).failingStep)}`);
  assert.deepEqual(outcome('wrong-status').failingStep, { index: 1, name: 'expect a missing item', reason: outcome('wrong-status').failingStep.reason });
  assert.match(outcome('wrong-status').failingStep.reason, /expected status 200, got 404/);
  assert.equal(outcome('wrong-status').executed, 2, 'a case stops at its failing step');
  assert.equal(outcome('wrong-status').attempts, 1, 'no retry by default');
  assert.equal(all.passed, 2); assert.equal(all.failed, 1); assert.equal(all.url, url);
  const served = (await (await fetch(`${url}/healthz`)).json() as any).commit;
  assert.equal(all.sha, /^[0-9a-f]{40}$/.test(served ?? '') ? served : null, 'the report names the commit the target served');
  assert.match(mixed.stdout, /FAIL wrong-status/); assert.match(mixed.stdout, /step 2 expect a missing item: expected status 200, got 404/); assert.match(mixed.stdout, /PASS board/);
  assert.match(mixed.stdout, /2 passed, 1 failed/);

  // Each result is a run of the case's registered revision, with the base URL, SHA, duration, outcome and failing step.
  const runs = (await call('tests/wrong-status/runs', operator)).body.runs as CaseRun[];
  assert.equal(runs.length, 1);
  assert.equal(runs[0].result, 'fail'); assert.equal(runs[0].scenarioRevision, 1); assert.equal(runs[0].run.kind, 'e2e'); assert.equal(runs[0].run.id, all.runId);
  assert.deepEqual(runs[0].e2e, { baseUrl: url, durationMs: outcome('wrong-status').durationMs, failingStep: outcome('wrong-status').failingStep });
  assert.equal(runs[0].environment, new URL(url).host); assert.equal(runs[0].sha, all.sha ?? 'unknown');
  const passed = (await call('tests/board/runs', operator)).body.runs as CaseRun[];
  assert.equal(passed[0].result, 'pass'); assert.equal(passed[0].e2e!.failingStep, null);

  // One case passing exits zero; --no-record leaves history alone.
  const one = await runCli('board', '--url', url, '--report', report, '--no-record', '--environment', 'local');
  assert.equal(one.code, 0, one.stderr);
  assert.equal(JSON.parse(await readFile(report, 'utf8')).environment, 'local');
  assert.equal((await call('tests/board/runs', operator)).body.runs.length, 1);
  // A token is never an argument.
  const refused = await runCli('--all', '--url', url, '--token', 'secret');
  assert.notEqual(refused.code, 0); assert.match(refused.stderr, /never takes a token as an argument/);
  assert.ok(commands.find(command => command.name === 'e2e')?.help.some(line => line.includes('e2e run')));

  // In process: a per-case retry, a per-step timeout, and an unsynced case reported as not recorded.
  let calls = 0;
  const flaky = (async () => new Response(++calls % 2 ? '{}' : '[]', { status: calls % 2 ? 500 : 200 })) as typeof fetch;
  const retried = await runCases(cases.filter(entry => entry.definition.id === 'wrong-status'), { url: 'http://target.test', token: 't', fetcher: flaky, retries: 1 });
  assert.equal(retried.cases[0].attempts, 2);
  const hang = (async (_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted by the step timeout'))))) as typeof fetch;
  const timed = await runCases([cases.find(entry => entry.definition.id === 'board')!], { url: 'http://target.test', token: 't', fetcher: hang, stepTimeoutMs: 50 });
  assert.equal(timed.cases[0].outcome, 'fail'); assert.match(timed.cases[0].failingStep!.reason, /abort|within 50 ms/);
  const unsynced: CaseFile = { file: 'e2e/cases/unsynced.json', definition: parseCase('e2e/cases/unsynced.json', JSON.stringify(http200('unsynced'))) };
  const local = await runCases([unsynced], { url, token: tokens.get(operator.id)! });
  await recordRuns(apiAs(operator), [unsynced], local);
  assert.deepEqual(local.cases[0].recorded, { error: 'no registered revision matches e2e/cases/unsynced.json; run graphyard e2e sync' });
  assert.match(summarize(local), /not recorded: no registered revision/);
});

test('unit:e2e-runner-results — browser steps open, fill, click and expect text on one page, and a page that never shows the text fails that step', async () => {
  const actions: string[] = [];
  const page = (missing: string): E2ePage => {
    const locator = (what: string) => ({ first: () => locator(what), click: async () => { actions.push(`click ${what}`); }, fill: async (value: string) => { actions.push(`fill ${what}=${value}`); },
      waitFor: async () => { if (what.includes(missing)) throw new Error(`Timeout waiting for ${what}`); actions.push(`see ${what}`); } });
    return { on: () => undefined, goto: async target => { actions.push(`open ${target}`); }, getByLabel: label => locator(label), getByRole: (role, options) => locator(`${role}:${options.name}:${options.exact}`),
      getByText: text => locator(`text:${text}`), close: async () => {} };
  };
  let launches = 0;
  const launcher = (missing: string): E2eLauncher => ({ launch: async () => { launches++; return { newPage: async () => page(missing), close: async () => {} }; } });
  const signIn = (await loadCases(root)).filter(entry => entry.definition.id === 'sign-in');
  const health = (async () => new Response('{}')) as typeof fetch;
  const ok = await runCases(signIn, { url: 'https://uat.example.test', token: 'uat-token', launcher: launcher('nothing'), fetcher: health });
  assert.equal(ok.cases[0].outcome, 'pass', JSON.stringify(ok.cases[0].failingStep));
  assert.deepEqual(actions, ['open https://uat.example.test/', 'fill Access token=uat-token', 'click button:Open control plane:false', 'see navigation:Primary:true', 'see heading:Work:true']);
  assert.equal(launches, 1);
  const bad = await runCases(signIn, { url: 'https://uat.example.test', token: 'uat-token', launcher: launcher('heading:Work'), fetcher: health });
  assert.deepEqual(bad.cases[0].failingStep, { index: 4, name: 'expect heading "Work"', reason: 'Timeout waiting for heading:Work:true' });
});

test('unit:e2e-tracking-history — the Tests page lists each E2E case with last outcome, SHA, environment, pass rate and flaky flag over 20 runs, and each failed run\'s failing step; the route reads bounded history', async () => {
  const dir = await repository({ 'tracked.json': http200('tracked', { tags: ['api', 'tracked'] }) });
  const [tracked] = await loadCases(dir);
  await syncCases(apiAs(operator), [tracked]);
  const sha = (n: number) => String(n % 10).repeat(40);
  const record = (n: number, outcome: 'pass' | 'fail', environment = 'uat') => call('scenarios/tracked/runs', operator, { revision: 1, runId: `run-${n}`, baseUrl: 'https://uat.example.test', sha: sha(n), environment,
    durationMs: 100 + n, outcome, executed: 1, failingStep: outcome === 'fail' ? { index: 0, name: 'GET /api/tests', reason: `expected status 200, got 50${n % 10}` } : null });
  // 25 runs: the first five fail; of the last 20, run 23 fails on the same commit run 13 passed on.
  for (let n = 1; n <= 25; n++) assert.equal((await record(n, n <= 5 || n === 23 ? 'fail' : 'pass', n === 25 ? 'staging' : 'uat')).status, 200);
  assert.equal((await record(25, 'pass', 'staging')).status, 200, 'a retried report is the same run');
  assert.equal((await store.pool.query("SELECT count(*) AS n FROM scenario_runs WHERE scenario='tracked'")).rows[0].n, '25');

  const summary = (await call('tests', operator)).body;
  const entry = summary.cases.find((c: any) => c.id === 'tracked');
  assert.equal(summary.window, 20);
  assert.equal(entry.history.length, 20, 'the summary reads at most the window of runs');
  assert.equal(entry.runs, 25); assert.equal(entry.failures, 6);
  assert.equal(entry.latest.result, 'pass'); assert.equal(entry.latest.sha, sha(25)); assert.equal(entry.latest.environment, 'staging');
  assert.equal(entry.passRate, 19 / 20);
  assert.equal(entry.flaky, true); assert.match(entry.flakyReason, new RegExp(`passed and failed on commit ${sha(23).slice(0, 8)}`));
  assert.deepEqual(entry.e2e, { tags: ['api', 'tracked'], target: 'uat', required: false });
  const failed = entry.history.find((run: CaseRun) => run.result === 'fail');
  assert.deepEqual(failed.e2e.failingStep, { index: 0, name: 'GET /api/tests', reason: 'expected status 200, got 503' });
  const older = (await call(`tests/tracked/runs?before=${entry.history.at(-1).seq}&limit=50`, operator)).body;
  assert.equal(older.runs.length, 5); assert.ok(older.runs.every((run: CaseRun) => run.result === 'fail' && run.e2e?.failingStep));

  // Recording is an operator's command bound to a registered revision.
  assert.equal((await call('scenarios/tracked/runs', worker, { revision: 1, runId: 'w', baseUrl: 'https://x.test', sha: null, environment: 'uat', durationMs: 1, outcome: 'pass', executed: 1, failingStep: null })).status, 403);
  assert.equal((await call('scenarios/tracked/runs', operator, { revision: 9, runId: 'r9', baseUrl: 'https://x.test', sha: null, environment: 'uat', durationMs: 1, outcome: 'pass', executed: 1, failingStep: null })).status, 404);
  assert.equal((await call('scenarios/tracked/runs', operator, { revision: 1, runId: 'r10', baseUrl: 'https://x.test', sha: null, environment: 'uat', durationMs: 1, outcome: 'fail', executed: 1, failingStep: null })).status, 400, 'a failure names its step');

  // The page renders the case's outcome, commit, environment, pass rate, flaky flag and each failed run's step.
  const html = renderToStaticMarkup(createElement(TestsView, { data: summary, error: '', loading: false, filter: 'all', setFilter: () => {}, retry: () => {}, api: async () => ({}), canEdit: false }));
  const row = html.slice(html.indexOf('data-case="tracked"'));
  const text = row.slice(0, row.indexOf('</tr>')).replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
  assert.match(text, /E2E case · e2e\/cases\/tracked\.json · targets uat · optional, never blocks a release · api, tracked/, 'an optional case is marked optional (GY-1378)');
  assert.match(text, /passed 55555555 on staging/);
  assert.match(text, /95% of 20 runs/);
  assert.match(text, /flaky: passed and failed on commit 33333333/);
  assert.match(text, /failed at step 1 GET \/api\/tests: expected status 200, got 503/);
  assert.match(text, /e2e run run-25 · https:\/\/uat\.example\.test/);
  assert.match(row, /href="#case-tracked"/);
  assert.ok(scenarioDefinition(tracked).steps.length === 1);

  // Runs against a target that reported no commit share no commit: a pass then a fail is not flaky.
  const [local] = await loadCases(await repository({ 'local.json': http200('local') }));
  await syncCases(apiAs(operator), [local]);
  for (const [n, outcome] of [[1, 'pass'], [2, 'fail']] as const) assert.equal((await call('scenarios/local/runs', operator, { revision: 1, runId: `local-${n}`, baseUrl: 'http://127.0.0.1:1', sha: null, environment: 'local',
    durationMs: 1, outcome, executed: 1, failingStep: outcome === 'fail' ? { index: 0, name: 'GET /api/tests', reason: 'expected status 200, got 500' } : null })).status, 200);
  const unreported = (await call('tests', operator)).body.cases.find((c: any) => c.id === 'local');
  assert.equal(unreported.latest.sha, 'unknown'); assert.equal(unreported.flaky, false, 'no pseudo-commit makes a case flaky');
});

/** Cases that each read `/api/ID`, and a UAT serving `sha` whose answers follow `answers[ID]` call by call (the last one repeats). */
const verdictCases = (specs: Record<string, { required: boolean }>) => Object.entries(specs).map(([id, spec]) =>
  ({ file: `e2e/cases/${id}.json`, definition: parseCase(`e2e/cases/${id}.json`, JSON.stringify({ id, title: `Case ${id}`, target: 'uat', required: spec.required, steps: [{ kind: 'http', name: `read ${id}`, method: 'GET', path: `/api/${id}`, status: 200 }] })) }));
function verdictTarget(sha: string | null, answers: Record<string, number[]>) {
  const calls = new Map<string, number>();
  return (async (target: URL | string) => {
    const path = new URL(String(target)).pathname;
    if (path === '/healthz') return new Response(JSON.stringify({ ok: true, commit: sha ?? 'unknown' }));
    const id = path.slice('/api/'.length), n = calls.get(id) ?? 0; calls.set(id, n + 1);
    const statuses = answers[id] ?? [200];
    const status = statuses[Math.min(n, statuses.length - 1)];
    return new Response(status === 200 ? '{}' : '{"error":"broken"}', { status });
  }) as typeof fetch;
}

test('unit:e2e-case-verdict-states — a release run ends each case passed, failed, unrun (naming the case that stopped it) or flaky (both attempts kept); only failed and unaccepted-flaky required cases block, and unrun cases are reported apart', async () => {
  const sha = '1'.repeat(40);
  // In id order: a passes, b fails then passes on its retry (flaky), c fails both attempts and stops the run, d (required) and e (optional) never run.
  const cases = verdictCases({ 'verdict-a': { required: true }, 'verdict-b': { required: true }, 'verdict-c': { required: true }, 'verdict-d': { required: true }, 'verdict-e': { required: false } });
  const target = verdictTarget(sha, { 'verdict-b': [500, 200], 'verdict-c': [500] });
  const report = await runCases(cases, { url: 'https://uat.example.test', token: 't', runId: 'rc-verdicts', fetcher: target, retries: 1, stopOnRequiredFailure: true });
  const of = (id: string) => report.cases.find(entry => entry.id === id)!;
  assert.deepEqual(report.cases.map(entry => [entry.id, entry.verdict]), [['verdict-a', 'passed'], ['verdict-b', 'flaky'], ['verdict-c', 'failed'], ['verdict-d', 'unrun'], ['verdict-e', 'unrun']]);
  assert.deepEqual(of('verdict-b').attemptResults.map(attempt => attempt.outcome), ['fail', 'pass'], 'a flaky case keeps its failed attempt beside its pass');
  assert.deepEqual(of('verdict-b').failingStep, { index: 0, name: 'read verdict-b', reason: 'expected status 200, got 500: {"error":"broken"}' });
  assert.equal(of('verdict-c').attempts, 2); assert.deepEqual(of('verdict-c').attemptResults.map(attempt => attempt.outcome), ['fail', 'fail']);
  assert.equal(of('verdict-d').stoppedBy, 'verdict-c'); assert.equal(of('verdict-e').stoppedBy, 'verdict-c', 'every case after the stop is unrun, naming the case that stopped it');
  assert.equal(of('verdict-d').outcome, null); assert.equal(of('verdict-d').attempts, 0);
  assert.deepEqual([report.passed, report.failed, report.flaky, report.unrun], [1, 1, 1, 2], 'unrun cases count neither as failures nor as passes');

  // The verdict: the failed required case and the flaky one block; the unrun ones are listed apart.
  const verdict = releaseVerdict(report);
  assert.equal(verdict.passed, false);
  assert.deepEqual(verdict.blocking.map(entry => entry.id), ['verdict-b', 'verdict-c']);
  assert.deepEqual(verdict.unrun.map(entry => entry.id), ['verdict-d', 'verdict-e']);
  assert.ok(!verdict.blocking.some(entry => entry.verdict === 'unrun'));
  // An acceptance of the flaky case for this run at this SHA leaves only the failure blocking; one at another SHA or run accepts nothing.
  assert.deepEqual(releaseVerdict(report, [{ case: 'verdict-b', runId: 'rc-verdicts', sha, decision: 'd-1' }]).blocking.map(entry => entry.id), ['verdict-c']);
  assert.deepEqual(releaseVerdict(report, [{ case: 'verdict-b', runId: 'rc-verdicts', sha: '2'.repeat(40), decision: 'd-2' }, { case: 'verdict-b', runId: 'rc-other', sha, decision: 'd-3' }]).blocking.map(entry => entry.id), ['verdict-b', 'verdict-c']);

  const words = summarize(report);
  assert.match(words, /PASS verdict-a/); assert.match(words, /FLAKY verdict-b .*\n {5}attempt 1 failed at step 1 read verdict-b: expected status 200, got 500/);
  assert.match(words, /FAIL verdict-c/); assert.match(words, /UNRUN verdict-d: not run, the run stopped at required case verdict-c/); assert.match(words, /UNRUN verdict-e \(optional\)/);
  assert.match(words, /1 passed, 1 failed, 1 flaky, 2 unrun$/);

  // The e2e suite of release validate runs the same way: one retry, stop at a required failure, and a detail naming the blockers and the unrun cases apart.
  const suite = await e2eSuite(cases, 't', { fetcher: verdictTarget(sha, { 'verdict-b': [500, 200], 'verdict-c': [500] }) }).run('https://uat.example.test', { id: 'verdicts' });
  assert.equal(suite.passed, false);
  assert.equal(suite.detail, '2 of 3 E2E cases failed: case verdict-b was flaky: it failed at step 1 (read verdict-b) and passed on attempt 2; it blocks until an evidence decision accepts it; '
    + 'case verdict-c failed at step 1 (read verdict-c): expected status 200, got 500: {"error":"broken"}; unrun after required case verdict-c stopped the run: verdict-d, verdict-e');
  // Optional cases never block: an optional failure leaves the suite passing, and it does not stop the run.
  const optional = verdictCases({ 'optional-a': { required: false }, 'optional-b': { required: true } });
  const relaxed = await e2eSuite(optional, 't', { fetcher: verdictTarget(sha, { 'optional-a': [500] }) }).run('https://uat.example.test', null);
  assert.equal(relaxed.passed, true, relaxed.detail); assert.match(relaxed.detail, /optional, not blocking: optional-a failed/);
  // A pass after a failure at an unreported commit is no flaky result bound to a SHA: it is a failure.
  const unbound = await runCases(cases.slice(1, 2), { url: 'https://uat.example.test', token: 't', fetcher: verdictTarget(null, { 'verdict-b': [500, 200] }), retries: 1 });
  assert.equal(unbound.cases[0].verdict, 'failed');

  // Recording keeps both attempts of the flaky case as runs of its revision; the unrun cases record nothing.
  await syncCases(apiAs(operator), cases);
  await recordRuns(apiAs(operator), cases, report);
  const runs = (await call('tests/verdict-b/runs', operator)).body.runs as CaseRun[];
  assert.deepEqual(runs.map(run => [run.run.id, run.result, run.sha]).sort(), [['rc-verdicts:attempt-1', 'fail', sha], ['rc-verdicts:attempt-2', 'pass', sha]]);
  assert.equal((await call('tests/verdict-d/runs', operator)).body.runs.length, 0);
  assert.equal(of('verdict-d').recorded, undefined);
  // The Tests page marks a required case required.
  const summary = (await call('tests', operator)).body;
  assert.equal(summary.cases.find((entry: any) => entry.id === 'verdict-a').e2e.required, true);
  const html = renderToStaticMarkup(createElement(TestsView, { data: summary, error: '', loading: false, filter: 'all', setFilter: () => {}, retry: () => {}, api: async () => ({}), canEdit: false }));
  const row = html.slice(html.indexOf('data-case="verdict-a"'));
  assert.match(row.slice(0, row.indexOf('</tr>')).replace(/<[^>]+>/g, ' '), /targets uat · +required/);
});

test('unit:e2e-flaky-evidence-decision — a flaky required case blocks promotion until an evidence decision requested and approved by two different agents accepts it, bound to the case, run and exact SHA', async () => {
  const sha = '3'.repeat(40), other = '4'.repeat(40);
  const agents = { requester: { id: 'evidence-requester', capabilities: ['decision:attest'] }, approver: { id: 'evidence-approver', capabilities: ['decision:approve'] } };
  const agentToken = (id: string) => `${id}-${'e'.repeat(32)}`;
  for (const agent of Object.values(agents)) await apiAs(operator)('operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: ['owner/project'], workItems: ['*'] }, token: agentToken(agent.id), reason: 'Release agents decide flaky evidence' });
  const as = async (id: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${agentToken(id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };

  // Candidate C at `sha`: the required case flakes in its release run, which is recorded attempt by attempt.
  const cases = verdictCases({ 'evidence-flaky': { required: true } });
  await syncCases(apiAs(operator), cases);
  const candidate: ReleaseCandidate = { id: '20261006T120000Z', sha, cutAt: '2026-10-06T12:00:00.000Z', trigger: 'manual', since: null, items: [] };
  let report: any;
  const suite = await e2eSuite(cases, 't', { fetcher: verdictTarget(sha, { 'evidence-flaky': [500, 200] }), report: async written => { report = written; } }).run('https://uat.example.test', candidate);
  assert.equal(suite.passed, false); assert.match(suite.detail, /1 of 1 E2E cases were flaky: case evidence-flaky was flaky/);
  await recordRuns(apiAs(operator), cases, report);
  const uat = { ...assessUat(candidate, { deployedSha: sha, suites: [suite], now: new Date('2026-10-06T12:30:00Z') }), e2e: e2eRecord(report, candidate) };
  assert.deepEqual(uat.e2e!.blocking, ['evidence-flaky']);
  const blocked = assessPromotion(candidate, uat, null);
  assert.equal(blocked.promotable, false);
  assert.match(blocked.refusals.join(' '), /required E2E case evidence-flaky was flaky at 3{40} in run rc-20261006T120000Z; an evidence decision must accept it at that exact SHA before promotion/);

  // The decision is recorded on the release hold item the flaky case landed in.
  const hold = await apiAs(operator)('work', holdItem({ kind: 'open', outcome: 'evidence-outcome', hold: 'evidence-outcome', candidate: candidate.id, sha, at: '2026-10-06T12:30:00.000Z',
    cases: [{ case: 'evidence-flaky', verdict: 'flaky', candidate: candidate.id, sha, runId: report.runId, attempts: 2, failingStep: report.cases[0].failingStep }] }, candidate));
  const input = { case: 'evidence-flaky', runId: report.runId, sha };
  const requested = await as(agents.requester.id, `work/${hold.key}/decide`, { action: 'evidence', input, reason: 'The retry passed at the same SHA and the failure was a transient 500 from a cold UAT' });
  assert.equal(requested.status, 200, JSON.stringify(requested.body)); assert.equal(requested.body.state, 'requested');
  const acceptances = async () => acceptancesFrom((await as(agents.requester.id, `work/${hold.key}/decisions`)).body.decisions);
  assert.deepEqual(await acceptances(), [], 'a requested decision accepts nothing');
  assert.equal(assessPromotion(candidate, uat, null, await acceptances()).promotable, false, 'the block holds before the decision is approved');

  // Self-approval is refused through the existing decision path; a second agent approves.
  const self = await as(agents.requester.id, `work/${hold.key}/approve`, { decision: requested.body.id, reason: 'Approving my own request' });
  assert.equal(self.status, 403); assert.match(self.body.error, /Self-approval refused/);
  const approved = await as(agents.approver.id, `work/${hold.key}/approve`, { decision: requested.body.id, reason: 'Both attempts are recorded at that SHA; the failure is transient' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body)); assert.equal(approved.body.state, 'applied');
  assert.equal(approved.body.approvedBy, agents.approver.id); assert.equal(approved.body.requestedBy, agents.requester.id);
  const accepted = await acceptances();
  assert.deepEqual(accepted, [{ case: 'evidence-flaky', runId: report.runId, sha, decision: requested.body.id }]);
  assert.deepEqual(assessPromotion(candidate, uat, null, accepted), { promotable: true, refusals: [], sha, already: false }, 'the block clears for that SHA');

  // It never carries to another SHA: the same case flaky on a later candidate at another SHA is still blocked by it.
  const later: ReleaseCandidate = { ...candidate, id: '20261006T140000Z', sha: other };
  let laterReport: any;
  const laterSuite = await e2eSuite(cases, 't', { fetcher: verdictTarget(other, { 'evidence-flaky': [500, 200] }), report: async written => { laterReport = written; } }).run('https://uat.example.test', later);
  const laterUat = { ...assessUat(later, { deployedSha: other, suites: [laterSuite], now: new Date('2026-10-06T14:30:00Z') }), e2e: e2eRecord(laterReport, later) };
  assert.equal(assessPromotion(later, laterUat, null, accepted).promotable, false);
  // And the decision path refuses an acceptance with no recorded flaky result behind it: another SHA, or a run that never flaked.
  const unrecorded = await as(agents.requester.id, `work/${hold.key}/decide`, { action: 'evidence', input: { ...input, sha: other }, reason: 'Accept the later flake too' });
  assert.equal(unrecorded.status, 409); assert.match(unrecorded.body.error, /no recorded flaky result in run rc-20261006T120000Z at 4{40}/);
  const short = await as(agents.requester.id, `work/${hold.key}/decide`, { action: 'evidence', input: { ...input, sha: sha.slice(0, 12) }, reason: 'A short SHA' });
  assert.equal(short.status, 400, 'an acceptance names the full 40-character SHA');
});
