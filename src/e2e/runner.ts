import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { servedRevision } from '../release-candidate.js';
import { describeStep, loadCases, registeredRevision, scenarioDefinition, type Api, type CaseFile, type E2eStep } from './case.js';

/**
 * The E2E case runner (GY-1351): runs repository cases (src/e2e/case.ts) against one base URL with
 * one credential, each step under its own timeout and each case retried `retries` times (zero by
 * default, so a flaky case shows as a failure rather than being retried into a pass). Its report
 * names each case's outcome, the step that failed and why, and the commit the target served; each
 * result is then appended to the run history of the scenario revision the case is registered as.
 */
export const defaultStepTimeoutMs = 30_000;

/** The slice of Playwright's chromium the browser steps drive; tests substitute their own. */
export interface E2eLauncher { launch(options: { headless: boolean }): Promise<E2eBrowser> }
export interface E2eBrowser { newPage(): Promise<E2ePage>; close(): Promise<void> }
export interface E2eLocator {
  first(): E2eLocator;
  click(options: { timeout: number }): Promise<void>;
  fill(value: string, options: { timeout: number }): Promise<void>;
  waitFor(options: { state: 'visible'; timeout: number }): Promise<void>;
}
export interface E2ePage {
  on(event: 'pageerror', listener: (error: Error) => void): unknown;
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<unknown>;
  getByLabel(text: string): E2eLocator;
  getByRole(role: string, options: { name: string; exact: boolean }): E2eLocator;
  getByText(text: string, options: { exact: boolean }): E2eLocator;
  close(): Promise<void>;
}

export interface FailingStep { index: number; name: string; reason: string }
export interface CaseOutcome {
  id: string; title: string; file: string; outcome: 'pass' | 'fail'; durationMs: number; attempts: number;
  /** The steps the last attempt ran, the failing one included. */
  executed: number;
  failingStep: FailingStep | null;
  /** The registered revision the run was appended to, or why it was not recorded. */
  recorded?: { revision: number } | { error: string };
}
export interface E2eReport {
  runId: string; url: string; environment: string; sha: string | null; startedAt: string; finishedAt: string;
  passed: number; failed: number; cases: CaseOutcome[];
}
export interface RunOptions {
  url: string; token: string; environment?: string; runId?: string;
  stepTimeoutMs?: number; retries?: number;
  fetcher?: typeof fetch; launcher?: E2eLauncher; now?: () => number;
}

/** The commit the target's /healthz reports serving, or null when it reports none in time. */
async function readServed(url: string, fetcher: typeof fetch, timeoutMs: number) {
  try { const response = await fetcher(new URL('/healthz', url), { signal: AbortSignal.timeout(timeoutMs) }); return response.ok ? servedRevision(await response.json()) : null; } catch { return null; }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 900);

/** The value at a dotted path (`criteria.0.id`); the empty path is the value itself. */
export function valueAt(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split('.').reduce<unknown>((current, key) => current !== null && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, value);
}
const matches = (actual: unknown, expected: unknown): boolean => expected !== null && typeof expected === 'object' && !Array.isArray(expected)
  ? actual !== null && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => matches((actual as Record<string, unknown>)[key], value))
  : JSON.stringify(actual) === JSON.stringify(expected);
const typeOf = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

/** Every `{{name}}` in a value replaced from `vars`; an unknown name fails the step. */
export function substitute<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === 'string') return value.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`{{${name}}} is not set: no earlier step saved it`);
    return vars[name];
  }) as T;
  if (Array.isArray(value)) return value.map(entry => substitute(entry, vars)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry, vars)])) as T;
  return value;
}

/** Why an http step's answer fails its checks, or null when it passes. */
export function checkAnswer(step: Extract<E2eStep, { kind: 'http' }>, status: number, body: unknown, text: string): string | null {
  if (status !== step.status) return `expected status ${step.status}, got ${status}${text ? `: ${text.slice(0, 200)}` : ''}`;
  for (const check of step.expect) {
    const actual = valueAt(body, check.path), at = check.path || '(body)';
    if ('equals' in check && !matches(actual, check.equals) ) return `${at} is ${JSON.stringify(actual)?.slice(0, 200)}, expected ${JSON.stringify(check.equals)}`;
    if (check.exists !== undefined && (actual !== undefined) !== check.exists) return `${at} ${check.exists ? 'is missing' : 'is present'}`;
    if (check.type && typeOf(actual) !== check.type) return `${at} is ${typeOf(actual)}, expected ${check.type}`;
    if ('includes' in check) {
      const found = Array.isArray(actual) ? actual.some(entry => matches(entry, check.includes)) : typeof actual === 'string' && typeof check.includes === 'string' && actual.includes(check.includes);
      if (!found) return `${at} does not include ${JSON.stringify(check.includes)}`;
    }
  }
  return null;
}

const withTimeout = <T>(work: Promise<T>, ms: number, what: string) => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};

interface CaseContext { url: string; vars: Record<string, string>; timeoutMs: number; fetcher: typeof fetch; page: () => Promise<E2ePage>; pageErrors: string[]; idempotency: (index: number) => string }

async function runStep(step: E2eStep, index: number, context: CaseContext) {
  if (step.kind === 'http') {
    const path = substitute(step.path, context.vars);
    const body = step.body === undefined ? undefined : JSON.stringify(substitute(step.body, context.vars));
    const response = await context.fetcher(new URL(path, context.url), { method: step.method, signal: AbortSignal.timeout(context.timeoutMs),
      headers: { Authorization: `Bearer ${context.vars.token}`, 'Content-Type': 'application/json', ...(step.method === 'POST' ? { 'Idempotency-Key': context.idempotency(index) } : {}) }, body });
    const text = await response.text();
    let parsed: unknown = undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { /* a non-JSON answer passes only checks that need no body */ }
    const failure = checkAnswer(substitute(step, context.vars), response.status, parsed, text);
    if (failure) throw new Error(failure);
    for (const [name, at] of Object.entries(step.save ?? {})) {
      const value = valueAt(parsed, at);
      if (value === undefined || value === null || typeof value === 'object') throw new Error(`could not save ${name}: ${at || '(body)'} is ${JSON.stringify(value) ?? 'missing'}`);
      context.vars[name] = String(value);
    }
    return;
  }
  const page = await context.page();
  const before = context.pageErrors.length;
  const timeout = context.timeoutMs;
  const text = step.text === undefined ? '' : substitute(step.text, context.vars);
  const exact = step.exact ?? true;
  const target = () => step.role ? page.getByRole(step.role, { name: text, exact }).first() : page.getByText(text, { exact }).first();
  if (step.action === 'open') await page.goto(new URL(substitute(step.path!, context.vars), context.url).toString(), { waitUntil: 'load', timeout });
  else if (step.action === 'fill') await page.getByLabel(substitute(step.label!, context.vars)).first().fill(substitute(step.value!, context.vars), { timeout });
  else if (step.action === 'click') await target().click({ timeout });
  else await target().waitFor({ state: 'visible', timeout });
  if (context.pageErrors.length > before) throw new Error(`page error: ${context.pageErrors[before]}`);
}

/** Run one case once: its steps in order, stopping at the first that fails. */
async function attemptCase(entry: CaseFile, options: Required<Pick<RunOptions, 'url' | 'token' | 'stepTimeoutMs'>> & { runId: string; attempt: number; fetcher: typeof fetch; launcher: () => Promise<E2eLauncher> }) {
  const { definition } = entry;
  const vars: Record<string, string> = { token: options.token, run: `${options.runId}-${options.attempt}`, case: definition.id };
  const pageErrors: string[] = [];
  let browser: E2eBrowser | null = null, page: E2ePage | null = null;
  const context: CaseContext = { url: options.url, vars, timeoutMs: options.stepTimeoutMs, fetcher: options.fetcher, pageErrors,
    idempotency: index => `e2e:${definition.id}:${options.runId}:${options.attempt}:${index}`,
    page: async () => {
      if (!page) {
        browser = await (await options.launcher()).launch({ headless: true });
        page = await browser.newPage();
        page.on('pageerror', error => pageErrors.push(message(error)));
      }
      return page;
    } };
  let executed = 0, failingStep: FailingStep | null = null;
  try {
    for (const [index, step] of definition.steps.entries()) {
      executed++;
      try { await withTimeout(runStep(step, index, context), options.stepTimeoutMs + 1_000, `step ${index + 1}`); }
      catch (error) { failingStep = { index, name: describeStep(step), reason: message(error) }; break; }
    }
  } finally { if (browser) await (browser as E2eBrowser).close().catch(() => {}); }
  return { executed, failingStep };
}

/**
 * Run the selected cases against `url` and report each one. Cases run one after another so their
 * steps never race each other on the same target; a case's browser steps share one page.
 */
export async function runCases(cases: readonly CaseFile[], options: RunOptions): Promise<E2eReport> {
  const now = options.now ?? Date.now, fetcher = options.fetcher ?? fetch;
  const runId = options.runId ?? randomUUID();
  const retries = options.retries ?? 0, stepTimeoutMs = options.stepTimeoutMs ?? defaultStepTimeoutMs;
  let launcher: E2eLauncher | undefined = options.launcher;
  const launch = async () => launcher ??= (await import('@playwright/test')).chromium as unknown as E2eLauncher;
  const startedAt = new Date(now()).toISOString();
  const sha = await readServed(options.url, fetcher, stepTimeoutMs);
  const outcomes: CaseOutcome[] = [];
  for (const entry of cases) {
    const started = now();
    let attempts = 0, result: { executed: number; failingStep: FailingStep | null };
    do { attempts++; result = await attemptCase(entry, { url: options.url, token: options.token, stepTimeoutMs, runId, attempt: attempts, fetcher, launcher: launch }); }
    while (result.failingStep && attempts <= retries);
    outcomes.push({ id: entry.definition.id, title: entry.definition.title, file: entry.file, outcome: result.failingStep ? 'fail' : 'pass', durationMs: Math.max(0, now() - started), attempts, executed: result.executed, failingStep: result.failingStep });
  }
  const failed = outcomes.filter(outcome => outcome.outcome === 'fail').length;
  return { runId, url: options.url, environment: options.environment ?? new URL(options.url).host, sha, startedAt, finishedAt: new Date(now()).toISOString(), passed: outcomes.length - failed, failed, cases: outcomes };
}

/**
 * Append each case's result as a run of the scenario revision it is registered as. A case whose
 * file no registered revision matches is not recorded — `graphyard e2e sync` registers it — and
 * the report says so; recording never changes a case's outcome.
 */
export async function recordRuns(api: Api, cases: readonly CaseFile[], report: E2eReport) {
  let registry: { id: string; revision: number }[];
  try { registry = await api('scenarios'); }
  catch (error) { for (const outcome of report.cases) outcome.recorded = { error: `could not read the scenario registry: ${message(error)}` }; return report; }
  for (const outcome of report.cases) {
    const entry = cases.find(candidate => candidate.definition.id === outcome.id)!;
    const revision = registeredRevision(registry, scenarioDefinition(entry));
    if (revision === null) { outcome.recorded = { error: `no registered revision matches ${entry.file}; run graphyard e2e sync` }; continue; }
    try {
      await api(`scenarios/${encodeURIComponent(outcome.id)}/runs`, { revision, runId: report.runId, baseUrl: report.url, sha: report.sha, environment: report.environment,
        durationMs: outcome.durationMs, outcome: outcome.outcome, executed: outcome.executed, failingStep: outcome.failingStep }, `e2e-run:${report.runId}:${outcome.id}`);
      outcome.recorded = { revision };
    } catch (error) { outcome.recorded = { error: message(error) }; }
  }
  return report;
}

/** The report in words: one line per case, the failing step and reason under each failure. */
export function summarize(report: E2eReport) {
  const lines = report.cases.map(outcome => `${outcome.outcome === 'pass' ? 'PASS' : 'FAIL'} ${outcome.id} (${outcome.durationMs} ms)`
    + (outcome.failingStep ? `\n     step ${outcome.failingStep.index + 1} ${outcome.failingStep.name}: ${outcome.failingStep.reason}` : '')
    + (outcome.recorded && 'error' in outcome.recorded ? `\n     not recorded: ${outcome.recorded.error}` : ''));
  return [`E2E run ${report.runId} against ${report.url} (${report.environment}, serving ${report.sha ?? 'an unreported commit'})`, ...lines,
    `${report.passed} passed, ${report.failed} failed`].join('\n');
}

/** A failing report in one line, for a release validation suite's detail and its follow-up item. */
export const failureDetail = (report: E2eReport) => report.cases.filter(outcome => outcome.failingStep)
  .map(outcome => `case ${outcome.id} failed at step ${outcome.failingStep!.index + 1} (${outcome.failingStep!.name}): ${outcome.failingStep!.reason}`).join('; ');

/**
 * The `e2e` suite of `release validate` (GY-1351): every case targeted at `uat` against the UAT
 * deployment with the UAT principal's token. A failing case fails the suite, and so the candidate's
 * UAT validation, exactly as the other suites do; the detail names each failing case and step, so
 * the follow-up item a failed candidate files names them too.
 */
export const e2eSuite = (cases: readonly CaseFile[], token: string, options: { fetcher?: typeof fetch; launcher?: E2eLauncher; stepTimeoutMs?: number; report?: (report: E2eReport) => Promise<void> } = {}) => ({
  name: 'e2e',
  run: async (url: string, candidate: { id: string } | null) => {
    const selected = cases.filter(entry => entry.definition.target === 'uat');
    if (!selected.length) return { name: 'e2e', passed: false, detail: 'no E2E case targets uat, so the suite exercised nothing' };
    const report = await runCases(selected, { url, token, environment: 'uat', runId: candidate ? `rc-${candidate.id}` : undefined, fetcher: options.fetcher, launcher: options.launcher, stepTimeoutMs: options.stepTimeoutMs });
    await options.report?.(report);
    return report.failed
      ? { name: 'e2e', passed: false, detail: `${report.failed} of ${report.cases.length} E2E cases failed: ${failureDetail(report)}` }
      : { name: 'e2e', passed: true, detail: `${report.passed} E2E case${report.passed === 1 ? '' : 's'} passed against UAT serving ${report.sha ?? 'an unreported commit'}` };
  },
});

/**
 * Run the e2e suite as a `release validate --suite` command, from the candidate's own checkout:
 * `GRAPHYARD_UAT_URL` is the deployment the validation set and `GRAPHYARD_UAT_TOKEN` the UAT
 * principal the api and browser suites use. Like every suite command it never holds the release
 * credential, so it only writes its report to `GRAPHYARD_E2E_REPORT`; the workflow's next step
 * records that report with `graphyard e2e record`.
 */
export async function runE2eSuite(env: NodeJS.ProcessEnv = process.env, root = process.cwd()) {
  const url = env.GRAPHYARD_UAT_URL, token = env.GRAPHYARD_UAT_TOKEN;
  if (!url || !token) throw new Error('The e2e suite needs GRAPHYARD_UAT_URL and GRAPHYARD_UAT_TOKEN');
  const result = await e2eSuite(await loadCases(root), token, { report: async report => {
    console.log(summarize(report));
    if (env.GRAPHYARD_E2E_REPORT) await writeFile(env.GRAPHYARD_E2E_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  } }).run(url, env.GRAPHYARD_CANDIDATE_ID ? { id: env.GRAPHYARD_CANDIDATE_ID } : null);
  console.log(result.detail);
  if (!result.passed) process.exitCode = 1;
  return result;
}
