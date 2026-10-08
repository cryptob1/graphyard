import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { harness, REPOSITORY } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Imported per test, so a base without these exports fails each case rather than the whole file.
const setup = () => import('../src/github-setup.js') as Promise<any>;
const install = () => import('../src/install/index.js') as Promise<any>;

const CALLBACK = 'http://127.0.0.1:4311';

test('unit:manifest-no-loopback-hook — GitHub refuses a hook URL it cannot reach even when inactive, so a loopback or private origin sends no hook_attributes and a public one an active hook', async () => {
  const { appManifest, publiclyReachable } = await setup();
  for (const origin of ['http://127.0.0.1:4310', 'http://127.8.9.10:4310', 'http://localhost:4310', 'http://[::1]:4310']) {
    const manifest = appManifest('owner/scratch', origin, CALLBACK);
    assert.equal('hook_attributes' in manifest, false, `${origin} sent hook_attributes`);
    assert.doesNotMatch(JSON.stringify(manifest), /api\/github\/webhook/, `${origin} manifest names a hook URL`);
  }
  for (const origin of ['https://10.0.0.5', 'https://172.16.1.1', 'https://172.31.255.255', 'https://192.168.1.20', 'https://169.254.0.1', 'https://100.64.0.1', 'https://[fd00::1]', 'https://[fe80::1]', 'https://graphyard.localhost', 'https://box.local', 'https://[::ffff:127.0.0.1]', 'https://[::ffff:10.0.0.1]', 'https://[::ffff:192.168.1.20]']) {
    assert.equal(publiclyReachable(origin), false, `${origin} counted as public`);
    assert.equal('hook_attributes' in appManifest('owner/scratch', origin, CALLBACK), false, `${origin} sent hook_attributes`);
  }
  const hosted = appManifest('owner/scratch', 'https://graphyard.example', CALLBACK);
  assert.deepEqual(hosted.hook_attributes, { url: 'https://graphyard.example/api/github/webhook', active: true });
  for (const origin of ['https://graphyard.example', 'https://203.0.113.10', 'https://172.32.0.1', 'https://[2001:db8::1]', 'https://[::ffff:203.0.113.10]']) assert.equal(publiclyReachable(origin), true, `${origin} counted as private`);
});

test('unit:local-install-no-webhook — a compose install says in preflight that it polls GitHub and registers no webhook, and skips every webhook step instead of failing it', async () => {
  const { applyInstall, buildPlan, prepareInstall, webhookPreflight } = await install();
  const line = webhookPreflight('compose');
  assert.ok(line?.ok);
  assert.match(line!.detail, /polls GitHub and registers no webhook/);
  for (const provider of ['railway', 'hetzner', 'docker-host'] as const) assert.equal(webhookPreflight(provider), null, provider);

  const fixture = await harness({ provider: 'compose' });
  try {
    const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'compose' }, fixture.deps);
    const plan = await buildPlan(session);
    const preflight = plan.preflight.find((item: any) => item.name === 'GitHub webhook');
    assert.ok(preflight?.ok, 'the compose preflight has no webhook line');
    assert.match(preflight!.detail, /polls GitHub and registers no webhook/);
    for (const id of ['github.webhook', 'verify.webhook']) {
      const action = plan.actions.find((entry: any) => entry.id === id)!;
      assert.equal(action.state, 'satisfied', `${id} is not skipped`);
      assert.match(action.title, /^Skipped:/);
    }
    const summary = await applyInstall(session, plan);
    assert.equal(summary.webhook.skipped, true);
    assert.match(summary.webhook.detail, /^skipped:/);
    assert.ok(!summary.nextSteps.some((step: string) => /Webhook delivery is unconfirmed/.test(step)), 'the skipped delivery is reported as a failure');
    assert.ok(!fixture.requests.some(request => request.url.includes('/app/hook/') || request.url.includes('/check-runs')), 'a local install touched the App webhook or published a delivery check');
    assert.equal(fixture.state.hookConfig, null);
  } finally { await fixture.cleanup(); }
});

test('unit:manifest-no-loopback-hook — a control-plane App is created although GitHub returns no webhook secret, and gets a local one rather than its credentials being discarded', async () => {
  const { startGithubSetup } = await setup();
  // GY-1476: a hosted origin too keeps the App GitHub already created; install writes the secret to its webhook.
  for (const [deployment, created] of [['http://127.0.0.1:4310', true], ['https://graphyard.example', true]] as const) {
    const root = await temporaryDirectory('manifest-setup'); execFileSync('git', ['init', '-q', root]);
    const page = await startGithubSetup(root, 'owner/scratch', deployment, 0, { convert: async () => ({ id: 123, slug: 'graphyard-scratch', pem: 'test-only-private-key', webhook_secret: null }) });
    try {
      const state = (await (await fetch(page.url)).text()).match(/state=([a-f0-9]+)/)![1];
      const response = await fetch(`${page.url}/created?code=example&state=${state}`, { redirect: 'manual' });
      if (created) {
        assert.equal(response.status, 303, `${deployment}: the webhook-less App was not persisted`);
        const saved = JSON.parse(await readFile(page.file, 'utf8'));
        assert.equal(saved.appId, 123);
        assert.match(saved.webhookSecret, /^[0-9a-f]{64}$/, 'GITHUB_WEBHOOK_SECRET would be empty');
      } else {
        assert.notEqual(response.status, 303, `${deployment}: an App with a webhook was saved without its secret`);
        await assert.rejects(readFile(page.file, 'utf8'));
      }
    } finally { await new Promise<void>(done => page.http.close(() => done())); await rm(root, { recursive: true, force: true }); }
  }
});
