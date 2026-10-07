import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import type { BrowserPage, Located, PageInput, RecordedStep, SudoState } from '../src/master-browser.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1459: the greenfield pilot's authenticator code was thrown away — every code-field locator
 * came back null on GitHub's authenticator Confirm-access page — and its 'confirm in your own
 * Chrome' route could never reach a drive running on a copy of the operator's Chrome profile.
 *
 * unit:sudo-totp-field — on GitHub's authenticator Confirm-access page the drive waits up to 10 s
 * for the TOTP input to render, finds it by its own attributes, types the code and submits it; a
 * field that never renders is reported and the code kept, not consumed.
 *
 * unit:sudo-code-direct — a code handed on the local App page or with `graphyard up --sudo-code`
 * reaches the waiting drive directly and is typed within 2 s; the handoff says to enter it right
 * after the app rolls over to a new code.
 *
 * unit:sudo-copy-profile-routes — on a profile copy the handoff never offers confirming in the
 * operator's own Chrome: it offers the code methods and opening the local App page in their own
 * browser, and the drive continues once that page finishes the step.
 */

// Loaded per test, so on a base without this change each case fails on its own assertion.
const browser = () => import('../src/master-browser.js');
const CODE = '483920';
const LOCAL = 'http://127.0.0.1:4311';
const SUDO = 'https://github.com/sessions/sudo';

// GitHub's Confirm-access page (sessions/sudo) as the pilot's agent-browser profile copy rendered it
// on 2026-10-07: its recorded text (record.json step 139, and the master's app-permissions records)
// with the markup GitHub serves for it. The passkey view is the default; "Use your authenticator
// app" swaps in the authenticator form, which renders after the click. Its TOTP input is a plain
// text input with autocomplete="one-time-code" and inputmode="numeric", named by a heading through
// aria-labelledby, not by a <label>, and its name and id are none the GY-1450 locator tried — which
// is why every one of them came back null and the code was discarded.
const PASSKEY_VIEW = `<main><div class="auth-form">
<h1>Confirm access</h1><p>Signed in as <strong>@operator</strong></p>
<div class="sudo-passkey"><h2>Passkey</h2><p>When you are ready, authenticate using the button below.</p><button type="button" class="btn btn-primary">Use passkey</button></div>
<form action="/sessions/sudo" method="post" hidden><input type="hidden" name="authenticity_token" value="t0k3n"><input type="hidden" name="sudo_method" value="email">
<label for="sudo_email_otp">Email code</label><input type="text" id="sudo_email_otp" name="email_otp" autocomplete="one-time-code" inputmode="numeric"></form>
<p>Having problems?</p><ul><li><a href="/sessions/sudo?mobile=1">Use GitHub Mobile</a></li><li><a href="/sessions/sudo?sudo_method=totp">Use your authenticator app</a></li><li><button type="button">Send a code via email</button></li></ul>
</div></main>`;
const TOTP_VIEW = `<main><div class="auth-form">
<h1>Confirm access</h1><p>Signed in as <strong>@operator</strong></p>
<form action="/sessions/sudo" method="post"><input type="hidden" name="authenticity_token" value="t0k3n"><input type="hidden" name="sudo_method" value="totp"><input type="hidden" name="sudo_return_to" value="/settings/apps/new">
<h2 id="sudo-totp-heading">Authentication code</h2>
<input type="text" id="sudo_totp" name="totp" class="form-control input-block" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="XXXXXX" aria-labelledby="sudo-totp-heading" required autofocus>
<p class="note">Open your two-factor authenticator (TOTP) app or browser extension to view your authentication code.</p>
<button type="submit" class="btn btn-primary btn-block">Verify</button></form>
<form action="/sessions/sudo" method="post" hidden><label for="sudo_email_otp">Email code</label><input type="text" id="sudo_email_otp" name="email_otp" autocomplete="one-time-code" inputmode="numeric"></form>
<p>Having problems?</p><ul><li><a href="/sessions/sudo">Use passkey</a></li><li><a href="/sessions/sudo?mobile=1">Use GitHub Mobile</a></li><li><button type="button">Send a code via email</button></li></ul>
</div></main>`;
// The view switched, but its form has not rendered (yet).
const TOTP_LOADING = `<main><div class="auth-form"><h1>Confirm access</h1><p>Authentication code</p><p>Having problems?</p><a href="/sessions/sudo">Use passkey</a></div></main>`;

/** The page's text as agent-browser's `get text body` returns it: tags dropped, hidden forms skipped. */
function textOf(html: string) {
  return html.replace(/<form[^>]*\bhidden\b[^>]*>[^]*?<\/form>/g, '').replace(/<[^>]+>/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}
const attributes = (raw: string) => Object.fromEntries([...raw.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, value ?? '']));
/** What the inputs script reports for HTML: every typeable input, its naming text, and whether a hidden ancestor hides it. */
function inputsOf(html: string): PageInput[] {
  const headings = Object.fromEntries([...html.matchAll(/<[a-z0-9]+ id="([^"]+)"[^>]*>([^<]*)</g)].map(([, id, text]) => [id, text]));
  const labels = Object.fromEntries([...html.matchAll(/<label for="([^"]+)">([^<]*)<\/label>/g)].map(([, id, text]) => [id, text]));
  const found: PageInput[] = [];
  const hidden: boolean[] = [];
  for (const [, closing, tag, raw] of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>/g)) {
    if (tag !== 'input') { if (closing) hidden.pop(); else hidden.push(/\bhidden\b/.test(raw) || !!hidden[hidden.length - 1]); continue; }
    const attrs = attributes(raw), type = attrs.type ?? 'text';
    if (['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(type)) continue;
    const label = [labels[attrs.id], headings[attrs['aria-labelledby']], attrs['aria-label'], attrs.placeholder].filter(Boolean).join(' | ');
    found.push({ selector: `#${attrs.id}`, type, name: attrs.name ?? '', id: attrs.id ?? '', autocomplete: attrs.autocomplete ?? '', inputmode: attrs.inputmode ?? '', label, visible: !hidden[hidden.length - 1] });
  }
  return found;
}
const noop = { meta: () => null, setChecked() {}, select() {}, screenshot() {}, close() {} };

/**
 * The fixture as a page. Choosing the authenticator view renders it after RENDER_WAITS 500 ms waits
 * (never, with Infinity); `typed` is what reached the TOTP field, `submitted` what Verify sent.
 */
function fixturePage(options: { renderWaits?: number[]; clock?: { at: number }; done?: string } = {}) {
  const renders = [...(options.renderWaits ?? [2])];
  const state = { view: 'passkey' as 'passkey' | 'loading' | 'totp' | 'done', waits: 0, pending: 1, field: '', typed: [] as { code: string; at: number }[], submitted: [] as string[], clicked: [] as string[], reloads: 0, waited: [] as number[] };
  const html = () => state.view === 'passkey' ? PASSKEY_VIEW : state.view === 'totp' ? TOTP_VIEW : state.view === 'loading' ? TOTP_LOADING : `<h1>${options.done ?? 'Register new GitHub App'}</h1>`;
  const page: BrowserPage = { ...noop,
    open() { state.reloads += 1; if (state.view !== 'done') state.view = 'passkey'; },
    url: () => state.view === 'done' ? 'https://github.com/settings/apps/new' : SUDO,
    text: () => textOf(html()),
    wait(ms) {
      state.waited.push(ms); if (options.clock) options.clock.at += ms;
      if (state.view === 'loading' && ++state.waits >= state.pending) state.view = 'totp';
    },
    inputs: () => inputsOf(html()),
    // The GY-1450 locators, answered from the fixture: a field by its name, a <label> by its text.
    locate(kind, text): Located | null {
      const markup = html();
      if (kind === 'field') { const input = inputsOf(markup).find(candidate => candidate.name === text); return input ? { selector: input.selector, tag: 'input', checked: null, value: '', text: '', visible: input.visible } : null; }
      if (kind === 'label') { const match = markup.match(new RegExp(`<label for="([^"]+)">${text}`)); return match ? { selector: `#${match[1]}`, tag: 'input', checked: null, value: '', text: '' } : null; }
      const anchor = kind === 'link' && markup.match(new RegExp(`<a href="([^"]+)">${text}</a>`));
      if (anchor) return { selector: `a[href="${anchor[1]}"]`, tag: 'a', checked: null, value: null, text, href: `https://github.com${anchor[1]}`, visible: true };
      if (kind === 'button' && new RegExp(`<button[^>]*>${text}</button>`).test(markup)) return { selector: `button:${text}`, tag: 'button', checked: null, value: null, text, visible: true };
      return null;
    },
    click(selector) {
      state.clicked.push(selector);
      if (selector === 'a[href="/sessions/sudo?sudo_method=totp"]') { state.view = 'loading'; state.waits = 0; state.pending = renders.shift() ?? 1; }
      if (selector === 'button:Verify' && state.view === 'totp') { state.submitted.push(state.field); if (state.field === CODE) state.view = 'done'; state.field = ''; }
    },
    fill(selector, value) { assert.equal(selector, '#sudo_totp', 'the code goes into the TOTP input, never the hidden email field'); state.field = value; if (value) state.typed.push({ code: value, at: options.clock?.at ?? 0 }); },
  };
  return { page, state };
}
const sudoSteps = (steps: RecordedStep[]) => steps.filter(step => step.action.startsWith('sudo-')).map(step => [step.action, ...step.args]);

test('unit:sudo-totp-field — the fixture defeats the GY-1450 locators, and its TOTP input is found by its own attributes', async () => {
  const { confirmCodeField } = await browser();
  const inputs = inputsOf(TOTP_VIEW);
  const { page } = fixturePage();
  for (const name of ['app_otp', 'otp', 'sudo_otp']) assert.equal(inputs.find(input => input.name === name), undefined, `no input named ${name}`);
  assert.equal(page.locate('label', 'Authentication code'), null, 'no <label> names the TOTP input');
  const field = confirmCodeField(inputs, 'authenticator')!;
  assert.deepEqual({ type: field.type, autocomplete: field.autocomplete, id: field.id, name: field.name, label: field.label }, { type: 'text', autocomplete: 'one-time-code', id: 'sudo_totp', name: 'totp', label: 'Authentication code | XXXXXX' });
  assert.equal(confirmCodeField(inputsOf(PASSKEY_VIEW), 'authenticator'), null, 'the hidden email field is never the authenticator field');
  assert.equal(confirmCodeField(inputsOf(TOTP_LOADING), 'authenticator'), null);
  assert.equal(confirmCodeField(inputs.map(input => ({ ...input, visible: true })), 'email')?.id, 'sudo_email_otp', 'the email view takes the email field, never the TOTP one');
});

test('unit:sudo-totp-field — after choosing the authenticator method the drive waits for the TOTP input to render, types the code and submits it', async () => {
  const { passSudo, recordingPage } = await browser();
  const clock = { at: 0 };
  // The authenticator form renders 4 s after the click: 8 checks, 500 ms apart.
  const fake = fixturePage({ renderWaits: [8], clock });
  const steps: RecordedStep[] = [];
  const page = recordingPage(fake.page, { directory: '/nonexistent-record', steps, now: () => new Date(clock.at) });
  let handed = 0;
  const result = await passSudo(page, { flow: 'installation-accept', record: 'graphyard up', prefer: 'passkey-or-password', timeoutMs: 600_000, now: () => new Date(clock.at),
    readCode: () => handed++ === 1 ? { kind: 'code', code: CODE, at: new Date(clock.at).toISOString() } : null,
    onCode: () => {}, sleep: async ms => { clock.at += ms; } });
  assert.deepEqual(result, { passed: true, attempts: 0, code: null });
  assert.deepEqual(fake.state.clicked, ['a[href="/sessions/sudo?sudo_method=totp"]', 'button:Verify'], 'the authenticator view was chosen, then the code submitted with Verify');
  assert.deepEqual(fake.state.typed.map(entry => entry.code), [CODE]);
  assert.deepEqual(fake.state.submitted, [CODE], 'Verify sent the typed code');
  // The click's own 1 s settle, then a check every 500 ms until the form rendered 4.5 s after the click.
  assert.deepEqual(fake.state.waited.slice(0, 8), [1_000, ...Array(7).fill(500)], 'the drive checked for the field every 500 ms until it rendered');
  assert.deepEqual(sudoSteps(steps), [['sudo-method', 'passkey'], ['sudo-code', 'authenticator', 'entered'], ['sudo-method', 'authenticator']]);
  assert.ok(!JSON.stringify(steps).includes(CODE), 'the code appears in no recorded step');
});

test('unit:sudo-totp-field — a TOTP input that never renders within 10 s is reported, and the code is kept and typed on the next check, not consumed', async () => {
  const { passSudo, recordingPage, sudoInstruction } = await browser();
  const clock = { at: 0 };
  // The first choice of the authenticator view never renders its form; after the re-check's reload it renders at once.
  const fake = fixturePage({ renderWaits: [Infinity, 1], clock });
  const steps: RecordedStep[] = [];
  const page = recordingPage(fake.page, { directory: '/nonexistent-record', steps, now: () => new Date(clock.at) });
  const handed: SudoState[] = [];
  let reads = 0;
  const result = await passSudo(page, { flow: 'installation-accept', record: 'graphyard up', prefer: 'passkey-or-password', timeoutMs: 600_000, now: () => new Date(clock.at),
    readCode: () => ++reads === 1 ? { kind: 'code', code: CODE, at: new Date(clock.at).toISOString() } : null,
    onCode: state => { handed.push(state); }, sleep: async ms => { clock.at += ms; } });
  assert.deepEqual(result, { passed: true, attempts: 0, code: null });
  const firstTry = fake.state.waited.slice(1, 1 + 19);
  assert.deepEqual(firstTry, Array(19).fill(500), 'the first try waited 10 s for the field: 20 checks, 500 ms apart');
  assert.deepEqual(sudoSteps(steps), [['sudo-method', 'passkey'], ['sudo-code', 'authenticator', 'no code field'], ['sudo-code', 'authenticator', 'entered'], ['sudo-method', 'authenticator']]);
  assert.deepEqual(fake.state.typed.map(entry => entry.code), [CODE], 'the kept code was typed once its field rendered');
  assert.equal(reads >= 2, true);
  assert.equal(handed.length, 2, 'the missing field was handed to the operator');
  assert.equal(handed[1].field, 'missing');
  assert.match(sudoInstruction(handed[1], 'your phone', { page: LOCAL, command: 'graphyard up --sudo-code' }), /GitHub's code field did not appear within 10 s: the drive kept your code and tries it again/);
  assert.ok(!JSON.stringify([steps, handed]).includes(CODE), 'the kept code is never recorded');
});

test('unit:sudo-code-direct — a code entered on the local App page or with graphyard up --sudo-code reaches the waiting drive directly and is typed within 2 s', async () => {
  const { passSudo, sudoInstruction, takeSudoCode } = await browser();
  const { startGithubSetup } = await import('../src/github-setup.js');
  const { installCommands } = await import('../src/cli/install.js');
  const up = installCommands.find(command => command.name === 'up')!;
  for (const via of ['local App page', 'graphyard up --sudo-code'] as const) {
    const root = await temporaryDirectory('sudo-code-direct');
    execFileSync('git', ['init', '-q'], { cwd: root });
    const setup = await startGithubSetup(root, 'acme/shop', 'http://127.0.0.1:4320', 0);
    try {
      const home = await (await fetch(setup.url)).text();
      const formState = home.match(/name="state" value="([a-f0-9]+)"/)![1];
      // The operator enters the code themselves, 4.3 s into the wait: between two of the drive's checks.
      const enterCode = async () => {
        if (via === 'local App page') { const answer = await fetch(`${setup.url}/sudo-code`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state: formState, code: CODE }) }); assert.equal(answer.status, 200); }
        else await up.run({ command: 'up', id: '--sudo-code', args: [CODE], rest: ['--sudo-code', CODE], repositoryRoot: () => root, print: () => {} } as any, undefined as any);
      };
      const clock = { at: 0 }, enteredAt = 4_300;
      let entered = false;
      const fake = fixturePage({ renderWaits: [1], clock });
      const handed: string[] = [];
      const result = await passSudo(fake.page, { flow: 'installation-accept', record: 'graphyard up', prefer: 'passkey-or-password', timeoutMs: 600_000, now: () => new Date(clock.at),
        // The drive reads the file the page and the command write, as `graphyard up` wires it: no agent relays the code.
        readCode: async () => { const taken = await takeSudoCode(root); return taken?.kind === 'code' ? { ...taken, at: new Date(clock.at).toISOString() } : taken; },
        onCode: state => { handed.push(sudoInstruction(state, 'your phone', { page: LOCAL, command: 'graphyard up --sudo-code' })); },
        sleep: async ms => { const before = clock.at; clock.at += ms; if (!entered && before < enteredAt && clock.at >= enteredAt) { entered = true; await enterCode(); } } });
      assert.deepEqual(result, { passed: true, attempts: 0, code: null }, via);
      assert.equal(fake.state.typed.length, 1, via);
      const delay = fake.state.typed[0].at - enteredAt;
      assert.ok(delay >= 0 && delay <= 2_000, `${via}: typed ${delay} ms after it was entered`);
      assert.deepEqual(fake.state.submitted, [CODE]);
      assert.deepEqual(await readdir(`${root}/.graphyard/master-actions`), [], `${via}: the code was taken once`);
      const lines = handed[0].split('\n');
      assert.ok(lines.includes(`For your authenticator app, enter its 6-digit code at ${LOCAL} or with graphyard up --sudo-code CODE`));
      assert.ok(lines.includes('Enter an authenticator code yourself, right after the app rolls over to a new one: the drive reads it the moment you enter it and types it within 2 s, with nobody passing it on'), 'the handoff says to enter a fresh code right after it rolls over');
    } finally { await new Promise<void>(accept => setup.http.close(() => accept())); }
  }
});

test('unit:sudo-copy-profile-routes — on a profile copy the handoff offers the code methods and the local App page in the operator\'s own browser, never their own Chrome', async () => {
  const { agentBrowserPage, recordingPage, sudoAttention, sudoInstruction, sudoTimeout, signalSudoSettled, takeSudoCode } = await browser();
  const { browserAppDriver } = await import('../src/up.js');
  assert.equal(agentBrowserPage({ profile: 'Default' }, 'graphyard-up', () => '{"success":true,"data":{}}').copy, true, 'agent-browser runs its own Chrome on a copy of the profile');
  const root = await temporaryDirectory('sudo-copy-profile');
  execFileSync('git', ['init', '-q'], { cwd: root });
  let view: 'local' | 'sudo' | 'installed-local' | 'install' | 'done' = 'local', registered = false, clock = 0, sleeps = 0;
  const clicked: string[] = [];
  const located = (selector: string, text: string, extra: Partial<Located> = {}): Located => ({ selector, tag: 'button', checked: null, value: null, text, visible: true, ...extra });
  const fake: BrowserPage = { ...noop, wait() {}, copy: true,
    open(url) { if (url === LOCAL) view = view === 'done' || registered ? 'installed-local' : 'local'; else if (url.includes('/installations/new/permissions')) view = 'install'; },
    url: () => view === 'sudo' ? SUDO : view === 'install' ? 'https://github.com/apps/graphyard-acme-shop/installations/new/permissions' : LOCAL,
    text: () => view === 'sudo' ? textOf(PASSKEY_VIEW) : '',
    locate(kind, text) {
      if (view === 'local' && kind === 'button' && text === 'Register Graphyard App →') return located('#register', text);
      if (view === 'installed-local' && kind === 'link' && text === 'Install GitHub App') return located('#install-link', text, { tag: 'a', href: 'https://github.com/apps/graphyard-acme-shop/installations/new' });
      if (view === 'install' && kind === 'button' && text === 'Install') return located('#install', text);
      return null;
    },
    click(selector) { clicked.push(selector); if (selector === '#register') view = 'sudo'; if (selector === '#install') view = 'done'; },
  };
  const page = recordingPage(fake, { directory: '/nonexistent-record', steps: [], now: () => new Date(clock) });
  assert.equal(page.copy, true, 'the recording page keeps the copy');
  const handed: string[] = [];
  const drive = browserAppDriver({ page, repository: 'acme/shop', ids: () => ({ owner: 11, repository: 22 }), now: () => new Date(clock), readCode: () => takeSudoCode(root, new Date(clock)),
    // The operator opens the local App page in their own browser and registers the App there: the page tells the drive.
    sleep: async ms => { clock += ms; if (++sleeps === 3) { registered = true; await signalSudoSettled(root, new Date(clock)); } } });
  assert.deepEqual(await drive(LOCAL, sentence => { handed.push(sentence); }), { state: 'done' }, 'the drive continued once the local App page finished the step');
  assert.deepEqual(clicked, ['#register', '#install'], 'the drive went on to install the App the operator registered');
  assert.equal(handed.length, 1);
  const lines = handed[0].split('\n');
  assert.doesNotMatch(handed[0], /own Chrome/, 'confirming in the operator\'s own Chrome is never offered on a profile copy');
  assert.equal(lines[0], "GitHub's Confirm-access page (https://github.com/sessions/sudo) offers: passkey, authenticator app, email code, Mobile");
  assert.ok(lines.includes(`For your authenticator app, enter its 6-digit code at ${LOCAL} or with graphyard up --sudo-code CODE`), 'the authenticator code method');
  assert.ok(lines.some(line => line.startsWith(`For an email code, ask for it at ${LOCAL} or with graphyard up --sudo-code email`)), 'the email code method');
  assert.equal(lines[lines.length - 1], `Or open ${LOCAL} in your own browser and click its button there: your own GitHub session holds sudo mode, and setup continues by itself once GitHub returns you to that page`, 'the one-click manual route');

  // Every other message about a wait on a profile copy says the same.
  const copied: SudoState = { flow: 'installation-accept', record: 'r', code: null, issuedAt: new Date(0).toISOString(), attempt: 1, deadline: new Date(600_000).toISOString(), state: 'waiting', method: 'passkey', offered: ['passkey', 'authenticator', 'mobile'], copy: true };
  assert.doesNotMatch(sudoAttention(copied, 0)!.instruction, /own Chrome/);
  assert.doesNotMatch(sudoInstruction(copied), /own Chrome/);
  assert.equal(sudoTimeout(copied, [], 600_000, 'installation-accept', true), 'Confirm access was not approved within 600s; confirm access with your passkey or authenticator app and rerun master browser installation-accept');

  // The local App page itself no longer sends the operator to their own Chrome, and a step it finishes ends the drive's wait.
  const { startGithubSetup } = await import('../src/github-setup.js');
  const setup = await startGithubSetup(root, 'acme/shop', 'http://127.0.0.1:4320', 0, { convert: async () => ({ id: 7, slug: 'graphyard-acme-shop', pem: 'key', webhook_secret: 'secret' }) });
  try {
    const home = await (await fetch(setup.url)).text();
    assert.doesNotMatch(home, /Confirming once in your own Chrome/);
    assert.match(home, /open this page in your own browser and click its button above: your live GitHub session confirms access, and the drive continues by itself/);
    const formState = home.match(/name="state" value="([a-f0-9]+)"/)![1];
    const created = await fetch(`${setup.url}/created?state=${formState}&code=abc`, { redirect: 'manual' });
    assert.equal(created.status, 303);
    assert.equal(JSON.parse(await readFile(`${root}/.graphyard/master-actions/sudo-code.json`, 'utf8')).kind, 'settled', 'registering on the page signals the waiting drive');
  } finally { await new Promise<void>(accept => setup.http.close(() => accept())); }
});
