import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadCases, loadContract, parseCase, scenarioDefinition, type CaseFile } from '../src/e2e/case.js';
import { recordRuns, runCases } from '../src/e2e/runner.js';
import { assessHolds, e2eRecord, foldHolds, type HoldRecord } from '../src/release-holds.js';
import { checkoutRepositoryPolicy } from '../src/model/repository-policy.js';
import { projectDeliveryAssignment } from '../src/project-applications.js';
import { composeLeftovers, composeProjectName } from '../src/compose-preview.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// @ts-expect-error The fixture is a plain ES module the uat job runs under tsx.
import { candidateRoot, checkoutHead, createOnboardingFixture, fixtureCases, recordingReports, runOnboardingE2e, startControlPlane } from '../scripts/onboarding-delivery-fixture.mjs';

// GY-1924 (release hold of outcome declared-app-previews): previews-for-declared-apps failed on
// candidate 20261017T172515Z at 093d0b56d433 (run 39053652430) at step 3, because the shared UAT
// install declares no application and runs no preview loop, so GY-2367 had no preview. The case now
// runs on the isolated normally onboarded fixture, whose loop previews the static site and the
// Compose application onboarding declared.

const root = candidateRoot as string;
const caseId = 'previews-for-declared-apps';
const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0 && spawnSync('docker', ['image', 'inspect', 'alpine:3'], { encoding: 'utf8' }).status === 0;

/** Chromium as Playwright installs it, else the host's Chrome, as the launcher the case's browser steps use; null when neither launches. */
async function browserLauncher() {
  const { chromium } = await import('@playwright/test');
  for (const options of [{}, { channel: 'chrome' }]) {
    try { await (await chromium.launch({ headless: true, ...options })).close(); return { launch: (launch: { headless: boolean }) => chromium.launch({ ...launch, ...options }) } as any; } catch { /* try the next */ }
  }
  return null;
}

const probe: CaseFile = { file: 'e2e/cases/shared-delivery-probe.json', definition: parseCase('e2e/cases/shared-delivery-probe.json', JSON.stringify({
  id: 'shared-delivery-probe', title: 'The shared install keeps its delivery', target: 'uat', required: true,
  steps: [{ kind: 'http', method: 'GET', path: '/api/status', status: 200, expect: [{ path: 'project.delivery.source', equals: 'environment' }] }] })) };

test('integration:release-uat-declared-app-previews — previews-for-declared-apps fails on a shared install with no preview loop, as run 39053652430 did, and passes unchanged on a normally onboarded fixture declaring fixture-static-home and fixture-compose-app, whose real preview loop serves the static site with the change and the Compose app with the change and its own database, both on the local runner; the case reads the loop\'s own records and served pages, the shared install keeps its configuration, the cases after it still run, every run is bound to the candidate source, and the run clears the outcome\'s release hold', { timeout: 900_000 }, async t => {
  if (!docker) { assert.ok(!process.env.CI, 'CI runs the Compose previews'); t.skip('no Docker Compose or alpine:3 image on this host'); return; }
  const launcher = await browserLauncher();
  if (!launcher) { assert.ok(!process.env.CI, 'CI opens the preview in a browser'); t.skip('no Chromium or Chrome to open the preview in'); return; }
  const cases = await loadCases(root);
  const shipped = cases.find(entry => entry.definition.id === caseId)!;
  // The protected case is the one the release contract binds, with every assertion it was approved with.
  assert.ok(fixtureCases.includes(caseId));
  assert.equal(shipped.definition.target, 'uat'); assert.equal(shipped.definition.required, true); assert.deepEqual(shipped.definition.secrets, []);
  const contract = await loadContract(root);
  assert.deepEqual(contract.outcomes.find(outcome => outcome.id === 'declared-app-previews')!.cases, [caseId]);
  const expectations = shipped.definition.steps.flatMap(step => step.kind === 'http' ? [`${step.method} ${step.path} ${step.status}`, ...step.expect.map(check => `${check.path}=${JSON.stringify(check.equals ?? check.type)}`)] : step.kind === 'browser' ? [`${step.action} ${step.path ?? step.text}`] : []);
  assert.deepEqual(expectations, ['POST /api/work 200', 'POST /api/work 200',
    'GET /api/work/{{idS}} 200', 'preview.path="/preview/{{keyS}}"', 'preview.state="running"', 'preview.runner="local"',
    'GET /api/work/{{idC}} 200', 'preview.path="/preview/{{keyC}}"', 'preview.state="running"', 'preview.runner="local"',
    'GET /preview/{{keyS}} 200', 'GET /preview/{{keyC}} 200',
    'open /preview/{{keyS}}', 'expectText Fixture static site', 'expectText E2E case {{case}} run {{run}} static',
    'open /preview/{{keyC}}', 'expectText Fixture compose app', 'expectText E2E case {{case}} run {{run}} compose', 'expectText database preview-{{keyC}}-db']);
  const proofs = shipped.definition.steps.flatMap(step => step.kind === 'http' && step.method === 'POST' && step.path === '/api/work' ? [(step.body as any).criteria[0].proofs] : []);
  assert.deepEqual(proofs, [['e2e:fixture-static-home'], ['e2e:fixture-compose-app']], 'each change cites one of the fixture\'s declared cases');
  // The four uat cases the failed run left unrun after this one, which still run on the shared install.
  const after = cases.filter(entry => entry.definition.target === 'uat' && entry.definition.id > caseId).map(entry => entry.definition.id);
  assert.deepEqual(after, ['production-exact-verification', 'sign-in', 'tests-page', 'work-item-detail']);
  assert.ok(after.every(id => !fixtureCases.includes(id)));

  const head = checkoutHead(root) as string;
  // The shared install: the local defaults deployed, no application declared and no preview loop, as UAT runs.
  const declared = projectDeliveryAssignment({ mode: 'local', previews: 'local', candidateMaxChanges: 5, productionVerification: true });
  const shared = await startControlPlane({ root, sha: head, scratch: await temporaryDirectory('release-uat-declared-shared'), env: { [declared.variable]: declared.value } });
  const opened: any[] = [];
  try {
    const status = async () => (await (await fetch(`${shared.url}/api/status`, { headers: { Authorization: `Bearer ${shared.token}` } })).json() as any).project;
    const sharedBefore = await status();

    // The previous target reproduces the hold's failure: step 3 finds no preview on the static change it created.
    const before = await runCases([shipped], { url: shared.url, token: shared.token, launcher });
    assert.equal(before.cases[0].verdict, 'failed');
    assert.equal(before.cases[0].failingStep!.index, 2);
    assert.match(before.cases[0].failingStep!.reason, /^preview\.path is undefined, expected "\/preview\/[A-Z]+-\d+"$/);

    // The repaired suite: the case on the isolated fixture, every other uat case on the shared install. Every response is recorded as the case received it.
    const seen: { url: string; method: string; status: number; body: string; order: number }[] = [];
    const recording: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      seen.push({ url: String(input instanceof Request ? input.url : input), method: init?.method ?? 'GET', status: response.status, body: await response.clone().text(), order: seen.length });
      return response;
    };
    const observed: { work?: any[]; leftovers?: Record<string, unknown> } = {};
    let previewLaunches = 0;
    const fixture = async () => {
      const made = await createOnboardingFixture({ root, launcher: { launch: (options: { headless: boolean }) => { previewLaunches += 1; return launcher.launch(options); } }, allocate: () => temporaryDirectory('release-uat-declared-fixture') });
      opened.push(made);
      const close = made.close;
      made.close = async () => {
        if (observed.work) return close();
        observed.work = (await (await fetch(`${made.url}/api/work-snapshot?view=coordination`, { headers: { Authorization: `Bearer ${made.token}` } })).json() as any).work;
        await close();
        // Every Compose preview the fixture's loop started is gone from the daemon once the fixture closes.
        observed.leftovers = Object.fromEntries(await Promise.all(observed.work!.filter(entry => entry.preview?.database).map(async entry => {
          const project = composeProjectName(entry.key, entry.preview.id);
          return [project, await composeLeftovers(project)];
        })));
      };
      return made;
    };
    const policy = checkoutRepositoryPolicy(root);
    const candidate = { id: '20261017T180000Z', sha: head, pendingOutcomes: [] } as any;
    const report = await runOnboardingE2e([shipped, probe], { url: shared.url, token: shared.token, fixture, candidate, contract, policy, root, launcher, fetcher: recording });
    assert.deepEqual(report.cases.map((outcome: any) => [outcome.id, outcome.verdict, outcome.failingStep]), [[caseId, 'passed', null], ['shared-delivery-probe', 'passed', null]], JSON.stringify([report.cases[0].attemptResults, opened[0]?.loop.notes]));
    assert.equal(report.cases[0].executed, shipped.definition.steps.length, 'every step of the case ran');

    // The fixture came from normal onboarding: init declared both applications and bound each fixture case to its own.
    const [made] = opened;
    const applications = made.config.delivery.applications;
    assert.equal(applications.find((application: any) => application.id === 'site')?.kind, 'static');
    assert.deepEqual(applications.find((application: any) => application.kind === 'compose'), { id: 'app', kind: 'compose', file: 'compose.yml', service: 'web', port: 8080 });
    assert.equal(made.config.delivery.cases['fixture-static-home'], 'site');
    assert.equal(made.config.delivery.cases['fixture-compose-app'], 'app');
    assert.ok(previewLaunches >= 2, 'each preview ran its declared case in a browser it opened with the launcher');

    // The two items the case created, each previewed by the loop as the application its case is bound to.
    const created = seen.filter(entry => entry.method === 'POST' && entry.url === `${made.url}/api/work`).map(entry => JSON.parse(entry.body));
    assert.equal(created.length, 2, 'the case ran once');
    const [staticItem, composeItem] = created;
    assert.match(staticItem.title, new RegExp(`^E2E case ${caseId} run rc-${candidate.id}-1 static$`));
    assert.match(composeItem.title, new RegExp(`^E2E case ${caseId} run rc-${candidate.id}-1 compose$`));
    for (const [item, label] of [[staticItem, 'site: fixture-static-home'], [composeItem, 'app: fixture-compose-app']]) {
      assert.ok(made.loop.notes.some((note: string) => note.startsWith(`Started ${item.key}'s preview of `) && note.endsWith(` (${label})`)), made.loop.notes.join('; '));
    }
    const read = (item: any) => JSON.parse(seen.find(entry => entry.method === 'GET' && entry.url === `${made.url}/api/work/${item.id}`)!.body).preview;
    const staticPreview = read(staticItem), composePreview = read(composeItem);
    assert.deepEqual({ path: staticPreview.path, state: staticPreview.state, runner: staticPreview.runner, application: staticPreview.application, database: staticPreview.database, cases: staticPreview.cases },
      { path: `/preview/${staticItem.key}`, state: 'running', runner: 'local', application: 'site', database: null, cases: [{ case: 'fixture-static-home', result: 'pass' }] });
    assert.deepEqual({ path: composePreview.path, state: composePreview.state, runner: composePreview.runner, application: composePreview.application, instance: composePreview.instance, database: composePreview.database, secrets: composePreview.secrets, cases: composePreview.cases },
      { path: `/preview/${composeItem.key}`, state: 'running', runner: 'local', application: 'app', instance: `preview-${composeItem.key}`, database: `preview-${composeItem.key}-db`, secrets: [], cases: [{ case: 'fixture-compose-app', result: 'pass' }] });
    // Each link served the page its preview runs: the static site with its change, the Compose app with its change and its own database.
    const served = (item: any) => seen.find(entry => entry.method === 'GET' && entry.url === `${made.url}/preview/${item.key}`)!;
    assert.equal(served(staticItem).status, 200); assert.equal(served(composeItem).status, 200);
    assert.match(served(staticItem).body, /Fixture static site/); assert.ok(served(staticItem).body.includes(staticItem.title));
    assert.match(served(composeItem).body, /Fixture compose app/); assert.ok(served(composeItem).body.includes(composeItem.title));
    assert.ok(served(composeItem).body.includes(`database preview-${composeItem.key}-db`));
    const stored = (item: any) => observed.work!.find(entry => entry.id === item.id);
    assert.equal(stored(staticItem).preview.id, staticPreview.id, 'the stored record is the one the case read');
    assert.equal(stored(composeItem).preview.id, composePreview.id, 'the stored record is the one the case read');
    for (const left of Object.values(observed.leftovers!)) assert.deepEqual(left, { containers: [], volumes: [], networks: [], images: [] });
    assert.equal(Object.keys(observed.leftovers!).length, 1);

    // Bound to the candidate: each target served the checkout's HEAD, and each case's runs are recorded at the target it ran on.
    assert.equal(report.sha, head);
    assert.deepEqual(report.targets.map((target: any) => [target.url, target.sha, target.cases]), [[made.url, head, [caseId]], [shared.url, head, ['shared-delivery-probe']]]);
    const recorded: Record<string, string[]> = {};
    const recorder = async (path: string, data?: any) => {
      if (path === 'scenarios') return [shipped, probe].map(entry => ({ ...scenarioDefinition(entry), revision: 1 }));
      (recorded[decodeURIComponent(path.split('/')[1])] ??= []).push(data.baseUrl);
    };
    for (const part of recordingReports(report)) await recordRuns(recorder, [shipped, probe], part);
    assert.deepEqual(recorded[caseId], [made.url]);
    assert.deepEqual(recorded['shared-delivery-probe'], [shared.url]);

    // Nothing of the fixture outlives the run, and the shared install keeps its configuration, with no item of the case on it but the reproduction's.
    assert.equal(existsSync(made.scratch), false);
    await assert.rejects(fetch(`${made.url}/healthz`));
    assert.deepEqual(await status(), sharedBefore);
    assert.ok(!seen.some(entry => entry.method === 'POST' && entry.url.startsWith(`${shared.url}/`)), 'the repaired suite created nothing on the shared install');

    // The run clears the outcome's open hold under the hold's own rule.
    const failedAt = { candidate: '20261017T172515Z', sha: '093d0b56d433f8e831fc720379254c882cf85731' };
    const hold: HoldRecord = { kind: 'open', outcome: 'declared-app-previews', hold: 'declared-app-previews', ...failedAt, at: '2026-10-17T17:32:00.000Z',
      cases: [{ case: caseId, verdict: 'failed', ...failedAt, runId: `rc-${failedAt.candidate}`, attempts: 2, failingStep: { index: 2, name: "the static change's preview is local", reason: 'preview.path is undefined, expected "/preview/GY-2367"' } }] };
    const record = e2eRecord(report, candidate, contract, policy);
    assert.deepEqual(assessHolds(contract, candidate, { deployedSha: head, e2e: record }, foldHolds([hold]), '2026-10-17T18:30:00.000Z', policy).map(entry => [entry.kind, entry.outcome]), [['clear', 'declared-app-previews']]);
  } finally {
    for (const made of opened) await made.close();
    await shared.close();
  }
});
