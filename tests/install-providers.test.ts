import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { buildPlan, coreEnv, materializeInstall, prepareInstall, applyInstall } from '../src/install/index.js';
import { chooseRailwayWorkspace, variableMarker } from '../src/install/adapters.js';
import type { Provider } from '../src/install/types.js';
import { harness, satisfiedProtection, RAILWAY_WORKSPACES, type Harness } from './install-harness.js';

const supported: Provider[] = ['railway', 'hetzner', 'docker-host', 'compose'];
const inputsFor = (provider: Provider) => ({ repository: 'owner/project', provider, ...(provider === 'railway' || provider === 'compose' ? {} : { sshHost: '203.0.113.10', sshUser: 'root', domain: 'graphyard.example.test' }), ...(provider === 'hetzner' ? { sshKey: 'graphyard-key', maxMonthly: 50 } : {}) });

function renderEnv(provider: Provider, values: { name: string; value: string }[]) {
  return provider === 'railway'
    ? JSON.stringify(Object.fromEntries(values.map(value => [value.name, value.value])))
    : `${values.map(value => `${value.name}=${value.value}`).join('\n')}\n`;
}

test('every supported provider produces a complete ordered plan that applies nothing', async () => {
  for (const provider of supported) {
    const fixture = await harness({ provider });
    try {
      const session = await prepareInstall(fixture.root, inputsFor(provider), fixture.deps, 'plan');
      const plan = await buildPlan(session);
      assert.equal(plan.provider, provider);
      assert.equal(session.materialized, false, `${provider} plan generated credentials`);
      assert.ok(plan.preflight.length >= 2, `${provider} must report preflight`);
      assert.ok(plan.preflight.every(item => item.ok || item.fix), `${provider} preflight must say how to fix a gap`);

      const ids = plan.actions.map(action => action.id);
      for (const required of ['local.credentials', 'provider.env.core', 'provider.deploy', 'provider.url', 'verify.health', 'github.app', 'github.env', 'github.webhook', 'github.ci-app-ids', 'github.protection', 'verify.status', 'verify.webhook', 'local.profiles', 'local.herdr']) {
        assert.ok(ids.includes(required), `${provider} plan is missing ${required}`);
      }
      assert.ok(ids.some(id => id.startsWith('provider.provision.')), `${provider} plan must provision compute`);
      // Postgres is provisioned on every provider, not only the managed one.
      assert.ok(plan.actions.some(action => /Postgres/i.test(action.title)), `${provider} plan must provision Postgres`);
      assert.ok(plan.actions.every(action => (action.values ?? []).every(value => !value.secret || value.value === '[redacted]')));

      const serialized = JSON.stringify(plan);
      assert.ok(!/[A-Za-z0-9_-]{43}/.test(serialized), `${provider} plan contains something shaped like a credential`);
      await assert.rejects(stat(session.directory), { code: 'ENOENT' }, `${provider} plan created the installation directory`);

      const lines = fixture.allCommandLines();
      for (const mutation of ['up -d', '--method PUT', 'railway up', 'hcloud server create', 'docker build']) {
        assert.ok(!lines.some(line => line.includes(mutation)), `${provider} plan must not run ${mutation}`);
      }
    } finally { await fixture.cleanup(); }
  }
});

test('re-planning an existing installation reports it as satisfied instead of proposing duplicates', async () => {
  for (const provider of supported) {
    const first = await harness({ provider });
    let second: Harness | undefined;
    try {
      const session = await materializeInstall(await prepareInstall(first.root, inputsFor(provider), first.deps));
      const envFile = renderEnv(provider, coreEnv(session));
      second = await harness({ provider, installed: true, envFile, protection: satisfiedProtection(null), root: first.root, configHome: first.configHome });
      const plan = await buildPlan(await prepareInstall(second.root, inputsFor(provider), second.deps, 'plan'));

      const provisioning = plan.actions.filter(action => action.id.startsWith('provider.provision.'));
      assert.ok(provisioning.length > 0);
      for (const action of provisioning) assert.equal(action.state, 'satisfied', `${provider} would re-provision ${action.id}`);
      const core = plan.actions.find(action => action.id === 'provider.env.core')!;
      assert.equal(core.state, 'satisfied', `${provider} reported phantom variable drift: ${JSON.stringify(core.drift)}`);
      assert.deepEqual(core.drift, []);
    } finally { await first.cleanup(); if (second) await second.cleanup(); }
  }
});

test('a changed value is reported as drift with a redacted comparison, never as a duplicate action', async () => {
  const first = await harness({ provider: 'compose' });
  let second: Harness | undefined;
  try {
    const session = await materializeInstall(await prepareInstall(first.root, inputsFor('compose'), first.deps));
    const core = coreEnv(session);
    const drifted = core.map(value => value.name === 'GITHUB_BASE_BRANCH' ? { ...value, value: 'trunk' }
      : value.name === 'GRAPHYARD_PRINCIPALS' ? { ...value, value: '[{"id":"stale","role":"admin","token":"stale-token-value-0123456789abcd"}]' }
      : value).filter(value => value.name !== 'GRAPHYARD_REVIEWER_APPS');

    second = await harness({ provider: 'compose', installed: true, envFile: renderEnv('compose', drifted), root: first.root, configHome: first.configHome });
    const plan = await buildPlan(await prepareInstall(second.root, inputsFor('compose'), second.deps, 'plan'));
    const action = plan.actions.find(item => item.id === 'provider.env.core')!;
    assert.equal(action.state, 'update');
    assert.equal(plan.existing, true);

    const branch = action.drift!.find(entry => entry.field === 'GITHUB_BASE_BRANCH')!;
    assert.deepEqual(branch, { action: 'provider.env.core', field: 'GITHUB_BASE_BRANCH', expected: 'main', observed: 'trunk' });
    const principals = action.drift!.find(entry => entry.field === 'GRAPHYARD_PRINCIPALS')!;
    assert.match(principals.expected, /^sha:[0-9a-f]{12}$/);
    assert.match(principals.observed, /^sha:[0-9a-f]{12}$/);
    assert.notEqual(principals.expected, principals.observed);
    assert.equal(action.drift!.find(entry => entry.field === 'GRAPHYARD_REVIEWER_APPS')!.observed, 'absent');

    const serialized = JSON.stringify(plan);
    for (const token of session.tokens.values()) assert.ok(!serialized.includes(token));
    assert.ok(plan.actions.filter(item => item.id === 'provider.env.core').length === 1, 'drift must not duplicate the action');
  } finally { await first.cleanup(); if (second) await second.cleanup(); }
});

test('changing the provider or domain of an existing installation is reported as drift', async () => {
  const first = await harness({ provider: 'compose' });
  let second: Harness | undefined;
  try {
    const session = await materializeInstall(await prepareInstall(first.root, inputsFor('compose'), first.deps));
    const { writeInstallRecord, Vault, installRecordSchema } = await import('../src/install/secrets.js');
    const now = new Date().toISOString();
    await writeInstallRecord(session.directory, installRecordSchema.parse({ version: 1, installId: session.installId, repository: 'owner/project', provider: 'compose', baseBranch: 'main', reviewPolicy: 'github', domain: 'old.example.test', url: 'http://127.0.0.1:4310', principals: [], github: null, reviewers: [], profiles: [], createdAt: now, updatedAt: now }), new Vault());

    second = await harness({ provider: 'railway', root: first.root, configHome: first.configHome });
    const plan = await buildPlan(await prepareInstall(second.root, { repository: 'owner/project', provider: 'railway', domain: 'new.example.test' }, second.deps, 'plan'));
    assert.equal(plan.existing, true);
    assert.deepEqual(plan.drift.find(entry => entry.field === 'provider'), { action: 'local.credentials', field: 'provider', expected: 'railway', observed: 'compose' });
    assert.deepEqual(plan.drift.find(entry => entry.field === 'domain'), { action: 'provider.url', field: 'domain', expected: 'new.example.test', observed: 'old.example.test' });
  } finally { await first.cleanup(); if (second) await second.cleanup(); }
});

test('an observed value is compared by fingerprint only when it is a credential', () => {
  // Classification follows the value, not the name: the same DATABASE_URL is a harmless
  // provider reference in one installation and a password-bearing connection string in another.
  assert.equal(variableMarker('DATABASE_URL', '${{Postgres.DATABASE_URL}}'), '${{Postgres.DATABASE_URL}}');
  assert.match(variableMarker('DATABASE_URL', 'postgres://graphyard:secret@db:5432/graphyard'), /^sha:[0-9a-f]{12}$/);
  assert.match(variableMarker('DATABASE_URL', 'postgres://postgres:managed@monorail.proxy.rlwy.net:41234/railway'), /^sha:[0-9a-f]{12}$/);
  assert.match(variableMarker('GITHUB_PRIVATE_KEY', 'pem'), /^sha:[0-9a-f]{12}$/);
  assert.equal(variableMarker('HOST', '0.0.0.0'), '0.0.0.0');
});

/**
 * Railway is given the shared reference `${{Postgres.DATABASE_URL}}` but reports the value it
 * resolves to. That resolved value is a password, so it can never be read to compare it: the
 * installer compares the reference by presence and treats a fingerprinted observed value as
 * satisfied. A re-plan of a real Railway installation therefore reports no phantom drift, and
 * the password still never reaches the plan.
 *
 * Comparing against the raw template instead would be better, but no Railway CLI surface
 * returns it: `variables --json` and `--kv` both resolve the reference (checked against a
 * live project, where the help text's "raw values" still means the resolved string). The
 * accepted residual is that a literal connection string set in the reference's place is
 * indistinguishable from a resolved one; DATABASE_URL is the only variable the installer
 * ever sets as a reference.
 */
test('a database password a provider resolves for itself is compared by presence and never reaches the plan', async () => {
  const first = await harness({ provider: 'railway' });
  let second: Harness | undefined;
  try {
    const session = await materializeInstall(await prepareInstall(first.root, inputsFor('railway'), first.deps));
    const resolved = 'postgres://postgres:railway-managed-password-9xz@monorail.proxy.rlwy.net:41234/railway';
    const envFile = renderEnv('railway', coreEnv(session).map(value => value.name === 'DATABASE_URL' ? { ...value, value: resolved } : value));
    second = await harness({ provider: 'railway', installed: true, envFile, protection: satisfiedProtection(null), root: first.root, configHome: first.configHome });
    const plan = await buildPlan(await prepareInstall(second.root, inputsFor('railway'), second.deps, 'plan'));

    assert.ok(!plan.drift.some(item => item.field === 'DATABASE_URL'), 'a resolved DATABASE_URL was reported as drift');
    const core = plan.actions.find(item => item.id === 'provider.env.core')!;
    assert.equal(core.state, 'satisfied', `re-plan reported drift: ${JSON.stringify(core.drift)}`);
    assert.ok(!JSON.stringify(plan).includes('railway-managed-password-9xz'), 'the resolved database password reached the plan');
  } finally { await first.cleanup(); await second?.cleanup(); }
});

test('docker-host without a public hostname refuses to apply instead of failing its own health check', async () => {
  const fixture = await harness({ provider: 'docker-host' });
  try {
    const inputs = { repository: 'owner/project', provider: 'docker-host' as Provider, sshHost: '203.0.113.10', sshUser: 'root' };
    const session = await prepareInstall(fixture.root, inputs, fixture.deps);
    const plan = await buildPlan(session);
    const item = plan.preflight.find(entry => entry.name === 'Public hostname')!;
    assert.equal(item.ok, false);
    assert.match(item.fix!, /--domain/);
    await assert.rejects(applyInstall(session, plan), /Preflight is incomplete[\s\S]*Public hostname/);
    assert.ok(!fixture.commandLines().some(line => line.includes('up -d')), 'a refused apply started the stack');
  } finally { await fixture.cleanup(); }
});

test('hetzner requires an SSH key so the created server is reachable, and plans the exact create command', async () => {
  const fixture = await harness({ provider: 'hetzner' });
  try {
    const inputs = { repository: 'owner/project', provider: 'hetzner' as Provider, sshHost: '203.0.113.10', sshUser: 'root', domain: 'graphyard.example.test' };
    const withoutKey = await buildPlan(await prepareInstall(fixture.root, inputs, fixture.deps, 'plan'));
    const item = withoutKey.preflight.find(entry => entry.name === 'SSH key')!;
    assert.equal(item.ok, false);
    assert.match(item.fix!, /--ssh-key/);
    assert.match(item.fix!, /hcloud ssh-key list/);

    const planned = await buildPlan(await prepareInstall(fixture.root, inputsFor('hetzner'), fixture.deps, 'plan'));
    const create = planned.actions.find(action => action.id === 'provider.provision.server')!;
    assert.equal(create.command, 'hcloud server create --name graphyard-owner-project --type cx22 --location nbg1 --image ubuntu-24.04 --ssh-key graphyard-key');
  } finally { await fixture.cleanup(); }
});

/**
 * Railway creates the project without a terminal here, and outside one its CLI refuses to pick
 * between workspaces. The live proof of AC-3 failed exactly there ("--workspace required in
 * non-interactive mode"), after the plan had said every preflight item was fine. The plan must
 * settle the workspace before it is approved: on its own for a single-workspace account, from
 * --workspace otherwise, and as a failed preflight item — with the choices — when it cannot.
 */
test('the Railway plan settles the workspace before apply, and reports an ambiguous account as a preflight gap', async () => {
  const workspaceItem = (plan: Awaited<ReturnType<typeof buildPlan>>) => plan.preflight.find(item => item.name === 'Railway workspace');
  const project = (plan: Awaited<ReturnType<typeof buildPlan>>) => plan.actions.find(action => action.id === 'provider.provision.project')!;

  const single = await harness({ provider: 'railway' });
  try {
    const plan = await buildPlan(await prepareInstall(single.root, inputsFor('railway'), single.deps, 'plan'));
    assert.deepEqual(workspaceItem(plan), { name: 'Railway workspace', ok: true, detail: 'Graphyard (ws-graphyard-0001), the only workspace of this account' });
    assert.equal(project(plan).command, 'railway init --name graphyard-owner-project --workspace ws-graphyard-0001');
    assert.deepEqual(project(plan).values, [{ name: 'workspace', value: 'Graphyard (ws-graphyard-0001)', secret: false }]);
  } finally { await single.cleanup(); }

  const several = await harness({ provider: 'railway', workspaces: RAILWAY_WORKSPACES });
  try {
    const ambiguous = await buildPlan(await prepareInstall(several.root, inputsFor('railway'), several.deps, 'plan'));
    const item = workspaceItem(ambiguous)!;
    assert.equal(item.ok, false);
    assert.match(item.detail, /belongs to 2 workspaces/);
    assert.match(item.detail, /Graphyard \(ws-graphyard-0001\), Installer's Projects \(ws-personal-0002\)/);
    assert.equal(item.fix, `Rerun with --workspace "Graphyard" | "Installer's Projects" (railway whoami --json lists them)`);
    assert.ok(!several.commandLines().some(line => line.includes('railway init')), 'an ambiguous plan must not touch the provider');

    // By name, case-insensitively, or by ID; the command always carries the exact ID.
    for (const requested of ['Graphyard', 'graphyard', 'ws-graphyard-0001']) {
      const chosen = await buildPlan(await prepareInstall(several.root, { ...inputsFor('railway'), workspace: requested }, several.deps, 'plan'));
      assert.deepEqual(workspaceItem(chosen), { name: 'Railway workspace', ok: true, detail: 'Graphyard (ws-graphyard-0001)' }, requested);
      assert.equal(project(chosen).command, 'railway init --name graphyard-owner-project --workspace ws-graphyard-0001', requested);
      assert.ok(chosen.preflight.every(item => item.ok), requested);
    }

    const unknown = await buildPlan(await prepareInstall(several.root, { ...inputsFor('railway'), workspace: 'Nowhere' }, several.deps, 'plan'));
    assert.equal(workspaceItem(unknown)!.ok, false);
    assert.match(workspaceItem(unknown)!.detail, /no workspace is named "Nowhere"/);
  } finally { await several.cleanup(); }
});

test('a Railway CLI that does not enumerate workspaces still plans, passing --workspace through as given', () => {
  assert.deepEqual(chooseRailwayWorkspace(null, []), { selected: null, choices: [], problem: null });
  assert.deepEqual(chooseRailwayWorkspace('team-id', []), { selected: { id: 'team-id', name: 'team-id' }, choices: [], problem: null });
  assert.equal(chooseRailwayWorkspace(' Graphyard ', RAILWAY_WORKSPACES).selected?.id, 'ws-graphyard-0001');
});
