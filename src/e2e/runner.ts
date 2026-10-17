import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateTagPrefix, contractPendingCases, gitIn, readRecords, servedRevision, type ReleaseCandidate } from '../release-candidate.js';
import { contractFile, describeStep, loadCases, loadContract, registeredRevision, scenarioDefinition, type Api, type CaseFile, type E2eStep, type ReleaseContract } from './case.js';
import { checkoutRepositoryPolicy, repositoryPolicy, type RepositoryPolicy } from '../model/repository-policy.js';
import { installSecretsDirectory, loadSecrets, redact, redactValues, runAgentStep, runCommandStep, runProcess, stepEnvironment, type ProcessRunner, type StepRecord } from './steps.js';

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
}
export interface RunOptions {
  url: string; token: string; environment?: string; runId?: string;
  stepTimeoutMs?: number; retries?: number;
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

interface CaseContext { url: string; vars: Record<string, string>; timeoutMs: number; fetcher: typeof fetch; page: () => Promise<E2ePage>; pageErrors: string[]; idempotency: (index: number) => string;
  secrets: Record<string, string>; general: { root: string; env: Record<string, string>; run: ProcessRunner; artifacts: string; session: (index: number) => string; signal?: AbortSignal } }

/** A step's own timeout: a command or agent step declares one; the request and browser steps share the run's. */
const timeoutOf = (step: E2eStep, context: Pick<CaseContext, 'timeoutMs'>) => step.kind === 'command' || step.kind === 'agent' ? step.timeoutSeconds * 1000 : context.timeoutMs;

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
    const response = await context.fetcher(onTarget(path, context.url), { method: step.method, signal: AbortSignal.timeout(context.timeoutMs),
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
  if (step.action === 'open') await page.goto(onTarget(substitute(step.path!, context.vars), context.url).toString(), { waitUntil: 'load', timeout });
  else if (step.action === 'fill') await page.getByLabel(substitute(step.label!, context.vars)).first().fill(substitute(step.value!, context.vars), { timeout });
  else if (step.action === 'click') await target().click({ timeout });
  else await target().waitFor({ state: 'visible', timeout });
  if (context.pageErrors.length > before) throw new Error(`page error: ${context.pageErrors[before]}`);
}

/** Run one case once: its declared secrets resolved first, then its steps in order, stopping at the first that fails. */
async function attemptCase(entry: CaseFile, options: Required<Pick<RunOptions, 'url' | 'token' | 'stepTimeoutMs' | 'root' | 'artifactsDirectory' | 'hostEnvironment' | 'processRunner'>> & { runId: string; attempt: number; fetcher: typeof fetch; launcher: () => Promise<E2eLauncher>; secretsDirectory: () => string; signal?: AbortSignal; withholdSecrets?: boolean }) {
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
  const context: CaseContext = { url: options.url, vars, timeoutMs: options.stepTimeoutMs, fetcher: options.fetcher, pageErrors, secrets,
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
  const now = options.now ?? Date.now, signal = options.signal, fetcher = signal ? cancellable(options.fetcher ?? fetch, signal) : options.fetcher ?? fetch;
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
      const result = await attemptCase(entry, { url: options.url, token: options.token, stepTimeoutMs, runId, attempt: attemptResults.length + 1, fetcher, launcher: launch, signal, withholdSecrets: options.withholdSecrets, ...general });
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
 * The `e2e` suite of `release validate` (GY-1351): every case targeted at `uat` against the UAT
 * deployment with the UAT principal's token, in id order. A release run retries a failing case once
 * (a pass on the retry is flaky, never passed) and stops at the first required case that fails, so
 * the cases after it are unrun. Only the release verdict's blocking cases — required cases that
 * failed or were flaky — fail the suite; optional cases run and are recorded but never fail it
 * (GY-1378). The detail names each blocking case and step, then the unrun cases apart. A managed
 * repository's candidate (GY-1535, release-project.ts projectCaseSuite) selects every required
 * case beside the uat ones and runs every one of them (`runAll`): a failing required case still
 * fails the suite, but never leaves a later required case unrun.
 */
export const releaseRetries = 1;
/** The candidate record the checkout's ledger holds for `id`, or why it reads none (GY-1802): its pending outcomes ride the `rc/ID` tag the cut pushed, which a validation checkout carries with no plane credential. A read that fails names none, so the suite blocks exactly as before. */
export const candidatePendingOutcomes = (root: string, id: string | undefined): readonly string[] | undefined => {
  if (!id) return undefined;
  try { return readRecords<ReleaseCandidate>(gitIn(root), candidateTagPrefix).find(entry => entry.id === id)?.pendingOutcomes; } catch { return undefined; }
};
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
  policy?: RepositoryPolicy } = {}) => ({
  name: 'e2e',
  run: async (url: string, candidate: { id: string; pendingOutcomes?: readonly string[] } | null) => {
    const selected = cases.filter(options.select ?? (entry => entry.definition.target === 'uat'));
    if (!selected.length) return { name: 'e2e', passed: false, detail: options.select ? 'no required or uat E2E case is in the checkout, so the suite exercised nothing' : 'no E2E case targets uat, so the suite exercised nothing' };
    const policy = options.policy ?? (options.root ? checkoutRepositoryPolicy(options.root) : repositoryPolicy());
    const pendingCases = pendingUnder(contractPendingCases(options.contract, candidate?.pendingOutcomes), policy);
    const report = await runCases(selected, { url, token, environment: 'uat', runId: candidate ? `rc-${candidate.id}` : undefined, fetcher: options.fetcher, launcher: options.launcher, stepTimeoutMs: options.stepTimeoutMs,
      root: options.root, retries: releaseRetries, stopOnRequiredFailure: !options.runAll, signal: options.signal, withholdSecrets: options.withholdSecrets, hostEnvironment: options.hostEnvironment, pendingCases, policy });
    await options.report?.(report);
    const verdict = releaseVerdict(report, [], pendingCases, policy), detail = failureDetail(report, pendingCases, policy);
    const executed = report.cases.length - verdict.unrun.length;
    return !verdict.passed
      ? { name: 'e2e', passed: false, detail: `${verdict.blocking.length} of ${executed} E2E cases ${verdict.blocking.every(outcome => outcome.verdict === 'flaky') ? 'were flaky' : 'failed'}: ${detail}` }
      : { name: 'e2e', passed: true, detail: `${report.passed} E2E case${report.passed === 1 ? '' : 's'} passed against UAT serving ${report.sha ?? 'an unreported commit'}${detail ? `; ${detail}` : ''}` };
  },
});

/**
 * Run the e2e suite as a `release validate --suite` command, from the candidate's own checkout (or
 * `GRAPHYARD_E2E_ROOT`): `GRAPHYARD_UAT_URL` is the deployment the validation set and
 * `GRAPHYARD_UAT_TOKEN` the UAT principal the api and browser suites use. The suite's one-line
 * detail, naming each failing case and step, goes to the file `GRAPHYARD_SUITE_DETAIL` names, which
 * the command suite reads back as its detail, so the failed candidate's follow-up names them. Like
 * every suite command it never holds the release credential, so it only writes its report to
 * `GRAPHYARD_E2E_REPORT`; the workflow's next step records that report with `graphyard e2e record`.
 * The candidate's pending outcomes (GY-1802) it reads off the `rc/ID` record in its own checkout's
 * ledger, beside the contract, so a case whose outcome no delivered item serves yet fails as
 * pending, never blocking, without any credential beyond the checkout.
 */
export async function runE2eSuite(env: NodeJS.ProcessEnv = process.env, root = env.GRAPHYARD_E2E_ROOT ?? process.cwd()) {
  const detail = async (text: string) => { if (env.GRAPHYARD_SUITE_DETAIL) await writeFile(env.GRAPHYARD_SUITE_DETAIL, `${text}\n`); };
  try {
    const url = env.GRAPHYARD_UAT_URL, token = env.GRAPHYARD_UAT_TOKEN;
    if (!url || !token) throw new Error('The e2e suite needs GRAPHYARD_UAT_URL and GRAPHYARD_UAT_TOKEN');
    const contract = await checkoutContract(root);
    const result = await e2eSuite(await loadCases(root), token, { root, contract, report: async report => {
      console.log(summarize(report));
      if (env.GRAPHYARD_E2E_REPORT) await writeFile(env.GRAPHYARD_E2E_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    } }).run(url, env.GRAPHYARD_CANDIDATE_ID ? { id: env.GRAPHYARD_CANDIDATE_ID, pendingOutcomes: candidatePendingOutcomes(root, env.GRAPHYARD_CANDIDATE_ID) } : null);
    console.log(result.detail);
    await detail(result.detail);
    if (!result.passed) process.exitCode = 1;
    return result;
  } catch (error) {
    await detail(`the e2e suite could not run: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
