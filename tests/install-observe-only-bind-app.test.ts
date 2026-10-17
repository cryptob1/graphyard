import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appCommand, applyInstall, buildPlan, installRequestFromArgs, prepareInstall, type InstallDependencies, type InstallPlan, type InstallSummary } from '../src/install/index.js';
import { deliveryPolicySchema } from '../src/model/delivery-policy.js';
import { appKey, harness, CI_APP_ID, REPOSITORY, REPOSITORY_ID } from './install-harness.js';

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
const ciChecks = (ci: { visible: boolean }) => ({ match: `gh api repos/${REPOSITORY}/commits/main/check-runs`, result: () => JSON.stringify({ check_runs: ci.visible ? [{ name: 'test', app: { id: CI_APP_ID, slug: 'github-actions' } }] : [] }) });

const releaseCandidate = deliveryPolicySchema.parse({
  mode: 'release-candidate', candidateSchedule: '0 */6 * * *',
  mergeGate: { preMerge: [{ check: 'test', command: 'npm run test', source: 'script', reason: 'fast' }], perCandidate: [{ check: 'test:e2e', command: 'npm run test:e2e', source: 'script', reason: 'long' }] },
  deploy: { adapter: 'railway', project: null, uat: null, production: null },
});

/** The variable names a slice of recorded Railway commands sets: plain ones in --set, secrets by name over standard input. */
const variablesSet = (lines: string[]) => lines.flatMap(line => line.startsWith('railway variables ') ? [...line.matchAll(/--set ([A-Z_]+)=/g)].map(match => match[1]) : /^railway variable set .* --stdin ([A-Z_]+)$/.exec(line)?.slice(1) ?? []);
const mutations = [/git\/refs/, /\/protection/, /rulesets/, /allow_auto_merge|auto-merge|merge_queue/i, /^railway environment/, /^herdr /, /systemctl/, / master init/];

async function observeOnlyInstallation(options: { ciVisible?: boolean } = {}) {
  const ci = { visible: options.ciVisible ?? true };
  // The served App is the one whose GITHUB_APP_ID the deployment was given, unless the server fails to load it.
  const server = { loadsApp: true };
  let fixture: Awaited<ReturnType<typeof harness>>;
  fixture = await harness({ provider: 'railway', extraResponses: [ciChecks(ci), ...statefulRailway()], apps: [{ appId: APP_ID, slug: SLUG, installationId: INSTALLATION_ID }],
    statusBody: () => {
      const bound = server.loadsApp && fixture.allCommandLines().some(line => line.includes(`--set GITHUB_APP_ID=${APP_ID}`));
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
  const importApp = () => writeFile(join(first.directory, `imported-app-${SLUG}.json`), JSON.stringify({ appId: APP_ID, slug: SLUG, privateKey: appKey, webhookSecret: IMPORTED_SECRET, repository: REPOSITORY, role: 'control-plane' }), { mode: 0o600 });
  const readRecord = async () => JSON.parse(await readFile(join(first.directory, 'install.json'), 'utf8'));
  return { fixture, calls, logs, observe, bind, bindPlan, bindApply, directory: first.directory, importApp, readRecord, ci, server };
}

const state = (actions: InstallPlan['actions'], id: string) => actions.find(action => action.id === id)!.state;

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
    // Exactly the five App variables on the recorded service; the deploy stamps its own GRAPHYARD_BUILD_SHA and uploads once.
    const written = variablesSet(bindLines);
    assert.deepEqual(written.filter(name => name !== 'GRAPHYARD_BUILD_SHA').sort(), [...APP_VARIABLES].sort());
    assert.ok(bindLines.filter(line => line.startsWith('railway variable')).every(line => line.includes(`--service ${SERVICE}`)), 'a variable was written outside the control-plane service');
    assert.equal(bindLines.filter(line => /^railway up/.test(line)).length, 1, 'the bind did not deploy exactly once');
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
    assert.equal(lines.filter(line => /^railway up/.test(line)).length, 1);
    assert.deepEqual((await readRecord()).github.ciAppIds, [CI_APP_ID]);
  } finally { await fixture.cleanup(); }
});

test('app bind reaches a recorded docker-host installation through --ssh-host, which its record does not keep, and refuses without it (GY-1877)', async () => {
  const fixture = await harness({ provider: 'docker-host', apps: [{ appId: APP_ID, slug: SLUG, installationId: INSTALLATION_ID }],
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
    await assert.rejects(bind('--plan'), /installed on a Docker host, and its record keeps no SSH target: rerun as graphyard app bind graphyard-owner-project-imported --ssh-host HOST/);
    const plan = await bind('--plan', '--ssh-host', target.sshHost, '--ssh-user', target.sshUser) as InstallPlan;
    assert.equal(plan.preflight.find(entry => entry.name === 'SSH target')!.detail, 'deploy@203.0.113.10');
    assert.ok(plan.preflight.every(entry => entry.ok), JSON.stringify(plan.preflight.filter(entry => !entry.ok)));
    const summary = await bind('--ssh-host', target.sshHost, '--ssh-user', target.sshUser) as InstallSummary;
    assert.equal(summary.github?.appId, APP_ID);
    assert.equal(summary.url, 'https://graphyard.example.test');
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
