import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadCases, loadContract, parseCase, type CaseFile } from '../src/e2e/case.js';
import { runCases, type E2eLauncher, type E2eLocator, type E2ePage } from '../src/e2e/runner.js';
import { assessHolds, e2eRecord, foldHolds, type HoldRecord } from '../src/release-holds.js';
import { checkoutRepositoryPolicy } from '../src/model/repository-policy.js';
import { projectDeliveryAssignment } from '../src/project-applications.js';
import { DeliveryDefaults } from '../web/components/delivery-slices.js';
import Sidebar from '../web/components/sidebar.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { tempOwnerMarker } from '../src/tmp-reclaim.js';
import { execFileSync } from 'node:child_process';
// @ts-expect-error The fixture is a plain ES module the uat job runs under tsx.
import { candidateRoot, checkoutHead, createOnboardingFixture, fixtureCases, runOnboardingE2e, startControlPlane, suiteFixture } from '../scripts/onboarding-delivery-fixture.mjs';

// GY-1910 (release hold GY-1909): onboarding-delivery-defaults runs on an isolated project onboarded
// the normal way from the candidate's source, never on the shared UAT install, which keeps its
// explicit github merger.

const root = candidateRoot as string;
const caseId = 'onboarding-delivery-defaults';

/**
 * The dashboard as the case's browser steps meet it: sign-in with the filled token against the
 * plane's own API, the sidebar's Delivery button, and the Delivery view rendered from the live
 * /api/status by the dashboard's own components. Text is matched on the rendered page's text.
 */
function dashboardLauncher(): E2eLauncher {
  return { launch: async () => {
    let origin = '', token = '', markup = '';
    const read = async (path: string) => { const response = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${token}` } }); if (response.status !== 200) throw new Error(`${path} answered ${response.status}`); return response.json() as Promise<any>; };
    const text = () => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const locator = (actions: { click?: () => Promise<void>; fill?: (value: string) => void; visible?: () => boolean }): E2eLocator => ({
      first: () => locator(actions),
      click: async () => { if (!actions.click) throw new Error('nothing to click'); await actions.click(); },
      fill: async value => { if (!actions.fill) throw new Error('nothing to fill'); actions.fill(value); },
      waitFor: async () => { if (!actions.visible?.()) throw new Error('not visible'); },
    });
    const page: E2ePage = {
      on: () => page, close: async () => {},
      goto: async url => { origin = new URL(url).origin; markup = '<label>Access token</label><button>Open control plane</button>'; },
      getByLabel: label => locator({ fill: value => { assert.equal(label, 'Access token'); token = value; } }),
      getByRole: (role, { name }) => locator({ click: async () => {
        assert.equal(role, 'button');
        if (name === 'Open control plane') {
          const status = await read('/api/status');
          markup = renderToStaticMarkup(createElement(Sidebar, { entries: [], dashboard: { view: 'work', setView: () => {}, setSelected: () => {}, connected: true, lastUpdated: 'now', status, signOut: () => {} } as any }));
        } else if (name === 'Delivery') {
          if (!markup.includes('aria-label="Delivery"')) throw new Error('the Delivery button is not on the page');
          markup = renderToStaticMarkup(createElement(DeliveryDefaults, { status: await read('/api/status') }));
        } else throw new Error(`no ${name} button`);
      } }),
      getByText: (wanted, { exact }) => locator({ visible: () => exact ? text().split(' ').includes(wanted) : text().includes(wanted) }),
    };
    return { newPage: async () => page, close: async () => {} };
  } };
}

/** Every file under `directory` with its content, so a tree compares equal only when nothing in it was written, added or removed. */
const tree = (directory: string): Record<string, string> => Object.fromEntries(readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
  .map(entry => { const path = join(entry.parentPath, entry.name); return [path.slice(directory.length + 1), readFileSync(path, 'utf8')]; }).sort(([a], [b]) => a.localeCompare(b)));

const probe: CaseFile = { file: 'e2e/cases/shared-merger-probe.json', definition: parseCase('e2e/cases/shared-merger-probe.json', JSON.stringify({
  id: 'shared-merger-probe', title: 'The shared install keeps its merger', target: 'uat', required: true,
  steps: [{ kind: 'http', method: 'GET', path: '/api/merger', status: 200, expect: [{ path: 'mode', equals: 'github' }] }] })) };

test('integration:onboarding-uat-fresh-project-target — onboarding-delivery-defaults fails on a shared install explicitly set to github and passes, unchanged, on an isolated project normally onboarded from the candidate source; the shared install keeps github, the fixture is bound to the checkout HEAD and removed afterwards, and the run clears the outcome\'s release hold', async () => {
  const shipped = (await loadCases(root)).find(entry => entry.definition.id === caseId)!;
  // The protected case is the one the release contract binds, with every assertion it was approved with.
  assert.deepEqual(fixtureCases, [caseId]);
  assert.equal(shipped.definition.target, 'uat'); assert.equal(shipped.definition.required, true);
  const contract = await loadContract(root);
  assert.deepEqual(contract.outcomes.find(outcome => outcome.id === 'onboarding-default-path')!.cases, [caseId]);
  const expectations = shipped.definition.steps.flatMap(step => step.kind === 'http' ? step.expect.map(check => `${step.path} ${check.path}=${JSON.stringify(check.equals)}`) : step.kind === 'browser' && step.action === 'expectText' ? [`view ${step.text}`] : []);
  assert.deepEqual(expectations, ['/api/status project.delivery.previews="local"', '/api/status project.delivery.candidateMaxChanges=5', '/api/status project.delivery.productionVerification=true', '/api/merger mode="control-plane"', 'view Local preview', 'view Production verification']);

  const head = checkoutHead(root) as string;
  // The shared install: an existing installation serving the local defaults whose merger an admin explicitly set to github.
  const declared = projectDeliveryAssignment({ mode: 'local', previews: 'local', candidateMaxChanges: 5, productionVerification: true });
  const shared = await startControlPlane({ root, sha: head, scratch: await temporaryDirectory('onboarding-uat-shared'), env: { [declared.variable]: declared.value } });
  const opened: any[] = [];
  try {
    const admin = (path: string, init: RequestInit = {}) => fetch(`${shared.url}${path}`, { ...init, headers: { Authorization: `Bearer ${shared.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'explicit-github', ...init.headers } }).then(response => response.json() as Promise<any>);
    assert.equal((await admin('/api/merger', { method: 'POST', body: JSON.stringify({ merger: 'github', reason: 'this installation keeps GitHub as its merger' }) })).merger, 'github');

    // The previous target reproduces the hold's failure: step 2 reads the shared install's github merger.
    const before = await runCases([shipped], { url: shared.url, token: shared.token, launcher: dashboardLauncher() });
    assert.equal(before.cases[0].verdict, 'failed');
    assert.equal(before.cases[0].failingStep!.index, 1);
    assert.equal(before.cases[0].failingStep!.reason, 'mode is "github", expected "control-plane"');

    // The repaired suite: the fixture case on an isolated normally onboarded project, every other uat case on the shared install.
    // The host as the uat job meets it: a supported runtime on PATH, and a home and configuration of its own that already
    // hold an install record and a worker credential, so normal init both proposes worker credentials and could read or write the host's.
    const sentinel = await temporaryDirectory('onboarding-uat-host');
    const bin = join(sentinel, 'bin'), home = join(sentinel, 'home'), hostConfig = join(sentinel, 'graphyard-config');
    mkdirSync(bin); writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, 'claude'), 0o755);
    for (const directory of [join(home, '.config/graphyard/workers'), join(home, '.config/graphyard/installs/owner-fixture'), join(hostConfig, 'workers')]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(home, '.config/graphyard/workers/claude-primary.token'), 'host-owned\n');
    writeFileSync(join(home, '.config/graphyard/installs/owner-fixture/install.json'), '{"repository":"owner/fixture","host":"sentinel"}\n');
    writeFileSync(join(hostConfig, 'workers/claude-primary.token'), 'host-owned\n');
    const host = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GRAPHYARD_CONFIG_HOME: hostConfig };
    const hostBefore = tree(sentinel);
    const credentials: string[][] = [], owners: any[] = [];
    // The fixture's scratch comes from the suite's tracked helper, so a killed run leaves it marked with its owner for the dead-owner sweep.
    const fixture = async () => {
      const made = await createOnboardingFixture({ root, host, allocate: () => temporaryDirectory('onboarding-uat-fixture') }); opened.push(made);
      owners.push(JSON.parse(readFileSync(tempOwnerMarker(made.scratch), 'utf8')));
      credentials.push(Object.keys(tree(made.scratch)).filter(path => path.endsWith('.token')).map(path => join(made.scratch, path)));
      return made;
    };
    const policy = checkoutRepositoryPolicy(root);
    const candidate = { id: '20261017T150000Z', sha: head, pendingOutcomes: [] } as any;
    const report = await runOnboardingE2e([shipped, probe], { url: shared.url, token: shared.token, fixture, candidate, contract, policy, root, launcher: dashboardLauncher() });
    assert.deepEqual(report.cases.map((outcome: any) => [outcome.id, outcome.verdict, outcome.failingStep]), [[caseId, 'passed', null], ['shared-merger-probe', 'passed', null]]);
    assert.equal(report.sha, head, 'both targets served the candidate source');
    assert.equal(report.runId, `rc-${candidate.id}`);

    // The fixture came from normal init with the candidate's own CLI and serves what init committed.
    const [made] = opened;
    assert.equal(made.cli, join(root, 'bin/graphyard.mjs')); assert.equal(made.sha, head);
    assert.ok(made.onboarding.scanned.mergeGate.some((line: string) => /^local: .*at most 5 changes/.test(line)), 'init --scan proposed the local defaults');
    assert.deepEqual([made.config.delivery.mode, made.config.delivery.previews, made.config.delivery.candidateMaxChanges, made.config.delivery.productionVerification], ['local', 'local', 5, true]);
    // Init proposed the discovered runtime's worker and wrote its credential inside the fixture's scratch, never under the host's configuration.
    assert.ok(made.onboarding.applied.applied.includes('claude-primary credential file'), 'init wrote the discovered runtime\'s worker credential');
    assert.ok(credentials[0].length > 0 && credentials[0].every(path => path.startsWith(`${made.scratch}/`)), `the fixture wrote its credentials in scratch: ${credentials[0].join(', ')}`);
    assert.deepEqual(tree(sentinel), hostBefore, 'the host configuration and its install record are untouched');
    // Every isolated resource is gone once the run ends: the files, its credentials, the database and the plane.
    assert.equal(owners[0].pid, process.pid, 'the scratch directory was tracked and marked with this process as its owner');
    assert.equal(existsSync(made.scratch), false);
    assert.ok(credentials.flat().every(path => !existsSync(path)));
    await assert.rejects(fetch(`${made.url}/healthz`));

    // The shared install still records its explicit github merger, set once, by its admin.
    const merger = await admin('/api/merger');
    assert.equal(merger.mode, 'github');
    assert.deepEqual(merger.history.map((entry: any) => entry.merger), ['github']);

    // The run clears the outcome's open hold under the hold's own rule.
    const hold: HoldRecord = { kind: 'open', outcome: 'onboarding-default-path', hold: 'onboarding-default-path', candidate: '20261017T132854Z', sha: 'f9b95ec94fc613e7647ffcdfa7826e1f851c254b', at: '2026-10-17T13:30:00.000Z',
      cases: [{ case: caseId, verdict: 'failed', candidate: '20261017T132854Z', sha: 'f9b95ec94fc613e7647ffcdfa7826e1f851c254b', runId: 'rc-20261017T132854Z', attempts: 2, failingStep: { index: 1, name: 'read the merger mode', reason: 'mode is "github", expected "control-plane"' } }] };
    const record = e2eRecord(report, candidate, contract, policy);
    assert.deepEqual(assessHolds(contract, candidate, { deployedSha: head, e2e: record }, foldHolds([hold]), '2026-10-17T15:30:00.000Z', policy).map(entry => [entry.kind, entry.outcome]), [['clear', 'onboarding-default-path']]);

    // Candidate-source binding: a fixture whose plane served other source leaves the run unattributed, and none is built for another SHA.
    const elsewhere: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const url = new URL(String(input instanceof Request ? input.url : input));
      return url.pathname === '/healthz' && url.origin !== new URL(shared.url).origin ? Response.json({ ...(await response.json() as object), commit: '0'.repeat(40) }) : response;
    };
    const unbound = await runOnboardingE2e([shipped, probe], { url: shared.url, token: shared.token, fixture, candidate, contract, policy, root, launcher: dashboardLauncher(), fetcher: elsewhere });
    assert.equal(unbound.sha, null);
    assert.equal(e2eRecord(unbound, candidate, contract, policy), null, 'an unattributed run binds nothing to the candidate');
    await assert.rejects(createOnboardingFixture({ root, sha: '0'.repeat(40) }), /builds from the checkout's HEAD [0-9a-f]{40}, not the candidate 0{40}/);
    // The suite builds its fixture from the selected checkout, not this script's: a selected candidate at another HEAD is checked against its own.
    const selected = await temporaryDirectory('onboarding-uat-selected');
    execFileSync('git', ['init', '-q', selected]); execFileSync('git', ['-C', selected, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'selected candidate']);
    const selectedHead = checkoutHead(selected) as string;
    assert.notEqual(selectedHead, head);
    await assert.rejects(suiteFixture({ CANDIDATE_SHA: selectedHead }, selected)(), /serves the dashboard from dist\/, which the checkout has not built/, 'the selected candidate\'s own HEAD passed the source binding');
    await assert.rejects(suiteFixture({ CANDIDATE_SHA: head }, selected)(), new RegExp(`builds from the checkout's HEAD ${selectedHead}, not the candidate ${head}`));

    // A setup that fails after its database started stops that database before rejecting, so no live Postgres outlives it.
    const calls: string[] = [];
    class FailingPostgres { constructor(_options: unknown) {} async initialise() { calls.push('initialise'); } async start() { calls.push('start'); }
      async createDatabase() { calls.push('createDatabase'); throw new Error('database creation failed'); } async stop() { calls.push('stop'); } }
    await assert.rejects(startControlPlane({ root, sha: head, scratch: await temporaryDirectory('onboarding-uat-failed-setup'), Postgres: FailingPostgres }), /database creation failed/);
    assert.deepEqual(calls, ['initialise', 'start', 'createDatabase', 'stop']);
  } finally {
    for (const made of opened) await made.close();
    await shared.close();
  }
});
