import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserPage, Located, RecordedStep, SudoState } from '../src/master-browser.js';
import type { AppCredentials } from '../src/github-setup.js';
import { controlPlanePermissions, requiredPermissions, reviewerPermissions } from '../src/github-permissions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1442: GitHub App creation no longer depends on a GitHub Mobile push arriving.
 *
 * unit:sudo-method-fallback — a recorded Confirm-access page offering a passkey, a password, or only
 * GitHub Mobile: passkey or password is handed off first, Mobile only when the page offers nothing
 * else or the operator chose it, a Mobile code unapproved for 60 s is handed off again with the
 * passkey or password link, and the recorded steps name the method used.
 *
 * unit:reuse-app-install — `--reuse-app SLUG` reuses an App saved on this host: the repository is
 * added to its installation with gh, its permissions are checked, and a control-plane App whose
 * webhook serves another install is refused by name; the App page offers the same reuse.
 */

// Loaded per test, so on a base without this change each case fails on its own assertion.
const browser = () => import('../src/master-browser.js');
const up = () => import('../src/up.js');
const githubSetup = () => import('../src/github-setup.js');
const install = () => import('../src/install/index.js');
const noSleep = async () => {};
const SUDO = 'https://github.com/sessions/sudo?return_to=%2Fsettings%2Fapps%2Fnew';
const PASSWORD_LINK = 'https://github.com/sessions/sudo?type=password';

/** A Confirm-access page offering METHODS; `confirm()` stands for the operator confirming elsewhere. */
function confirmPage(methods: { passkey?: boolean; password?: boolean; mobile?: boolean }, options: { approveMobileAfterPolls?: number } = {}) {
  const state = { sudo: true, code: null as string | null, polls: 0, clicked: [] as string[], opened: [] as string[] };
  const page: BrowserPage = {
    open(url) { state.opened.push(url); },
    url: () => state.sudo ? SUDO : 'https://github.com/settings/apps/new',
    text() {
      if (!state.sudo) return 'Register new GitHub App';
      if (state.code) {
        if (options.approveMobileAfterPolls !== undefined && ++state.polls > options.approveMobileAfterPolls) { state.sudo = false; return 'Register new GitHub App'; }
        return `Confirm access\nEnter the digits shown below in GitHub Mobile\n\n${state.code}\n\nHaving problems?\n${methods.password ? 'Use your password\n' : ''}`;
      }
      return ['Confirm access', methods.passkey ? 'Use your passkey' : '', methods.password ? 'Password\nUse your password' : '', 'Having problems?', methods.mobile ? 'Use GitHub Mobile' : ''].filter(Boolean).join('\n');
    },
    meta: () => null,
    locate(kind, text): Located | null {
      if (!state.sudo) return null;
      if (text === 'Use GitHub Mobile' && kind === 'button' && methods.mobile && !state.code) return { selector: '#mobile', tag: 'button', checked: null, value: null, text, visible: true };
      if (text === 'Use your password' && kind === 'link' && methods.password) return { selector: '#password', tag: 'a', checked: null, value: null, text, href: PASSWORD_LINK, visible: true };
      return null;
    },
    click(selector) { state.clicked.push(selector); if (selector === '#mobile') state.code = '64'; },
    setChecked() {}, select() {}, screenshot() {}, wait() {}, close() {},
  };
  return { page, state, confirm: () => { state.sudo = false; } };
}
const recorded = async (page: BrowserPage) => { const steps: RecordedStep[] = []; return { steps, page: (await browser()).recordingPage(page, { directory: '/nonexistent-record', steps, now: () => new Date(0) }) }; };
const methodSteps = (steps: RecordedStep[]) => steps.filter(step => step.action.startsWith('sudo-')).map(step => [step.action, ...step.args]);

test('unit:sudo-method-fallback — a page offering a passkey or a password hands that confirmation off first and never triggers GitHub Mobile', async () => {
  const { passSudo, sudoAttention, sudoInstruction } = await browser();
  for (const [offer, method] of [[{ passkey: true, password: true, mobile: true }, 'passkey'], [{ password: true, mobile: true }, 'password']] as const) {
    const fake = confirmPage(offer);
    const { page, steps } = await recorded(fake.page);
    const codes: SudoState[] = [];
    let polls = 0;
    const result = await passSudo(page, { flow: 'installation-accept', record: 'r', prefer: 'passkey-or-password', onCode: state => { codes.push(state); }, sleep: async () => { if (++polls === 3) fake.confirm(); }, pollMs: 10, timeoutMs: 10_000 });
    assert.deepEqual(result, { passed: true, attempts: 0, code: null });
    assert.deepEqual(fake.state.clicked, [], `${method}: GitHub Mobile was never activated`);
    assert.equal(codes.length, 1); assert.equal(codes[0].method, method); assert.equal(codes[0].url, SUDO);
    assert.equal(sudoInstruction(codes[0]), `Confirm access with your passkey or password at ${SUDO} in the Chrome profile the agent drives (GitHub ties the confirmation to that browser's session)`);
    assert.match(sudoAttention(codes[0], Date.parse(codes[0].issuedAt))!.instruction, /passkey or password at https:\/\/github\.com\/sessions\/sudo.*installation-accept flow is waiting/);
    assert.deepEqual(methodSteps(steps), [['sudo-method', method]], 'the recorded steps name the method used');
  }
});

test('unit:sudo-method-fallback — a passkey or password wait reopens the page on its interval, so a confirmation made in the agent\'s Chrome profile is seen', async () => {
  const { passSudo } = await browser();
  const fake = confirmPage({ passkey: true });
  let clock = 0;
  await passSudo(fake.page, { flow: 'installation-accept', record: 'r', prefer: 'passkey-or-password', onCode: () => {}, now: () => new Date(clock), sleep: async () => { clock += 10_000; if (clock >= 70_000) fake.confirm(); }, pollMs: 10_000, reloadMs: 30_000, timeoutMs: 600_000 });
  assert.deepEqual(fake.state.opened, [SUDO, SUDO], 'reopened at 30 s and 60 s');
});

test('unit:sudo-method-fallback — a page offering only GitHub Mobile, or an operator who chose it, triggers Mobile and records it', async () => {
  const { passSudo } = await browser();
  const only = confirmPage({ mobile: true }, { approveMobileAfterPolls: 1 });
  const { page, steps } = await recorded(only.page);
  const codes: SudoState[] = [];
  const result = await passSudo(page, { flow: 'installation-accept', record: 'r', prefer: 'passkey-or-password', onCode: state => { codes.push(state); }, sleep: noSleep, pollMs: 10, timeoutMs: 10_000 });
  assert.deepEqual(result, { passed: true, attempts: 1, code: '64' });
  assert.deepEqual(codes.map(code => [code.method, code.code]), [['mobile', '64']]);
  assert.deepEqual(methodSteps(steps), [['sudo-method', 'mobile']]);

  const chosen = confirmPage({ passkey: true, password: true, mobile: true }, { approveMobileAfterPolls: 1 });
  const chose = await recorded(chosen.page);
  assert.deepEqual(await passSudo(chose.page, { flow: 'installation-accept', record: 'r', prefer: 'mobile', onCode: () => {}, sleep: noSleep, pollMs: 10, timeoutMs: 10_000 }), { passed: true, attempts: 1, code: '64' });
  assert.deepEqual(chosen.state.clicked, ['#mobile']);
  assert.deepEqual(methodSteps(chose.steps), [['sudo-method', 'mobile']]);
});

test('unit:sudo-method-fallback — a Mobile prompt unapproved for 60 s is handed off again with the password route and its link', async () => {
  const { passSudo, sudoAttention, sudoInstruction } = await browser();
  const fake = confirmPage({ password: true, mobile: true });
  const { page, steps } = await recorded(fake.page);
  let clock = 0;
  const handed: { sentence: string; url: string | null; code: string | null }[] = [];
  const sudoStates: SudoState[] = [];
  const result = await passSudo(page, { flow: 'installation-accept', record: 'graphyard up', prefer: 'mobile', now: () => new Date(clock), onCode: state => { sudoStates.push(state); handed.push({ sentence: sudoInstruction(state), url: state.fallback?.url ?? state.url ?? null, code: state.code }); }, sleep: async () => { clock += 5_000; if (handed.length === 2) fake.confirm(); }, pollMs: 5_000, timeoutMs: 600_000 });
  assert.deepEqual(result, { passed: true, attempts: 1, code: '64' });
  assert.deepEqual(handed, [
    { sentence: 'Approve the GitHub Mobile prompt on your phone and choose 64', url: SUDO, code: '64' },
    { sentence: `Approve the GitHub Mobile prompt on your phone and choose 64, or, if no prompt arrived, confirm with your password at ${PASSWORD_LINK}`, url: PASSWORD_LINK, code: '64' },
  ]);
  assert.equal(Date.parse(sudoStates[1].issuedAt), 0); assert.ok(clock >= 60_000, 'the fallback came after a minute without approval, not before');
  assert.deepEqual(methodSteps(steps), [['sudo-method', 'mobile'], ['sudo-fallback', 'password', PASSWORD_LINK]], 'the recorded steps show Mobile was used and the password route offered');
  assert.match(sudoAttention(sudoStates[1], 1)!.instruction, /choose 64, or, if no prompt arrived, confirm with your password at https:\/\/github\.com\/sessions\/sudo\?type=password/);
});

test('unit:sudo-method-fallback — graphyard up hands the operator the passkey or password route first, and GitHub Mobile only with --github-mobile', async () => {
  const { browserAppDriver, upRequestFromArgs } = await up();
  assert.equal(upRequestFromArgs(['--repo', 'acme/shop']).sudo, undefined, 'passkey or password first by default');
  assert.equal(upRequestFromArgs(['--repo', 'acme/shop', '--github-mobile']).sudo, 'mobile');
  const controls: Record<string, Located> = {
    'button:Register Graphyard App →': { selector: '#register', tag: 'button', checked: null, value: null, text: '' },
    'button:Create GitHub App for acme': { selector: '#create', tag: 'button', checked: null, value: null, text: '' },
  };
  for (const method of ['passkey', 'password'] as const) {
    const fake = confirmPage({ [method]: true, mobile: true });
    let created = false, polls = 0;
    const page: BrowserPage = { ...fake.page,
      url: () => created && fake.state.sudo ? SUDO : 'http://127.0.0.1:4311/',
      text: () => created && fake.state.sudo ? fake.page.text() : '',
      locate: (kind, text) => created && fake.state.sudo ? fake.page.locate(kind, text) : controls[`${kind}:${text}`] ?? null,
      click: selector => { if (selector === '#create') created = true; fake.page.click(selector); } };
    const handed: { sentence: string; url: string | null }[] = [];
    const drive = browserAppDriver({ page, repository: 'acme/shop', ids: () => ({ owner: 11, repository: 22 }), sleep: async () => { if (++polls === 2) fake.confirm(); } });
    assert.deepEqual(await drive('http://127.0.0.1:4311', (sentence, link) => { handed.push({ sentence, url: link.url ?? null }); }), { state: 'done' });
    assert.deepEqual(handed, [{ sentence: `Confirm access with your passkey or password at ${SUDO} in the Chrome profile the agent drives (GitHub ties the confirmation to that browser's session)`, url: SUDO }], method);
    assert.ok(!fake.state.clicked.includes('#mobile'), `${method}: GitHub Mobile is only the operator's choice`);
  }
});

// ---- Reusing an existing App -----------------------------------------------------------------

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

interface FakeGitHub { appId: number; hook: string; registered: Record<string, string>; granted: Record<string, string>; selection: 'all' | 'selected'; account: string; repositories: string[]; calls: string[] }
function fakeGitHub(overrides: Partial<FakeGitHub> = {}) {
  const github: FakeGitHub = { appId: 7001, hook: '', registered: requiredPermissions(controlPlanePermissions), granted: requiredPermissions(controlPlanePermissions), selection: 'selected', account: 'acme', repositories: ['acme/api'], calls: [], ...overrides };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    github.calls.push(`${method} ${url.pathname}`);
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
    if (url.pathname === '/app') return json({ id: github.appId, slug: 'graphyard-acme-api', owner: { login: 'acme', type: 'Organization' }, permissions: github.registered });
    if (url.pathname === '/app/hook/config') return json({ url: github.hook, content_type: 'json' });
    if (url.pathname === '/app/installations') return json([{ id: 8001, account: { login: github.account }, permissions: github.granted, repository_selection: github.selection, suspended_at: null }]);
    if (url.pathname === '/app/installations/8001/access_tokens' && method === 'POST') return json({ token: 'installation-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (url.pathname.startsWith('/repos/') && auth === 'Bearer installation-token') {
      const name = url.pathname.slice('/repos/'.length);
      return github.selection === 'all' || github.repositories.includes(name) ? json({ full_name: name }) : json({ message: 'Not Found' }, 404);
    }
    return json({ message: `no route ${method} ${url.pathname}` }, 404);
  }) as typeof fetch;
  const gh = async (args: string[]) => {
    github.calls.push(`gh ${args.join(' ')}`);
    if (args[0] === 'api' && args[1] === 'repos/acme/shop') return JSON.stringify({ id: 9002, full_name: 'acme/shop', owner: { login: 'acme' } });
    if (args.join(' ') === 'api --method PUT /user/installations/8001/repositories/9002') { github.repositories.push('acme/shop'); return ''; }
    throw new Error(`gh has no route ${args.join(' ')}`);
  };
  return { github, fetcher, gh };
}
const savedApp = (extra: Partial<AppCredentials> = {}): AppCredentials => ({ appId: 7001, slug: 'graphyard-acme-api', privateKey, webhookSecret: 'saved-webhook-secret', repository: 'acme/api', installationId: 8001, ...extra });
async function savedOnHost(apps: Record<string, AppCredentials>) {
  const home = await temporaryDirectory('reuse-app-home');
  for (const [file, app] of Object.entries(apps)) {
    const directory = join(home, file.split('/')[0]);
    await mkdir(directory, { recursive: true });
    await writeFile(join(home, file), JSON.stringify(app), { mode: 0o600 });
  }
  return home;
}

test('unit:reuse-app-install — reusing an App saved on this host adds the repository to its installation with gh and verifies the App reaches it', async () => {
  const { reuseExistingApp, savedRegistrations } = await githubSetup();
  const { installRequestFromArgs, resumeCommand } = await install();
  const { upRequestFromArgs } = await up();
  const home = await savedOnHost({ 'acme-api/github-app.json': savedApp(), 'acme-api/github-reviewer-claude.json': savedApp({ appId: 7002, slug: 'acme-api-review-claude', reviewer: 'claude', botUserId: 99 }) });
  try {
    const registrations = await savedRegistrations([join(home, 'acme-api'), join(home, 'missing')]);
    assert.deepEqual(registrations.map(entry => [entry.app.slug, entry.role]), [['graphyard-acme-api', 'control-plane'], ['acme-api-review-claude', 'reviewer']]);
    const { github, fetcher, gh } = fakeGitHub();
    const plan = await reuseExistingApp({ slug: 'graphyard-acme-api', role: 'control-plane', repository: 'acme/shop', registrations, gh, fetcher, apply: false });
    assert.equal(plan.added, false); assert.equal(plan.selection, 'selected'); assert.deepEqual(github.repositories, ['acme/api'], 'the plan reads only');
    const applied = await reuseExistingApp({ slug: 'graphyard-acme-api', role: 'control-plane', repository: 'acme/shop', registrations, webhookUrl: 'http://127.0.0.1:4320/api/github/webhook', gh, fetcher, apply: true });
    assert.equal(applied.added, true);
    assert.deepEqual(github.repositories, ['acme/api', 'acme/shop'], 'the repository was added to the existing installation');
    assert.ok(github.calls.includes('gh api --method PUT /user/installations/8001/repositories/9002'), 'added through the API with the host\'s gh login');
    assert.ok(github.calls.includes('GET /repos/acme/shop'), 'the App\'s own token reaches the repository');
    assert.deepEqual({ ...applied.app, privateKey: '' }, { ...savedApp(), privateKey: '', repository: 'acme/shop', installationId: 8001 });
    // An installation on every repository needs nothing added.
    const all = fakeGitHub({ selection: 'all' });
    assert.equal((await reuseExistingApp({ slug: 'graphyard-acme-api', role: 'control-plane', repository: 'acme/shop', registrations, gh: all.gh, fetcher: all.fetcher, apply: true })).added, false);
    // A reviewer App is held to the reviewer declaration and has no webhook to check.
    const reviewer = fakeGitHub({ appId: 7002, registered: requiredPermissions(reviewerPermissions), granted: requiredPermissions(reviewerPermissions), hook: 'https://elsewhere.example/api/github/webhook' });
    const reused = await reuseExistingApp({ slug: 'acme-api-review-claude', role: 'reviewer', repository: 'acme/shop', registrations, gh: reviewer.gh, fetcher: reviewer.fetcher, apply: true });
    assert.equal(reused.app.botUserId, 99); assert.ok(!reviewer.github.calls.includes('GET /app/hook/config'));
    // install --reuse-app and up --reuse-app carry the slug through the resume command and on to install.
    const { request } = installRequestFromArgs(['--provider', 'compose', '--repo', 'acme/shop', '--reuse-app', 'graphyard-acme-api', '--reuse-app', 'acme-api-review-claude']);
    assert.deepEqual(request.reuseApps, ['graphyard-acme-api', 'acme-api-review-claude']);
    assert.match(resumeCommand({ inputs: { baseBranch: 'main', ...request } as any }), /--reuse-app graphyard-acme-api --reuse-app acme-api-review-claude --apply$/);
    assert.throws(() => installRequestFromArgs(['--provider', 'compose', '--repo', 'acme/shop', '--reuse-app', '../app']), /App slug/);
    assert.deepEqual(upRequestFromArgs(['--repo', 'acme/shop', '--reuse-app', 'graphyard-acme-api']).reuseApps, ['graphyard-acme-api']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('unit:reuse-app-install — an App missing a permission the role needs, or not granted it, is refused before anything is added', async () => {
  const { reuseExistingApp, savedRegistrations } = await githubSetup();
  const home = await savedOnHost({ 'acme-api/github-app.json': savedApp() });
  try {
    const registrations = await savedRegistrations([join(home, 'acme-api')]);
    const { contents: _contents, ...withoutContents } = requiredPermissions(controlPlanePermissions);
    const requested = fakeGitHub({ registered: withoutContents });
    await assert.rejects(reuseExistingApp({ slug: 'graphyard-acme-api', role: 'control-plane', repository: 'acme/shop', registrations, gh: requested.gh, fetcher: requested.fetcher, apply: true }), /App graphyard-acme-api does not request Contents: write, which the control-plane role needs; raise it at https:\/\/github\.com\/settings\/apps\/graphyard-acme-api\/permissions/);
    assert.deepEqual(requested.github.repositories, ['acme/api'], 'nothing was added');
    const granted = fakeGitHub({ granted: { ...requiredPermissions(controlPlanePermissions), contents: 'read' } });
    await assert.rejects(reuseExistingApp({ slug: 'graphyard-acme-api', role: 'control-plane', repository: 'acme/shop', registrations, gh: granted.gh, fetcher: granted.fetcher, apply: true }), /installation on acme does not grant Contents: write; accept the pending permission request/);
    assert.deepEqual(granted.github.repositories, ['acme/api']);
    const elsewhere = fakeGitHub({ account: 'other-org' });
    await assert.rejects(reuseExistingApp({ slug: 'graphyard-acme-api', role: 'control-plane', repository: 'acme/shop', registrations, gh: elsewhere.gh, fetcher: elsewhere.fetcher, apply: true }), /not installed on acme; install it there at https:\/\/github\.com\/apps\/graphyard-acme-api\/installations\/new/);
    await assert.rejects(reuseExistingApp({ slug: 'graphyard-unknown', role: 'control-plane', repository: 'acme/shop', registrations, gh: elsewhere.gh, fetcher: elsewhere.fetcher, apply: false }), /No registration for App graphyard-unknown is saved on this host.*\(graphyard-acme-api\)/);
    await assert.rejects(reuseExistingApp({ slug: 'graphyard-acme-api', role: 'reviewer', repository: 'acme/shop', registrations, gh: elsewhere.gh, fetcher: elsewhere.fetcher, apply: false }), /registered as a control-plane App and cannot serve as the reviewer App/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('unit:reuse-app-install — a reviewer App holding more than its declaration is refused, naming the excess; two Apps for one role are refused', async () => {
  const { reuseExistingApp, savedRegistrations } = await githubSetup();
  const { reusedForRole } = await install();
  const home = await savedOnHost({ 'acme-api/github-app.json': savedApp(), 'acme-api/github-reviewer-claude.json': savedApp({ appId: 7002, slug: 'acme-api-review-claude', reviewer: 'claude' }), 'acme-web/github-reviewer-codex.json': savedApp({ appId: 7003, slug: 'acme-web-review-codex', reviewer: 'codex' }) });
  try {
    const registrations = await savedRegistrations([join(home, 'acme-api'), join(home, 'acme-web')]);
    const reviewer = requiredPermissions(reviewerPermissions);
    // A reviewer App whose registration requests Contents: write could write code: refused before anything is added.
    const registered = fakeGitHub({ appId: 7002, registered: { ...reviewer, contents: 'write' }, granted: reviewer });
    await assert.rejects(reuseExistingApp({ slug: 'acme-api-review-claude', role: 'reviewer', repository: 'acme/shop', registrations, gh: registered.gh, fetcher: registered.fetcher, apply: true }), /App acme-api-review-claude holds Contents: write, beyond the reviewer declaration; a reviewer App must never hold more than its declaration/);
    assert.deepEqual(registered.github.repositories, ['acme/api'], 'nothing was added');
    // An installation granting Checks: write could publish Graphyard's gate check: refused, naming the installation.
    const granted = fakeGitHub({ appId: 7002, registered: reviewer, granted: { ...reviewer, checks: 'write' } });
    await assert.rejects(reuseExistingApp({ slug: 'acme-api-review-claude', role: 'reviewer', repository: 'acme/shop', registrations, gh: granted.gh, fetcher: granted.fetcher, apply: true }), /App acme-api-review-claude's installation on acme holds Checks: write, beyond the reviewer declaration/);
    assert.deepEqual(granted.github.repositories, ['acme/api']);
    // A control-plane App needs Contents: write; holding it is no excess.
    assert.equal((await reuseExistingApp({ slug: 'graphyard-acme-api', role: 'control-plane', repository: 'acme/shop', registrations, ...fakeGitHub(), apply: false })).added, false);
    // Two reviewer slugs: both are named for refusal rather than the second silently dropped.
    assert.deepEqual(reusedForRole(['graphyard-acme-api', 'acme-api-review-claude', 'acme-web-review-codex'], registrations, 'reviewer'), ['acme-api-review-claude', 'acme-web-review-codex']);
    assert.deepEqual(reusedForRole(['graphyard-acme-api', 'acme-api-review-claude'], registrations, 'control-plane'), ['graphyard-acme-api']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('unit:reuse-app-install — a control-plane App bound to another install\'s control plane is refused, naming the App and its webhook', async () => {
  const { reuseExistingApp, savedRegistrations } = await githubSetup();
  const home = await savedOnHost({ 'acme-api/github-app.json': savedApp() });
  try {
    const registrations = await savedRegistrations([join(home, 'acme-api')]);
    const bound = fakeGitHub({ hook: 'https://graphyard.acme.example/api/github/webhook' });
    await assert.rejects(reuseExistingApp({ slug: 'graphyard-acme-api', role: 'control-plane', repository: 'acme/shop', registrations, webhookUrl: 'http://127.0.0.1:4320/api/github/webhook', gh: bound.gh, fetcher: bound.fetcher, apply: true }),
      /App graphyard-acme-api is bound to another install's control plane: its webhook delivers to https:\/\/graphyard\.acme\.example\/api\/github\/webhook/);
    assert.deepEqual(bound.github.repositories, ['acme/api'], 'nothing was added');
    assert.ok(!bound.github.calls.some(call => call.includes('PUT')));
    // The same App whose webhook is this install's own (a rerun) is reused.
    const own = fakeGitHub({ hook: 'http://127.0.0.1:4320/api/github/webhook' });
    assert.equal((await reuseExistingApp({ slug: 'graphyard-acme-api', role: 'control-plane', repository: 'acme/shop', registrations, webhookUrl: 'http://127.0.0.1:4320/api/github/webhook', gh: own.gh, fetcher: own.fetcher, apply: true })).added, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('unit:reuse-app-install — the App page offers the reuse, shows a refusal by name, and saves the reused App as installed', async () => {
  const { startGithubSetup } = await githubSetup();
  const root = await temporaryDirectory('reuse-app-page');
  execFileSync('git', ['init', '-q'], { cwd: root });
  let refuse = true;
  const reused: string[] = [];
  const setup = await startGithubSetup(root, 'acme/shop', 'http://127.0.0.1:4320', 0, {
    reusable: ['graphyard-acme-api'],
    reuse: async slug => {
      reused.push(slug);
      if (refuse) throw new Error('App graphyard-acme-api is bound to another install\'s control plane: its webhook delivers to https://graphyard.acme.example/api/github/webhook.');
      return { ...savedApp(), repository: 'acme/shop', installationId: 8001 };
    },
  });
  try {
    const page = await (await fetch(setup.url)).text();
    assert.match(page, /Or reuse an App you already have/); assert.match(page, /<option value="graphyard-acme-api">/);
    const state = page.match(/name="state" value="([a-f0-9]+)"/)![1];
    assert.equal((await fetch(`${setup.url}/reuse?state=wrong&slug=graphyard-acme-api`)).status, 409);
    assert.equal((await fetch(`${setup.url}/reuse?state=${state}&slug=not-offered`)).status, 400);
    const refused = await fetch(`${setup.url}/reuse?state=${state}&slug=graphyard-acme-api`);
    assert.equal(refused.status, 409); assert.match(await refused.text(), /graphyard-acme-api is bound to another install&#39;s control plane|graphyard-acme-api is bound to another install's control plane/);
    refuse = false;
    const done = await (await fetch(`${setup.url}/reuse?state=${state}&slug=graphyard-acme-api`)).text();
    assert.match(done, /installation verified/); assert.doesNotMatch(done, /PRIVATE KEY/);
    const saved = JSON.parse(await readFile(setup.file, 'utf8'));
    assert.equal(saved.installationId, 8001); assert.equal(saved.repository, 'acme/shop'); assert.equal((await stat(setup.file)).mode & 0o777, 0o600);
    assert.deepEqual(reused, ['graphyard-acme-api', 'graphyard-acme-api']);
  } finally { await new Promise<void>(accept => setup.http.close(() => accept())); await rm(root, { recursive: true, force: true }); }
});
