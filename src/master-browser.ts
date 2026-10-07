import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { relative, resolve } from 'node:path';
import { z } from 'zod';
import { atomicPrivateWrite, privateFile, type MasterBrowser, type MasterConfig } from './master.js';
import { protectionPlan, readProtection, type ProtectionRun } from './protection.js';
import type { Work } from './model.js';
import type { InstallationState } from './github.js';
import { controlPlanePermissions as declaredPermissions, requiredPermissions } from './github-permissions.js';

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

// What the control-plane App must hold for every path Graphyard exercises, read from the one
// declaration of it (src/github-permissions.ts) so a permission a feature adds there — actions write
// for failed CI reruns — is one these flows raise and accept, not one they report already granted
// while the integration jobs it holds stay held (GY-949). Workflows write is registered on top: worker
// pushes of base syncs that carry workflow changes need it, yet no preflight feature is held on it.
export const controlPlanePermissions: Record<string, 'read' | 'write' | 'admin'> = { ...requiredPermissions(declaredPermissions), workflows: 'write' };
const level = (value: unknown) => value === 'admin' ? 3 : value === 'write' ? 2 : value === 'read' ? 1 : 0;
/** Permissions still below what the control plane needs. */
export function missingPermissions(actual: Record<string, unknown> | null | undefined, desired = controlPlanePermissions) {
  return Object.entries(desired).filter(([name, wanted]) => level(actual?.[name]) < level(wanted)).map(([name, wanted]) => `${name}: ${String(actual?.[name] ?? 'none')} to ${wanted}`);
}

export interface Located { selector: string; tag: string; checked: boolean | null; value: string | null; text: string; href?: string | null; visible?: boolean }
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
  /** Writes a step to the flow's record without touching the page (a recording page records it; others ignore it). */
  note?(action: string, args: string[]): void;
  /** Types VALUE into the field at SELECTOR (GY-1450: a Confirm-access code); a recording page never records VALUE. */
  fill?(selector: string, value: string): void;
  /** Every typeable input the page renders now, each tagged so its selector addresses exactly it (GY-1459). */
  inputs?(): PageInput[];
  /**
   * GY-1459: the page runs in its own browser on a copy of the operator's profile, so sudo mode
   * they confirm in their own Chrome never reaches it.
   */
  copy?: boolean;
}
/**
 * A rendered input as the page itself describes it (GY-1459): its type, name, id, autocomplete and
 * inputmode, the text naming it (its label, aria-label, aria-labelledby or placeholder), and
 * whether it is shown. GitHub's Confirm-access code field is found by these, not by one name.
 */
export interface PageInput { selector: string; type: string; name: string; id: string; autocomplete: string; inputmode: string; label: string; visible: boolean }

// Runs inside the page: describes and tags every typeable input (GY-1459).
const inputsScript = `(() => {
  const norm = value => String(value ?? '').replace(/\\s+/g, ' ').trim();
  const shown = candidate => candidate.getClientRects().length > 0 && getComputedStyle(candidate).visibility !== 'hidden';
  const skip = new Set(['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset']);
  return JSON.stringify([...document.querySelectorAll('input')].filter(input => !skip.has((input.type || 'text').toLowerCase())).map(input => {
    const marker = 'gy-' + String((window.__graphyardLocated = (window.__graphyardLocated ?? 0) + 1));
    input.setAttribute('data-graphyard-target', marker);
    const labelled = (input.getAttribute('aria-labelledby') || '').split(/\\s+/).map(id => id && document.getElementById(id)).filter(Boolean).map(node => node.textContent);
    const label = [...(input.labels ?? [])].map(node => node.textContent).concat(labelled, [input.getAttribute('aria-label'), input.getAttribute('placeholder')]).map(norm).filter(Boolean).join(' | ');
    return { selector: '[data-graphyard-target="' + marker + '"]', type: (input.type || 'text').toLowerCase(), name: input.name || '', id: input.id || '', autocomplete: input.getAttribute('autocomplete') || '', inputmode: input.getAttribute('inputmode') || '', label, visible: shown(input) };
  }));
})()`;

// Runs inside the page. It tags the located element so the following command addresses exactly
// that element, whatever GitHub's own ids are.
const locateScript = (kind: string, text: string) => `(() => {
  const kind = ${JSON.stringify(kind)}, wanted = ${JSON.stringify(text)};
  const norm = value => String(value ?? '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const target = norm(wanted);
  // A rendered match wins over a hidden one: GitHub keeps hidden controls with the same label.
  const shown = candidate => candidate.getClientRects().length > 0 && getComputedStyle(candidate).visibility !== 'hidden';
  const pick = matches => matches.find(shown) ?? matches[0] ?? null;
  let element = null;
  if (kind === 'button') element = pick([...document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button], summary')].filter(candidate => norm(candidate.tagName === 'INPUT' ? candidate.value : candidate.textContent) === target));
  else if (kind === 'link') element = pick([...document.querySelectorAll('a[href]')].filter(candidate => norm(candidate.textContent) === target));
  else if (kind === 'label') {
    const label = [...document.querySelectorAll('label')].find(candidate => norm(candidate.textContent).startsWith(target));
    element = label ? label.control ?? (label.htmlFor ? document.getElementById(label.htmlFor) : null) ?? label.querySelector('input, select') : null;
  } else if (kind === 'field') element = document.querySelector('[name="' + wanted.replace(/["\\\\]/g, '\\\\$&') + '"]');
  if (!element) return 'null';
  const marker = 'gy-' + String((window.__graphyardLocated = (window.__graphyardLocated ?? 0) + 1));
  element.setAttribute('data-graphyard-target', marker);
  return JSON.stringify({ selector: '[data-graphyard-target="' + marker + '"]', tag: element.tagName.toLowerCase(), checked: 'checked' in element ? !!element.checked : null, value: 'value' in element ? String(element.value) : null, text: norm(element.textContent), href: element.tagName === 'A' && element.href ? element.href : null, visible: shown(element) });
})()`;

export type AgentBrowserRun = (args: string[]) => string;
const agentBrowserRun: AgentBrowserRun = args => execFileSync('agent-browser', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
/** The command prefix every step uses. Headless, one named session, the operator's own profile. */
export function agentBrowserArguments(browser: MasterBrowser, session: string) {
  return ['--json', '--session', session, '--profile', browser.profile, ...(browser.executable ? ['--executable-path', browser.executable] : [])];
}
/**
 * What agent-browser itself said when a command failed. A non-zero exit still prints its JSON
 * verdict, and stderr carries the rest; the spawn message only repeats the command line.
 */
export function agentBrowserError(error: unknown) {
  const failure = error as { stdout?: unknown; stderr?: unknown; message?: unknown } | null;
  const text = (value: unknown) => Buffer.isBuffer(value) ? value.toString('utf8').trim() : typeof value === 'string' ? value.trim() : '';
  const stdout = text(failure?.stdout), stderr = text(failure?.stderr);
  if (stdout) {
    try { const parsed = JSON.parse(stdout); if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim(); } catch { /* not its JSON verdict */ }
  }
  if (stderr) return stderr;
  if (stdout) return stdout;
  return error instanceof Error ? error.message : String(error);
}
export function agentBrowserPage(browser: MasterBrowser, session: string, run: AgentBrowserRun = agentBrowserRun): BrowserPage {
  const prefix = agentBrowserArguments(browser, session);
  const invoke = (...args: string[]) => {
    let parsed: any;
    try { parsed = JSON.parse(run([...prefix, ...args])); }
    catch (error) { throw new Error(`agent-browser ${args[0]} failed: ${agentBrowserError(error)}`); }
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
    fill: (selector, value) => { try { invoke('fill', selector, value); } catch (error) { throw new Error(withheld(error, value)); } },
    inputs: () => { const result = invoke('eval', inputsScript).result; const value = typeof result === 'string' ? JSON.parse(result) : result; return Array.isArray(value) ? value as PageInput[] : []; },
    screenshot: file => { invoke('screenshot', file); },
    wait: ms => { invoke('wait', String(ms)); },
    close: () => { try { run([...prefix, 'close']); } catch { /* the session may already be gone */ } },
    // agent-browser launches its own Chrome on a copy of the profile: the operator's running Chrome holds the original.
    copy: true,
  };
}

// ---- Recording -----------------------------------------------------------------------------

export interface RecordedStep { n: number; at: string; action: string; args: string[]; result: string | null; screenshot: string | null; error?: string }
export const actionsDirectory = (root: string) => resolve(root, '.graphyard/master-actions');
const truncate = (value: unknown, max = 2_000) => { const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''; return text.length > max ? `${text.slice(0, max)}…` : text; };
const stamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-');

/**
 * Wrap a page so every call is written to the record with a screenshot after each mutation. Once a
 * value is typed (a Confirm-access code), mutations are recorded without one until the field is
 * cleared or a page is opened afresh, since the page may still show the code (GY-1450).
 */
export function recordingPage(page: BrowserPage, record: { directory: string; steps: RecordedStep[]; now: () => Date }): BrowserPage {
  const capture = new Set(['open', 'click', 'setChecked', 'select']);
  let typed = false;
  const step = <T>(action: string, args: string[], run: () => T): T => {
    const entry: RecordedStep = { n: record.steps.length + 1, at: record.now().toISOString(), action, args, result: null, screenshot: null };
    record.steps.push(entry);
    try {
      const result = run();
      entry.result = result === undefined ? null : truncate(result);
      if (action === 'open') typed = false;
      if (capture.has(action) && !typed) {
        const file = resolve(record.directory, `${String(entry.n).padStart(3, '0')}-${action}.png`);
        try { page.screenshot(file); entry.screenshot = relative(record.directory, file); } catch (error) { entry.screenshot = null; entry.error = `screenshot failed: ${error instanceof Error ? error.message : String(error)}`; }
      }
      return result;
    } catch (error) { entry.error = error instanceof Error ? error.message : String(error); throw error; }
  };
  return {
    ...(page.copy ? { copy: true } : {}),
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
    note: (action, args) => step(action, args, () => undefined),
    ...(page.inputs ? { inputs: () => step('inputs', [], () => page.inputs!()) } : {}),
    ...(page.fill ? { fill: (selector: string, value: string) => step('fill', [selector, value ? '[code withheld]' : ''], () => {
      try { page.fill!(selector, value); } catch (error) { throw new Error(withheld(error, value)); }
      typed = value !== '';
    }) } : {}),
  };
}

// ---- Sudo mode -----------------------------------------------------------------------------

export const sudoMethods = ['passkey', 'password', 'authenticator', 'email', 'mobile'] as const;
export type SudoMethod = typeof sudoMethods[number];
/** The methods confirmed on the page or by a typed code, as opposed to a GitHub Mobile push (GY-1450). */
const pageMethods = ['passkey', 'password', 'authenticator', 'email'] as const;
/** What a message calls each method: a Mobile prompt is named "GitHub Mobile" only once one was issued (GY-1450). */
export const sudoMethodNames: Record<SudoMethod, string> = { passkey: 'passkey', password: 'password', authenticator: 'authenticator app', email: 'email code', mobile: 'Mobile' };
/**
 * A sudo-protected GitHub page the operator can open in their own Chrome: confirming access there
 * grants sudo mode to the GitHub session the agent's profile copy shares, which unblocks the flow.
 */
export const sudoProtectedPage = 'https://github.com/settings/apps/new';
export const sudoStateSchema = z.object({
  flow: z.enum(browserFlows), record: z.string().min(1),
  code: z.string().regex(/^\d{2}$/).nullable(), issuedAt: z.string().min(1).max(40), attempt: z.number().int().positive(),
  deadline: z.string().min(1).max(40), state: z.enum(['waiting', 'approved', 'expired']),
  // GY-1442: how access is being confirmed, the page to confirm it on, and, once a Mobile prompt
  // has gone unapproved for a minute, the passkey or password route offered beside it.
  method: z.enum(sudoMethods).optional(), url: z.string().max(2_000).optional(),
  fallback: z.object({ method: z.enum(['passkey', 'password']), url: z.string().max(2_000) }).strict().nullable().optional(),
  // GY-1450: every method the page offered, and whether GitHub was asked to email a code.
  offered: z.array(z.enum(sudoMethods)).max(sudoMethods.length).optional(), emailed: z.boolean().optional(),
  // GY-1459: a handed code found no code field within 10 s; the drive kept it and tries it again.
  field: z.literal('missing').optional(),
  // GY-1459: the flow's browser runs on a copy of the operator's profile (BrowserPage.copy).
  copy: z.boolean().optional(),
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
  return { ...state, instruction: `${sudoInstruction(state, 'your device')}; the ${state.flow} flow is waiting` };
}
/**
 * Where a waiting flow takes an authenticator or email code (GY-1450): a local page, a command, or
 * both. COPY (GY-1459): the drive runs on a copy of the operator's Chrome profile, so sudo mode
 * confirmed in their own Chrome never reaches it; the handoff then offers the local page, opened in
 * their own browser, as the manual route instead.
 */
export interface SudoCodeRoute { page?: string | null; command?: string | null; copy?: boolean }
const listMethods = (methods: readonly SudoMethod[]) => {
  const names = methods.map(method => sudoMethodNames[method]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0] ?? '';
};
/**
 * What a person acts on. A Confirm-access page handed off (anything but a Mobile push): the first
 * line is the one confirmation that always works — once, in the operator's own Chrome, which
 * grants sudo mode to the session the agent's profile copy shares — then every method the page
 * offers, then, when the flow takes codes (ROUTE), where an authenticator or email code goes. A
 * GitHub Mobile prompt: its code and, once it has gone a minute unapproved, the other route too.
 */
export function sudoInstruction(state: Pick<SudoState, 'code' | 'method' | 'url' | 'fallback' | 'offered' | 'emailed' | 'field' | 'copy'>, device = 'your phone', route: SudoCodeRoute = {}) {
  if (state.copy && route.copy === undefined) route = { ...route, copy: true };
  if (state.method && state.method !== 'mobile') {
    const offered = state.offered?.length ? state.offered : [state.method];
    const lines = [`GitHub's Confirm-access page${state.url ? ` (${state.url})` : ''} offers: ${offered.map(method => sudoMethodNames[method]).join(', ')}`];
    if (!route.copy) lines.unshift(`Confirm access once in your own Chrome at ${sudoProtectedPage} with your passkey or password: GitHub then holds sudo mode for the session the agent's browser shares, and the flow continues by itself within 10 s`);
    const where = [route.page ? `at ${route.page}` : '', route.command ? `with ${route.command} CODE` : ''].filter(Boolean).join(' or ');
    if (where && offered.includes('authenticator')) lines.push(`For your authenticator app, enter its 6-digit code ${where}`);
    if (where && offered.includes('email')) lines.push(state.emailed ? `GitHub emailed you a code: enter its 6 digits ${where}`
      : `For an email code, ask for it ${[route.page ? `at ${route.page}` : '', route.command ? `with ${route.command} email` : ''].filter(Boolean).join(' or ')}, then enter its 6 digits ${where}`);
    // GY-1459: the code goes straight to the drive, and a fresh one leaves it the most of its 30 s.
    if (where && offered.includes('authenticator')) lines.push('Enter an authenticator code yourself, right after the app rolls over to a new one: the drive reads it the moment you enter it and types it within 2 s, with nobody passing it on');
    if (route.copy && route.page) lines.push(`Or open ${route.page} in your own browser and click its button there: your own GitHub session holds sudo mode, and setup continues by itself once GitHub returns you to that page`);
    if (state.field === 'missing') lines.push("GitHub's code field did not appear within 10 s: the drive kept your code and tries it again on its next check; once the code has rolled over, enter the new one");
    return lines.join('\n');
  }
  const mobile = state.code ? `Approve the GitHub Mobile prompt on ${device} and choose ${state.code}` : 'Confirm access to GitHub on your device (GitHub Mobile or your passkey)';
  return state.fallback ? `${mobile}, or, if no prompt arrived, confirm with your ${state.fallback.method === 'passkey' ? 'passkey' : 'password'} at ${state.fallback.url}` : mobile;
}
/**
 * Why a Confirm-access wait gave up, naming the method actually in use: the GitHub Mobile prompt
 * only when one was issued, otherwise the methods the page offered (GY-1450).
 */
export function sudoTimeout(state: Pick<SudoState, 'code' | 'method' | 'offered'> | null, offered: readonly SudoMethod[], timeoutMs: number, flow: string, copy = false) {
  const within = `Confirm access was not approved within ${Math.round(timeoutMs / 1000)}s`;
  if (state?.method === 'mobile') return `${within}; approve the GitHub Mobile prompt${state.code ? ` (code ${state.code})` : ''} and rerun master browser ${flow}`;
  const methods = (state?.offered?.length ? state.offered : offered).filter(method => method !== 'mobile');
  return `${within}; confirm access with your ${methods.length ? listMethods(methods) : 'passkey or password'}${copy ? '' : `, or once in your own Chrome at ${sudoProtectedPage},`} and rerun master browser ${flow}`;
}

/** Recognize GitHub's Confirm-access page and what it currently shows. */
export function detectSudo(url: string, text: string) {
  const sudo = /\/sessions\/sudo(?:[/?#]|$)/.test(url) || /\bconfirm access\b/i.test(text) && /\b(github mobile|authenticator|passkey|password|email)\b/i.test(text);
  if (!sudo) return { sudo: false, code: null as string | null, expired: false, mobileOffered: false };
  const mobileOffered = /use github mobile/i.test(text);
  const expired = /\b(expired|didn.t receive|try again|resend)\b/i.test(text);
  // The pairing code is the only line of the page that is exactly two digits.
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const code = lines.find(line => /^\d{2}$/.test(line)) ?? null;
  return { sudo, code, expired, mobileOffered };
}
/** The confirmation methods a Confirm-access page offers (GY-1442, GY-1450). */
export function offeredSudoMethods(text: string): Record<SudoMethod, boolean> {
  return { passkey: /\bpasskey\b/i.test(text), password: /\bpassword\b/i.test(text), authenticator: /\bauthenticator\b|\bauthentication code\b/i.test(text),
    email: /\bvia email\b|\bemail(?:ed)? (?:me )?a code\b|\bemail code\b/i.test(text), mobile: /\bgithub mobile\b/i.test(text) };
}
const routeLabels = { passkey: ['Use your passkey', 'Use passkey', 'Use a passkey'], password: ['Use your password', 'Use password'] } as const;
const authenticatorLabels = ['Use your authenticator app', 'Use authenticator app', 'Use an authenticator app', 'Authenticator app'];
const emailLabels = ['Send a code via email', 'Send code via email', 'Email me a code'];
const codeFieldNames = ['app_otp', 'otp', 'email_otp', 'sudo_otp'];
const codeFieldLabels = ['Authentication code', 'Verification code', 'Enter the code', 'Code'];
const verifyLabels = ['Verify', 'Confirm', 'Submit'];
/** How long a code field may take to render once its view is chosen (GY-1459): 20 checks, 500 ms apart. */
const codeFieldChecks = 20, codeFieldCheckMs = 500;
/**
 * GitHub's Confirm-access code field for METHOD among the page's rendered inputs (GY-1459), by its
 * real attributes rather than one name: a shown text input asking for a one-time code
 * (autocomplete one-time-code, an otp or totp name or id, a label naming an authentication or
 * verification code, a numeric inputmode). The other method's field (email for the authenticator,
 * the app's for email) is never chosen.
 */
export function confirmCodeField(inputs: readonly PageInput[], method: 'authenticator' | 'email'): PageInput | null {
  const other = method === 'authenticator' ? /email/i : /totp|app_otp/i;
  let best: { input: PageInput; score: number } | null = null;
  for (const input of inputs) {
    if (!input.visible || !['text', 'tel', 'number', ''].includes(input.type)) continue;
    const key = `${input.name} ${input.id}`;
    if (other.test(key)) continue;
    const score = (/^one-time-code$/i.test(input.autocomplete.trim()) ? 4 : 0) + (/otp/i.test(key) ? 3 : 0)
      + (/authentication code|verification code|one-time|\bcode\b/i.test(input.label) ? 2 : 0) + (input.inputmode === 'numeric' ? 1 : 0);
    if (score >= 3 && (!best || score > best.score)) best = { input, score };
  }
  return best?.input ?? null;
}

// ---- Sudo codes ------------------------------------------------------------------------------

/**
 * A code the operator hands a waiting Confirm-access flow (GY-1450): six digits from their
 * authenticator app or an email, or `email` to have GitHub email one. The local App setup page and
 * `graphyard up --sudo-code` write it; the flow takes it once, types it into the page and deletes
 * it. It is never logged, recorded, or echoed back.
 */
export const sudoCodeSubmissionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('code'), code: z.string().regex(/^\d{6}$/), at: z.string().min(1).max(40) }).strict(),
  z.object({ kind: z.literal('email'), at: z.string().min(1).max(40) }).strict(),
  // GY-1459: the local App page finished the step itself (the operator registered or installed the
  // App in their own browser); a flow waiting since before AT ends its wait.
  z.object({ kind: z.literal('settled'), at: z.string().min(1).max(40) }).strict(),
]);
export type SudoCodeSubmission = z.infer<typeof sudoCodeSubmissionSchema>;
const sudoCodeFile = (root: string) => resolve(actionsDirectory(root), 'sudo-code.json');
/** How long a handed code waits to be taken: an authenticator code is stale long before this. */
const sudoCodeFreshMs = 600_000;
export async function submitSudoCode(root: string, value: string, now = new Date()): Promise<SudoCodeSubmission['kind']> {
  const trimmed = value.trim();
  const submission: SudoCodeSubmission = trimmed.toLowerCase() === 'email' ? { kind: 'email', at: now.toISOString() }
    : /^\d{6}$/.test(trimmed) ? { kind: 'code', code: trimmed, at: now.toISOString() }
    : (() => { throw new Error('A Confirm-access code is the 6 digits from your authenticator app or email, or "email" to have GitHub email one'); })();
  await mkdir(actionsDirectory(root), { recursive: true, mode: 0o700 });
  await atomicPrivateWrite(sudoCodeFile(root), submission);
  return submission.kind;
}
/**
 * GY-1459: the local App page tells a waiting drive its step was finished in the operator's own
 * browser, where their live session holds sudo mode, so the drive's Confirm-access wait ends.
 */
export async function signalSudoSettled(root: string, now = new Date()) {
  await mkdir(actionsDirectory(root), { recursive: true, mode: 0o700 });
  await atomicPrivateWrite(sudoCodeFile(root), { kind: 'settled', at: now.toISOString() } satisfies SudoCodeSubmission);
}
/** The handed code, taken once: the file is removed whether it was usable or not. */
export async function takeSudoCode(root: string, now = new Date()): Promise<SudoCodeSubmission | null> {
  const file = sudoCodeFile(root);
  let raw: string;
  try { await privateFile(file); raw = await readFile(file, 'utf8'); }
  catch (error: any) { if (error.code === 'ENOENT') return null; await rm(file, { force: true }); return null; }
  await rm(file, { force: true });
  let submission: SudoCodeSubmission;
  try { submission = sudoCodeSubmissionSchema.parse(JSON.parse(raw)); } catch { return null; }
  return now.getTime() - Date.parse(submission.at) > sudoCodeFreshMs ? null : submission;
}
/** How often a waiting flow checks for a handed code (GY-1459), so it is typed within 2 s. */
const codePollMs = 500;
/** How long a kept code is tried again after its field failed to render: a TOTP code's window and its neighbours. */
const heldCodeMs = 90_000;
/** An error message with the code withheld, whatever echoed it. */
const withheld = (error: unknown, code: string) => (error instanceof Error ? error.message : String(error)).split(code).join('[code withheld]');

export interface SudoOptions {
  flow: BrowserFlow; record: string; onCode: (state: SudoState) => Promise<void> | void; onSettled?: (state: SudoState) => Promise<void> | void; sleep?: (ms: number) => Promise<void>; now?: () => Date; timeoutMs?: number; pollMs?: number; maxAttempts?: number;
  /**
   * GY-1442: 'passkey-or-password' hands the operator the page's own confirmation (passkey,
   * password, authenticator or email code) whenever the page offers one and triggers GitHub Mobile
   * only when it offers none (or the operator starts it on the page); 'mobile' (the default for
   * unattended master browser flows) triggers GitHub Mobile first, as the operator chose.
   */
  prefer?: 'passkey-or-password' | 'mobile';
  /** How long a shown Mobile code may go unapproved before the passkey or password route is offered beside it (60 s). */
  mobileFallbackMs?: number;
  /**
   * How often a handed-off wait reopens the page (10 s, GY-1450), so sudo mode granted to the shared
   * session — in the operator's own Chrome, or in the agent's profile — is seen and the flow continues.
   */
  reloadMs?: number;
  /**
   * GY-1450: a code handed to the waiting flow, if any (takeSudoCode); typed into the page, never
   * logged. Checked every 500 ms while the flow waits on the page's own confirmation (GY-1459), so
   * a handed code is typed within 2 s.
   */
  readCode?: () => Promise<SudoCodeSubmission | null> | SudoCodeSubmission | null;
}
/**
 * Pass a Confirm-access prompt without a keyboard: hand the operator the page's confirmation and
 * re-check every 10 s whether the shared session already holds sudo mode, typing in any
 * authenticator or email code they hand over, or trigger GitHub Mobile and surface the pairing
 * code, and wait for the approval with a bounded, retrying poll. Every re-issued code counts as an
 * attempt; the deadline bounds the whole wait. The method used is written to the flow's recorded
 * steps (`sudo-method`); a typed code is recorded as entered (`sudo-code`), never its digits.
 */
export async function passSudo(page: BrowserPage, options: SudoOptions) {
  const now = options.now ?? (() => new Date()), sleep = options.sleep ?? (ms => new Promise<void>(accept => setTimeout(accept, ms)));
  const timeoutMs = options.timeoutMs ?? 180_000, pollMs = options.pollMs ?? 3_000, maxAttempts = options.maxAttempts ?? 3;
  const started = now().getTime(), deadline = new Date(started + timeoutMs).toISOString();
  const prefer = options.prefer ?? 'mobile', mobileFallbackMs = options.mobileFallbackMs ?? 60_000, reloadMs = options.reloadMs ?? 10_000;
  let attempt = 0; let state = null as SudoState | null;
  // GY-1459: a handed code that found no code field, kept for another try while it may still be valid.
  let held = null as Extract<SudoCodeSubmission, { kind: 'code' }> | null, heldTried = 0;
  // The methods the page offered, kept from its first render: the code view hides them.
  const offered = new Set<SudoMethod>();
  const listed = () => sudoMethods.filter(method => offered.has(method));
  let lastReload = started;
  const waiting = (fields: Pick<SudoState, 'code' | 'method'> & Partial<SudoState>): SudoState => ({ flow: options.flow, record: options.record, issuedAt: now().toISOString(), attempt: Math.max(attempt, 1), deadline, state: 'waiting', ...fields });
  const route = (method: 'passkey' | 'password') => {
    for (const label of routeLabels[method]) { const link = page.locate('link', label); if (link?.href) return link.href; }
    return state?.url ?? 'the GitHub Confirm-access page';
  };
  const control = (labels: readonly string[], kinds: readonly ('button' | 'link')[] = ['button', 'link']) => {
    for (const label of labels) for (const kind of kinds) { const found = page.locate(kind, label); if (found && found.visible !== false) return found; }
    return null;
  };
  const activate = (located: Located) => {
    try { page.click(located.selector); } catch (error) { if (!located.href) throw error; page.open(located.href); }
    page.wait(Math.min(pollMs, 1_000));
  };
  const codeField = (method: 'authenticator' | 'email'): { selector: string } | null => {
    // A page that lists its inputs is read by their attributes alone; the named locators are for one that cannot.
    if (page.inputs) return confirmCodeField(page.inputs(), method);
    const usable = (field: Located | null) => !!field && field.visible !== false;
    for (const name of codeFieldNames) { if (method === 'authenticator' && name.startsWith('email')) continue; const field = page.locate('field', name); if (usable(field)) return field; }
    for (const label of codeFieldLabels) { const field = page.locate('label', label); if (usable(field)) return field; }
    return null;
  };
  // The chosen view renders its field asynchronously: wait up to 10 s for it.
  const renderedField = (method: 'authenticator' | 'email') => {
    for (let check = 1; ; check += 1) {
      const field = codeField(method);
      if (field || check >= codeFieldChecks) return field;
      page.wait(codeFieldCheckMs);
    }
  };
  // A handed code: `email` asks GitHub to email one; six digits go into the email view once one
  // was sent, else into the authenticator view, opened first when the page still shows another.
  // A code whose field never rendered is reported and kept, not discarded (GY-1459): 'missing'.
  const enter = async (submission: Exclude<SudoCodeSubmission, { kind: 'settled' }>): Promise<'done' | 'missing'> => {
    if (submission.kind === 'email') {
      const send = offered.has('email') ? control(emailLabels) : null;
      if (!send) { page.note?.('sudo-code', ['email', 'not offered']); return 'done'; }
      activate(send);
      page.note?.('sudo-method', ['email']);
      state = { ...state!, method: 'email', emailed: true };
      await options.onCode(state);
      return 'done';
    }
    const method = state!.emailed ? 'email' : offered.has('authenticator') ? 'authenticator' : 'email';
    let field = codeField(method);
    if (!field) {
      const view = method === 'authenticator' ? control(authenticatorLabels) : null;
      if (view) activate(view);
      field = renderedField(method);
    }
    if (!field || !page.fill) {
      page.note?.('sudo-code', [method, field ? 'page cannot type' : 'no code field']);
      if (field) return 'done';
      if (state!.field !== 'missing') { state = { ...state!, field: 'missing' }; await options.onCode(state); }
      return 'missing';
    }
    try { page.fill(field.selector, submission.code); } catch (error) { throw new Error(withheld(error, submission.code)); }
    const verify = control(verifyLabels, ['button']);
    if (verify) page.click(verify.selector);
    page.wait(Math.min(pollMs, 1_000));
    // A refused code stays in the field: clear it before any later step screenshots the page.
    const left = codeField(method);
    if (left) { try { page.fill(left.selector, ''); } catch { page.note?.('sudo-code', [method, 'field not cleared']); } }
    page.note?.('sudo-code', [method, 'entered']);
    if (state!.field) { const { field: _missing, ...rest } = state!; state = rest; }
    if (state!.method !== method) { page.note?.('sudo-method', [method]); state = { ...state!, method }; }
    return 'done';
  };
  // The older page offers GitHub Mobile as a button; the passkey-first page keeps that button
  // hidden and offers a "Use GitHub Mobile" link under "Having problems?". A rendered control is
  // activated first, and an anchor whose click fails is followed through its href instead. When a
  // rendered button's click fails, the link of the same label is located and tried as well.
  const issue = (label: string) => {
    if (attempt >= maxAttempts) throw new Error(`GitHub Mobile confirmation was re-issued ${attempt} times without approval; approve the prompt on your device and rerun master browser ${options.flow}`);
    const button = page.locate('button', label);
    const rendered = !!button && button.visible !== false;
    const controls = [button, rendered ? null : page.locate('link', label)].filter((control): control is Located => !!control);
    if (!controls.length) throw new Error(`Confirm-access page offers no "${label}" control; only GitHub Mobile confirmation is automated, so confirm access in your own browser and rerun master browser ${options.flow}`);
    controls.sort((a, b) => Number(b.visible !== false) - Number(a.visible !== false));
    attempt += 1;
    const failures: string[] = [];
    for (let index = 0; index < controls.length; index += 1) {
      const control = controls[index];
      try { page.click(control.selector); page.wait(Math.min(pollMs, 1_000)); return; }
      catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
      if (control.href) { page.open(control.href); return; }
      if (rendered && control === button) {
        const link = page.locate('link', label);
        if (link && link.selector !== button.selector) controls.push(link);
      }
    }
    throw new Error(`Confirm-access "${label}" could not be activated (${failures.join('; ')}); confirm access in your own browser and rerun master browser ${options.flow}`);
  };
  for (;;) {
    const current = page.url(), text = page.text();
    const detected = detectSudo(current, text);
    if (!detected.sudo) {
      if (state) { state = { ...state, state: 'approved' }; await options.onSettled?.(state); }
      return { passed: !!state, attempts: attempt, code: state?.code ?? null } as { passed: boolean; attempts: number; code: string | null; settled?: true };
    }
    const methods = offeredSudoMethods(text);
    for (const method of sudoMethods) if (methods[method]) offered.add(method);
    if (now().getTime() - started >= timeoutMs) {
      if (state) { state = { ...state, state: 'expired' }; await options.onSettled?.(state); }
      throw new Error(sudoTimeout(state, listed(), timeoutMs, options.flow, !!page.copy));
    }
    const handed = !!state && state.method !== 'mobile';
    if (!detected.code && (handed || !state && prefer === 'passkey-or-password' && pageMethods.some(method => methods[method]))) {
      // The page's own confirmation first: the operator confirms (here or once in their own
      // Chrome) or hands a code; GitHub Mobile is started only if they choose it on the page, and
      // its code is then surfaced like any other.
      if (!state) {
        const method = pageMethods.find(method => methods[method])!;
        page.note?.('sudo-method', [method]);
        state = waiting({ code: null, method, url: current, offered: listed(), ...(page.copy ? { copy: true } : {}) });
        await options.onCode(state);
      } else {
        // A held code is tried again once per re-check, while it may still be valid (a TOTP window is 30 s; GitHub accepts its neighbours).
        if (held && now().getTime() - Date.parse(held.at) > heldCodeMs) { page.note?.('sudo-code', ['authenticator', 'kept code expired']); held = null; }
        let submission = await options.readCode?.() ?? null;
        // A kept code is tried on a freshly loaded page: the view that failed to render it is reloaded first.
        if (!submission && held && now().getTime() - heldTried >= reloadMs) { page.open(current); submission = held; }
        if (submission?.kind === 'settled') {
          // The step was finished on the local App page in the operator's own browser, after this wait began.
          if (Date.parse(submission.at) >= started) {
            page.note?.('sudo-settled', ['local App page']);
            state = { ...state, state: 'approved' }; await options.onSettled?.(state);
            return { passed: true, attempts: attempt, code: state.code, settled: true as const };
          }
          continue;
        }
        if (submission) {
          const outcome = await enter(submission);
          held = outcome === 'missing' && submission.kind === 'code' ? submission : null; heldTried = now().getTime();
          lastReload = now().getTime(); continue;
        }
        // Re-check whether the shared session holds sudo mode now: the page no longer asks on reload.
        if (now().getTime() - lastReload >= reloadMs) { lastReload = now().getTime(); page.open(current); continue; }
      }
      await sleep(options.readCode ? Math.min(pollMs, codePollMs) : pollMs);
      continue;
    }
    if (!state && !detected.code) { issue('Use GitHub Mobile'); continue; }
    if (state && detected.expired && !detected.code) { issue(detected.mobileOffered ? 'Use GitHub Mobile' : 'Try again'); state = null; continue; }
    if (detected.code && detected.code !== state?.code) {
      if (state?.method !== 'mobile') page.note?.('sudo-method', ['mobile']);
      state = waiting({ code: detected.code, method: 'mobile', url: current });
      await options.onCode(state);
    } else if (!state) {
      page.note?.('sudo-method', ['mobile']);
      state = waiting({ code: null, method: 'mobile', url: current });
      await options.onCode(state);
    } else if (state.code && !state.fallback && (offered.has('passkey') || offered.has('password')) && now().getTime() - Date.parse(state.issuedAt) >= mobileFallbackMs) {
      // No approval within the minute: the push may never arrive, so the other route is offered beside it.
      const method = offered.has('passkey') ? 'passkey' : 'password';
      state = { ...state, fallback: { method, url: route(method) } };
      page.note?.('sudo-fallback', [method, state.fallback!.url]);
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
  /** The control plane's App-credential read of the installation (`GET /api/github/installation`). */
  installation?: () => Promise<InstallationState>;
  now?: () => Date; sleep?: (ms: number) => Promise<void>; sudo?: Partial<Pick<SudoOptions, 'timeoutMs' | 'pollMs' | 'maxAttempts'>>;
  dryRun?: boolean;
}
type Observed = { installation: { id: number; slug: string; account: string; accountType: string; installationUrl: string; permissions: Record<string, string>; app: Record<string, string> } };
const apiRun: ProtectionRun = (command, args, input) => execFileSync(command, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });

function githubLogin(api: ProtectionRun) {
  try { const user = JSON.parse(api('gh', ['api', 'user'])); return typeof user?.login === 'string' ? user.login : null; } catch { return null; }
}
/**
 * The control-plane App's installation and the permissions the App requests, as the App's own
 * installation credential reads them through the control plane (GY-964). The operator's gh token
 * is never asked: a token without the scopes `user/installations` needs saw no installation and
 * refused a flow the App could complete.
 */
export async function observeInstallation(read: FlowDependencies['installation'], appId: number): Promise<Observed['installation']> {
  if (!read) throw new Error('This flow reads the installation through the control plane\'s App credential; run it as graphyard master browser');
  let state: InstallationState;
  try { state = await read(); } catch (error) { throw new Error(`The control plane could not read App ${appId}'s installation with the App's own credential: ${error instanceof Error ? error.message : String(error)}`); }
  if (Number(state?.appId) !== appId) throw new Error(`The control plane reports App ${state?.appId}, not App ${appId} this master is bound to; rerun master init against the right control plane`);
  if (state.suspended) throw new Error(`App ${state.slug}'s installation ${state.installationId} is suspended; restore it at ${state.installationUrl}`);
  return { id: Number(state.installationId), slug: String(state.slug), account: String(state.account ?? ''), accountType: String(state.accountType ?? 'User'), installationUrl: String(state.installationUrl ?? ''), permissions: state.permissions ?? {}, app: state.app ?? {} };
}
const installationSettingsUrl = (installation: Observed['installation']) => /^https:\/\/github\.com\//.test(installation.installationUrl) ? installation.installationUrl
  : installation.accountType === 'Organization'
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
      const installation = await observeInstallation(dependencies.installation, config.githubAppId);
      before = { app: installation.app, installation: installation.permissions };
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
        const updated = await observeInstallation(dependencies.installation, config.githubAppId);
        after = { app: updated.app, installation: updated.permissions };
        const still = missingPermissions((after as any).app);
        verified = !still.length; outcome = verified ? 'applied' : 'refused';
        reason = verified ? `App now requests ${missing.length} raised permission(s); run master browser installation-accept so the installation grants them` : `GitHub still reports ${still.join(', ')} after saving`;
      }
    } else if (flow === 'installation-accept') {
      const installation = await observeInstallation(dependencies.installation, config.githubAppId);
      before = { installation: installation.permissions, app: installation.app };
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
          const updated = await observeInstallation(dependencies.installation, config.githubAppId);
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
