import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { buildPlan, coreEnv, prepareInstall } from '../src/install/index.js';
import { variableMarker } from '../src/install/adapters.js';
import type { Provider } from '../src/install/types.js';
import { harness, satisfiedProtection, type Harness } from './install-harness.js';

const supported: Provider[] = ['railway', 'hetzner', 'docker-host', 'compose'];
const inputsFor = (provider: Provider) => ({ repository: 'owner/project', provider, ...(provider === 'railway' || provider === 'compose' ? {} : { sshHost: '203.0.113.10', sshUser: 'root', domain: 'graphyard.example.test' }) });

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
      const session = await prepareInstall(first.root, inputsFor(provider), first.deps);
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
    const session = await prepareInstall(first.root, inputsFor('compose'), first.deps);
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
    const session = await prepareInstall(first.root, inputsFor('compose'), first.deps);
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
  assert.equal(variableMarker('railway', 'DATABASE_URL', '${{Postgres.DATABASE_URL}}'), '${{Postgres.DATABASE_URL}}');
  assert.match(variableMarker('compose', 'DATABASE_URL', 'postgres://graphyard:secret@db:5432/graphyard'), /^sha:[0-9a-f]{12}$/);
  assert.match(variableMarker('railway', 'GITHUB_PRIVATE_KEY', 'pem'), /^sha:[0-9a-f]{12}$/);
  assert.equal(variableMarker('railway', 'HOST', '0.0.0.0'), '0.0.0.0');
});
