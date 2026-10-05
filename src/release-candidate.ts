import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Release candidates: one moving main, a frozen candidate, UAT, then that exact SHA in production.
 *
 * A candidate is cut from main's tip on a schedule or on demand and recorded as an annotated tag
 * `rc/ID` on that exact commit, whose message is the candidate record: its SHA, when and why it
 * was cut, and the delivered items promoting it would bring to production. Cutting writes a tag
 * and nothing else, so merges to main never pause while a candidate is under test.
 *
 * UAT and production are Railway environments whose service tracks a branch of its own
 * (`release/uat`, `release/production`; see .railway/railway.ts), never main. Deploying a
 * candidate moves that branch to the candidate SHA. UAT validation is recorded as the tag
 * `rc-uat/ID` and only a passing record whose deployment served the candidate SHA lets
 * `release/production` move to it, recorded as `rc-production/ID`. A failed candidate files one
 * follow-up item naming the failing suite and the SHA, changes nothing about the deliveries it
 * contains, and the next cut proceeds from main's tip (fix forward).
 */

export const uatBranch = 'release/uat';
export const productionBranch = 'release/production';
export const candidateTagPrefix = 'rc/';
export const uatTagPrefix = 'rc-uat/';
export const productionTagPrefix = 'rc-production/';
/** The request id that makes filing a failed candidate's follow-up idempotent across retries. */
export const followUpRequestId = (id: string) => `release-candidate-follow-up:${id}`;

export type CutTrigger = 'schedule' | 'manual';
export interface CandidateItem { key: string; mergeSha: string; pr: number | null }
export interface ReleaseCandidate {
  id: string; sha: string; cutAt: string; trigger: CutTrigger;
  /** The newest candidate already promoted to production, which the item list is measured from. */
  since: { id: string; sha: string } | null;
  items: CandidateItem[];
}
export interface SuiteResult { name: string; passed: boolean; detail: string }
export interface UatRecord {
  id: string; sha: string; result: 'passed' | 'failed'; deployedSha: string | null; at: string; suites: SuiteResult[];
  /** The follow-up item a failed candidate filed, once filed. */
  followUp: string | null;
}
export interface ProductionRecord { id: string; sha: string; at: string }
export interface CommitSummary { sha: string; subject: string; body: string }

const fullSha = /^[0-9a-f]{40}$/;
const assertSha = (sha: string, label: string) => { if (!fullSha.test(sha)) throw new Error(`${label} must be a full 40-character commit SHA, got ${JSON.stringify(sha)}`); };

/** `20261001T231900Z`: sortable, unique per second, and valid inside a Git ref name. */
export const candidateId = (now: Date) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * The delivered items a range of main's first-parent commits carries. A Graphyard branch merge
 * names its item in the branch (`graphyard/gy-1094-1`); a squash or a hand-written subject names
 * it as `GY-N:`. A commit naming no item (a docs touch, a direct fix) is not a delivery.
 */
export function itemsFromCommits(commits: readonly CommitSummary[]): CandidateItem[] {
  const items: CandidateItem[] = [];
  const seen = new Set<string>();
  for (const commit of commits) {
    // The subject names the merged branch; a body may mention other items' branches in passing.
    const branchIn = (text: string) => /\bgraphyard\/([a-z][a-z0-9]*-\d+)-\d+\b/i.exec(text)?.[1];
    const namedIn = (text: string) => /^([A-Z][A-Z0-9]*-\d+):/m.exec(text)?.[1];
    const key = (branchIn(commit.subject) ?? namedIn(commit.subject) ?? branchIn(commit.body) ?? namedIn(commit.body))?.toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const pr = /#(\d+)\b/.exec(commit.subject);
    items.push({ key, mergeSha: commit.sha, pr: pr ? Number(pr[1]) : null });
  }
  return items;
}

/**
 * Pure: the candidate a cut records, or why there is nothing to cut. The previous candidate's
 * outcome never matters — a failed candidate leaves main moving and the next cut proceeds — but a
 * tip that is already a candidate is not cut twice.
 */
export function cutCandidate(input: { tip: string; now: Date; trigger: CutTrigger; latest: ReleaseCandidate | null; promoted: ReleaseCandidate | null; commits: readonly CommitSummary[] }):
  { cut: true; candidate: ReleaseCandidate } | { cut: false; reason: string } {
  assertSha(input.tip, 'main tip');
  if (input.latest?.sha === input.tip) return { cut: false, reason: `main tip ${input.tip} is already candidate ${input.latest.id}` };
  return { cut: true, candidate: {
    id: candidateId(input.now), sha: input.tip, cutAt: input.now.toISOString(), trigger: input.trigger,
    since: input.promoted ? { id: input.promoted.id, sha: input.promoted.sha } : null,
    items: itemsFromCommits(input.commits),
  } };
}

/**
 * Pure: the UAT verdict for a candidate. It passes only when every suite ran and passed against a
 * deployment that served the candidate's exact SHA; a deployment serving anything else is a
 * failure of the candidate's validation, never a pass attributed to it.
 */
export function assessUat(candidate: ReleaseCandidate, input: { deployedSha: string | null; suites: SuiteResult[]; now: Date }): UatRecord {
  const suites = [...input.suites];
  if (input.deployedSha !== candidate.sha) suites.unshift({ name: 'deployment', passed: false, detail: `UAT served ${input.deployedSha ?? 'no observable commit'}, not candidate ${candidate.sha}` });
  if (!suites.length) suites.push({ name: 'suites', passed: false, detail: 'no suite ran against the UAT deployment' });
  return { id: candidate.id, sha: candidate.sha, result: suites.every(suite => suite.passed) ? 'passed' : 'failed', deployedSha: input.deployedSha, at: input.now.toISOString(), suites, followUp: null };
}

/**
 * Pure: whether production may move to a candidate. Only a candidate whose recorded UAT
 * validation passed on its exact SHA is promotable, and only forward: a candidate older than the
 * one production already runs is a rollback, which goes through recovery, not promotion.
 */
export function assessPromotion(candidate: ReleaseCandidate, uat: UatRecord | null, current: ProductionRecord | null) {
  const refusals: string[] = [];
  if (!uat) refusals.push(`Candidate ${candidate.id} has no UAT validation record; deploy it to UAT and validate it first`);
  else {
    if (uat.sha !== candidate.sha || uat.deployedSha !== candidate.sha) refusals.push(`Candidate ${candidate.id}'s UAT record is for ${uat.deployedSha ?? 'no deployment'}, not its SHA ${candidate.sha}`);
    if (uat.result !== 'passed') refusals.push(`Candidate ${candidate.id} failed UAT (${failingSuites(uat).map(suite => suite.name).join(', ')}); cut a newer candidate after the fix`);
  }
  if (current && current.id > candidate.id) refusals.push(`Production already runs newer candidate ${current.id}; an older candidate is a rollback, not a promotion`);
  return { promotable: refusals.length === 0, refusals, sha: candidate.sha, already: current?.sha === candidate.sha };
}

export const failingSuites = (uat: UatRecord) => uat.suites.filter(suite => !suite.passed);

/**
 * The one fix-forward item a failed candidate files. It names the failing suites and, among them,
 * the failing release-candidate proofs (GY-1101), the candidate SHA and the commit range since the
 * last promoted candidate, and lists the deliveries the candidate carried for context only: they
 * stay merged-pending-release, are never reworked or reverted, and the next candidate cut after the
 * fix carries them again.
 */
export function followUpItem(candidate: ReleaseCandidate, uat: UatRecord) {
  const failing = failingSuites(uat);
  if (uat.result !== 'failed' || !failing.length) throw new Error(`Candidate ${candidate.id} did not fail UAT; it files no follow-up`);
  const first = failing[0];
  const proofs = failing.flatMap(suite => suite.name.startsWith('proof ') ? [suite.name.slice(6)] : []);
  const carried = candidate.items.length ? candidate.items.map(item => `${item.key} (${item.mergeSha.slice(0, 12)})`).join(', ') : 'no named deliveries';
  const range = candidate.since ? `${candidate.since.sha}..${candidate.sha} (since promoted candidate ${candidate.since.id})` : `up to ${candidate.sha} (no candidate promoted yet)`;
  return {
    title: `Release candidate ${candidate.id} failed UAT ${proofs.length ? `proof ${proofs[0]}` : `suite ${first.name}`} at ${candidate.sha.slice(0, 12)}`,
    description: `Release candidate ${candidate.id} at ${candidate.sha} failed UAT. Failing suite${failing.length > 1 ? 's' : ''}: ${failing.map(suite => `${suite.name} — ${suite.detail}`).join('; ')}. `
      + `Failing proofs: ${proofs.length ? proofs.join(', ') : 'none (no release-candidate proof failed)'}. Commit range: ${range}. `
      + `It carried ${carried}; those items stay merged-pending-release and are not reworked or reverted. Fix forward on main; the next candidate cut after the fix carries them and this fix to UAT.`,
    type: 'bug', priority: 1,
    criteria: [{ id: 'AC-1', text: `The ${first.name} suite that failed on candidate ${candidate.id} (${candidate.sha}) passes against the UAT deployment of a later candidate`, proofs: ['manual:release-candidate-uat-pass'] }],
    policy: { checks: ['test', 'typecheck'], review: true },
  };
}

/** The candidate report the release CLI sends the control plane (GY-1101): the candidate, its UAT record and its promotion. */
export const candidateReport = (ledger: Ledger, candidate: ReleaseCandidate) => {
  const uat = ledger.uat.find(record => record.id === candidate.id) ?? null;
  const production = ledger.production.find(record => record.id === candidate.id) ?? null;
  return { candidate: { id: candidate.id, sha: candidate.sha, items: candidate.items },
    uat: uat ? { result: uat.result, suites: uat.suites, followUp: uat.followUp } : null, production: production ? { at: production.at } : null };
};

/** Pure: which promoted candidate a production deployment serves, or why it serves none. */
export function assessProductionServing(servedSha: string | null, promoted: readonly ProductionRecord[]) {
  if (!servedSha) return { verified: false as const, reason: 'production reports no serving commit', candidate: null };
  const match = promoted.find(record => record.sha === servedSha);
  if (!match) return { verified: false as const, reason: `production serves ${servedSha}, which is not a promoted release candidate`, candidate: null };
  const latest = [...promoted].sort((a, b) => b.id.localeCompare(a.id))[0];
  return { verified: true as const, reason: latest.id === match.id ? null : `production serves candidate ${match.id}; candidate ${latest.id} is promoted and not yet serving`, candidate: match.id, sha: servedSha };
}

/**
 * The commit a Graphyard deployment reports serving, from its `/healthz` body. The server reports
 * the commit it was built from as `commit`; `revision` is the image's stamped build revision, which
 * a Railway build leaves `unknown`, so it only counts when `commit` is absent and it is a full SHA.
 */
export const servedRevision = (health: any): string | null => {
  for (const value of [health?.commit, health?.revision]) {
    const sha = typeof value === 'string' ? value.toLowerCase() : '';
    if (fullSha.test(sha)) return sha;
  }
  return null;
};

// ——— Effects: the candidate ledger is the repository's own tags and branches. ———

export type Git = (args: string[]) => string;
export const gitIn = (cwd: string): Git => args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

/** Every record under one tag prefix, newest first, read from annotated tag messages. */
export function readRecords<T>(git: Git, prefix: string): T[] {
  const out = git(['for-each-ref', '--sort=-refname', '--format=%(refname:strip=2)%00%(contents)%00%00', `refs/tags/${prefix}`]);
  return out.split('\0\0').map(entry => entry.replace(/^\n/, '')).filter(Boolean).flatMap(entry => {
    const [, body] = entry.split('\0');
    try { return [JSON.parse(body.trim()) as T]; } catch { return []; }
  });
}

export interface Ledger { candidates: ReleaseCandidate[]; uat: UatRecord[]; production: ProductionRecord[] }
export const readLedger = (git: Git): Ledger => ({
  candidates: readRecords<ReleaseCandidate>(git, candidateTagPrefix),
  uat: readRecords<UatRecord>(git, uatTagPrefix),
  production: readRecords<ProductionRecord>(git, productionTagPrefix),
});
export const findCandidate = (ledger: Ledger, id: string) => {
  const candidate = id === 'latest' ? ledger.candidates[0] : ledger.candidates.find(entry => entry.id === id);
  if (!candidate) throw new Error(id === 'latest' ? 'No release candidate has been cut' : `Unknown release candidate ${id}`);
  return candidate;
};
export const latestPromoted = (ledger: Ledger) => {
  const record = ledger.production[0];
  return record ? ledger.candidates.find(candidate => candidate.id === record.id) ?? null : null;
};

/** Record one ledger entry as an annotated tag on `sha` and publish it. A tag never moves. */
export function writeRecord(git: Git, tag: string, sha: string, record: unknown, push: boolean) {
  git(['-c', 'user.name=graphyard-release', '-c', 'user.email=release@graphyard.invalid', 'tag', '-a', tag, sha, '-m', JSON.stringify(record, null, 2)]);
  if (push) git(['push', 'origin', `refs/tags/${tag}`]);
}

/**
 * Point an environment branch at the exact candidate SHA; the environment deploys that commit.
 * Given the SHA the branch is expected to hold (the last candidate promoted there), the push is
 * leased on it, so a branch someone moved by hand is refused rather than silently overwritten.
 */
export const deployBranch = (git: Git, branch: string, sha: string, expected?: string | null) => {
  assertSha(sha, 'candidate');
  if (expected) assertSha(expected, 'expected branch tip');
  git(['push', expected ? `--force-with-lease=refs/heads/${branch}:${expected}` : '--force', 'origin', `${sha}:refs/heads/${branch}`]);
};

export function firstParentCommits(git: Git, tip: string, since: string | null): CommitSummary[] {
  const range = since ? [`${since}..${tip}`] : ['--max-count=200', tip];
  const out = git(['log', '--first-parent', '--format=%H%x00%s%x00%b%x1e', ...range]);
  return out.split('\x1e').map(entry => entry.trim()).filter(Boolean).map(entry => { const [sha, subject, body] = entry.split('\0'); return { sha, subject, body: body ?? '' }; });
}

/** Bring the base branch and every ledger tag up to date with the remote. */
export const syncLedger = (git: Git, base: string) => git(['fetch', '--quiet', '--force', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`, '+refs/tags/*:refs/tags/*']);

/** Cut a candidate from the remote base branch's tip, as recorded in the remote's tags. */
export function cut(git: Git, options: { base: string; trigger: CutTrigger; now: Date; push: boolean }) {
  syncLedger(git, options.base);
  const tip = git(['rev-parse', `refs/remotes/origin/${options.base}`]).trim();
  const ledger = readLedger(git);
  const promoted = latestPromoted(ledger);
  const result = cutCandidate({ tip, now: options.now, trigger: options.trigger, latest: ledger.candidates[0] ?? null, promoted, commits: firstParentCommits(git, tip, promoted?.sha ?? null) });
  if (result.cut) writeRecord(git, `${candidateTagPrefix}${result.candidate.id}`, tip, result.candidate, options.push);
  return result;
}

/** One suite run against the UAT deployment: a check the CLI performs, or a command it starts. */
export interface Suite { name: string; run: (url: string, candidate: ReleaseCandidate) => Promise<SuiteResult> }

/**
 * A command run with `GRAPHYARD_UAT_URL` set to the deployment. It never sees `GRAPHYARD_TOKEN`, the
 * release credential that files a failed candidate's follow-up: only that filing step needs it.
 */
export const commandSuite = (name: string, command: string, timeoutMs = 3_600_000): Suite => ({ name, run: async url => {
  const { GRAPHYARD_TOKEN: _release, ...env } = process.env;
  const child = spawnSync('bash', ['-c', command], { stdio: 'inherit', timeout: timeoutMs, env: { ...env, GRAPHYARD_UAT_URL: url } });
  const passed = child.status === 0;
  return { name, passed, detail: passed ? `\`${command}\` passed` : `\`${command}\` exited ${child.status ?? child.signal}` };
} });

/**
 * One release-candidate proof (GY-1101) run against the candidate's own checkout: the test cases
 * whose titles carry the proof id. It passes only when at least one such case ran and none failed,
 * so a proof no test names never passes by matching nothing. Like every suite command it never
 * sees `GRAPHYARD_TOKEN`.
 */
export const testProofSuite = (proof: string, cwd = process.cwd(), timeoutMs = 3_600_000): Suite => ({ name: `proof ${proof}`, run: async () => {
  const { GRAPHYARD_TOKEN: _release, ...env } = process.env;
  const pattern = proof.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const child = spawnSync('node', ['--import', 'tsx', 'tests/helpers/run-tests.ts', `--test-name-pattern=${pattern}`, '--test-reporter=tap'], { cwd, encoding: 'utf8', timeout: timeoutMs, env, maxBuffer: 256 * 1024 * 1024 });
  return proofRunResult(proof, child.status, `${child.stdout ?? ''}`);
} });
/** Pure: a proof run's verdict from its TAP stream and exit status. */
export function proofRunResult(proof: string, status: number | null, tap: string): SuiteResult {
  const lines = tap.split('\n').filter(line => line.includes(proof) && /^\s*(not )?ok \d+/.test(line) && !/# SKIP/i.test(line));
  const passed = lines.filter(line => /^\s*ok /.test(line)).length, failed = lines.filter(line => /^\s*not ok /.test(line)).length;
  const ok = status === 0 && passed > 0 && failed === 0;
  return { name: `proof ${proof}`, passed: ok, detail: ok ? `${passed} case${passed === 1 ? '' : 's'} naming ${proof} passed` : passed + failed === 0 ? `no test case names ${proof}` : `${failed} of ${passed + failed} cases naming ${proof} failed (exit ${status})` };
}

export const endpointSuite = (paths: readonly string[], fetcher: typeof fetch = fetch): Suite => ({ name: 'endpoints', run: async url => {
  const failures: string[] = [];
  for (const path of paths) {
    try { const response = await fetcher(new URL(path, url)); if (!response.ok) failures.push(`${path} answered ${response.status}`); }
    catch (error) { failures.push(`${path} failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { name: 'endpoints', passed: !failures.length, detail: failures.length ? failures.join('; ') : `${paths.join(', ')} answered 2xx` };
} });

/**
 * The long suite that drives the deployed UAT API end to end with a UAT-only principal's token: it
 * creates a work item in UAT's own database, replays that create under the same idempotency key
 * and expects the same item back, then finds the item through the work list and reads the board
 * and status views every operator surface is built on. UAT has its own Postgres and no GitHub App,
 * so the item it creates never reaches the production repository or production's work.
 */
export const apiSuite = (token: string, fetcher: typeof fetch = fetch): Suite => ({ name: 'api', run: async (url, candidate) => {
  const failures: string[] = [];
  const call = async (path: string, body?: unknown, requestId?: string) => {
    const response = await fetcher(new URL(path, url), { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(requestId ? { 'Idempotency-Key': requestId } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`${body === undefined ? 'GET' : 'POST'} ${path} answered ${response.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  const requestId = `release-candidate-uat:${candidate.id}`;
  const item = {
    title: `UAT scenario for release candidate ${candidate.id} at ${candidate.sha.slice(0, 12)}`,
    description: `Created by the release candidate api suite against UAT serving ${candidate.sha}.`,
    type: 'chore', priority: 3,
    criteria: [{ id: 'AC-1', text: `UAT accepts and serves work created against candidate ${candidate.id}`, proofs: ['manual:release-candidate-uat-scenario'] }],
    policy: { checks: ['test'], review: true },
  };
  try {
    const created = await call('/api/work', item, requestId);
    const id = created?.id ?? created?.work?.id;
    if (!id) throw new Error(`POST /api/work returned no item id: ${JSON.stringify(created).slice(0, 200)}`);
    const replayed = await call('/api/work', item, requestId);
    if ((replayed?.id ?? replayed?.work?.id) !== id) failures.push(`replaying the create under ${requestId} returned ${replayed?.id ?? replayed?.work?.id}, not ${id}`);
    const listed = (await call('/api/work') as any[]).find(entry => entry.id === id);
    if (!listed) failures.push(`GET /api/work does not list the created item ${id}`);
    else if (listed.title !== item.title) failures.push(`GET /api/work lists ${id} titled ${JSON.stringify(listed.title)}`);
    await call('/api/board');
    await call('/api/status');
  } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  return { name: 'api', passed: !failures.length, detail: failures.length ? failures.join('; ') : 'created, replayed and listed a work item, and read the board and status, on the UAT deployment' };
} });

/** The slice of Playwright's chromium the browser suite drives; tests substitute their own. */
export interface BrowserLauncher { launch(options: { headless: boolean }): Promise<BrowserSession> }
export interface BrowserSession { newPage(): Promise<BrowserPage>; close(): Promise<void> }
export interface BrowserPage {
  on(event: 'pageerror', listener: (error: Error) => void): unknown;
  on(event: 'response', listener: (response: { url(): string; status(): number }) => void): unknown;
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<unknown>;
  getByLabel(text: string): { fill(value: string): Promise<void> };
  getByRole(role: 'button' | 'navigation' | 'heading', options: { name: string; exact?: boolean; level?: number }): BrowserLocator;
}
export interface BrowserLocator { click(): Promise<void>; waitFor(options: { state: 'visible'; timeout: number }): Promise<void>; getByRole: BrowserPage['getByRole'] }

/**
 * The scenario suite that drives the UAT deployment in a real browser, the way an operator meets
 * it: it loads the dashboard UAT serves, signs in with the UAT principal's token, waits for the
 * control plane to verify it and render the primary navigation, and opens the Work view. Any
 * uncaught page error, or any answer of 500 or above from the UAT origin, fails it, as does a
 * step that never renders. The runner's own checkout serves nothing here: every page, script and
 * API call comes from the UAT deployment.
 */
export const browserSuite = (token: string, launcher?: BrowserLauncher, timeoutMs = 60_000): Suite => ({ name: 'browser', run: async url => {
  const failures: string[] = [];
  const chromium = launcher ?? (await import('@playwright/test')).chromium as unknown as BrowserLauncher;
  const browser = await chromium.launch({ headless: true });
  const origin = new URL(url).origin;
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => failures.push(`page error: ${error.message}`));
    page.on('response', response => { if (response.status() >= 500 && response.url().startsWith(origin)) failures.push(`${new URL(response.url()).pathname} answered ${response.status()}`); });
    let step = `load ${url}`;
    try {
      await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
      step = 'sign in with the UAT token';
      await page.getByLabel('Access token').fill(token);
      await page.getByRole('button', { name: 'Open control plane' }).click();
      step = 'render the primary navigation after sign-in';
      const navigation = page.getByRole('navigation', { name: 'Primary' });
      await navigation.waitFor({ state: 'visible', timeout: timeoutMs });
      step = 'open the Work view';
      await navigation.getByRole('button', { name: 'Work', exact: true }).click();
      await page.getByRole('heading', { name: 'Work', exact: true, level: 1 }).waitFor({ state: 'visible', timeout: timeoutMs });
    } catch (error) { failures.unshift(`could not ${step}: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`); }
  } finally { await browser.close(); }
  return { name: 'browser', passed: !failures.length, detail: failures.length ? failures.join('; ') : 'loaded the dashboard, signed in and opened the Work view in a browser on the UAT deployment' };
} });

/**
 * Run the browser suite as a `release validate --suite` command: `GRAPHYARD_UAT_URL` is the
 * deployment the validation set, `GRAPHYARD_UAT_TOKEN` the UAT principal the api suite also uses.
 */
export async function runBrowserSuite(env: NodeJS.ProcessEnv = process.env) {
  const url = env.GRAPHYARD_UAT_URL, token = env.GRAPHYARD_UAT_TOKEN;
  if (!url || !token) throw new Error('The browser suite needs GRAPHYARD_UAT_URL and GRAPHYARD_UAT_TOKEN');
  const result = await browserSuite(token).run(url, null as never);
  console.log(result.detail);
  if (!result.passed) process.exitCode = 1;
  return result;
}

export async function readServed(url: string, fetcher: typeof fetch = fetch) {
  try { const response = await fetcher(new URL('/healthz', url)); return response.ok ? servedRevision(await response.json()) : null; } catch { return null; }
}

/** Wait until `url` serves `sha`, up to the deadline; returns what it last served. */
export async function awaitServing(url: string, sha: string, options: { timeoutMs: number; intervalMs?: number; fetcher?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
  const now = options.now ?? Date.now, sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const served = await readServed(url, options.fetcher);
    if (served === sha || now() >= deadline) return served;
    await sleep(options.intervalMs ?? 15_000);
  }
}

/**
 * Validate a candidate on UAT: wait for UAT to serve its exact SHA, run every suite against it,
 * and confirm UAT still serves that SHA afterwards so no verdict is attributed across a redeploy.
 */
export async function validate(candidate: ReleaseCandidate, url: string, suites: readonly Suite[], options: { timeoutMs: number; now?: () => Date; fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void> }) {
  const clock = options.now ?? (() => new Date());
  const before = await awaitServing(url, candidate.sha, { timeoutMs: options.timeoutMs, fetcher: options.fetcher, sleep: options.sleep, now: () => clock().getTime() });
  if (before !== candidate.sha) return assessUat(candidate, { deployedSha: before, suites: [], now: clock() });
  const results: SuiteResult[] = [];
  for (const suite of suites) results.push(await suite.run(url, candidate));
  const after = await readServed(url, options.fetcher);
  if (after !== candidate.sha) results.push({ name: 'deployment', passed: false, detail: `UAT moved from ${candidate.sha} to ${after ?? 'no observable commit'} while the suites ran` });
  return assessUat(candidate, { deployedSha: candidate.sha, suites: results, now: clock() });
}

/**
 * How long after its cut a candidate UAT serves without a verdict counts as still under validation:
 * longer than the workflow's cut, long-suite and uat jobs together (10 + 45 + 120 minutes), so a
 * validation that crashed without recording blocks the next deploy for at most this long.
 */
export const uatValidationWindowMs = 4 * 3_600_000;

/**
 * Pure: whether `release/uat` may move to a candidate, given the commit it holds now. UAT serving
 * another candidate that has no verdict yet, cut within the validation window, is a validation in
 * progress: moving UAT under it would fail that validation and file a spurious follow-up, so the
 * deploy is refused. Otherwise the push is leased on the observed tip, so a concurrent deploy that
 * moved the branch in between is refused rather than overwritten.
 */
export function assessUatDeploy(candidate: ReleaseCandidate, ledger: Ledger, uatTip: string | null, now: Date) {
  if (!uatTip || uatTip === candidate.sha) return { deploy: true as const, expected: uatTip };
  const there = ledger.candidates.filter(entry => entry.sha === uatTip);
  const pending = there.some(entry => ledger.uat.some(record => record.id === entry.id)) ? undefined
    : there.find(entry => now.getTime() - Date.parse(entry.cutAt) < uatValidationWindowMs);
  if (pending) return { deploy: false as const, refusal: `UAT serves candidate ${pending.id} (${pending.sha}), whose validation has no verdict yet; moving release/uat now would fail it. Wait for its verdict, or until ${new Date(Date.parse(pending.cutAt) + uatValidationWindowMs).toISOString()} if that validation was abandoned` };
  return { deploy: true as const, expected: uatTip };
}

const remoteTip = (git: Git, branch: string) => git(['ls-remote', 'origin', `refs/heads/${branch}`]).split(/\s/)[0] || null;

/**
 * Deploy a candidate to UAT: `release/uat` moves to its exact SHA, unless another candidate's
 * validation is still running there, and only from the tip it was observed at.
 */
export function deployToUat(git: Git, id: string, base: string, now = new Date()) {
  syncLedger(git, base);
  const ledger = readLedger(git);
  const candidate = findCandidate(ledger, id);
  const assessment = assessUatDeploy(candidate, ledger, remoteTip(git, uatBranch), now);
  if (!assessment.deploy) throw new Error(assessment.refusal);
  deployBranch(git, uatBranch, candidate.sha, assessment.expected);
  return { candidate: candidate.id, sha: candidate.sha, branch: uatBranch };
}

/**
 * Validate a candidate on UAT and record the verdict once. A failed candidate files its one
 * follow-up before the record is written, keyed by the candidate so a retry never files twice;
 * a filing that fails still records the verdict, and `release follow-up` files it later.
 */
export async function validateAndRecord(git: Git, id: string, url: string, suites: readonly Suite[], options: { base: string; push: boolean; timeoutMs: number;
  file?: (item: ReturnType<typeof followUpItem>, requestId: string) => Promise<string>; now?: () => Date; fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void> }) {
  syncLedger(git, options.base);
  const ledger = readLedger(git);
  const candidate = findCandidate(ledger, id);
  const existing = ledger.uat.find(record => record.id === candidate.id);
  if (existing) throw new Error(`Candidate ${candidate.id} was already validated on UAT (${existing.result} at ${existing.at}); cut a new candidate to validate again`);
  const record = await validate(candidate, url, suites, options);
  let filingError: string | null = null;
  if (record.result === 'failed' && options.file) {
    try { record.followUp = await options.file(followUpItem(candidate, record), followUpRequestId(candidate.id)); }
    catch (error) { filingError = error instanceof Error ? error.message : String(error); }
  }
  writeRecord(git, `${uatTagPrefix}${candidate.id}`, candidate.sha, record, options.push);
  return { record, followUp: record.result === 'failed' ? record.followUp ?? null : null, filingError };
}

/** Promote a candidate: `release/production` moves to its exact SHA, only after UAT passed on it. */
export function promote(git: Git, id: string, options: { base: string; push: boolean; now: Date }) {
  syncLedger(git, options.base);
  const ledger = readLedger(git);
  const candidate = findCandidate(ledger, id);
  const assessment = assessPromotion(candidate, ledger.uat.find(record => record.id === candidate.id) ?? null, ledger.production[0] ?? null);
  if (!assessment.promotable) return { promoted: false as const, candidate: candidate.id, refusals: assessment.refusals };
  deployBranch(git, productionBranch, candidate.sha, ledger.production[0]?.sha ?? null);
  if (!ledger.production.some(record => record.id === candidate.id)) writeRecord(git, `${productionTagPrefix}${candidate.id}`, candidate.sha, { id: candidate.id, sha: candidate.sha, at: options.now.toISOString() } satisfies ProductionRecord, options.push);
  return { promoted: true as const, candidate: candidate.id, sha: candidate.sha, branch: productionBranch };
}

/** Every candidate with its UAT and production state, newest first. */
export const ledgerStatus = (ledger: Ledger) => ledger.candidates.map(candidate => {
  const uat = ledger.uat.find(record => record.id === candidate.id) ?? null;
  return { id: candidate.id, sha: candidate.sha, cutAt: candidate.cutAt, trigger: candidate.trigger, items: candidate.items.map(item => item.key),
    uat: uat ? { result: uat.result, at: uat.at, failing: failingSuites(uat).map(suite => suite.name), followUp: uat.followUp } : null,
    production: ledger.production.find(record => record.id === candidate.id)?.at ?? null };
});
