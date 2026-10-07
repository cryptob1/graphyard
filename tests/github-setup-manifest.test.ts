import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appManifest, publiclyReachable } from '../src/github-setup.js';
import { applyInstall, buildPlan, prepareInstall, webhookPreflight } from '../src/install/index.js';
import { harness, REPOSITORY } from './install-harness.js';

const CALLBACK = 'http://127.0.0.1:4311';

test('unit:manifest-no-loopback-hook — GitHub refuses a hook URL it cannot reach even when inactive, so a loopback or private origin sends no hook_attributes and a public one an active hook', () => {
  for (const origin of ['http://127.0.0.1:4310', 'http://127.8.9.10:4310', 'http://localhost:4310', 'http://[::1]:4310']) {
    const manifest = appManifest('owner/scratch', origin, CALLBACK);
    assert.equal('hook_attributes' in manifest, false, `${origin} sent hook_attributes`);
    assert.doesNotMatch(JSON.stringify(manifest), /api\/github\/webhook/, `${origin} manifest names a hook URL`);
  }
  for (const origin of ['https://10.0.0.5', 'https://172.16.1.1', 'https://172.31.255.255', 'https://192.168.1.20', 'https://169.254.0.1', 'https://100.64.0.1', 'https://[fd00::1]', 'https://[fe80::1]', 'https://graphyard.localhost', 'https://box.local']) {
    assert.equal(publiclyReachable(origin), false, `${origin} counted as public`);
    assert.equal('hook_attributes' in appManifest('owner/scratch', origin, CALLBACK), false, `${origin} sent hook_attributes`);
  }
  const hosted = appManifest('owner/scratch', 'https://graphyard.example', CALLBACK);
  assert.deepEqual(hosted.hook_attributes, { url: 'https://graphyard.example/api/github/webhook', active: true });
  for (const origin of ['https://graphyard.example', 'https://203.0.113.10', 'https://172.32.0.1', 'https://[2001:db8::1]']) assert.equal(publiclyReachable(origin), true, `${origin} counted as private`);
});

test('unit:local-install-no-webhook — a compose install says in preflight that it polls GitHub and registers no webhook, and skips every webhook step instead of failing it', async () => {
  const line = webhookPreflight('compose');
  assert.ok(line?.ok);
  assert.match(line!.detail, /polls GitHub and registers no webhook/);
  for (const provider of ['railway', 'hetzner', 'docker-host'] as const) assert.equal(webhookPreflight(provider), null, provider);

  const fixture = await harness({ provider: 'compose' });
  try {
    const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'compose' }, fixture.deps);
    const plan = await buildPlan(session);
    const preflight = plan.preflight.find(item => item.name === 'GitHub webhook');
    assert.ok(preflight?.ok, 'the compose preflight has no webhook line');
    assert.match(preflight!.detail, /polls GitHub and registers no webhook/);
    for (const id of ['github.webhook', 'verify.webhook']) {
      const action = plan.actions.find(entry => entry.id === id)!;
      assert.equal(action.state, 'satisfied', `${id} is not skipped`);
      assert.match(action.title, /^Skipped:/);
    }
    const summary = await applyInstall(session, plan);
    assert.equal(summary.webhook.skipped, true);
    assert.match(summary.webhook.detail, /^skipped:/);
    assert.ok(!summary.nextSteps.some(step => /Webhook delivery is unconfirmed/.test(step)), 'the skipped delivery is reported as a failure');
    assert.ok(!fixture.requests.some(request => request.url.includes('/app/hook/') || request.url.includes('/check-runs')), 'a local install touched the App webhook or published a delivery check');
    assert.equal(fixture.state.hookConfig, null);
  } finally { await fixture.cleanup(); }
});
