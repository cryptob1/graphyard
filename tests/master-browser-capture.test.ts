import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import type { BrowserPage, Located } from '../src/master-browser.js';
import type { InstallationState } from '../src/github.js';
import type { MasterSession } from '../src/cli/master/session.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1686: `graphyard master browser capture` reaches GitHub's Confirm-access page on purpose, with
 * no administrative change pending, and keeps the views it shows as redacted fixtures through the
 * same keep logic the administrative flows run on the first such page they meet (GY-1461, GY-1482),
 * so a worker whose criterion needs a live Confirm-access fixture takes the latest file from
 * `master browser fixtures` instead of asking a person to record one.
 *
 * unit:master-browser-capture-keeps-views — a recorded Confirm-access page behind the sudo-protected
 * App permissions page: the landing view and each view a link alone opens (passkey, authenticator
 * app, email code) are saved as redacted markup in a new master-actions record, listed by
 * `master browser fixtures`; nothing is submitted, typed or sent, no control that sends a code is
 * followed, and GitHub Mobile is never triggered.
 *
 * unit:master-browser-capture-outcomes — sudo already held (no Confirm access shown), a page that
 * cannot be reached, a profile not signed in, a profile GitHub denies the page to, an offered view
 * that could not be kept, a landing that offers email only through a control that sends a code
 * (GitHub's own), and `--dry-run`: each records its outcome and reason as a step of its record,
 * names the next step, and carries the same actor, profile and audit ledger entry as the other
 * flows; only kept views become fixtures, a send-only email method is no view the capture owes,
 * and the dry run launches no browser.
 */

// Loaded per test, so on a base without this change each case fails on its own assertion.
const browser = () => import('../src/master-browser.js');
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const SLUG = 'graphyard-owner-project';
const PERMISSIONS = `https://github.com/settings/apps/${SLUG}/permissions`;
// Fake session-bound values, generated at runtime so no key-like literal is committed (gitleaks).
const fake = (label: string) => `${label}-${randomUUID()}`;
const TOKEN = fake('AUTHTOKEN'), SECRET = fake('TSSECRET'), PREFILLED = fake('PREFILLED'), CHALLENGE = fake('CHALLENGE'), TOTP = '493817';
const SECRETS = [TOKEN, SECRET, PREFILLED, CHALLENGE, TOTP];
type View = 'landing' | 'passkey' | 'authenticator' | 'email' | 'permissions';
const form = (inner: string) => `<form action="/sessions/sudo" method="post"><input type="hidden" name="authenticity_token" value="${TOKEN}" />` +
  `<input type="hidden" name="timestamp_secret" value="${SECRET}" />${inner}</form>`;
const MARKUP: Record<Exclude<View, 'permissions'>, string> = {
  landing: form('<label for="sudo_password">Password</label><input type="password" name="sudo_password" id="sudo_password" value="' + PREFILLED + '"><input type="submit" name="commit" value="Confirm">'),
  passkey: form(`<webauthn-get data-json='{"challenge":"${CHALLENGE}"}'><button type="submit">Use passkey</button></webauthn-get>`),
  authenticator: form(`<label for="app_totp">Authentication code</label><input type="text" name="app_otp" id="app_totp" autocomplete="one-time-code" value="${TOTP}"><button type="submit">Verify</button>`),
  email: form(`<label for="email_otp">Email code</label><input type="text" name="email_otp" id="email_otp" autocomplete="one-time-code" value="${PREFILLED}"><button type="submit">Verify</button>`),
};
const TEXT: Record<View, string> = {
  landing: 'Confirm access\nPassword\nConfirm\nHaving problems?\nUse your passkey\nUse GitHub Mobile\nUse your authenticator app\nUse email\nSend a code via email',
  passkey: 'Confirm access\nPasskey\nUse passkey', authenticator: 'Confirm access\nAuthentication code\nVerify', email: 'Confirm access\nEmail code\nVerify',
  permissions: 'Permissions\nRepository permissions\nSave changes',
};
const located = (selector: string, text: string, extra: Partial<Located> = {}): Located => ({ selector, tag: 'a', checked: null, value: null, text, visible: true, ...extra });

async function master() {
  const root = await temporaryDirectory('browser-capture'), credentialDirectory = await temporaryDirectory('browser-capture-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, browser: { profile: 'Default' } }, coordinatorStatus as typeof fetch);
  return { root, config: await loadMasterConfig(root), cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}

const installation = async (): Promise<InstallationState> => {
  const { controlPlanePermissions } = await browser();
  return { appId: 1234, installationId: 91011, slug: SLUG, account: 'owner', accountType: 'User', installationUrl: 'https://github.com/settings/installations/91011', suspended: false,
    permissions: { ...controlPlanePermissions }, app: { ...controlPlanePermissions } } as InstallationState;
};

/**
 * The App permissions page as the profile sees it. `confirm`: GitHub asks to confirm access first,
 * each method view opened by its link alone; `held`: sudo mode is held, the permissions page shows
 * at once; `unreachable`: the page cannot be opened; `signed-out`: GitHub redirects to its login
 * page; `denied`: a signed-in profile that cannot administer the App lands on GitHub's not-found page;
 * `partial`: the authenticator view's link is offered but fails to open; `send-only`: GitHub's real
 * landing, which offers email only through "Send a code via email" and no view link. Typing, Verify,
 * the passkey button, "Send a code via email" and "Use GitHub Mobile" fail the test.
 */
class AppPermissionsPage {
  view: View;
  clicked: string[] = []; opened: string[] = [];
  links: Record<string, Located> = { 'Use your passkey': located('#passkey', 'Use your passkey'), 'Use your authenticator app': located('#totp', 'Use your authenticator app'), 'Use email': located('#email-view', 'Use email') };
  constructor(readonly mode: 'confirm' | 'held' | 'unreachable' | 'signed-out' | 'denied' | 'partial' | 'send-only') {
    this.view = mode === 'held' ? 'permissions' : 'landing';
    if (mode === 'send-only') delete this.links['Use email'];
  }
  page(): BrowserPage {
    const self = this;
    return {
      open(url) {
        assert.equal(url, PERMISSIONS, 'only the App permissions page is opened');
        self.opened.push(url);
        if (self.mode === 'unreachable') throw new Error('agent-browser open failed: net::ERR_NAME_NOT_RESOLVED at https://github.com/');
        self.view = self.mode === 'held' ? 'permissions' : 'landing';
      },
      url: () => self.mode === 'signed-out' ? `https://github.com/login?return_to=${encodeURIComponent(PERMISSIONS)}` : self.mode === 'denied' ? 'https://github.com/settings/apps' : PERMISSIONS,
      text: () => self.mode === 'signed-out' ? 'Sign in to GitHub' : self.mode === 'denied' ? '404\nThis is not the web page you are looking for.'
        : self.mode === 'send-only' && self.view === 'landing' ? TEXT.landing.replace('\nUse email', '') : TEXT[self.view],
      meta: name => name === 'user-login' && self.mode !== 'signed-out' ? 'operator' : null,
      locate(kind, text) {
        if (self.view !== 'landing') return null;
        if (kind === 'button' && text === 'Use GitHub Mobile') return located('#mobile', text, { tag: 'button' });
        if (kind === 'button' && text === 'Send a code via email') return located('#send-email', text, { tag: 'button' });
        return kind === 'link' ? self.links[text] ?? null : null;
      },
      click(selector) {
        self.clicked.push(selector);
        const views: Record<string, View> = { '#passkey': 'passkey', '#totp': 'authenticator', '#email-view': 'email' };
        if (self.mode === 'partial' && selector === '#totp') throw new Error('agent-browser click failed: element #totp is detached');
        if (views[selector]) self.view = views[selector];
        else assert.fail(`the capture must not activate ${selector}`);
      },
      setChecked() { assert.fail('nothing is checked'); }, select() { assert.fail('nothing is selected'); },
      screenshot() {}, wait() {}, close() {},
      fill() { assert.fail('nothing is typed into Confirm access'); },
      markup: () => self.view === 'permissions' || self.mode === 'denied' ? null : MARKUP[self.view],
    };
  }
}

async function capture(root: string, config: Awaited<ReturnType<typeof master>>['config'], github: AppPermissionsPage, dryRun = false) {
  const { runBrowserFlow } = await browser();
  let tick = Date.parse('2026-10-11T03:00:00Z');
  const result = await runBrowserFlow(root, config, 'capture', { page: github.page(), api: () => JSON.stringify({ login: 'operator-cli' }), installation, coordinator: 'master', now: () => new Date(tick += 1_000), sleep: async () => {}, dryRun });
  return { result, record: JSON.parse(await readFile(join(root, result.record, 'record.json'), 'utf8')) };
}
const exists = (path: string) => stat(path).then(() => true, () => false);
const fleet = async (root: string, args: string[], extra: Record<string, unknown> = {}) => {
  const { fleetCommand } = await import('../src/cli/master/fleet.js');
  return await fleetCommand({ id: 'browser', args, print: (value: unknown) => value, root, ...extra } as unknown as MasterSession) as any;
};

test('unit:master-browser-capture-keeps-views — master browser capture keeps the landing, passkey, authenticator and email views of a Confirm-access page as redacted fixtures, following view links alone', async () => {
  const { root, config, cleanup } = await master();
  try {
    const { browserFlows, readAdministrationLedger, sudoFormRedaction } = await browser();
    assert.ok(browserFlows.includes('capture'), 'capture is a master browser flow');
    await assert.rejects(fleet(root, ['bogus']), /master browser app-permissions\|installation-accept\|protection\|capture \[--dry-run\]/, 'the CLI names the capture flow');
    const github = new AppPermissionsPage('confirm');
    const { result, record } = await capture(root, config, github);
    assert.equal(result.flow, 'capture'); assert.equal(result.outcome, 'applied'); assert.equal(result.verified, true);
    assert.equal(result.sudo, null, 'no Confirm-access pass ran: no attempt, no GitHub Mobile code');
    assert.match(result.reason!, /^Kept 4 Confirm-access view\(s\) as redacted markup: landing, passkey, authenticator, email$/);
    assert.match(result.next, /master browser fixtures/);
    assert.deepEqual(github.clicked, ['#passkey', '#totp', '#email-view'], 'each code view was opened by its own link; nothing was sent, typed, verified or Mobile-prompted');
    assert.ok(github.opened.length >= 1 && github.opened.every(url => url === PERMISSIONS), 'only the App permissions page and its landing view were opened');
    assert.deepEqual(record.target, { repository: 'owner/project', appId: 1234, slug: SLUG, installationId: 91011 });
    assert.deepEqual(record.actor, { browser: 'operator', profile: 'Default', cli: 'operator-cli', os: userInfo().username, host: config.hostId, coordinator: 'master' });
    const actions = record.steps.map((step: { action: string }) => step.action);
    for (const forbidden of ['sudo-method', 'sudo-code', 'sudo-fallback', 'fill', 'select', 'setChecked']) assert.ok(!actions.includes(forbidden), `no ${forbidden} step: the capture confirms nothing`);
    assert.deepEqual(record.steps.filter((step: { action: string }) => step.action === 'confirm-access-capture').map((step: { args: string[] }) => step.args[0]), ['landing', 'passkey', 'authenticator', 'email'], 'each kept view is a recorded step');
    assert.deepEqual(record.steps.filter((step: { action: string }) => step.action === 'capture').map((step: { args: string[] }) => step.args), [['applied', result.reason]], 'the outcome is a recorded step with its reason');
    assert.deepEqual(record.after, { url: PERMISSIONS, views: ['landing', 'passkey', 'authenticator', 'email'], missed: [] });
    const captures = join(root, result.record, 'confirm-access');
    const files = (await readdir(captures)).sort();
    assert.deepEqual(files, ['confirm-access-authenticator.html', 'confirm-access-email.html', 'confirm-access-landing.html', 'confirm-access-passkey.html'], 'the mobile view is never kept: no prompt was issued');
    assert.deepEqual(record.confirmAccess.map((captured: { view: string; file: string; url: string }) => [captured.view, captured.file, captured.url]),
      ['landing', 'passkey', 'authenticator', 'email'].map(view => [view, `confirm-access/confirm-access-${view}.html`, PERMISSIONS]), 'record.json names every capture');
    assert.deepEqual(record.sudoForms.map((captured: { view: string; file: string }) => [captured.view, captured.file]), [['landing', 'sudo-form-landing.html'], ['authenticator', 'sudo-form-authenticator.html'], ['email', 'sudo-form-email.html']], 'the GY-1461 forms are kept by the same logic');
    for (const file of files) {
      const html = await readFile(join(captures, file), 'utf8');
      for (const secret of SECRETS) assert.ok(!html.includes(secret), `${file} holds no session-bound value or code (${secret.split('-')[0]})`);
      assert.match(html, /^<form action="\/sessions\/sudo" method="post">/, `${file} keeps the form element`);
      for (const [, value] of html.matchAll(/\bvalue="([^"]*)"/g)) assert.equal(value, sudoFormRedaction, `${file} keeps no value attribute contents`);
      assert.ok(html.includes(`<input type="hidden" name="authenticity_token" value="${sudoFormRedaction}" />`), `${file} keeps the token input, redacted`);
    }
    assert.ok((await readFile(join(captures, 'confirm-access-authenticator.html'), 'utf8')).includes('name="app_otp" id="app_totp" autocomplete="one-time-code"'), 'the code field keeps its name, id and autocomplete');
    assert.ok((await readFile(join(captures, 'confirm-access-passkey.html'), 'utf8')).includes(`<webauthn-get data-json="${sudoFormRedaction}">`), 'the passkey challenge is redacted');
    // The audit ledger carries the capture like any administrative flow.
    const ledger = await readAdministrationLedger(root);
    assert.deepEqual(ledger.entries.map(entry => [entry.flow, entry.outcome, entry.verified, entry.record, entry.actor.profile, entry.sudo]), [['capture', 'applied', true, result.record, 'Default', null]]);
    assert.ok(!('confirmAccess' in result) && !('steps' in ledger.entries[0]), 'the ledger entry keeps its schema');
    // master browser fixtures lists the kept views, newest first, with the latest of each named.
    const listed = await fleet(root, ['fixtures']);
    assert.equal(listed.total, 4);
    assert.deepEqual(listed.fixtures.map((fixture: any) => [fixture.flow, fixture.record]), Array(4).fill(['capture', result.record]));
    assert.deepEqual(Object.keys(listed.latest).sort(), ['authenticator', 'email', 'landing', 'passkey']);
    assert.equal(listed.latest.authenticator, `${result.record}/confirm-access/confirm-access-authenticator.html`);
  } finally { await cleanup(); }
});

test('unit:master-browser-capture-outcomes — sudo already held, an unreachable page, a signed-out profile, a profile GitHub denies the page to, an offered view that could not be kept, a landing offering email only through a control that sends a code, and --dry-run each record their outcome and reason as a step, name the next step and carry the same actor and audit entry; only the kept views become fixtures, a send-only email method is owed no view, and the dry run launches no browser', async () => {
  const { root, config, cleanup } = await master();
  try {
    const { readAdministrationLedger } = await browser();
    const noFixture = async (record: string) => assert.equal(await exists(join(root, record, 'confirm-access')), false, `${record} keeps no fixture`);
    const outcomeStep = (record: any) => record.steps.filter((step: { action: string }) => step.action === 'capture').map((step: { args: string[] }) => step.args);

    // Sudo mode already held: the permissions page shows, there is no view to keep.
    const held = await capture(root, config, new AppPermissionsPage('held'));
    assert.equal(held.result.outcome, 'unchanged'); assert.equal(held.result.verified, true);
    assert.match(held.result.reason!, /GitHub showed no Confirm access at https:\/\/github\.com\/settings\/apps\/graphyard-owner-project\/permissions: the profile's session already holds sudo mode/);
    assert.deepEqual(outcomeStep(held.record), [['none', held.result.reason]]);
    assert.match(held.result.next, /^Rerun master browser capture once GitHub asks the profile to confirm access again/);
    assert.deepEqual(held.record.confirmAccess, []); assert.deepEqual(held.record.sudoForms, []);
    await noFixture(held.result.record);

    // The page cannot be reached: the open step records the error, the outcome is refused with it.
    const unreachable = new AppPermissionsPage('unreachable');
    const down = await capture(root, config, unreachable);
    assert.equal(down.result.outcome, 'refused'); assert.equal(down.result.verified, false);
    assert.match(down.result.reason!, /net::ERR_NAME_NOT_RESOLVED/);
    assert.deepEqual(outcomeStep(down.record), [['refused', down.result.reason]]);
    assert.equal(down.record.steps.find((step: { action: string }) => step.action === 'open')?.error, down.result.reason, 'the failed open is recorded with its error');
    assert.match(down.result.next, new RegExp(`^Inspect ${down.result.record}/record\\.json and its screenshots, then rerun master browser capture$`));
    await noFixture(down.result.record);

    // The profile is not signed in: GitHub redirects to its login page, which is refused by name.
    const out = await capture(root, config, new AppPermissionsPage('signed-out'));
    assert.equal(out.result.outcome, 'refused');
    assert.match(out.result.reason!, /^The browser profile Default is not signed in to GitHub; sign in once in that profile, then rerun master browser capture$/);
    assert.deepEqual(outcomeStep(out.record), [['refused', out.result.reason]]);
    await noFixture(out.result.record);

    // A signed-in profile that cannot administer the App: GitHub shows neither Confirm access nor the
    // permissions page, which is refused by name rather than read as sudo mode already held.
    const denied = await capture(root, config, new AppPermissionsPage('denied'));
    assert.equal(denied.result.outcome, 'refused'); assert.equal(denied.result.verified, false);
    assert.match(denied.result.reason!, /^GitHub showed neither Confirm access nor the App permissions page at https:\/\/github\.com\/settings\/apps; the browser profile Default may not administer the App graphyard-owner-project, and the recorded page shows what it offered instead$/);
    assert.deepEqual(outcomeStep(denied.record), [['refused', denied.result.reason]]);
    assert.match(denied.result.next, /^Inspect .*record\.json and its screenshots, then rerun master browser capture$/);
    await noFixture(denied.result.record);

    // An offered view the capture could not open: the kept views are fixtures, the run is refused
    // naming the missed one, so a worker is never sent to a fixture set that lacks the view it needs.
    const partial = await capture(root, config, new AppPermissionsPage('partial'));
    assert.equal(partial.result.outcome, 'refused'); assert.equal(partial.result.verified, false);
    assert.equal(partial.result.reason, 'Kept landing, passkey, email but not the offered authenticator view(s); the recorded steps name each failure, so rerun until every offered view is kept');
    assert.deepEqual(outcomeStep(partial.record), [['refused', partial.result.reason]]);
    assert.deepEqual(partial.record.after, { url: PERMISSIONS, views: ['landing', 'passkey', 'email'], missed: ['authenticator'] });
    assert.ok(partial.record.steps.some((step: { action: string; args: string[] }) => step.action === 'sudo-form-capture' && step.args[0] === 'authenticator' && /^failed: agent-browser click failed/.test(step.args[1])), 'the missed view is a recorded failure step');
    assert.deepEqual(partial.record.confirmAccess.map((capture: { view: string }) => capture.view).sort(), ['email', 'landing', 'passkey']);
    assert.equal(await exists(join(root, partial.result.record, 'confirm-access', 'confirm-access-authenticator.html')), false, 'no authenticator fixture is written');
    assert.match(partial.result.next, /^Inspect .*record\.json and its screenshots, then rerun master browser capture$/);

    // GitHub's own landing advertises email only as "Send a code via email": a control the capture
    // never follows, so the email view is not one the run owes. The capture is applied on the views
    // a link alone opens, the reason says why no email view is expected, and the keep logic's step
    // records the method it did not follow.
    const sendOnly = await capture(root, config, new AppPermissionsPage('send-only'));
    assert.equal(sendOnly.result.outcome, 'applied'); assert.equal(sendOnly.result.verified, true);
    assert.equal(sendOnly.result.reason, 'Kept 3 Confirm-access view(s) as redacted markup: landing, passkey, authenticator; the email method is offered only by a control that sends a code, which the capture never follows, so no email view is expected');
    assert.deepEqual(outcomeStep(sendOnly.record), [['applied', sendOnly.result.reason]]);
    assert.deepEqual(sendOnly.record.after, { url: PERMISSIONS, views: ['landing', 'passkey', 'authenticator'], missed: [] });
    assert.ok(sendOnly.record.steps.some((step: { action: string; args: string[] }) => step.action === 'sudo-form-capture' && step.args[0] === 'email' && step.args[1] === 'failed: no email view link (only a control that sends a code, which is not followed)'), 'the send-only email method is a recorded step, not a missed view');
    assert.deepEqual(sendOnly.record.confirmAccess.map((capture: { view: string }) => capture.view), ['landing', 'passkey', 'authenticator']);
    assert.equal(await exists(join(root, sendOnly.result.record, 'confirm-access', 'confirm-access-email.html')), false, 'no email fixture is written: no code was sent');
    assert.match(sendOnly.result.next, /master browser fixtures/);

    // --dry-run: what would be opened is recorded; no page is opened and no browser launched.
    const dry = new AppPermissionsPage('confirm');
    dry.page = () => ({ ...new AppPermissionsPage('confirm').page(), open: () => assert.fail('a dry run opens no page') });
    const planned = await capture(root, config, dry, true);
    assert.equal(planned.result.outcome, 'unchanged'); assert.equal(planned.result.verified, false);
    assert.match(planned.result.reason!, new RegExp(`^Dry run; would open ${PERMISSIONS} in browser profile Default and keep each Confirm-access view it offers \\(landing, passkey, authenticator, email\\) as redacted markup under ${planned.result.record}/confirm-access, submitting nothing$`));
    assert.deepEqual(outcomeStep(planned.record), [['dry-run', planned.result.reason]]);
    assert.equal(planned.record.steps.length, 1, 'the dry run records what it would open and nothing else');
    assert.equal(planned.result.next, 'Rerun master browser capture without --dry-run to open the page and keep its Confirm-access views');
    await noFixture(planned.result.record);
    // Through the CLI, the dry run builds the real agent-browser page and still runs no command: nothing else listens on this host.
    const cli = await fleet(root, ['capture', '--dry-run'], { master: config, coordinator: { actor: { id: 'master' } }, masterApi: async (path: string) => path === 'work-snapshot' ? { work: [] } : installation() });
    assert.equal(cli.outcome, 'unchanged'); assert.match(cli.reason, /^Dry run; would open/); assert.equal(cli.actor.coordinator, 'master');

    // Every run carries the same actor, profile and audit entry as the administrative flows.
    const ledger = await readAdministrationLedger(root);
    assert.deepEqual(ledger.entries.map(entry => [entry.flow, entry.outcome, entry.actor.profile, entry.actor.coordinator, entry.sudo]),
      [['capture', 'unchanged', 'Default', 'master', null], ['capture', 'refused', 'Default', 'master', null], ['capture', 'refused', 'Default', 'master', null], ['capture', 'refused', 'Default', 'master', null], ['capture', 'refused', 'Default', 'master', null], ['capture', 'applied', 'Default', 'master', null], ['capture', 'unchanged', 'Default', 'master', null], ['capture', 'unchanged', 'Default', 'master', null]]);
    for (const entry of ledger.entries) assert.deepEqual(entry.target, { repository: 'owner/project', appId: 1234, slug: SLUG, installationId: 91011 });
    // Only the partial and send-only captures kept any view; every outcome without a Confirm-access
    // page lists none, and the latest of each view comes from the newest record that kept it.
    const fixtures = await fleet(root, ['fixtures']);
    assert.deepEqual(fixtures.fixtures.map((fixture: { view: string; flow: string }) => [fixture.flow, fixture.view]).sort(), [['capture', 'authenticator'], ['capture', 'email'], ['capture', 'landing'], ['capture', 'landing'], ['capture', 'passkey'], ['capture', 'passkey']], 'the kept views of the partial and send-only captures are listed, the missed and unowed ones are not');
    assert.equal(fixtures.total, 6); assert.deepEqual(Object.keys(fixtures.latest).sort(), ['authenticator', 'email', 'landing', 'passkey']);
    assert.equal(fixtures.latest.landing, `${sendOnly.result.record}/confirm-access/confirm-access-landing.html`);
    assert.equal(fixtures.latest.email, `${partial.result.record}/confirm-access/confirm-access-email.html`);
  } finally { await cleanup(); }
});
