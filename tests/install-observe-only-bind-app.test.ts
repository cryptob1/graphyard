import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appCommand, applyInstall, buildPlan, installRequestFromArgs, prepareInstall, type InstallDependencies, type InstallPlan, type InstallSummary } from '../src/install/index.js';
import { deliveryPolicySchema } from '../src/model/delivery-policy.js';
import { appKey, harness, CI_APP_ID, REPOSITORY, REPOSITORY_ID, type FakeApp } from './install-harness.js';

// GY-1877: `graphyard app bind SLUG`, the separate step after `install --observe-only --apply`, binds an
// App `graphyard app import` saved on this host to the recorded observation-only control plane:
// exactly the full install's App step, and nothing more. A later observation-only apply keeps it.
const SERVICE = 'graphyard-owner-project';
const SLUG = 'graphyard-owner-project-imported';
const APP_ID = 310_077;
const INSTALLATION_ID = 777;
const IMPORTED_SECRET = 'imported-webhook-secret-for-tests-5a6b7c8d';
const OBSERVE_ONLY_HELD = 'held by observation-only (--observe-only)';
const APP_VARIABLES = ['GITHUB_APP_ID', 'GITHUB_INSTALLATION_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_CI_APP_IDS'];
const ARGS = ['--provider', 'railway', '--repo', REPOSITORY, '--observe-only'];
/** App bind's Railway redeploy (GY-1908): --json so applyVariables can await that deployment id. */
const REDEPLOY = `railway redeploy --service ${SERVICE} --yes --json`;
const DEPLOY_TITLE = /Redeploy the serving SUCCESS deployment with the App variables \(refuse when latest is a newer failed attempt; no source upload or GRAPHYARD_BUILD_SHA stamp\) and wait for that redeploy and the bound App to serve/;

/** A Railway account that remembers what the installer created. */
function statefulRailway() {
  const state = { project: false, database: false, service: false };
  return [
    { match: 'railway status --json', result: () => state.project
      ? JSON.stringify({ name: SERVICE, services: { edges: [...(state.database ? [{ node: { name: 'Postgres' } }] : []), ...(state.service ? [{ node: { name: SERVICE } }] : [])] } })
      : { stdout: '', stderr: 'no linked project', code: 1 } },
    { match: 'railway init', result: () => { state.project = true; return ''; } },
    { match: 'railway add --database', result: () => { state.database = true; return ''; } },
    { match: 'railway add --service', result: () => { state.service = true; return ''; } },
    { match: 'git/ref/heads/release', result: { stdout: '', stderr: 'gh: Not Found (HTTP 404)', code: 1 } },
    { match: `repos/${REPOSITORY}/environments`, result: JSON.stringify({ environments: [] }) },
  ];
}
/** The base branch's check runs, empty until `ci.visible`: a repository whose CI has not published a check yet. */
const ciChecks = (ci: { visible: boolean; added?: number }) => ({ match: `gh api repos/${REPOSITORY}/commits/main/check-runs`, result: () => JSON.stringify({ check_runs: ci.visible ? [{ name: 'test', app: { id: CI_APP_ID, slug: 'github-actions' } }, ...(ci.added ? [{ name: 'lint', app: { id: ci.added, slug: 'another-ci' } }] : [])] : [] }) });

const releaseCandidate = deliveryPolicySchema.parse({
  mode: 'release-candidate', candidateSchedule: '0 */6 * * *',
  mergeGate: { preMerge: [{ check: 'test', command: 'npm run test', source: 'script', reason: 'fast' }], perCandidate: [{ check: 'test:e2e', command: 'npm run test:e2e', source: 'script', reason: 'long' }] },
  deploy: { adapter: 'railway', project: null, uat: null, production: null },
});

/** The variable names a slice of recorded Railway commands sets: plain ones in --set, secrets by name over standard input. */
const variablesSet = (lines: string[]) => lines.flatMap(line => line.startsWith('railway variables ') ? [...line.matchAll(/--set ([A-Z_]+)=/g)].map(match => match[1]) : /^railway variable set .* --stdin ([A-Z_]+)$/.exec(line)?.slice(1) ?? []);
const mutations = [/git\/refs/, /\/protection/, /rulesets/, /allow_auto_merge|auto-merge|merge_queue/i, /^railway environment/, /^herdr /, /systemctl/, / master init/];

async function observeOnlyInstallation(options: {
  ciVisible?: boolean;
  /** First-match Railway deployment/redeploy responses (GY-1908 serving-check and await). */
  railwayDeploy?: { match: string; result: string | { stdout: string; stderr: string; code: number } | ((line: string, input?: string) => string | { stdout: string; stderr: string; code: number }) }[];
  /** Status reads before /api/status reports the App after variables are written (delayed readiness). */
  statusDelay?: number;
} = {}) {
  const ci: { visible: boolean; added?: number } = { visible: options.ciVisible ?? true };
  // The served App is the one whose GITHUB_APP_ID the deployment was given, unless the server fails to load it.
  const server = { loadsApp: true };
  let fixture: Awaited<ReturnType<typeof harness>>;
  let statusReads = 0;
  // The App's installation, whose selected repositories the gh PUT the bind runs adds the repository back to.
  const app: FakeApp = { appId: APP_ID, slug: SLUG, installationId: INSTALLATION_ID, deselected: false };
  const addRepository = { match: `gh api --method PUT /user/installations/${INSTALLATION_ID}/repositories/${REPOSITORY_ID}`, result: () => { app.deselected = false; return ''; } };
  fixture = await harness({ provider: 'railway', extraResponses: [...(options.railwayDeploy ?? []), addRepository, ciChecks(ci), ...statefulRailway()], apps: [app],
    statusBody: () => {
      const written = server.loadsApp && fixture.allCommandLines().some(line => line.includes(`--set GITHUB_APP_ID=${APP_ID}`));
      if (written) statusReads++;
      const bound = written && (options.statusDelay === undefined || statusReads > options.statusDelay);
      return { actor: { id: 'owner-project-operator', role: 'admin' }, repository: REPOSITORY, github: bound, githubAppId: bound ? APP_ID : null, githubInstallationId: bound ? INSTALLATION_ID : null };
    } });
  await writeFile(join(fixture.root, 'graphyard.json'), JSON.stringify({ documentation: { paths: ['README.md'], changelog: null }, delivery: releaseCandidate }));
  const calls = { githubApp: 0, registerProfiles: 0, runHerdr: 0, provision: 0 };
  const logs: string[] = [];
  const deps: InstallDependencies = { ...fixture.deps, log: line => logs.push(line),
    githubApp: async () => { calls.githubApp++; throw new Error('observation-only must not open the App flow'); },
    registerProfiles: async () => { calls.registerProfiles++; throw new Error('observation-only must not register profiles'); },
    runHerdr: () => { calls.runHerdr++; return ''; } };
  const wrap = (adapter: any) => ({ ...adapter, provision: async (...args: any[]) => { calls.provision++; return adapter.provision(...args); } });
  // The observation-only control plane this App is bound to, deployed first by a plain observation-only apply.
  const observe = async (mode: 'plan' | 'apply') => {
    const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'railway', observeOnly: true }, deps, mode);
    session.delivery.adapter = wrap(session.delivery.adapter);
    return session;
  };
  const first = await observe('apply');
  await applyInstall(first, await buildPlan(first));
  // `graphyard app bind SLUG [--plan]` as the CLI runs it, on this fixture's transport, fetch and config home.
  const bind = (...flags: string[]) => appCommand(['bind', SLUG, ...flags], { root: fixture.root, configHome: fixture.configHome, install: deps });
  const bindPlan = async () => await bind('--plan') as InstallPlan;
  const bindApply = async () => await bind() as InstallSummary;
  // What `graphyard app import --app-id APP_ID --key-file PEM` saves in the install directory.
  const importApp = (webhookSecret = IMPORTED_SECRET) => writeFile(join(first.directory, `imported-app-${SLUG}.json`), JSON.stringify({ appId: APP_ID, slug: SLUG, privateKey: appKey, webhookSecret, repository: REPOSITORY, role: 'control-plane' }), { mode: 0o600 });
  const readRecord = async () => JSON.parse(await readFile(join(first.directory, 'install.json'), 'utf8'));
  return { fixture, calls, logs, observe, bind, bindPlan, bindApply, directory: first.directory, importApp, readRecord, ci, server, app };
}

const state = (actions: InstallPlan['actions'], id: string) => actions.find(action => action.id === id)!.state;

test('unit:railway-app-bind-preserves-deployed-source — a real Railway adapter with recording transport performs an App-only bind by merging exactly the five APP_VARIABLES and issuing one deployment-preserving railway redeploy through applyVariables; it issues no railway up, no GRAPHYARD_BUILD_SHA write and no source or image change; health, live App readback, webhook and binding persistence still occur, and an identical already-satisfied bind writes and deploys nothing (GY-1908)', async () => {
  const { fixture, bindPlan, bindApply, importApp, readRecord } = await observeOnlyInstallation();
  try {
    await importApp();
    const plan = await bindPlan();
    assert.match(plan.actions.find(action => action.id === 'provider.deploy')!.title, DEPLOY_TITLE);
    const mark = fixture.allCommandLines().length;
    const summary = await bindApply();
    assert.equal(summary.health, true);
    assert.equal(summary.status.githubAppId, APP_ID);
    assert.deepEqual(summary.github, { appId: APP_ID, installationId: INSTALLATION_ID, slug: SLUG, ciAppIds: [CI_APP_ID] });
    const lines = fixture.allCommandLines().slice(mark);
    assert.deepEqual(variablesSet(lines).sort(), [...APP_VARIABLES].sort());
    assert.equal(lines.filter(line => line === REDEPLOY).length, 1);
    assert.ok(lines.some(line => line.includes('railway deployment list')), 'the bind did not list deployments before redeploying');
    assert.ok(!lines.some(line => /^railway up/.test(line) || /GRAPHYARD_BUILD_SHA/.test(line) || /--image\b/.test(line)), 'the bind uploaded source, stamped a build or changed an image');
    assert.ok(fixture.requests.slice(-20).some(request => request.url.endsWith('/healthz')));
    assert.equal(fixture.state.hookConfig?.url, `${summary.url}/api/github/webhook`);
    assert.equal((await readRecord()).github.appId, APP_ID);
    const again = fixture.allCommandLines().length;
    await bindApply();
    const second = fixture.allCommandLines().slice(again);
    assert.deepEqual(variablesSet(second), []);
    assert.ok(!second.some(line => /^railway (up|redeploy)/.test(line)), 'the identical bind redeployed or uploaded');
  } finally { await fixture.cleanup(); }
});

test('unit:railway-app-bind-plan-matches-redeploy — the supported app-bind plan states Railway binding changes only the five App variables and redeploys the current deployment without a source upload or build stamp; plan performs no mutation, and a refusal before binding causes no variable write, upload or redeploy (GY-1908)', async () => {
  const docs = await readFile(new URL('../docs/install.md', import.meta.url), 'utf8');
  assert.ok(docs.split('\n').some(line =>
    line.includes('app bind SLUG')
    && line.includes('GITHUB_APP_ID') && line.includes('GITHUB_INSTALLATION_ID') && line.includes('GITHUB_PRIVATE_KEY') && line.includes('GITHUB_WEBHOOK_SECRET') && line.includes('GITHUB_CI_APP_IDS')
    && /Railway serving-SUCCESS redeploy \(refuse latest≠SUCCESS\)\/await\/no-source-upload\/no-`GRAPHYARD_BUILD_SHA`/.test(line)
    && /else deploy/.test(line)), 'docs/install.md does not state Railway app bind changes only the five App variables, redeploys the serving SUCCESS deployment (refusing a newer failed latest), awaits that redeploy, and never uploads or stamps GRAPHYARD_BUILD_SHA');
  const { fixture, bindPlan, bindApply, importApp } = await observeOnlyInstallation();
  try {
    let mark = fixture.allCommandLines().length;
    const refused = await bindPlan();
    assert.equal(refused.preflight.find(entry => entry.name === `Bind App ${SLUG}`)!.ok, false);
    assert.match(refused.actions.find(action => action.id === 'provider.deploy')!.title, /no source upload or GRAPHYARD_BUILD_SHA stamp/);
    await assert.rejects(bindApply(), /Preflight is incomplete; the installer changed nothing/);
    let lines = fixture.allCommandLines().slice(mark);
    assert.deepEqual(variablesSet(lines), []);
    assert.ok(!lines.some(line => /^railway (up|redeploy|variables|variable set)/.test(line)), `refusal mutated: ${lines.find(line => /^railway/.test(line))}`);

    await importApp();
    mark = fixture.allCommandLines().length;
    const plan = await bindPlan();
    lines = fixture.allCommandLines().slice(mark);
    assert.ok(!lines.some(line => /^railway (up|redeploy|variables|variable set|init|add)/.test(line) || /--method (POST|PUT|PATCH|DELETE)/.test(line)), `plan mutated: ${lines.find(line => /^railway |--method/.test(line))}`);
    assert.deepEqual(plan.actions.find(action => action.id === 'github.env')!.values!.map(value => value.name), APP_VARIABLES);
    assert.match(plan.actions.find(action => action.id === 'provider.deploy')!.title, DEPLOY_TITLE);
    mark = fixture.allCommandLines().length;
    await bindApply();
    lines = fixture.allCommandLines().slice(mark);
    assert.deepEqual(variablesSet(lines).sort(), [...APP_VARIABLES].sort());
    assert.equal(lines.filter(line => line === REDEPLOY).length, 1);
    assert.ok(!lines.some(line => /^railway up/.test(line) || /GRAPHYARD_BUILD_SHA/.test(line)));
  } finally { await fixture.cleanup(); }
});

test('unit:railway-app-bind-awaits-redeploy — after railway redeploy the bind waits for that deployment id to become SUCCESS and for /api/status to report the App before changing the webhook or recording the binding; a redeploy that fails while the old instance stays healthy refuses without webhook or record (GY-1908)', async () => {
  let redeployed: string | null = null;
  let polls = 0;
  const delayed = await observeOnlyInstallation({
    statusDelay: 2,
    railwayDeploy: [
      { match: 'railway deployment list', result: () => {
        if (!redeployed) return JSON.stringify([{ id: 'dep-serving', status: 'SUCCESS' }]);
        polls++;
        const status = polls < 3 ? 'DEPLOYING' : 'SUCCESS';
        return JSON.stringify([{ id: redeployed, status }, { id: 'dep-serving', status: 'SUCCESS' }]);
      } },
      { match: 'railway redeploy', result: () => { redeployed = 'dep-new'; polls = 0; return JSON.stringify({ id: redeployed }); } },
    ],
  });
  try {
    await delayed.importApp();
    const mark = delayed.fixture.allCommandLines().length;
    const hooksBefore = delayed.fixture.requests.filter(request => request.method === 'PATCH' && request.url.endsWith('/app/hook/config')).length;
    const summary = await delayed.bindApply();
    assert.equal(summary.status.githubAppId, APP_ID);
    assert.equal((await delayed.readRecord()).github.appId, APP_ID);
    assert.ok(polls >= 3, `redeploy was not polled until SUCCESS (polls=${polls})`);
    assert.ok(delayed.fixture.requests.filter(request => request.method === 'PATCH' && request.url.endsWith('/app/hook/config')).length > hooksBefore);
    const lines = delayed.fixture.allCommandLines().slice(mark);
    assert.equal(lines.filter(line => line === REDEPLOY).length, 1);
    assert.ok(lines.filter(line => line.includes('railway deployment list')).length >= 4, 'serving check plus await polls');
  } finally { await delayed.fixture.cleanup(); }

  let failedId: string | null = null;
  const failed = await observeOnlyInstallation({
    railwayDeploy: [
      { match: 'railway deployment list', result: () => !failedId
        ? JSON.stringify([{ id: 'dep-serving', status: 'SUCCESS' }])
        : JSON.stringify([{ id: failedId, status: 'FAILED' }, { id: 'dep-serving', status: 'SUCCESS' }]) },
      { match: 'railway redeploy', result: () => { failedId = 'dep-failed'; return JSON.stringify({ id: failedId }); } },
    ],
  });
  try {
    await failed.importApp();
    const mark = failed.fixture.allCommandLines().length;
    const hooksBefore = failed.fixture.requests.filter(request => request.method === 'PATCH' && request.url.endsWith('/app/hook/config')).length;
    await assert.rejects(failed.bindApply(), /redeployed deployment dep-failed is FAILED/);
    assert.equal((await failed.readRecord()).github, null);
    assert.equal(failed.fixture.requests.filter(request => request.method === 'PATCH' && request.url.endsWith('/app/hook/config')).length, hooksBefore, 'failed redeploy changed the webhook');
    const lines = failed.fixture.allCommandLines().slice(mark);
    assert.deepEqual(variablesSet(lines).sort(), [...APP_VARIABLES].sort(), 'variables were not written before the failed redeploy');
    assert.equal(lines.filter(line => line === REDEPLOY).length, 1);
    assert.ok(failed.fixture.requests.some(request => request.url.endsWith('/healthz')), 'old instance health was still probed');
  } finally { await failed.fixture.cleanup(); }
});

test('unit:railway-app-bind-refuses-non-serving-latest — when a newer failed deployment exists while an older SUCCESS still serves, app bind refuses before any variable write, upload or redeploy (GY-1908)', async () => {
  const { fixture, bindApply, importApp, readRecord } = await observeOnlyInstallation({
    railwayDeploy: [
      { match: 'railway deployment list', result: JSON.stringify([{ id: 'dep-failed', status: 'FAILED' }, { id: 'dep-serving', status: 'SUCCESS' }]) },
      { match: 'railway redeploy', result: () => { throw new Error('redeploy must not run when latest is not serving'); } },
    ],
  });
  try {
    await importApp();
    const mark = fixture.allCommandLines().length;
    const hooksBefore = fixture.requests.filter(request => request.method === 'PATCH' && request.url.endsWith('/app/hook/config')).length;
    await assert.rejects(bindApply(), /latest deployment dep-failed is FAILED, while dep-serving \(SUCCESS\) is still serving/);
    const lines = fixture.allCommandLines().slice(mark);
    assert.deepEqual(variablesSet(lines), []);
    assert.ok(!lines.some(line => /^railway (up|redeploy|variables|variable set)/.test(line)), `refusal mutated: ${lines.find(line => /^railway/.test(line))}`);
    assert.equal(fixture.requests.filter(request => request.method === 'PATCH' && request.url.endsWith('/app/hook/config')).length, hooksBefore);
    assert.equal((await readRecord()).github, null);
  } finally { await fixture.cleanup(); }
});

test('unit:observe-only-bind-app-writes-only-app-variables — graphyard app bind SLUG binds an App imported on the host to the recorded observation-only installation: exactly the five App variables are written, the control plane is deployed and healthy, the App webhook is repointed to it and the binding is recorded; a second run reports every step satisfied and writes nothing; without the imported App it is refused naming graphyard app import', async () => {
  const { fixture, calls, logs, bind, bindPlan, bindApply, directory, importApp, readRecord } = await observeOnlyInstallation();
  try {
    await assert.rejects(bind('extra'), /Use app bind SLUG \[--plan\]/);
    await assert.rejects(appCommand(['bind', 'not a slug'], { root: fixture.root, configHome: fixture.configHome }), /app bind takes an App slug/);
    await assert.rejects(appCommand(['list', SLUG], { root: fixture.root, configHome: fixture.configHome }), /Only app bind takes a SLUG/);
    // Without an imported App for the slug the bind is refused before any write, naming the import command.
    let mark = fixture.allCommandLines().length;
    const refusedPlan = await bindPlan();
    const item = refusedPlan.preflight.find(entry => entry.name === `Bind App ${SLUG}`)!;
    assert.equal(item.ok, false);
    assert.match(item.detail, /no registration for App graphyard-owner-project-imported is imported on this host/);
    assert.match(item.fix!, /^graphyard app import --repo owner\/project --app-id ID --key-file PEM/);
    await assert.rejects(bindApply(), /Preflight is incomplete; the installer changed nothing[\s\S]*graphyard app import/);
    assert.deepEqual(variablesSet(fixture.allCommandLines().slice(mark)), []);
    assert.ok(!fixture.allCommandLines().slice(mark).some(line => /^railway up/.test(line)), 'the refused bind deployed');
    assert.equal((await readRecord()).github, null);

    await importApp();
    const plan = await bindPlan();
    assert.equal(plan.observeOnly, true);
    assert.ok(plan.preflight.every(entry => entry.ok), JSON.stringify(plan.preflight.filter(entry => !entry.ok)));
    assert.match(plan.preflight.find(entry => entry.name === `Bind App ${SLUG}`)!.detail, /imported control-plane App graphyard-owner-project-imported \(app 310077\).*--apply adds owner\/project to that installation/);
    assert.deepEqual(['github.app', 'github.env', 'provider.deploy', 'github.webhook', 'github.ci-app-ids'].map(id => state(plan.actions, id)), ['update', 'create', 'update', 'create', 'create']);
    assert.deepEqual(plan.actions.find(action => action.id === 'github.env')!.values!.map(value => value.name), APP_VARIABLES);
    assert.ok(!JSON.stringify(plan).includes(IMPORTED_SECRET) && !JSON.stringify(plan).includes(appKey.split('\n')[1]), 'the plan leaks the imported App credentials');

    mark = fixture.allCommandLines().length;
    const requestsBefore = fixture.requests.length;
    const summary = await bindApply();
    assert.deepEqual(summary.github, { appId: APP_ID, installationId: INSTALLATION_ID, slug: SLUG, ciAppIds: [CI_APP_ID] });
    assert.equal(summary.health, true);
    assert.equal(summary.status.githubAppId, APP_ID);
    assert.equal(summary.webhook.skipped, true);
    assert.match(summary.webhook.detail, /now delivers to https:\/\/graphyard-owner-project\.up\.railway\.app\/api\/github\/webhook/);
    const bindLines = fixture.allCommandLines().slice(mark);
    // Exactly the five App variables on the recorded service; one redeploy, no source upload or build stamp (GY-1908).
    const written = variablesSet(bindLines);
    assert.deepEqual(written.sort(), [...APP_VARIABLES].sort());
    assert.ok(!written.includes('GRAPHYARD_BUILD_SHA'), 'the bind stamped GRAPHYARD_BUILD_SHA');
    assert.ok(bindLines.filter(line => line.startsWith('railway variable')).every(line => line.includes(`--service ${SERVICE}`)), 'a variable was written outside the control-plane service');
    assert.equal(bindLines.filter(line => line === REDEPLOY).length, 1, 'the bind did not redeploy exactly once');
    assert.ok(!bindLines.some(line => /^railway up/.test(line)), 'the bind uploaded source');
    assert.ok(!bindLines.some(line => /^railway (init|add)/.test(line)), 'the bind provisioned again');
    assert.equal(bindLines.filter(line => line === `gh api --method PUT /user/installations/${INSTALLATION_ID}/repositories/${REPOSITORY_ID}`).length, 1, 'the repository was not added to the App installation exactly once');
    const bindRequests = fixture.requests.slice(requestsBefore);
    assert.ok(bindRequests.some(request => request.url.endsWith('/healthz')), 'health was not waited for');
    assert.equal(bindRequests.filter(request => request.method === 'PATCH' && request.url.endsWith('/app/hook/config')).length, 1);
    assert.deepEqual(fixture.state.hookConfig, { url: `${summary.url}/api/github/webhook`, content_type: 'json', insecure_ssl: '0', secret: IMPORTED_SECRET });
    const record = await readRecord();
    assert.deepEqual({ appId: record.github.appId, installationId: record.github.installationId, slug: record.github.slug, ciAppIds: record.github.ciAppIds, noGithubApp: record.noGithubApp }, { appId: APP_ID, installationId: INSTALLATION_ID, slug: SLUG, ciAppIds: [CI_APP_ID], noGithubApp: false });
    assert.equal(typeof record.github.webhookFingerprint, 'string');
    assert.ok(!JSON.stringify(record).includes(IMPORTED_SECRET), 'the record holds the webhook secret');
    assert.ok(summary.nextSteps.some(step => /Observation-only: GitHub App graphyard-owner-project-imported \(app 310077\) is bound to the control plane, and nothing owner\/project or its product owns was changed/.test(step)));
    assert.ok(logs.some(line => /Repointing the App webhook/.test(line)));
    assert.deepEqual(calls, { githubApp: 0, registerProfiles: 0, runHerdr: 0, provision: 0 });

    // A second identical run: every step is reported satisfied, and nothing is written again.
    const replanned = await bindPlan();
    assert.ok(replanned.preflight.every(entry => entry.ok), JSON.stringify(replanned.preflight.filter(entry => !entry.ok)));
    for (const action of replanned.actions.filter(action => action.state !== 'held' && !action.id.startsWith('verify.'))) assert.equal(action.state, 'satisfied', `${action.id} is ${action.state} after the bind`);
    mark = fixture.allCommandLines().length;
    const patches = fixture.requests.filter(request => request.method === 'PATCH').length;
    const second = await bindApply();
    assert.deepEqual(second.github, summary.github);
    assert.match(second.webhook.detail, /already delivers to/);
    const secondLines = fixture.allCommandLines().slice(mark);
    assert.deepEqual(variablesSet(secondLines), []);
    assert.ok(!secondLines.some(line => /^railway (up|redeploy|init|add)/.test(line) || /--method (POST|PUT|PATCH|DELETE)/.test(line)), `the second run wrote ${secondLines.find(line => /^railway (up|redeploy|init|add)/.test(line) || /--method/.test(line))}`);
    assert.equal(fixture.requests.filter(request => request.method === 'PATCH').length, patches, 'the second run repointed the webhook again');
    assert.deepEqual(await readRecord(), record, 'the second run rewrote the install record');
    assert.equal(directory, summary.installDirectory);
  } finally { await fixture.cleanup(); }
});

test('unit:bind-app-holds-protection-wiring-profiles-herdr — graphyard app bind writes no branch protection, release ref or wiring, check run, auto-merge or merge-queue setting, principal, profile or Herdr link; a later install --observe-only --apply keeps the binding and binds nothing; --observe-only takes no App flag; docs/install.md documents app bind after an observation-only install', async () => {
  const ARGS_APPLY = [...ARGS, '--apply'];
  for (const flag of [['--github-app', 'app.json'], ['--reuse-app', SLUG]]) assert.throws(() => installRequestFromArgs([...ARGS_APPLY, ...flag]), new RegExp(`--observe-only changes nothing the repository owns.*${flag[0]}`));
  assert.throws(() => installRequestFromArgs([...ARGS_APPLY, '--bind-app', SLUG]), /Unknown option '--bind-app'/);
  const docs = await readFile(new URL('../docs/install.md', import.meta.url), 'utf8');
  assert.ok(!docs.includes('--bind-app'), 'docs/install.md still documents --bind-app');
  assert.ok(docs.split('\n').some(line => line.includes('--observe-only') && line.includes('app bind SLUG') && /keep/.test(line)), 'docs/install.md documents app bind after an observation-only install, and that later applies keep the binding');

  const { fixture, calls, observe, bindPlan, bindApply, importApp, readRecord } = await observeOnlyInstallation();
  try {
    await importApp();
    const plan = await bindPlan();
    const heldActions = plan.actions.filter(action => action.state === 'held');
    assert.deepEqual(heldActions.map(action => action.id), ['github.protection', 'release.branches', 'release.github-environments', 'release.railway.project', 'release.railway.uat', 'release.railway.production', 'verify.webhook', 'local.workers', 'local.profiles', 'local.herdr']);
    for (const action of heldActions) assert.ok(action.held!.startsWith(`${OBSERVE_ONLY_HELD}: `), `${action.id} is not named as held by observation-only`);
    assert.match(plan.actions.find(action => action.id === 'github.protection')!.held!, /branch protection, auto-merge and merge-queue settings are never written/);
    assert.match(plan.actions.find(action => action.id === 'release.branches')!.held!, /release refs are not created/);
    assert.match(plan.actions.find(action => action.id === 'verify.webhook')!.held!, /no check run is published/);
    assert.match(plan.actions.find(action => action.id === 'local.profiles')!.held!, /no profile, supervisor unit or master loop/);
    assert.match(plan.actions.find(action => action.id === 'local.herdr')!.held!, /Herdr is left untouched/);
    assert.ok(!plan.principals.some(principal => principal.role === 'worker' || principal.role === 'producer'), 'a worker principal was planned');

    const principalsBefore = (await readRecord()).principals;
    let mark = fixture.allCommandLines().length;
    let requestsBefore = fixture.requests.length;
    const summary = await bindApply();
    assert.equal(summary.github?.appId, APP_ID);
    assert.deepEqual(summary.held!.map(entry => entry.id), heldActions.map(action => action.id));
    assert.match(summary.protection, /held by observation-only.*branch protection, auto-merge and merge-queue settings were not read or written/);
    assert.deepEqual(summary.release.created, []);
    assert.deepEqual(summary.profiles.workers, []);
    assert.deepEqual(summary.profiles.reviewers, []);
    assert.equal(summary.profiles.master.configured, false);
    assert.equal(summary.profiles.repository.herdr, false);
    assert.deepEqual(calls, { githubApp: 0, registerProfiles: 0, runHerdr: 0, provision: 0 });
    assert.deepEqual((await readRecord()).principals, principalsBefore, 'the bind changed the principals');

    let lines = fixture.allCommandLines().slice(mark);
    for (const pattern of mutations) assert.ok(!lines.some(line => pattern.test(line)), `the bind ran ${lines.find(line => pattern.test(line))}`);
    assert.ok(!variablesSet(lines).includes('GRAPHYARD_PRINCIPALS'), 'the bind wrote the principals');
    // The one GitHub write through gh adds the repository to the App's installation; nothing of the repository's is written.
    assert.deepEqual(lines.filter(line => /--method (POST|PUT|PATCH|DELETE)/.test(line)), [`gh api --method PUT /user/installations/${INSTALLATION_ID}/repositories/${REPOSITORY_ID}`]);
    let requests = fixture.requests.slice(requestsBefore);
    assert.ok(!requests.some(request => request.method === 'POST' && request.url.includes('/check-runs')), 'a check run was published');
    assert.ok(!requests.some(request => /\/protection|\/git\/refs|\/environments|\/rulesets/.test(request.url)), 'the repository was written through the API');
    assert.ok(!fixture.transport.commands.slice(mark).some(command => command.cwd?.endsWith('/release-railway')), 'the product deployment adapter ran railway');
    assert.ok(!lines.some(line => /^railway (init|add)/.test(line)), 'the bind provisioned the control plane again');

    // A later plain observation-only apply keeps the binding and binds nothing itself.
    const bound = await readRecord();
    const rerun = await observe('apply');
    const rerunPlan = await buildPlan(rerun);
    assert.ok(rerunPlan.preflight.every(entry => entry.ok), JSON.stringify(rerunPlan.preflight.filter(entry => !entry.ok)));
    assert.equal(state(rerunPlan.actions, 'github.app'), 'satisfied');
    assert.match(rerunPlan.actions.find(action => action.id === 'github.app')!.title, /Keep GitHub App graphyard-owner-project-imported \(app 310077\) bound by graphyard app bind/);
    mark = fixture.allCommandLines().length;
    requestsBefore = fixture.requests.length;
    const kept = await applyInstall(rerun, rerunPlan);
    assert.deepEqual(kept.github, { appId: APP_ID, installationId: INSTALLATION_ID, slug: SLUG, ciAppIds: [CI_APP_ID] });
    assert.equal(kept.status.githubAppId, APP_ID);
    const after = await readRecord();
    assert.deepEqual({ github: after.github, noGithubApp: after.noGithubApp }, { github: bound.github, noGithubApp: false });
    lines = fixture.allCommandLines().slice(mark);
    assert.deepEqual(variablesSet(lines).filter(name => APP_VARIABLES.includes(name)), [], 'the observation-only rerun wrote an App variable');
    assert.ok(!lines.some(line => /--method (POST|PUT|PATCH|DELETE)/.test(line)), 'the observation-only rerun wrote to GitHub');
    requests = fixture.requests.slice(requestsBefore);
    assert.ok(!requests.some(request => request.method === 'PATCH' && request.url.endsWith('/app/hook/config')), 'the observation-only rerun repointed the webhook');
    assert.deepEqual(calls, { githubApp: 0, registerProfiles: 0, runHerdr: 0, provision: 0 });
  } finally { await fixture.cleanup(); }
});

test('app bind refuses an installation not applied with --observe-only, records nothing when the server does not report the App, and detects CI Apps again when the first bind observed none (GY-1877)', async () => {
  const { fixture, directory, bindPlan, bindApply, importApp, readRecord, ci, server } = await observeOnlyInstallation({ ciVisible: false });
  try {
    await importApp();
    // An installation whose latest apply was not observation-only: its roster and environment are not this bind's to rewrite.
    const marker = join(directory, 'observe-only-applied.json');
    const saved = await readFile(marker, 'utf8');
    await rm(marker);
    const refused = (await bindPlan()).preflight.find(entry => entry.name === 'Installation')!;
    assert.equal(refused.ok, false);
    assert.match(refused.detail, /was not applied with --observe-only/);
    await writeFile(marker, saved, { mode: 0o600 });

    // A server that does not load the App: the variables were written, but the binding is not recorded.
    server.loadsApp = false;
    await assert.rejects(bindApply(), /reports no GitHub App after GitHub App graphyard-owner-project-imported \(app 310077\) was written to it, so the binding is not recorded/);
    assert.equal((await readRecord()).github, null);
    server.loadsApp = true;

    // No CI App has published a check yet: the bind records none, and the plan keeps detecting them.
    const first = await bindApply();
    assert.deepEqual(first.github?.ciAppIds, []);
    const pending = await bindPlan();
    assert.deepEqual(['github.env', 'provider.deploy', 'github.ci-app-ids'].map(id => state(pending.actions, id)), ['update', 'update', 'create']);
    ci.visible = true;
    const mark = fixture.allCommandLines().length;
    const second = await bindApply();
    assert.deepEqual(second.github?.ciAppIds, [CI_APP_ID]);
    const lines = fixture.allCommandLines().slice(mark);
    assert.ok(lines.some(line => line.includes(`--set GITHUB_CI_APP_IDS=${CI_APP_ID}`)), 'GITHUB_CI_APP_IDS was not written');
    assert.equal(lines.filter(line => line === REDEPLOY).length, 1);
    assert.ok(!lines.some(line => /^railway up/.test(line) || variablesSet(lines).includes('GRAPHYARD_BUILD_SHA')), 'the CI-App write uploaded or stamped');
    assert.deepEqual((await readRecord()).github.ciAppIds, [CI_APP_ID]);
  } finally { await fixture.cleanup(); }
});

test('app bind reaches a recorded docker-host installation through --ssh-host, which its record does not keep, and refuses without it; it writes the control-plane variables back unchanged and refuses a checkout whose policy would change them (GY-1877)', async () => {
  // The host answers `cat` with what the installer wrote there, so the bind reads the deployed environment.
  const readHost = { match: 'cat ', result: (line: string) => { const file = fixture.hostFiles.get(line.split(' ').pop()!); return file ? file.content : { stdout: '', stderr: 'No such file or directory', code: 1 }; } };
  const fixture = await harness({ provider: 'docker-host', apps: [{ appId: APP_ID, slug: SLUG, installationId: INSTALLATION_ID }], extraResponses: [readHost],
    statusBody: () => {
      // The host's environment file is the deployment's: the served App is the one written there.
      const bound = [...fixture.hostFiles.values(), ...[...fixture.remotes.values()].flatMap(remote => [...remote.files.values()])].some(file => file.content.includes(`GITHUB_APP_ID=${APP_ID}`));
      return { actor: { id: 'owner-project-operator', role: 'admin' }, repository: REPOSITORY, github: bound, githubAppId: bound ? APP_ID : null, githubInstallationId: bound ? INSTALLATION_ID : null };
    } });
  try {
    const target = { sshHost: '203.0.113.10', sshUser: 'deploy', domain: 'graphyard.example.test' };
    const first = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'docker-host', observeOnly: true, ...target }, fixture.deps);
    await applyInstall(first, await buildPlan(first));
    await writeFile(join(first.directory, `imported-app-${SLUG}.json`), JSON.stringify({ appId: APP_ID, slug: SLUG, privateKey: appKey, webhookSecret: IMPORTED_SECRET, repository: REPOSITORY, role: 'control-plane' }), { mode: 0o600 });
    const bind = (...flags: string[]) => appCommand(['bind', SLUG, ...flags], { root: fixture.root, configHome: fixture.configHome, install: fixture.deps });
    await assert.rejects(bind('--plan', '--ssh-host', target.sshHost, '--workspace', 'Graphyard'), /--workspace names a Railway installation's workspace; owner\/project is installed on docker-host/);
    await assert.rejects(bind('--plan'), /installed on a Docker host, and its record keeps no SSH target: rerun as graphyard app bind graphyard-owner-project-imported --ssh-host HOST/);
    const serverEnv = () => fixture.hostFiles.get('/opt/graphyard/owner-project/server.env')!.content;
    const deployed = serverEnv();
    // A checkout whose policy changed since the observation-only apply would redeploy a different
    // GRAPHYARD_REPOSITORY_POLICY beside the App's variables: the plan and the apply refuse, writing nothing.
    const policy = join(fixture.root, 'graphyard.json');
    const original = await readFile(policy, 'utf8').catch(() => null);
    await writeFile(policy, JSON.stringify({ documentation: { paths: ['README.md'], changelog: null }, risk: { sensitive: [{ rule: 'billing', glob: 'billing/' }] } }));
    const drifted = await bind('--plan', '--ssh-host', target.sshHost, '--ssh-user', target.sshUser) as InstallPlan;
    const refusal = drifted.preflight.find(entry => entry.name === 'Control-plane variables');
    assert.ok(refusal && !refusal.ok && refusal.detail.includes('GRAPHYARD_REPOSITORY_POLICY'), JSON.stringify(drifted.preflight));
    await assert.rejects(bind('--ssh-host', target.sshHost, '--ssh-user', target.sshUser), /Control-plane variables: docker-host rewrites the whole environment, and binding the App would also change [^\n]*GRAPHYARD_REPOSITORY_POLICY/);
    assert.equal(serverEnv(), deployed, 'a refused bind wrote the environment');
    if (original === null) await rm(policy); else await writeFile(policy, original);
    const plan = await bind('--plan', '--ssh-host', target.sshHost, '--ssh-user', target.sshUser) as InstallPlan;
    assert.equal(plan.preflight.find(entry => entry.name === 'SSH target')!.detail, 'deploy@203.0.113.10');
    assert.ok(plan.preflight.every(entry => entry.ok), JSON.stringify(plan.preflight.filter(entry => !entry.ok)));
    const summary = await bind('--ssh-host', target.sshHost, '--ssh-user', target.sshUser) as InstallSummary;
    assert.equal(summary.github?.appId, APP_ID);
    assert.equal(summary.url, 'https://graphyard.example.test');
    // Exactly the App's variables were added; every deployed control-plane line is written back as it was.
    const added = serverEnv().split('\n').filter(line => !deployed.split('\n').includes(line)).map(line => line.split('=')[0]);
    assert.deepEqual(added.sort(), ['GITHUB_APP_ID', 'GITHUB_CI_APP_IDS', 'GITHUB_INSTALLATION_ID', 'GITHUB_PRIVATE_KEY_FILE', 'GITHUB_WEBHOOK_SECRET']);
    assert.ok(deployed.split('\n').every(line => serverEnv().split('\n').includes(line)), 'a control-plane variable was rewritten');
  } finally { await fixture.cleanup(); }
});

test('app bind takes --ssh-user and --ssh-key only for an installation reached over SSH, and --ssh-host only for docker-host (GY-1877)', async () => {
  const { fixture, bind } = await observeOnlyInstallation();
  try {
    await assert.rejects(bind('--ssh-host', '203.0.113.10'), /--ssh-host names a docker-host installation's target; owner\/project is installed on railway/);
    await assert.rejects(bind('--ssh-user', 'deploy'), /--ssh-user and --ssh-key reach a docker-host or Hetzner installation/);
    await assert.rejects(appCommand(['list', '--ssh-host', 'h'], { root: fixture.root, configHome: fixture.configHome }), /Only app bind takes/);
  } finally { await fixture.cleanup(); }
});

test('app bind binds a re-imported App again: a rotated key and new webhook secret are written to the server and the App webhook, and an observation-only rerun refuses until then; a CI publisher added after the bind is written on the next rerun (GY-1877)', async () => {
  const { fixture, observe, bindPlan, bindApply, importApp, readRecord, ci } = await observeOnlyInstallation();
  try {
    await importApp();
    await bindApply();
    const bound = await readRecord();
    // `graphyard app import` run again (a rotated private key) writes a fresh webhook secret.
    const ROTATED = 'rotated-webhook-secret-for-tests-9e8d7c6b';
    await importApp(ROTATED);
    const plan = await bindPlan();
    assert.ok(plan.preflight.every(entry => entry.ok), JSON.stringify(plan.preflight.filter(entry => !entry.ok)));
    assert.match(plan.preflight.find(entry => entry.name === `Rebind App ${SLUG}`)!.detail, /imported again, so its private key and webhook secret are new/);
    assert.deepEqual(['github.app', 'github.env', 'provider.deploy', 'github.webhook'].map(id => state(plan.actions, id)), ['update', 'update', 'update', 'update']);
    assert.ok(!JSON.stringify(plan).includes(ROTATED), 'the plan leaks the rotated webhook secret');
    // A whole-environment observation-only rerun would load the new secret while GitHub keeps the old one: refused, naming app bind.
    const rerunPlan = await buildPlan(await observe('plan'));
    const refused = rerunPlan.preflight.find(entry => entry.name === 'GitHub App')!;
    assert.equal(refused.ok, false);
    assert.match(refused.detail, /was imported again since graphyard app bind bound it/);
    assert.equal(refused.fix, `graphyard app bind ${SLUG}, then rerun`);

    let mark = fixture.allCommandLines().length;
    let patches = fixture.requests.filter(request => request.method === 'PATCH').length;
    const rebound = await bindApply();
    assert.equal(rebound.github?.appId, APP_ID);
    let lines = fixture.allCommandLines().slice(mark);
    assert.deepEqual(variablesSet(lines).sort(), [...APP_VARIABLES].sort());
    assert.equal(lines.filter(line => line === REDEPLOY).length, 1, 'the rebind did not redeploy exactly once');
    assert.ok(!lines.some(line => /^railway up/.test(line)), 'the rebind uploaded source');
    assert.equal(fixture.requests.filter(request => request.method === 'PATCH').length, patches + 1, 'the webhook secret was not set again');
    assert.equal(fixture.state.hookConfig?.secret, ROTATED);
    const record = await readRecord();
    assert.notEqual(record.github.webhookFingerprint, bound.github.webhookFingerprint, 'the refreshed binding was not recorded');
    assert.ok(!JSON.stringify(record).includes(ROTATED));
    // The refreshed binding is current: the observation-only rerun plans again, and an identical bind writes nothing.
    assert.ok((await buildPlan(await observe('plan'))).preflight.every(entry => entry.ok));
    mark = fixture.allCommandLines().length;
    patches = fixture.requests.filter(request => request.method === 'PATCH').length;
    await bindApply();
    lines = fixture.allCommandLines().slice(mark);
    assert.deepEqual(variablesSet(lines), []);
    assert.ok(!lines.some(line => /^railway up/.test(line) || /--method (POST|PUT|PATCH|DELETE)/.test(line)));
    assert.equal(fixture.requests.filter(request => request.method === 'PATCH').length, patches);
    assert.deepEqual(await readRecord(), record);

    // Another CI App starts publishing checks: the plan names it, and the next bind writes GITHUB_CI_APP_IDS and deploys.
    ci.added = 424_242;
    const ciPlan = await bindPlan();
    assert.deepEqual(['github.env', 'provider.deploy', 'github.ci-app-ids'].map(id => state(ciPlan.actions, id)), ['update', 'update', 'update']);
    mark = fixture.allCommandLines().length;
    const widened = await bindApply();
    assert.deepEqual([...widened.github!.ciAppIds].sort(), [CI_APP_ID, 424_242].sort());
    lines = fixture.allCommandLines().slice(mark);
    assert.ok(lines.some(line => /--set GITHUB_CI_APP_IDS=/.test(line) && line.includes('424242')), 'GITHUB_CI_APP_IDS was not written with the new publisher');
    assert.equal(lines.filter(line => line === REDEPLOY).length, 1);
    assert.ok(!lines.some(line => /^railway up/.test(line)), 'the CI widen uploaded source');
    assert.deepEqual([...(await readRecord()).github.ciAppIds].sort(), [CI_APP_ID, 424_242].sort());
  } finally { await fixture.cleanup(); }
});

test('app bind adds the repository back to a bound App installation that no longer reaches it, writing nothing else, and passes --workspace to a Railway installation (GY-1877)', async () => {
  const { fixture, bind, bindPlan, bindApply, importApp, readRecord, app } = await observeOnlyInstallation();
  try {
    await importApp();
    await bindApply();
    const record = await readRecord();
    // The repository is removed from the App's selected-repositories installation after the bind.
    app.deselected = true;
    const plan = await bindPlan();
    assert.equal(state(plan.actions, 'github.app'), 'update');
    assert.match(plan.preflight.find(entry => entry.name === `Bind App ${SLUG}`)!.detail, /--apply adds owner\/project to that installation, which no longer reaches it/);
    const mark = fixture.allCommandLines().length;
    const patches = fixture.requests.filter(request => request.method === 'PATCH').length;
    const tokens = fixture.requests.filter(request => request.url.endsWith('/access_tokens')).length;
    await bindApply();
    const lines = fixture.allCommandLines().slice(mark);
    assert.deepEqual(lines.filter(line => /--method (POST|PUT|PATCH|DELETE)/.test(line)), [`gh api --method PUT /user/installations/${INSTALLATION_ID}/repositories/${REPOSITORY_ID}`]);
    assert.ok(fixture.requests.filter(request => request.url.endsWith('/access_tokens')).length > tokens, 'the App did not prove it reaches the repository');
    assert.equal(app.deselected, false);
    assert.deepEqual(variablesSet(lines), []);
    assert.ok(!lines.some(line => /^railway up/.test(line)), 'the repair deployed');
    assert.equal(fixture.requests.filter(request => request.method === 'PATCH').length, patches);
    assert.deepEqual(await readRecord(), record);
    assert.equal(state((await bindPlan()).actions, 'github.app'), 'satisfied');

    // A Railway account in several workspaces names the one its install used; another provider refuses the flag.
    const named = await bind('--plan', '--workspace', 'Graphyard') as InstallPlan;
    assert.equal(named.preflight.find(entry => entry.name === 'Railway workspace')!.detail, 'Graphyard (ws-graphyard-0001)', 'the named workspace was not the one resolved');
    await assert.rejects(appCommand(['list', '--workspace', 'Personal'], { root: fixture.root, configHome: fixture.configHome }), /Only app bind takes/);
  } finally { await fixture.cleanup(); }
});
