import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractFile, describeStep, loadCases, loadContract, registeredRevision, scenarioDefinition, type Api, type CaseFile, type E2eStep, type ReleaseContract } from './case.js';
import { checkoutRepositoryPolicy, repositoryPolicy, type RepositoryPolicy } from '../model/repository-policy.js';
import { installSecretsDirectory, loadSecrets, redact, redactValues, runAgentStep, runCommandStep, runProcess, stepEnvironment, type ProcessRunner, type StepRecord } from './steps.js';
import type { ExternalEvidence, ExternalRunResult, ExternalVerdict } from '../runner-report.js';
import { importedEvidenceArtifacts, type EvidenceArtifact } from '../model/evidence.js';

/**
 * The E2E case runner (GY-1351): runs repository cases (src/e2e/case.ts) against one base URL with
 * one credential, each step under its own timeout and each case retried `retries` times (zero by
 * default). Its report names each case's outcome, the step that failed and why, and the commit the
 * target served; each attempt is then appended to the run history of the scenario revision the
 * case is registered as.
 *
 * Every case in a run ends in one verdict (GY-1378): `passed`; `failed` (every attempt failed);
 * `flaky` (an attempt failed and a later one passed at the same served SHA — both attempts are kept,
 * and it never counts as passed until an evidence decision accepts it); or `unrun` (a required case
 * failed earlier and the run stopped, naming that case in `stoppedBy`). Unrun is neither a failure
 * nor a pass.
 *
 * A case's `command` and `agent` steps (GY-1536, src/e2e/steps.ts) run under their own timeout in
 * the checkout `root` names, with `TARGET_URL` and the case's declared secrets — read from the
 * install's `e2e-secrets.<target>.env` before the case runs — and nothing else Graphyard holds.
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
export type CaseVerdict = 'passed' | 'failed' | 'flaky' | 'unrun';
export interface AttemptResult { attempt: number; outcome: 'pass' | 'fail'; durationMs: number; executed: number; failingStep: FailingStep | null;
  /** Each command and agent step the attempt ran: its outcome, last lines of output (secrets redacted), verdict and screenshots. */
  steps?: StepRecord[] }
export interface CaseOutcome {
  id: string; title: string; file: string;
  /** The last attempt's result; null for a case the run never executed. */
  outcome: 'pass' | 'fail' | null;
  verdict: CaseVerdict; required: boolean;
  /** For an unrun case: the required case whose failure stopped the run. */
  stoppedBy?: string;
  durationMs: number; attempts: number;
  /** Every attempt in order, so a flaky case keeps its failure beside its pass. */
  attemptResults: AttemptResult[];
  /** The steps the last attempt ran, the failing one included. */
  executed: number;
  /** The last attempt's failing step, or for a flaky case the step its failed attempt stopped at. */
  failingStep: FailingStep | null;
  /** GY-1802: the case failed or flaked while its outcome was still pending on the candidate, so it ran and is recorded here, but did not block. */
  pending?: true;
  /** The registered revision the run was appended to, or why it was not recorded. */
  recorded?: { revision: number } | { error: string };
}
export interface E2eReport {
  runId: string; url: string; environment: string; sha: string | null; startedAt: string; finishedAt: string;
  passed: number; failed: number; flaky?: number; unrun?: number; cases: CaseOutcome[];
  /** GY-1843: the `e2e.pendingOutcomes` rule the run was judged under, when its caller named the repository's policy: the release holds judge its pending cases by the same rule. */
  pendingOutcomes?: RepositoryPolicy['e2e']['pendingOutcomes'];
  /** GY-1938: the required cases this run pended because the install it ran against cannot serve deliveries, with the install's own answer the probe read. A release run pends a case only on this ground, and the hold layer counts it only when its own probe agrees. */
  suspendedDeliveries?: { cases: string[]; merger: string; repositoryWired: boolean };
  /** GY-1938: set when the delivery probe could not read the install's merger, so every case ran as blocking. */
  deliveryProbe?: 'unreadable';
}
export interface RunOptions {
  url: string; token: string; environment?: string; runId?: string;
  stepTimeoutMs?: number; retries?: number;
  /** How often a step with `waitSeconds` asks again (`httpWaitPollMs` by default), and the longest any step waits (its own `waitSeconds` by default); tests shorten both. */
  waitPollMs?: number; maxWaitSeconds?: number;
  /** GY-1938: the one instant, on `now`'s clock, at which every waiting step of the run stops asking again, whatever its own `waitSeconds`: all cases, steps and attempts share it, so their waits together never pass it. None by default. */
  waitUntil?: number;
  /** How a waiting step pauses between asks (a real timer by default); tests pair it with `now` as a fake clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Stop at the first required case that fails: every case after it is unrun, naming it. A case bound to an outcome still pending on the candidate (GY-1802) never stops the run. */
  stopOnRequiredFailure?: boolean;
  /** GY-1802: the required case ids bound to an outcome still pending on the candidate (`contractPendingCases`): their failure records as pending, never blocking. */
  pendingCases?: readonly string[];
  /** GY-1843: the repository's policy; under `e2e.pendingOutcomes: blocking` no case is pending. The one in force by default. */
  policy?: RepositoryPolicy;
  fetcher?: typeof fetch; launcher?: E2eLauncher; now?: () => number;
  /** The candidate checkout command steps run in (the working directory by default). */
  root?: string;
  /** Where `e2e-secrets.<target>.env` is read from: the checkout's install directory by default. */
  secretsDirectory?: string;
  /**
   * Never read the install's secrets (GY-1718: a merge preview runs cases the candidate wrote): a
   * case declaring any fails at its declared secrets, and no secrets file is opened.
   */
  withholdSecrets?: boolean;
  /** Where agent steps' screenshots go: a run-named directory under the temp directory by default. */
  artifactsDirectory?: string;
  /** The host environment a step's process draws its basics from, and how it is spawned; tests substitute both. */
  hostEnvironment?: NodeJS.ProcessEnv; processRunner?: ProcessRunner;
  /**
   * Cancels the run (GY-1718: a merge preview past its budget): no further case, attempt or step
   * starts, in-flight requests are aborted and an open browser closed, so the run settles within
   * the step it is in; a case not yet started is unrun, `stoppedBy` naming `cancelledRun`.
   */
  signal?: AbortSignal;
}
/** What a case a cancelled run never started names in `stoppedBy`. */
export const cancelledRun = 'cancelled';
/** `fetcher` with `signal` added to every request, beside the request's own. */
const cancellable = (fetcher: typeof fetch, signal: AbortSignal): typeof fetch =>
  (input, init) => fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });

/** The commit a deployment's /healthz body reports serving: `commit`, else `revision` when it is a full SHA. */
const servedRevision = (health: any): string | null => {
  for (const value of [health?.commit, health?.revision]) {
    const sha = typeof value === 'string' ? value.toLowerCase() : '';
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return null;
};

/** The commit the target's /healthz reports serving, or null when it reports none in time. */
async function readServed(url: string, fetcher: typeof fetch, timeoutMs: number) {
  try { const response = await fetcher(new URL('/healthz', url), { signal: AbortSignal.timeout(timeoutMs) }); return response.ok ? servedRevision(await response.json()) : null; } catch { return null; }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 900);
/** A failure's text with every secret redacted before it is cut to one line, so no cut leaves a value's prefix. */
const redactedMessage = (error: unknown, secrets: Record<string, string>) => message(redact(error instanceof Error ? error.message : String(error), secrets));

/** The value at a dotted path (`criteria.0.id`); the empty path is the value itself. */
export function valueAt(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split('.').reduce<unknown>((current, key) => current !== null && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, value);
}
const matches = (actual: unknown, expected: unknown): boolean => expected !== null && typeof expected === 'object' && !Array.isArray(expected)
  ? actual !== null && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => matches((actual as Record<string, unknown>)[key], value))
  : JSON.stringify(actual) === JSON.stringify(expected);
const typeOf = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

/** Every `{{name}}` or `{{secret:NAME}}` in a value replaced from `vars`; an unknown name fails the step. */
export function substitute<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === 'string') return value.replace(/\{\{\s*((?:secret:)?[a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(name.startsWith('secret:') ? `{{${name}}} is not declared: add ${name.slice('secret:'.length)} to the case's secrets` : `{{${name}}} is not set: no earlier step saved it`);
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

/** `path` resolved on the target, refused when it leaves the target's origin (a `//host/…` path would carry the case's token elsewhere, GY-1718). */
const onTarget = (path: string, url: string) => {
  const resolved = new URL(path, url);
  if (resolved.origin !== new URL(url).origin) throw new Error(`the path ${path} leaves the target ${new URL(url).origin}`);
  return resolved;
};

const withTimeout = <T>(work: Promise<T>, ms: number, what: string) => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};

interface CaseContext { url: string; vars: Record<string, string>; timeoutMs: number; pollMs: number; maxWaitSeconds: number; waitUntil: number; now: () => number; sleep: (ms: number) => Promise<void>; fetcher: typeof fetch; page: () => Promise<E2ePage>; pageErrors: string[]; idempotency: (index: number) => string;
  secrets: Record<string, string>; general: { root: string; env: Record<string, string>; run: ProcessRunner; artifacts: string; session: (index: number) => string; signal?: AbortSignal } }

/** A step's own timeout: a command or agent step declares one; the request and browser steps share the run's, a waiting GET's widened by the wait it may still take. */
const timeoutOf = (step: E2eStep, context: Pick<CaseContext, 'timeoutMs' | 'maxWaitSeconds' | 'waitUntil' | 'now'>) => step.kind === 'command' || step.kind === 'agent' ? step.timeoutSeconds * 1000
  : step.kind === 'http' && step.waitSeconds ? waitMs(step.waitSeconds, context) + context.timeoutMs : context.timeoutMs;
/** How long a waiting GET may still wait: its own `waitSeconds`, capped by the run's per-step cap and by what is left before the run's shared deadline (GY-1938). */
const waitMs = (waitSeconds: number, context: Pick<CaseContext, 'maxWaitSeconds' | 'waitUntil' | 'now'>) =>
  Math.max(0, Math.min(Math.min(waitSeconds, context.maxWaitSeconds) * 1000, context.waitUntil - context.now()));
/** How often a waiting GET step asks again. */
export const httpWaitPollMs = 5_000;

async function runStep(step: E2eStep, index: number, context: CaseContext): Promise<Omit<StepRecord, 'index' | 'name'> | void> {
  if (step.kind === 'command' || step.kind === 'agent') {
    const general = { url: context.url, secrets: context.secrets, ...context.general, session: context.general.session(index) };
    const { record, reason } = step.kind === 'command' ? await runCommandStep(substitute(step, context.vars), general) : await runAgentStep(substitute(step, context.vars), general);
    if (reason) throw Object.assign(new Error(reason), { record });
    return record;
  }
  if (step.kind === 'http') {
    const path = substitute(step.path, context.vars);
    const body = step.body === undefined ? undefined : JSON.stringify(substitute(step.body, context.vars));
    // A waiting GET asks again until its answer holds, `waitSeconds` pass or the run's shared deadline comes; the last answer's failure is the step's.
    const waitSeconds = Math.min(step.waitSeconds ?? 0, context.maxWaitSeconds), allowed = waitMs(step.waitSeconds ?? 0, context), deadline = context.now() + allowed;
    const waited = !waitSeconds ? '' : allowed < waitSeconds * 1000 ? ` (still, at the run's shared wait deadline after ${Math.round(allowed / 1000)} s)` : ` (still, after waiting ${waitSeconds} s)`;
    let parsed: unknown = undefined;
    for (;;) {
      const response = await context.fetcher(onTarget(path, context.url), { method: step.method, signal: AbortSignal.timeout(context.timeoutMs),
        headers: { Authorization: `Bearer ${context.vars.token}`, 'Content-Type': 'application/json', ...(step.method === 'POST' ? { 'Idempotency-Key': context.idempotency(index) } : {}) }, body });
      const text = await response.text();
      parsed = undefined;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { /* a non-JSON answer passes only checks that need no body */ }
      const failure = checkAnswer(substitute(step, context.vars), response.status, parsed, text);
      if (!failure) break;
      if (context.now() + context.pollMs > deadline) throw new Error(`${failure}${waited}`);
      await context.sleep(context.pollMs);
    }
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
  if (step.action === 'open') await page.goto(onTarget(substitute(step.path!, context.vars), context.url).toString(), { waitUntil: 'load', timeout });
  else if (step.action === 'fill') await page.getByLabel(substitute(step.label!, context.vars)).first().fill(substitute(step.value!, context.vars), { timeout });
  else if (step.action === 'click') await target().click({ timeout });
  else await target().waitFor({ state: 'visible', timeout });
  if (context.pageErrors.length > before) throw new Error(`page error: ${context.pageErrors[before]}`);
}

/** Run one case once: its declared secrets resolved first, then its steps in order, stopping at the first that fails. */
async function attemptCase(entry: CaseFile, options: Required<Pick<RunOptions, 'url' | 'token' | 'stepTimeoutMs' | 'root' | 'artifactsDirectory' | 'hostEnvironment' | 'processRunner'>> & { runId: string; attempt: number; fetcher: typeof fetch; launcher: () => Promise<E2eLauncher>; secretsDirectory: () => string; signal?: AbortSignal; withholdSecrets?: boolean; waitPollMs?: number; maxWaitSeconds?: number; waitUntil?: number; now: () => number; sleep: (ms: number) => Promise<void> }) {
  const { definition } = entry;
  const steps: StepRecord[] = [];
  let secrets: Record<string, string>;
  try {
    if (options.withholdSecrets && definition.secrets.length) throw new Error(`declared secret ${definition.secrets[0]} is withheld: this run never reads the install's secrets`);
    secrets = await loadSecrets(definition.secrets, definition.target, options.secretsDirectory);
  }
  catch (error) { return { executed: 0, failingStep: { index: 0, name: 'declared secrets', reason: message(error) }, steps }; }
  const vars: Record<string, string> = { token: options.token, run: `${options.runId}-${options.attempt}`, case: definition.id, ...Object.fromEntries(Object.entries(secrets).map(([name, value]) => [`secret:${name}`, value])) };
  const pageErrors: string[] = [];
  let browser: E2eBrowser | null = null, page: E2ePage | null = null;
  const session = (index: number) => `graphyard-e2e-${options.runId}-${definition.id}-${options.attempt}-${index + 1}`.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120);
  const context: CaseContext = { url: options.url, vars, timeoutMs: options.stepTimeoutMs, pollMs: options.waitPollMs ?? httpWaitPollMs, maxWaitSeconds: options.maxWaitSeconds ?? Infinity, waitUntil: options.waitUntil ?? Infinity, now: options.now, sleep: options.sleep, fetcher: options.fetcher, pageErrors, secrets,
    general: { root: options.root, env: stepEnvironment(options.url, secrets, options.hostEnvironment), run: options.processRunner, artifacts: options.artifactsDirectory, session, signal: options.signal },
    idempotency: index => `e2e:${definition.id}:${options.runId}:${options.attempt}:${index}`,
    page: async () => {
      if (!page) {
        if (options.signal?.aborted) throw new Error('the run was cancelled');
        browser = await (await options.launcher()).launch({ headless: true });
        page = await browser.newPage();
        page.on('pageerror', error => pageErrors.push(message(error)));
      }
      return page;
    } };
  let executed = 0, failingStep: FailingStep | null = null;
  // The step as it ran, values substituted then redacted, and only then shortened; a step whose value names nothing substitutable is described as written.
  const name = (step: E2eStep) => { let ran = step; try { ran = substitute(step, vars); } catch { /* the failure names the missing value */ } return describeStep(redactValues(ran, secrets)); };
  // A cancelled run closes the case's browser at once, so a step waiting on its page settles.
  const closeOnCancel = () => { if (browser) (browser as E2eBrowser).close().catch(() => {}); };
  options.signal?.addEventListener('abort', closeOnCancel, { once: true });
  try {
    for (const [index, step] of definition.steps.entries()) {
      if (options.signal?.aborted) { failingStep = { index, name: name(step), reason: 'the run was cancelled' }; break; }
      executed++;
      try {
        const record = await withTimeout(runStep(step, index, context), timeoutOf(step, context) + 1_000, `step ${index + 1}`);
        if (record) steps.push({ index, name: name(step), ...record });
      } catch (error) {
        const record = (error as { record?: Omit<StepRecord, 'index' | 'name'> }).record;
        if (record) steps.push({ index, name: name(step), ...record });
        failingStep = { index, name: name(step), reason: redactedMessage(error, secrets) }; break;
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', closeOnCancel);
    if (browser) await (browser as E2eBrowser).close().catch(() => {});
  }
  return { executed, failingStep, steps };
}

/**
 * Run the selected cases against `url` and report each one. Cases run one after another so their
 * steps never race each other on the same target; a case's browser steps share one page.
 */
export async function runCases(cases: readonly CaseFile[], options: RunOptions): Promise<E2eReport> {
  const now = options.now ?? Date.now, sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))), signal = options.signal, fetcher = signal ? cancellable(options.fetcher ?? fetch, signal) : options.fetcher ?? fetch;
  const runId = options.runId ?? randomUUID();
  const retries = options.retries ?? 0, stepTimeoutMs = options.stepTimeoutMs ?? defaultStepTimeoutMs;
  const pendingCases = pendingUnder(options.pendingCases ?? [], options.policy);
  const root = options.root ?? process.cwd();
  let secretsDirectory = options.secretsDirectory;
  const general = { root, artifactsDirectory: options.artifactsDirectory ?? join(tmpdir(), `graphyard-e2e-${runId}`), hostEnvironment: options.hostEnvironment ?? process.env, processRunner: options.processRunner ?? runProcess,
    secretsDirectory: () => secretsDirectory ??= installSecretsDirectory(root) };
  let launcher: E2eLauncher | undefined = options.launcher;
  const launch = async () => launcher ??= (await import('@playwright/test')).chromium as unknown as E2eLauncher;
  const startedAt = new Date(now()).toISOString();
  const sha = await readServed(options.url, fetcher, stepTimeoutMs);
  const outcomes: CaseOutcome[] = [];
  let stoppedBy: string | null = null;
  for (const entry of cases) {
    const { id, title, required } = entry.definition;
    if (!stoppedBy && signal?.aborted) stoppedBy = cancelledRun;
    if (stoppedBy) { outcomes.push({ id, title, file: entry.file, outcome: null, verdict: 'unrun', required, stoppedBy, durationMs: 0, attempts: 0, attemptResults: [], executed: 0, failingStep: null }); continue; }
    const started = now();
    const attemptResults: AttemptResult[] = [];
    do {
      const began = now();
      const result = await attemptCase(entry, { url: options.url, token: options.token, stepTimeoutMs, runId, attempt: attemptResults.length + 1, fetcher, launcher: launch, signal, withholdSecrets: options.withholdSecrets, waitPollMs: options.waitPollMs,
        // A case pending on the candidate cannot block it, so it asks once and never holds the run on a wait (GY-1938).
        maxWaitSeconds: required && pendingCases.includes(id) ? 0 : options.maxWaitSeconds, waitUntil: options.waitUntil, now, sleep, ...general });
      attemptResults.push({ attempt: attemptResults.length + 1, outcome: result.failingStep ? 'fail' : 'pass', durationMs: Math.max(0, now() - began), ...result });
    } while (attemptResults.at(-1)!.outcome === 'fail' && attemptResults.length <= retries && !signal?.aborted);
    const last = attemptResults.at(-1)!;
    // A pass after a failure is flaky only when both attempts are bound to one served commit; at an unreported commit it is a failure.
    const verdict: CaseVerdict = last.outcome === 'fail' || (attemptResults.length > 1 && !sha) ? 'failed' : attemptResults.length > 1 ? 'flaky' : 'passed';
    const pending = required && pendingCases.includes(id) && (verdict === 'failed' || verdict === 'flaky');
    outcomes.push({ id, title, file: entry.file, outcome: last.outcome, verdict, required, durationMs: Math.max(0, now() - started), attempts: attemptResults.length, attemptResults,
      executed: last.executed, failingStep: last.failingStep ?? attemptResults.find(attempt => attempt.failingStep)?.failingStep ?? null, ...(pending ? { pending: true } : {}) });
    if (verdict === 'failed' && required && options.stopOnRequiredFailure && !pendingCases.includes(id)) stoppedBy = id;
  }
  const tally = (verdict: CaseVerdict) => outcomes.filter(outcome => outcome.verdict === verdict).length;
  return { runId, url: options.url, environment: options.environment ?? new URL(options.url).host, sha, startedAt, finishedAt: new Date(now()).toISOString(),
    passed: tally('passed'), failed: tally('failed'), flaky: tally('flaky'), unrun: tally('unrun'), cases: outcomes, ...(options.policy ? { pendingOutcomes: options.policy.e2e.pendingOutcomes } : {}) };
}

/** The cases a run treats as pending under the repository's `e2e.pendingOutcomes` (GY-1843): all of them when non-blocking (GY-1802), none when blocking. */
export const pendingUnder = (pendingCases: readonly string[], policy: RepositoryPolicy = repositoryPolicy()) =>
  policy.e2e.pendingOutcomes === 'blocking' ? [] : pendingCases;

/** An accepted flaky result (GY-1378): the evidence decision that accepted one case of one run at one exact SHA. */
export interface FlakyAcceptance { case: string; runId: string; sha: string; decision: string }

/**
 * Pure: the release verdict of a run (GY-1378). Blocking are the required cases that failed and the
 * required cases that were flaky with no evidence decision accepting that case, run and exact SHA.
 * Unrun cases are reported apart, never as failures and never as passes, and optional cases never
 * block. A report naming no served SHA can bind no acceptance. `pendingCases` (GY-1802) names the
 * required cases bound to an outcome still pending on the candidate: such a case keeps its verdict
 * in the report, but is listed as pending instead of blocking — it ran, and its failure counts
 * against nothing until a candidate cut after its outcome is delivered — unless the repository
 * declares `e2e.pendingOutcomes: blocking` (GY-1843), when no case is pending and each blocks like
 * any required case.
 */
export function releaseVerdict(report: Pick<E2eReport, 'runId' | 'sha' | 'cases'>, acceptances: readonly FlakyAcceptance[] = [], pending: readonly string[] = [], policy?: RepositoryPolicy) {
  const pendingCases = pendingUnder(pending, policy);
  const accepted = (id: string) => !!report.sha && acceptances.some(entry => entry.case === id && entry.runId === report.runId && entry.sha === report.sha);
  const of = (verdict: CaseVerdict) => report.cases.filter(outcome => outcome.verdict === verdict);
  const wouldBlock = (outcome: CaseOutcome) => outcome.required && (outcome.verdict === 'failed' || (outcome.verdict === 'flaky' && !accepted(outcome.id)));
  const blocking = report.cases.filter(outcome => wouldBlock(outcome) && !pendingCases.includes(outcome.id));
  return {
    passed: blocking.length === 0, blocking, pending: report.cases.filter(outcome => wouldBlock(outcome) && pendingCases.includes(outcome.id)),
    flaky: of('flaky'), unrun: of('unrun'),
    acceptedFlaky: of('flaky').filter(outcome => outcome.required && accepted(outcome.id)),
    optionalFailures: report.cases.filter(outcome => !outcome.required && (outcome.verdict === 'failed' || outcome.verdict === 'flaky')),
  };
}

/**
 * One blocking case of an imported run: its verdict as given, why a blocked one could not run, and
 * where its own record lives — its links as external artifacts, its opaque pointers (GY-1860) as given.
 */
export interface ImportedBlockingCase { id: string; verdict: ExternalVerdict; reason?: string; evidence: EvidenceArtifact[]; evidencePointers?: Exclude<ExternalEvidence, string>[] }

/**
 * The release verdict of an imported run (GY-1842, `graphyard-external-run-v1`). The import keeps
 * every verdict as the producer gave it — nothing is dropped or read as failed — and it blocks
 * exactly as the runner's own result would: a required case that failed blocks, a flaky one blocks
 * unless an evidence decision accepts it (bound to the case, the run id and the exact head, never
 * to a digest-only run, the same rule `releaseVerdict` holds), and optional cases never block. A
 * required `blocked` case blocks like a failed one: it did not run to a pass, and its missing
 * precondition is the producer's own record of why. A required `unrun` case blocks on its own
 * too: an import has no `stoppedBy` chain, so the run that stopped before reaching it would have
 * carried the required failure it stopped at, and either way the head is not releasable. A
 * `skipped` case (GY-1860) follows the required-case rule the runner's own inventory holds
 * (`verifyRunnerReport` fails a required inventory that skips): required and skipped blocks,
 * optional and skipped does not, and the verdict stays skipped on the record either way. A case
 * bound to a still-pending outcome (`pendingCases`, GY-1802) is listed apart and never blocks, as in
 * `releaseVerdict`.
 */
export function importedRunVerdict(run: ExternalRunResult, acceptances: readonly FlakyAcceptance[] = [], pendingCases: readonly string[] = []) {
  const accepted = (id: string) => !!run.sha && acceptances.some(entry => entry.case === id && entry.runId === run.runId && entry.sha === run.sha);
  const wouldBlock = (outcome: ExternalRunResult['cases'][number]) => outcome.required && (outcome.verdict === 'failed' || outcome.verdict === 'blocked' || outcome.verdict === 'unrun' || outcome.verdict === 'skipped'
    || (outcome.verdict === 'flaky' && !accepted(outcome.id)));
  const listed = (outcome: ExternalRunResult['cases'][number]): ImportedBlockingCase => ({ id: outcome.id, verdict: outcome.verdict,
    ...(outcome.reason ? { reason: outcome.reason } : {}), evidence: importedEvidenceArtifacts(outcome.evidence.filter(entry => typeof entry === 'string')),
    ...(outcome.evidence.some(entry => typeof entry !== 'string') ? { evidencePointers: outcome.evidence.filter(entry => typeof entry !== 'string') } : {}) });
  const blocking = run.cases.filter(outcome => wouldBlock(outcome) && !pendingCases.includes(outcome.id));
  return { passed: blocking.length === 0, blocking: blocking.map(listed), pending: run.cases.filter(outcome => wouldBlock(outcome) && pendingCases.includes(outcome.id)).map(listed) };
}

/** The run id one attempt is recorded under: the run's own for a single attempt, `RUN:attempt-N` when a case took several. */
export const attemptRunId = (runId: string, outcome: Pick<CaseOutcome, 'attempts'>, attempt: number) => outcome.attempts > 1 ? `${runId}:attempt-${attempt}` : runId;
/** Why a pending case's failure did not count (GY-1802), recorded beside its failing step on the Tests page. */
export const pendingNote = '; recorded pending: its outcome has no delivered item yet, so it does not block the candidate';

/**
 * Append each attempt of each case as a run of the scenario revision it is registered as, so a
 * flaky case's failed attempt stays beside its pass. A case whose file no registered revision
 * matches is not recorded — `graphyard e2e sync` registers it — and the report says so; an unrun
 * case has nothing to record. Recording never changes a case's outcome.
 */
export async function recordRuns(api: Api, cases: readonly CaseFile[], report: E2eReport) {
  let registry: { id: string; revision: number }[];
  try { registry = await api('scenarios'); }
  catch (error) { for (const outcome of report.cases) outcome.recorded = { error: `could not read the scenario registry: ${message(error)}` }; return report; }
  for (const outcome of report.cases) {
    if (outcome.verdict === 'unrun') continue;
    const entry = cases.find(candidate => candidate.definition.id === outcome.id)!;
    const revision = registeredRevision(registry, scenarioDefinition(entry));
    if (revision === null) { outcome.recorded = { error: `no registered revision matches ${entry.file}; run graphyard e2e sync` }; continue; }
    // A report written before attempts were kept carries only the last attempt.
    const attempts = outcome.attemptResults?.length ? outcome.attemptResults : [{ attempt: outcome.attempts, outcome: outcome.outcome ?? 'fail', durationMs: outcome.durationMs, executed: outcome.executed, failingStep: outcome.failingStep }];
    try {
      for (const attempt of attempts) {
        const runId = attemptRunId(report.runId, { attempts: attempts.length }, attempt.attempt);
        // GY-1802: the recorded run of a pending case names why its failure did not count, beside the failing step.
        const failingStep = attempt.failingStep && outcome.pending ? { ...attempt.failingStep, reason: `${attempt.failingStep.reason}${pendingNote}`.slice(0, 1000) } : attempt.failingStep;
        await api(`scenarios/${encodeURIComponent(outcome.id)}/runs`, { revision, runId, baseUrl: report.url, sha: report.sha, environment: report.environment,
          durationMs: attempt.durationMs, outcome: attempt.outcome, executed: attempt.executed, failingStep }, `e2e-run:${runId}:${outcome.id}`);
      }
      // A pending flaky case's last attempt passed, which would read as its latest run with no label: a closing run keeps its first failing step, labelled pending, as the latest.
      const failed = outcome.pending && outcome.verdict === 'flaky' ? attempts.find(attempt => attempt.failingStep) : undefined;
      if (failed?.failingStep) {
        const runId = `${report.runId}:pending`;
        await api(`scenarios/${encodeURIComponent(outcome.id)}/runs`, { revision, runId, baseUrl: report.url, sha: report.sha, environment: report.environment,
          durationMs: failed.durationMs, outcome: 'fail', executed: failed.executed, failingStep: { ...failed.failingStep, reason: `${failed.failingStep.reason}${pendingNote}`.slice(0, 1000) } }, `e2e-run:${runId}:${outcome.id}`);
      }
      outcome.recorded = { revision };
    } catch (error) { outcome.recorded = { error: message(error) }; }
  }
  return report;
}

const verdictWord: Record<CaseVerdict, string> = { passed: 'PASS', failed: 'FAIL', flaky: 'FLAKY', unrun: 'UNRUN' };
const stepLine = (step: FailingStep) => `step ${step.index + 1} ${step.name}: ${step.reason}`;

/** The report in words: one line per case, the failing step and reason under each failure. */
export function summarize(report: E2eReport) {
  const lines = report.cases.map(outcome => {
    const verdict = outcome.verdict ?? (outcome.outcome === 'pass' ? 'passed' : 'failed');
    const head = `${verdictWord[verdict]} ${outcome.id}${outcome.required ? '' : ' (optional)'}`;
    if (verdict === 'unrun') return `${head}: not run, the run stopped at required case ${outcome.stoppedBy}`;
    return `${head} (${outcome.durationMs} ms)`
      + (outcome.pending ? `\n     pending: its outcome has no delivered item yet, so it does not block` : '')
      + (verdict === 'flaky' && outcome.failingStep ? `\n     attempt 1 failed at ${stepLine(outcome.failingStep)}; attempt ${outcome.attempts} passed at ${report.sha}` : '')
      + (verdict === 'failed' && outcome.failingStep ? `\n     ${stepLine(outcome.failingStep)}` : '')
      + (outcome.recorded && 'error' in outcome.recorded ? `\n     not recorded: ${outcome.recorded.error}` : '');
  });
  const pending = report.cases.filter(outcome => outcome.pending).length;
  const extra = [report.flaky ? `${report.flaky} flaky` : '', report.unrun ? `${report.unrun} unrun` : '', pending ? `${pending} pending` : ''].filter(Boolean);
  return [`E2E run ${report.runId} against ${report.url} (${report.environment}, serving ${report.sha ?? 'an unreported commit'})`, ...lines,
    [`${report.passed} passed, ${report.failed} failed`, ...extra].join(', ')].join('\n');
}

const caseFailure = (outcome: CaseOutcome) => outcome.verdict === 'flaky'
  ? `case ${outcome.id} was flaky: it failed at step ${outcome.failingStep!.index + 1} (${outcome.failingStep!.name}) and passed on attempt ${outcome.attempts}; it blocks until an evidence decision accepts it`
  : `case ${outcome.id} failed at step ${outcome.failingStep!.index + 1} (${outcome.failingStep!.name}): ${outcome.failingStep!.reason}`;
/** A failing report in one line, for a release validation suite's detail and its follow-up item: the blocking cases, then the unrun and pending ones apart. */
export const failureDetail = (report: E2eReport, pendingCases: readonly string[] = [], policy?: RepositoryPolicy) => {
  const verdict = releaseVerdict(report, [], pendingCases, policy);
  return [verdict.blocking.filter(outcome => outcome.failingStep).map(caseFailure).join('; '),
    verdict.unrun.length ? `unrun after required case ${verdict.unrun[0].stoppedBy} stopped the run: ${verdict.unrun.map(outcome => outcome.id).join(', ')}` : '',
    verdict.pending.length ? `pending, not blocking: ${verdict.pending.map(caseFailure).join('; ')}` : '',
    verdict.optionalFailures.length ? `optional, not blocking: ${verdict.optionalFailures.map(outcome => `${outcome.id} ${outcome.verdict}`).join(', ')}` : ''].filter(Boolean).join('; ');
};

/**
 * The release `e2e` suite (GY-1351): every case targeted at `uat` against a deployment with its
 * principal's token, in id order. A release run retries a failing case once
 * (a pass on the retry is flaky, never passed) and stops at the first required case that fails, so
 * the cases after it are unrun. Only the release verdict's blocking cases — required cases that
 * failed or were flaky — fail the suite; optional cases run and are recorded but never fail it
 * (GY-1378). The detail names each blocking case and step, then the unrun cases apart. A managed
 * repository's candidate (GY-1535, release-project.ts projectCaseSuite) selects every required
 * case beside the uat ones and runs every one of them (`runAll`): a failing required case still
 * fails the suite, but never leaves a later required case unrun. Before the cases run, one probe
 * asks the install whether it can deliver a change at all (GY-1938): an install whose merger is
 * github and which reports no repository wiring can never satisfy the delivery cases, so the run
 * pends them and names them, instead of failing on waits nothing can answer.
 */
export const releaseRetries = 1;
/** How long after a release run starts its one shared wait deadline falls (GY-1938): every waiting step of every case and attempt stops asking again by then, half the suite's one-hour command timeout, so the suite reports instead of being killed however many steps wait. */
export const releaseWaitBudgetSeconds = 1800;
/** The shared wait deadline of a release run starting at `start` (ms). */
export const releaseWaitUntil = (start: number) => start + releaseWaitBudgetSeconds * 1000;
/** Whether a case's steps exercise the install's delivery surface — the delivery and production routes whose expectations only an install that delivers changes can satisfy (GY-1938). */
export const exercisesDelivery = (definition: Pick<CaseFile['definition'], 'steps'>): boolean =>
  definition.steps.some(step => step.kind === 'http' && (step.path.startsWith('/api/delivery') || step.path.startsWith('/production/')));
/**
 * Whether the install at `url` can deliver a change at all (GY-1938): a control-plane merger acts on
 * the plane itself, and a GitHub merger needs the repository wiring the install reports. An install
 * whose merger is github and which reports no repository, GitHub app or state can never make the
 * delivery a case's steps wait for, however long they wait. A merger the probe cannot read answers
 * `true`, so a run blocks exactly as before rather than pending on a guess.
 */
export const installServesDeliveries = async (url: string, token: string, fetcher: typeof fetch = fetch): Promise<{ servesDeliveries: boolean; merger: string; repositoryWired: boolean }> => {
  const read = async (path: string, authorized: boolean): Promise<any> => {
    try { const response = await fetcher(new URL(path, url), { ...(authorized ? { headers: { Authorization: `Bearer ${token}` } } : {}), signal: AbortSignal.timeout(10_000) }); return response.ok ? await response.json() : null; } catch { return null; }
  };
  const merger = await read('api/merger', true);
  const mode = merger?.mode ?? merger?.merger;
  if (!mode) return { servesDeliveries: true, merger: 'unreadable', repositoryWired: true };
  if (mode !== 'github') return { servesDeliveries: true, merger: mode, repositoryWired: true };
  const status = await read('api/status', true);
  // `repository` is only the configured name, present with no GitHub App; wiring is the App the install reports.
  const repositoryWired = !!status && (status.github === true || status.githubRepository != null);
  return { servesDeliveries: repositoryWired, merger: mode, repositoryWired };
};
/** The required cases a release run pends because the install it runs against cannot serve deliveries (GY-1938): those that exercise the delivery surface. */
export const deliverySuspendedCases = (cases: readonly CaseFile[], servesDeliveries: boolean): string[] =>
  servesDeliveries ? [] : cases.filter(entry => entry.definition.required && exercisesDelivery(entry.definition)).map(entry => entry.definition.id);
/** GY-1802: the required case ids the contract binds only to outcomes in `pendingOutcomes` — the cases whose failure records as pending instead of blocking. */
export const contractPendingCases = (contract: Pick<ReleaseContract, 'outcomes'> | null | undefined, pendingOutcomes: readonly string[] | undefined): string[] =>
  !contract || !pendingOutcomes?.length ? [] : [...new Set(contract.outcomes.filter(outcome => pendingOutcomes.includes(outcome.id)).flatMap(outcome => outcome.cases))]
    .filter(id => !contract.outcomes.some(outcome => !pendingOutcomes.includes(outcome.id) && outcome.cases.includes(id)));
/** The checkout's release contract, or null when it has none or one that does not parse. */
export const checkoutContract = async (root: string): Promise<ReleaseContract | null> => existsSync(join(root, contractFile)) ? await loadContract(root).catch(() => null) : null;
export const e2eSuite = (cases: readonly CaseFile[], token: string, options: { fetcher?: typeof fetch; launcher?: E2eLauncher; stepTimeoutMs?: number; root?: string; report?: (report: E2eReport) => void | Promise<void>;
  /** Which cases run: those targeting uat by default; a managed repository's candidate (GY-1535) runs every required case too. */
  select?: (entry: CaseFile) => boolean;
  /** Run every selected case even after a required one fails, so each records its own result (GY-1535). */
  runAll?: boolean; signal?: AbortSignal; withholdSecrets?: boolean; hostEnvironment?: NodeJS.ProcessEnv;
  /** The checkout's release contract: a candidate outcome still pending on the record it was cut with (GY-1802) runs its failing cases as pending, never blocking. */
  contract?: ReleaseContract | null;
  /** The repository's policy (GY-1843), whose `e2e.pendingOutcomes` decides whether a pending case blocks: by default the graphyard.json of `root`, the candidate's own checkout, never the plane's installed GRAPHYARD_REPOSITORY_POLICY; with no root, the policy in force. */
  policy?: RepositoryPolicy;
  /** The run's clock and pause between asks; tests substitute a fake clock (GY-1938). */
  now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) => ({
  name: 'e2e',
  run: async (url: string, candidate: { id: string; pendingOutcomes?: readonly string[] } | null) => {
    const selected = cases.filter(options.select ?? (entry => entry.definition.target === 'uat'));
    if (!selected.length) return { name: 'e2e', passed: false, detail: options.select ? 'no required or uat E2E case is in the checkout, so the suite exercised nothing' : 'no E2E case targets uat, so the suite exercised nothing' };
    const policy = options.policy ?? (options.root ? checkoutRepositoryPolicy(options.root) : repositoryPolicy());
    // GY-1938: an install that cannot serve deliveries can never satisfy the delivery cases, so the run pends them instead of failing on waits nothing can answer; `pendingUnder` keeps a blocking-mode repository judging every case. A signal marks a budgeted run (a merge preview) against an origin of its own, whose cases are the merger's choice: it probes nothing and runs exactly the cases it named.
    const probed = options.signal ? { servesDeliveries: true, merger: 'unreadable', repositoryWired: true } : await installServesDeliveries(url, token, options.fetcher ?? fetch);
    const suspended = deliverySuspendedCases(selected, probed.servesDeliveries);
    const pendingCases = pendingUnder([...contractPendingCases(options.contract, candidate?.pendingOutcomes), ...suspended], policy);
    const report = await runCases(selected, { url, token, environment: 'uat', runId: candidate ? `rc-${candidate.id}` : undefined, fetcher: options.fetcher, launcher: options.launcher, stepTimeoutMs: options.stepTimeoutMs,
      root: options.root, retries: releaseRetries, waitUntil: releaseWaitUntil((options.now ?? Date.now)()), now: options.now, sleep: options.sleep, stopOnRequiredFailure: !options.runAll, signal: options.signal, withholdSecrets: options.withholdSecrets, hostEnvironment: options.hostEnvironment, pendingCases, policy });
    if (suspended.length) report.suspendedDeliveries = { cases: suspended, merger: probed.merger, repositoryWired: probed.repositoryWired };
    if (!options.signal && probed.merger === 'unreadable') report.deliveryProbe = 'unreadable';
    await options.report?.(report);
    const verdict = releaseVerdict(report, [], pendingCases, policy), detail = failureDetail(report, pendingCases, policy);
    const suspension = suspended.length ? `; the install serves no deliveries (merger ${probed.merger} without a repository wired), so its delivery cases ${suspended.join(', ')} are pending, not blocking` : '';
    const executed = report.cases.length - verdict.unrun.length;
    return !verdict.passed
      ? { name: 'e2e', passed: false, detail: `${verdict.blocking.length} of ${executed} E2E cases ${verdict.blocking.every(outcome => outcome.verdict === 'flaky') ? 'were flaky' : 'failed'}: ${detail}${suspension}` }
      : { name: 'e2e', passed: true, detail: `${report.passed} E2E case${report.passed === 1 ? '' : 's'} passed against UAT serving ${report.sha ?? 'an unreported commit'}${suspension}${detail ? `; ${detail}` : ''}` };
  },
});

/**
 * GY-1982: the loop's end-to-end step after it deploys a commit: every case under e2e/cases/ (the
 * cases release-candidate.yml ran) through the runner against the install's own URL. Every failing
 * case throws, optional and pending ones too, the end-to-end failure that rolls the deploy back.
 */
export async function deployedE2e(root: string, url: string, token: string, suite: typeof e2eSuite = e2eSuite) {
  let report: E2eReport | null = null;
  const result = await suite(await loadCases(root), token, { root, contract: await checkoutContract(root), select: () => true, runAll: true, report: value => { report = value; } }).run(url, null);
  const failed = (report as E2eReport | null)?.cases.filter(outcome => outcome.verdict === 'failed') ?? [];
  if (!result.passed) throw new Error(result.detail);
  if (failed.length) throw new Error(`${failed.length} E2E case${failed.length === 1 ? '' : 's'} failed: ${failed.map(outcome => `${outcome.id}${outcome.failingStep ? ` (${outcome.failingStep.reason})` : ''}`).join('; ')}`.slice(0, 500));
  return result;
}

