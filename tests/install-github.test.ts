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

test('the installer writes the App credentials to the server, points the webhook at it, and detects CI identities', async () => {
  const fixture = await harness({ provider: 'railway' });
  try {
    const session = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'railway' }, fixture.deps);
    const summary = await applyInstall(session, await buildPlan(session));

    const sent = new Map(fixture.transport.commands.filter(command => command.args.includes('--stdin')).map(command => [command.args.at(-1)!, command.input!]));
    assert.equal(sent.get('GITHUB_PRIVATE_KEY'), appKey);
    assert.equal(sent.get('GITHUB_WEBHOOK_SECRET'), WEBHOOK_SECRET);
    const plain = fixture.commandLines().find(line => line.includes('GITHUB_APP_ID='))!;
    assert.ok(plain.includes(`GITHUB_APP_ID=${GRAPHYARD_APP_ID}`));
    assert.ok(plain.includes('GITHUB_INSTALLATION_ID=500'));
    assert.ok(plain.includes(`GITHUB_CI_APP_IDS=${CI_APP_ID}`), 'CI App IDs were not detected from the base branch');

    const patch = fixture.requests.find(request => request.method === 'PATCH' && request.url.endsWith('/app/hook/config'))!;
    const body = JSON.parse(patch.body!);
    assert.equal(body.url, `${summary.url}/api/github/webhook`);
    assert.equal(body.secret, WEBHOOK_SECRET);
    assert.equal(body.content_type, 'json');
    assert.equal(body.insecure_ssl, '0');

    // Protection is applied through the human's gh credential, not the App.
    const put = fixture.transport.commands.find(command => command.args.includes('PUT') && command.args.some(argument => argument.includes('/protection')))!;
    assert.ok(put, 'branch protection was not applied');
    assert.equal(summary.protection.includes('admin enforcement'), true);
    assert.match(summary.protection, /1 approving review/);
  } finally { await fixture.cleanup(); }
});

test('applying protection to a stricter branch raises what Graphyard needs without lowering what the repository already requires', async () => {
  // The branch demands two approvals and is locked; the agent review policy demands none.
  const current = { ...satisfiedProtection(null, 2), lock_branch: { enabled: true } };
  const fixture = await harness({ provider: 'railway', protection: current });
  try {
    const session = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'railway', reviewPolicy: 'agent' }, fixture.deps);
    const plan = await buildPlan(session);
    const action = plan.actions.find(item => item.id === 'github.protection')!;
    assert.match(action.title, /2 approving review\(s\), the stricter count this branch already requires/);

    const summary = await applyInstall(session, plan);
    const put = fixture.transport.commands.find(command => command.args.includes('PUT') && command.args.some(argument => argument.includes('/protection')))!;
    const payload = JSON.parse(put.input!);
    assert.equal(payload.required_pull_request_reviews.required_approving_review_count, 2, 'the installer lowered an existing review requirement');
    assert.equal(payload.required_pull_request_reviews.require_last_push_approval, true);
    assert.equal(payload.lock_branch, true, 'the installer unlocked a locked branch');
    assert.equal(payload.enforce_admins, true);
    assert.equal(payload.required_conversation_resolution, false, 'the review gate is the verdict; threads block nothing');
    assert.match(summary.protection, /2 approving review/);
  } finally { await fixture.cleanup(); }
});

test('a reviewer App is registered as a separate identity and can never be the control-plane App', async () => {
  const fixture = await harness({ provider: 'compose' });
  try {
    const session = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'compose', reviewer: 'claude' }, fixture.deps);
    const plan = await buildPlan(session);
    const action = plan.actions.find(item => item.id === 'github.reviewer')!;
    assert.match(action.human!, /One additional browser confirmation/);
    const summary = await applyInstall(session, plan);
    assert.deepEqual(summary.reviewers, [{ name: 'claude', appId: GRAPHYARD_APP_ID + 1, botUserId: 900_001 }]);

    const manifest = reviewerAppManifest('claude', 'owner/project', 'https://graphyard.example.test', 'http://127.0.0.1:4311');
    const reviewerPermissions = manifest.default_permissions as Record<string, string>;
    assert.equal(reviewerPermissions.checks, undefined, 'a reviewer must not publish a check');
    assert.equal(reviewerPermissions.administration, undefined, 'a reviewer must not change protection');
    assert.equal(manifest.default_permissions.contents, 'read');
    assert.equal(appManifest('owner/project', 'https://graphyard.example.test', 'http://127.0.0.1:4311').default_permissions.checks, 'write');
  } finally { await fixture.cleanup(); }

  const collision = await harness({ provider: 'compose' });
  try {
    const session = await prepareInstall(collision.root, { repository: 'owner/project', provider: 'compose', reviewer: 'claude' }, {
      ...collision.deps,
      githubApp: async () => ({ appId: GRAPHYARD_APP_ID, slug: 'graphyard', installationId: 500, privateKey: appKey, webhookSecret: WEBHOOK_SECRET, botUserId: 900_001 }),
    });
    await assert.rejects(applyInstall(session, await buildPlan(session)), /reviewer App must be a different identity/);
  } finally { await collision.cleanup(); }
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

test('the saved App file holds the credentials and the plan never does', async () => {
  const fixture = await harness({ provider: 'compose' });
  try {
    const session = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'compose' }, fixture.deps);
    const plan = await buildPlan(session);
    const values = plan.actions.find(action => action.id === 'github.env')!.values!;
    assert.equal(values.find(value => value.name === 'GITHUB_PRIVATE_KEY')!.value, '[redacted]');
    assert.equal(values.find(value => value.name === 'GITHUB_WEBHOOK_SECRET')!.value, '[redacted]');
    assert.equal(values.find(value => value.name === 'GITHUB_APP_ID')!.value, '<from the App manifest flow>');
    await applyInstall(session, plan);
    const record = JSON.parse(await readFile(`${session.directory}/install.json`, 'utf8'));
    assert.equal(record.github.appId, GRAPHYARD_APP_ID);
    assert.match(record.github.webhookFingerprint, /^[0-9a-f]{12}$/);
    assert.ok(!JSON.stringify(record).includes(WEBHOOK_SECRET));
    assert.ok(!JSON.stringify(record).includes(appKey));
  } finally { await fixture.cleanup(); }
});

test('the App registration credentials are stored under the install directory, never inside the managed repository', async () => {
  const fixture = await harness({ provider: 'railway' });
  const announced: string[] = [];
  try {
    // The real manifest flow, wired exactly as the CLI wires it, so the file the credentials
    // reach is the one the installer chose — under the install directory, outside every
    // Git checkout, per the runbook's hard rule.
    const deps = {
      ...fixture.deps,
      githubApp: (request: { root: string; repository: string; origin: string; file: string; reviewer?: string }) => runManifestFlow(request.root, request.repository, request.origin, {
        port: 0, poll: 5, reviewer: request.reviewer,
        announce: message => announced.push(message),
        dependencies: {
          file: request.file,
          convert: async () => ({ id: request.reviewer ? GRAPHYARD_APP_ID + 1 : GRAPHYARD_APP_ID, slug: request.reviewer ? `${request.reviewer}-app` : 'graphyard-owner-project', pem: appKey, webhook_secret: WEBHOOK_SECRET }),
          verify: async () => {},
          resolveBot: async () => ({ id: 900_001, type: 'Bot' }),
        },
      }),
    };
    const session = await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'railway', reviewer: 'claude' }, deps);
    const applied = applyInstall(session, await buildPlan(session));
    await driveSetup(announced, 0, 500);
    await driveSetup(announced, 1, 501);
    await applied;

    assert.equal((await stat(`${session.directory}/github-app.json`)).mode & 0o777, 0o600);
    assert.equal((await stat(`${session.directory}/github-reviewer-claude.json`)).mode & 0o777, 0o600);
    await assert.rejects(stat(`${fixture.root}/.graphyard/github-app.json`), { code: 'ENOENT' }, 'the App private key was written inside the managed repository');
    await assert.rejects(stat(`${fixture.root}/.graphyard/github-reviewer-claude.json`), { code: 'ENOENT' }, 'the reviewer App key was written inside the managed repository');
    assert.ok(!announced.join('\n').includes(appKey) && !announced.join('\n').includes(WEBHOOK_SECRET));
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
