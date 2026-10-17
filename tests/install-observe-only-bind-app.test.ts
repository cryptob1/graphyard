import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyInstall, buildPlan, installRequestFromArgs, prepareInstall, resumeCommand, type InstallDependencies } from '../src/install/index.js';
import { deliveryPolicySchema } from '../src/model/delivery-policy.js';
import { appKey, harness, CI_APP_ID, REPOSITORY, REPOSITORY_ID } from './install-harness.js';

// GY-1877: `install --observe-only --bind-app SLUG` binds an App `graphyard app import` saved on this
// host to the observation-only control plane: exactly the full install's App step, and nothing more.
const SERVICE = 'graphyard-owner-project';
const SLUG = 'graphyard-owner-project-imported';
const APP_ID = 310_077;
const INSTALLATION_ID = 777;
const IMPORTED_SECRET = 'imported-webhook-secret-for-tests-5a6b7c8d';
const OBSERVE_ONLY_HELD = 'held by observation-only (--observe-only)';
const APP_VARIABLES = ['GITHUB_APP_ID', 'GITHUB_INSTALLATION_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_CI_APP_IDS'];
const ARGS = ['--provider', 'railway', '--repo', REPOSITORY, '--observe-only'];

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

const releaseCandidate = deliveryPolicySchema.parse({
  mode: 'release-candidate', candidateSchedule: '0 */6 * * *',
  mergeGate: { preMerge: [{ check: 'test', command: 'npm run test', source: 'script', reason: 'fast' }], perCandidate: [{ check: 'test:e2e', command: 'npm run test:e2e', source: 'script', reason: 'long' }] },
  deploy: { adapter: 'railway', project: null, uat: null, production: null },
});

/** The variable names a slice of recorded Railway commands sets: plain ones in --set, secrets by name over standard input. */
const variablesSet = (lines: string[]) => lines.flatMap(line => line.startsWith('railway variables ') ? [...line.matchAll(/--set ([A-Z_]+)=/g)].map(match => match[1]) : /^railway variable set .* --stdin ([A-Z_]+)$/.exec(line)?.slice(1) ?? []);
const mutations = [/git\/refs/, /\/protection/, /rulesets/, /allow_auto_merge|auto-merge|merge_queue/i, /^railway environment/, /^herdr /, /systemctl/, / master init/];

async function observeOnlyInstallation() {
  const fixture = await harness({ provider: 'railway', extraResponses: statefulRailway(), apps: [{ appId: APP_ID, slug: SLUG, installationId: INSTALLATION_ID }],
    statusBody: { actor: { id: 'owner-project-operator', role: 'admin' }, repository: REPOSITORY, github: false, githubAppId: null, githubInstallationId: null } });
  await writeFile(join(fixture.root, 'graphyard.json'), JSON.stringify({ documentation: { paths: ['README.md'], changelog: null }, delivery: releaseCandidate }));
  const calls = { githubApp: 0, registerProfiles: 0, runHerdr: 0, provision: 0 };
  const logs: string[] = [];
  const deps: InstallDependencies = { ...fixture.deps, log: line => logs.push(line),
    githubApp: async () => { calls.githubApp++; throw new Error('observation-only must not open the App flow'); },
    registerProfiles: async () => { calls.registerProfiles++; throw new Error('observation-only must not register profiles'); },
    runHerdr: () => { calls.runHerdr++; return ''; } };
  const prepare = async (mode: 'plan' | 'apply', bindApp?: string) => {
    const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'railway', observeOnly: true, ...(bindApp ? { bindApp } : {}) }, deps, mode);
    const adapter = session.delivery.adapter;
    session.delivery.adapter = { ...adapter, provision: async (...args) => { calls.provision++; return adapter.provision(...args); } };
    return session;
  };
  // The observation-only control plane this App is bound to, deployed first.
  const first = await prepare('apply');
  await applyInstall(first, await buildPlan(first));
  // What `graphyard app import --app-id APP_ID --key-file PEM` saves in the install directory.
  const importApp = () => writeFile(join(first.directory, `imported-app-${SLUG}.json`), JSON.stringify({ appId: APP_ID, slug: SLUG, privateKey: appKey, webhookSecret: IMPORTED_SECRET, repository: REPOSITORY, role: 'control-plane' }), { mode: 0o600 });
  return { fixture, calls, logs, prepare, directory: first.directory, importApp };
}

test('unit:observe-only-bind-app-writes-only-app-variables — install --observe-only --bind-app SLUG --apply binds an App imported on the host: exactly the five App variables are written, the control plane is deployed and healthy, the App webhook is repointed to it and the binding is recorded; a second apply reports every step satisfied and writes nothing; without the imported App it is refused naming graphyard app import', async () => {
  const { request } = installRequestFromArgs([...ARGS, '--bind-app', SLUG, '--apply']);
  assert.deepEqual({ observeOnly: request.observeOnly, bindApp: request.bindApp, noGithubApp: request.noGithubApp, herdr: request.herdr }, { observeOnly: true, bindApp: SLUG, noGithubApp: true, herdr: 'skip' });
  const resume = resumeCommand({ inputs: { ...request, baseBranch: 'main' } as any });
  assert.match(resume, /--observe-only --bind-app graphyard-owner-project-imported --apply$/);
  assert.equal(installRequestFromArgs(resume.split(' ').slice(2)).request.bindApp, SLUG);
  assert.throws(() => installRequestFromArgs(['--provider', 'railway', '--repo', REPOSITORY, '--bind-app', SLUG]), /--bind-app binds an imported App to an observation-only install; use it with --observe-only/);
  assert.throws(() => installRequestFromArgs([...ARGS, '--bind-app', 'not a slug']), /--bind-app takes an App slug/);

  const { fixture, calls, logs, prepare, directory, importApp } = await observeOnlyInstallation();
  try {
    await assert.rejects(prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'railway', bindApp: SLUG }, fixture.deps, 'apply'), /use it with --observe-only/);
    // Without an imported App for the slug the bind is refused before any write, naming the import command.
    let mark = fixture.allCommandLines().length;
    const refused = await prepare('apply', SLUG);
    const refusedPlan = await buildPlan(refused);
    const item = refusedPlan.preflight.find(entry => entry.name === `Bind App ${SLUG}`)!;
    assert.equal(item.ok, false);
    assert.match(item.detail, /no registration for App graphyard-owner-project-imported is imported on this host/);
    assert.match(item.fix!, /^graphyard app import --repo owner\/project --app-id ID --key-file PEM/);
    await assert.rejects(applyInstall(refused, refusedPlan), /Preflight is incomplete; the installer changed nothing[\s\S]*graphyard app import/);
    assert.deepEqual(variablesSet(fixture.allCommandLines().slice(mark)), []);
    assert.ok(!fixture.allCommandLines().slice(mark).some(line => /^railway up/.test(line)), 'the refused bind deployed');

    await importApp();
    const plan = await buildPlan(await prepare('plan', SLUG));
    assert.equal(plan.observeOnly, true);
    assert.ok(plan.preflight.every(entry => entry.ok), JSON.stringify(plan.preflight.filter(entry => !entry.ok)));
    assert.match(plan.preflight.find(entry => entry.name === `Bind App ${SLUG}`)!.detail, /imported control-plane App graphyard-owner-project-imported \(app 310077\).*--apply adds owner\/project to that installation/);
    const state = (actions: typeof plan.actions, id: string) => actions.find(action => action.id === id)!.state;
    assert.deepEqual(['github.app', 'github.env', 'provider.deploy', 'github.webhook', 'github.ci-app-ids'].map(id => state(plan.actions, id)), ['update', 'create', 'update', 'create', 'create']);
    assert.deepEqual(plan.actions.find(action => action.id === 'github.env')!.values!.map(value => value.name), APP_VARIABLES);
    assert.ok(!JSON.stringify(plan).includes(IMPORTED_SECRET) && !JSON.stringify(plan).includes(appKey.split('\n')[1]), 'the plan leaks the imported App credentials');

    mark = fixture.allCommandLines().length;
    const requestsBefore = fixture.requests.length;
    const session = await prepare('apply', SLUG);
    const summary = await applyInstall(session, await buildPlan(session));
    assert.deepEqual(summary.github, { appId: APP_ID, installationId: INSTALLATION_ID, slug: SLUG, ciAppIds: [CI_APP_ID] });
    assert.equal(summary.health, true);
    assert.equal(summary.webhook.skipped, true);
    assert.match(summary.webhook.detail, /now delivers to https:\/\/graphyard-owner-project\.up\.railway\.app\/api\/github\/webhook/);
    const bindLines = fixture.allCommandLines().slice(mark);
    // Exactly the five App variables; the deploy stamps its own GRAPHYARD_BUILD_SHA and uploads once.
    const written = variablesSet(bindLines);
    assert.deepEqual(written.filter(name => name !== 'GRAPHYARD_BUILD_SHA').sort(), [...APP_VARIABLES].sort());
    assert.equal(bindLines.filter(line => /^railway up/.test(line)).length, 1, 'the bind did not deploy exactly once');
    assert.ok(!bindLines.some(line => /^railway (init|add)/.test(line)), 'the bind provisioned again');
    assert.equal(bindLines.filter(line => line === `gh api --method PUT /user/installations/${INSTALLATION_ID}/repositories/${REPOSITORY_ID}`).length, 1, 'the repository was not added to the App installation exactly once');
    const bindRequests = fixture.requests.slice(requestsBefore);
    assert.ok(bindRequests.some(request => request.url.endsWith('/healthz')), 'health was not waited for');
    assert.equal(bindRequests.filter(request => request.method === 'PATCH' && request.url.endsWith('/app/hook/config')).length, 1);
    assert.deepEqual(fixture.state.hookConfig, { url: `${summary.url}/api/github/webhook`, content_type: 'json', insecure_ssl: '0', secret: IMPORTED_SECRET });
    const record = JSON.parse(await readFile(join(directory, 'install.json'), 'utf8'));
    assert.deepEqual({ appId: record.github.appId, installationId: record.github.installationId, slug: record.github.slug, ciAppIds: record.github.ciAppIds, noGithubApp: record.noGithubApp }, { appId: APP_ID, installationId: INSTALLATION_ID, slug: SLUG, ciAppIds: [CI_APP_ID], noGithubApp: false });
    assert.equal(typeof record.github.webhookFingerprint, 'string');
    assert.ok(!JSON.stringify(record).includes(IMPORTED_SECRET), 'the record holds the webhook secret');
    assert.ok(summary.nextSteps.some(step => /Observation-only: GitHub App graphyard-owner-project-imported \(app 310077\) is bound to the control plane, and nothing owner\/project or its product owns was changed/.test(step)));
    assert.ok(logs.some(line => /Repointing the App webhook/.test(line)));
    assert.deepEqual(calls, { githubApp: 0, registerProfiles: 0, runHerdr: 0, provision: 0 });

    // A second identical apply: every step is reported satisfied, and nothing is written again.
    const replanned = await buildPlan(await prepare('plan', SLUG));
    assert.ok(replanned.preflight.every(entry => entry.ok), JSON.stringify(replanned.preflight.filter(entry => !entry.ok)));
    for (const action of replanned.actions.filter(action => action.state !== 'held' && !action.id.startsWith('verify.'))) assert.equal(action.state, 'satisfied', `${action.id} is ${action.state} after the bind`);
    mark = fixture.allCommandLines().length;
    const patches = fixture.requests.filter(request => request.method === 'PATCH').length;
    const again = await prepare('apply', SLUG);
    const second = await applyInstall(again, replanned);
    assert.deepEqual(second.github, summary.github);
    assert.match(second.webhook.detail, /already delivers to/);
    const secondLines = fixture.allCommandLines().slice(mark);
    assert.deepEqual(variablesSet(secondLines), []);
    assert.ok(!secondLines.some(line => /^railway (up|redeploy|init|add)/.test(line) || /--method (POST|PUT|PATCH|DELETE)/.test(line)), `the second apply wrote ${secondLines.find(line => /^railway (up|redeploy|init|add)/.test(line) || /--method/.test(line))}`);
    assert.equal(fixture.requests.filter(request => request.method === 'PATCH').length, patches, 'the second apply repointed the webhook again');
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'install.json'), 'utf8')), record, 'the second apply rewrote the install record');
  } finally { await fixture.cleanup(); }
});

test('unit:bind-app-holds-protection-wiring-profiles-herdr — the --observe-only --bind-app apply writes no branch protection, release ref or wiring, check run, auto-merge or merge-queue setting, profile or Herdr link, its plan holds each by observation-only, plain --observe-only still refuses --github-app and --reuse-app, and docs/install.md documents --bind-app beside --observe-only', async () => {
  for (const flag of [['--github-app', 'app.json'], ['--reuse-app', SLUG]]) {
    assert.throws(() => installRequestFromArgs([...ARGS, ...flag]), new RegExp(`--observe-only changes nothing the repository owns.*${flag[0]}`));
    assert.throws(() => installRequestFromArgs([...ARGS, '--bind-app', SLUG, ...flag]), new RegExp(`--observe-only changes nothing the repository owns.*${flag[0]}`));
  }
  const docs = await readFile(new URL('../docs/install.md', import.meta.url), 'utf8');
  assert.ok(docs.split('\n').some(line => line.includes('--observe-only') && line.includes('--bind-app SLUG')), 'docs/install.md documents --bind-app beside --observe-only');
  assert.match(docs, /app import/);

  const { fixture, calls, prepare, importApp } = await observeOnlyInstallation();
  try {
    await importApp();
    const plan = await buildPlan(await prepare('plan', SLUG));
    const heldActions = plan.actions.filter(action => action.state === 'held');
    assert.deepEqual(heldActions.map(action => action.id), ['github.protection', 'release.branches', 'release.github-environments', 'release.railway.project', 'release.railway.uat', 'release.railway.production', 'verify.webhook', 'local.workers', 'local.profiles', 'local.herdr']);
    for (const action of heldActions) assert.ok(action.held!.startsWith(`${OBSERVE_ONLY_HELD}: `), `${action.id} is not named as held by observation-only`);
    assert.match(plan.actions.find(action => action.id === 'github.protection')!.held!, /branch protection, auto-merge and merge-queue settings are never written/);
    assert.match(plan.actions.find(action => action.id === 'release.branches')!.held!, /release refs are not created/);
    assert.match(plan.actions.find(action => action.id === 'verify.webhook')!.held!, /no check run is published/);
    assert.match(plan.actions.find(action => action.id === 'local.profiles')!.held!, /no profile, supervisor unit or master loop/);
    assert.match(plan.actions.find(action => action.id === 'local.herdr')!.held!, /Herdr is left untouched/);
    assert.ok(!plan.principals.some(principal => principal.role === 'worker' || principal.role === 'producer'), 'a worker principal was planned');

    const mark = fixture.allCommandLines().length;
    const requestsBefore = fixture.requests.length;
    const session = await prepare('apply', SLUG);
    const summary = await applyInstall(session, await buildPlan(session));
    assert.equal(summary.github?.appId, APP_ID);
    assert.deepEqual(summary.held!.map(entry => entry.id), heldActions.map(action => action.id));
    assert.match(summary.protection, /held by observation-only.*branch protection, auto-merge and merge-queue settings were not read or written/);
    assert.deepEqual(summary.release.created, []);
    assert.deepEqual(summary.profiles.workers, []);
    assert.deepEqual(summary.profiles.reviewers, []);
    assert.equal(summary.profiles.master.configured, false);
    assert.equal(summary.profiles.repository.herdr, false);
    assert.deepEqual(calls, { githubApp: 0, registerProfiles: 0, runHerdr: 0, provision: 0 });

    const lines = fixture.allCommandLines().slice(mark);
    for (const pattern of mutations) assert.ok(!lines.some(line => pattern.test(line)), `the bind ran ${lines.find(line => pattern.test(line))}`);
    // The one GitHub write through gh adds the repository to the App's installation; nothing of the repository's is written.
    assert.deepEqual(lines.filter(line => /--method (POST|PUT|PATCH|DELETE)/.test(line)), [`gh api --method PUT /user/installations/${INSTALLATION_ID}/repositories/${REPOSITORY_ID}`]);
    const requests = fixture.requests.slice(requestsBefore);
    assert.ok(!requests.some(request => request.method === 'POST' && request.url.includes('/check-runs')), 'a check run was published');
    assert.ok(!requests.some(request => /\/protection|\/git\/refs|\/environments|\/rulesets/.test(request.url)), 'the repository was written through the API');
    assert.ok(!fixture.transport.commands.slice(mark).some(command => command.cwd?.endsWith('/release-railway')), 'the product deployment adapter ran railway');
    assert.ok(!lines.some(line => /^railway (init|add)/.test(line)), 'the bind provisioned the control plane again');
  } finally { await fixture.cleanup(); }
});
