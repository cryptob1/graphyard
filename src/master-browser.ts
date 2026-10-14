import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
 *
 * The capture flow (GY-1686) administers nothing: it opens the sudo-protected App permissions page
 * only to keep the Confirm-access views GitHub shows there as redacted fixtures, through the same
 * keep logic the administrative flows run, and stops without submitting, typing or sending anything.
 */
export const browserFlows = ['app-permissions', 'installation-accept', 'protection', 'capture'] as const;
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
  /** The raw markup of the Confirm-access form(s) on the page, or null when it shows none (GY-1461); redacted before it is kept. */
  markup?(): string | null;
  /** Every button and link under the element whose text is HEADING (GY-1781: "Having problems?"), by tag and label, so a refused capture names what the page offered. */
  controls?(heading: string): PageControl[];
  /** Every typeable input the page renders now, each tagged so its selector addresses exactly it (GY-1459). */
  inputs?(): PageInput[];
  /**
   * GY-1459: the page runs in its own browser on a copy of the operator's profile (browserProfileMode),
   * so sudo mode they confirm in their own Chrome never reaches it.
   */
  copy?: boolean;
}
export interface PageControl { tag: string; label: string }
/**
 * A rendered input as the page itself describes it (GY-1459): its type, name, id, autocomplete and
 * inputmode, the text naming it (its labels, aria-label, aria-labelledby or placeholder), and
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
    const label = [...new Set([...(input.labels ?? [])].map(node => node.textContent).concat(labelled, [input.getAttribute('aria-label'), input.getAttribute('placeholder')]).map(norm).filter(Boolean))].join(' | ');
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

// Runs inside the page: the buttons and links under the element whose own text is HEADING, by tag
// and label (GY-1781). GitHub's passkey-first Confirm-access page lists its other methods under
// "Having problems?"; a page without that heading lists the controls of its whole body instead.
const controlsScript = (heading: string) => `(() => {
  const wanted = ${JSON.stringify(heading)};
  const norm = value => String(value ?? '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const own = element => norm([...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(' ')) || norm(element.textContent);
  const heading = [...document.querySelectorAll('summary, h1, h2, h3, h4, h5, h6, legend, p, strong, span, div, label')].find(candidate => own(candidate) === norm(wanted)) ?? null;
  const scope = heading ? heading.closest('details') ?? heading.parentElement ?? document.body : document.body;
  const controls = [...scope.querySelectorAll('button, input[type=submit], input[type=button], a[href], a[role=button], summary')].filter(candidate => candidate !== heading);
  return JSON.stringify(controls.slice(0, 30).map(control => ({ tag: control.tagName.toLowerCase(), label: norm(control.tagName === 'INPUT' ? control.value : control.textContent) })));
})()`;

// Runs inside the page: the outerHTML of every Confirm-access form (one posting to the sudo
// session, or one holding a code or passkey field), hidden views included.
const sudoFormScript = `(() => {
  const sudo = form => /sudo/i.test(form.getAttribute('action') || '') || !!form.querySelector('input[name$="otp"], input[autocomplete="one-time-code"], webauthn-get, [data-webauthn-get]');
  const forms = [...document.querySelectorAll('form')].filter(sudo);
  return JSON.stringify(forms.length ? forms.map(form => form.outerHTML).join('\\n') : null);
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
    screenshot: file => { invoke('screenshot', file); },
    wait: ms => { invoke('wait', String(ms)); },
    close: () => { try { run([...prefix, 'close']); } catch { /* the session may already be gone */ } },
    markup: () => { const result = invoke('eval', sudoFormScript).result; const value = typeof result === 'string' ? JSON.parse(result) : result; return typeof value === 'string' ? value : null; },
    controls: heading => { const result = invoke('eval', controlsScript(heading)).result; const value = typeof result === 'string' ? JSON.parse(result) : result; return Array.isArray(value) ? value.filter((control): control is PageControl => !!control && typeof control.tag === 'string' && typeof control.label === 'string') : []; },
    inputs: () => { const result = invoke('eval', inputsScript).result; const value = typeof result === 'string' ? JSON.parse(result) : result; return Array.isArray(value) ? value as PageInput[] : []; },
    // GY-1459: agent-browser opens a profile named by its name as a copy of its own; the operator's running Chrome holds the original.
    copy: browserProfileMode(browser.profile) === 'copy',
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
    // The page's markup still carries session-bound values, so the step records only its length.
    ...(page.markup ? { markup: () => { let html: string | null = null; step('markup', [], () => { html = page.markup!(); return html === null ? null : `${html.length} chars`; }); return html; } } : {}),
    ...(page.controls ? { controls: (heading: string) => step('controls', [heading], () => page.controls!(heading)) } : {}),
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
 * both; and, when known, whether the drive shares the operator's live Chrome session (GY-1457):
 * PROFILE names it, or COPY (GY-1459) says the drive runs on a copy of their profile. On a copy a
 * confirmation in their own Chrome never reaches the drive, so the handoff offers the local page,
 * opened in their own browser, as the manual route instead.
 */
export interface SudoCodeRoute { page?: string | null; command?: string | null; profile?: { mode: BrowserProfileMode; name: string } | null; copy?: boolean }
/**
 * Whether the headless drive shares the operator's live Chrome session (GY-1457). A Chrome profile
 * named by its name (such as Default) is opened by agent-browser as a copy, whose session is its
 * own, so a confirmation in the operator's Chrome may not reach it; a profile directory named by
 * its path is opened as itself, so the session is the one that directory's Chrome holds.
 */
export type BrowserProfileMode = 'shared' | 'copy';
export const browserProfileMode = (profile: string): BrowserProfileMode => /[\\/]/.test(profile) ? 'shared' : 'copy';
const listMethods = (methods: readonly SudoMethod[]) => {
  const names = methods.map(method => sudoMethodNames[method]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0] ?? '';
};
/**
 * What a person acts on. A Confirm-access page handed off (anything but a Mobile push): the first
 * line is the one confirmation that always works — once, in the operator's own Chrome, which
 * grants sudo mode to the session the agent's profile copy shares — then every method the page
 * offers, then, when the flow takes codes (ROUTE), where an authenticator or email code goes. When
 * ROUTE names the drive's profile (GY-1457), a first line says whether it shares the live Chrome
 * session; on a copy the own-Chrome line is left out, and when the page offers no code method the
 * drive can take, that line says so and names what does reach it (Mobile, a shared profile, the
 * App-import route). Only the code methods the page offers are ever listed. A
 * GitHub Mobile prompt: its code and, once it has gone a minute unapproved, the other route too.
 */
export function sudoInstruction(state: Pick<SudoState, 'code' | 'method' | 'url' | 'fallback' | 'offered' | 'emailed' | 'field' | 'copy'>, device = 'your phone', route: SudoCodeRoute = {}) {
  if (state.method && state.method !== 'mobile') {
    const offered = state.offered?.length ? state.offered : [state.method];
    const profile = route.profile;
    // GY-1459: a drive on a profile copy, known from the route's profile, the route itself, or the state the page recorded.
    const copy = profile ? profile.mode === 'copy' : !!(route.copy ?? state.copy);
    const where = [route.page ? `at ${route.page}` : '', route.command ? `with ${route.command} CODE` : ''].filter(Boolean).join(' or ');
    // Only a code method the page offers can be typed in: passSudo acts on nothing else.
    const codes = where ? (['authenticator', 'email'] as const).filter(method => offered.includes(method)) : [];
    const unreached = `none of the page's methods reaches the drive: ${offered.includes('mobile') ? 'rerun with --github-mobile to approve a GitHub Mobile prompt, ' : ''}pass --browser-profile a Chrome profile directory path to share your live session, or take the App-import route`;
    const lines = [
      ...(profile ? [profile.mode === 'shared' ? `The drive uses your live Chrome session (profile ${profile.name}), so a confirmation in your own Chrome reaches it`
        : `The drive runs on a copy of your Chrome profile ${profile.name}, not your live session, so a confirmation in your own Chrome does not reach it: ${codes.length ? 'use a code below' : unreached}`] : []),
      ...(copy ? [] : [`Confirm access once in your own Chrome at ${sudoProtectedPage} with your passkey or password: GitHub then holds sudo mode for the session the agent's browser shares, and the flow continues by itself within 10 s`]),
      `GitHub's Confirm-access page${state.url ? ` (${state.url})` : ''} offers: ${offered.map(method => sudoMethodNames[method]).join(', ')}`];
    if (codes.includes('authenticator')) lines.push(`For your authenticator app, enter its 6-digit code ${where}`);
    if (codes.includes('email')) lines.push(state.emailed ? `GitHub emailed you a code: enter its 6 digits ${where}`
      : `For an email code, ask for it ${[route.page ? `at ${route.page}` : '', route.command ? `with ${route.command} email` : ''].filter(Boolean).join(' or ')}, then enter its 6 digits ${where}`);
    // GY-1459: the code goes straight to the drive, and a fresh one leaves it the most of its 30 s.
    if (codes.includes('authenticator')) lines.push('Enter an authenticator code yourself, right after the app rolls over to a new one: the drive reads it the moment you enter it and types it within 2 s, with nobody passing it on');
    // GY-1459: on a copy, the one-click manual route is the local page in the operator's own browser, whose live session holds sudo mode.
    if (copy && route.page) lines.push(`Or open ${route.page} in your own browser and click its button there: your own GitHub session holds sudo mode, and setup continues by itself once GitHub returns you to that page`);
    if (state.field === 'missing') lines.push("GitHub's code field did not appear within 10 s: the drive kept your code and tries it again on its next check; once the code has rolled over, enter the new one");
    return lines.join('\n');
  }
  const mobile = state.code ? `Approve the GitHub Mobile prompt on ${device} and choose ${state.code}` : 'Confirm access to GitHub on your device (GitHub Mobile or your passkey)';
  const prompt = state.fallback ? `${mobile}, or, if no prompt arrived, confirm with your ${state.fallback.method === 'passkey' ? 'passkey' : 'password'} at ${state.fallback.url}` : mobile;
  // GY-1459: the same page offers its code methods and, on a profile copy, the local App page: both are named beside the prompt.
  const where = [route.page ? `at ${route.page}` : '', route.command ? `with ${route.command} CODE` : ''].filter(Boolean).join(' or ');
  const codes = where ? (['authenticator', 'email'] as const).filter(method => state.offered?.includes(method)) : [];
  const copy = route.profile ? route.profile.mode === 'copy' : !!(route.copy ?? state.copy);
  const more = [
    ...(codes.includes('authenticator') ? [`Or enter your authenticator app's 6-digit code ${where}: the drive types it within 2 s`] : []),
    ...(codes.includes('email') ? [`Or ask for an email code ${[route.page ? `at ${route.page}` : '', route.command ? `with ${route.command} email` : ''].filter(Boolean).join(' or ')}, then enter its 6 digits ${where}`] : []),
    ...(copy && route.page ? [`Or open ${route.page} in your own browser and click its button there: your own GitHub session holds sudo mode, and setup continues by itself once GitHub returns you to that page`] : []),
  ];
  return [prompt, ...more].join('\n');
}
/**
 * Why a Confirm-access wait gave up, naming the method actually in use: the GitHub Mobile prompt
 * only when one was issued, otherwise the methods the page offered (GY-1450).
 */
export function sudoTimeout(state: Pick<SudoState, 'code' | 'method' | 'offered'> | null, offered: readonly SudoMethod[], timeoutMs: number, flow: string, copy = false) {
  const within = `Confirm access was not approved within ${Math.round(timeoutMs / 1000)}s`;
  if (state?.method === 'mobile') return `${within}; approve the GitHub Mobile prompt${state.code ? ` (code ${state.code})` : ''} and rerun master browser ${flow}`;
  const methods = (state?.offered?.length ? state.offered : offered).filter(method => method !== 'mobile');
  // GY-1459: a profile copy never sees a confirmation in the operator's own Chrome, so it is not offered.
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
// GY-1459: GitHub's recorded authenticator view names its field sudo_app_otp (id app_totp) and labels it
// "Enter the verification code"; the email view's is sudo_email_otp. The older names stay for pages that keep them.
const codeFieldNames = ['app_otp', 'sudo_app_otp', 'otp', 'email_otp', 'sudo_email_otp', 'sudo_otp'];
const codeFieldLabels = ['Authentication code', 'Verification code', 'Enter the verification code', 'Enter the code', 'Code'];
const verifyLabels = ['Verify', 'Confirm', 'Submit'];
/** How long a code field may take to render once its view is chosen (GY-1459): 20 checks, 500 ms apart. */
const codeFieldChecks = 20, codeFieldCheckMs = 500;
/**
 * GitHub's Confirm-access code field for METHOD among the page's rendered inputs (GY-1459), by the
 * attributes its recorded authenticator view shows (master browser capture of 2026-10-14, record
 * 2026-10-14T06-29-13-782Z-capture-1920704a, confirm-access-authenticator.html): a shown text input
 * named sudo_app_otp with id app_totp, labelled "Enter the verification code", inputmode numeric,
 * autocomplete off and a 6-digit pattern. A field is therefore scored on an otp or totp name or id,
 * a label naming a verification or authentication code, a numeric inputmode, and autocomplete
 * one-time-code where a page sets it, never on one name. Hidden inputs are never chosen, nor is the
 * other method's field: the email view's sudo_email_otp for the authenticator, the app's for email.
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

// ---- Confirm-access form capture ---------------------------------------------------------------

/** What every session-bound value in a captured Confirm-access form is replaced with (GY-1461). */
export const sudoFormRedaction = '[graphyard-redacted]';
// Attributes whose value is bound to the session, whatever element carries them.
const secretAttribute = /token|nonce|csrf|secret|challenge|signature|json/i;
// Inputs whose value attribute is structure, not something the session or the operator put there.
const structuralInputs = new Set(['submit', 'button', 'reset', 'checkbox', 'radio', 'image']);
const unescapeAttribute = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
/**
 * A Confirm-access form's markup with no session-bound value left: every hidden input's value,
 * every attribute named like a token, nonce, csrf token or secret, and the value of every text or
 * password input is replaced by sudoFormRedaction. Names, ids, labels and autocomplete stay. A
 * one-time code shown as text — a GitHub Mobile pairing code, or any element whose whole text is a
 * short run of digits — and every CODES value in text or in any attribute are redacted too (GY-1482).
 * With EVERYVALUE, a structural input's value (a submit button's label, a checkbox's value) goes too:
 * a Confirm-access capture keeps no value attribute contents at all.
 */
export function redactSudoForm(html: string, codes: readonly string[] = [], everyValue = false) {
  const known = codes.filter(code => /^\w+$/.test(code)).map(code => new RegExp(`\\b${code}\\b`, 'g'));
  const holdsCode = (value: string) => known.some(pattern => { pattern.lastIndex = 0; return pattern.test(value); });
  const tags = html.replace(/<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g, (_tag, name: string, body: string, close: string) => {
    const attributes = [...body.matchAll(/([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)]
      .map(([, key, double, single, bare]) => ({ key, value: double ?? single ?? bare ?? null }));
    const input = name.toLowerCase() === 'input';
    const type = (attributes.find(attribute => attribute.key.toLowerCase() === 'type')?.value ?? 'text').toLowerCase();
    const rewritten = attributes.map(({ key, value }) => {
      if (value === null) return key;
      const secret = secretAttribute.test(key) || input && key.toLowerCase() === 'value' && (everyValue || !structuralInputs.has(type)) || holdsCode(unescapeAttribute(value));
      return `${key}="${secret ? sudoFormRedaction : escapeAttribute(unescapeAttribute(value))}"`;
    });
    return `<${name}${rewritten.map(attribute => ` ${attribute}`).join('')}${close ? ' /' : ''}>`;
  });
  return tags.replace(/>([^<]*)</g, (_text, shown: string) => `>${known.reduce((text, pattern) => text.replace(pattern, sudoFormRedaction), shown.replace(/^(\s*)\d{2,8}(\s*)$/, `$1${sudoFormRedaction}$2`))}<`);
}
// The links that open a method's view without sending anything. A "Send a code via email" control
// emails a code and a "Use GitHub Mobile" control sends a push, so neither is followed here: their
// views are kept when the flow itself selects them (SudoOptions.keep).
const sudoViewLinks: Record<'passkey' | 'authenticator' | 'email', readonly string[]> = { passkey: routeLabels.passkey, authenticator: authenticatorLabels, email: ['Use email', 'Use your email', 'Use an email code', 'Use email code', 'Email code'] };
export interface CapturedSudoForm { view: 'landing' | 'authenticator' | 'email'; file: string; url: string }
/** The heading GitHub's passkey-first Confirm-access page lists its other methods under (GY-1781). */
export const sudoProblemsHeading = 'Having problems?';
export type ControlActivation = { outcome: 'activated' | 'absent' } | { outcome: 'failed'; failures: string[] };
/**
 * Activate the Confirm-access control labelled LABEL the way the GitHub Mobile route does (GY-1450,
 * GY-1781): the older page offers a method as a button, the passkey-first page as a form button or
 * a link under "Having problems?". A rendered button is activated first, and an anchor whose click
 * fails is followed through its href instead; when a rendered button's click fails, the link of the
 * same label is located and tried as well. `absent` when the page has no such control, `activated`
 * once one responded (after WAITMS), else the failure of every try.
 */
export function activateSudoControl(page: BrowserPage, label: string, waitMs: number): ControlActivation {
  const button = page.locate('button', label);
  const rendered = !!button && button.visible !== false;
  const controls = [button, rendered ? null : page.locate('link', label)].filter((control): control is Located => !!control);
  if (!controls.length) return { outcome: 'absent' };
  controls.sort((a, b) => Number(b.visible !== false) - Number(a.visible !== false));
  const failures: string[] = [];
  for (let index = 0; index < controls.length; index += 1) {
    const control = controls[index];
    try { page.click(control.selector); page.wait(waitMs); return { outcome: 'activated' }; }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    if (control.href) { page.open(control.href); return { outcome: 'activated' }; }
    if (rendered && control === button) {
      const link = page.locate('link', label);
      if (link && link.selector !== button.selector) controls.push(link);
    }
  }
  return { outcome: 'failed', failures };
}
/** The controls under "Having problems?" as a refused capture names them: `button "Use GitHub Mobile", a "Use your password"`. */
export function describeSudoControls(page: BrowserPage, heading = sudoProblemsHeading) {
  if (!page.controls) return `the page cannot list the controls under "${heading}"`;
  let controls: PageControl[];
  try { controls = page.controls(heading); } catch (error) { return `the controls under "${heading}" could not be listed: ${error instanceof Error ? error.message : String(error)}`; }
  return controls.length ? `controls under "${heading}": ${controls.map(control => `${control.tag} "${control.label}"`).join(', ')}` : `no control under "${heading}"`;
}

/** The views of a Confirm-access page saved for fixtures: the one it loaded on and each method's (GY-1482). */
export const confirmAccessViews = ['landing', 'passkey', 'authenticator', 'email', 'mobile'] as const;
export type ConfirmAccessView = typeof confirmAccessViews[number];
/** Where a flow record keeps its Confirm-access captures, beside its steps and screenshots. */
export const confirmAccessDirectory = 'confirm-access';
export const confirmAccessFile = (view: ConfirmAccessView) => `${confirmAccessDirectory}/confirm-access-${view}.html`;
export interface ConfirmAccessCapture { view: ConfirmAccessView; file: string; url: string; at: string }
/**
 * Save forms' markup HTML as VIEW's Confirm-access capture in the flow record DIRECTORY, redacted
 * first (CODES are the one-time codes the page showed), replacing an earlier capture of the view.
 */
async function saveConfirmAccess(page: BrowserPage, directory: string, view: ConfirmAccessView, html: string, codes: readonly string[], now: () => Date): Promise<ConfirmAccessCapture> {
  const file = confirmAccessFile(view);
  await mkdir(resolve(directory, confirmAccessDirectory), { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, file), `${redactSudoForm(html, codes, true)}\n`, { mode: 0o600 });
  page.note?.('confirm-access-capture', [view, file]);
  return { view, file, url: page.url(), at: now().toISOString() };
}
/**
 * Save the Confirm-access forms the page shows now as VIEW's capture (GY-1482): called after each
 * method the flow selects. Throws when the page shows no Confirm-access form.
 */
export async function captureConfirmAccess(page: BrowserPage, directory: string, view: ConfirmAccessView, options: { codes?: readonly string[]; now?: () => Date } = {}) {
  if (!page.markup) throw new Error('the page cannot read markup');
  const html = page.markup();
  if (!html) throw new Error('no Confirm-access form found');
  return saveConfirmAccess(page, directory, view, html, options.codes ?? [], options.now ?? (() => new Date()));
}
/**
 * Keep the markup of a Confirm-access page's forms for fixtures (GY-1461): the view it landed on,
 * then each code view it offers (authenticator app, email code), opened through its own control —
 * a rendered button first, then a link — never typed into or submitted, and the landing page
 * reopened afterwards so the flow proceeds exactly as before. A code view is kept only once its
 * page actually opened: a control the page never answers is a recorded failure, never a landing
 * form kept under the view's name (GY-1781 review). Each form is redacted before it is written.
 * A failure is recorded as a step with its error and never thrown; the capture stops once its time
 * budget is spent.
 *
 * The same reads are saved as the flow's Confirm-access captures too (GY-1482, ONCAPTURE), with the
 * passkey view besides: opened by its link, or, on a page that asks for the passkey on the view it
 * loads on, that landing view itself — its button starts WebAuthn, so it is never pressed.
 */
export async function captureSudoForms(page: BrowserPage, directory: string, options: { now?: () => Date; budgetMs?: number; onCapture?: (capture: ConfirmAccessCapture) => void } = {}): Promise<CapturedSudoForm[]> {
  const captured: CapturedSudoForm[] = [];
  const failed = (view: string, error: unknown) => page.note?.('sudo-form-capture', [view, `failed: ${error instanceof Error ? error.message : String(error)}`]);
  const missed = (view: string, error: unknown) => page.note?.('confirm-access-capture', [view, `failed: ${error instanceof Error ? error.message : String(error)}`]);
  if (!page.markup) { failed('landing', 'the page cannot read markup'); return captured; }
  // GY-1781: each code view's control is looked for as a button and as a link under every label it
  // may carry, and a view is read once it opens, so the budget allows for those extra page reads.
  const now = options.now ?? (() => new Date()), budgetMs = options.budgetMs ?? 45_000;
  const started = now().getTime();
  let landing: string, text: string;
  try { landing = page.url(); text = page.text(); } catch (error) { failed('landing', error); return captured; }
  let landingHtml: string | null = null;
  const confirmAccess = async (view: ConfirmAccessView, html: string) => {
    try { options.onCapture?.(await saveConfirmAccess(page, directory, view, html, [], now)); } catch (error) { missed(view, error); }
  };
  const keep = async (view: CapturedSudoForm['view'] | 'passkey') => {
    const html = page.markup!();
    if (!html) throw new Error('no Confirm-access form found');
    if (view === 'landing') landingHtml = html;
    if (view !== 'passkey') {
      const file = `sudo-form-${view}.html`;
      await writeFile(resolve(directory, file), `${redactSudoForm(html)}\n`, { mode: 0o600 });
      captured.push({ view, file, url: page.url() });
      page.note?.('sudo-form-capture', [view, file]);
    }
    await confirmAccess(view, html);
  };
  try { await keep('landing'); } catch (error) { failed('landing', error); }
  const offered = offeredSudoMethods(text);
  // A view link the capture follows counts as offering that view, whatever the page's prose says.
  const linked = (view: keyof typeof sudoViewLinks) => sudoViewLinks[view].some(label => text.toLowerCase().includes(label.toLowerCase()));
  let moved = false;
  for (const view of ['passkey', 'authenticator', 'email'] as const) {
    if (!offered[view] && !linked(view)) continue;
    const fail = view === 'passkey' ? missed : failed;
    if (now().getTime() - started >= budgetMs) { fail(view, `capture budget of ${Math.round(budgetMs / 1000)}s spent`); break; }
    try {
      if (moved) { page.open(landing); moved = false; }
      if (view === 'passkey') {
        // The passkey view is reached by its link alone: a "Use passkey" button starts WebAuthn.
        let link: Located | null = null;
        for (const label of sudoViewLinks.passkey) { link = page.locate('link', label); if (link) break; }
        if (!link) { if (landingHtml) await confirmAccess('passkey', landingHtml); else missed('passkey', 'no passkey view link and no landing form'); continue; }
        moved = true;
        try { page.click(link.selector); } catch (error) { if (!link.href) throw error; page.open(link.href); }
        page.wait(1_000);
      } else {
        // GY-1781: a code view opens through whichever control carries one of its labels, a rendered
        // button first and then a link, as the GitHub Mobile route does: the passkey-first page
        // offers "Use your authenticator app" under "Having problems?" as a form button, not a link.
        // When no label is offered at all, the failure names every control under that heading.
        let activated: string | null = null;
        for (const label of sudoViewLinks[view]) {
          const result = activateSudoControl(page, label, 1_000);
          if (result.outcome === 'absent') continue;
          moved = true;
          if (result.outcome === 'failed') throw new Error(result.failures.join('; then the link of the same label: '));
          activated = label; break;
        }
        if (!activated) throw new Error(`${view === 'email' ? 'no email view control (only a control that sends a code, which is not followed)' : 'no authenticator view control'}; ${describeSudoControls(page)}`);
        // The view is kept only once it actually opened (GY-1781 review): a click the page never
        // answers would otherwise keep the landing form under the view's name.
        awaitView(view);
      }
      await keep(view);
    } catch (error) { fail(view, error); }
  }
  if (moved) restoreSudoLanding(page, landing, text, failed);
  return captured;

  // The view has opened once the page's text differs from the landing's: a view the page switches
  // to client-side can take a moment longer than the activation's own wait, within the budget. A
  // view that never opens is a failure, never a capture: a landing still shown after the reads is
  // thrown so no markup is kept under the view's name (GY-1781 review).
  function awaitView(view: 'authenticator' | 'email') {
    for (let tries = 0; tries < 4; tries += 1) {
      let shown: string;
      try { shown = page.text(); } catch (error) { throw new Error(`the ${view} view could not be read after its control was activated: ${error instanceof Error ? error.message : String(error)}`); }
      if (shown !== text) return;
      if (now().getTime() - started >= budgetMs) break;
      page.wait(1_000);
    }
    throw new Error(`the ${view} view did not open: its control was activated but the page still shows the view it landed on, so nothing is kept for it`);
  }
}
/**
 * Reopen a Confirm-access page's landing view after a capture moved off it, retrying once, until it
 * shows the same address and the same offered methods as before; each failed try is noted as a
 * `restore` step. True when the landing view shows again.
 */
export function restoreSudoLanding(page: BrowserPage, landing: string, text: string, failed: (view: string, error: unknown) => void, tries = 2) {
  const methods = JSON.stringify(offeredSudoMethods(text));
  const shown = () => { try { return page.url() === landing && JSON.stringify(offeredSudoMethods(page.text())) === methods; } catch { return false; } };
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      page.open(landing);
      if (shown()) return true;
      throw new Error('the reopened page does not show the landing view');
    } catch (error) { failed('restore', error); }
  }
  return false;
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
  // GY-1459: the local App page finished the step itself (the operator registered, reused or installed
  // the App in their own browser); a flow waiting since before AT ends its wait.
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
 * browser, where their live session holds sudo mode, so the drive's Confirm-access wait ends. It
 * replaces a code handed the same instant: the step that code was for is done.
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
/** What passSudo returns: SETTLED when the local App page finished the step in the operator's own browser (GY-1459). */
export interface SudoPass { passed: boolean; attempts: number; code: string | null; settled?: true }

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
  /** GY-1461: called once, when the page first asks to confirm access and before any wait, to keep its forms' markup. */
  capture?: (page: BrowserPage) => Promise<void> | void;
  /**
   * GY-1482: called each time the flow itself selects a method — a GitHub Mobile prompt issued (with
   * its pairing code, to redact), an email code sent, the authenticator view opened, the passkey or a
   * code handed to the operator — to keep that view's forms. A failure is recorded, never thrown.
   */
  keep?: (page: BrowserPage, view: Exclude<ConfirmAccessView, 'landing'>, codes: string[]) => Promise<unknown> | unknown;
}
/**
 * Pass a Confirm-access prompt without a keyboard: hand the operator the page's confirmation and
 * re-check every 10 s whether the shared session already holds sudo mode, typing in any
 * authenticator or email code they hand over, or trigger GitHub Mobile and surface the pairing
 * code, and wait for the approval with a bounded, retrying poll. Every re-issued code counts as an
 * attempt; the deadline bounds the whole wait. The method used is written to the flow's recorded
 * steps (`sudo-method`); a typed code is recorded as entered (`sudo-code`), never its digits.
 */
export async function passSudo(page: BrowserPage, options: SudoOptions): Promise<SudoPass> {
  const now = options.now ?? (() => new Date()), sleep = options.sleep ?? (ms => new Promise<void>(accept => setTimeout(accept, ms)));
  // GY-1461: a Confirm-access page keeps its forms' markup before any wait starts, so the capture
  // never eats into the deadline; a failed capture is recorded and the pass proceeds unchanged.
  const landing = options.capture ? page.url() : '', landingText = options.capture ? page.text() : '';
  if (options.capture && detectSudo(landing, landingText).sudo) {
    const failed = (view: string, error: unknown) => page.note?.('sudo-form-capture', [view, `failed: ${error instanceof Error ? error.message : String(error)}`]);
    try { await options.capture(page); } catch (error) { failed('all', error); }
    // Whatever the capture left open, the pass starts from the view the page landed on, with the
    // methods it offered there: one more reopen when the capture could not restore it.
    let current: string, shown: string;
    try { current = page.url(); shown = page.text(); } catch { current = ''; shown = ''; }
    if (current !== landing || JSON.stringify(offeredSudoMethods(shown)) !== JSON.stringify(offeredSudoMethods(landingText))) restoreSudoLanding(page, landing, landingText, failed, 1);
  }
  const timeoutMs = options.timeoutMs ?? 180_000, pollMs = options.pollMs ?? 3_000, maxAttempts = options.maxAttempts ?? 3;
  const started = now().getTime(), deadline = new Date(started + timeoutMs).toISOString();
  const prefer = options.prefer ?? 'mobile', mobileFallbackMs = options.mobileFallbackMs ?? 60_000, reloadMs = options.reloadMs ?? 10_000;
  let attempt = 0; let state = null as SudoState | null;
  // GY-1459: a handed code that found no code field, kept for another try while it may still be valid.
  let held = null as Extract<SudoCodeSubmission, { kind: 'code' }> | null, heldTried = 0;
  // The methods the page offered, kept from its first render: the code view hides them.
  const offered = new Set<SudoMethod>();
  if (landingText) { const methods = offeredSudoMethods(landingText); for (const method of sudoMethods) if (methods[method]) offered.add(method); }
  const listed = () => sudoMethods.filter(method => offered.has(method));
  let lastReload = started;
  const keep = async (view: Exclude<ConfirmAccessView, 'landing'>, codes: string[] = []) => {
    if (!options.keep) return;
    try { await options.keep(page, view, codes); } catch (error) { page.note?.('confirm-access-capture', [view, `failed: ${error instanceof Error ? error.message : String(error)}`]); }
  };
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
    // A page that lists its inputs is read by their attributes alone (GY-1459); the named locators are for one that cannot.
    if (page.inputs) return confirmCodeField(page.inputs(), method);
    const usable = (field: Located | null) => !!field && field.visible !== false;
    for (const name of codeFieldNames) {
      if (method === 'authenticator' ? name.includes('email') : name.includes('app_otp')) continue;
      const field = page.locate('field', name); if (usable(field)) return field;
    }
    for (const label of codeFieldLabels) { const field = page.locate('label', label); if (usable(field)) return field; }
    return null;
  };
  // The chosen view renders its field asynchronously (GY-1459): wait up to 10 s for it.
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
      await keep('email');
      state = { ...state!, method: 'email', emailed: true };
      await options.onCode(state);
      return 'done';
    }
    const method = state!.emailed ? 'email' : offered.has('authenticator') ? 'authenticator' : 'email';
    let field = codeField(method);
    if (!field) {
      const view = method === 'authenticator' ? control(authenticatorLabels) : null;
      if (view) { activate(view); await keep('authenticator'); }
      field = renderedField(method);
    }
    if (!field || !page.fill) {
      page.note?.('sudo-code', [method, field ? 'page cannot type' : 'no code field']);
      if (field) return 'done';
      if (state!.field !== 'missing') {
        if (state!.method === 'mobile') page.note?.('sudo-method', [method]);
        state = { ...state!, field: 'missing', ...(state!.method === 'mobile' ? { method } : {}) }; await options.onCode(state);
      }
      return 'missing';
    }
    try { page.fill(field.selector, submission.code); } catch (error) { throw new Error(withheld(error, submission.code)); }
    // GitHub's recorded field submits itself once its 6 digits are typed (js-verification-code-input-auto-submit),
    // so a Verify button the page has already left is no failure: the next read of the page shows the outcome.
    try { const verify = control(verifyLabels, ['button']); if (verify) page.click(verify.selector); }
    catch (error) { page.note?.('sudo-code', [method, `verify control: ${withheld(error, submission.code)}`]); }
    page.wait(Math.min(pollMs, 1_000));
    // A refused code stays in the field: clear it before any later step screenshots the page.
    let left: { selector: string } | null = null;
    try { left = codeField(method); } catch { /* the page has moved on */ }
    if (left) { try { page.fill(left.selector, ''); } catch { page.note?.('sudo-code', [method, 'field not cleared']); } }
    page.note?.('sudo-code', [method, 'entered']);
    if (state!.field) { const { field: _missing, ...rest } = state!; state = rest; }
    if (state!.method !== method) { page.note?.('sudo-method', [method]); state = { ...state!, method }; }
    return 'done';
  };
  // GY-1459: the code view is opened and its field rendered before the operator is invited to enter a code, so a code
  // entered at any moment is typed at once; a code that arrives while the field renders is kept in `early` and typed first.
  let early = null as SudoCodeSubmission | null, prepared = false;
  const prepare = async () => {
    if (!options.readCode || !offered.has('authenticator') || state?.emailed || codeField('authenticator')) return;
    const view = control(authenticatorLabels);
    if (!view) return;
    activate(view);
    if (!prepared) { prepared = true; await keep('authenticator'); }
    for (let check = 1; check < codeFieldChecks && !codeField('authenticator'); check += 1) {
      early ??= await options.readCode() ?? null;
      if (early) return;
      page.wait(codeFieldCheckMs);
    }
  };
  // The code handed to the waiting run (GY-1459), whichever method the page is showing: a finished step settles the pass,
  // a typed code is 'entered', and a kept code that found no field is tried again on a freshly loaded page.
  const takeHanded = async (current: string): Promise<SudoPass | 'entered' | null> => {
    // A TOTP window is 30 s and GitHub accepts its neighbours: a kept code is dropped once it may be stale.
    if (held && now().getTime() - Date.parse(held.at) > heldCodeMs) { page.note?.('sudo-code', ['authenticator', 'kept code expired']); held = null; }
    let submission = early ?? await options.readCode?.() ?? null; early = null;
    // A kept code is tried on a freshly loaded page: the view that failed to render its field is reloaded first.
    if (!submission && held && now().getTime() - heldTried >= reloadMs) { page.open(current); submission = held; }
    if (submission?.kind === 'settled') {
      // The step was finished on the local App page in the operator's own browser, after this wait began.
      if (Date.parse(submission.at) < started) return null;
      page.note?.('sudo-settled', ['local App page']);
      state = { ...state!, state: 'approved' }; await options.onSettled?.(state);
      return { passed: true, attempts: attempt, code: state.code, settled: true };
    }
    if (!submission) return null;
    const outcome = await enter(submission);
    held = outcome === 'missing' && submission.kind === 'code' ? submission : null; heldTried = now().getTime();
    lastReload = now().getTime();
    return 'entered';
  };
  // The older page offers GitHub Mobile as a button; the passkey-first page keeps that button
  // hidden and offers a "Use GitHub Mobile" control under "Having problems?": activateSudoControl
  // tries a rendered button first, then the link, and the capture opens code views the same way.
  const issue = (label: string) => {
    if (attempt >= maxAttempts) throw new Error(`GitHub Mobile confirmation was re-issued ${attempt} times without approval; approve the prompt on your device and rerun master browser ${options.flow}`);
    const result = activateSudoControl(page, label, Math.min(pollMs, 1_000));
    if (result.outcome === 'absent') throw new Error(`Confirm-access page offers no "${label}" control; only GitHub Mobile confirmation is automated, so confirm access in your own browser and rerun master browser ${options.flow}`);
    attempt += 1;
    if (result.outcome === 'failed') throw new Error(`Confirm-access "${label}" could not be activated (${result.failures.join('; ')}); confirm access in your own browser and rerun master browser ${options.flow}`);
  };
  for (;;) {
    const current = page.url(), text = page.text();
    const detected = detectSudo(current, text);
    if (!detected.sudo) {
      if (state) { state = { ...state, state: 'approved' }; await options.onSettled?.(state); }
      return { passed: !!state, attempts: attempt, code: state?.code ?? null };
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
        if (method !== 'password') await keep(method);
        await prepare();
        state = waiting({ code: null, method, url: current, offered: listed(), ...(page.copy ? { copy: true } : {}) });
        await options.onCode(state);
      } else {
        const taken = await takeHanded(current);
        if (taken === 'entered') continue;
        if (taken) return taken;
        // Re-check whether the shared session holds sudo mode now: the page no longer asks on reload.
        if (now().getTime() - lastReload >= reloadMs) { lastReload = now().getTime(); page.open(current); await prepare(); continue; }
      }
      await sleep(options.readCode ? Math.min(pollMs, codePollMs) : pollMs);
      continue;
    }
    if (!state && !detected.code) { issue('Use GitHub Mobile'); continue; }
    // GY-1459: a code handed to a run waiting on a GitHub Mobile prompt is typed as well; the page offers Mobile beside its code views.
    if (state?.method === 'mobile' && options.readCode) {
      const taken = await takeHanded(current);
      if (taken === 'entered') continue;
      if (taken) return taken;
    }
    if (state && detected.expired && !detected.code) { issue(detected.mobileOffered ? 'Use GitHub Mobile' : 'Try again'); state = null; continue; }
    if (detected.code && detected.code !== state?.code) {
      if (state?.method !== 'mobile') page.note?.('sudo-method', ['mobile']);
      state = waiting({ code: detected.code, method: 'mobile', url: current, offered: listed() });
      await keep('mobile', [detected.code]);
      await options.onCode(state);
    } else if (!state) {
      page.note?.('sudo-method', ['mobile']);
      state = waiting({ code: null, method: 'mobile', url: current, offered: listed() });
      await keep('mobile');
      await options.onCode(state);
    } else if (state.code && !state.fallback && (offered.has('passkey') || offered.has('password')) && now().getTime() - Date.parse(state.issuedAt) >= mobileFallbackMs) {
      // No approval within the minute: the push may never arrive, so the other route is offered beside it.
      const method = offered.has('passkey') ? 'passkey' : 'password';
      state = { ...state, fallback: { method, url: route(method) } };
      page.note?.('sudo-fallback', [method, state.fallback!.url]);
      await options.onCode(state);
    }
    await sleep(state?.method === 'mobile' && options.readCode ? Math.min(pollMs, codePollMs) : pollMs);
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

// ---- Confirm-access fixtures ----------------------------------------------------------------

export interface ConfirmAccessFixture { flow: string; view: ConfirmAccessView; at: string; file: string; record: string }
/**
 * Every Confirm-access capture the flow records hold (GY-1482), newest first: the flow, the view,
 * when it was written, and its path from the checkout root, with the latest capture of each view
 * named, so a worker takes a real page as its fixture instead of asking a person to record one.
 */
export async function listConfirmAccessFixtures(root: string) {
  const base = actionsDirectory(root);
  let entries: string[];
  try { entries = await readdir(base); } catch (error: any) { if (error.code === 'ENOENT') entries = []; else throw error; }
  const fixtures: ConfirmAccessFixture[] = [];
  for (const name of entries) {
    const directory = resolve(base, name);
    let files: string[];
    try { files = await readdir(resolve(directory, confirmAccessDirectory)); } catch { continue; }
    let flow: string | null = null;
    try { const record = JSON.parse(await readFile(resolve(directory, 'record.json'), 'utf8')); if (typeof record?.flow === 'string') flow = record.flow; } catch { /* a run cut short leaves no record */ }
    flow ??= browserFlows.find(candidate => name.includes(`-${candidate}-`)) ?? 'unknown';
    for (const file of files) {
      const view = /^confirm-access-([a-z]+)\.html$/.exec(file)?.[1] as ConfirmAccessView | undefined;
      if (!view || !confirmAccessViews.includes(view)) continue;
      const path = resolve(directory, confirmAccessDirectory, file);
      fixtures.push({ flow, view, at: (await stat(path)).mtime.toISOString(), file: relative(root, path), record: relative(root, directory) });
    }
  }
  fixtures.sort((a, b) => b.at.localeCompare(a.at) || a.file.localeCompare(b.file));
  const latest = Object.fromEntries(confirmAccessViews.flatMap(view => { const found = fixtures.find(fixture => fixture.view === view); return found ? [[view, found.file]] : []; }));
  return { fixtures, latest, total: fixtures.length };
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
  // The first Confirm-access page of the flow keeps its forms' redacted markup (GY-1461) and saves it
  // as the record's Confirm-access captures, which each method the flow selects then saves again, the
  // latest capture of a view winning (GY-1482).
  const sudoForms: CapturedSudoForm[] = [];
  const confirmAccess: ConfirmAccessCapture[] = [];
  const saved = (capture: ConfirmAccessCapture) => { const index = confirmAccess.findIndex(earlier => earlier.view === capture.view); if (index < 0) confirmAccess.push(capture); else confirmAccess[index] = capture; };
  let formsCaptured = false;
  const capture = async (current: BrowserPage) => { if (formsCaptured) return; formsCaptured = true; sudoForms.push(...await captureSudoForms(current, directory, { now, onCapture: saved })); };
  const keep: SudoOptions['keep'] = async (current, view, codes) => saved(await captureConfirmAccess(current, directory, view, { codes, now }));
  const settle = async (state: SudoState) => { if (state.state === 'approved') await rm(sudoFile(root), { force: true }); else await atomicPrivateWrite(sudoFile(root), state); };
  // Every navigation may land on Confirm access; each is followed by the same bounded pass.
  const visit = async (url: string) => {
    page.open(url);
    const passed = await passSudo(page, { flow, record: entry.record, onCode: state => atomicPrivateWrite(sudoFile(root), state), onSettled: settle, capture, keep, sleep: dependencies.sleep, now, ...dependencies.sudo });
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
    } else if (flow === 'capture') {
      // GY-1686: reach a Confirm-access page on purpose and keep its views as fixtures. The pass that
      // confirms access (passSudo) is never entered, so nothing is submitted, typed or sent and no
      // GitHub Mobile prompt is issued: the capture follows each view's own link and stops.
      const installation = await observeInstallation(dependencies.installation, config.githubAppId);
      entry.target = { ...entry.target, slug: installation.slug, installationId: installation.id };
      const url = `https://github.com/settings/apps/${encodeURIComponent(installation.slug)}/permissions`;
      before = { url, views: [] as string[] };
      if (dependencies.dryRun) {
        outcome = 'unchanged'; reason = `Dry run; would open ${url} in browser profile ${config.browser.profile} and keep each Confirm-access view it offers (landing, passkey, authenticator, email) as redacted markup under ${entry.record}/${confirmAccessDirectory}, submitting nothing`;
        page.note?.('capture', ['dry-run', reason]);
      } else {
        page.open(url);
        browserLogin ??= page.meta('user-login');
        if (!browserLogin && /github\.com\/login\b/.test(page.url())) throw new Error(`The browser profile ${config.browser.profile} is not signed in to GitHub; sign in once in that profile, then rerun master browser capture`);
        const current = page.url(), text = page.text();
        if (!detectSudo(current, text).sudo) {
          // No Confirm access proves sudo is held only when the page asked for actually loaded: a
          // profile that cannot administer the App lands on a not-found or access-denied page instead.
          if (current.split(/[?#]/)[0] !== url || !/\bpermissions\b/i.test(text)) throw new Error(`GitHub showed neither Confirm access nor the App permissions page at ${current}; the browser profile ${config.browser.profile} may not administer the App ${installation.slug}, and the recorded page shows what it offered instead`);
          outcome = 'unchanged'; verified = true; reason = `GitHub showed no Confirm access at ${current}: the profile's session already holds sudo mode, so there is no view to keep`;
          page.note?.('capture', ['none', reason]);
        } else {
          // The views the page offers are judged exactly as captureSudoForms chooses which to keep:
          // the passkey view falls back to the landing form, so the landing alone keeps it, while
          // the authenticator and email views are kept only through a view link of their own. A
          // method the page advertises by prose alone, as GitHub's landing offers email only through
          // "Send a code via email", is no view the capture can keep without sending a code, so it is
          // never expected; the keep logic records why it was not followed.
          const offered = offeredSudoMethods(text);
          const linked = (view: keyof typeof sudoViewLinks) => sudoViewLinks[view].some(label => text.toLowerCase().includes(label.toLowerCase()));
          const expected = ['landing', ...(['passkey', 'authenticator', 'email'] as const).filter(view => linked(view) || view === 'passkey' && offered.passkey)];
          const sendOnly = offered.email && !linked('email');
          sudoForms.push(...await captureSudoForms(page, directory, { now, onCapture: saved }));
          const kept: string[] = [];
          for (const capture of confirmAccess) { try { await stat(resolve(directory, capture.file)); kept.push(capture.view); } catch { /* its capture step records the failure */ } }
          const missed = expected.filter(view => !kept.includes(view));
          after = { url: current, views: kept, missed };
          // A view the page offered but the capture could not keep is a failed capture, never a
          // success a worker is sent to: the fixture it needs may be the one that is absent.
          verified = !missed.length; outcome = verified ? 'applied' : 'refused';
          reason = verified ? `Kept ${kept.length} Confirm-access view(s) as redacted markup: ${kept.join(', ')}`
            : kept.length ? `Kept ${kept.join(', ')} but not the offered ${missed.join(', ')} view(s); the recorded steps name each failure, so rerun until every offered view is kept`
              : 'The Confirm-access page offered no view the capture could keep; its recorded steps name each failure';
          if (sendOnly) reason += '; the email method is offered only by a control that sends a code, which the capture never follows, so no email view is expected';
          page.note?.('capture', [outcome, reason]);
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
        await passSudo(page, { flow, record: entry.record, onCode: state => atomicPrivateWrite(sudoFile(root), state), onSettled: settle, capture, keep, sleep: dependencies.sleep, now, ...dependencies.sudo });
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
    // A capture that could not reach or read its page records that outcome, with the reason, as a step.
    if (flow === 'capture') page.note?.('capture', ['refused', reason]);
  } finally {
    // The session exists for this flow alone; a page that was never opened has nothing to close.
    if (steps.some(step => step.action === 'open')) try { page.close(); } catch { /* recorded on the step */ }
  }
  const completedAt = now().toISOString();
  const record = { ...entry, actor: { ...entry.actor, browser: browserLogin }, completedAt, before, after, outcome, verified, reason, screenshots: steps.filter(step => step.screenshot).length, sudo, sudoForms, confirmAccess, steps };
  await writeFile(resolve(directory, 'record.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  const { steps: _steps, sudoForms: _sudoForms, confirmAccess: _confirmAccess, ...ledgerEntry } = record;
  await appendAdministrationEntry(root, ledgerEntry);
  const next = outcome === 'refused' ? `Inspect ${entry.record}/record.json and its screenshots, then rerun master browser ${flow}`
    : flow === 'capture' ? dependencies.dryRun ? 'Rerun master browser capture without --dry-run to open the page and keep its Confirm-access views'
      : outcome === 'applied' ? 'Run master browser fixtures; a worker whose criterion needs a live Confirm-access fixture takes the latest file of that view'
      : 'Rerun master browser capture once GitHub asks the profile to confirm access again: sudo mode lapses about two hours after it was granted'
    : flow === 'app-permissions' && outcome === 'applied' ? 'Run master browser installation-accept' : 'Run master status';
  return { ...ledgerEntry, steps: steps.length, next };
}
