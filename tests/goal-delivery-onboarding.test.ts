import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import { deliveryPolicySchema, generatedWorkflowFiles, requiredPullRequestChecks } from '../src/model/delivery-policy.js';
import { renderReleasePipeline } from '../src/install/release-pipeline.js';
import { prepareInstall, repositoryDelivery } from '../src/install/index.js';
import { installIdFor } from '../src/install/types.js';
import { harness, REPOSITORY } from './install-harness.js';
import { deliveryWorkflowFile } from '../src/onboarding.js';
import { detectApplications, loadProjectDelivery, projectDeliveryAssignment, projectDeliveryVariable, setProjectDelivery } from '../src/project-applications.js';
import { DeliveryDefaults } from '../web/components/delivery-slices.js';
import Sidebar from '../web/components/sidebar.js';
import { views } from '../web/pages/index.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1901 (GOAL-1, onboarding-default-path): normal onboarding commits application declarations and
// the rapid path's local delivery defaults; /api/status and the Delivery view show them.

const launcher = join(import.meta.dirname, '../bin/graphyard.mjs');
const fixtureFiles: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'fixture-project', scripts: { test: 'node --test', build: 'node build.mjs' } }),
  'build.mjs': 'console.log("built");\n',
  '.github/workflows/ci.yml': 'name: ci\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
  'public/index.html': '<!doctype html><title>Fixture static site</title>\n',
  'compose.yml': 'services:\n  web:\n    build: .\n    ports:\n      - "8080:3000"\n  db:\n    image: postgres:16\n',
  // A Railway target the repository carries: the local mode must still not depend on Railway.
  'railway.json': JSON.stringify({ build: { builder: 'NIXPACKS' } }),
  'e2e/cases/fixture-static-home.json': JSON.stringify({ id: 'fixture-static-home', title: 'Home', tags: ['fixture', 'site'], target: 'any', required: false, steps: [] }),
  'e2e/cases/fixture-compose-app.json': JSON.stringify({ id: 'fixture-compose-app', title: 'App', tags: ['fixture', 'app'], target: 'any', required: false, steps: [] }),
};

/** `extra` values of `null` omit a fixture file (a repository with no CI of its own). */
async function fixtureRepository(extra: Record<string, string | null> = {}) {
  const files = { ...fixtureFiles };
  for (const [path, text] of Object.entries(extra)) { if (text === null) delete files[path]; else files[path] = text; }
  const root = join(await temporaryDirectory('goal-onboarding'), 'repo');
  for (const [path, text] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', 'git@github.com:owner/fixture.git');
  return root;
}

/** A control plane that answers only what init reads: the recorded merger on /api/status. */
async function statusStub(merger: 'control-plane' | 'github') {
  const stub: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/api/status')) res.end(JSON.stringify({ mergeWriter: { merger } }));
    else { res.statusCode = 404; res.end('{"error":"not here"}'); }
  });
  await new Promise<void>(done => stub.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`, close: () => new Promise<void>(done => stub.close(() => done())) };
}

function cliEnv(url: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GRAPHYARD_')) delete env[key];
  return { ...env, GRAPHYARD_URL: url, GRAPHYARD_TOKEN: 'fixture-operator-token' };
}
const runCli = (cwd: string, args: string[], env: NodeJS.ProcessEnv) => promisify(execFile)(process.execPath, [launcher, ...args], { cwd, env })
  .then(result => result.stdout, error => { throw new Error(String((error as any).stderr || error.message)); });

/** Normal onboarding: init --scan, then init --scan --apply of the reviewed proposal. */
async function onboard(root: string, merger: 'control-plane' | 'github', scanArgs: string[] = []) {
  const stub = await statusStub(merger);
  try {
    const env = cliEnv(stub.url);
    const scanned = JSON.parse(await runCli(root, ['init', '--scan', ...scanArgs], env));
    await writeFile(join(root, '.graphyard/github-app.json'), JSON.stringify({ appId: 99, slug: 'graphyard-owner-fixture', repository: 'owner/fixture', privateKey: 'test-only', webhookSecret: 'test-only', installationId: 7 }), { mode: 0o600 });
    const applied = JSON.parse(await runCli(root, ['init', '--scan', '--apply', '--url', stub.url], env));
    const config = JSON.parse(await readFile(join(root, 'graphyard.json'), 'utf8'));
    return { scanned, applied, config };
  } finally { await stub.close(); }
}
const exists = (path: string) => stat(path).then(() => true, () => false);

test('integration:goal-local-delivery-onboarding — normal init of a fixture repository commits its applications, local previews, candidates of at most five and required production verification, generating no GitHub Actions or Railway dependency; an explicit GitHub merger and a committed policy keep their behaviour', async () => {
  const root = await fixtureRepository();
  const { scanned, config } = await onboard(root, 'control-plane');
  const delivery = config.delivery;
  assert.equal(delivery.mode, 'local');
  assert.equal(delivery.previews, 'local');
  assert.equal(delivery.candidateMaxChanges, 5);
  assert.equal(delivery.productionVerification, true);
  assert.deepEqual(delivery.applications, [
    { id: 'app', kind: 'compose', file: 'compose.yml', service: 'web', port: 3000 },
    { id: 'site', kind: 'static', directory: 'public', build: 'npm run build' },
  ]);
  assert.deepEqual(delivery.cases, { 'fixture-static-home': 'site', 'fixture-compose-app': 'app' });
  assert.ok(scanned.mergeGate.some((line: string) => /^local: .*at most 5 changes.*no GitHub Actions workflow/.test(line)), 'the scan shows the local defaults before anything is applied');
  // No generated workflow and no Railway adapter: the control plane runs previews, candidates and verification itself.
  for (const path of [...generatedWorkflowFiles, deliveryWorkflowFile]) assert.equal(await exists(join(root, path)), false, `${path} is not generated`);
  assert.equal(delivery.deploy.adapter, 'command');
  const policy = deliveryPolicySchema.parse(delivery);
  assert.deepEqual(renderReleasePipeline(policy), []);
  assert.deepEqual(requiredPullRequestChecks(policy), ['test', 'build'], 'pull requests wait only on the repository\'s own checks, never a generated workflow\'s');
  // The install reads the committed declaration and deploys it for the control plane to serve.
  const installed = await repositoryDelivery(root);
  assert.equal(installed.committed, true);
  const assignment = projectDeliveryAssignment(installed.policy);
  assert.equal(assignment.variable, projectDeliveryVariable);
  const served = loadProjectDelivery({ [projectDeliveryVariable]: assignment.value });
  assert.deepEqual({ ...served, source: undefined }, { mode: 'local', previews: 'local', candidateMaxChanges: 5, productionVerification: true, applications: delivery.applications, cases: delivery.cases, source: undefined });
  assert.equal(served.source, 'environment');
  // A rerun is idempotent: the committed policy is the scan's own.
  const again = await onboard(root, 'control-plane');
  assert.deepEqual(again.config.delivery, delivery);

  // An explicit GitHub merger keeps the GitHub release-candidate pipeline and its Railway adapter.
  const legacy = await fixtureRepository();
  const github = await onboard(legacy, 'github');
  assert.equal(github.config.delivery.mode, 'release-candidate');
  assert.equal(github.config.delivery.deploy.adapter, 'railway');
  assert.equal(github.config.delivery.previews, undefined);
  for (const path of generatedWorkflowFiles) assert.equal(await exists(join(legacy, path)), true, `${path} is generated under the GitHub merger`);
  // Switching that release-candidate repository to local removes the generated candidate and promotion
  // workflows, so nothing keeps releasing outside the control plane; a hand-written one is named instead.
  const switched = await fixtureRepository({ 'graphyard.json': `${JSON.stringify({ documentation: github.config.documentation, delivery: github.config.delivery }, null, 2)}\n` });
  for (const path of generatedWorkflowFiles) { await mkdir(join(switched, path, '..'), { recursive: true }); await writeFile(join(switched, path), await readFile(join(legacy, path), 'utf8')); }
  const local = await onboard(switched, 'github', ['--delivery', 'local']);
  assert.equal(local.config.delivery.mode, 'local');
  for (const path of generatedWorkflowFiles) assert.equal(await exists(join(switched, path)), false, `${path} is removed on the switch to local`);
  assert.ok(generatedWorkflowFiles.every(path => local.applied.applied.some((line: string) => line.startsWith(`removed ${path}`))), 'the apply reports each removal');
  const handWritten = await fixtureRepository({ 'graphyard.json': `${JSON.stringify({ documentation: github.config.documentation, delivery: github.config.delivery }, null, 2)}\n`, [generatedWorkflowFiles[0]]: 'name: mine\non: workflow_dispatch\n' });
  const kept = await onboard(handWritten, 'github', ['--delivery', 'local']);
  assert.equal(await exists(join(handWritten, generatedWorkflowFiles[0])), true, 'a workflow init did not generate is never deleted');
  assert.ok(kept.applied.drift.some((line: string) => line.startsWith(`${generatedWorkflowFiles[0]} is not one init generated`)));

  // A repository's committed policy is its own choice: a control-plane merger never rewrites it.
  const committedPolicy = { ...github.config.delivery };
  const keptRepository = await fixtureRepository({ 'graphyard.json': `${JSON.stringify({ documentation: github.config.documentation, delivery: committedPolicy }, null, 2)}\n` });
  const keptOnboarding = await onboard(keptRepository, 'control-plane');
  assert.deepEqual(keptOnboarding.config.delivery, committedPolicy);

  // A repository with no CI of its own under the local mode still gets no workflow and no graphyard-gate requirement.
  const noCi = await fixtureRepository({ '.github/workflows/ci.yml': null });
  const bare = await onboard(noCi, 'control-plane');
  assert.equal(bare.config.delivery.mode, 'local');
  assert.equal(bare.scanned.proposal.ci.system, 'none');
  for (const path of [...generatedWorkflowFiles, deliveryWorkflowFile]) assert.equal(await exists(join(noCi, path)), false, `${path} is not generated without CI`);
  assert.ok(!bare.config.delivery.mergeGate.preMerge.some((entry: { check: string }) => entry.check === 'graphyard-gate'));
  assert.ok(!bare.config.delivery.mergeGate.perCandidate.some((entry: { check: string }) => entry.check === 'graphyard-gate'));
  assert.deepEqual(bare.scanned.proposal.policy.checks, [], 'local mode requires no GitHub check when the repository has no CI');
  await rm(join(root, '..'), { recursive: true, force: true });

  // graphyard up with no committed delivery: a new install, or a retry of one whose record names the control-plane
  // merger, proposes local; an existing install whose record names github, or predates the field, keeps its model.
  const install = await harness({ provider: 'compose' });
  try {
    const planned = async (merger?: 'control-plane' | 'github' | null) => {
      const directory = join(install.configHome, installIdFor(REPOSITORY));
      await rm(directory, { recursive: true, force: true });
      if (merger !== undefined) {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'install.json'), JSON.stringify({ version: 1, installId: installIdFor(REPOSITORY), repository: REPOSITORY, provider: 'compose', baseBranch: 'main', createdAt: 'then', updatedAt: 'then', ...(merger === null ? {} : { merger }) }));
      }
      const session = await prepareInstall(install.root, { repository: REPOSITORY, provider: 'compose' }, install.deps, 'plan');
      return { mode: session.delivery.policy.mode, merger: session.delivery.merger };
    };
    assert.deepEqual(await planned(), { mode: 'local', merger: 'control-plane' }, 'a new install proposes local');
    assert.deepEqual(await planned('control-plane'), { mode: 'local', merger: 'control-plane' }, 'a retry of a control-plane install keeps local');
    assert.deepEqual(await planned('github'), { mode: 'per-pr', merger: 'github' }, 'an existing GitHub-merger install keeps its model');
    assert.deepEqual(await planned(null), { mode: 'per-pr', merger: null }, 'a record predating the field keeps its model');
  } finally { await install.cleanup(); }
});

// ---- The status API and the Delivery view ---------------------------------------------------------

const operator: Principal = { id: 'operator', role: 'admin' };
const token = `operator-${'t'.repeat(40)}`;
let database: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string, scratch: string;
const freePort = async () => { const probe = netServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done)); const { port } = probe.address() as AddressInfo; await new Promise<void>(done => probe.close(() => done())); return port; };

before(async () => {
  scratch = await temporaryDirectory('goal-delivery-status');
  const port = await freePort();
  database = new EmbeddedPostgres({ databaseDir: join(scratch, 'pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('delivery_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/delivery_test`); await store.init();
  http = server(new Engine(store, [15368], 120, 'owner/fixture'), [{ ...operator, token }]);
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
after(async () => {
  delete process.env[projectDeliveryVariable]; setProjectDelivery(null);
  if (http) await new Promise<void>(done => http.close(() => done()));
  if (store) await store.close(); if (database) await database.stop(); if (scratch) await rm(scratch, { recursive: true, force: true });
});
const read = async (path: string) => { const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${token}` } }); assert.equal(response.status, 200, path); return response.json() as Promise<any>; };
const serving = (declaration: unknown) => { process.env[projectDeliveryVariable] = JSON.stringify(declaration); setProjectDelivery(null); };

test('integration:goal-delivery-defaults-visible — /api/status and the Delivery view render the effective defaults from the stored policy; invalid applications or case bindings are refused with an actionable reason', async () => {
  const applications = [{ id: 'site', kind: 'static', directory: 'public', build: null }, { id: 'app', kind: 'compose', file: 'compose.yml', service: 'web', port: 3000 }];
  serving({ mode: 'local', previews: 'local', candidateMaxChanges: 5, productionVerification: true, applications, cases: { 'fixture-static-home': 'site', 'fixture-compose-app': 'app' } });
  const status = await read('status');
  assert.deepEqual(status.project.delivery, { mode: 'local', previews: 'local', candidateMaxChanges: 5, productionVerification: true, applications, cases: { 'fixture-static-home': 'site', 'fixture-compose-app': 'app' }, source: 'environment' });
  assert.equal((await read('merger')).mode, 'control-plane', 'a new database merges through the control plane, GitHub only a mirror');
  // The effective defaults fill what a declaration leaves out; declaring nothing is the rapid path.
  serving({ mode: 'local' });
  assert.deepEqual((await read('status')).project.delivery, { mode: 'local', previews: 'local', candidateMaxChanges: 5, productionVerification: true, applications: [], cases: {}, source: 'environment' });
  serving({ mode: 'release-candidate' });
  assert.equal((await read('status')).project.delivery.previews, 'off', 'a GitHub release-candidate project keeps its own behaviour');

  // The Delivery view, opened from the sidebar on every page, renders what the status read served.
  serving({ mode: 'local', previews: 'local', candidateMaxChanges: 5, productionVerification: true, applications, cases: { 'fixture-static-home': 'site' } });
  const live = await read('status');
  const page = renderToStaticMarkup(createElement(DeliveryDefaults, { status: live }));
  for (const text of ['Local preview', 'At most 5 changes per candidate', 'Production verification', 'Required: the exact live release is verified', 'The control plane (GitHub only a mirror)', 'static site in public', 'Compose compose.yml, service web:3000', 'cases: fixture-static-home']) assert.ok(page.includes(text), text);
  assert.ok(views.some(view => view.id === 'delivery' && view.label === 'Delivery' && !view.section), 'the Delivery view is registered and is no sidebar section of its own');
  const dashboard = { view: 'work', setView: () => {}, setSelected: () => {}, connected: true, lastUpdated: 'now', status: live, signOut: () => {} } as any;
  assert.match(renderToStaticMarkup(createElement(Sidebar, { entries: [], dashboard })), /<button type="button" class="text-button" aria-label="Delivery" title="Delivery defaults">/);

  // Invalid declarations: the status read names the reason instead of claiming the defaults.
  serving({ mode: 'local', applications, cases: { 'fixture-static-home': 'ghost' } });
  const refused = await read('status');
  assert.equal(refused.project.delivery, null);
  assert.match(refused.project.error, /binds case "fixture-static-home" to application "ghost", which delivery\.applications does not declare; bind it to one of site, app/);
  assert.match(renderToStaticMarkup(createElement(DeliveryDefaults, { status: refused })), /delivery declaration is refused: .*application &quot;ghost&quot;/);
  serving({ mode: 'local', applications: [{ id: 'site', kind: 'static', directory: '../outside' }] });
  assert.match((await read('status')).project.error, /applications\.0\.directory: A static application directory is a repository-relative path without \.\. segments/);

  // Case ids follow e2e/cases' own grammar (dots, underscores, up to 100 characters): served, discovered and bound.
  const longest = `c${'x'.repeat(99)}`;
  serving({ mode: 'local', applications, cases: { checkout_flow: 'site', 'api.v2': 'app', [longest]: 'site' } });
  assert.deepEqual((await read('status')).project.delivery.cases, { checkout_flow: 'site', 'api.v2': 'app', [longest]: 'site' });
  serving({ mode: 'local', applications, cases: { [`${longest}x`]: 'site' } });
  assert.match((await read('status')).project.error, /does not parse: cases\.cx{100}: Invalid key in record/);
  const discovered = detectApplications(['index.html', ...['checkout_flow', 'api.v2', longest, `${longest}x`].map(id => `e2e/cases/${id}.json`)], {}, null);
  assert.deepEqual(discovered.cases, { checkout_flow: 'site', 'api.v2': 'site', [longest]: 'site' }, 'discovery binds every valid case id and skips one over 100 characters');

  // init refuses a committed declaration it cannot use, naming the binding and the fix, and writes nothing.
  const stub = await statusStub('control-plane');
  try {
    const env = cliEnv(stub.url);
    const committed = (cases: Record<string, string>) => fixtureRepository({ 'graphyard.json': `${JSON.stringify({ documentation: { paths: ['README.md'], changelog: null }, delivery: { mode: 'local', mergeGate: { preMerge: [], perCandidate: [] }, candidateSchedule: null, deploy: { adapter: 'command', project: null, uat: null, production: null }, applications, cases } }, null, 2)}\n` });
    const undeclared = await committed({ 'fixture-static-home': 'ghost' });
    await assert.rejects(runCli(undeclared, ['init', '--scan'], env), /delivery\.cases binds case "fixture-static-home" to application "ghost", which delivery\.applications does not declare/);
    assert.equal(await exists(join(undeclared, '.graphyard/setup-proposal.json')), false);
    const missing = await committed({ 'no-such-case': 'site' });
    await assert.rejects(runCli(missing, ['init', '--scan'], env), /binds case "no-such-case", but e2e\/cases\/no-such-case\.json does not exist/);
    // and the install refuses both an undeclared application and a binding whose case file is missing.
    await assert.rejects(repositoryDelivery(undeclared), /binds case "fixture-static-home" to application "ghost"/);
    await assert.rejects(repositoryDelivery(missing), /binds case "no-such-case", but e2e\/cases\/no-such-case\.json does not exist/);
    const dotted = await fixtureRepository({ 'e2e/cases/checkout_flow.json': '{}', 'e2e/cases/api.v2.json': '{}', 'graphyard.json': `${JSON.stringify({ documentation: { paths: ['README.md'], changelog: null }, delivery: { mode: 'local', mergeGate: { preMerge: [], perCandidate: [] }, candidateSchedule: null, deploy: { adapter: 'command', project: null, uat: null, production: null }, applications, cases: { checkout_flow: 'site', 'api.v2': 'app' } } }, null, 2)}\n` });
    assert.deepEqual((await repositoryDelivery(dotted)).policy.cases, { checkout_flow: 'site', 'api.v2': 'app' }, 'the install accepts bindings to dotted and underscored cases');
    assert.deepEqual(JSON.parse(await runCli(dotted, ['init', '--scan'], env)).proposal.delivery.cases, { checkout_flow: 'site', 'api.v2': 'app' }, 'and so does init');
  } finally { await stub.close(); }
});
