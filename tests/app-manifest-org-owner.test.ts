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

/** Opens the local App setup page for REPOSITORY with no owner-type reader injected: the page's default reading runs. */
async function openDefaultPage(repository: string): Promise<OpenPage> {
  const { startGithubSetup } = await setup();
  const root = await temporaryDirectory('org-owner-page');
  execFileSync('git', ['init', '-q', root]);
  const page = await startGithubSetup(root, repository, 'https://graphyard.example', 0);
  return {
    url: page.url,
    close: () => new Promise<void>(done => page.http.close(() => done())),
    html: async () => (await (await fetch(page.url)).text()),
  };
}

/** Stands in for GitHub's API while a default owner-type reading runs; answers an account of TYPE. */
function serveOwnerType(type: string): typeof fetch {
  return (async (input: any) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? input);
    if (!url.startsWith('https://api.github.com/users/')) throw new Error(`unexpected fetch ${url}`);
    return { ok: true, json: async () => ({ type }) } as any;
  }) as typeof fetch;
}

test('unit:app-manifest-drive-route — the graphyard up --agent drive resolves the owner\'s account type before it hands off the App-import route, naming the owner\'s registration path', async () => {
  const { browserAppDriver } = await import('../src/up.js') as any;
  // The local App page first (the drive presses its register button), then a Confirm-access page
  // that never settles: the drive hands off once, and --no-wait ends it with the route.
  const page = () => {
    let view: 'local' | 'sudo' = 'local';
    return {
      open: () => {}, url: () => view === 'local' ? 'http://127.0.0.1:4311' : 'https://github.com/sessions/sudo',
      text: () => view === 'local' ? '' : 'Skip to content\nConfirm access\n\nSigned in as @operator\n\nPasskey\nWhen you are ready, authenticate using the button below.\nUse passkey\nHaving problems?\nUse GitHub Mobile\nUse your authenticator app\nSend a code via email',
      meta: () => null,
      locate: (kind: string, text: string) => view === 'local' && kind === 'button' && text === 'Register Graphyard App →' ? { selector: '#register', tag: 'button', checked: null, value: null, text, visible: true } : null,
      click: (selector: string) => { if (selector === '#register') view = 'sudo'; },
      setChecked: () => {}, select: () => {}, screenshot: () => {}, wait: () => {}, close: () => {},
    };
  };
  const route = async (ownerType?: () => Promise<'User' | 'Organization' | null>) => {
    const handed: string[] = [];
    const outcome = await browserAppDriver({ page: page(), repository: 'acme/shop', noWait: true, ...(ownerType ? { ownerType } : {}), sleep: async () => {} })('http://127.0.0.1:4311', (sentence: string) => handed.push(sentence));
    assert.equal(outcome.state, 'waiting', '--no-wait ends the drive at the confirmation hand-off');
    assert.equal(handed.length, 1, 'exactly one hand-off, ending with the route');
    return { handoff: handed[0]!, next: outcome.next as string };
  };
  const org = await route(async () => 'Organization');
  assert.match(org.handoff, /create the App at github\.com\/organizations\/acme\/settings\/apps\/new whenever convenient/, 'the hand-off names the organization\'s registration path');
  assert.match(org.next, /create the App at github\.com\/organizations\/acme\/settings\/apps\/new whenever convenient/, 'the --no-wait answer names the organization\'s registration path');
  const none = await route(async () => null);
  assert.match(none.handoff, /create the App at github\.com\/settings\/apps\/new whenever convenient/, 'an unknown reading keeps the user\'s path');
  assert.doesNotMatch(none.handoff, /github\.com\/organizations\//, 'an unknown reading names no organization path');

  // With nothing injected the drive consults githubOwnerType, as the setup page does.
  const realFetch = globalThis.fetch;
  globalThis.fetch = serveOwnerType('Organization');
  try {
    const drive = await route();
    assert.match(drive.handoff, /create the App at github\.com\/organizations\/acme\/settings\/apps\/new whenever convenient/, 'the drive\'s default reading registers an organization\'s repository through the organization\'s path');
  } finally { globalThis.fetch = realFetch; }
});

test('unit:app-manifest-default-reading — a page opened with no injected reader consults githubOwnerType, so a real organization-owned repository registers through the organization\'s path', async () => {
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? input);
    if (!url.startsWith('https://api.github.com/')) return realFetch(input, init);
    asked.push(url);
    return serveOwnerType('Organization')(input);
  }) as typeof fetch;
  try {
    const page = await openDefaultPage('acme/shop');
    try {
      const { state, action } = manifestForm(await page.html());
      assert.equal(action, `https://github.com/organizations/acme/settings/apps/new?state=${state}`, 'the default reading registers an organization\'s repository through the organization\'s path');
      assert.ok(asked.includes('https://api.github.com/users/acme'), 'the default reading asked GitHub\'s public API for the owner\'s account type');
    } finally { await page.close(); }
  } finally { globalThis.fetch = realFetch; }
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
