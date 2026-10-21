import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { buildPlan, coreEnv, materializeInstall, prepareInstall } from '../src/install/index.js';
import { variableMarker } from '../src/install/adapters.js';
import { harness, type Harness } from './install-harness.js';

const inputsFor = () => ({ repository: 'owner/project', provider: 'compose' as const });
const renderEnv = (values: { name: string; value: string }[]) => `${values.map(value => `${value.name}=${value.value}`).join('\n')}\n`;

test('the compose provider produces a complete ordered plan that applies nothing', async () => {
  const fixture = await harness({ provider: 'compose' });
  try {
    const session = await prepareInstall(fixture.root, inputsFor(), fixture.deps, 'plan');
    const plan = await buildPlan(session);
    assert.equal(plan.provider, 'compose');
    assert.equal(session.materialized, false, 'the plan generated credentials');
    assert.ok(plan.preflight.length >= 2, 'the plan must report preflight');
    assert.ok(plan.preflight.every(item => item.ok || item.fix), 'preflight must say how to fix a gap');

    const ids = plan.actions.map(action => action.id);
    for (const required of ['local.credentials', 'provider.env.core', 'provider.deploy', 'provider.url', 'verify.health', 'github.deploy-key', 'verify.status', 'local.profiles', 'local.herdr']) {
      assert.ok(ids.includes(required), `the plan is missing ${required}`);
    }
    // GY-2009: no App, App variables, webhook, CI App ids or branch protection.
    for (const absent of ['github.app', 'github.env', 'github.webhook', 'github.ci-app-ids', 'github.protection']) assert.ok(!ids.includes(absent), `the plan must not plan ${absent}`);
    assert.ok(ids.some(id => id.startsWith('provider.provision.')), 'the plan must provision compute');
    assert.ok(plan.actions.some(action => /Postgres/i.test(action.title)), 'the plan must provision Postgres');
    assert.ok(plan.actions.every(action => (action.values ?? []).every(value => !value.secret || value.value === '[redacted]')));

    const serialized = JSON.stringify(plan);
    assert.ok(!/[A-Za-z0-9_-]{43}/.test(serialized), 'the plan contains something shaped like a credential');
    await assert.rejects(stat(session.directory), { code: 'ENOENT' }, 'the plan created the installation directory');

    const lines = fixture.allCommandLines();
    for (const mutation of ['up -d', '--method PUT', 'docker build']) {
      assert.ok(!lines.some(line => line.includes(mutation)), `the plan must not run ${mutation}`);
    }
  } finally { await fixture.cleanup(); }
});

test('re-planning an existing installation reports it as satisfied instead of proposing duplicates', async () => {
  const first = await harness({ provider: 'compose' });
  let second: Harness | undefined;
  try {
    const session = await materializeInstall(await prepareInstall(first.root, inputsFor(), first.deps));
    const envFile = renderEnv(coreEnv(session));
    second = await harness({ provider: 'compose', installed: true, envFile, root: first.root, configHome: first.configHome });
    const plan = await buildPlan(await prepareInstall(second.root, inputsFor(), second.deps, 'plan'));

    const provisioning = plan.actions.filter(action => action.id.startsWith('provider.provision.'));
    assert.ok(provisioning.length > 0);
    for (const action of provisioning) assert.equal(action.state, 'satisfied', `the plan would re-provision ${action.id}`);
    const core = plan.actions.find(action => action.id === 'provider.env.core')!;
    assert.equal(core.state, 'satisfied', `the plan reported phantom variable drift: ${JSON.stringify(core.drift)}`);
    assert.deepEqual(core.drift, []);
  } finally { await first.cleanup(); if (second) await second.cleanup(); }
});

test('a changed value is reported as drift with a redacted comparison, never as a duplicate action', async () => {
  const first = await harness({ provider: 'compose' });
  let second: Harness | undefined;
  try {
    const session = await materializeInstall(await prepareInstall(first.root, inputsFor(), first.deps));
    const core = coreEnv(session);
    const drifted = core.map(value => value.name === 'GITHUB_BASE_BRANCH' ? { ...value, value: 'trunk' }
      : value.name === 'GRAPHYARD_PRINCIPALS' ? { ...value, value: '[{"id":"stale","role":"admin","token":"stale-token-value-0123456789abcd"}]' }
      : value).filter(value => value.name !== 'GRAPHYARD_REVIEWER_APPS');

    second = await harness({ provider: 'compose', installed: true, envFile: renderEnv(drifted), root: first.root, configHome: first.configHome });
    const plan = await buildPlan(await prepareInstall(second.root, inputsFor(), second.deps, 'plan'));
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

test('changing the domain of an existing installation is reported as drift', async () => {
  const first = await harness({ provider: 'compose' });
  let second: Harness | undefined;
  try {
    const session = await materializeInstall(await prepareInstall(first.root, inputsFor(), first.deps));
    const { writeInstallRecord, Vault, installRecordSchema } = await import('../src/install/secrets.js');
    const now = new Date().toISOString();
    await writeInstallRecord(session.directory, installRecordSchema.parse({ version: 1, installId: session.installId, repository: 'owner/project', provider: 'compose', baseBranch: 'main', reviewPolicy: 'github', domain: 'old.example.test', url: 'http://127.0.0.1:4310', principals: [], github: null, reviewers: [], profiles: [], createdAt: now, updatedAt: now }), new Vault());

    second = await harness({ provider: 'compose', root: first.root, configHome: first.configHome });
    const plan = await buildPlan(await prepareInstall(second.root, { ...inputsFor(), domain: 'new.example.test' }, second.deps, 'plan'));
    assert.equal(plan.existing, true);
    assert.deepEqual(plan.drift.find(entry => entry.field === 'domain'), { action: 'provider.url', field: 'domain', expected: 'new.example.test', observed: 'old.example.test' });
  } finally { await first.cleanup(); if (second) await second.cleanup(); }
});

test('an observed value is compared by fingerprint only when it is a credential', () => {
  assert.match(variableMarker('DATABASE_URL', 'postgres://graphyard:secret@db:5432/graphyard'), /^sha:[0-9a-f]{12}$/);
  assert.match(variableMarker('GITHUB_PRIVATE_KEY', 'pem'), /^sha:[0-9a-f]{12}$/);
  assert.equal(variableMarker('HOST', '0.0.0.0'), '0.0.0.0');
});
