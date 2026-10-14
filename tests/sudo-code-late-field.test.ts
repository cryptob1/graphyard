import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import type { BrowserPage, Located, PageInput, RecordedStep, SudoState } from '../src/master-browser.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1792: a sudo code handed a drive whose Confirm-access page has not rendered GitHub's
 * authenticator input yet — entered on the local Setup page field or with `graphyard up
 * --sudo-code` — waited on GitHub's render with no deadline measured from the field appearing.
 *
 * unit:sudo-code-late-field — against the recorded Confirm-access fixture (the drive's own capture,
 * tests/fixtures/github-confirm-access-authenticator.html) with the field rendered late: a code
 * handed while the input is still rendering is kept, then typed within 2 s of the input appearing
 * (the input appears inside the 10 s render wait) and submitted; an input that never renders within
 * the wait leaves the code reported kept and unused, never typed or submitted.
 */

// Loaded per test, so on a base without this change each case fails on its own assertion.
const browser = () => import('../src/master-browser.js');
const CODE = '483920';
const SUDO = 'https://github.com/sessions/sudo';
const LOCAL = 'http://127.0.0.1:4311';

// GitHub's Confirm-access page (sessions/sudo), authenticator view: the recorded page itself —
// tests/fixtures/github-confirm-access-authenticator.html, captured from GitHub by the master's
// confirm-access capture, secrets redacted — whose code input is name="sudo_app_otp" id="app_totp".
// PASSKEY_VIEW is only what the drive sees before the view switch.
const TOTP_VIEW = readFileSync(new URL('./fixtures/github-confirm-access-authenticator.html', import.meta.url), 'utf8');
const PASSKEY_VIEW = `<main><div class="auth-form">
<h1>Confirm access</h1><p>Signed in as <strong>@operator</strong></p>
<div class="sudo-passkey"><h2>Passkey</h2><p>When you are ready, authenticate using the button below.</p><button type="button" class="btn btn-primary">Use passkey</button></div>
<p>Having problems?</p><ul><li><a href="/sessions/sudo?mobile=1">Use GitHub Mobile</a></li><li><a href="/sessions/sudo?sudo_method=totp">Use your authenticator app</a></li><li><button type="button">Send a code via email</button></li></ul>
</div></main>`;
// The view switched, but its form has not rendered (yet).
const TOTP_LOADING = `<main><div class="auth-form"><h1>Confirm access</h1><p>Authentication code</p><p>Having problems?</p><a href="/sessions/sudo">Use passkey</a></div></main>`;

/** The page's text as agent-browser's `get text body` returns it: tags dropped, hidden forms skipped. */
function textOf(html: string) {
  return html.replace(/<form[^>]*\bhidden\b[^>]*>[^]*?<\/form>/g, '').replace(/<[^>]+>/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}
const attributes = (raw: string) => Object.fromEntries([...raw.matchAll(/([a-z_-]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, value ?? '']));
/** What the inputs script reports for HTML: every typeable input, its naming text, and whether a hidden ancestor hides it. */
function inputsOf(html: string): PageInput[] {
  const headings = Object.fromEntries([...html.matchAll(/<[a-z0-9]+ id="([^"]+)"[^>]*>([^<]*)</g)].map(([, id, text]) => [id, text.trim()]));
  const labels = Object.fromEntries([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/label>/g)].map(([, id, text]) => [id, text.trim()]));
  const found: PageInput[] = [];
  const hidden: boolean[] = [];
  for (const [, closing, tag, raw] of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>/g)) {
    if (tag !== 'input') { if (closing) hidden.pop(); else hidden.push(/\bhidden\b/.test(raw) || !!hidden[hidden.length - 1]); continue; }
    const attrs = attributes(raw), type = attrs.type ?? 'text';
    if (['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(type)) continue;
    const label = [...new Set([labels[attrs.id], headings[attrs['aria-labelledby']], attrs['aria-label'], attrs.placeholder].filter(Boolean))].join(' | ');
    found.push({ selector: `#${attrs.id}`, type, name: attrs.name ?? '', id: attrs.id ?? '', autocomplete: attrs.autocomplete ?? '', inputmode: attrs.inputmode ?? '', label, visible: !hidden[hidden.length - 1] });
  }
  return found;
}
const noop = { meta: () => null, setChecked() {}, select() {}, screenshot() {}, close() {} };

/**
 * The fixture as a page. Choosing the authenticator view renders it after RENDER_WAITS 500 ms waits
 * (never, with Infinity); `renderedAt` is when the input appeared on the fixture's clock, `typed`
 * what reached the TOTP field and when, `submitted` what Verify sent.
 */
function fixturePage(options: { renderWaits?: number[]; clock?: { at: number } } = {}) {
  const renders = [...(options.renderWaits ?? [1])];
  const state = { view: 'passkey' as 'passkey' | 'loading' | 'totp' | 'done', waits: 0, pending: 1, field: '', typed: [] as { code: string; at: number }[], submitted: [] as string[], clicked: [] as string[], renderedAt: null as number | null, chosenAt: null as number | null };
  const html = () => state.view === 'passkey' ? PASSKEY_VIEW : state.view === 'totp' ? TOTP_VIEW : state.view === 'loading' ? TOTP_LOADING : '<h1>Register new GitHub App</h1>';
  const page: BrowserPage = { ...noop,
    open() { if (state.view !== 'done') state.view = 'passkey'; },
    url: () => state.view === 'done' ? 'https://github.com/settings/apps/new' : SUDO,
    text: () => textOf(html()),
    wait(ms) {
      if (options.clock) options.clock.at += ms;
      if (state.view === 'loading' && ++state.waits >= state.pending) { state.view = 'totp'; state.renderedAt = options.clock?.at ?? 0; }
    },
    inputs: () => inputsOf(html()),
    // The GY-1450 locators, answered from the fixture: a field by its name, a <label> by its text.
    locate(kind, text): Located | null {
      const markup = html();
      if (kind === 'field') { const input = inputsOf(markup).find(candidate => candidate.name === text); return input ? { selector: input.selector, tag: 'input', checked: null, value: '', text: '', visible: input.visible } : null; }
      if (kind === 'label') { const match = markup.match(new RegExp(`<label\\b[^>]*\\bfor="([^"]+)"[^>]*>\\s*${text}`)); return match ? { selector: `#${match[1]}`, tag: 'input', checked: null, value: '', text: '' } : null; }
      const anchor = kind === 'link' && markup.match(new RegExp(`<a href="([^"]+)">${text}</a>`));
      if (anchor) return { selector: `a[href="${anchor[1]}"]`, tag: 'a', checked: null, value: null, text, href: `https://github.com${anchor[1]}`, visible: true };
      if (kind === 'button' && new RegExp(`<button[^>]*>\\s*${text}\\s*</button>`).test(markup)) return { selector: `button:${text}`, tag: 'button', checked: null, value: null, text, visible: true };
      return null;
    },
    click(selector) {
      state.clicked.push(selector);
      if (selector === 'a[href="/sessions/sudo?sudo_method=totp"]') { state.view = 'loading'; state.waits = 0; state.pending = renders.shift() ?? 1; state.chosenAt = options.clock?.at ?? 0; }
      if (selector === 'button:Verify' && state.view === 'totp') { state.submitted.push(state.field); if (state.field === CODE) state.view = 'done'; state.field = ''; }
    },
    fill(selector, value) { assert.equal(selector, '#app_totp', 'the code goes into the TOTP input, never the hidden email field'); state.field = value; if (value) state.typed.push({ code: value, at: options.clock?.at ?? 0 }); },
  };
  return { page, state };
}

test('unit:sudo-code-late-field — a code handed while the TOTP input is still rendering is typed within 2 s of the input appearing and submitted', async () => {
  const { passSudo, recordingPage, takeSudoCode } = await browser();
  const { startGithubSetup } = await import('../src/github-setup.js');
  const { installCommands } = await import('../src/cli/install.js');
  const up = installCommands.find(command => command.name === 'up')!;
  for (const via of ['local App page', 'graphyard up --sudo-code'] as const) {
    const root = await temporaryDirectory('sudo-code-late-field');
    execFileSync('git', ['init', '-q'], { cwd: root });
    const setup = await startGithubSetup(root, 'acme/shop', 'http://127.0.0.1:4320', 0);
    try {
      const home = await (await fetch(setup.url)).text();
      const formState = home.match(/name="state" value="([a-f0-9]+)"/)![1];
      // The operator enters the code at 4.3 s, while GitHub's input has not rendered; the input
      // appears 8.5 s after the view was chosen (16 render waits), inside the 10 s render wait.
      const enteredAt = 4_300;
      let entered = false;
      const enterCode = async () => {
        if (via === 'local App page') {
          const answer = await fetch(`${setup.url}/sudo-code`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state: formState, code: CODE }) });
          assert.equal(answer.status, 200);
        } else {
          await up.run({ command: 'up', id: '--sudo-code', args: [CODE], rest: ['--sudo-code', CODE], repositoryRoot: () => root, print: () => {} } as any, undefined as any);
        }
      };
      const clock = { at: 0 };
      const fake = fixturePage({ renderWaits: [16], clock });
      const recorded: RecordedStep[] = [];
      const page = recordingPage(fake.page, { directory: '/nonexistent-record', steps: recorded, now: () => new Date(clock.at) });
      const result = await passSudo(page, { flow: 'installation-accept', record: 'graphyard up', prefer: 'passkey-or-password', timeoutMs: 600_000, now: () => new Date(clock.at),
        // The drive reads the file the page and the command write, as `graphyard up` wires it: no agent relays the code.
        readCode: async () => {
          if (!entered && clock.at >= enteredAt) { entered = true; await enterCode(); }
          const taken = await takeSudoCode(root);
          return taken?.kind === 'code' ? { ...taken, at: new Date(clock.at).toISOString() } : taken;
        },
        onCode: () => {}, sleep: async ms => { clock.at += ms; } });
      assert.deepEqual(result, { passed: true, attempts: 0, code: null }, via);
      assert.equal(fake.state.typed.length, 1, `${via}: the code was typed once`);
      const renderedAt = fake.state.renderedAt!;
      assert.ok(renderedAt !== null && renderedAt > enteredAt, `${via}: the input appeared after the code was handed (${renderedAt} ms vs ${enteredAt} ms)`);
      assert.ok(renderedAt - fake.state.chosenAt! <= 10_000, `${via}: the input appeared inside the 10 s render wait (${renderedAt! - fake.state.chosenAt!} ms)`);
      const delay = fake.state.typed[0].at - renderedAt;
      assert.ok(delay >= 0 && delay <= 2_000, `${via}: the code was typed ${delay} ms after the input appeared, over its 2 s bound`);
      assert.deepEqual(fake.state.submitted, [CODE], `${via}: Verify sent the typed code`);
      assert.deepEqual(await readdir(`${root}/.graphyard/master-actions`), [], `${via}: the handed code was taken once, leaving no file behind`);
      assert.ok(!JSON.stringify(recorded).includes(CODE), `${via}: the code appears in no recorded step`);
    } finally { await new Promise<void>(accept => setup.http.close(() => accept())); }
  }
});

test('unit:sudo-code-late-field — an input that never renders within the 10 s wait leaves the code unused: reported kept, never typed or submitted', async () => {
  const { passSudo, sudoInstruction } = await browser();
  const enteredAt = 4_300;
  let entered = false, approved = false;
  const clock = { at: 0 };
  const fake = fixturePage({ renderWaits: [Infinity], clock });
  const base = fake.page;
  // The operator approves in their own browser once the drive reports the missing input, ending the wait.
  const page: BrowserPage = { ...base,
    url: () => approved ? 'https://github.com/settings/apps/new' : base.url(),
    text: () => approved ? '<h1>Register new GitHub App</h1>' : base.text() };
  const handed: SudoState[] = [];
  const result = await passSudo(page, { flow: 'installation-accept', record: 'graphyard up', prefer: 'passkey-or-password', timeoutMs: 600_000, now: () => new Date(clock.at),
    readCode: () => {
      if (!entered && clock.at >= enteredAt) { entered = true; return { kind: 'code' as const, code: CODE, at: new Date(clock.at).toISOString() }; }
      return null;
    },
    onCode: state => { handed.push(state); if (state.field === 'missing') approved = true; },
    sleep: async ms => { clock.at += ms; } });
  assert.deepEqual(result, { passed: true, attempts: 0, code: null }, 'the approval ended the wait with the code unspent');
  assert.equal(fake.state.renderedAt, null, 'GitHub never rendered the input');
  assert.deepEqual(fake.state.typed, [], 'the code was never typed');
  assert.deepEqual(fake.state.submitted, [], 'nothing was submitted');
  assert.equal(handed.length, 2, 'the drive handed the waiting state, then the missing-input report');
  assert.equal(handed[1].field, 'missing');
  const instruction = sudoInstruction(handed[1], 'your phone', { page: LOCAL, command: 'graphyard up --sudo-code' });
  assert.match(instruction, /GitHub's code field did not appear within 10 s: the drive kept your code and tries it again/, 'the code is reported kept and unused, not consumed');
});

test('unit:sudo-code-late-field — a code handed beside a GitHub Mobile prompt, whose input renders late, is typed within 2 s of the input appearing', async () => {
  const { passSudo } = await browser();
  const clock = { at: 0 };
  // The drive chooses the authenticator view itself; GitHub renders its input 3.5 s later, after the
  // drive's own 2 s bound gave up once — the kept code is typed the moment the input is there.
  const fake = fixturePage({ renderWaits: [7], clock });
  let mobile = false;
  const base = fake.page;
  const page: BrowserPage = { ...base,
    text: () => mobile && fake.state.view === 'passkey' ? 'Confirm access\nGitHub Mobile\n42\nUse your authenticator app\nUse passkey' : base.text(),
    open(url) { mobile = false; base.open(url); },
    click(selector) { if (selector === 'a[href="/sessions/sudo?mobile=1"]') mobile = true; else base.click(selector); } };
  let reads = 0;
  const result = await passSudo(page, { flow: 'installation-accept', record: 'graphyard up', prefer: 'mobile', timeoutMs: 60_000, pollMs: 500, maxAttempts: 2, now: () => new Date(clock.at),
    readCode: () => ++reads === 3 ? { kind: 'code' as const, code: CODE, at: new Date(clock.at).toISOString() } : null,
    onCode: () => {}, sleep: async ms => { clock.at += ms; } });
  assert.equal(result.passed, true);
  assert.deepEqual(fake.state.submitted, [CODE], 'the code handed beside the prompt reached the TOTP field');
  const renderedAt = fake.state.renderedAt!;
  assert.ok(renderedAt !== null, 'the input rendered');
  const delay = fake.state.typed[0].at - renderedAt;
  assert.ok(delay >= 0 && delay <= 2_000, `the code was typed ${delay} ms after the input appeared, over its 2 s bound`);
});
