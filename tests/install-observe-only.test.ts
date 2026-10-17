import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyInstall, buildPlan, installRequestFromArgs, prepareInstall, resumeCommand, type InstallDependencies } from '../src/install/index.js';
import { fingerprint } from '../src/install/secrets.js';
import { deliveryPolicySchema } from '../src/model/delivery-policy.js';
import { allText, harness, REPOSITORY } from './install-harness.js';

// The repository's own Railway variables, as a value-printing listing would show them: none may
// reach a recorded command, the plan or the apply output, by value or by fingerprint.
const SEEDED = { DATABASE_URL: 'postgres://app:seeded-database-password-7f3a@db.internal:5432/app', GITHUB_WEBHOOK_SECRET: 'seeded-webhook-secret-91c2', STRIPE_KEY: 'sk_live_seeded-product-key-4d8e' };
const SERVICE = 'graphyard-owner-project';
const OBSERVE_ONLY_HELD = 'held by observation-only (--observe-only)';

/** A Railway account that remembers what the installer created, and a deploy that is interrupted once. */
function statefulRailway(state: { project: boolean; database: boolean; service: boolean; interrupt: number }) {
  return [
    { match: 'railway status --json', result: () => state.project
      ? JSON.stringify({ name: SERVICE, services: { edges: [...(state.database ? [{ node: { name: 'Postgres' } }] : []), ...(state.service ? [{ node: { name: SERVICE } }] : [])] } })
      : { stdout: '', stderr: 'no linked project', code: 1 } },
    { match: 'railway init', result: () => { state.project = true; return ''; } },
    { match: 'railway add --database', result: () => { state.database = true; return ''; } },
    { match: 'railway add --service', result: () => { state.service = true; return ''; } },
    { match: 'railway up', result: () => state.interrupt-- > 0 ? { stdout: '', stderr: 'deployment interrupted', code: 1 } : '' },
    { match: `railway variables --service ${SERVICE} --json`, result: JSON.stringify(SEEDED) },
    { match: `git/ref/heads/release`, result: { stdout: '', stderr: 'gh: Not Found (HTTP 404)', code: 1 } },
    { match: `repos/${REPOSITORY}/environments`, result: JSON.stringify({ environments: [] }) },
  ];
}

const releaseCandidate = deliveryPolicySchema.parse({
  mode: 'release-candidate', candidateSchedule: '0 */6 * * *',
  mergeGate: { preMerge: [{ check: 'test', command: 'npm run test', source: 'script', reason: 'fast' }], perCandidate: [{ check: 'test:e2e', command: 'npm run test:e2e', source: 'script', reason: 'long' }] },
  deploy: { adapter: 'railway', project: null, uat: null, production: null },
});

async function observeOnlyFixture(interrupt = 0) {
  const railway = { project: false, database: false, service: false, interrupt };
  const fixture = await harness({ provider: 'railway', extraResponses: statefulRailway(railway),
    statusBody: { actor: { id: 'owner-project-operator', role: 'admin' }, repository: REPOSITORY, github: false, githubAppId: null, githubInstallationId: null } });
  await writeFile(join(fixture.root, 'graphyard.json'), JSON.stringify({ documentation: { paths: ['README.md'], changelog: null }, delivery: releaseCandidate }));
  const calls = { githubApp: 0, registerProfiles: 0, runHerdr: 0, provision: 0 };
  const logs: string[] = [];
  const deps: InstallDependencies = { ...fixture.deps, log: line => logs.push(line),
    githubApp: async () => { calls.githubApp++; throw new Error('observation-only must not bind an App'); },
    registerProfiles: async () => { calls.registerProfiles++; throw new Error('observation-only must not register profiles'); },
    runHerdr: () => { calls.runHerdr++; return ''; } };
  const prepare = async (mode: 'plan' | 'apply') => {
    const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'railway', observeOnly: true }, deps, mode);
    const adapter = session.delivery.adapter;
    session.delivery.adapter = { ...adapter, provision: async (...args) => { calls.provision++; return adapter.provision(...args); } };
    return session;
  };
  return { fixture, railway, calls, logs, prepare };
}

const mutations = [/git\/refs/, /--method (POST|PUT|PATCH|DELETE)/, /\/protection/, /rulesets/, /allow_auto_merge|auto-merge|merge_queue/i, /^railway environment/, /^herdr /, /systemctl/, / master init/];

test('unit:install-observe-only-changes-nothing — install --observe-only --apply creates no ref, writes no protection, auto-merge or merge queue, binds no App, installs no worker, profile, supervisor unit or Herdr link, runs no product deployment adapter, and its plan names each held action', async () => {
  // The flag parses to the observation-only request, implying --no-github-app and --no-herdr,
  // refuses every flag that would change the repository, and survives the resume command.
  const { request } = installRequestFromArgs(['--provider', 'railway', '--repo', REPOSITORY, '--observe-only', '--apply']);
  assert.deepEqual({ observeOnly: request.observeOnly, noGithubApp: request.noGithubApp, herdr: request.herdr }, { observeOnly: true, noGithubApp: true, herdr: 'skip' });
  assert.match(resumeCommand({ inputs: { ...request, baseBranch: 'main' } as any }), /--no-herdr .*--no-github-app --observe-only --apply$/);
  for (const flag of [['--reviewer', 'claude'], ['--workers', '2'], ['--create-environments'], ['--herdr-rebind'], ['--producer-proof', 'unit']])
    assert.throws(() => installRequestFromArgs(['--provider', 'railway', '--repo', REPOSITORY, '--observe-only', ...flag]), new RegExp(`--observe-only changes nothing the repository owns.*${flag[0]}`));

  const { fixture, calls, logs, prepare } = await observeOnlyFixture();
  try {
    const plan = await buildPlan(await prepare('plan'));
    assert.equal(plan.observeOnly, true);
    assert.ok(plan.preflight.every(item => item.ok), JSON.stringify(plan.preflight.filter(item => !item.ok)));
    const heldIds = plan.actions.filter(action => action.state === 'held').map(action => action.id);
    assert.deepEqual(heldIds, ['github.app', 'github.protection', 'release.branches', 'release.github-environments', 'release.railway.project', 'release.railway.uat', 'release.railway.production', 'local.workers', 'local.profiles', 'local.herdr']);
    for (const action of plan.actions.filter(entry => entry.state === 'held')) assert.ok(action.held!.startsWith(`${OBSERVE_ONLY_HELD}: `), `${action.id} is not named as held by observation-only`);
    assert.match(plan.actions.find(action => action.id === 'release.branches')!.held!, /release refs are not created/);
    assert.match(plan.actions.find(action => action.id === 'github.protection')!.held!, /branch protection, auto-merge and merge-queue settings are never written/);
    assert.match(plan.actions.find(action => action.id === 'release.railway.uat')!.held!, /product deployment adapter does not run/);
    assert.ok(!plan.principals.some(principal => principal.role === 'worker' || principal.role === 'producer'), 'a worker principal was planned');
    // The control plane itself is still deployed.
    for (const id of ['provider.provision.project', 'provider.env.core', 'provider.deploy']) assert.notEqual(plan.actions.find(action => action.id === id)!.state, 'held');

    const session = await prepare('apply');
    const summary = await applyInstall(session, await buildPlan(session));
    assert.deepEqual(summary.held!.map(entry => entry.id), heldIds);
    assert.equal(summary.github, null);
    assert.deepEqual(summary.release.created, []);
    assert.match(summary.protection, /held by observation-only/);
    assert.deepEqual(summary.profiles.workers, []);
    assert.equal(summary.profiles.master.configured, false);
    assert.deepEqual(calls, { githubApp: 0, registerProfiles: 0, runHerdr: 0, provision: 0 });

    const lines = fixture.allCommandLines();
    for (const pattern of mutations) assert.ok(!lines.some(line => pattern.test(line)), `observation-only ran ${lines.find(line => pattern.test(line))}`);
    assert.ok(!fixture.transport.commands.some(command => command.cwd?.endsWith('/release-railway')), 'the product deployment adapter ran railway');
    assert.ok(!fixture.requests.some(request => request.url.includes('api.github.com')), 'observation-only called the GitHub API');
    // The deployed roster holds no worker principal.
    const roster = fixture.transport.commands.find(command => command.args.includes('GRAPHYARD_PRINCIPALS'))!.input!;
    assert.ok(!JSON.parse(roster).some((principal: { role: string }) => principal.role === 'worker' || principal.role === 'producer'));
    assert.ok(summary.nextSteps.some(step => /Observation-only: the control plane is deployed and nothing owner\/project or its product owns was changed/.test(step)));
    assert.ok(logs.length > 0);
  } finally { await fixture.cleanup(); }
});

test('unit:install-observe-only-redacted-resumable — the Railway observation reads no variable value, and a second --apply after an interrupted one creates nothing twice and reports the completed steps satisfied', async () => {
  const { fixture, logs, prepare } = await observeOnlyFixture(1);
  try {
    const first = await prepare('apply');
    const interrupted = await applyInstall(first, await buildPlan(first)).then(() => null, (error: Error) => error);
    assert.match(String(interrupted?.message), /deployment interrupted/, 'the first apply was not interrupted at the deploy');

    const replanned = await buildPlan(await prepare('plan'));
    const state = (id: string) => replanned.actions.find(action => action.id === id)!.state;
    for (const id of ['local.credentials', 'provider.provision.project', 'provider.provision.database', 'provider.provision.app', 'provider.env.core']) assert.equal(state(id), 'satisfied', `${id} is not reported satisfied after the interrupted apply`);
    assert.match(replanned.actions.find(action => action.id === 'provider.env.core')!.title, /variable names are unknown \(observation-only reads no values\)/);

    const second = await prepare('apply');
    const plan = await buildPlan(second);
    const summary = await applyInstall(second, plan);
    assert.equal(summary.health, true);

    const lines = fixture.allCommandLines();
    for (const created of ['railway init', 'railway add --database', 'railway add --service']) assert.equal(lines.filter(line => line.startsWith(created)).length, 1, `${created} ran more than once`);
    assert.ok(!lines.some(line => /git\/refs|--method (POST|PUT)/.test(line)), 'a ref or GitHub resource was created');
    // No command whose output carries variable values ran, and nothing seeded reached any output.
    assert.ok(!lines.some(line => /^railway variables(?!.*--set)/.test(line) || /^railway variable list/.test(line)), `a variable listing ran: ${lines.find(line => /^railway variables(?!.*--set)/.test(line))}`);
    const output = allText(fixture, [JSON.stringify(replanned), JSON.stringify(plan), JSON.stringify(summary), String(interrupted?.message), ...logs]);
    for (const value of Object.values(SEEDED)) {
      assert.ok(!output.includes(value), 'a seeded variable value reached the commands or the output');
      assert.ok(!output.includes(`sha:${fingerprint(value)}`) && !output.includes(fingerprint(value)), 'a seeded value fingerprint reached the output');
    }
  } finally { await fixture.cleanup(); }
});
