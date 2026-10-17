import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1878: GitHub creates an App under the account whose settings form it is served from, so an
// organization-owned repository must register both Apps through the organization's settings path;
// the user path would give it a user-owned private App the repository cannot install.

// Imported per test, so a base without these exports fails each case rather than the whole file.
const setup = () => import('../src/github-setup.js') as Promise<any>;

interface OpenPage { url: string; close: () => Promise<void>; html: () => Promise<string> }

/** Opens the local App setup page for REPOSITORY with the owner's account type injected. */
async function openPage(repository: string, ownerType: 'User' | 'Organization' | null, reviewer?: string): Promise<OpenPage> {
  const { startGithubSetup } = await setup();
  const root = await temporaryDirectory('org-owner-page');
  execFileSync('git', ['init', '-q', root]);
  const page = await startGithubSetup(root, repository, 'https://graphyard.example', 0, { ownerType: async () => ownerType }, reviewer);
  return {
    url: page.url,
    close: () => new Promise<void>(done => page.http.close(() => done())),
    html: async () => (await (await fetch(page.url)).text()),
  };
}

/** The one GitHub manifest form on the page, and the registration state its session carries. */
function manifestForm(shown: string) {
  const state = shown.match(/name="state" value="([a-f0-9]+)"/)![1];
  const action = shown.match(/action="(https:\/\/github\.com\/[^"]+)"/)![1];
  return { state, action };
}

test('unit:app-manifest-targets-organization-owner — an organization-owned repository posts both manifest forms to the organization\'s registration path, a user-owned one to the user\'s', async () => {
  for (const [reviewer, button] of [[false, 'Register Graphyard App'], [true, 'Register reviewer App']] as const) {
    const org = await openPage('acme/shop', 'Organization', reviewer ? 'claude' : undefined);
    try {
      const { state, action } = manifestForm(await org.html());
      assert.equal(action, `https://github.com/organizations/acme/settings/apps/new?state=${state}`, `${button}: the form posts to the organization's path`);
    } finally { await org.close(); }
    const user = await openPage('acme/shop', 'User', reviewer ? 'claude' : undefined);
    try {
      const { state, action } = manifestForm(await user.html());
      assert.equal(action, `https://github.com/settings/apps/new?state=${state}`, `${button}: a user-owned repository keeps the user's path`);
    } finally { await user.close(); }
  }
});

test('unit:app-manifest-org-route — the hand-made route names the organization\'s registration path for both Apps and keeps the user\'s path, its default, for a user-owned repository', async () => {
  const { appImportRoute } = await setup();
  for (const reviewer of [false, true] as const) {
    const role = reviewer ? 'reviewer' : 'control-plane';
    const org = appImportRoute('acme-2/shop', ' --agent', reviewer, 'Organization');
    assert.match(org, /github\.com\/organizations\/acme-2\/settings\/apps\/new/, `${role}: the route names the organization's path`);
    assert.doesNotMatch(org, /github\.com\/settings\/apps\/new/, `${role}: the route never names the user path for an organization's repository`);
    const user = appImportRoute('acme-2/shop', ' --agent', reviewer);
    assert.equal(user, appImportRoute('acme-2/shop', ' --agent', reviewer, 'User'), `${role}: omitting the owner type is the user's path`);
    assert.match(user, /github\.com\/settings\/apps\/new/, `${role}: a user-owned repository keeps the user's path`);
    assert.doesNotMatch(user, /github\.com\/organizations\//, `${role}: a user-owned repository names no organization path`);
    assert.match(user, /create the (App|reviewer App) at github\.com\/settings\/apps\/new whenever convenient/, `${role}: the user-owned wording tests/sudo-code-entry.test.ts pins stays`);
  }
});

test('unit:app-manifest-owner-type — the owner type is resolved once per page, and a failed or unknown reading keeps the user\'s path', async () => {
  const { githubOwnerType } = await setup();
  const serving = (body: any, ok = true) => (async () => ({ ok, json: async () => body })) as any;
  assert.equal(await githubOwnerType('acme', serving({ type: 'Organization' })), 'Organization');
  assert.equal(await githubOwnerType('acme', serving({ type: 'User' })), 'User');
  assert.equal(await githubOwnerType('acme', serving({ type: 'Bot' })), null, 'an unreadable account type resolves to nothing');
  assert.equal(await githubOwnerType('acme', serving({ type: 'Organization' }, false)), null, 'a refused reading resolves to nothing');
  assert.equal(await githubOwnerType('acme', (async () => { throw new Error('offline'); }) as any), null, 'an unreachable GitHub resolves to nothing');

  const { startGithubSetup } = await setup();
  const root = await temporaryDirectory('org-owner-page');
  execFileSync('git', ['init', '-q', root]);
  let readings = 0;
  const page = await startGithubSetup(root, 'acme/shop', 'https://graphyard.example', 0, { ownerType: async () => { readings++; return 'Organization'; } });
  try {
    await (await fetch(page.url)).text(); await (await fetch(page.url)).text();
    assert.equal(readings, 1, 'the owner type is resolved once per setup page, not per render');
  } finally { await new Promise<void>(done => page.http.close(() => done())); }
  const fallback = await openPage('acme/shop', null);
  try {
    const { state, action } = manifestForm(await fallback.html());
    assert.equal(action, `https://github.com/settings/apps/new?state=${state}`, 'an unknown owner type keeps the user\'s path');
  } finally { await fallback.close(); }
});
