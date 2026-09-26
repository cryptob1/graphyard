import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadMasterConfig, managedMasterInstructions, masterConfigSchema, masterHarness, setupMaster, type MasterConfig } from '../src/master.js';
import { masterHarnessPlan, writeHarnessPermissions } from '../src/harness.js';
import { agentBrowserArguments, agentBrowserPage, appendAdministrationEntry, browserFlows, controlPlanePermissions, detectSudo, missingPermissions, passSudo, readAdministrationLedger, readSudoState, recordingPage, runBrowserFlow, sudoAttention, summarizeAdministration, type BrowserPage, type Located, type SudoState } from '../src/master-browser.js';
import type { Work } from '../src/model.js';
import { readMasterGuide } from './helpers/master-guide.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const execFile = promisify(execFileCallback);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));

async function master(browser = { profile: 'Default' }) {
  const root = await temporaryDirectory('browser'), credentialDirectory = await temporaryDirectory('browser-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, browser }, coordinatorStatus as typeof fetch);
  const config = await loadMasterConfig(root);
  return { root, config, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}
function work(overrides: Partial<Work> = {}) {
  return { id: 'work-id', key: 'GY-42', title: 'Prove the browser flow', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [], policy: { checks: ['test'], review: true, reviewProvider: 'agent' }, plannedFiles: [],
    stage: 'review', revision: 1, policyRevision: 1, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], observation: null, ...overrides } as unknown as Work;
}

/**
 * A stub of the GitHub pages the flows touch: the App permissions form, the installation
 * permission request, the branch list and classic rule form, and the Confirm-access interstitial
 * that any of them may redirect to. State changes only when the flow submits a form, exactly as
 * the real pages behave, and the API stub reads the same state.
 */
class StubGitHub {
  app: Record<string, string> = { metadata: 'read', contents: 'read', pull_requests: 'write', issues: 'read', checks: 'write', administration: 'read' };
  installation: Record<string, string> = { ...this.app };
  pendingRequest = false;
  protection = { required_approving_review_count: 1, require_last_push_approval: true, dismiss_stale_reviews: true, strict: true, enforce_admins: true, hasCheck: true, hasRule: true };
  // pending: navigations that hit Confirm access; approveAfterPolls: URL reads after a code is
  // issued before the operator's approval lands; expireAfterPolls: reads before that code expires.
  sudo = { pending: 0, approveAfterPolls: 1, expireAfterPolls: 0, polls: 0, code: 41, offerMobile: true, expired: false };
  login: string | null = 'operator';
  visited: string[] = [];
  private current = ''; private form: Record<string, string> = {}; private sudoActive = false; private sudoCode: string | null = null; private returnTo = '';
  shots = 0;
  page(): BrowserPage {
    const self = this;
    return {
      open(url) { self.visited.push(url); self.navigate(url); },
      url() { self.poll(); return self.sudoActive ? `https://github.com/sessions/sudo?return_to=${encodeURIComponent(self.current)}` : self.current; },
      text() { return self.render(); },
      meta(name) { return name === 'user-login' ? self.login : null; },
      locate(kind, text) { return self.find(kind, text); },
      click(selector) { self.act(selector); },
      setChecked(selector, checked) { self.form[selector.replace(/^#/, '')] = checked ? 'on' : 'off'; },
      select(selector, value) { self.form[selector.replace(/^#/, '')] = value; },
      screenshot(file) { self.shots += 1; writeFileSync(file, 'png'); },
      wait() {},
      close() { self.visited.push('close'); },
    };
  }
  private navigate(url: string) {
    if (!this.login) { this.current = 'https://github.com/login'; return; }
    this.current = url; this.form = {};
    if (this.sudo.pending > 0) { this.sudo.pending -= 1; this.sudoActive = true; this.sudoCode = null; this.sudo.polls = 0; this.sudo.expired = false; }
  }
  private poll() {
    if (!this.sudoActive || !this.sudoCode) return;
    this.sudo.polls += 1;
    if (this.sudo.expireAfterPolls && this.sudo.polls >= this.sudo.expireAfterPolls) { this.sudoCode = null; this.sudo.expired = true; this.sudo.expireAfterPolls = 0; }
    else if (this.sudo.polls > this.sudo.approveAfterPolls) { this.sudoActive = false; this.sudoCode = null; }
  }
  private render() {
    if (this.sudoActive) {
      if (this.sudoCode) return `Confirm access\n\nApprove on GitHub Mobile\nEnter the digits shown below in the GitHub Mobile app\n\n${this.sudoCode}\n\nDidn't receive a notification? Resend`;
      if (this.sudo.expired) return `Confirm access\n\nYour GitHub Mobile request expired. Try again\n${this.sudo.offerMobile ? 'Use GitHub Mobile\n' : ''}`;
      return `Confirm access\n\nVerify with your device\n${this.sudo.offerMobile ? 'Use GitHub Mobile\n' : ''}Use your password`;
    }
    if (this.current.includes('/settings/apps/')) return 'Permissions & events\nRepository permissions\nContents\nSave changes';
    if (this.current.includes('/permissions/update')) return this.pendingRequest ? 'Review permission request\nAccept new permissions' : 'This installation has no pending permission request';
    if (this.current.endsWith('/settings/branches')) return this.protection.hasRule ? 'Branch protection rules\nmain\nEdit' : 'No branch protection rules';
    if (this.current.includes('/branch_protection_rules/')) return 'Protect matching branches\nSave changes';
    return 'GitHub';
  }
  private find(kind: string, text: string): Located | null {
    const located = (id: string, extra: Partial<Located> = {}): Located => ({ selector: `#${id}`, tag: 'input', checked: null, value: null, text, ...extra });
    if (this.sudoActive) {
      if (kind === 'button' && text === 'Use GitHub Mobile' && this.sudo.offerMobile && !this.sudoCode) return located('mobile', { tag: 'button' });
      if (kind === 'button' && text === 'Try again' && this.sudo.expired) return located('retry', { tag: 'button' });
      return null;
    }
    if (this.current.includes('/settings/apps/')) {
      const match = /^integration\[default_permissions\]\[(\w+)\]$/.exec(text);
      if (kind === 'field' && match && match[1] in this.app) return located(`permission-${match[1]}`, { tag: 'select', value: this.app[match[1]] });
      if (kind === 'button' && text === 'Save changes') return located('save-app', { tag: 'button' });
      return null;
    }
    if (this.current.includes('/permissions/update')) return kind === 'button' && text === 'Accept new permissions' && this.pendingRequest ? located('accept', { tag: 'button' }) : null;
    if (this.current.endsWith('/settings/branches')) return kind === 'link' && text === 'main' && this.protection.hasRule ? located('rule', { tag: 'a' }) : null;
    if (this.current.includes('/branch_protection_rules/')) {
      const p = this.protection;
      const boxes: Record<string, boolean> = { 'Require a pull request before merging': true, 'Dismiss stale pull request approvals when new commits are pushed': p.dismiss_stale_reviews, 'Require approval of the most recent reviewable push': p.require_last_push_approval, 'Require status checks to pass before merging': true, 'Require branches to be up to date before merging': p.strict, 'Do not allow bypassing the above settings': p.enforce_admins };
      if (kind === 'label' && text in boxes) return located(text.replace(/\W+/g, '-'), { checked: this.form[text.replace(/\W+/g, '-')] ? this.form[text.replace(/\W+/g, '-')] === 'on' : boxes[text] });
      if (kind === 'label' && text === 'Required number of approvals before merging') return located('approvals', { tag: 'select', value: this.form.approvals ?? String(p.required_approving_review_count) });
      if (kind === 'button' && text === 'Save changes') return located('save-rule', { tag: 'button' });
    }
    return null;
  }
  private act(selector: string) {
    if (selector === '#mobile' || selector === '#retry') { this.sudoCode = String(this.sudo.code++); this.sudo.polls = 0; this.sudo.expired = false; return; }
    if (selector === '#save-app') {
      for (const [id, value] of Object.entries(this.form)) if (id.startsWith('permission-')) { this.app[id.slice('permission-'.length)] = value; this.pendingRequest = true; }
      return;
    }
    if (selector === '#accept') { this.installation = { ...this.app }; this.pendingRequest = false; return; }
    if (selector === '#rule') { this.navigate('https://github.com/owner/project/settings/branch_protection_rules/7'); return; }
    if (selector === '#save-rule') {
      const on = (label: string, current: boolean) => { const value = this.form[label.replace(/\W+/g, '-')]; return value ? value === 'on' : current; };
      this.protection = { ...this.protection, strict: on('Require branches to be up to date before merging', this.protection.strict), enforce_admins: on('Do not allow bypassing the above settings', this.protection.enforce_admins),
        dismiss_stale_reviews: on('Dismiss stale pull request approvals when new commits are pushed', this.protection.dismiss_stale_reviews), require_last_push_approval: on('Require approval of the most recent reviewable push', this.protection.require_last_push_approval),
        required_approving_review_count: Number(this.form.approvals ?? this.protection.required_approving_review_count) };
      return;
    }
    throw new Error(`stub page has no element ${selector}`);
  }
  api = (_command: string, args: string[]): string => {
    const path = args[args.indexOf('api') + 1];
    if (path === 'user') return JSON.stringify({ login: 'operator-cli' });
    if (path.startsWith('user/installations')) return JSON.stringify({ installations: [{ id: 91011, app_id: 1234, app_slug: 'graphyard-owner-project', account: { login: 'owner', type: 'User' }, permissions: this.installation }, { id: 5, app_id: 99, app_slug: 'other', permissions: {} }] });
    if (path.startsWith('apps/')) return JSON.stringify({ slug: 'graphyard-owner-project', permissions: this.app });
    if (path.endsWith('/protection')) return JSON.stringify({ required_pull_request_reviews: { required_approving_review_count: this.protection.required_approving_review_count, require_last_push_approval: this.protection.require_last_push_approval, dismiss_stale_reviews: this.protection.dismiss_stale_reviews },
      required_status_checks: { strict: this.protection.strict, checks: this.protection.hasCheck ? [{ context: 'Graphyard / merge', app_id: 1234 }] : [] }, enforce_admins: { enabled: this.protection.enforce_admins }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } });
    throw new Error(`stub API has no route ${path}`);
  };
}
const noSleep = async () => {};

test('a Confirm-access page is recognized with its pairing code, and nothing else is', () => {
  assert.equal(detectSudo('https://github.com/settings/apps/x/permissions', 'Permissions & events\nSave changes').sudo, false);
  assert.equal(detectSudo('https://github.com/owner/project', 'Confirm access to the merge queue\n42').sudo, false, 'plain page text mentioning access is not the interstitial');
  const plain = detectSudo('https://github.com/sessions/sudo?return_to=%2Fsettings', 'Confirm access\nUse GitHub Mobile\nUse your password');
  assert.deepEqual(plain, { sudo: true, code: null, expired: false, mobileOffered: true });
  const coded = detectSudo('https://github.com/sessions/sudo', 'Confirm access\nEnter the digits shown below\n\n  73  \n\nDidn\'t receive a notification? Resend');
  assert.equal(coded.code, '73'); assert.equal(coded.expired, true, 'the resend offer is visible while the code is shown, so it never counts as expiry on its own');
  assert.equal(detectSudo('https://github.com/sessions/sudo', 'Confirm access\nYour request expired. Try again\nUse GitHub Mobile').code, null);
  assert.equal(detectSudo('https://github.com/x', 'Confirm access\nUse your password\n2026').code, null, 'a four-digit year is not a pairing code');
});

test('sudo mode triggers GitHub Mobile, surfaces the code, waits with a bounded retry, and settles', async () => {
  const github = new StubGitHub();
  github.sudo.pending = 1; github.sudo.approveAfterPolls = 2;
  const page = github.page();
  page.open('https://github.com/settings/apps/graphyard-owner-project/permissions');
  const codes: SudoState[] = []; const settled: SudoState[] = [];
  const result = await passSudo(page, { flow: 'app-permissions', record: 'r', onCode: state => { codes.push(state); }, onSettled: state => { settled.push(state); }, sleep: noSleep, pollMs: 10, timeoutMs: 10_000 });
  assert.equal(result.passed, true); assert.equal(result.code, '41'); assert.equal(result.attempts, 1);
  assert.equal(codes.length, 1); assert.equal(codes[0].code, '41'); assert.equal(codes[0].state, 'waiting'); assert.equal(codes[0].attempt, 1);
  assert.equal(settled[0].state, 'approved');
  assert.equal(page.url(), 'https://github.com/settings/apps/graphyard-owner-project/permissions', 'the flow resumes on the page it was sent to');
  const attention = sudoAttention(codes[0], Date.parse(codes[0].issuedAt));
  assert.match(attention!.instruction, /choose 41/); assert.match(attention!.instruction, /app-permissions/);
  assert.equal(sudoAttention(settled[0]), null, 'an approved prompt needs no attention');
  assert.match(sudoAttention(codes[0], Date.parse(codes[0].deadline) + 1)!.instruction, /timed out/);

  // A page that does not need confirmation passes straight through.
  const clean = new StubGitHub(); const cleanPage = clean.page(); cleanPage.open('https://github.com/owner/project/settings/branches');
  assert.deepEqual(await passSudo(cleanPage, { flow: 'protection', record: 'r', onCode: () => assert.fail('no code expected'), sleep: noSleep }), { passed: false, attempts: 0, code: null });

  // An expired code is re-issued, and the new code is surfaced again.
  const expiring = new StubGitHub(); expiring.sudo.pending = 1; expiring.sudo.approveAfterPolls = 2; expiring.sudo.expireAfterPolls = 2; expiring.sudo.offerMobile = false;
  const expiringPage = expiring.page(); expiringPage.open('https://github.com/settings/installations/91011/permissions/update');
  const reissued: (string | null)[] = [];
  await assert.rejects(passSudo(expiringPage, { flow: 'installation-accept', record: 'r', onCode: () => {}, sleep: noSleep }), /only GitHub Mobile confirmation is automated/, 'a first prompt without GitHub Mobile is refused');
  expiring.sudo.offerMobile = true;
  const retry = await passSudo(expiringPage, { flow: 'installation-accept', record: 'r', onCode: state => { reissued.push(state.code); }, sleep: noSleep, pollMs: 10, timeoutMs: 10_000, maxAttempts: 3 });
  assert.equal(retry.passed, true); assert.equal(retry.attempts, 2, 'the expired code was re-issued once'); assert.deepEqual(reissued, ['41', '42']);
  // Re-issues are bounded.
  const stubborn = new StubGitHub(); stubborn.sudo.pending = 1; stubborn.sudo.approveAfterPolls = 100; stubborn.sudo.expireAfterPolls = 1;
  const stubbornPage = stubborn.page(); stubbornPage.open('https://github.com/settings/installations/91011/permissions/update');
  const stubbornRun = passSudo(stubbornPage, { flow: 'installation-accept', record: 'r', onCode: () => { stubborn.sudo.expireAfterPolls = 1; }, sleep: noSleep, pollMs: 10, timeoutMs: 60_000, maxAttempts: 2 });
  await assert.rejects(stubbornRun, /re-issued 2 times without approval/);

  // The wait is bounded: a prompt nobody approves fails with the code and the rerun command.
  const ignored = new StubGitHub(); ignored.sudo.pending = 1; ignored.sudo.approveAfterPolls = 1_000_000;
  const ignoredPage = ignored.page(); ignoredPage.open('https://github.com/owner/project/settings/branches');
  let clock = 0; const now = () => new Date(clock);
  const outcomes: string[] = [];
  await assert.rejects(passSudo(ignoredPage, { flow: 'protection', record: 'r', onCode: () => {}, onSettled: state => { outcomes.push(state.state); }, sleep: async () => { clock += 1_000; }, now, pollMs: 1_000, timeoutMs: 5_000 }), /not approved within 5s.*code 41.*master browser protection/);
  assert.deepEqual(outcomes, ['expired']);
});

test('the browser flows administer GitHub through the recorded page, verify via the API, and audit each action', async () => {
  const { root, config, cleanup } = await master();
  try {
    const github = new StubGitHub();
    github.sudo.pending = 1;
    let tick = Date.parse('2026-09-18T12:00:00Z'); const now = () => new Date(tick += 1_000);
    const common = { api: github.api, coordinator: 'master', now, sleep: noSleep, sudo: { pollMs: 10, timeoutMs: 10_000 } };

    const permissions = await runBrowserFlow(root, config, 'app-permissions', { page: github.page(), ...common });
    assert.equal(permissions.outcome, 'applied'); assert.equal(permissions.verified, true);
    assert.deepEqual(github.app, controlPlanePermissions, 'the App now requests every control-plane permission');
    assert.equal(github.visited[0], 'https://github.com/settings/apps/graphyard-owner-project/permissions');
    assert.deepEqual(permissions.sudo, { attempts: 1, code: '41' }, 'the Confirm-access interstitial was passed through GitHub Mobile');
    assert.equal(permissions.actor.browser, 'operator'); assert.equal(permissions.actor.cli, 'operator-cli'); assert.equal(permissions.actor.coordinator, 'master'); assert.equal(permissions.actor.profile, 'Default');
    assert.deepEqual(permissions.target, { repository: 'owner/project', appId: 1234, slug: 'graphyard-owner-project', installationId: 91011 });
    assert.equal((permissions.before as any).app.contents, 'read'); assert.equal((permissions.after as any).app.contents, 'write');
    assert.match(permissions.next, /installation-accept/);
    const record = JSON.parse(await readFile(join(root, permissions.record, 'record.json'), 'utf8'));
    assert.equal(record.steps.length, permissions.steps); assert.ok(record.steps.some((step: any) => step.action === 'select' && step.args[1] === 'write'));
    assert.ok(record.steps.some((step: any) => step.action === 'click' && step.args[0] === '#save-app'), 'the form was submitted');
    const screenshots = (await readdir(join(root, permissions.record))).filter(name => name.endsWith('.png'));
    assert.equal(screenshots.length, permissions.screenshots); assert.ok(permissions.screenshots >= 3, 'every navigation and mutation is captured');
    assert.equal(await readSudoState(root), null, 'an approved sudo prompt leaves no pending state');
    assert.equal(github.visited.at(-1), 'close', 'the browser session is closed after the flow');

    const accepted = await runBrowserFlow(root, config, 'installation-accept', { page: github.page(), ...common });
    assert.equal(accepted.outcome, 'applied'); assert.equal(accepted.verified, true);
    assert.deepEqual(github.installation, controlPlanePermissions); assert.equal(github.pendingRequest, false);
    assert.equal(github.visited.at(-2), 'https://github.com/settings/installations/91011/permissions/update');
    assert.equal(accepted.sudo, null);
    assert.equal((await runBrowserFlow(root, config, 'installation-accept', { page: github.page(), ...common })).outcome, 'unchanged', 'a granted installation is left alone');

    const item = work();
    const protection = await runBrowserFlow(root, config, 'protection', { page: github.page(), work: [item], ...common });
    assert.equal(protection.outcome, 'applied', protection.reason); assert.equal(protection.verified, true);
    assert.equal(github.protection.strict, false); assert.equal(github.protection.required_approving_review_count, 0); assert.equal(github.protection.require_last_push_approval, false); assert.equal(github.protection.enforce_admins, true);
    assert.deepEqual(protection.target, { repository: 'owner/project', appId: 1234, branch: 'main', mode: 'agent' });
    assert.equal((protection.before as any).strictOff, false); assert.equal((protection.after as any).strictOff, true);
    const dry = await runBrowserFlow(root, config, 'protection', { page: github.page(), work: [work({ policy: { checks: ['test'], review: true } as any })], dryRun: true, ...common });
    assert.equal(dry.outcome, 'unchanged'); assert.match(dry.reason!, /Dry run; would change required_approving_review_count 0 to 1/);
    assert.equal(github.protection.required_approving_review_count, 0, 'a dry run changes nothing');

    const ledger = await readAdministrationLedger(root);
    assert.deepEqual(ledger.entries.map(entry => [entry.flow, entry.outcome]), [['app-permissions', 'applied'], ['installation-accept', 'applied'], ['installation-accept', 'unchanged'], ['protection', 'applied'], ['protection', 'unchanged']]);
    assert.equal((await stat(join(root, '.graphyard/master-actions/ledger.json'))).mode & 0o777, 0o600);
    for (const entry of ledger.entries) { assert.ok(entry.startedAt < entry.completedAt); assert.equal(entry.actor.host, config.hostId); assert.ok((await stat(join(root, entry.record, 'record.json'))).isFile()); }
    await assert.rejects(appendAdministrationEntry(root, ledger.entries[0]), /immutable/);
    const summary = summarizeAdministration(ledger.entries, null);
    assert.equal(summary.total, 5); assert.equal(summary.recent[0].flow, 'protection'); assert.equal(summary.recent[0].by, 'operator-cli', 'a flow decided from the API is attributed to the CLI identity'); assert.equal(summary.recent[1].by, 'operator', 'a flow that drove the browser is attributed to the signed-in profile'); assert.equal(summary.sudo, null);
  } finally { await cleanup(); }
});

test('a flow that cannot find its page, verify its result, or sign in refuses with a recorded, audited reason', async () => {
  const { root, config, cleanup } = await master();
  try {
    const github = new StubGitHub();
    github.protection.hasRule = false;
    const common = { api: github.api, sleep: noSleep, sudo: { pollMs: 10, timeoutMs: 10_000 } };
    const missingRule = await runBrowserFlow(root, config, 'protection', { page: github.page(), work: [work()], ...common });
    assert.equal(missingRule.outcome, 'refused'); assert.match(missingRule.reason!, /classic protection rule for main/); assert.match(missingRule.next, /record\.json/);
    github.protection.hasRule = true; github.protection.hasCheck = false;
    const missingCheck = await runBrowserFlow(root, config, 'protection', { page: github.page(), work: [work()], ...common });
    assert.equal(missingCheck.outcome, 'refused'); assert.match(missingCheck.reason!, /Graphyard \/ merge/);
    assert.equal(github.visited.filter(url => url.startsWith('https://')).length, 1, 'a refusal decided from the API opens no page');
    github.protection.hasCheck = true;
    const appBehind = await runBrowserFlow(root, config, 'installation-accept', { page: github.page(), ...common });
    assert.equal(appBehind.outcome, 'refused'); assert.match(appBehind.reason!, /run master browser app-permissions first/);
    github.app.contents = 'write';
    const notPending = await runBrowserFlow(root, config, 'installation-accept', { page: github.page(), ...common });
    assert.equal(notPending.outcome, 'refused'); assert.match(notPending.reason!, /no pending permission request/);
    github.login = null;
    const signedOut = await runBrowserFlow(root, config, 'app-permissions', { page: github.page(), api: (command, args) => { const body = JSON.parse(github.api(command, args)); if (body.slug) body.permissions = { ...body.permissions, contents: 'read' }; return JSON.stringify(body); }, sleep: noSleep });
    assert.equal(signedOut.outcome, 'refused'); assert.match(signedOut.reason!, /not signed in to GitHub/);
    const ledger = await readAdministrationLedger(root);
    assert.equal(ledger.entries.length, 5); assert.ok(ledger.entries.every(entry => entry.reason));
    const withoutProfile = masterConfigSchema.parse({ ...config, browser: undefined });
    await assert.rejects(runBrowserFlow(root, withoutProfile, 'protection', { api: github.api }), /master init --browser-profile/);
    await assert.rejects(runBrowserFlow(root, config, 'export-cookies' as any, { api: github.api }), /Use master browser/);
  } finally { await cleanup(); }
});

test('the agent-browser page drives one headless session on the operator profile and never touches its cookies', () => {
  const calls: string[][] = [];
  const responses: Record<string, unknown> = { open: {}, get: { url: 'https://github.com/sessions/sudo', text: 'Confirm access' }, eval: { result: JSON.stringify({ selector: '[data-graphyard-target="gy-1"]', tag: 'button', checked: null, value: null, text: 'save changes' }) }, click: {}, check: {}, uncheck: {}, select: {}, screenshot: {}, wait: {} };
  const page = agentBrowserPage({ profile: 'Default', executable: '/usr/bin/google-chrome' }, 'graphyard-master-owner-project', args => { calls.push(args); return JSON.stringify({ success: true, data: responses[args[args.indexOf('--executable-path') + 2]] ?? {}, error: null }); });
  page.open('https://github.com/settings/apps/x/permissions'); page.url(); page.text();
  const located = page.locate('button', 'Save changes'); page.click(located!.selector); page.setChecked('#a', false); page.setChecked('#a', true); page.select('#b', 'write'); page.screenshot('/tmp/x.png'); page.wait(5); page.close();
  assert.deepEqual(agentBrowserArguments({ profile: 'Default' }, 's'), ['--json', '--session', 's', '--profile', 'Default']);
  for (const call of calls) assert.deepEqual(call.slice(0, 7), ['--json', '--session', 'graphyard-master-owner-project', '--profile', 'Default', '--executable-path', '/usr/bin/google-chrome']);
  assert.ok(calls.every(call => !call.includes('--headed')), 'the session is headless');
  assert.deepEqual(calls.map(call => call[7]), ['open', 'get', 'get', 'eval', 'click', 'uncheck', 'check', 'select', 'screenshot', 'wait', 'close']);
  assert.equal(located!.selector, '[data-graphyard-target="gy-1"]');
  assert.ok(calls.every(call => !/cookies|state|auth|storage|--restore|--auto-connect/.test(call.slice(7).join(' '))), 'no command saves, exports, or restores the profile\'s login state');
  assert.ok(calls.find(call => call[7] === 'eval')![8].includes('=== target'), 'elements are matched exactly, never fuzzily');
  const refusing = agentBrowserPage({ profile: 'Default' }, 's', () => JSON.stringify({ success: false, data: null, error: 'Unknown action' }));
  assert.throws(() => refusing.click('#x'), /agent-browser click refused: Unknown action/);
  assert.throws(() => agentBrowserPage({ profile: 'Default' }, 's', () => { throw new Error('spawn agent-browser ENOENT'); }).open('https://github.com'), /agent-browser open failed: spawn agent-browser ENOENT/);
});

test('the recording page captures every step and a screenshot after each mutation', async () => {
  const directory = await temporaryDirectory('record');
  try {
    const github = new StubGitHub();
    const steps: any[] = [];
    const page = recordingPage(github.page(), { directory, steps, now: () => new Date('2026-09-18T12:00:00Z') });
    page.open('https://github.com/owner/project/settings/branches'); page.text(); page.locate('link', 'main'); page.click('#rule'); page.wait(1);
    assert.throws(() => page.click('#missing'), /no element/);
    assert.deepEqual(steps.map(step => step.action), ['open', 'text', 'locate', 'click', 'wait', 'click']);
    assert.equal(steps[0].screenshot, '001-open.png'); assert.equal(steps[3].screenshot, '004-click.png'); assert.equal(steps[1].screenshot, null);
    assert.match(steps[5].error, /no element/);
    assert.deepEqual((await readdir(directory)).sort(), ['001-open.png', '004-click.png']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('master harness writes the allow rules the browser flows need, each with a reason, and narrows the denies to bypasses', async () => {
  const { root, config, cleanup } = await master();
  try {
    const plan = masterHarness(root, config, 'claude');
    const allow = plan.allow.map(entry => entry.rule), deny = plan.deny.map(entry => entry.rule);
    for (const entry of [...plan.allow, ...plan.deny]) assert.ok(entry.why.length > 30, `${entry.rule} must explain itself`);
    assert.ok(!allow.some(rule => rule.includes('agent-browser')), 'the session never drives agent-browser itself; only master browser does');
    assert.ok(allow.includes(`Bash(node ${config.cliPath} master browser:*)`), 'the browser flows are allowed');
    assert.ok(allow.includes(`Bash(node ${config.cliPath} master review:*)`), 'the reviewer launcher is allowed');
    assert.ok(allow.includes('Bash(gh api repos/owner/project/branches/main/protection*)'), 'protection reads are allowed');
    assert.ok(allow.includes('Bash(gh api --method PATCH repos/owner/project/branches/main/protection/*)'), 'protection subresource writes are allowed');
    assert.ok(allow.includes('Bash(gh api user/installations*)'), 'installation reads are allowed');
    assert.ok(!allow.some(rule => /PUT|POST|DELETE/.test(rule)), 'no allow rule writes to an installation or replaces protection; only PATCH subresources and the browser flows do');
    assert.ok(allow.includes('Bash(gh api apps/*)') && allow.includes('Bash(gh api user)'));
    assert.ok(allow.includes('Read(./.graphyard/master-actions/**)'), 'the recorded flows are readable');
    assert.match(plan.note, /classifier otherwise refuses/);
    assert.ok(plan.allow.filter(entry => entry.rule.includes('gh api')).every(entry => /classifier|verify|audit|before and after/.test(entry.why)), 'each gh api rule states why the classifier would otherwise refuse it or what it verifies');
    for (const rule of allow) assert.doesNotMatch(rule, /merge|access_tokens|reviews|graphql|\.pem|\.token|credential|cookies/i, `allow rule ${rule} must not reach a merge, a verdict, or a credential`);
    for (const rule of ['Bash(gh pr merge:*)', 'Bash(gh pr review:*)', 'Bash(gh api *merge*)', 'Bash(gh api *pulls/*/reviews*)', 'Bash(gh api *access_tokens*)', 'Bash(gh api graphql*)', 'Bash(gh api *DELETE*)', 'Bash(gh api *PUT*)', 'Bash(gh api *POST*)', 'Bash(agent-browser *)', 'Bash(git push:*)', 'Read(**/*.pem)', 'Read(**/*.token)']) assert.ok(deny.includes(rule), `${rule} must be denied`);
    assert.ok(!deny.includes('Bash(gh api:*)'), 'the blanket gh api deny would override every allow above');
    const plain = masterHarnessPlan({ harness: 'claude', root, cliPath: config.cliPath, repository: 'org/repo', baseBranch: 'release/2026', credentialHome: '/home/x/.config/graphyard' });
    assert.ok(plain.allow.some(entry => entry.rule === 'Bash(gh api repos/org/repo/branches/release%2F2026/protection*)'), 'the base branch is encoded exactly as the CLI requests it');
    const written = await writeHarnessPermissions(root, plan, true);
    assert.equal(written.applied, true);
    const settings = JSON.parse(await readFile(join(root, '.claude/settings.local.json'), 'utf8'));
    assert.ok(settings.permissions.deny.includes('Bash(agent-browser *)')); assert.ok(settings.permissions.deny.includes('Bash(gh api *merge*)'));
    assert.deepEqual((await writeHarnessPermissions(root, plan, true)).added, []);
  } finally { await cleanup(); }
});

test('the generated master instructions and the guides assign GitHub administration to the master through the browser', async () => {
  const read = async (name: string) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
  const instructions = managedMasterInstructions('');
  const [masterAgent, onboarding, github, help] = await Promise.all([readMasterGuide(), read('docs/onboarding.md'), read('docs/github.md'), read('src/cli/master.ts')]);
  for (const flow of browserFlows) {
    assert.ok(instructions.includes(`master browser ${flow}`), `the generated instructions must name ${flow}`);
    assert.ok(masterAgent.includes(`master browser ${flow}`), `docs/master-agent.md must name ${flow}`);
  }
  for (const fragment of ['App permission updates', 'installation permission', 'branch-protection reconciliation', 'browser profile', '.graphyard/master-actions/', 'audit entry', 'GitHub Mobile', 'two-digit code', 'only\noperator interactions', 'Never store, export, or reuse']) assert.ok(instructions.includes(fragment), `the generated instructions must state: ${fragment}`);
  assert.match(instructions, /yours, not the operator's/);
  assert.match(instructions, /Never use an administrative merge bypass, edit a candidate, or read a\nworker credential/);
  for (const fragment of ['## GitHub administration through the browser', 'Confirm access', 'GitHub Mobile', 'master status', 'record.json', 'ledger.json', 'human-only', 'never stores', 'device', 'master init --browser-profile', 'must never', 'merge bypass', 'classifier']) assert.ok(masterAgent.includes(fragment), `docs/master-agent.md must document: ${fragment}`);
  assert.match(masterAgent, /\| `app-permissions` \|/); assert.match(masterAgent, /\| `installation-accept` \|/); assert.match(masterAgent, /\| `protection` \|/);
  for (const fragment of ['master browser', '--browser-profile', 'GitHub Mobile', 'human-only']) assert.ok(onboarding.includes(fragment), `docs/onboarding.md must document: ${fragment}`);
  assert.doesNotMatch(onboarding, /click GitHub's App confirmation for each App/, 'the install guide no longer lists App confirmation as an operator step');
  for (const fragment of ['master browser app-permissions', 'master browser installation-accept', 'master browser protection']) assert.ok(github.includes(fragment), `docs/github.md must route the administration to the master: ${fragment}`);
  for (const command of ['master browser FLOW', '--browser-profile PROFILE']) assert.ok(help.includes(command), `${command} must appear in CLI help`);
  assert.equal(managedMasterInstructions(instructions), instructions, 'regeneration is idempotent');
});

test('the master CLI stores the browser profile, refuses flows without one, and reports administration in status', async () => {
  const root = await temporaryDirectory('browser-cli'), credentialDirectory = await temporaryDirectory('browser-cli-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/status') return response.end(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
    if (request.url === '/api/work-snapshot') return response.end(JSON.stringify({ work: [], now: new Date().toISOString() }));
    response.statusCode = 404; response.end('{}');
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const binary = join(credentialDirectory, 'bin'); await mkdir(binary, { recursive: true });
    await writeFile(join(binary, 'gh'), '#!/bin/sh\necho \'{"login":"operator-cli","installations":[]}\'\n', { mode: 0o755 });
    await writeFile(join(binary, 'agent-browser'), '#!/bin/sh\necho \'{"success":false,"data":null,"error":"stub browser refused"}\'\n', { mode: 0o755 });
    const environment: NodeJS.ProcessEnv = { ...process.env, PATH: `${binary}:${process.env.PATH}`, GRAPHYARD_CONFIG_HOME: credentialDirectory };
    for (const name of Object.keys(environment)) if (name.startsWith('GRAPHYARD_') && name !== 'GRAPHYARD_CONFIG_HOME') delete environment[name];
    const cli = async (args: string[], input?: string) => {
      const child = execFile(process.execPath, [launcher, ...args], { cwd: root, env: environment, encoding: 'utf8' });
      child.child.stdin!.end(input ?? '');
      try { return { stdout: (await child).stdout, code: 0 }; } catch (error: any) { return { stdout: error.stdout as string, stderr: error.stderr as string, code: error.code as number }; }
    };
    await cli(['master', 'init', '--url', url, '--token-stdin', '--cli-path', launcher], coordinatorToken);
    const refused = await cli(['master', 'browser', 'protection']);
    assert.notEqual(refused.code, 0); assert.match(refused.stderr!, /master init --browser-profile/);
    const configured = JSON.parse((await cli(['master', 'init', '--url', url, '--token-stdin', '--cli-path', launcher, '--browser-profile', 'Default'], coordinatorToken)).stdout);
    assert.deepEqual(configured.browser, { profile: 'Default' });
    assert.deepEqual((await loadMasterConfig(root)).browser, { profile: 'Default' });
    assert.deepEqual(JSON.parse((await cli(['master', 'init', '--url', url, '--token-stdin', '--cli-path', launcher], coordinatorToken)).stdout).browser, { profile: 'Default' }, 'rerunning init keeps the profile');
    const usage = await cli(['master', 'browser']);
    assert.match(usage.stderr!, /Use master browser app-permissions\|installation-accept\|protection/);
    // Without an installation visible to the operator's token the flow refuses before opening a page, and the refusal is audited.
    const noInstallation = await cli(['master', 'browser', 'app-permissions']);
    assert.equal(noInstallation.code, 1);
    const result = JSON.parse(noInstallation.stdout); assert.equal(result.outcome, 'refused'); assert.match(result.reason, /sees no installation of App 1234/);
    const status = JSON.parse((await cli(['master', 'status'])).stdout);
    assert.deepEqual(status.administration.browser, { profile: 'Default' }); assert.equal(status.administration.total, 1); assert.equal(status.administration.recent[0].outcome, 'refused'); assert.equal(status.administration.sudo, null);
    const pending: SudoState = { flow: 'protection', record: 'x', code: '58', issuedAt: new Date().toISOString(), attempt: 1, deadline: new Date(Date.now() + 60_000).toISOString(), state: 'waiting' };
    await writeFile(join(root, '.graphyard/master-actions/sudo.json'), JSON.stringify(pending), { mode: 0o600 });
    const waiting = JSON.parse((await cli(['master', 'status'])).stdout);
    assert.equal(waiting.administration.sudo.code, '58'); assert.match(waiting.administration.sudo.instruction, /choose 58/);
    const harness = JSON.parse((await cli(['master', 'harness', 'claude'])).stdout);
    assert.ok(harness.added.some((entry: any) => entry.list === 'allow' && entry.rule === `Bash(node ${launcher} master browser:*)` && entry.why));
    assert.ok(harness.added.some((entry: any) => entry.list === 'deny' && entry.rule === 'Bash(agent-browser *)' && /identity/.test(entry.why)));
  } finally {
    await new Promise<void>(accept => server.close(() => accept()));
    await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true });
  }
});

test('permission comparison treats write as satisfying read and reports only what is below the requirement', () => {
  assert.deepEqual(missingPermissions({ ...controlPlanePermissions }), []);
  assert.deepEqual(missingPermissions({ ...controlPlanePermissions, metadata: 'write', issues: 'write' }), []);
  assert.deepEqual(missingPermissions({ ...controlPlanePermissions, contents: 'read', checks: undefined as any }), ['contents: read to write', 'checks: none to write']);
  assert.equal(missingPermissions(null).length, Object.keys(controlPlanePermissions).length);
});
