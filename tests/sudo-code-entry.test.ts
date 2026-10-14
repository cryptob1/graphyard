import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
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

/**
 * GitHub's Confirm-access page with its authenticator and email views; `typed` is what reached the
 * code field, `field` what it shows now (a refused code stays in it, as on GitHub's error page), and
 * `shots` what the field showed at each screenshot.
 */
function codePage(refused: readonly string[] = []) {
  const state = { view: 'passkey' as 'passkey' | 'totp' | 'email' | 'done', typed: [] as string[], clicked: [] as string[], field: '', shots: [] as string[] };
  const page: BrowserPage = { ...noop,
    screenshot() { state.shots.push(state.field); },
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
      if (selector === '#totp-link') { state.view = 'totp'; state.field = ''; }
      if (selector === '#email-send') { state.view = 'email'; state.field = ''; }
      if (selector === '#verify' && /^\d{6}$/.test(state.field) && !refused.includes(state.field)) { state.view = 'done'; state.field = ''; }
    },
    fill(selector, value) { assert.ok(selector === '#app_otp' || selector === '#email_otp'); state.field = value; if (value) state.typed.push(value); },
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

test('unit:sudo-code-entry — no screenshot is recorded while the code field holds a code, whether GitHub accepts the code or refuses it', async () => {
  const { passSudo, recordingPage } = await browser();
  const WRONG = '000000';
  for (const codes of [[CODE], [WRONG, CODE]]) {
    const fake = codePage([WRONG]);
    const steps: RecordedStep[] = [];
    let clock = 0;
    const page = recordingPage(fake.page, { directory: '/nonexistent-record', steps, now: () => new Date(clock) });
    const queue = codes.map(code => ({ kind: 'code' as const, code, at: new Date(0).toISOString() }));
    const result = await passSudo(page, { flow: 'installation-accept', record: 'graphyard up', prefer: 'passkey-or-password', timeoutMs: 600_000, pollMs: 1_000, now: () => new Date(clock),
      // After a refused code, the next is handed only once a re-check reload has screenshot the page.
      readCode: () => !fake.state.typed.length || steps.some(step => step.action === 'open' && step.screenshot) ? queue.shift() ?? null : null,
      onCode: () => {}, sleep: async ms => { clock += ms; } });
    assert.deepEqual(result, { passed: true, attempts: 0, code: null }, codes.join(' then '));
    assert.deepEqual(fake.state.typed, codes, 'every handed code was typed');
    assert.ok(fake.state.shots.length >= 1, 'the flow still screenshots the page');
    assert.deepEqual(fake.state.shots.filter(Boolean), [], `${codes.join(' then ')}: no screenshot showed a code in the field`);
    const verify = steps.filter(step => step.action === 'click' && step.args[0] === '#verify');
    assert.equal(verify.length, codes.length);
    for (const click of verify) assert.equal(click.screenshot, null, 'the click submitting a code is recorded without a screenshot');
    assert.ok(!JSON.stringify(steps).includes(CODE) && !JSON.stringify(steps).includes(WRONG), 'no recorded step holds a code');
    if (codes.length > 1) {
      assert.ok(steps.some(step => step.action === 'open' && step.screenshot), 'the re-check after the refused code was screenshot, with the field cleared');
      assert.deepEqual(steps.filter(step => step.action === 'fill').map(step => step.args), [['#app_otp', '[code withheld]'], ['#app_otp', ''], ['#app_otp', '[code withheld]']], 'the refused code was cleared from the field');
    }
  }
});

/**
 * GY-1457: setup no longer depends on a live Confirm-access moment.
 *
 * unit:sudo-wait-matches-up — agent mode's Confirm-access wait is up's own wait (20 minutes, or
 * --wait), so a recorded page confirmed after 700 s still finishes; a rerun resumes the pending
 * confirmation without a new handoff.
 *
 * unit:sudo-handoff-profile-mode — the handoff says whether the drive shares the live Chrome
 * session; the own-Chrome route only when it does, otherwise the code methods the page offers, or,
 * when it offers none, what does reach a copy.
 *
 * unit:sudo-offers-import-route — the handoff and the local App setup page offer the App-import
 * route for both Apps as runnable commands, and `up --no-wait` exits with it instead of waiting.
 */
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const IMPORT_ROUTE = (up: string) => new RegExp(escapeRegExp('create the App at github.com/settings/apps/new whenever convenient, once for the control plane and once for the reviewer: '
  + 'give the control-plane App the Repository permissions Actions: write, Administration: read, Checks: write, Contents: write, Deployments: read, Issues: read, Metadata: read, Pull requests: write, workflows: write, '
  + 'subscribe it to pull_request, pull_request_review, issue_comment, check_run, check_suite, push and leave its webhook URL empty (setup points it at this install); '
  + 'give the reviewer App exactly Contents: read, Issues: read, Metadata: read, Pull requests: write and nothing more; '
  + 'install each on acme from its github.com/apps/SLUG/installations/new page with acme/shop selected; '
  + 'import each with `graphyard app import --app-id ID --key-file PEM --role control-plane --repo acme/shop` and `graphyard app import --app-id ID --key-file PEM --role reviewer --repo acme/shop`, '
  + `then run \`graphyard up --reuse-app SLUG --reuse-app REVIEWER_SLUG --repo acme/shop${up}\``));
/** The up command a route names, as up parses it: it must run as written, reusing both Apps. */
const routeUp = (text: string) => text.match(/`graphyard up ([^`]+)`/)![1].split(' ');
/** The local App page, then GitHub's Confirm access until the clock reaches GRANTAT, then the new-App form; no install link, so no repository ids are read. */
function appDrivePage(clock: { t: number }, grantAt: number) {
  let view: 'local' | 'sudo' | 'form' | 'manifest' | 'done' = 'local';
  const granted = () => clock.t >= grantAt;
  const page: BrowserPage = { ...noop,
    open(url) { if (url === LOCAL) view = view === 'done' ? 'done' : 'local'; else if (url === NEW_APP && view === 'sudo' && granted()) view = 'form'; },
    url: () => view === 'local' || view === 'done' ? LOCAL : NEW_APP,
    text: () => view === 'sudo' ? PASSKEY_PAGE : view === 'form' ? 'Register new GitHub App' : view === 'manifest' ? 'Create GitHub App for acme' : '',
    locate(kind, text) {
      if (view === 'local' && kind === 'button' && text === 'Register Graphyard App →') return located('#register', text);
      if (view === 'manifest' && kind === 'button' && text === 'Create GitHub App for acme') return located('#create', text);
      return null;
    },
    click(selector) { if (selector === '#register') view = granted() ? 'manifest' : 'sudo'; if (selector === '#create') view = 'done'; },
  };
  return page;
}
const upRequest = async (...extra: string[]) => (await import('../src/up.js')).upRequestFromArgs(['--repo', 'acme/shop', '--agent', ...extra]);

test('unit:sudo-wait-matches-up — the drive waits at Confirm access as long as up does, past 600 s, and a rerun resumes the pending confirmation without a new handoff', async () => {
  const { recordedAppDriver, upWaitMs, upRequestFromArgs, readPendingSudo, rememberPendingSudo } = await import('../src/up.js');
  assert.equal(upWaitMs(await upRequest()), 1_200_000, "agent mode's wait on a person is 20 minutes");
  assert.equal(upWaitMs(await upRequest('--wait', '45')), 2_700_000, '--wait MINUTES sets it');
  assert.throws(() => upRequestFromArgs(['--repo', 'acme/shop', '--wait', '0']), /whole minutes/);

  const root = await temporaryDirectory('sudo-wait-up');
  const clock = { t: 0 };
  const timing = { now: () => new Date(clock.t), sleep: async (ms: number) => { clock.t += ms; } };
  const handed: string[] = [];
  const confirmedAt = 700_000;
  const { drive } = recordedAppDriver(root, await upRequest(), { profile: 'Default' }, () => appDrivePage(clock, confirmedAt), timing);
  assert.deepEqual(await drive(LOCAL, sentence => { handed.push(sentence); }), { state: 'done' }, 'confirmed after 700 s, the drive finished instead of giving up at 600 s');
  assert.ok(clock.t >= confirmedAt, `the drive was still waiting at ${clock.t} ms`);
  assert.equal(handed.length, 1);
  assert.equal(await readPendingSudo(root), null, 'an approved confirmation leaves nothing pending');

  // A run whose wait (--wait 1) ends first leaves the confirmation pending; the rerun resumes it.
  const rerunRoot = await temporaryDirectory('sudo-wait-rerun');
  const first: string[] = [];
  const short = recordedAppDriver(rerunRoot, await upRequest('--wait', '1'), { profile: 'Default' }, () => appDrivePage(clock, Infinity), timing);
  const gaveUp = await short.drive(LOCAL, sentence => { first.push(sentence); });
  assert.equal(gaveUp.state, 'failed');
  assert.match(gaveUp.state === 'failed' ? gaveUp.reason : '', /not approved within 60s.*rerun graphyard up --repo acme\/shop --provider compose --agent/);
  assert.doesNotMatch(gaveUp.state === 'failed' ? gaveUp.reason : '', /own Chrome/, 'a copied profile\'s timeout never offers the confirmation that cannot reach it');
  assert.equal(first.length, 1);
  const pending = await readPendingSudo(rerunRoot);
  assert.equal(pending?.method, 'passkey', 'the handed-off confirmation is kept for the rerun');
  // A later up from the same checkout for another repository never resumes it: it hands off its own confirmation.
  assert.equal(await readPendingSudo(rerunRoot, { repository: 'acme/other', provider: 'compose', browserProfile: 'Default' }), null);
  assert.equal(await readPendingSudo(rerunRoot, { repository: 'acme/shop', provider: 'railway', browserProfile: 'Default' }), null);
  const other: string[] = [], otherNotes: string[] = [];
  const otherRun = recordedAppDriver(rerunRoot, upRequestFromArgs(['--repo', 'acme/other', '--agent', '--wait', '1']), { profile: 'Default' }, () => appDrivePage(clock, Infinity), { ...timing, emit: event => { if (event.kind === 'note') otherNotes.push(event.text); } });
  assert.equal((await otherRun.drive(LOCAL, sentence => { other.push(sentence); })).state, 'failed');
  assert.equal(other.length, 1, "another repository's run issues its own handoff");
  assert.match(other[0], /--repo acme\/other/, 'naming its own repository');
  assert.deepEqual(otherNotes, [], 'and resumes nothing');
  // Restore this repository's pending confirmation for the resume below.
  await rememberPendingSudo(rerunRoot, pending, { repository: 'acme/shop', provider: 'compose', browserProfile: 'Default' });
  // A rerun that drives another browser profile gets the handoff for that profile, not the old one's.
  assert.equal(await readPendingSudo(rerunRoot, { repository: 'acme/shop', provider: 'compose', browserProfile: '/home/operator/.config/google-chrome' }), null);
  const switched: string[] = [], switchedNotes: string[] = [];
  const switchedRun = recordedAppDriver(rerunRoot, await upRequest('--wait', '1'), { profile: '/home/operator/.config/google-chrome' }, () => appDrivePage(clock, Infinity), { ...timing, emit: event => { if (event.kind === 'note') switchedNotes.push(event.text); } });
  assert.equal((await switchedRun.drive(LOCAL, sentence => { switched.push(sentence); })).state, 'failed');
  assert.equal(switched.length, 1, 'a rerun on another profile issues its own handoff');
  assert.match(switched[0], /^The drive uses your live Chrome session \(profile \/home\/operator\/\.config\/google-chrome\)/, "naming that profile's sharing");
  assert.deepEqual(switchedNotes, [], 'and resumes nothing');
  await rememberPendingSudo(rerunRoot, pending, { repository: 'acme/shop', provider: 'compose', browserProfile: 'Default' });
  const second: string[] = [], notes: string[] = [];
  const resumeAt = clock.t + 300_000;
  const rerun = recordedAppDriver(rerunRoot, await upRequest(), { profile: 'Default' }, () => appDrivePage(clock, resumeAt), { ...timing, emit: event => { if (event.kind === 'note') notes.push(event.text); } });
  assert.deepEqual(await rerun.drive(LOCAL, sentence => { second.push(sentence); }), { state: 'done' });
  assert.deepEqual(second, [], 'the rerun issued no new handoff');
  assert.equal(notes.length, 1); assert.match(notes[0], new RegExp(`^Resuming the Confirm access handed off at ${pending!.issuedAt}`));
  assert.equal(await readPendingSudo(rerunRoot), null);
});

test('unit:sudo-handoff-profile-mode — the handoff says whether the drive shares the live Chrome session, and offers confirming in your own Chrome only when it does', async () => {
  const { browserProfileMode, sudoInstruction } = await browser();
  assert.equal(browserProfileMode('Default'), 'copy', 'a profile named by its name is opened as a copy');
  assert.equal(browserProfileMode('/home/operator/.config/google-chrome'), 'shared', 'a profile directory named by its path is opened as itself');
  const state = { code: null, method: 'passkey' as const, url: 'https://github.com/sessions/sudo', offered: ['passkey', 'authenticator', 'email'] as SudoMethod[] };
  const route = { page: LOCAL, command: 'graphyard up --sudo-code' };
  const shared = sudoInstruction(state, 'your phone', { ...route, profile: { mode: 'shared', name: '/home/operator/chrome' } }).split('\n');
  assert.equal(shared[0], 'The drive uses your live Chrome session (profile /home/operator/chrome), so a confirmation in your own Chrome reaches it');
  assert.equal(shared[1], FIRST_LINE, 'shared: confirming in your own Chrome is offered');
  const copy = sudoInstruction(state, 'your phone', { ...route, profile: { mode: 'copy', name: 'Default' } }).split('\n');
  assert.equal(copy[0], 'The drive runs on a copy of your Chrome profile Default, not your live session, so a confirmation in your own Chrome does not reach it: use a code below');
  assert.ok(!copy.some(line => /in your own Chrome at/.test(line)), 'copy: confirming in your own Chrome is not offered');
  assert.ok(copy.includes(`For your authenticator app, enter its 6-digit code at ${LOCAL} or with graphyard up --sudo-code CODE`), 'copy: the authenticator code is offered');
  assert.ok(copy.some(line => line.startsWith('For an email code, ask for it')), 'copy: the email code is offered');

  // Only the code methods the page offers are listed: passSudo can type nothing else.
  const authenticatorOnly = sudoInstruction({ ...state, offered: ['passkey', 'authenticator'] }, 'your phone', { ...route, profile: { mode: 'copy', name: 'Default' } }).split('\n');
  assert.ok(authenticatorOnly.some(line => line.startsWith('For your authenticator app')));
  assert.ok(!authenticatorOnly.some(line => /email code, ask for it/.test(line)), 'an email code the page does not offer is not');
  // A passkey-only page on a copy: no code reaches the drive, and the handoff says so and names what does.
  const passkeyOnly = sudoInstruction({ ...state, offered: ['passkey'] }, 'your phone', { ...route, profile: { mode: 'copy', name: 'Default' } }).split('\n');
  assert.equal(passkeyOnly[0], "The drive runs on a copy of your Chrome profile Default, not your live session, so a confirmation in your own Chrome does not reach it: none of the page's methods reaches the drive: pass --browser-profile a Chrome profile directory path to share your live session, or take the App-import route");
  assert.ok(!passkeyOnly.some(line => /^For (your authenticator|an email code)/.test(line)), 'no code method is invented');
  assert.ok(!passkeyOnly.some(line => /in your own Chrome at/.test(line)));
  const withMobile = sudoInstruction({ ...state, offered: ['passkey', 'mobile'] }, 'your phone', { ...route, profile: { mode: 'copy', name: 'Default' } }).split('\n');
  assert.match(withMobile[0], /none of the page's methods reaches the drive: rerun with --github-mobile to approve a GitHub Mobile prompt, /, 'Mobile is named when the page offers it');

  // The drive names its own profile's mode.
  const { recordedAppDriver } = await import('../src/up.js');
  for (const [profile, said] of [['Default', /^The drive runs on a copy of your Chrome profile Default/], ['/home/operator/chrome', /^The drive uses your live Chrome session/]] as const) {
    const clock = { t: 0 }, handed: string[] = [];
    const { drive } = recordedAppDriver(await temporaryDirectory('sudo-profile-mode'), await upRequest(), { profile }, () => appDrivePage(clock, 30_000), { now: () => new Date(clock.t), sleep: async ms => { clock.t += ms; } });
    assert.deepEqual(await drive(LOCAL, sentence => { handed.push(sentence); }), { state: 'done' });
    assert.match(handed[0], said, profile);
  }
});

test('unit:sudo-offers-import-route — the handoff and the local setup page offer the App-import route, and up --no-wait exits with it instead of waiting', async () => {
  const { recordedAppDriver, runUp, upRequestFromArgs } = await import('../src/up.js');
  const clock = { t: 0 };
  const timing = { now: () => new Date(clock.t), sleep: async (ms: number) => { clock.t += ms; } };
  const handed: string[] = [];
  const { drive } = recordedAppDriver(await temporaryDirectory('sudo-import-route'), await upRequest(), { profile: 'Default' }, () => appDrivePage(clock, 30_000), timing);
  assert.deepEqual(await drive(LOCAL, sentence => { handed.push(sentence); }), { state: 'done' });
  const handedRoute = handed[0].split('\n').at(-1)!;
  assert.match(handedRoute, IMPORT_ROUTE(' --provider compose --agent'), 'the handoff ends with the route that needs no live moment');
  const routed = upRequestFromArgs(routeUp(handedRoute));
  assert.deepEqual({ repository: routed.repository, provider: routed.provider, agent: routed.agent, reuseApps: routed.reuseApps }, { repository: 'acme/shop', provider: 'compose', agent: true, reuseApps: ['SLUG', 'REVIEWER_SLUG'] }, 'the route runs as written, reusing both Apps');
  // The route and the rerun carry every option the operator set up with, not only the provider and --agent.
  const custom: string[] = [];
  const options = ['--provider', 'hetzner', '--reviewer', 'codex', '--master', 'codex', '--goal', 'goals/first game.md', '--ssh-host', 'build.example.com', '--ssh-user', 'ops', '--confirm-price', '4.51', '--wait', '45', '--reuse-app', 'acme-graphyard'];
  const customRequest = await upRequest(...options);
  const customDrive = recordedAppDriver(await temporaryDirectory('sudo-import-options'), customRequest, { profile: 'Default' }, () => appDrivePage(clock, clock.t + 30_000), timing);
  assert.deepEqual(await customDrive.drive(LOCAL, sentence => { custom.push(sentence); }), { state: 'done' });
  const words = (command: string) => command.match(/'[^']*'|\S+/g)!.map(word => word.replace(/^'(.*)'$/, '$1'));
  const carried = upRequestFromArgs(words(custom[0].split('\n').at(-1)!.match(/`graphyard up ([^`]+)`/)![1]));
  const { reuseApps: _reuse, ...expected } = customRequest;
  assert.deepEqual({ ...carried, reuseApps: undefined }, { ...expected, reuseApps: undefined }, 'a non-default --reviewer, --master, --goal, SSH, price and wait survive the route');
  assert.deepEqual(carried.reuseApps, ['SLUG', 'REVIEWER_SLUG'], 'the route names its own --reuse-app per App');

  // An App set up exactly as the route says passes --reuse-app's preflight for its role: the permissions
  // it names, no webhook bound elsewhere, and an installation on the repository's owner.
  const { reuseExistingApp } = await import('../src/github-setup.js');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const named = (role: string) => {
    const clause = role === 'control-plane' ? handedRoute.match(/control-plane App the Repository permissions (.+?), subscribe/)![1] : handedRoute.match(/reviewer App exactly (.+?) and nothing more/)![1];
    return Object.fromEntries(clause.split(', ').map(entry => { const [label, level] = entry.split(': '); return [label.toLowerCase().replace(' ', '_'), level]; }));
  };
  assert.match(handedRoute, /install each on acme from its github\.com\/apps\/SLUG\/installations\/new page with acme\/shop selected/);
  for (const role of ['control-plane', 'reviewer'] as const) {
    const permissions = named(role), appId = role === 'control-plane' ? 11 : 12, slug = `hand-made-${role}`;
    const fetcher = (async (url: string) => {
      const path = new URL(url).pathname;
      const body = path === '/app' ? { id: appId, permissions } : path === '/app/hook/config' ? { url: '' }
        : path === '/app/installations' ? [{ id: 5, account: { login: 'acme' }, permissions, repository_selection: 'selected' }] : null;
      return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
    }) as typeof fetch;
    const reused = await reuseExistingApp({ slug, role, repository: 'acme/shop', apply: false, fetcher,
      registrations: [{ file: `${slug}.json`, role, app: { appId, slug, privateKey, installationId: 0, webhookSecret: '', repository: 'acme/shop' } as any }],
      gh: async () => JSON.stringify({ id: 99, owner: { login: 'acme' } }) });
    assert.equal(reused.app.installationId, 5, `a ${role} App made as the route says is reused`);
  }

  const { startGithubSetup } = await import('../src/github-setup.js');
  const pageRoot = await temporaryDirectory('sudo-import-page');
  execFileSync('git', ['init', '-q'], { cwd: pageRoot });
  const setup = await startGithubSetup(pageRoot, 'acme/shop', 'http://127.0.0.1:4320', 0);
  try {
    const shown = (await (await fetch(setup.url)).text()).replace(/<\/?code>/g, '`').replace(/&#39;/g, "'");
    assert.match(shown, IMPORT_ROUTE(''), 'the local setup page offers it');
    assert.match(shown, /REVIEWER_SLUG --repo acme\/shop` with every other option you ran up with \(--provider, --agent, and any --reviewer, --master, --goal, /, 'the page names every option the operator must carry over');
    assert.equal(upRequestFromArgs(routeUp(shown)).repository, 'acme/shop', 'its up command parses');
  }
  finally { await new Promise<void>(accept => setup.http.close(() => accept())); }
  // A reviewer App's page names that App alone: no control-plane permissions, events or webhook.
  const reviewerSetup = await startGithubSetup(pageRoot, 'acme/shop', 'http://127.0.0.1:4320', 0, {}, 'claude');
  try {
    const shown = (await (await fetch(reviewerSetup.url)).text()).replace(/<\/?code>/g, '`').replace(/&#39;/g, "'");
    assert.match(shown, /create the reviewer App at github\.com\/settings\/apps\/new whenever convenient: give it exactly Contents: read, Issues: read, Metadata: read, Pull requests: write and nothing more; install it on acme .*`graphyard app import --app-id ID --key-file PEM --role reviewer --repo acme\/shop`, then run `graphyard up --reuse-app REVIEWER_SLUG --repo acme\/shop` with every other option/);
    assert.doesNotMatch(shown, /webhook|control-plane/, 'the reviewer page never asks for the control-plane App');
    assert.equal(upRequestFromArgs(routeUp(shown)).repository, 'acme/shop', 'its up command parses');
  }
  finally { await new Promise<void>(accept => reviewerSetup.http.close(() => accept())); }

  // --no-wait: the drive meets Confirm access, up ends the install it drives and exits 3 with the route.
  const root = await temporaryDirectory('sudo-no-wait');
  const request = upRequestFromArgs(['--repo', 'acme/shop', '--agent', '--no-wait', '--browser-profile', 'Default']);
  assert.equal(request.noWait, true);
  const runClock = { t: 0 };
  const noWait = recordedAppDriver(root, request, { profile: 'Default' }, () => appDrivePage(runClock, Infinity), { now: () => new Date(runClock.t), sleep: async ms => { runClock.t += ms; } });
  const events: { kind: string }[] = [];
  let aborted = false, installEnv: Record<string, string> | undefined;
  const result = await runUp(request, {
    root, pollMs: 1, emit: event => { events.push(event); }, now: () => runClock.t, sleep: async ms => { runClock.t += ms; await new Promise(accept => setImmediate(accept)); },
    serverUrl: async () => null, masterToken: async () => null, status: async () => null,
    publishOnboarding: async () => null, onboardingMerged: async () => true, driveApp: noWait.drive,
    cli: async (args, options = {}) => {
      if (args.includes('--plan')) return { code: 0, stdout: JSON.stringify({ preflight: [{ name: 'GitHub CLI', ok: true }] }) };
      installEnv = options.env;
      options.onLine?.('Open http://127.0.0.1:4311 in a browser on this machine and confirm the Graphyard App');
      // The install serves its App page until up ends it.
      await new Promise<void>(accept => options.signal?.addEventListener('abort', () => { aborted = true; accept(); }));
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    },
  });
  assert.equal(result.exitCode, 3, 'waiting on a person, resumable');
  assert.match(result.next, /--no-wait does not wait for it/);
  assert.match(result.next, IMPORT_ROUTE(' --provider compose --agent --browser-profile Default'), 'the next step is the App-import route, with the options up was run with');
  assert.ok(aborted, 'the install serving the App page was ended');
  assert.equal(installEnv?.GRAPHYARD_APP_WAIT_MS, '1260000', "the App page is served up's wait plus a minute, outliving the drive");
  assert.equal(result.handoffs.length, 1);
});

test('unit:preflight-durable-checkout — host preflight names a checkout under a temporary directory, which the loop unit would refuse, and a durable place instead', async () => {
  const { durableCheckoutPreflight } = await import('../src/supervisor.js');
  const scratch = await temporaryDirectory('durable-checkout');
  const checkout = `${scratch}/pilot`;
  const refused = durableCheckoutPreflight(checkout, ['/nonexistent-tmp', scratch], '/home/operator');
  assert.equal(refused.name, 'Durable checkout');
  assert.equal(refused.ok, false, 'a checkout under a temporary directory fails preflight before setup starts');
  assert.match(refused.detail, new RegExp(`^${checkout.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} is under the temporary directory .+, where the master loop's unit refuses to run$`));
  assert.equal(refused.fix, 'Clone the repository on durable storage, such as /home/operator/code/pilot, and run setup from there');
  for (const temporary of ['/var/tmp', '/tmp']) assert.equal(durableCheckoutPreflight(`${temporary}/graphyard-game-pilot`, [temporary], '/home/operator').ok, false, `${temporary} is temporary`);
  const durable = durableCheckoutPreflight('/home/operator/code/pilot', ['/tmp', '/var/tmp'], '/home/operator');
  assert.deepEqual({ ok: durable.ok, name: durable.name }, { ok: true, name: 'Durable checkout' });
});
