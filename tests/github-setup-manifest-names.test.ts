import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpDependencies, UpRequest } from '../src/up.js';
import { appKey, GRAPHYARD_APP_ID, harness, REPOSITORY, WEBHOOK_SECRET } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Imported per test, so a base without these exports fails each case rather than the whole file.
const setup = () => import('../src/github-setup.js') as Promise<any>;
const install = () => import('../src/install/index.js') as Promise<any>;
const installGithub = () => import('../src/install/github.js') as Promise<any>;
const manifest = () => import('../src/install/manifest.js') as Promise<any>;
const up = () => import('../src/up.js');

const CALLBACK = 'http://127.0.0.1:4311';
const PILOT = 'cryptob1/graphyard-game-pilot';
const closed = (page: { http: { close(done: () => void): void } }) => new Promise<void>(done => page.http.close(() => done()));
async function checkout(label: string) {
  const root = await temporaryDirectory(label); execFileSync('git', ['init', '-q', root]);
  return root;
}

test('unit:manifest-names-fit — both manifest builders fall back to a shorter App name for a long OWNER/REPO or reviewer name, so GitHub never sees one over 34 characters', async () => {
  const { appManifest, reviewerAppManifest, APP_NAME_LIMIT } = await setup();
  assert.equal(APP_NAME_LIMIT, 34);
  // A short repository keeps the full OWNER-REPO name.
  assert.equal(appManifest('owner/scratch', 'https://graphyard.example', CALLBACK).name, 'Graphyard owner-scratch');
  // The pilot's 'Graphyard cryptob1-graphyard-game-pilot' (39) falls back to the repository name alone.
  assert.equal(appManifest(PILOT, 'http://127.0.0.1:4310', CALLBACK).name, 'Graphyard graphyard-game-pilot');
  const long = `acme/${'a-really-long-repository-name-'.repeat(3)}x`;
  const clipped = appManifest(long, 'https://graphyard.example', CALLBACK).name;
  assert.ok(clipped.length <= 34 && clipped.startsWith('Graphyard a-really'), clipped);
  assert.doesNotMatch(clipped, /[-._]$/);

  // The reviewer App: the pilot's 'cryptob1-graphyard-game-pilot review claude' threw before.
  assert.equal(reviewerAppManifest('claude', 'owner/scratch', 'https://graphyard.example', CALLBACK).name, 'owner-scratch review claude');
  assert.equal(reviewerAppManifest('claude', PILOT, 'http://127.0.0.1:4310', CALLBACK).name, 'graphyard-game-pilot review claude');
  for (const reviewer of ['claude', 'codex-reviewer']) {
    const name = reviewerAppManifest(reviewer, long, 'https://graphyard.example', CALLBACK).name;
    assert.ok(name.length <= 34 && name.endsWith(` review ${reviewer}`) && /^a-really/.test(name), name);
  }
  // Only a reviewer name that leaves no room for any repository is refused.
  assert.throws(() => reviewerAppManifest('a-reviewer-name-of-thirty-chars', PILOT, 'https://graphyard.example', CALLBACK), /limited to 34 characters/);
});

test('unit:manifest-exchange-no-secret — the manifest exchange keeps a control-plane App GitHub returned without webhook_secret, generating the secret locally instead of discarding its one-time key', async () => {
  const { startGithubSetup } = await setup();
  for (const deployment of ['https://graphyard.example', 'http://127.0.0.1:4310']) {
    const root = await checkout('manifest-no-secret');
    const page = await startGithubSetup(root, 'owner/scratch', deployment, 0, { convert: async () => ({ id: 123, slug: 'graphyard-scratch', pem: 'test-only-private-key' }) });
    try {
      const state = (await (await fetch(page.url)).text()).match(/state=([a-f0-9]+)/)![1];
      const response = await fetch(`${page.url}/created?code=example&state=${state}`, { redirect: 'manual' });
      assert.equal(response.status, 303, `${deployment}: the App's credentials were discarded`);
      const saved = JSON.parse(await readFile(page.file, 'utf8'));
      assert.equal(saved.appId, 123);
      assert.equal(saved.privateKey, 'test-only-private-key');
      assert.match(saved.webhookSecret, /^[0-9a-f]{64}$/, 'GITHUB_WEBHOOK_SECRET would be empty');
    } finally { await closed(page); await rm(root, { recursive: true, force: true }); }
  }
});

test('unit:local-install-no-hook-config — a loopback reviewer manifest subscribes to no events, and a local install neither configures the App webhook nor publishes a delivery proof, reporting that the control plane polls GitHub', async () => {
  const { reviewerAppManifest } = await setup();
  for (const origin of ['http://127.0.0.1:4310', 'http://localhost:4310', 'http://[::1]:4310']) {
    const local = reviewerAppManifest('claude', 'owner/scratch', origin, CALLBACK);
    assert.deepEqual(local.default_events, [], `${origin}: GitHub refuses events on an App with no hook`);
    assert.equal('hook_attributes' in local, false);
  }
  assert.ok(reviewerAppManifest('claude', 'owner/scratch', 'https://graphyard.example', CALLBACK).default_events.length > 0, 'a hosted reviewer keeps its events');

  const { applyInstall, buildPlan, prepareInstall } = await install();
  const fixture = await harness({ provider: 'compose' });
  const logs: string[] = [];
  try {
    const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'compose' }, { ...fixture.deps, log: (line: string) => logs.push(line) });
    const summary = await applyInstall(session, await buildPlan(session));
    assert.ok(!fixture.requests.some(request => request.url.includes('/app/hook/')), 'install read or PATCHed /app/hook/config for a local install');
    assert.ok(!fixture.requests.some(request => request.url.includes('/check-runs')), 'install attempted a delivery proof for a local install');
    assert.equal(summary.webhook.skipped, true);
    assert.match(summary.webhook.detail, /polls GitHub/);
    assert.ok(logs.some(line => /polls GitHub/.test(line)), 'install does not report that the control plane polls GitHub');
  } finally { await fixture.cleanup(); }
});

test('unit:installed-app-detected — a saved App without installationId is completed from the App JWT lookup before any Install step or App page, and agent-mode up lets install reuse it without a browser', async () => {
  // The lookup: GET /repos/OWNER/NAME/installation, authenticated as the App itself.
  const { repositoryInstallation } = await installGithub();
  const seen: { url: string; authorization: string }[] = [];
  const lookup = (async (input: any, init: any = {}) => {
    seen.push({ url: String(input), authorization: String(init.headers?.Authorization ?? '') });
    return String(input).includes('/missing/') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ id: 4242 }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await repositoryInstallation({ appId: GRAPHYARD_APP_ID, privateKey: appKey }, 'owner/project', lookup), 4242);
  assert.equal(seen[0].url, 'https://api.github.com/repos/owner/project/installation');
  const jwt = seen[0].authorization.replace(/^Bearer /, '');
  assert.equal(JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).iss, String(GRAPHYARD_APP_ID), 'not signed as the App');
  assert.equal(await repositoryInstallation({ appId: GRAPHYARD_APP_ID, privateKey: appKey }, 'owner/missing', lookup), null);

  // The setup page: an installation the operator made elsewhere (a phone) is recorded before the page shows any Install step.
  const { startGithubSetup } = await setup();
  const registered = { appId: 123, slug: 'graphyard-scratch', privateKey: 'test-only-private-key', webhookSecret: 'w'.repeat(64), repository: 'owner/scratch' };
  const root = await checkout('installed-app');
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard/github-app.json'), JSON.stringify(registered));
  const recorded: number[] = [];
  const page = await startGithubSetup(root, 'owner/scratch', 'http://127.0.0.1:4310', 0, { findInstallation: async () => 77, verify: async () => {}, record: async (app: any) => { recorded.push(app.installationId); } });
  try {
    assert.equal(page.installed, true);
    assert.equal(JSON.parse(await readFile(page.file, 'utf8')).installationId, 77);
    assert.deepEqual(recorded, [77]);
    const body = await (await fetch(page.url)).text();
    assert.match(body, /installation verified/);
    assert.doesNotMatch(body, /installations\/new/, 'the page still asks for an Install');
  } finally { await closed(page); }

  // Installed while the page waits: the page and the flow's poll both find it.
  await writeFile(join(root, '.graphyard/github-app.json'), JSON.stringify(registered));
  let installation: number | null = null;
  const waiting = await startGithubSetup(root, 'owner/scratch', 'http://127.0.0.1:4310', 0, { findInstallation: async () => installation, verify: async () => {} });
  try {
    assert.equal(waiting.installed, false);
    assert.match(await (await fetch(waiting.url)).text(), /installations\/new/);
    installation = 78;
    const body = await (await fetch(waiting.url)).text();
    assert.match(body, /installation verified/);
    assert.equal(JSON.parse(await readFile(waiting.file, 'utf8')).installationId, 78);
  } finally { await closed(waiting); }

  // The manifest flow never announces an App page for an App setup found installed.
  const { runManifestFlow } = await manifest();
  await writeFile(join(root, '.graphyard/github-app.json'), JSON.stringify(registered));
  const announced: string[] = [];
  const facts = await runManifestFlow(root, 'owner/scratch', 'http://127.0.0.1:4310', { port: 0, announce: (line: string) => announced.push(line), dependencies: { findInstallation: async () => 79, verify: async () => {} } });
  assert.equal(facts.installationId, 79);
  assert.deepEqual(announced, [], 'an App page was announced for an installed App');
  // And one installed while it waits is looked up by the flow's own poll, with nobody loading the page.
  await writeFile(join(root, '.graphyard/github-app.json'), JSON.stringify(registered));
  let later: number | null = null;
  const polled = await runManifestFlow(root, 'owner/scratch', 'http://127.0.0.1:4310', { port: 0, announce: () => {}, detectEveryMs: 0, wait: async () => { later = 80; }, dependencies: { findInstallation: async () => later, verify: async () => {} } });
  assert.equal(polled.installationId, 80);
  await rm(root, { recursive: true, force: true });

  // Install: the saved registration is completed through the lookup and reused; no App page opens.
  const { applyInstall, buildPlan, prepareInstall } = await install();
  const fixture = await harness({ provider: 'compose' });
  try {
    await mkdir(join(fixture.root, '.graphyard'), { recursive: true });
    await writeFile(join(fixture.root, '.graphyard/github-app.json'), JSON.stringify({ appId: GRAPHYARD_APP_ID, slug: 'graphyard-owner-project', privateKey: appKey, webhookSecret: WEBHOOK_SECRET, repository: REPOSITORY }));
    const base = fixture.deps.fetch!;
    const fetcher = (async (input: any, init: any) => String(input) === `https://api.github.com/repos/${REPOSITORY}/installation` ? new Response(JSON.stringify({ id: 500 }), { status: 200 }) : base(input, init)) as typeof fetch;
    let pages = 0;
    const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'compose' }, { ...fixture.deps, fetch: fetcher, githubApp: async () => { pages++; throw new Error('an App page was opened'); } });
    const plan = await buildPlan(session);
    assert.ok(!plan.browserApps.includes('control-plane'), 'the plan still creates the control-plane App in a browser');
    await applyInstall(session, plan);
    assert.equal(pages, 0);
    assert.equal(JSON.parse(await readFile(join(session.directory, 'github-app.json'), 'utf8')).installationId, 500, 'the detected installation is not recorded');
  } finally { await fixture.cleanup(); }

  // Agent-mode up: with no browser profile, a plan whose saved App leaves nothing for a browser goes on to install.
  const { runUp } = await up();
  const request: UpRequest = { repository: 'acme/shop', provider: 'compose', agent: true, reviewer: 'claude', master: 'claude', goalFile: null, browserProfile: null };
  const runWith = async (browserApps: string[]) => {
    const calls: string[][] = [];
    const deps: UpDependencies = {
      root: await temporaryDirectory('up-saved-app'), emit: () => {}, now: () => 0, sleep: async () => {}, pollMs: 1, humanWaitMs: 1, machineWaitMs: 1,
      status: async () => null, serverUrl: async () => null, masterToken: async () => null, publishOnboarding: async () => null, onboardingMerged: async () => true,
      async cli(args) {
        calls.push(args);
        if (args.includes('--plan')) return { code: 0, stdout: JSON.stringify({ preflight: [], browserApps }) };
        return { code: 1, stdout: '' };
      },
    };
    return { result: await runUp(request, deps), applied: calls.some(args => args[0] === 'install' && args.includes('--apply')) };
  };
  const reused = await runWith([]);
  assert.equal(reused.applied, true, 'up stopped before install could reuse the saved App');
  assert.doesNotMatch(reused.result.next, /--browser-profile/);
  const uncovered = await runWith(['control-plane']);
  assert.equal(uncovered.result.exitCode, 2);
  assert.equal(uncovered.applied, false);
  assert.match(uncovered.result.next, /No App saved on this machine covers the control-plane App/);
});
