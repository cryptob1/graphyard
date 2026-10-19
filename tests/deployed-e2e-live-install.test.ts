import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, type DaemonState } from '../src/master-daemon.js';
import { deployTip, deployLine } from '../src/daemon/continuous-deploy.js';
import type { e2eSuite, E2eReport } from '../src/e2e/runner.js';
import { parseCase, type CaseFile } from '../src/e2e/case.js';

/**
 * GY-2217: the loop's deploys of main rolled back at the end-to-end step because the cases were
 * written for a disposable UAT of the fixture project, while this install runs the control-plane
 * merger with no UAT and declares no applications: seven required cases failed on waits nothing
 * could answer and three optional ones failed beside them. The end-to-end step must pass against an
 * install configured like this one — every case either passing or, when its outcome needs a release
 * candidate, a UAT or a declared application this install lacks, reported pending — and a case that
 * fails for any other reason must still fail the deploy. A failed deploy records every failing case
 * id and its failing step in the deploy failure master status shows, never cut short.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const sha = 'a'.repeat(40);

type Item = { id: string; key: string; title: string; stage: string; closure?: { kind: string; reason: string }; preview?: unknown; delivery?: unknown };
type Install = { url: string; server: Server; status: unknown; items: Item[]; candidates: number };

/** A fake install configured like the live one: a control-plane merger, the repository wired, no UAT, and no declared applications. */
async function fakeInstall(options: { projectDelivery?: unknown } = {}): Promise<Install> {
  const install: Install = { url: '', server: undefined!, status: null, items: [], candidates: 0 };
  install.status = {
    github: null,
    project: { delivery: options.projectDelivery ?? { mode: 'local', previews: 'local', candidateMaxChanges: 5, productionVerification: true, applications: [], cases: {}, source: 'environment' } },
  };
  const read = async (body: string) => JSON.parse(body || '{}') as any;
  install.server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://install').pathname, send = (value: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
    };
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    if (path === '/healthz') return send({ ok: true, healthy: true, commit: sha, revision: sha });
    if (path === '/api/merger') return send({ merger: 'control-plane', mode: 'control-plane' });
    if (path === '/api/status') return send(install.status);
    if (path === '/api/work' && request.method === 'POST') {
      const data = await read(body);
      const item: Item = { id: `w-${install.items.length + 1}`, key: `GY-${5000 + install.items.length}`, title: data.title ?? 'created', stage: 'backlog' };
      install.items.push(item);
      return send(item);
    }
    if (path === '/api/work' && request.method === 'GET') return send(install.items);
    const work = /^\/api\/work\/([^/]+)$/.exec(path);
    if (work && request.method === 'GET') return send(install.items.find(item => item.id === work[1] || item.key === work[1]) ?? {});
    // The run closes, as obsolete, every work item its cases created (GY-2216): a deploy leaves no batch on the live board.
    const close = /^\/api\/work\/([^/]+)\/close$/.exec(path);
    if (close && request.method === 'POST') {
      const item = install.items.find(entry => entry.id === close[1]);
      if (!item) return send({ error: 'no such item' }, 404);
      item.closure = { kind: 'obsolete', reason: 'the run closes its own work when it ends' };
      item.stage = 'done';
      return send(item);
    }
    if (path === '/api/candidates' && request.method === 'POST') return send({ id: `cand-${++install.candidates}` });
    const candidate = /^\/api\/candidates\/([^/]+)$/.exec(path);
    if (candidate && request.method === 'GET') return send({ id: candidate[1], members: [], sourceSha: null, validation: { result: 'fail', cases: [], failed: [] } });
    if (path === '/production/redeploy' || path === '/api/delivery/sweep') return send({});
    return send({ reason: 'not found' }, 404);
  });
  await new Promise<void>(done => install.server.listen(0, '127.0.0.1', done));
  install.url = `http://127.0.0.1:${(install.server.address() as AddressInfo).port}`;
  return install;
}

const closeInstall = (install: Install) => new Promise<void>(done => install.server.close(() => done()));

/** The cases the live deploy ran that decide this fix, selected out of the checkout's own case files. */
const decidingCases = (cases: readonly CaseFile[]) => cases.filter(entry =>
  ['create-work-item', 'candidate-batches-five', 'candidate-gates-promotion', 'production-exact-verification',
    'preview-isolation-cleanup', 'preview-serves-change', 'previews-for-declared-apps'].includes(entry.definition.id));

const pendingCasesOf = (report: E2eReport) => [...report.suspendedDeliveries?.cases ?? [], ...report.suspendedPreviews?.cases ?? []].sort();

test('unit:deployed-e2e-passes-on-control-plane-install — against an install like this one (control-plane merger, repository wired, no UAT, no declared applications), every case passes or pends, and the deploy passes', async () => {
  const { deployedE2e, e2eSuite: realSuite } = await import('../src/e2e/runner.js') as Record<string, any>;
  const install = await fakeInstall();
  try {
    const seen: { report?: E2eReport } = {};
    // A fake clock: the waiting steps of the cases this install cannot serve ask again by it, so a run against sources without the change (verify's base exercise) fails inside its shared deadline in milliseconds, not after 1800 real seconds.
    let clock = Date.now();
    const suite = ((cases: readonly CaseFile[], token: string, options: Parameters<typeof e2eSuite>[2] = {}) =>
      realSuite(decidingCases(cases), token, { ...options, now: () => clock, sleep: async (ms: number) => { clock += ms; }, report: (value: E2eReport) => { seen.report = value; options.report?.(value); } })) as typeof e2eSuite;
    // No UAT: the loop's environment names neither GRAPHYARD_UAT_URL nor GRAPHYARD_UAT_STATIC.
    const result = await deployedE2e(root, install.url, 'e2e-token', suite, { uat: false });
    assert.equal(result.passed, true, 'the deploy\'s end-to-end step passes');
    const ran = seen.report;
    assert.ok(ran, 'the run reported its cases');
    const passed = ran.cases.filter(outcome => outcome.verdict === 'passed').map(outcome => outcome.id);
    assert.deepEqual(passed, ['create-work-item'], 'the case this install serves passes');
    // The release-candidate cases pend because the install promotes through no UAT; the preview-tagged cases pend because it declares no applications.
    assert.deepEqual(pendingCasesOf(ran), ['candidate-batches-five', 'candidate-gates-promotion', 'preview-isolation-cleanup', 'preview-serves-change', 'previews-for-declared-apps', 'production-exact-verification']);
    for (const outcome of ran.cases.filter(entry => pendingCasesOf(ran).includes(entry.id))) {
      assert.equal(outcome.verdict, 'failed', `${outcome.id} ran and failed its unservable wait`);
      assert.equal(outcome.pending, true, `${outcome.id} is reported pending, not failing the deploy`);
    }
  } finally { await closeInstall(install); }
});

test('unit:deployed-e2e-passes-on-control-plane-install — a case that fails for any other reason still fails the deploy', async () => {
  const { deployedE2e, e2eSuite: realSuite } = await import('../src/e2e/runner.js') as Record<string, any>;
  const install = await fakeInstall();
  try {
    const broken = parseCase('e2e/cases/dashboard-route.json', JSON.stringify({
      id: 'dashboard-route', title: 'A required case failing for no suspension reason', target: 'uat', required: true,
      steps: [{ kind: 'http', method: 'GET', path: '/api/nowhere', status: 200, expect: [] }],
    }));
    const suite = ((cases: readonly CaseFile[], token: string, options: Parameters<typeof e2eSuite>[2] = {}) => {
      let clock = Date.now();
      return realSuite([...decidingCases(cases), { file: 'e2e/cases/dashboard-route.json', definition: broken }], token,
        { ...options, now: () => clock, sleep: async (ms: number) => { clock += ms; } }) as typeof e2eSuite;
    })
    await assert.rejects(deployedE2e(root, install.url, 'e2e-token', suite, { uat: false }), /dashboard-route failed at step 1/,
      'a failure no suspension ground covers fails the deploy');
  } finally { await closeInstall(install); }
});

test('unit:deployed-e2e-passes-on-control-plane-install — an install that declares the applications does not pend a preview case: its failure fails the deploy', async () => {
  const { deployedE2e, e2eSuite: realSuite } = await import('../src/e2e/runner.js') as Record<string, any>;
  const install = await fakeInstall({ projectDelivery: { mode: 'local', previews: 'local', candidateMaxChanges: 5, productionVerification: true,
    applications: [{ id: 'site', kind: 'static', directory: 'dist', build: null }], cases: { 'preview-serves-change': 'site' }, source: 'graphyard.json' } });
  try {
    const suite = ((cases: readonly CaseFile[], token: string, options: Parameters<typeof e2eSuite>[2] = {}) =>
      realSuite(cases.filter(entry => entry.definition.id === 'preview-serves-change'), token, options)) as typeof e2eSuite;
    await assert.rejects(deployedE2e(root, install.url, 'e2e-token', suite, { uat: true }), /1 of 1 E2E cases failed: case preview-serves-change/,
      'the pending ground is the install\'s own declaration, never a blanket pardon');
  } finally { await closeInstall(install); }
});

/** A report of `count` failed cases, each with its own failing step, as the runner reports a deploy's end-to-end failure. */
const failedReport = (count: number): E2eReport => ({
  runId: 'rc-gy-2217', url: 'http://127.0.0.1:1', environment: 'install', sha, startedAt: '', finishedAt: '',
  passed: 0, failed: count, cases: Array.from({ length: count }, (_, i) => ({
    id: `case-${i + 1}`, title: `Case ${i + 1}`, file: `e2e/cases/case-${i + 1}.json`, outcome: 'fail' as const, verdict: 'failed' as const, required: true,
    durationMs: 1, attempts: 1, attemptResults: [], executed: 6, failingStep: { index: 5, name: `the first change carries its merge commit ${i + 1}`, reason: `delivery.mergeSha is undefined, expected string (still, after waiting ${3600 + i} s)` },
  })),
});

test('unit:deploy-failure-names-every-failing-case — the end-to-end failure names every failing case with its failing step, never cut short', async () => {
  const { deployedE2e } = await import('../src/e2e/runner.js') as Record<string, any>;
  const report = failedReport(8);
  const suite = ((cases: readonly CaseFile[], token: string, options: Parameters<typeof e2eSuite>[2] = {}) => ({
    name: 'e2e',
    run: async () => { options.report?.(report); return { name: 'e2e', passed: true, detail: 'the verdict passed, the optional failures alone fail the deploy' }; },
  })) as unknown as typeof e2eSuite;
  const failure = await deployedE2e(root, 'http://127.0.0.1:1', 'e2e-token', suite).then(() => null, (error: Error) => error.message);
  assert.ok(failure, 'the failing optional cases throw, the end-to-end failure that rolls the deploy back');
  assert.ok(failure.length > 500, `the failure reason is not cut at the old 500 characters (it is ${failure.length})`);
  for (let i = 1; i <= 8; i++)
    assert.ok(failure.includes(`case case-${i} failed at step 6 (the first change carries its merge commit ${i})`), `case-${i}'s id and failing step are named`);
});

test('unit:deploy-failure-names-every-failing-case — the deploy failure master status shows records every failing case id and step, never cut before the last one', async () => {
  const { deployedE2e, e2eSuite: realSuite } = await import('../src/e2e/runner.js') as Record<string, any>;
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/nonexistent/coordinator.token', cliPath: '/nonexistent/bin/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const state: DaemonState = emptyDaemonState(master);
  const released = 'a1a1a1a1a1a1'.padEnd(40, '0'), tip = 'b2b2b2b2b2b2'.padEnd(40, '0'), from = 'c3c3c3c3c3c3'.padEnd(40, '0');
  state.release = { commit: released, dirty: false };
  // The end-to-end port runs the real deployedE2e over a report of eight failing cases, so the recorded reason is exactly what the step threw.
  const suite = ((cases: readonly CaseFile[], token: string, options: Parameters<typeof e2eSuite>[2] = {}) => {
    const report = failedReport(8);
    return realSuite(cases, token, { ...options, report: (value: E2eReport) => Object.assign(value, report) });
  }) as typeof e2eSuite;
  const ports = {
    deploy: async () => {}, health: async () => {},
    e2e: () => deployedE2e(root, 'http://127.0.0.1:1', 'e2e-token', suite),
    schemas: async () => ({ target: 7, database: 7 }),
  };
  let clock = Date.now();
  const checkouts: string[] = [], notes: string[] = [];
  await deployTip(state, tip, from, ports, {
    git: async (...args: string[]) => { const commit = args.find(arg => /^[0-9a-f]{40}$/.test(arg)); if (commit) checkouts.push(commit); return ''; },
    at: () => new Date((clock += 1000)).toISOString(),
    persist: async () => {},
    note: async (detail: string) => { notes.push(detail); },
  });
  const failure = state.promotion?.deployFailed;
  assert.ok(failure, 'the failed deploy is recorded');
  assert.equal(failure.step, 'e2e');
  assert.ok(failure.rolledBackTo === released, 'the recorded release was redeployed');
  assert.ok(failure.reason.length > 500, `the reason is not cut at the old 500 characters (it is ${failure.reason.length})`);
  for (let i = 1; i <= 8; i++)
    assert.ok(failure.reason.includes(`case case-${i} failed at step 6 (the first change carries its merge commit ${i})`), `the reason names case-${i} and its failing step`);
  const line = deployLine(failure)!;
  assert.ok(line.includes('failed at e2e:'), 'master status shows one deploy failure line');
  for (let i = 1; i <= 8; i++) assert.ok(line.includes(`case-${i}`), `master status's line names case-${i}`);
  assert.deepEqual(checkouts, [tip, released, from], 'the checkout moved to the tip, back to the release, then returned');
});
