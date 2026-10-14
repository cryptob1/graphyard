import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import type { BrowserPage, Located, PageControl } from '../src/master-browser.js';
import type { InstallationState } from '../src/github.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1781: `master browser capture` looked for "Use your authenticator app" as a link alone, while
 * GitHub's passkey-first Confirm-access page offers it under "Having problems?" as a form button, so
 * the authenticator view was never kept and GY-1459's fixture stayed unrecorded. The capture now
 * activates each code view's control the way the GitHub Mobile route does: a rendered button first,
 * then an anchor through its href when its click fails; it waits for the view, keeps it as
 * confirm-access-authenticator.html and returns to the landing view. When no control of any offered
 * label exists, the recorded step names every control under "Having problems?" by tag and label.
 *
 * unit:capture-keeps-authenticator-view-from-button — a page whose authenticator method is a form
 * button keeps the authenticator view (the button is tried before any link, and the landing view is
 * restored); a page whose only control is an anchor that refuses its click is followed through its
 * href; a page with no such control refuses the capture with a step naming the controls it saw.
 *
 * unit:capture-docs-name-control-kinds — docs/master-agent-reference.md states that the capture
 * follows each offered method's control as a button or a link and that a refused capture's record
 * names the controls it saw.
 */

// Loaded per test, so on a base without this change each case fails on its own assertion.
const browser = () => import('../src/master-browser.js');
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const SLUG = 'graphyard-owner-project';
const PERMISSIONS = `https://github.com/settings/apps/${SLUG}/permissions`;
const TOTP_HREF = 'https://github.com/sessions/sudo?sudo_method=app';
// Fake session-bound values, generated at runtime so no key-like literal is committed (gitleaks).
const fake = (label: string) => `${label}-${randomUUID()}`;
const TOKEN = fake('AUTHTOKEN'), TOTP = '493817';
type View = 'landing' | 'authenticator';
const form = (inner: string) => `<form action="/sessions/sudo" method="post"><input type="hidden" name="authenticity_token" value="${TOKEN}" />${inner}</form>`;
const MARKUP: Record<View, string> = {
  landing: form(`<webauthn-get data-json='{"challenge":"${fake('CHALLENGE')}"}'><button type="button">Use passkey</button></webauthn-get>`),
  authenticator: form(`<label for="app_totp">Authentication code</label><input type="text" name="sudo_app_otp" id="app_totp" autocomplete="one-time-code" value="${TOTP}"><button type="submit">Verify</button>`),
};
// GitHub's passkey-first landing, as the 2026-10-13 capture record read it: no view link anywhere.
const TEXT: Record<View, string> = {
  landing: 'Confirm access\nSigned in as @operator\nPasskey\nWhen you are ready, authenticate using the button below.\nUse passkey\nHaving problems?\nUse GitHub Mobile\nUse your authenticator app\nSend a code via email',
  authenticator: 'Confirm access\nAuthentication code\nVerify',
};
const located = (selector: string, text: string, extra: Partial<Located> = {}): Located => ({ selector, tag: 'button', checked: null, value: null, text, visible: true, ...extra });
const PROBLEMS: PageControl[] = [{ tag: 'button', label: 'Use GitHub Mobile' }, { tag: 'button', label: 'Send a code via email' }, { tag: 'a', label: 'Use your password' }];

async function master() {
  const root = await temporaryDirectory('capture-button'), credentialDirectory = await temporaryDirectory('capture-button-credentials');
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
 * The passkey-first Confirm-access page behind the App permissions page. `button`: "Use your
 * authenticator app" is a rendered form button and no link; `href`: that button is not rendered,
 * and the anchor of the same label refuses its click but carries an href; `none`: the text offers
 * the authenticator app but no button or link carries any of its labels. The passkey button,
 * "Use GitHub Mobile", "Send a code via email", typing and Verify fail the test.
 */
class PasskeyFirstPage {
  view: View = 'landing';
  clicked: string[] = []; opened: string[] = []; located: string[] = []; listed: string[] = [];
  constructor(readonly mode: 'button' | 'href' | 'none') {}
  page(): BrowserPage {
    const self = this;
    const authenticator = (label: string) => ['Use your authenticator app', 'Use authenticator app', 'Use an authenticator app', 'Authenticator app'].includes(label);
    return {
      open(url) {
        self.opened.push(url);
        if (url === TOTP_HREF) { assert.equal(self.mode, 'href', 'only the href mode follows the anchor'); self.view = 'authenticator'; return; }
        assert.equal(url, PERMISSIONS, 'only the App permissions page is opened');
        self.view = 'landing';
      },
      url: () => self.view === 'authenticator' && self.mode === 'href' ? TOTP_HREF : PERMISSIONS,
      text: () => TEXT[self.view],
      meta: name => name === 'user-login' ? 'operator' : null,
      locate(kind, text) {
        self.located.push(`${kind}:${text}`);
        if (self.view !== 'landing') return null;
        if (kind === 'button' && text === 'Use passkey') return located('#passkey', text);
        if (kind === 'button' && text === 'Use GitHub Mobile') return located('#mobile', text);
        if (kind === 'button' && text === 'Send a code via email') return located('#send-email', text);
        if (!authenticator(text) || text !== 'Use your authenticator app') return null;
        if (self.mode === 'button') return kind === 'button' ? located('#totp-button', text) : null;
        if (self.mode === 'href') return kind === 'button' ? located('#totp-hidden', text, { visible: false }) : located('#totp-anchor', text, { tag: 'a', href: TOTP_HREF });
        return null;
      },
      click(selector) {
        self.clicked.push(selector);
        if (selector === '#totp-button') { self.view = 'authenticator'; return; }
        if (selector === '#totp-anchor' || selector === '#totp-hidden') throw new Error(`agent-browser click failed: element ${selector} is not clickable`);
        assert.fail(`the capture must not activate ${selector}`);
      },
      setChecked() { assert.fail('nothing is checked'); }, select() { assert.fail('nothing is selected'); },
      screenshot() {}, wait() {}, close() {},
      fill() { assert.fail('nothing is typed into Confirm access'); },
      markup: () => MARKUP[self.view],
      controls(heading) { self.listed.push(heading); return self.view === 'landing' && heading === 'Having problems?' ? PROBLEMS.map(control => ({ ...control })) : []; },
    };
  }
}

async function capture(root: string, config: Awaited<ReturnType<typeof master>>['config'], github: PasskeyFirstPage) {
  const { runBrowserFlow } = await browser();
  let tick = Date.parse('2026-10-14T03:00:00Z');
  const result = await runBrowserFlow(root, config, 'capture', { page: github.page(), api: () => JSON.stringify({ login: 'operator-cli' }), installation, coordinator: 'master', now: () => new Date(tick += 1_000), sleep: async () => {} });
  return { result, record: JSON.parse(await readFile(join(root, result.record, 'record.json'), 'utf8')) };
}
const exists = (path: string) => stat(path).then(() => true, () => false);
const captureSteps = (record: any, view: string) => record.steps.filter((step: { action: string; args: string[] }) => step.action === 'sudo-form-capture' && step.args[0] === view).map((step: { args: string[] }) => step.args[1]);

test('unit:capture-keeps-authenticator-view-from-button — a form button opens the authenticator view, which is kept and left for the landing view; an anchor refusing its click is followed through its href; no control of any label refuses the capture naming the controls under "Having problems?"', async () => {
  const { root, config, cleanup } = await master();
  try {
    const { sudoFormRedaction } = await browser();
    // The authenticator method is a rendered form button: the button is tried before any link.
    const button = new PasskeyFirstPage('button');
    const kept = await capture(root, config, button);
    assert.equal(kept.result.outcome, 'applied', kept.result.reason!); assert.equal(kept.result.verified, true);
    assert.equal(kept.result.reason, 'Kept 3 Confirm-access view(s) as redacted markup: landing, passkey, authenticator; the email method is offered only by a control that sends a code, which the capture never follows, so no email view is expected');
    assert.deepEqual(kept.record.after, { url: PERMISSIONS, views: ['landing', 'passkey', 'authenticator'], missed: [] });
    assert.deepEqual(button.clicked, ['#totp-button'], 'the authenticator button is the only control activated: no passkey, Mobile or email control');
    const order = button.located.filter(entry => entry.endsWith(':Use your authenticator app'));
    assert.equal(order[0], 'button:Use your authenticator app', 'a rendered button is located first');
    assert.ok(!order.includes('link:Use your authenticator app'), 'a rendered button is activated without locating the link');
    assert.ok(!button.located.some(entry => entry.startsWith('button:Use your passkey') || entry.startsWith('button:Use passkey')), 'the passkey view is still reached by its link alone: its button starts WebAuthn');
    assert.deepEqual(button.opened, [PERMISSIONS, PERMISSIONS], 'the landing view is reopened after the authenticator view was kept');
    const file = join(root, kept.result.record, 'confirm-access', 'confirm-access-authenticator.html');
    const html = await readFile(file, 'utf8');
    assert.ok(html.includes(`<input type="text" name="sudo_app_otp" id="app_totp" autocomplete="one-time-code" value="${sudoFormRedaction}">`), 'the authenticator view is kept as confirm-access-authenticator.html, redacted');
    assert.ok(!html.includes(TOTP) && !html.includes(TOKEN));
    assert.ok(kept.record.confirmAccess.some((captured: { view: string; file: string }) => captured.view === 'authenticator' && captured.file === 'confirm-access/confirm-access-authenticator.html'), 'record.json names the authenticator capture');
    assert.deepEqual(captureSteps(kept.record, 'authenticator'), ['sudo-form-authenticator.html'], 'the GY-1461 form is kept by the same step');
    assert.ok(kept.record.steps.some((step: { action: string; args: string[] }) => step.action === 'text'), 'the capture waits for the view by reading the page');

    // The button is not rendered and the anchor of the same label refuses its click: its href is opened.
    const anchor = new PasskeyFirstPage('href');
    const followed = await capture(root, config, anchor);
    assert.equal(followed.result.outcome, 'applied', followed.result.reason!);
    assert.deepEqual(followed.record.after.views, ['landing', 'passkey', 'authenticator']);
    assert.deepEqual(anchor.clicked, ['#totp-anchor'], 'the rendered anchor is clicked before its href is opened; the hidden button is never clicked');
    assert.ok(anchor.opened.includes(TOTP_HREF), 'the anchor is followed through its href when its click fails');
    assert.equal(anchor.opened.at(-1), PERMISSIONS, 'the landing view is reopened afterwards');
    assert.ok(await exists(join(root, followed.result.record, 'confirm-access', 'confirm-access-authenticator.html')));
    assert.equal(followed.record.confirmAccess.find((captured: { view: string }) => captured.view === 'authenticator').url, TOTP_HREF, 'the capture records the address the view was kept at');

    // No button or link carries any offered label: refused, and the step names what the page offered.
    const none = new PasskeyFirstPage('none');
    const refused = await capture(root, config, none);
    assert.equal(refused.result.outcome, 'refused'); assert.equal(refused.result.verified, false);
    assert.equal(refused.result.reason, 'Kept landing, passkey but not the offered authenticator view(s); the recorded steps name each failure, so rerun until every offered view is kept; the email method is offered only by a control that sends a code, which the capture never follows, so no email view is expected');
    assert.deepEqual(refused.record.after, { url: PERMISSIONS, views: ['landing', 'passkey'], missed: ['authenticator'] });
    assert.deepEqual(captureSteps(refused.record, 'authenticator'), ['failed: no authenticator view control; controls under "Having problems?": button "Use GitHub Mobile", button "Send a code via email", a "Use your password"'], 'the failure names every control under "Having problems?" by tag and label');
    assert.deepEqual(captureSteps(refused.record, 'email'), ['failed: no email view control (only a control that sends a code, which is not followed); controls under "Having problems?": button "Use GitHub Mobile", button "Send a code via email", a "Use your password"']);
    assert.deepEqual(none.listed, ['Having problems?', 'Having problems?']);
    assert.ok(refused.record.steps.some((step: { action: string; args: string[]; result: string | null }) => step.action === 'controls' && step.args[0] === 'Having problems?' && /Use GitHub Mobile/.test(step.result ?? '')), 'the listing is a recorded step');
    assert.deepEqual(none.clicked, [], 'nothing is activated');
    for (const label of ['button:Use your authenticator app', 'link:Use your authenticator app', 'button:Use authenticator app', 'link:Authenticator app']) assert.ok(none.located.includes(label), `${label} was looked for`);
    assert.equal(await exists(join(root, refused.result.record, 'confirm-access', 'confirm-access-authenticator.html')), false);
    assert.match(refused.result.next, /^Inspect .*record\.json and its screenshots, then rerun master browser capture$/);

    // The agent-browser page lists the controls by evaluating a script scoped to the heading.
    const { agentBrowserPage } = await browser();
    const evals: string[] = [];
    const page = agentBrowserPage({ profile: 'Default' }, 's', args => { if (args.includes('eval')) evals.push(args[args.length - 1]); return JSON.stringify({ success: true, data: { result: JSON.stringify(PROBLEMS) } }); });
    assert.deepEqual(page.controls!('Having problems?'), PROBLEMS);
    assert.ok(evals[0].includes('"Having problems?"') && /button, input\[type=submit\], input\[type=button\], a\[href\]/.test(evals[0]), 'the script lists buttons and links under the heading');
  } finally { await cleanup(); }
});

test('unit:capture-docs-name-control-kinds — docs/master-agent-reference.md states that the capture follows each offered method\'s control as a button or a link and that a refused capture\'s record names the controls it saw', async () => {
  const docs = await readFile(fileURLToPath(new URL('../docs/master-agent-reference.md', import.meta.url)), 'utf8');
  const sentence = docs.split('\n').find(line => line.includes('master browser capture'));
  assert.ok(sentence, 'the reference documents master browser capture');
  assert.match(sentence!, /following each offered method's control as a button or a link/, 'the capture follows a method\'s control as a button or a link');
  assert.match(sentence!, /a refused capture's record names the controls it saw/, 'a refused capture\'s record names the controls it saw');
});
