import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import type { BrowserPage, Located, RecordedStep } from '../src/master-browser.js';
import type { InstallationState } from '../src/github.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1461: a master browser flow that reaches GitHub's Confirm access keeps the redacted markup of
 * the page's forms — the view it landed on, the authenticator view and the email-code view — in its
 * record, so a fixture for the authenticator code field can be recorded through the sanctioned path.
 *
 * unit:sudo-form-capture-redacted — a fake Confirm-access page whose forms carry an
 * authenticity_token, a timestamp_secret and a prefilled input: the captured files exist, are named
 * in record.json, keep the form's structure, names, ids, labels and autocomplete, and hold none of
 * the secret values; nothing is typed or submitted and the flow passes sudo by the method it always did.
 *
 * unit:sudo-form-capture-nonfatal — no form, an absent view link, a page error and a spent budget are
 * each recorded as a step with its error, and the flow still completes.
 */

// Loaded per test, so on a base without this change each case fails on its own assertion.
const browser = () => import('../src/master-browser.js');
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const UPDATE = 'https://github.com/settings/installations/91011/permissions/update';
// Fake session-bound values, generated at runtime so no key-like literal is committed (gitleaks).
const fake = (label: string) => `${label}-${randomUUID()}`;
const TOKEN = fake('AUTHTOKEN'), TIMESTAMP_SECRET = fake('TSSECRET'), TIMESTAMP = String(Date.now()), PREFILLED = fake('PREFILLED'), NONCE = fake('NONCE');
const SECRETS = [TOKEN, TIMESTAMP_SECRET, TIMESTAMP, PREFILLED, NONCE];
const LANDING_TEXT = 'Confirm access\n\nPasskey\nWhen you are ready, authenticate using the button below.\nUse passkey\nHaving problems?\nUse GitHub Mobile\nUse your authenticator app\nSend a code via email';
const form = (inner: string) => `<form action="/sessions/sudo" accept-charset="UTF-8" method="post"><input type="hidden" name="authenticity_token" value="${TOKEN}" autocomplete="off" />` +
  `<input type="hidden" name="timestamp" value="${TIMESTAMP}" /><input type="hidden" name="timestamp_secret" value="${TIMESTAMP_SECRET}" />${inner}</form>`;
const MARKUP = {
  landing: form(`<webauthn-get data-json='{"challenge":"${NONCE}"}'><button type="submit" class="btn">Use passkey</button></webauthn-get>`),
  authenticator: form(`<label for="app_totp">Authentication code</label><input type="text" name="app_otp" id="app_totp" autocomplete="one-time-code" inputmode="numeric" value="${PREFILLED}" class="form-control" data-csrf-nonce="${NONCE}"><button type="submit" class="btn btn-primary">Verify</button>`),
  email: form(`<label for="email_otp">Email code</label><input type="password" name="email_otp" id="email_otp" autocomplete="one-time-code" value='${PREFILLED}'><button type="submit">Verify</button>`),
};
const located = (selector: string, text: string, extra: Partial<Located> = {}): Located => ({ selector, tag: 'a', checked: null, value: null, text, visible: true, ...extra });

async function master() {
  const root = await temporaryDirectory('sudo-form'), credentialDirectory = await temporaryDirectory('sudo-form-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, browser: { profile: 'Default' } }, coordinatorStatus as typeof fetch);
  return { root, config: await loadMasterConfig(root), cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}

/**
 * The installation's permission request behind Confirm access. The landing view offers a passkey,
 * GitHub Mobile, the authenticator app and email; each code view is opened by its link. Clicking
 * GitHub Mobile is approved at once; typing, Verify or "Send a code via email" fail the test.
 */
class ConfirmAccessPage {
  view: 'landing' | 'authenticator' | 'email' | 'update' = 'landing';
  granted = false; accepted = false;
  opened: string[] = []; clicked: string[] = [];
  markup: Partial<Record<'landing' | 'authenticator' | 'email', string | null>> = { ...MARKUP };
  links: Record<string, Located | null> = { 'Use your authenticator app': located('#totp', 'Use your authenticator app'), 'Use email': located('#email-view', 'Use email') };
  failClick = new Set<string>();
  // Opens made while the page shows the email view that fail with a page error, leaving it there.
  failOpensFromEmail = 0;
  landingText = LANDING_TEXT;
  page(): BrowserPage {
    const self = this;
    return {
      open(url) {
        self.opened.push(url); assert.equal(url, UPDATE, 'only the flow\'s own page is opened');
        if (self.view === 'email' && self.failOpensFromEmail > 0) { self.failOpensFromEmail -= 1; throw new Error('agent-browser open failed: net::ERR_CONNECTION_RESET'); }
        self.view = self.granted ? 'update' : 'landing';
      },
      url: () => UPDATE,
      text: () => self.view === 'update' ? 'Review permission request\nAccept new permissions' : self.view === 'landing' ? self.landingText : self.view === 'authenticator' ? 'Confirm access\nAuthentication code\nVerify' : 'Confirm access\nEmail code\nVerify',
      meta: name => name === 'user-login' ? 'operator' : null,
      locate(kind, text) {
        if (self.view === 'update') return kind === 'button' && text === 'Accept new permissions' ? located('#accept', text, { tag: 'button' }) : null;
        if (self.view !== 'landing') return null;
        if (kind === 'button' && text === 'Use GitHub Mobile') return located('#mobile', text, { tag: 'button' });
        if (kind === 'button' && text === 'Send a code via email') return located('#send-email', text, { tag: 'button' });
        return kind === 'link' ? self.links[text] ?? null : null;
      },
      click(selector) {
        self.clicked.push(selector);
        if (self.failClick.has(selector)) throw new Error(`agent-browser click refused: ${selector} detached`);
        if (selector === '#totp') self.view = 'authenticator';
        else if (selector === '#email-view') self.view = 'email';
        else if (selector === '#mobile') { self.granted = true; self.view = 'update'; }
        else if (selector === '#accept') self.accepted = true;
        else assert.fail(`the flow must not activate ${selector}`);
      },
      setChecked() { assert.fail('nothing is checked'); }, select() { assert.fail('nothing is selected'); },
      screenshot() {}, wait() {}, close() {},
      fill() { assert.fail('nothing is typed into Confirm access'); },
      markup() {
        if (self.view === 'update') return null;
        const html = self.markup[self.view];
        if (html === undefined) throw new Error('agent-browser eval failed: Execution context was destroyed');
        return html;
      },
    };
  }
  installation = async (): Promise<InstallationState> => {
    const { controlPlanePermissions } = await browser();
    const before = Object.fromEntries(Object.entries(controlPlanePermissions).map(([name, level]) => [name, name === 'contents' ? 'read' : level]));
    return { appId: 1234, installationId: 91011, slug: 'graphyard-owner-project', account: 'owner', accountType: 'User', installationUrl: 'https://github.com/settings/installations/91011', suspended: false,
      permissions: this.accepted ? { ...controlPlanePermissions } : before, app: { ...controlPlanePermissions } } as InstallationState;
  };
}

async function run(github: ConfirmAccessPage, root: string, config: Awaited<ReturnType<typeof master>>['config'], now = (() => { let tick = Date.parse('2026-10-07T12:00:00Z'); return () => new Date(tick += 1_000); })()) {
  const { runBrowserFlow } = await browser();
  const result = await runBrowserFlow(root, config, 'installation-accept', { page: github.page(), api: () => JSON.stringify({ login: 'operator-cli' }), installation: github.installation, coordinator: 'master', now, sleep: async () => {}, sudo: { pollMs: 10, timeoutMs: 600_000 } });
  const record = JSON.parse(await readFile(join(root, result.record, 'record.json'), 'utf8'));
  return { result, record, steps: record.steps as RecordedStep[] };
}
const captureSteps = (steps: RecordedStep[]) => steps.filter(step => step.action === 'sudo-form-capture').map(step => step.args);

test('unit:sudo-form-capture-redacted — each Confirm-access code view is captured, redacted, named in record.json, and the flow passes sudo as before', async () => {
  const { root, config, cleanup } = await master();
  try {
    const github = new ConfirmAccessPage();
    const { result, record, steps } = await run(github, root, config);
    assert.equal(result.outcome, 'applied'); assert.equal(github.accepted, true);
    assert.deepEqual(result.sudo, { attempts: 1, code: null }, 'sudo was passed through GitHub Mobile, the method the flow always used');
    assert.deepEqual(github.clicked, ['#totp', '#email-view', '#mobile', '#accept'], 'each view was opened by its link; nothing was sent, typed or verified');
    assert.ok(!github.clicked.includes('#send-email'));
    assert.ok(github.clicked.indexOf('#email-view') < github.clicked.indexOf('#mobile'), 'the forms were captured before the flow waited for any approval');
    assert.deepEqual(record.sudoForms, [
      { view: 'landing', file: 'sudo-form-landing.html', url: UPDATE },
      { view: 'authenticator', file: 'sudo-form-authenticator.html', url: UPDATE },
      { view: 'email', file: 'sudo-form-email.html', url: UPDATE },
    ]);
    assert.ok(!('sudoForms' in result), 'the audit ledger entry keeps its schema');
    const files = (await readdir(join(root, result.record))).filter(name => name.endsWith('.html')).sort();
    assert.deepEqual(files, ['sudo-form-authenticator.html', 'sudo-form-email.html', 'sudo-form-landing.html']);
    const { sudoFormRedaction } = await browser();
    for (const file of files) {
      const html = await readFile(join(root, result.record, file), 'utf8');
      for (const secret of SECRETS) assert.ok(!html.includes(secret), `${file} holds no session-bound value (${secret.split('-')[0]})`);
      assert.match(html, /^<form action="\/sessions\/sudo" accept-charset="UTF-8" method="post">/, `${file} keeps the form element`);
      assert.match(html, /<\/form>\n$/);
      assert.ok(html.includes(`<input type="hidden" name="authenticity_token" value="${sudoFormRedaction}" autocomplete="off" />`), `${file} keeps the token input, redacted`);
      assert.ok(html.includes(`<input type="hidden" name="timestamp_secret" value="${sudoFormRedaction}" />`));
    }
    const totp = await readFile(join(root, result.record, 'sudo-form-authenticator.html'), 'utf8');
    assert.ok(totp.includes('<label for="app_totp">Authentication code</label>'), 'the label stays');
    assert.ok(totp.includes(`<input type="text" name="app_otp" id="app_totp" autocomplete="one-time-code" inputmode="numeric" value="${sudoFormRedaction}" class="form-control" data-csrf-nonce="${sudoFormRedaction}">`), 'name, id, autocomplete and inputmode stay; the prefilled value and nonce attribute do not');
    assert.ok(totp.includes('<button type="submit" class="btn btn-primary">Verify</button>'));
    const email = await readFile(join(root, result.record, 'sudo-form-email.html'), 'utf8');
    assert.ok(email.includes(`<input type="password" name="email_otp" id="email_otp" autocomplete="one-time-code" value="${sudoFormRedaction}">`));
    const landing = await readFile(join(root, result.record, 'sudo-form-landing.html'), 'utf8');
    assert.ok(landing.includes(`<webauthn-get data-json="${sudoFormRedaction}">`), 'a session-bound passkey challenge is redacted');
    const recorded = await readFile(join(root, result.record, 'record.json'), 'utf8');
    for (const secret of SECRETS) assert.ok(!recorded.includes(secret), 'record.json holds no session-bound value either');
    assert.ok(steps.some(step => step.action === 'markup' && /^\d+ chars$/.test(step.result ?? '')), 'the markup step records only its length');
  } finally { await cleanup(); }
});

test('unit:sudo-form-capture-nonfatal — a missing form, an absent link, a page error or a spent budget is a recorded step and the flow completes', async () => {
  const { root, config, cleanup } = await master();
  try {
    // No form on the landing view, the authenticator link refuses its click (no href), no email view link.
    const broken = new ConfirmAccessPage();
    broken.markup.landing = null; broken.failClick.add('#totp'); broken.links['Use email'] = null;
    const first = await run(broken, root, config);
    assert.equal(first.result.outcome, 'applied'); assert.equal(broken.accepted, true);
    assert.deepEqual(first.result.sudo, { attempts: 1, code: null }, 'the flow used the method it always did');
    assert.deepEqual(first.record.sudoForms, []);
    assert.deepEqual(captureSteps(first.steps), [
      ['landing', 'failed: no Confirm-access form found'],
      ['authenticator', 'failed: agent-browser click refused: #totp detached'],
      ['email', 'failed: no email view link (only a control that sends a code, which is not followed)'],
    ]);
    assert.ok(!broken.clicked.includes('#send-email'), 'the control that emails a code is never used to reach the email view');

    // A page error while reading the markup (the eval throws), and a page that cannot read markup at all.
    const erroring = new ConfirmAccessPage();
    delete erroring.markup.authenticator;
    const second = await run(erroring, root, config);
    assert.equal(second.result.outcome, 'applied');
    assert.deepEqual(captureSteps(second.steps).map(([view, outcome]) => [view, outcome.startsWith('failed') ? outcome : 'kept']), [['landing', 'kept'], ['authenticator', 'failed: agent-browser eval failed: Execution context was destroyed'], ['email', 'kept']]);
    const blind = new ConfirmAccessPage();
    const blindPage = blind.page(); delete blindPage.markup;
    const { runBrowserFlow } = await browser();
    const third = await runBrowserFlow(root, config, 'installation-accept', { page: blindPage, api: () => '{}', installation: blind.installation, sleep: async () => {}, sudo: { pollMs: 10 } });
    assert.equal(third.outcome, 'applied');
    assert.deepEqual(captureSteps(JSON.parse(await readFile(join(root, third.record, 'record.json'), 'utf8')).steps), [['landing', 'failed: the page cannot read markup']]);

    // One bounded step: a capture that outlives its budget stops, and the flow proceeds.
    const { captureSudoForms, passSudo } = await browser();
    const slow = new ConfirmAccessPage();
    let clock = 0;
    const notes: string[][] = [];
    const slowPage = { ...slow.page(), wait: (ms: number) => { clock += ms * 40; }, note: (_action: string, args: string[]) => { notes.push(args); } };
    const directory = await temporaryDirectory('sudo-form-budget');
    try {
      const kept = await captureSudoForms(slowPage, directory, { now: () => new Date(clock), budgetMs: 30_000 });
      assert.deepEqual(kept.map(form => form.view), ['landing', 'authenticator']);
      assert.deepEqual(notes.at(-1), ['email', 'failed: capture budget of 30s spent']);
      assert.equal(slow.view, 'landing', 'the landing view is reopened after the capture');
    } finally { await rm(directory, { recursive: true, force: true }); }

    // The reopen of the landing view fails after a code view was opened: the capture retries it,
    // and when both of its tries fail the pass reopens it once more, so the flow still issues
    // GitHub Mobile from the landing view and completes.
    for (const failures of [1, 2]) {
      const stranded = new ConfirmAccessPage();
      stranded.failOpensFromEmail = failures;
      const restored = await run(stranded, root, config);
      assert.equal(restored.result.outcome, 'applied'); assert.equal(stranded.accepted, true);
      assert.deepEqual(restored.result.sudo, { attempts: 1, code: null }, `with ${failures} failed reopen(s) the flow passed sudo through GitHub Mobile`);
      assert.deepEqual(restored.record.sudoForms.map((form: { view: string }) => form.view), ['landing', 'authenticator', 'email']);
      assert.deepEqual(captureSteps(restored.steps).filter(([view]) => view === 'restore'), Array.from({ length: failures }, () => ['restore', 'failed: agent-browser open failed: net::ERR_CONNECTION_RESET']));
    }

    // A page that offers its email view only through a "Use email" link has that view captured too.
    const linkOnly = new ConfirmAccessPage();
    linkOnly.landingText = LANDING_TEXT.replace('\nSend a code via email', '\nUse email');
    const linkDirectory = await temporaryDirectory('sudo-form-link');
    try {
      const kept = await captureSudoForms(linkOnly.page(), linkDirectory);
      assert.deepEqual(kept.map(form => form.view), ['landing', 'authenticator', 'email']);
      assert.equal(linkOnly.view, 'landing');
    } finally { await rm(linkDirectory, { recursive: true, force: true }); }

    // A capture that throws outright is recorded and the wait proceeds unchanged.
    const throwing = new ConfirmAccessPage();
    const steps: RecordedStep[] = [];
    const { recordingPage } = await browser();
    const page = recordingPage(throwing.page(), { directory: root, steps, now: () => new Date() });
    page.open(UPDATE);
    const passed = await passSudo(page, { flow: 'installation-accept', record: 'r', onCode: () => {}, sleep: async () => {}, pollMs: 10, capture: () => { throw new Error('disk full'); } });
    assert.deepEqual(passed, { passed: false, attempts: 1, code: null }, 'GitHub Mobile was issued exactly as without a capture');
    assert.deepEqual(captureSteps(steps), [['all', 'failed: disk full']]);
  } finally { await cleanup(); }
});
