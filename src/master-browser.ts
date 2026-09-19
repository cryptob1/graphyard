import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { relative, resolve } from 'node:path';
import { z } from 'zod';
import { atomicPrivateWrite, privateFile, type MasterBrowser, type MasterConfig } from './master.js';
import { protectionPlan, readProtection, type ProtectionRun } from './protection.js';
import type { Work } from './model.js';

/**
 * GitHub administration the master performs itself, through the operator's own authenticated
 * browser profile, when the REST and App APIs offer no path: App permission updates, acceptance
 * of the installation permission request those updates raise, and classic branch-protection
 * settings the operator's token may not patch. Every flow is recorded step by step with
 * screenshots, verified afterwards through the API, and appended to an audit ledger, so a
 * browser-driven change is as attributable as a CLI one.
 *
 * The profile is the operator's identity. Nothing here saves, exports, or copies its cookies or
 * storage, and the session is used for the enumerated flows only.
 */
export const browserFlows = ['app-permissions', 'installation-accept', 'protection'] as const;
export type BrowserFlow = typeof browserFlows[number];

// What the control-plane App must hold for every path Graphyard exercises: contents write for
// published speculative queue tips, checks write for the gate check, administration read for
// protection observation, and pull-request write plus issue read for review dispatch.
export const controlPlanePermissions: Record<string, 'read' | 'write'> = { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'read', checks: 'write', administration: 'read' };
const level = (value: unknown) => value === 'write' ? 2 : value === 'read' ? 1 : 0;
/** Permissions still below what the control plane needs. */
export function missingPermissions(actual: Record<string, unknown> | null | undefined, desired = controlPlanePermissions) {
  return Object.entries(desired).filter(([name, wanted]) => level(actual?.[name]) < level(wanted)).map(([name, wanted]) => `${name}: ${String(actual?.[name] ?? 'none')} to ${wanted}`);
}

export interface Located { selector: string; tag: string; checked: boolean | null; value: string | null; text: string }
/** The page operations a flow needs. Exact, never fuzzy: a control is found by its own label or name. */
export interface BrowserPage {
  open(url: string): void;
  url(): string;
  text(): string;
  meta(name: string): string | null;
  locate(kind: 'button' | 'link' | 'label' | 'field', text: string): Located | null;
  click(selector: string): void;
  setChecked(selector: string, checked: boolean): void;
  select(selector: string, value: string): void;
  screenshot(file: string): void;
  wait(ms: number): void;
  close(): void;
}

// Runs inside the page. It tags the located element so the following command addresses exactly
// that element, whatever GitHub's own ids are.
const locateScript = (kind: string, text: string) => `(() => {
  const kind = ${JSON.stringify(kind)}, wanted = ${JSON.stringify(text)};
  const norm = value => String(value ?? '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const target = norm(wanted);
  let element = null;
  if (kind === 'button') element = [...document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button], summary')].find(candidate => norm(candidate.tagName === 'INPUT' ? candidate.value : candidate.textContent) === target) ?? null;
  else if (kind === 'link') element = [...document.querySelectorAll('a[href]')].find(candidate => norm(candidate.textContent) === target) ?? null;
  else if (kind === 'label') {
    const label = [...document.querySelectorAll('label')].find(candidate => norm(candidate.textContent).startsWith(target));
    element = label ? label.control ?? (label.htmlFor ? document.getElementById(label.htmlFor) : null) ?? label.querySelector('input, select') : null;
  } else if (kind === 'field') element = document.querySelector('[name="' + wanted.replace(/["\\\\]/g, '\\\\$&') + '"]');
  if (!element) return 'null';
  const marker = 'gy-' + String((window.__graphyardLocated = (window.__graphyardLocated ?? 0) + 1));
  element.setAttribute('data-graphyard-target', marker);
  return JSON.stringify({ selector: '[data-graphyard-target="' + marker + '"]', tag: element.tagName.toLowerCase(), checked: 'checked' in element ? !!element.checked : null, value: 'value' in element ? String(element.value) : null, text: norm(element.textContent) });
})()`;

export type AgentBrowserRun = (args: string[]) => string;
const agentBrowserRun: AgentBrowserRun = args => execFileSync('agent-browser', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
/** The command prefix every step uses. Headless, one named session, the operator's own profile. */
export function agentBrowserArguments(browser: MasterBrowser, session: string) {
  return ['--json', '--session', session, '--profile', browser.profile, ...(browser.executable ? ['--executable-path', browser.executable] : [])];
}
export function agentBrowserPage(browser: MasterBrowser, session: string, run: AgentBrowserRun = agentBrowserRun): BrowserPage {
  const prefix = agentBrowserArguments(browser, session);
  const invoke = (...args: string[]) => {
    let parsed: any;
    try { parsed = JSON.parse(run([...prefix, ...args])); }
    catch (error) { throw new Error(`agent-browser ${args[0]} failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (parsed?.success !== true) throw new Error(`agent-browser ${args[0]} refused: ${parsed?.error ?? 'unknown error'}`);
    return parsed.data ?? {};
  };
  return {
    open: url => { invoke('open', url); },
    url: () => String(invoke('get', 'url').url ?? ''),
    text: () => String(invoke('get', 'text', 'body').text ?? ''),
    meta: name => { const result = invoke('eval', `(() => { const m = document.querySelector('meta[name="${name.replace(/[^a-z-]/g, '')}"]'); return m ? m.content : null })()`).result; return typeof result === 'string' && result ? result : null; },
    locate: (kind, text) => { const result = invoke('eval', locateScript(kind, text)).result; const value = typeof result === 'string' ? JSON.parse(result) : result; return value && typeof value === 'object' ? value as Located : null; },
    click: selector => { invoke('click', selector); },
    setChecked: (selector, checked) => { invoke(checked ? 'check' : 'uncheck', selector); },
    select: (selector, value) => { invoke('select', selector, value); },
    screenshot: file => { invoke('screenshot', file); },
    wait: ms => { invoke('wait', String(ms)); },
    close: () => { try { run([...prefix, 'close']); } catch { /* the session may already be gone */ } },
  };
}

// ---- Recording -----------------------------------------------------------------------------

export interface RecordedStep { n: number; at: string; action: string; args: string[]; result: string | null; screenshot: string | null; error?: string }
export const actionsDirectory = (root: string) => resolve(root, '.graphyard/master-actions');
const truncate = (value: unknown, max = 2_000) => { const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''; return text.length > max ? `${text.slice(0, max)}…` : text; };
const stamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-');

/** Wrap a page so every call is written to the record with a screenshot after each mutation. */
export function recordingPage(page: BrowserPage, record: { directory: string; steps: RecordedStep[]; now: () => Date }): BrowserPage {
  const capture = new Set(['open', 'click', 'setChecked', 'select']);
  const step = <T>(action: string, args: string[], run: () => T): T => {
    const entry: RecordedStep = { n: record.steps.length + 1, at: record.now().toISOString(), action, args, result: null, screenshot: null };
    record.steps.push(entry);
    try {
      const result = run();
      entry.result = result === undefined ? null : truncate(result);
      if (capture.has(action)) {
        const file = resolve(record.directory, `${String(entry.n).padStart(3, '0')}-${action}.png`);
        try { page.screenshot(file); entry.screenshot = relative(record.directory, file); } catch (error) { entry.screenshot = null; entry.error = `screenshot failed: ${error instanceof Error ? error.message : String(error)}`; }
      }
      return result;
    } catch (error) { entry.error = error instanceof Error ? error.message : String(error); throw error; }
  };
  return {
    open: url => step('open', [url], () => page.open(url)),
    url: () => step('url', [], () => page.url()),
    text: () => step('text', [], () => page.text()),
    meta: name => step('meta', [name], () => page.meta(name)),
    locate: (kind, text) => step('locate', [kind, text], () => page.locate(kind, text)),
    click: selector => step('click', [selector], () => page.click(selector)),
    setChecked: (selector, checked) => step('setChecked', [selector, String(checked)], () => page.setChecked(selector, checked)),
    select: (selector, value) => step('select', [selector, value], () => page.select(selector, value)),
    screenshot: file => step('screenshot', [relative(record.directory, file)], () => page.screenshot(file)),
    wait: ms => step('wait', [String(ms)], () => page.wait(ms)),
    close: () => step('close', [], () => page.close()),
  };
}

// ---- Sudo mode -----------------------------------------------------------------------------

export const sudoStateSchema = z.object({
  flow: z.enum(browserFlows), record: z.string().min(1),
  code: z.string().regex(/^\d{2}$/).nullable(), issuedAt: z.string().min(1).max(40), attempt: z.number().int().positive(),
  deadline: z.string().min(1).max(40), state: z.enum(['waiting', 'approved', 'expired']),
}).strict();
export type SudoState = z.infer<typeof sudoStateSchema>;
const sudoFile = (root: string) => resolve(actionsDirectory(root), 'sudo.json');
export async function readSudoState(root: string): Promise<SudoState | null> {
  try { await privateFile(sudoFile(root)); return sudoStateSchema.parse(JSON.parse(await readFile(sudoFile(root), 'utf8'))); }
  catch (error: any) { if (error.code === 'ENOENT' || /ENOENT/.test(String(error.message))) return null; throw error; }
}
/** What the operator must do right now, if anything. */
export function sudoAttention(state: SudoState | null, now = Date.now()) {
  if (!state || state.state !== 'waiting') return null;
  if (Date.parse(state.deadline) <= now) return { ...state, instruction: `The ${state.flow} flow timed out waiting for sudo approval; rerun master browser ${state.flow}` };
  return { ...state, instruction: state.code ? `Approve the GitHub Mobile prompt on your device and choose ${state.code}; the ${state.flow} flow is waiting` : `Confirm access for the ${state.flow} flow on your device` };
}

/** Recognize GitHub's Confirm-access page and what it currently shows. */
export function detectSudo(url: string, text: string) {
  const sudo = /\/sessions\/sudo(?:[/?#]|$)/.test(url) || /\bconfirm access\b/i.test(text) && /\b(github mobile|authenticator|passkey|password)\b/i.test(text);
  if (!sudo) return { sudo: false, code: null as string | null, expired: false, mobileOffered: false };
  const mobileOffered = /use github mobile/i.test(text);
  const expired = /\b(expired|didn.t receive|try again|resend)\b/i.test(text);
  // The pairing code is the only line of the page that is exactly two digits.
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const code = lines.find(line => /^\d{2}$/.test(line)) ?? null;
  return { sudo, code, expired, mobileOffered };
}

export interface SudoOptions { flow: BrowserFlow; record: string; onCode: (state: SudoState) => Promise<void> | void; onSettled?: (state: SudoState) => Promise<void> | void; sleep?: (ms: number) => Promise<void>; now?: () => Date; timeoutMs?: number; pollMs?: number; maxAttempts?: number }
/**
 * Pass a Confirm-access prompt without a keyboard: trigger GitHub Mobile, surface the pairing
 * code, and wait for the operator's approval with a bounded, retrying poll. Every re-issued code
 * counts as an attempt; the deadline bounds the whole wait.
 */
export async function passSudo(page: BrowserPage, options: SudoOptions) {
  const now = options.now ?? (() => new Date()), sleep = options.sleep ?? (ms => new Promise<void>(accept => setTimeout(accept, ms)));
  const timeoutMs = options.timeoutMs ?? 180_000, pollMs = options.pollMs ?? 3_000, maxAttempts = options.maxAttempts ?? 3;
  const started = now().getTime(), deadline = new Date(started + timeoutMs).toISOString();
  let attempt = 0; let state = null as SudoState | null;
  const issue = (label: string) => {
    if (attempt >= maxAttempts) throw new Error(`GitHub Mobile confirmation was re-issued ${attempt} times without approval; approve the prompt on your device and rerun master browser ${options.flow}`);
    const button = page.locate('button', label);
    if (!button) throw new Error(`Confirm-access page offers no "${label}" control; only GitHub Mobile confirmation is automated, so confirm access in your own browser and rerun master browser ${options.flow}`);
    attempt += 1; page.click(button.selector); page.wait(Math.min(pollMs, 1_000));
  };
  for (;;) {
    const detected = detectSudo(page.url(), page.text());
    if (!detected.sudo) {
      if (state) { state = { ...state, state: 'approved' }; await options.onSettled?.(state); }
      return { passed: !!state, attempts: attempt, code: state?.code ?? null };
    }
    if (now().getTime() - started >= timeoutMs) {
      if (state) { state = { ...state, state: 'expired' }; await options.onSettled?.(state); }
      throw new Error(`Confirm access was not approved within ${Math.round(timeoutMs / 1000)}s; approve the GitHub Mobile prompt${state?.code ? ` (code ${state.code})` : ''} and rerun master browser ${options.flow}`);
    }
    if (!state && !detected.code) { issue('Use GitHub Mobile'); continue; }
    if (state && detected.expired && !detected.code) { issue(detected.mobileOffered ? 'Use GitHub Mobile' : 'Try again'); state = null; continue; }
    if (detected.code && detected.code !== state?.code) {
      state = { flow: options.flow, record: options.record, code: detected.code, issuedAt: now().toISOString(), attempt: Math.max(attempt, 1), deadline, state: 'waiting' };
      await options.onCode(state);
    } else if (!state) {
      state = { flow: options.flow, record: options.record, code: null, issuedAt: now().toISOString(), attempt: Math.max(attempt, 1), deadline, state: 'waiting' };
      await options.onCode(state);
    }
    await sleep(pollMs);
  }
}

// ---- Audit ledger --------------------------------------------------------------------------

export const administrationEntrySchema = z.object({
  id: z.string().uuid(), flow: z.enum(browserFlows),
  startedAt: z.string().min(1).max(40), completedAt: z.string().min(1).max(40),
  actor: z.object({ browser: z.string().max(200).nullable(), profile: z.string().max(500), cli: z.string().max(200).nullable(), os: z.string().max(200), host: z.string().max(200), coordinator: z.string().max(200).nullable() }).strict(),
  target: z.record(z.string(), z.union([z.string(), z.number()])),
  before: z.unknown(), after: z.unknown(),
  outcome: z.enum(['applied', 'unchanged', 'refused']), verified: z.boolean(), reason: z.string().max(2_000).optional(),
  record: z.string().min(1), screenshots: z.number().int().nonnegative(),
  sudo: z.object({ attempts: z.number().int().nonnegative(), code: z.string().nullable() }).nullable(),
}).strict();
export type AdministrationEntry = z.infer<typeof administrationEntrySchema>;
export const administrationLedgerSchema = z.object({ version: z.literal(1), entries: z.array(administrationEntrySchema).max(5_000).default([]) }).strict();
const ledgerFile = (root: string) => resolve(actionsDirectory(root), 'ledger.json');
export async function readAdministrationLedger(root: string) {
  try { await privateFile(ledgerFile(root)); return administrationLedgerSchema.parse(JSON.parse(await readFile(ledgerFile(root), 'utf8'))); }
  catch (error: any) { if (error.code === 'ENOENT' || /ENOENT/.test(String(error.message))) return { version: 1 as const, entries: [] as AdministrationEntry[] }; throw error; }
}
// Append only: an entry is never edited or removed once written.
export async function appendAdministrationEntry(root: string, entry: AdministrationEntry) {
  const ledger = await readAdministrationLedger(root);
  if (ledger.entries.some(existing => existing.id === entry.id)) throw new Error('Administration ledger entries are immutable');
  await mkdir(actionsDirectory(root), { recursive: true, mode: 0o700 });
  await atomicPrivateWrite(ledgerFile(root), administrationLedgerSchema.parse({ ...ledger, entries: [...ledger.entries, administrationEntrySchema.parse(entry)] }));
}
export function summarizeAdministration(entries: AdministrationEntry[], sudo: SudoState | null, now = Date.now()) {
  return { sudo: sudoAttention(sudo, now), recent: entries.slice(-5).reverse().map(({ id, flow, completedAt, actor, outcome, verified, reason, record }) => ({ id, flow, at: completedAt, by: actor.browser ?? actor.cli ?? actor.os, outcome, verified, reason: reason ?? null, record })), total: entries.length };
}

// ---- Flows ---------------------------------------------------------------------------------

export interface FlowDependencies {
  page?: BrowserPage; api?: ProtectionRun; work?: Work[]; coordinator?: string | null;
  now?: () => Date; sleep?: (ms: number) => Promise<void>; sudo?: Partial<Pick<SudoOptions, 'timeoutMs' | 'pollMs' | 'maxAttempts'>>;
  dryRun?: boolean;
}
type Observed = { installation: { id: number; slug: string; account: string; accountType: string; permissions: Record<string, string> } };
const apiRun: ProtectionRun = (command, args, input) => execFileSync(command, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });

function githubLogin(api: ProtectionRun) {
  try { const user = JSON.parse(api('gh', ['api', 'user'])); return typeof user?.login === 'string' ? user.login : null; } catch { return null; }
}
/** The control-plane App's installation as the operator's own token sees it. */
export function observeInstallation(api: ProtectionRun, appId: number): Observed['installation'] {
  const listed = JSON.parse(api('gh', ['api', 'user/installations?per_page=100']));
  const installation = (listed?.installations ?? []).find((candidate: any) => candidate?.app_id === appId);
  if (!installation) throw new Error(`The operator's GitHub identity sees no installation of App ${appId}; install the control-plane App on the managed repository first`);
  return { id: Number(installation.id), slug: String(installation.app_slug), account: String(installation.account?.login ?? ''), accountType: String(installation.account?.type ?? installation.target_type ?? 'User'), permissions: installation.permissions && typeof installation.permissions === 'object' ? installation.permissions : {} };
}
function observeApp(api: ProtectionRun, slug: string): Record<string, string> {
  const app = JSON.parse(api('gh', ['api', `apps/${encodeURIComponent(slug)}`]));
  return app?.permissions && typeof app.permissions === 'object' ? app.permissions : {};
}
const installationSettingsUrl = (installation: Observed['installation']) => installation.accountType === 'Organization'
  ? `https://github.com/organizations/${encodeURIComponent(installation.account)}/settings/installations/${installation.id}`
  : `https://github.com/settings/installations/${installation.id}`;

function required<T>(value: T | null, what: string, flow: BrowserFlow): T {
  if (!value) throw new Error(`Could not find ${what} on the page; the recorded steps and screenshots under .graphyard/master-actions show what the ${flow} flow saw`);
  return value;
}

export async function runBrowserFlow(root: string, config: MasterConfig, flow: BrowserFlow, dependencies: FlowDependencies = {}) {
  if (!browserFlows.includes(flow)) throw new Error(`Use master browser ${browserFlows.join('|')}`);
  if (!config.browser) throw new Error('No browser profile is configured; rerun master init --browser-profile PROFILE (a Chrome profile name such as Default, or a profile directory) so the master can administer GitHub through your authenticated browser');
  const now = dependencies.now ?? (() => new Date()), api = dependencies.api ?? apiRun;
  const startedAt = now();
  const id = randomUUID();
  const directory = resolve(actionsDirectory(root), `${stamp(startedAt)}-${flow}-${id.slice(0, 8)}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const steps: RecordedStep[] = [];
  const session = `graphyard-master-${config.repository.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;
  const raw = dependencies.page ?? agentBrowserPage(config.browser, session);
  const page = recordingPage(raw, { directory, steps, now });
  const cli = githubLogin(api);
  let browserLogin: string | null = null;
  let sudo: { attempts: number; code: string | null } | null = null;
  const entry: Omit<AdministrationEntry, 'completedAt' | 'outcome' | 'verified' | 'before' | 'after' | 'screenshots' | 'sudo'> = {
    id, flow, startedAt: startedAt.toISOString(),
    actor: { browser: null, profile: config.browser.profile, cli, os: userInfo().username, host: config.hostId, coordinator: dependencies.coordinator ?? null },
    target: { repository: config.repository, appId: config.githubAppId }, record: relative(root, directory),
  };
  const settle = async (state: SudoState) => { if (state.state === 'approved') await rm(sudoFile(root), { force: true }); else await atomicPrivateWrite(sudoFile(root), state); };
  // Every navigation may land on Confirm access; each is followed by the same bounded pass.
  const visit = async (url: string) => {
    page.open(url);
    const passed = await passSudo(page, { flow, record: entry.record, onCode: state => atomicPrivateWrite(sudoFile(root), state), onSettled: settle, sleep: dependencies.sleep, now, ...dependencies.sudo });
    if (passed.attempts || passed.passed) sudo = { attempts: passed.attempts, code: passed.code };
    browserLogin ??= page.meta('user-login');
    if (!browserLogin && /github\.com\/login\b/.test(page.url())) throw new Error(`The browser profile ${config.browser!.profile} is not signed in to GitHub; sign in once in that profile, then rerun master browser ${flow}`);
  };
  let before: unknown = null, after: unknown = null, outcome: AdministrationEntry['outcome'] = 'refused', verified = false, reason: string | undefined;
  try {
    if (flow === 'app-permissions') {
      const installation = observeInstallation(api, config.githubAppId);
      before = { app: observeApp(api, installation.slug), installation: installation.permissions };
      entry.target = { ...entry.target, slug: installation.slug, installationId: installation.id };
      const missing = missingPermissions((before as any).app);
      if (!missing.length) { outcome = 'unchanged'; verified = true; reason = 'The App already requests every permission the control plane needs'; }
      else if (dependencies.dryRun) { outcome = 'unchanged'; verified = false; reason = `Dry run; would raise ${missing.join(', ')}`; }
      else {
        await visit(`https://github.com/settings/apps/${encodeURIComponent(installation.slug)}/permissions`);
        for (const [name, wanted] of Object.entries(controlPlanePermissions)) {
          if (level((before as any).app[name]) >= level(wanted)) continue;
          const control = required(page.locate('field', `integration[default_permissions][${name}]`) ?? page.locate('label', name.replace(/_/g, ' ')), `the ${name} permission control`, flow);
          page.select(control.selector, wanted);
        }
        page.click(required(page.locate('button', 'Save changes'), 'the Save changes button', flow).selector);
        page.wait(1_500);
        after = { app: observeApp(api, installation.slug), installation: observeInstallation(api, config.githubAppId).permissions };
        const still = missingPermissions((after as any).app);
        verified = !still.length; outcome = verified ? 'applied' : 'refused';
        reason = verified ? `App now requests ${missing.length} raised permission(s); run master browser installation-accept so the installation grants them` : `GitHub still reports ${still.join(', ')} after saving`;
      }
    } else if (flow === 'installation-accept') {
      const installation = observeInstallation(api, config.githubAppId);
      before = { installation: installation.permissions, app: observeApp(api, installation.slug) };
      entry.target = { ...entry.target, slug: installation.slug, installationId: installation.id, account: installation.account };
      const missing = missingPermissions(installation.permissions);
      if (!missing.length) { outcome = 'unchanged'; verified = true; reason = 'The installation already grants every permission the control plane needs'; }
      else if (missingPermissions((before as any).app).length) { outcome = 'refused'; reason = `The App itself does not yet request ${missingPermissions((before as any).app).join(', ')}; run master browser app-permissions first`; }
      else if (dependencies.dryRun) { outcome = 'unchanged'; reason = `Dry run; would accept ${missing.join(', ')}`; }
      else {
        await visit(`${installationSettingsUrl(installation)}/permissions/update`);
        const accept = page.locate('button', 'Accept new permissions');
        if (!accept) { outcome = 'refused'; reason = 'GitHub shows no pending permission request for this installation; the recorded page shows what it offered instead'; }
        else {
          page.click(accept.selector); page.wait(1_500);
          const updated = observeInstallation(api, config.githubAppId);
          after = { installation: updated.permissions };
          const still = missingPermissions(updated.permissions);
          verified = !still.length; outcome = verified ? 'applied' : 'refused';
          reason = verified ? `Installation ${installation.id} now grants ${missing.join(', ')}` : `Installation still lacks ${still.join(', ')} after acceptance`;
        }
      }
    } else {
      const work = dependencies.work ?? [];
      const plan = protectionPlan(readProtection(config, api), config, work);
      before = { current: plan.current, strictOff: !plan.blockers.some(blocker => /up to date/.test(blocker)), enforceAdmins: !plan.blockers.some(blocker => /Administrator/.test(blocker)) };
      entry.target = { ...entry.target, branch: config.baseBranch, mode: plan.mode };
      // Only settings the browser form exposes are reconciled here; a missing App-bound check or a
      // CODEOWNERS requirement stays a refusal exactly as it does for master protection --apply.
      const unfixable = plan.blockers.filter(blocker => !/up to date|Administrator/.test(blocker));
      const wanted = { strict: false, enforceAdmins: true, requiredApprovals: plan.desired.requiredApprovals, requireLastPushApproval: plan.desired.requireLastPushApproval, dismissStaleReviews: plan.desired.dismissStaleReviews };
      if (unfixable.length) { outcome = 'refused'; reason = `Branch protection is missing settings the browser flow does not create: ${unfixable.join('; ')}`; }
      else if (plan.consistent) { outcome = 'unchanged'; verified = true; reason = 'Branch protection already matches every open review policy'; }
      else if (dependencies.dryRun) { outcome = 'unchanged'; reason = `Dry run; would change ${[...plan.changes, ...plan.blockers].join('; ')}`; }
      else {
        await visit(`https://github.com/${config.repository}/settings/branches`);
        const rule = required(page.locate('link', config.baseBranch), `the classic protection rule for ${config.baseBranch}`, flow);
        page.click(rule.selector);
        await passSudo(page, { flow, record: entry.record, onCode: state => atomicPrivateWrite(sudoFile(root), state), onSettled: settle, sleep: dependencies.sleep, now, ...dependencies.sudo });
        const checkbox = (label: string, checked: boolean) => { const control = required(page.locate('label', label), `the "${label}" setting`, flow); if (control.checked !== checked) page.setChecked(control.selector, checked); };
        checkbox('Require a pull request before merging', true);
        const count = required(page.locate('label', 'Required number of approvals before merging'), 'the required approvals count', flow);
        if (count.value !== String(wanted.requiredApprovals)) page.select(count.selector, String(wanted.requiredApprovals));
        checkbox('Dismiss stale pull request approvals when new commits are pushed', wanted.dismissStaleReviews);
        checkbox('Require approval of the most recent reviewable push', wanted.requireLastPushApproval);
        checkbox('Require status checks to pass before merging', true);
        checkbox('Require branches to be up to date before merging', wanted.strict);
        checkbox('Do not allow bypassing the above settings', wanted.enforceAdmins);
        page.click(required(page.locate('button', 'Save changes'), 'the Save changes button', flow).selector);
        page.wait(1_500);
        const verifiedPlan = protectionPlan(readProtection(config, api), config, work);
        after = { current: verifiedPlan.current, strictOff: !verifiedPlan.blockers.some(blocker => /up to date/.test(blocker)), enforceAdmins: !verifiedPlan.blockers.some(blocker => /Administrator/.test(blocker)) };
        verified = verifiedPlan.consistent; outcome = verified ? 'applied' : 'refused';
        reason = verified ? `Branch protection now matches the ${plan.mode} review policy: ${[...plan.changes, ...plan.blockers].join('; ')}` : `GitHub still reports ${[...verifiedPlan.changes, ...verifiedPlan.blockers].join('; ')} after saving`;
      }
    }
  } catch (error) {
    outcome = 'refused'; verified = false; reason = error instanceof Error ? error.message : String(error);
  } finally {
    // The session exists for this flow alone; a page that was never opened has nothing to close.
    if (steps.some(step => step.action === 'open')) try { page.close(); } catch { /* recorded on the step */ }
  }
  const completedAt = now().toISOString();
  const record = { ...entry, actor: { ...entry.actor, browser: browserLogin }, completedAt, before, after, outcome, verified, reason, screenshots: steps.filter(step => step.screenshot).length, sudo, steps };
  await writeFile(resolve(directory, 'record.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  const { steps: _steps, ...ledgerEntry } = record;
  await appendAdministrationEntry(root, ledgerEntry);
  return { ...ledgerEntry, steps: steps.length, next: outcome === 'refused' ? `Inspect ${entry.record}/record.json and its screenshots, then rerun master browser ${flow}` : flow === 'app-permissions' && outcome === 'applied' ? 'Run master browser installation-accept' : 'Run master status' };
}
