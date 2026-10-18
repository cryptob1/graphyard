import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyInstall, buildPlan, prepareInstall, type InstallDependencies } from '../src/install/index.js';
import { deliveryPolicySchema } from '../src/model/delivery-policy.js';
import { harness, REPOSITORY } from './install-harness.js';

const SERVICE = 'graphyard-owner-project';
const REPO_ONLY = { match: 'gh auth status', result: "github.com\n  ✓ Logged in to github.com account installer\n  - Token scopes: 'gist', 'read:org', 'repo'" };
const SIGNED_OUT = { match: 'gh auth status', result: { stdout: '', stderr: 'You are not logged into any GitHub hosts.', code: 1 } };

// A release-candidate repository, so the observe-only install still calls `gh` for its release wiring.
const releaseCandidate = deliveryPolicySchema.parse({
  mode: 'release-candidate', candidateSchedule: '0 */6 * * *',
  mergeGate: { preMerge: [{ check: 'test', command: 'npm run test', source: 'script', reason: 'fast' }], perCandidate: [{ check: 'test:e2e', command: 'npm run test:e2e', source: 'script', reason: 'long' }] },
  deploy: { adapter: 'railway', project: null, uat: null, production: null },
});

/** A Railway account that remembers what the installer created. */
function railway(login: typeof REPO_ONLY | typeof SIGNED_OUT) {
  const state = { project: false, database: false, service: false };
  return [login,
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

async function observeOnly(login: typeof REPO_ONLY | typeof SIGNED_OUT, mode: 'release-candidate' | 'per-pr' = 'release-candidate') {
  const fixture = await harness({ provider: 'railway', extraResponses: railway(login),
    statusBody: { actor: { id: 'owner-project-operator', role: 'admin' }, repository: REPOSITORY, github: false, githubAppId: null, githubInstallationId: null } });
  await writeFile(join(fixture.root, 'graphyard.json'), JSON.stringify({ documentation: { paths: ['README.md'], changelog: null }, ...(mode === 'release-candidate' ? { delivery: releaseCandidate } : {}) }));
  const calls = { githubApp: 0, registerProfiles: 0, runHerdr: 0, provision: 0 };
  const deps: InstallDependencies = { ...fixture.deps, log: () => {},
    githubApp: async () => { calls.githubApp++; throw new Error('observation-only must not bind an App'); },
    registerProfiles: async () => { calls.registerProfiles++; throw new Error('observation-only must not register profiles'); },
    runHerdr: () => { calls.runHerdr++; return ''; } };
  const prepare = async (mode: 'plan' | 'apply') => {
    const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'railway', observeOnly: true }, deps, mode);
    const adapter = session.delivery.adapter;
    session.delivery.adapter = { ...adapter, provision: async (...args) => { calls.provision++; return adapter.provision(...args); } };
    return session;
  };
  return { fixture, calls, prepare };
}

const githubCli = (plan: { preflight: { name: string; ok: boolean; detail: string; fix?: string }[] }) => plan.preflight.find(item => item.name === 'GitHub CLI')!;

test('unit:observe-only-repo-scope-suffices — a repo-only gh login passes the GitHub CLI preflight of install --observe-only --provider railway, which plans and applies holding every App, webhook, protection, ref and product action; no gh login is still refused', async () => {
  const { fixture, calls, prepare } = await observeOnly(REPO_ONLY);
  try {
    const plan = await buildPlan(await prepare('plan'));
    const gh = githubCli(plan);
    assert.equal(gh.ok, true, gh.detail);
    assert.match(gh.detail, /scopes repo; no install registers a webhook, so none needs admin:repo_hook/);
    assert.ok(plan.preflight.every(item => item.ok), JSON.stringify(plan.preflight.filter(item => !item.ok)));
    const held = plan.actions.filter(action => action.state === 'held').map(action => action.id);
    for (const id of ['github.app', 'release.branches', 'release.railway.uat', 'release.railway.production']) assert.ok(held.includes(id), `${id} is not held`);
    // GY-2009: install never plans a branch-protection write, held or not.
    assert.ok(!plan.actions.some(action => action.id === 'github.protection'), 'github.protection is not planned');

    const session = await prepare('apply');
    const summary = await applyInstall(session, await buildPlan(session));
    assert.equal(summary.health, true);
    assert.equal(summary.github, null);
    assert.deepEqual(summary.release.created, []);
    assert.deepEqual(calls, { githubApp: 0, registerProfiles: 0, runHerdr: 0, provision: 0 });
    const lines = fixture.allCommandLines();
    for (const pattern of [/git\/refs/, /--method (POST|PUT|PATCH|DELETE)/, /\/protection/, /\/hooks/, /rulesets/, /^railway environment/])
      assert.ok(!lines.some(line => pattern.test(line)), `observation-only ran ${lines.find(line => pattern.test(line))}`);
    assert.ok(!fixture.transport.commands.some(command => command.cwd?.endsWith('/release-railway')), 'the product deployment adapter ran railway');
    assert.ok(!fixture.requests.some(request => request.url.includes('api.github.com')), 'observation-only called the GitHub API');
  } finally { await fixture.cleanup(); }

  const signedOut = await observeOnly(SIGNED_OUT);
  try {
    const session = await signedOut.prepare('apply');
    const plan = await buildPlan(session);
    const gh = githubCli(plan);
    assert.equal(gh.ok, false);
    assert.match(gh.detail, /gh is missing or not authenticated/);
    assert.match(gh.fix!, /gh auth login --scopes repo /);
    await assert.rejects(applyInstall(session, plan), /Preflight is incomplete; the installer changed nothing/);
  } finally { await signedOut.fixture.cleanup(); }
});

test('unit:observe-only-per-pr-refuses-signed-out — install --observe-only on a per-pr repository still runs gh auth status: a repo-only login passes, and no gh login fails the GitHub CLI preflight so apply refuses before any change', async () => {
  const signedIn = await observeOnly(REPO_ONLY, 'per-pr');
  try {
    const session = await signedIn.prepare('plan');
    assert.equal(session.delivery.policy.mode, 'per-pr');
    const gh = githubCli(await buildPlan(session));
    assert.equal(gh.ok, true, gh.detail);
    assert.match(gh.detail, /scopes repo; no install registers a webhook/);
  } finally { await signedIn.fixture.cleanup(); }

  const signedOut = await observeOnly(SIGNED_OUT, 'per-pr');
  try {
    const session = await signedOut.prepare('apply');
    assert.equal(session.delivery.policy.mode, 'per-pr');
    const plan = await buildPlan(session);
    const gh = githubCli(plan);
    assert.ok(gh, 'observe-only on per-pr ran no GitHub CLI preflight');
    assert.equal(gh.ok, false);
    assert.match(gh.detail, /gh is missing or not authenticated/);
    assert.match(gh.fix!, /gh auth login --scopes repo /);
    await assert.rejects(applyInstall(session, plan), /Preflight is incomplete; the installer changed nothing/);
    assert.deepEqual(signedOut.calls, { githubApp: 0, registerProfiles: 0, runHerdr: 0, provision: 0 });
    assert.ok(!signedOut.fixture.allCommandLines().some(line => /^railway (init|add|up)/.test(line)), 'a signed-out observe-only apply provisioned the control plane');
  } finally { await signedOut.fixture.cleanup(); }
});

test('unit:full-install-repo-scope-suffices — a full Railway install whose gh login holds only repo passes the GitHub CLI preflight: no install binds an App or registers a webhook (GY-2009)', async () => {
  for (const provider of ['railway', 'docker-host', 'hetzner'] as const) {
    const fixture = await harness({ provider, extraResponses: [REPO_ONLY] });
    try {
      const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider }, fixture.deps, 'plan');
      const gh = githubCli(await buildPlan(session));
      assert.equal(gh.ok, true, `${provider}: ${gh.detail}`);
      assert.match(gh.detail, /deploy-key registration with scopes repo; no install registers a webhook, so none needs admin:repo_hook/);
    } finally { await fixture.cleanup(); }
  }
});
