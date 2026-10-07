import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import type { BrowserPage, Located, RecordedStep, SudoMethod, SudoState } from '../src/master-browser.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1450: GitHub's Confirm access during `graphyard up` no longer depends on a passkey the
 * headless profile copy cannot use, or on a GitHub Mobile push.
 *
 * unit:sudo-shared-session-continue — a recorded page sequence: the flow hands off with a first line
 * naming a sudo-protected page to confirm on once in the operator's own Chrome, re-checks every 10 s,
 * and continues as soon as a reload no longer shows Confirm access; the App drive then submits its
 * manifest again, since the reload dropped it.
 *
 * unit:sudo-code-entry — a recorded authenticator-code page: the handoff lists every method the page
 * offers, a code handed over with `graphyard up --sudo-code` or the local App page is typed into the
 * page, and the code appears in no recorded step, handoff, output or file left behind.
 *
 * unit:sudo-message-method — timeout and handoff messages name the method the page offered, and say
 * "GitHub Mobile" only once a Mobile prompt was issued.
 */

// Loaded per test, so on a base without this change each case fails on its own assertion.
const browser = () => import('../src/master-browser.js');
const CODE = '123456';
const NEW_APP = 'https://github.com/settings/apps/new';
const LOCAL = 'http://127.0.0.1:4311';
const FIRST_LINE = `Confirm access once in your own Chrome at ${NEW_APP} with your passkey or password: GitHub then holds sudo mode for the session the agent's browser shares, and the flow continues by itself within 10 s`;
// What the pilot's headless profile copy was shown (2026-10-07).
const PASSKEY_PAGE = 'Skip to content\nConfirm access\n\nSigned in as @operator\n\nPasskey\nWhen you are ready, authenticate using the button below.\nUse passkey\nHaving problems?\nUse GitHub Mobile\nUse your authenticator app\nSend a code via email';
const TOTP_PAGE = 'Confirm access\n\nAuthentication code\nOpen your two-factor authenticator (TOTP) app or browser extension to view your authentication code.\nVerify\nHaving problems?\nUse passkey\nUse GitHub Mobile\nSend a code via email';
const EMAIL_PAGE = 'Confirm access\n\nEmail code\nWe sent a code to your email address.\nVerify\nHaving problems?\nUse passkey\nUse GitHub Mobile\nUse your authenticator app';
const located = (selector: string, text: string, extra: Partial<Located> = {}): Located => ({ selector, tag: 'button', checked: null, value: null, text, visible: true, ...extra });
const noop = { meta: () => null, setChecked() {}, select() {}, screenshot() {}, wait() {}, close() {} };
const methodSteps = (steps: RecordedStep[]) => steps.filter(step => step.action.startsWith('sudo-')).map(step => [step.action, ...step.args]);

test('unit:sudo-shared-session-continue — a recorded page sequence: the flow re-checks every 10 s and continues once a reload no longer asks to confirm access', async () => {
  const { passSudo, recordingPage } = await browser();
  // Each reload reads the next recorded render; the fourth is the page itself: sudo mode was granted elsewhere.
  const renders = [PASSKEY_PAGE, PASSKEY_PAGE, PASSKEY_PAGE, PASSKEY_PAGE, 'Register new GitHub App\nGitHub App name'];
  let render = 0, clock = 0;
  const reloads: number[] = [], clicked: string[] = [];
  const fake: BrowserPage = { ...noop,
    open(url) { assert.equal(url, NEW_APP); reloads.push(clock); render += 1; },
    url: () => NEW_APP, text: () => renders[render],
    locate: (kind, text) => text === 'Use GitHub Mobile' ? located('#mobile', text, { tag: 'a', href: 'https://github.com/sessions/sudo?mobile=1' }) : null,
    click(selector) { clicked.push(selector); },
  };
  const steps: RecordedStep[] = [];
  const page = recordingPage(fake, { directory: '/nonexistent-record', steps, now: () => new Date(clock) });
  const handed: SudoState[] = [];
  const result = await passSudo(page, { flow: 'installation-accept', record: 'graphyard up', prefer: 'passkey-or-password', now: () => new Date(clock), onCode: state => { handed.push(state); }, sleep: async ms => { clock += ms; }, timeoutMs: 600_000 });
  assert.deepEqual(result, { passed: true, attempts: 0, code: null }, 'the flow continued once the page stopped demanding confirmation');
  assert.deepEqual(clicked, [], 'GitHub Mobile was never triggered');
  assert.equal(reloads.length, 4);
  assert.ok(reloads[0] >= 10_000 && reloads[0] < 13_000, `first re-check at ${reloads[0]} ms`);
  for (let index = 1; index < reloads.length; index += 1) { const gap = reloads[index] - reloads[index - 1]; assert.ok(gap >= 10_000 && gap < 13_000, `re-check every 10 s, not ${gap} ms`); }
  assert.equal(handed.length, 1);
  const { sudoInstruction } = await browser();
  assert.equal(sudoInstruction(handed[0]).split('\n')[0], FIRST_LINE, 'the first line: confirm once in your own Chrome on a named sudo-protected page with a passkey or password');
  assert.deepEqual(methodSteps(steps), [['sudo-method', 'passkey']]);
});

test('unit:sudo-shared-session-continue — the App drive submits its manifest again once access is confirmed on a reloaded page', async () => {
  const { browserAppDriver } = await import('../src/up.js');
  let view: 'local' | 'sudo' | 'form' | 'manifest' | 'installed-local' | 'install' | 'done' = 'local';
  let granted = false, reloads = 0, clock = 0;
  const clicked: string[] = [];
  const page: BrowserPage = { ...noop,
    open(url) {
      if (url === LOCAL) view = view === 'done' ? 'installed-local' : 'local';
      else if (url === NEW_APP) { reloads += 1; if (reloads >= 2) { granted = true; view = 'form'; } }
      else if (url.includes('/installations/new/permissions')) view = 'install';
    },
    url: () => view === 'sudo' || view === 'form' || view === 'manifest' ? NEW_APP : view === 'install' ? 'https://github.com/apps/graphyard-acme-shop/installations/new/permissions' : LOCAL,
    text: () => view === 'sudo' ? PASSKEY_PAGE : view === 'form' ? 'Register new GitHub App\nCreate GitHub App' : view === 'manifest' ? 'Create GitHub App for acme' : '',
    locate(kind, text) {
      if (view === 'local' && kind === 'button' && text === 'Register Graphyard App →') return located('#register', text);
      if (view === 'manifest' && kind === 'button' && text === 'Create GitHub App for acme') return located('#create', text);
      if (view === 'installed-local' && kind === 'link' && text === 'Install GitHub App') return located('#install-link', text, { tag: 'a', href: 'https://github.com/apps/graphyard-acme-shop/installations/new' });
      if (view === 'install' && kind === 'button' && text === 'Install') return located('#install', text);
      return null;
    },
    click(selector) {
      clicked.push(selector);
      if (selector === '#register') view = granted ? 'manifest' : 'sudo';
      if (selector === '#create') view = 'done';
    },
  };
  const handed: string[] = [];
  const drive = browserAppDriver({ page, repository: 'acme/shop', ids: () => ({ owner: 11, repository: 22 }), now: () => new Date(clock), sleep: async ms => { clock += ms; }, readCode: () => null });
  assert.deepEqual(await drive(LOCAL, sentence => { handed.push(sentence); }), { state: 'done' });
  assert.deepEqual(clicked, ['#register', '#register', '#create', '#install'], 'the manifest was submitted again after the reload, then the App created and installed');
  assert.equal(handed.length, 1); assert.equal(handed[0].split('\n')[0], FIRST_LINE);
});

/** GitHub's Confirm-access page with its authenticator and email views; `typed` is what reached the code field. */
function codePage() {
  const state = { view: 'passkey' as 'passkey' | 'totp' | 'email' | 'done', typed: [] as string[], clicked: [] as string[] };
  const page: BrowserPage = { ...noop,
    open() {}, url: () => state.view === 'done' ? NEW_APP : 'https://github.com/sessions/sudo',
    text: () => ({ passkey: PASSKEY_PAGE, totp: TOTP_PAGE, email: EMAIL_PAGE, done: 'Register new GitHub App' })[state.view],
    locate(kind, text) {
      if (state.view === 'done') return null;
      if (kind === 'link' && text === 'Use your authenticator app' && state.view !== 'totp') return located('#totp-link', text, { tag: 'a', href: 'https://github.com/sessions/sudo?type=app' });
      if (kind === 'button' && text === 'Send a code via email' && state.view !== 'email') return located('#email-send', text);
      if (kind === 'field' && text === 'app_otp' && state.view === 'totp') return located('#app_otp', '', { tag: 'input', value: '' });
      if (kind === 'field' && text === 'email_otp' && state.view === 'email') return located('#email_otp', '', { tag: 'input', value: '' });
      if (kind === 'button' && text === 'Verify' && state.view !== 'passkey') return located('#verify', text);
      return null;
    },
    click(selector) {
      state.clicked.push(selector);
      if (selector === '#totp-link') state.view = 'totp';
      if (selector === '#email-send') state.view = 'email';
      if (selector === '#verify' && state.typed.at(-1) && /^\d{6}$/.test(state.typed.at(-1)!)) state.view = 'done';
    },
    fill(selector, value) { assert.ok(selector === '#app_otp' || selector === '#email_otp'); state.typed.push(value); },
  };
  return { page, state };
}

test('unit:sudo-code-entry — an authenticator code handed with graphyard up --sudo-code is typed into the recorded page, and never logged', async () => {
  const { passSudo, recordingPage, sudoInstruction, takeSudoCode } = await browser();
  const { installCommands } = await import('../src/cli/install.js');
  const root = await temporaryDirectory('sudo-code-entry');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const fake = codePage();
  const steps: RecordedStep[] = [];
  const page = recordingPage(fake.page, { directory: '/nonexistent-record', steps, now: () => new Date(0) });
  const up = installCommands.find(command => command.name === 'up')!;
  const printed: unknown[] = [], output: string[] = [];
  const handed: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...args: unknown[]) => { output.push(args.join(' ')); }; console.error = (...args: unknown[]) => { output.push(args.join(' ')); };
  try {
    const result = await passSudo(page, { flow: 'installation-accept', record: 'graphyard up', prefer: 'passkey-or-password', timeoutMs: 600_000, pollMs: 10,
      readCode: () => takeSudoCode(root),
      onCode: async state => {
        handed.push(sudoInstruction(state, 'your phone', { page: LOCAL, command: 'graphyard up --sudo-code' }));
        // The agent reads the handoff and hands the code over, as `graphyard up --sudo-code CODE`.
        if (handed.length === 1) await up.run({ command: 'up', id: '--sudo-code', args: [CODE], rest: ['--sudo-code', CODE], repositoryRoot: () => root, print: (value: unknown) => { printed.push(value); } } as any, undefined as any);
      },
      sleep: async () => {} });
    assert.deepEqual(result, { passed: true, attempts: 0, code: null });
  } finally { console.log = log; console.error = error; }
  assert.deepEqual(fake.state.typed, [CODE], 'the code was typed into the authenticator field');
  assert.deepEqual(fake.state.clicked, ['#totp-link', '#verify'], 'the authenticator view was opened, the code entered and verified');
  assert.equal(handed.length, 1);
  const lines = handed[0].split('\n');
  assert.equal(lines[0], FIRST_LINE);
  assert.equal(lines[1], "GitHub's Confirm-access page (https://github.com/sessions/sudo) offers: passkey, authenticator app, email code, Mobile", 'every method the page offers is listed');
  assert.equal(lines[2], `For your authenticator app, enter its 6-digit code at ${LOCAL} or with graphyard up --sudo-code CODE`);
  assert.match(lines[3], /^For an email code, ask for it at http:\/\/127\.0\.0\.1:4311 or with graphyard up --sudo-code email, then enter its 6 digits/);
  assert.deepEqual(methodSteps(steps), [['sudo-method', 'passkey'], ['sudo-code', 'authenticator', 'entered'], ['sudo-method', 'authenticator']]);
  assert.deepEqual(steps.find(step => step.action === 'fill')?.args, ['#app_otp', '[code withheld]']);
  for (const [what, value] of [['recorded steps', steps], ['handoffs', handed], ['printed answer', printed], ['console output', output]] as const) assert.ok(!JSON.stringify(value).includes(CODE), `the code never appears in the ${what}`);
  assert.deepEqual(await readdir(`${root}/.graphyard/master-actions`), [], 'the handed code is taken once, leaving no file behind');
  await assert.rejects(up.run({ command: 'up', id: '--sudo-code', args: ['12345'], rest: [], repositoryRoot: () => root, print: () => {} } as any, undefined as any), /6 digits/);
});

test('unit:sudo-code-entry — an email code is requested, then typed into the email view; the local App page hands codes over without echoing them', async () => {
  const { passSudo, sudoInstruction, submitSudoCode, takeSudoCode } = await browser();
  const { startGithubSetup } = await import('../src/github-setup.js');
  const root = await temporaryDirectory('sudo-code-page');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const setup = await startGithubSetup(root, 'acme/shop', 'http://127.0.0.1:4320', 0);
  try {
    const home = await (await fetch(setup.url)).text();
    assert.match(home, /GitHub asking to confirm access\?/); assert.match(home, /action="\/sudo-code"/);
    const state = home.match(/name="state" value="([a-f0-9]+)"/)![1];
    const post = (body: Record<string, string>) => fetch(`${setup.url}/sudo-code`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    assert.equal((await post({ state: 'wrong', code: CODE })).status, 409);
    const refused = await post({ state, code: '12' });
    assert.equal(refused.status, 400); assert.match(await refused.text(), /6 digits/);
    const accepted = await post({ state, code: CODE });
    assert.equal(accepted.status, 200); assert.doesNotMatch(await accepted.text(), new RegExp(CODE));
    assert.equal((await stat(`${root}/.graphyard/master-actions/sudo-code.json`)).mode & 0o777, 0o600, 'the handed code is private to the operator');
    const taken = await takeSudoCode(root);
    assert.equal(taken?.kind === 'code' ? taken.code : null, CODE, 'the page handed the code over');
    assert.equal(await takeSudoCode(root), null, 'a handed code is taken once');
  } finally { await new Promise<void>(accept => setup.http.close(() => accept())); }

  const fake = codePage();
  const handed: string[] = [];
  const result = await passSudo(fake.page, { flow: 'installation-accept', record: 'graphyard up', prefer: 'passkey-or-password', timeoutMs: 600_000, pollMs: 10,
    readCode: () => takeSudoCode(root),
    onCode: async state => {
      handed.push(sudoInstruction(state, 'your phone', { page: LOCAL, command: 'graphyard up --sudo-code' }));
      if (handed.length === 1) await submitSudoCode(root, 'email');
      else await submitSudoCode(root, '654321');
    },
    sleep: async () => {} });
  assert.deepEqual(result, { passed: true, attempts: 0, code: null });
  assert.deepEqual(fake.state.clicked, ['#email-send', '#verify'], 'GitHub was asked to email a code, which was then entered');
  assert.deepEqual(fake.state.typed, ['654321']);
  assert.match(handed[1], new RegExp(`GitHub emailed you a code: enter its 6 digits at ${LOCAL.replace(/\./g, '\\.')} or with graphyard up --sudo-code CODE`));
  assert.ok(!handed.join('\n').includes('654321'));
});

test('unit:sudo-message-method — handoff and timeout messages name the method the page offered, and GitHub Mobile only once its prompt was issued', async () => {
  const { passSudo, sudoInstruction, sudoTimeout } = await browser();
  const named: Record<Exclude<SudoMethod, 'mobile'>, RegExp> = { passkey: /your passkey/, password: /your password/, authenticator: /your authenticator app/, email: /your email code/ };
  for (const [method, pattern] of Object.entries(named) as [Exclude<SudoMethod, 'mobile'>, RegExp][]) {
    const state = { code: null, method, offered: [method, 'mobile'] as SudoMethod[] };
    const timeout = sudoTimeout(state, [], 600_000, 'installation-accept');
    assert.match(timeout, /^Confirm access was not approved within 600s; confirm access with /, method);
    assert.match(timeout, pattern, `${method}: the timeout names the method offered`);
    assert.doesNotMatch(timeout, /GitHub Mobile/, `${method}: no Mobile prompt was issued`);
    const instruction = sudoInstruction({ ...state, url: 'https://github.com/sessions/sudo' }, 'your phone', { page: LOCAL, command: 'graphyard up --sudo-code' });
    assert.doesNotMatch(instruction, /GitHub Mobile/, `${method}: the handoff never names a prompt that was not issued`);
    assert.match(instruction.split('\n')[1], new RegExp(`offers: ${{ passkey: 'passkey', password: 'password', authenticator: 'authenticator app', email: 'email code' }[method]}, Mobile$`));
  }
  assert.equal(sudoTimeout({ code: null, method: 'passkey', offered: ['passkey', 'authenticator', 'email', 'mobile'] }, [], 600_000, 'installation-accept'),
    `Confirm access was not approved within 600s; confirm access with your passkey, authenticator app or email code, or once in your own Chrome at ${NEW_APP}, and rerun master browser installation-accept`);
  // A Mobile prompt that was issued is named as one.
  assert.equal(sudoTimeout({ code: '64', method: 'mobile' }, ['passkey', 'mobile'], 600_000, 'protection'), 'Confirm access was not approved within 600s; approve the GitHub Mobile prompt (code 64) and rerun master browser protection');
  assert.equal(sudoInstruction({ code: '64', method: 'mobile' }), 'Approve the GitHub Mobile prompt on your phone and choose 64');

  // The pilot's page, unanswered: the timeout names what it offered, never the Mobile prompt nobody was sent.
  let clock = 0;
  const fake = codePage();
  await assert.rejects(passSudo(fake.page, { flow: 'installation-accept', record: 'r', prefer: 'passkey-or-password', now: () => new Date(clock), onCode: () => {}, sleep: async ms => { clock += ms; }, timeoutMs: 600_000 }),
    (failure: Error) => { assert.match(failure.message, /not approved within 600s; confirm access with your passkey, authenticator app or email code/); assert.doesNotMatch(failure.message, /GitHub Mobile/); return true; });
});
