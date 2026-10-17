import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadCases, loadContract, parseCase, scenarioDefinition, type CaseFile } from '../src/e2e/case.js';
import { recordRuns, runCases } from '../src/e2e/runner.js';
import { assessHolds, e2eRecord, foldHolds, type HoldRecord } from '../src/release-holds.js';
import { checkoutRepositoryPolicy } from '../src/model/repository-policy.js';
import { projectDeliveryAssignment } from '../src/project-applications.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// @ts-expect-error The fixture is a plain ES module the uat job runs under tsx.
import { candidateRoot, checkoutHead, createOnboardingFixture, fixtureCases, recordingReports, runOnboardingE2e, startControlPlane } from '../scripts/onboarding-delivery-fixture.mjs';

// GY-1913 (release hold of outcome change-preview): preview-serves-change failed on candidate
// 20261017T150828Z (run 39043708413) because the shared UAT install declares no application and
// runs no preview loop, so the item it created had no preview. The case now runs on the isolated
// normally onboarded fixture, whose loop previews the site onboarding declared.

const root = candidateRoot as string;
const caseId = 'preview-serves-change';

/** Chromium as Playwright installs it; false when it does not launch. */
async function browserLaunches() {
  const { chromium } = await import('@playwright/test');
  try { await (await chromium.launch({ headless: true })).close(); return true; } catch { return false; }
}

const probe: CaseFile = { file: 'e2e/cases/shared-delivery-probe.json', definition: parseCase('e2e/cases/shared-delivery-probe.json', JSON.stringify({
  id: 'shared-delivery-probe', title: 'The shared install keeps its delivery', target: 'uat', required: true,
  steps: [{ kind: 'http', method: 'GET', path: '/api/status', status: 200, expect: [{ path: 'project.delivery.source', equals: 'environment' }] }] })) };

test('integration:goal-release-uat-preview-target — preview-serves-change fails on a shared install with no preview loop, as run 39043708413 did, and passes unchanged on a normally onboarded fixture whose real preview loop builds and serves its declared site; the case reads the loop\'s own record and served content, the shared install keeps its configuration, every run is bound to the candidate source and its target, and the run clears the outcome\'s release hold', { timeout: 600_000 }, async t => {
  if (!await browserLaunches()) { assert.ok(!process.env.CI, 'CI opens the preview in a browser'); t.skip('no Chromium to open the preview in'); return; }
  const shipped = (await loadCases(root)).find(entry => entry.definition.id === caseId)!;
  // The protected case is the one the release contract binds, with every assertion it was approved with.
  assert.ok(fixtureCases.includes(caseId));
  assert.equal(shipped.definition.target, 'uat'); assert.equal(shipped.definition.required, true);
  const contract = await loadContract(root);
  assert.deepEqual(contract.outcomes.find(outcome => outcome.id === 'change-preview')!.cases, [caseId]);
  const expectations = shipped.definition.steps.flatMap(step => step.kind === 'http' ? [`${step.method} ${step.path} ${step.status}`, ...step.expect.map(check => `${check.path}=${JSON.stringify(check.equals ?? check.type)}`)] : step.kind === 'browser' ? [`${step.action} ${step.path ?? step.text}`] : []);
  assert.deepEqual(expectations, ['POST /api/work 200', 'GET /api/work/{{id}} 200', 'preview.path="/preview/{{key}}"', 'preview.state="running"', 'preview.cases="array"', 'preview.cases.0.result="pass"',
    'GET /preview/{{key}} 200', 'open /preview/{{key}}', 'expectText E2E case {{case}} run {{run}}']);

  const head = checkoutHead(root) as string;
  // The shared install: the local defaults deployed, no application declared and no preview loop, as UAT runs.
  const declared = projectDeliveryAssignment({ mode: 'local', previews: 'local', candidateMaxChanges: 5, productionVerification: true });
  const shared = await startControlPlane({ root, sha: head, scratch: await temporaryDirectory('release-uat-preview-shared'), env: { [declared.variable]: declared.value } });
  const opened: any[] = [];
  try {
    const status = async () => (await (await fetch(`${shared.url}/api/status`, { headers: { Authorization: `Bearer ${shared.token}` } })).json() as any).project;
    const sharedBefore = await status();

    // The previous target reproduces the hold's failure: step 2 finds no preview on the item it created.
    const before = await runCases([shipped], { url: shared.url, token: shared.token });
    assert.equal(before.cases[0].verdict, 'failed');
    assert.equal(before.cases[0].failingStep!.index, 1);
    assert.match(before.cases[0].failingStep!.reason, /^preview\.path is undefined, expected "\/preview\/[A-Z]+-\d+"$/);

    // The repaired suite: the case on the isolated fixture, every other uat case on the shared install. Every response is recorded as the case received it.
    const seen: { url: string; method: string; status: number; body: string }[] = [];
    const recording: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      seen.push({ url: String(input instanceof Request ? input.url : input), method: init?.method ?? 'GET', status: response.status, body: await response.clone().text() });
      return response;
    };
    const observed: { tip?: string; work?: any[] } = {};
    const fixture = async () => {
      const made = await createOnboardingFixture({ root, allocate: () => temporaryDirectory('release-uat-preview-fixture') });
      opened.push(made);
      const close = made.close;
      made.close = async () => {
        if (observed.work) return close();
        observed.tip = execFileSync('git', ['-C', made.repository, 'rev-parse', 'refs/remotes/origin/main'], { encoding: 'utf8' }).trim();
        observed.work = (await (await fetch(`${made.url}/api/work-snapshot?view=coordination`, { headers: { Authorization: `Bearer ${made.token}` } })).json() as any).work;
        await close();
      };
      return made;
    };
    const policy = checkoutRepositoryPolicy(root);
    const candidate = { id: '20261017T160000Z', sha: head, pendingOutcomes: [] } as any;
    const report = await runOnboardingE2e([shipped, probe], { url: shared.url, token: shared.token, fixture, candidate, contract, policy, root, fetcher: recording });
    assert.deepEqual(report.cases.map((outcome: any) => [outcome.id, outcome.verdict, outcome.failingStep]), [[caseId, 'passed', null], ['shared-delivery-probe', 'passed', null]]);
    assert.equal(report.cases[0].executed, shipped.definition.steps.length, 'every step of the case ran');

    // The fixture came from normal onboarding: init declared the static site and bound the fixture's declared case to it.
    const [made] = opened;
    assert.deepEqual(made.config.delivery.applications.find((application: any) => application.kind === 'static'), { id: 'site', kind: 'static', directory: 'public', build: 'npm run build' });
    assert.equal(made.config.delivery.cases['fixture-static-home'], 'site');
    assert.ok(made.loop.notes.some((note: string) => /^Started [A-Z]+-\d+'s preview of [0-9a-f]{12} \(site: fixture-static-home\)$/.test(note)), made.loop.notes.join('; '));

    // The item the case read carried the loop's own record: the base the operator pushed, built, served and judged by the declared case.
    const created = seen.find(entry => entry.method === 'POST' && entry.url === `${made.url}/api/work`)!;
    const { id, key, title } = JSON.parse(created.body);
    assert.match(title, new RegExp(`^E2E case ${caseId} run rc-${candidate.id}-1$`), 'the case ran once, under the candidate\'s run');
    const read = seen.find(entry => entry.method === 'GET' && entry.url === `${made.url}/api/work/${id}`)!;
    const preview = JSON.parse(read.body).preview;
    assert.deepEqual({ path: preview.path, state: preview.state, runner: preview.runner, application: preview.application, source: preview.source, sha: preview.sha, cases: preview.cases },
      { path: `/preview/${key}`, state: 'running', runner: 'local', application: 'site', source: 'base', sha: observed.tip, cases: [{ case: 'fixture-static-home', result: 'pass' }] });
    assert.match(preview.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(observed.work!.find(entry => entry.id === id).preview.id, preview.id, 'the stored record is the one the case read');
    // The link served the site the build made from the change: the declared heading and this change's own title, not a placeholder.
    const served = seen.find(entry => entry.method === 'GET' && entry.url === `${made.url}/preview/${key}`)!;
    assert.equal(served.status, 200);
    assert.match(served.body, /<h1>Fixture static site<\/h1>/);
    assert.ok(served.body.includes(`<p>${title}</p>`), served.body);

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
    const failedAt = { candidate: '20261017T150828Z', sha: 'e71ec7b1e3f151d968478f819c69ee62f35bf486' };
    const hold: HoldRecord = { kind: 'open', outcome: 'change-preview', hold: 'change-preview', ...failedAt, at: '2026-10-17T15:14:00.000Z',
      cases: [{ case: caseId, verdict: 'failed', ...failedAt, runId: `rc-${failedAt.candidate}`, attempts: 2, failingStep: { index: 1, name: "read the item's preview", reason: 'preview.path is undefined, expected "/preview/GY-2217"' } }] };
    const record = e2eRecord(report, candidate, contract, policy);
    assert.deepEqual(assessHolds(contract, candidate, { deployedSha: head, e2e: record }, foldHolds([hold]), '2026-10-17T16:30:00.000Z', policy).map(entry => [entry.kind, entry.outcome]), [['clear', 'change-preview']]);
  } finally {
    for (const made of opened) await made.close();
    await shared.close();
  }
});
