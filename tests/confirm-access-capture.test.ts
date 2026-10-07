import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import type { BrowserPage, Located } from '../src/master-browser.js';
import type { InstallationState } from '../src/github.js';
import type { MasterSession } from '../src/cli/master/session.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1482: a master browser flow that meets GitHub's Confirm access saves the redacted HTML of its
 * forms after the page loads and after each method is selected, as confirm-access-<method>.html in
 * the flow's master-actions record, so sudo fixtures come from real runs instead of a human recording.
 *
 * unit:confirm-access-capture — a recorded Confirm-access page (passkey, authenticator, email and
 * GitHub Mobile, whose prompt shows a pairing code before it is approved) driven through the
 * installation-accept flow: confirm-access-landing, -passkey, -authenticator, -email and -mobile
 * exist in the record's confirm-access folder, are named in record.json, keep the form structure, and hold no value attribute contents, tokens or codes.
 *
 * unit:confirm-access-fixture-list — `graphyard master browser fixtures` lists every captured file
 * with its flow and time, newest first, and names the latest capture of each method.
 */

// Loaded per test, so on a base without this change each case fails on its own assertion.
const browser = () => import('../src/master-browser.js');
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const UPDATE = 'https://github.com/settings/installations/91011/permissions/update';
// Fake session-bound values, generated at runtime so no key-like literal is committed (gitleaks).
const fake = (label: string) => `${label}-${randomUUID()}`;
const TOKEN = fake('AUTHTOKEN'), SECRET = fake('TSSECRET'), PREFILLED = fake('PREFILLED'), CHALLENGE = fake('CHALLENGE');
const PAIRING = '73', TOTP = '493817';
const SECRETS = [TOKEN, SECRET, PREFILLED, CHALLENGE, TOTP];
type View = 'landing' | 'passkey' | 'authenticator' | 'email' | 'mobile' | 'update';
const form = (inner: string) => `<form action="/sessions/sudo" method="post"><input type="hidden" name="authenticity_token" value="${TOKEN}" />` +
  `<input type="hidden" name="timestamp_secret" value="${SECRET}" />${inner}</form>`;
const MARKUP: Record<Exclude<View, 'update'>, string> = {
  landing: form('<label for="sudo_password">Password</label><input type="password" name="sudo_password" id="sudo_password" value="' + PREFILLED + '"><input type="submit" name="commit" value="Confirm">'),
  passkey: form(`<webauthn-get data-json='{"challenge":"${CHALLENGE}"}'><button type="submit">Use passkey</button></webauthn-get>`),
  authenticator: form(`<label for="app_totp">Authentication code</label><input type="text" name="app_otp" id="app_totp" autocomplete="one-time-code" value="${TOTP}"><button type="submit">Verify</button>`),
  email: form(`<label for="email_otp">Email code</label><input type="text" name="email_otp" id="email_otp" autocomplete="one-time-code" value="${PREFILLED}"><button type="submit">Verify</button>`),
  mobile: form(`<p>Enter the number shown below in GitHub Mobile</p><h1 class="mobile-code" data-code="${PAIRING}">${PAIRING}</h1><p>Open GitHub Mobile and choose ${PAIRING}.</p>`),
};
const TEXT: Record<View, string> = {
  landing: 'Confirm access\nPassword\nConfirm\nHaving problems?\nUse your passkey\nUse GitHub Mobile\nUse your authenticator app\nSend a code via email',
  passkey: 'Confirm access\nPasskey\nUse passkey', authenticator: 'Confirm access\nAuthentication code\nVerify', email: 'Confirm access\nEmail code\nVerify',
  mobile: `Confirm access\nGitHub Mobile\n${PAIRING}\nWe sent you a push notification`, update: 'Review permission request\nAccept new permissions',
};
const located = (selector: string, text: string, extra: Partial<Located> = {}): Located => ({ selector, tag: 'a', checked: null, value: null, text, visible: true, ...extra });

async function master() {
  const root = await temporaryDirectory('confirm-access'), credentialDirectory = await temporaryDirectory('confirm-access-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, browser: { profile: 'Default' } }, coordinatorStatus as typeof fetch);
  return { root, config: await loadMasterConfig(root), cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}

/**
 * The installation's permission request behind a recorded Confirm-access page. Each method view is
 * opened by its link; GitHub Mobile shows its pairing code for two polls before it is approved.
 * Typing, Verify, the passkey button or "Send a code via email" fail the test.
 */
class RecordedConfirmAccess {
  view: View = 'landing';
  granted = false; accepted = false; polls = 0;
  clicked: string[] = [];
  links: Record<string, Located> = { 'Use your passkey': located('#passkey', 'Use your passkey'), 'Use your authenticator app': located('#totp', 'Use your authenticator app'), 'Use email': located('#email-view', 'Use email') };
  page(): BrowserPage {
    const self = this;
    return {
      open(url) { assert.equal(url, UPDATE, 'only the flow\'s own page is opened'); self.view = self.granted ? 'update' : 'landing'; },
      url: () => UPDATE,
      text() {
        if (self.view === 'mobile' && (self.polls += 1) > 2) { self.granted = true; self.view = 'update'; }
        return TEXT[self.view];
      },
      meta: name => name === 'user-login' ? 'operator' : null,
      locate(kind, text) {
        if (self.view === 'update') return kind === 'button' && text === 'Accept new permissions' ? located('#accept', text, { tag: 'button' }) : null;
        if (self.view !== 'landing') return null;
        if (kind === 'button' && text === 'Use GitHub Mobile') return located('#mobile', text, { tag: 'button' });
        return kind === 'link' ? self.links[text] ?? null : null;
      },
      click(selector) {
        self.clicked.push(selector);
        const views: Record<string, View> = { '#passkey': 'passkey', '#totp': 'authenticator', '#email-view': 'email', '#mobile': 'mobile' };
        if (views[selector]) self.view = views[selector];
        else if (selector === '#accept') self.accepted = true;
        else assert.fail(`the flow must not activate ${selector}`);
      },
      setChecked() { assert.fail('nothing is checked'); }, select() { assert.fail('nothing is selected'); },
      screenshot() {}, wait() {}, close() {},
      fill() { assert.fail('nothing is typed into Confirm access'); },
      markup: () => self.view === 'update' ? null : MARKUP[self.view],
    };
  }
  installation = async (): Promise<InstallationState> => {
    const { controlPlanePermissions } = await browser();
    const before = Object.fromEntries(Object.entries(controlPlanePermissions).map(([name, level]) => [name, name === 'contents' ? 'read' : level]));
    return { appId: 1234, installationId: 91011, slug: 'graphyard-owner-project', account: 'owner', accountType: 'User', installationUrl: 'https://github.com/settings/installations/91011', suspended: false,
      permissions: this.accepted ? { ...controlPlanePermissions } : before, app: { ...controlPlanePermissions } } as InstallationState;
  };
}

async function run(root: string, config: Awaited<ReturnType<typeof master>>['config']) {
  const { runBrowserFlow } = await browser();
  const github = new RecordedConfirmAccess();
  let tick = Date.parse('2026-10-07T12:00:00Z');
  const result = await runBrowserFlow(root, config, 'installation-accept', { page: github.page(), api: () => JSON.stringify({ login: 'operator-cli' }), installation: github.installation, coordinator: 'master', now: () => new Date(tick += 1_000), sleep: async () => {}, sudo: { pollMs: 10, timeoutMs: 600_000 } });
  return { github, result, record: JSON.parse(await readFile(join(root, result.record, 'record.json'), 'utf8')) };
}

test('unit:confirm-access-capture — each Confirm-access view the flow meets is saved as confirm-access-<method>.html with no value, token or code', async () => {
  const { root, config, cleanup } = await master();
  try {
    const { github, result, record } = await run(root, config);
    assert.equal(result.outcome, 'applied'); assert.equal(github.accepted, true);
    assert.deepEqual(result.sudo, { attempts: 1, code: PAIRING }, 'sudo passed through GitHub Mobile, the method the flow always used');
    assert.deepEqual(github.clicked, ['#passkey', '#totp', '#email-view', '#mobile', '#accept'], 'each view was opened by its link; nothing was sent, typed or verified');
    const captures = join(root, result.record, 'confirm-access');
    const files = (await readdir(captures)).sort();
    assert.deepEqual(files, ['confirm-access-authenticator.html', 'confirm-access-email.html', 'confirm-access-landing.html', 'confirm-access-mobile.html', 'confirm-access-passkey.html']);
    assert.deepEqual(record.confirmAccess.map((captured: { view: string; file: string }) => [captured.view, captured.file]),
      ['landing', 'passkey', 'authenticator', 'email', 'mobile'].map(view => [view, `confirm-access/confirm-access-${view}.html`]), 'record.json names every capture');
    assert.ok(record.confirmAccess.every((captured: { url: string; at: string }) => captured.url === UPDATE && !Number.isNaN(Date.parse(captured.at))));
    assert.ok(!('confirmAccess' in result), 'the audit ledger entry keeps its schema');
    const steps = record.steps.filter((step: { action: string }) => step.action === 'confirm-access-capture').map((step: { args: string[] }) => step.args[0]);
    assert.deepEqual(steps, ['landing', 'passkey', 'authenticator', 'email', 'mobile'], 'each capture is a recorded step');
    const { sudoFormRedaction } = await browser();
    for (const file of files) {
      const html = await readFile(join(captures, file), 'utf8');
      for (const secret of SECRETS) assert.ok(!html.includes(secret), `${file} holds no session-bound value or code (${secret.split('-')[0]})`);
      assert.match(html, /^<form action="\/sessions\/sudo" method="post">/, `${file} keeps the form element`);
      for (const [, value] of html.matchAll(/\bvalue="([^"]*)"/g)) assert.equal(value, sudoFormRedaction, `${file} keeps no value attribute contents`);
      assert.ok(html.includes(`<input type="hidden" name="authenticity_token" value="${sudoFormRedaction}" />`), `${file} keeps the token input, redacted`);
    }
    const landing = await readFile(join(captures, 'confirm-access-landing.html'), 'utf8');
    assert.ok(landing.includes(`<input type="submit" name="commit" value="${sudoFormRedaction}">`), 'a structural input keeps its type and name but not its value');
    const totp = await readFile(join(captures, 'confirm-access-authenticator.html'), 'utf8');
    assert.ok(totp.includes(`<input type="text" name="app_otp" id="app_totp" autocomplete="one-time-code" value="${sudoFormRedaction}">`), 'the code field keeps its name, id and autocomplete');
    const mobile = await readFile(join(captures, 'confirm-access-mobile.html'), 'utf8');
    assert.ok(!new RegExp(`\\b${PAIRING}\\b`).test(mobile), 'the GitHub Mobile pairing code is stripped from text and attributes');
    assert.ok(mobile.includes(`<h1 class="mobile-code" data-code="${sudoFormRedaction}">${sudoFormRedaction}</h1>`));
    assert.ok(mobile.includes('<p>Enter the number shown below in GitHub Mobile</p>'), 'the prose stays');
    const passkey = await readFile(join(captures, 'confirm-access-passkey.html'), 'utf8');
    assert.ok(passkey.includes(`<webauthn-get data-json="${sudoFormRedaction}">`), 'the passkey challenge is redacted');
  } finally { await cleanup(); }
});

test('unit:confirm-access-fixture-list — master browser fixtures lists the captured files with their flow and time', async () => {
  const { root, config, cleanup } = await master();
  try {
    const { fleetCommand } = await import('../src/cli/master/fleet.js');
    const list = async () => await fleetCommand({ id: 'browser', args: ['fixtures'], print: (value: unknown) => value, root } as unknown as MasterSession) as any;
    assert.deepEqual(await list(), { fixtures: [], latest: {}, total: 0 }, 'no record yet lists nothing');
    const first = await run(root, config);
    const second = await run(root, config);
    // The earlier run's captures are older on disk, as they would be on a real host.
    const older = new Date('2026-10-06T08:00:00Z');
    const earlier = join(root, first.result.record, 'confirm-access');
    for (const file of await readdir(earlier)) await utimes(join(earlier, file), older, older);
    const listed = await list();
    assert.equal(listed.total, 10);
    assert.deepEqual(listed.fixtures.slice(0, 5).map((fixture: any) => fixture.record), Array(5).fill(second.result.record), 'the latest run is listed first');
    for (const fixture of listed.fixtures) {
      assert.equal(fixture.flow, 'installation-accept');
      assert.match(fixture.at, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(fixture.file, `${fixture.record}/confirm-access/confirm-access-${fixture.view}.html`);
    }
    assert.deepEqual(listed.fixtures.slice(5).map((fixture: any) => fixture.at), Array(5).fill(older.toISOString()));
    assert.equal(listed.latest.authenticator, `${second.result.record}/confirm-access/confirm-access-authenticator.html`, 'the latest authenticator capture is named');
    assert.deepEqual(Object.keys(listed.latest).sort(), ['authenticator', 'email', 'landing', 'mobile', 'passkey']);
    assert.ok((await readFile(join(root, listed.latest.authenticator), 'utf8')).includes('name="app_otp"'));
  } finally { await cleanup(); }
});
