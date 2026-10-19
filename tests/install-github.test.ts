import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { applyInstall, buildPlan, prepareInstall } from '../src/install/index.js';
import { appJwt, detectCiAppIds, githubCli, protectionSatisfied, webhookUrlFor, CHECK_NAME, VERIFICATION_CHECK } from '../src/install/github.js';
import { runManifestFlow } from '../src/install/manifest.js';
import { appManifest, reviewerAppManifest } from '../src/github-setup.js';
import { appKey, harness, satisfiedProtection, temporaryRepository, CI_APP_ID, GRAPHYARD_APP_ID, WEBHOOK_SECRET } from './install-harness.js';
import { rm } from 'node:fs/promises';

test('the manifest flow completes with one browser confirmation and returns credentials to this machine', async () => {
  const root = await temporaryRepository();
  const announced: string[] = [];
  try {
    const flow = runManifestFlow(root, 'owner/project', 'https://graphyard.example.test', {
      port: 0, poll: 5, announce: message => announced.push(message),
      dependencies: {
        convert: async () => ({ id: GRAPHYARD_APP_ID, slug: 'graphyard-owner-project', pem: appKey, webhook_secret: WEBHOOK_SECRET }),
        verify: async (_app: unknown, installation: number) => { if (installation !== 500) throw new Error('wrong installation'); },
      },
    });
    // Drive the browser half of the single human confirmation.
    const setupUrl = await waitForUrl(announced);
    const page = await (await fetch(setupUrl)).text();
    assert.match(page, /Register a private App/);
    const state = page.match(/state=([a-f0-9]+)/)![1];
    const manifest = JSON.parse(page.match(/name="manifest" value="([^"]+)"/)![1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
    assert.equal(manifest.hook_attributes.url, webhookUrlFor('https://graphyard.example.test'));
    // Both callbacks redirect back to the setup page. Do not follow the redirect: the flow
    // finishes the moment /installed persists the installation id and immediately closes the
    // setup server, so a followed redirect races that shutdown for a page this test never reads.
    const created = await fetch(`${setupUrl}/created?code=install-test&state=${state}`, { redirect: 'manual' });
    assert.equal(created.status, 303);
    const installed = await fetch(`${setupUrl}/installed?installation_id=500`, { redirect: 'manual' });
    assert.equal(installed.status, 303);

    const facts = await flow;
    assert.equal(facts.appId, GRAPHYARD_APP_ID);
    assert.equal(facts.installationId, 500);
    assert.equal(facts.webhookSecret, WEBHOOK_SECRET);
    assert.ok(facts.privateKey.includes('PRIVATE KEY'));
    // The announcement explains the single click and never prints a credential.
    assert.match(announced.join('\n'), /confirm the Graphyard App, then install it on owner\/project/);
    for (const message of announced) { assert.ok(!message.includes(appKey)); assert.ok(!message.includes(WEBHOOK_SECRET)); }
    assert.equal((await stat(`${root}/.graphyard/github-app.json`)).mode & 0o777, 0o600);
    // A signed App JWT can be produced from what the flow returned.
    assert.equal(appJwt(facts.appId, facts.privateKey).split('.').length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function waitForUrl(announced: string[]) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const found = announced.join('\n').match(/http:\/\/127\.0\.0\.1:\d+/);
    if (found) return found[0];
    await new Promise(accept => setTimeout(accept, 10));
  }
  throw new Error('the setup URL was never announced');
}

test('GY-2009: the installer writes no App credentials, points no webhook, and writes no branch protection', async () => {
  const fixture = await harness({ provider: 'railway' });
  try {
    const session = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'railway' }, fixture.deps);
    const summary = await applyInstall(session, await buildPlan(session));
    for (const name of ['GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_ID', 'GITHUB_INSTALLATION_ID', 'GITHUB_CI_APP_IDS']) {
      assert.ok(!fixture.transport.commands.some(command => command.args.some(arg => arg === name || arg.startsWith(`${name}=`))), `${name} was set`);
    }
    assert.ok(!fixture.requests.some(request => request.url.endsWith('/app/hook/config')), 'no App webhook is configured');
    assert.ok(!fixture.transport.commands.some(command => command.args.includes('PUT') && command.args.some(argument => argument.includes('/protection'))), 'no branch protection is written');
    assert.equal(summary.github, null);
    assert.match(summary.protection, /deploy key/i);
  } finally { await fixture.cleanup(); }
});

test('the reviewer manifests stay separate identities, and install --reviewer registers no reviewer App (GY-2009)', async () => {
  const fixture = await harness({ provider: 'compose' });
  try {
    const session = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'compose', reviewer: 'claude' }, { ...fixture.deps, githubApp: async () => { throw new Error('no App flow may run'); } });
    const plan = await buildPlan(session);
    assert.ok(!plan.actions.some(item => item.id === 'github.reviewer' || item.id === 'github.app'));
    const summary = await applyInstall(session, plan);
    assert.deepEqual(summary.reviewers, []);

    const manifest = reviewerAppManifest('claude', 'owner/project', 'https://graphyard.example.test', 'http://127.0.0.1:4311');
    const reviewerPermissions = manifest.default_permissions as Record<string, string>;
    assert.equal(reviewerPermissions.checks, undefined, 'a reviewer must not publish a check');
    assert.equal(reviewerPermissions.administration, undefined, 'a reviewer must not change protection');
    assert.equal(manifest.default_permissions.contents, 'read');
    assert.equal(appManifest('owner/project', 'https://graphyard.example.test', 'http://127.0.0.1:4311').default_permissions.checks, 'write');
  } finally { await fixture.cleanup(); }
});

test('CI detection ignores the control-plane App and the installer verification check', async () => {
  const fixture = await harness({ provider: 'compose' });
  try {
    const gh = githubCli({ description: 'fake', putFile: async () => {}, exec: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ check_runs: [
      { name: 'test', app: { id: CI_APP_ID, slug: 'github-actions' } },
      { name: 'test', app: { id: CI_APP_ID, slug: 'github-actions' } },
      { name: CHECK_NAME, app: { id: GRAPHYARD_APP_ID, slug: 'graphyard' } },
      { name: VERIFICATION_CHECK, app: { id: GRAPHYARD_APP_ID, slug: 'graphyard' } },
      { name: 'coverage', app: { id: 77, slug: 'codecov' } },
    ] }) }) });
    assert.deepEqual(await detectCiAppIds(gh, 'owner/project', 'main', GRAPHYARD_APP_ID), [{ appId: 77, slug: 'codecov' }, { appId: CI_APP_ID, slug: 'github-actions' }]);
    assert.equal(protectionSatisfied({ repository: 'owner/project', branch: 'main', requiredChecks: [], graphyardAppId: null, reviewCount: 1 }, null), false);
  } finally { await fixture.cleanup(); }
});

test('GY-2009: the plan carries no App values, and no App file is written in the install directory or the managed repository', async () => {
  const fixture = await harness({ provider: 'compose' });
  try {
    const session = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'compose' }, { ...fixture.deps, githubApp: async () => { throw new Error('no App flow may run'); } });
    const plan = await buildPlan(session);
    assert.ok(!plan.actions.some(action => action.id === 'github.env'));
    await applyInstall(session, plan);
    const record = JSON.parse(await readFile(`${session.directory}/install.json`, 'utf8'));
    assert.ok(!record.github, 'no App is recorded');
    assert.ok(!JSON.stringify(record).includes(WEBHOOK_SECRET));
    assert.ok(!JSON.stringify(record).includes(appKey));
    await assert.rejects(stat(`${session.directory}/github-app.json`), { code: 'ENOENT' });
    await assert.rejects(stat(`${fixture.root}/.graphyard/github-app.json`), { code: 'ENOENT' });
  } finally { await fixture.cleanup(); }
});

async function driveSetup(announced: string[], index: number, installationId: number) {
  for (let attempt = 0; attempt < 500 && announced.length <= index; attempt++) await new Promise(accept => setTimeout(accept, 10));
  const url = announced[index]?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(url, `setup URL ${index} was never announced`);
  const page = await (await fetch(url)).text();
  const state = page.match(/state=([a-f0-9]+)/)![1];
  assert.equal((await fetch(`${url}/created?code=install-test&state=${state}`, { redirect: 'manual' })).status, 303);
  assert.equal((await fetch(`${url}/installed?installation_id=${installationId}`, { redirect: 'manual' })).status, 303);
}
