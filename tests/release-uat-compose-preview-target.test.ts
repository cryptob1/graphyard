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
import { closeSchema } from '../src/model/closure.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// @ts-expect-error The fixture is a plain ES module the uat job runs under tsx.
import { candidateRoot, checkoutHead, createOnboardingFixture, fixtureCases, recordingReports, runOnboardingE2e, startControlPlane } from '../scripts/onboarding-delivery-fixture.mjs';

// GY-1923 (release hold of outcome preview-isolation): preview-isolation-cleanup failed on candidate
// 20261017T165144Z (run 39051225770) at step 3, because the shared UAT install declares no
// application and runs no preview loop, so GY-2329 had no preview. The case now runs on the isolated
// normally onboarded fixture, whose loop previews the Compose application onboarding declared.

const root = candidateRoot as string;
const caseId = 'preview-isolation-cleanup';
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

test('integration:release-uat-compose-preview-target — preview-isolation-cleanup fails on a shared install with no preview loop, as run 39051225770 did, and passes unchanged on a normally onboarded fixture whose real preview loop brings up two isolated Compose previews of its declared application and cleans the settled one up; the case reads the loop\'s own records and served pages, the shared install keeps its configuration, every run is bound to the candidate source, and the run clears the outcome\'s release hold', { timeout: 900_000 }, async t => {
  if (!docker) { assert.ok(!process.env.CI, 'CI runs the Compose previews'); t.skip('no Docker Compose or alpine:3 image on this host'); return; }
  const launcher = await browserLauncher();
  if (!launcher) { assert.ok(!process.env.CI, 'CI opens the preview in a browser'); t.skip('no Chromium or Chrome to open the preview in'); return; }
  const shipped = (await loadCases(root)).find(entry => entry.definition.id === caseId)!;
  // The protected case is the one the release contract binds, with every assertion it was approved with.
  assert.ok(fixtureCases.includes(caseId));
  assert.equal(shipped.definition.target, 'uat'); assert.equal(shipped.definition.required, true); assert.deepEqual(shipped.definition.secrets, []);
  const contract = await loadContract(root);
  assert.deepEqual(contract.outcomes.find(outcome => outcome.id === 'preview-isolation')!.cases, [caseId]);
  const expectations = shipped.definition.steps.flatMap(step => step.kind === 'http' ? [`${step.method} ${step.path} ${step.status}`, ...step.expect.map(check => `${check.path}=${JSON.stringify(check.equals ?? check.type)}`)] : step.kind === 'browser' ? [`${step.action} ${step.path ?? step.text}`] : []);
  assert.deepEqual(expectations, ['POST /api/work 200', 'POST /api/work 200',
    'GET /api/work/{{idA}} 200', 'preview.path="/preview/{{keyA}}"', 'preview.state="running"', 'preview.instance="preview-{{keyA}}"', 'preview.database="preview-{{keyA}}-db"', 'preview.secrets=[]',
    'GET /api/work/{{idB}} 200', 'preview.path="/preview/{{keyB}}"', 'preview.state="running"', 'preview.instance="preview-{{keyB}}"', 'preview.database="preview-{{keyB}}-db"',
    'open /preview/{{keyA}}', 'expectText state preview-{{keyA}}', 'expectText database preview-{{keyA}}-db', 'expectText production credentials none',
    'open /preview/{{keyB}}', 'expectText state preview-{{keyB}}', 'expectText database preview-{{keyB}}-db',
    'POST /api/work/{{idA}}/close 200', 'GET /api/work/{{idA}} 200', 'preview.state="cleaned"', 'preview.cleanedAt="string"', 'preview.instance="preview-{{keyA}}"',
    'GET /preview/{{keyA}} 404', 'GET /preview/{{keyB}} 200']);
  assert.ok(shipped.definition.steps.filter(step => step.kind === 'http' && step.method === 'POST' && step.path === '/api/work')
    .every(step => step.kind === 'http' && JSON.stringify(step.body).includes('"e2e:fixture-compose-app"')), 'both changes cite the fixture\'s declared Compose case');

  const head = checkoutHead(root) as string;
  // The shared install: the local defaults deployed, no application declared and no preview loop, as UAT runs.
  const declared = projectDeliveryAssignment({ mode: 'local', previews: 'local', candidateMaxChanges: 5, productionVerification: true });
  const shared = await startControlPlane({ root, sha: head, scratch: await temporaryDirectory('release-uat-compose-shared'), env: { [declared.variable]: declared.value } });
  const opened: any[] = [];
  try {
    const status = async () => (await (await fetch(`${shared.url}/api/status`, { headers: { Authorization: `Bearer ${shared.token}` } })).json() as any).project;
    const sharedBefore = await status();

    // The previous target reproduces the hold's failure: step 3 finds no preview on the first item it created.
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
      const made = await createOnboardingFixture({ root, launcher: { launch: (options: { headless: boolean }) => { previewLaunches += 1; return launcher.launch(options); } }, allocate: () => temporaryDirectory('release-uat-compose-fixture') });
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
    const candidate = { id: '20261017T170000Z', sha: head, pendingOutcomes: [] } as any;
    const report = await runOnboardingE2e([shipped, probe], { url: shared.url, token: shared.token, fixture, candidate, contract, policy, root, launcher, fetcher: recording });
    assert.deepEqual(report.cases.map((outcome: any) => [outcome.id, outcome.verdict, outcome.failingStep]), [[caseId, 'passed', null], ['shared-delivery-probe', 'passed', null]], JSON.stringify([report.cases[0].attemptResults, opened[0]?.loop.notes]));
    assert.equal(report.cases[0].executed, shipped.definition.steps.length, 'every step of the case ran');

    // The fixture came from normal onboarding: init declared the Compose application and bound the fixture's declared case to it.
    const [made] = opened;
    assert.deepEqual(made.config.delivery.applications.find((application: any) => application.kind === 'compose'), { id: 'app', kind: 'compose', file: 'compose.yml', service: 'web', port: 8080 });
    assert.equal(made.config.delivery.cases['fixture-compose-app'], 'app');
    assert.ok(previewLaunches >= 2, 'each preview ran its declared case in a browser it opened with the launcher');

    // The two items the case created, each previewed by the loop as its own Compose project of the declared application.
    const created = seen.filter(entry => entry.method === 'POST' && entry.url === `${made.url}/api/work`).map(entry => JSON.parse(entry.body));
    assert.equal(created.length, 2, 'the case ran once');
    const [first, second] = created;
    assert.match(first.title, new RegExp(`^E2E case ${caseId} run rc-${candidate.id}-1 first$`));
    for (const item of created) assert.ok(made.loop.notes.some((note: string) => note.startsWith(`Started ${item.key}'s preview of `) && note.endsWith(' (app: fixture-compose-app)')), made.loop.notes.join('; '));
    const reads = (item: any) => seen.filter(entry => entry.method === 'GET' && entry.url === `${made.url}/api/work/${item.id}`).map(entry => ({ ...entry, preview: JSON.parse(entry.body).preview }));
    const [runningA, cleanedA] = reads(first), [runningB] = reads(second);
    for (const [item, read] of [[first, runningA], [second, runningB]] as const) {
      assert.deepEqual({ path: read.preview.path, state: read.preview.state, runner: read.preview.runner, application: read.preview.application, source: read.preview.source, instance: read.preview.instance, database: read.preview.database, secrets: read.preview.secrets, cases: read.preview.cases },
        { path: `/preview/${item.key}`, state: 'running', runner: 'local', application: 'app', source: 'base', instance: `preview-${item.key}`, database: `preview-${item.key}-db`, secrets: [], cases: [{ case: 'fixture-compose-app', result: 'pass' }] });
    }
    assert.notEqual(runningA.preview.origin, runningB.preview.origin, 'each preview serves from its own Compose project');
    // Both ran at once: the second's create answered once its preview settled, and the first was read running after it.
    const createdB = seen.find(entry => entry.method === 'POST' && entry.url === `${made.url}/api/work` && JSON.parse(entry.body).id === second.id)!;
    assert.ok(createdB.order < runningA.order && runningA.order < runningB.order);
    // Settling the first cleaned it up, read on the item as the loop recorded it, and its link stopped serving while the other's kept serving.
    assert.deepEqual({ id: cleanedA.preview.id, state: cleanedA.preview.state, endReason: cleanedA.preview.endReason, origin: cleanedA.preview.origin }, { id: runningA.preview.id, state: 'cleaned', endReason: 'cancelled', origin: null });
    assert.ok(Date.parse(cleanedA.preview.cleanedAt) >= Date.parse(cleanedA.preview.startedAt));
    assert.equal(seen.find(entry => entry.method === 'GET' && entry.url === `${made.url}/preview/${first.key}`)!.status, 404);
    assert.equal(seen.find(entry => entry.method === 'GET' && entry.url === `${made.url}/preview/${second.key}`)!.status, 200);
    const stored = (item: any) => observed.work!.find(entry => entry.id === item.id);
    assert.equal(stored(first).preview.state, 'cleaned'); assert.equal(stored(second).preview.state, 'running', 'the other preview kept running until the fixture closed');
    assert.deepEqual(stored(second).preview.id, runningB.preview.id, 'the stored record is the one the case read');
    for (const left of Object.values(observed.leftovers!)) assert.deepEqual(left, { containers: [], volumes: [], networks: [], images: [] });
    assert.equal(Object.keys(observed.leftovers!).length, 2);

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
    const failedAt = { candidate: '20261017T165144Z', sha: 'd4dc2e8ba6f14d55d2cf7a1ddab1fd267e098c90' };
    const hold: HoldRecord = { kind: 'open', outcome: 'preview-isolation', hold: 'preview-isolation', ...failedAt, at: '2026-10-17T16:58:00.000Z',
      cases: [{ case: caseId, verdict: 'failed', ...failedAt, runId: `rc-${failedAt.candidate}`, attempts: 2, failingStep: { index: 2, name: "the first item records its preview's own state and database", reason: 'preview.path is undefined, expected "/preview/GY-2329"' } }] };
    const record = e2eRecord(report, candidate, contract, policy);
    assert.deepEqual(assessHolds(contract, candidate, { deployedSha: head, e2e: record }, foldHolds([hold]), '2026-10-17T17:30:00.000Z', policy).map(entry => [entry.kind, entry.outcome]), [['clear', 'preview-isolation']]);
  } finally {
    for (const made of opened) await made.close();
    await shared.close();
  }
});

test('unit:close-without-kind-is-obsolete — a close naming only its reason, as preview-isolation-cleanup settles its change, is an obsolete closure; every other kind still names its ref', () => {
  assert.deepEqual(closeSchema.parse({ reason: 'The E2E case settles this change' }), { kind: 'obsolete', reason: 'The E2E case settles this change' });
  assert.throws(() => closeSchema.parse({ reason: 'settled', ref: 'GY-1' }), /An obsolete closure names no other item or commit/);
  assert.throws(() => closeSchema.parse({ kind: 'duplicate', reason: 'settled' }), /names the item it duplicates/);
});
