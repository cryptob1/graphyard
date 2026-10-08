import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Release candidates: one moving main, a frozen candidate, UAT, then that exact SHA in production.
 *
 * A candidate is cut from main on a schedule or on demand and recorded as an annotated tag `rc/ID`
 * on that exact commit, whose message is the candidate record: its SHA, when and why it was cut,
 * and the delivered items promoting it would bring to production. It carries at most `maxPrs`
 * merges after the previous candidate (GY-1491): main's tip, or the commit of that many merges. Cutting writes a tag
 * and nothing else, so merges to main never pause while a candidate is under test.
 *
 * UAT and production are Railway environments whose service tracks a branch of its own
 * (`release/uat`, `release/production`; see .railway/railway.ts), never main. Deploying a
 * candidate moves that branch to the candidate SHA. UAT validation is recorded as the tag
 * `rc-uat/ID` and only a passing record whose deployment served the candidate SHA lets
 * `release/production` move to it, recorded as `rc-production/ID`. A failed candidate files one
 * follow-up item naming the failing suite and the SHA, changes nothing about the deliveries it
 * contains, and the next cut starts after it (fix forward). A failure the release contract
 * attributes to a customer outcome is a release hold instead (src/release-holds.ts, GY-1378).
 */

export const uatBranch = 'release/uat';
export const productionBranch = 'release/production';
export const candidateTagPrefix = 'rc/';
export const uatTagPrefix = 'rc-uat/';
export const productionTagPrefix = 'rc-production/';
/** GY-1513: the advisory soak's verdict, recorded on the candidate's SHA by release-candidate-soak.yml once its run concludes. */
export const soakTagPrefix = 'rc-soak/';
/** The request id that makes filing a failed candidate's follow-up idempotent across retries. */
export const followUpRequestId = (id: string) => `release-candidate-follow-up:${id}`;

export type CutTrigger = 'schedule' | 'manual';
export interface CandidateItem { key: string; mergeSha: string; pr: number | null }
export interface ReleaseCandidate {
  id: string; sha: string; cutAt: string; trigger: CutTrigger;
  /** The newest candidate already promoted to production, which the item list is measured from. */
  since: { id: string; sha: string } | null;
  /**
   * GY-1491: the candidate this one starts after (the newest cut, promoted or not), which its merges
   * are counted from; null for the first candidate. Absent on records cut before GY-1491.
   */
  from?: { id: string; sha: string } | null;
  /** First-parent merges this candidate carries beyond `from`, and those left on main behind it at the cut. */
  prs?: number;
  queued?: number;
  items: CandidateItem[];
}
export interface SuiteResult { name: string; passed: boolean; detail: string }
/** One case of the candidate's e2e release run (GY-1378), as its UAT record keeps it. */
export interface E2eCaseRecord {
  case: string; verdict: 'passed' | 'failed' | 'flaky' | 'unrun'; required: boolean; stoppedBy?: string; attempts: number;
  failingStep: { index: number; name: string; reason: string } | null;
}
/** The e2e release run bound to the candidate: its run id, the SHA UAT served, every case's verdict and the blocking ones. */
export interface E2eRecord { runId: string; sha: string; cases: E2eCaseRecord[]; blocking: string[] }
export interface UatRecord {
  id: string; sha: string; result: 'passed' | 'failed'; deployedSha: string | null; at: string; suites: SuiteResult[];
  /** The follow-up item a failed candidate filed, once filed. */
  followUp: string | null;
  e2e?: E2eRecord | null;
  /** The release holds the validation opened, attached to or cleared (src/release-holds.ts). */
  holds?: { kind: 'open' | 'attach' | 'clear'; outcome: string; hold: string; item: string | null }[];
}
/** An applied evidence decision (GY-1378): one flaky case of one run accepted at one exact SHA. */
export interface FlakyAcceptance { case: string; runId: string; sha: string; decision: string }
export interface ProductionRecord { id: string; sha: string; at: string }
/**
 * GY-1513: the advisory soak and timing-budget suites' verdict for a candidate (`rc-soak/ID`): the
 * result of the soak run that soaked its exact SHA, that run's URL and the name of the timing report
 * it uploaded there. It decides nothing — promotion never reads it (GY-1440).
 */
export interface SoakRecord { id: string; sha: string; result: 'passed' | 'failed' | 'cancelled'; at: string; run: string | null; report: string | null }
export interface CommitSummary { sha: string; subject: string; body: string }

const fullSha = /^[0-9a-f]{40}$/;
const assertSha = (sha: string, label: string) => { if (!fullSha.test(sha)) throw new Error(`${label} must be a full 40-character commit SHA, got ${JSON.stringify(sha)}`); };

/** `20261001T231900Z`: sortable, unique per second, and valid inside a Git ref name. */
export const candidateId = (now: Date) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * The delivered items a range of main's first-parent commits carries. A Graphyard branch merge
 * names its item in the branch (`graphyard/gy-1094-1`); a squash or a hand-written subject names
 * it as `GY-N:`. A commit naming no item (a docs touch, a direct fix) is not a delivery, and neither
 * is a revert of an item's merge or the merge it reverted (GY-1526).
 */
export function itemsFromCommits(commits: readonly CommitSummary[]): CandidateItem[] {
  const items: CandidateItem[] = [];
  const seen = new Set<string>(), reverted = new Set<string>();
  for (const commit of commits) {
    // The subject names the merged branch; a body may mention other items' branches in passing.
    const branchIn = (text: string) => /\bgraphyard\/([a-z][a-z0-9]*-\d+)-\d+\b/i.exec(text)?.[1];
    const namedIn = (text: string) => /^([A-Z][A-Z0-9]*-\d+):/m.exec(text)?.[1];
    const key = (branchIn(commit.subject) ?? namedIn(commit.subject) ?? branchIn(commit.body) ?? namedIn(commit.body))?.toUpperCase();
    // GY-1526: a revert of an item's merge (`Revert "Merge pull request #N from …/graphyard/gy-N-E"`, as the
    // loop's candidate revert or the main guard writes it) delivers nothing, and the older merge it undoes
    // is no delivery either: the item is reopened, and its next merge names it afresh.
    if (key && /^Revert "/.test(commit.subject)) { reverted.add(key); continue; }
    if (!key || seen.has(key) || reverted.has(key)) continue;
    seen.add(key);
    const pr = /#(\d+)\b/.exec(commit.subject);
    items.push({ key, mergeSha: commit.sha, pr: pr ? Number(pr[1]) : null });
  }
  return items;
}

/**
 * GY-1491: the most merged pull requests one candidate carries, so a failed candidate implicates at
 * most this many changes. `GRAPHYARD_RC_MAX_PRS` (or `release cut --max-prs N`) sets another.
 */
export const defaultMaxPrs = 10;
export function maxPrsFrom(value: string | number | undefined | null) {
  if (value === undefined || value === null || value === '') return defaultMaxPrs;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`The release candidate PR cap must be a positive integer, got ${JSON.stringify(value)}`);
  return parsed;
}

/**
 * Pure: the candidate a cut records, or why there is nothing to cut. A candidate starts after the
 * newest one cut (`latest`), whatever its outcome — a failed candidate leaves main moving and its
 * successor starts after it (fix forward) — and carries at most `maxPrs` first-parent merges in
 * merge order: with more waiting, it is cut at the `maxPrs`th merge and the rest stay queued for the
 * next candidate, cut once this one concludes. `commits` are main's first-parent commits after the
 * promoted candidate (the newest ones when none is promoted), newest first, as `git log
 * --first-parent` lists them; the item list keeps measuring from the promoted candidate, since
 * promoting this one brings a failed predecessor's deliveries too. The first candidate ever has
 * nothing to start after, so it takes main's tip. A tip that is already a candidate is not cut twice.
 */
export function cutCandidate(input: { tip: string; now: Date; trigger: CutTrigger; latest: ReleaseCandidate | null; promoted: ReleaseCandidate | null; commits: readonly CommitSummary[]; maxPrs?: number }):
  { cut: true; candidate: ReleaseCandidate } | { cut: false; reason: string } {
  assertSha(input.tip, 'main tip');
  const { latest } = input;
  if (latest?.sha === input.tip) return { cut: false, reason: `main tip ${input.tip} is already candidate ${latest.id}` };
  const maxPrs = maxPrsFrom(input.maxPrs);
  const start = latest ? input.commits.findIndex(commit => commit.sha === latest.sha) : -1;
  const merges = (start >= 0 ? input.commits.slice(0, start) : input.commits).slice().reverse();
  if (latest && !merges.length) return { cut: false, reason: `main has no merge after candidate ${latest.id} (${latest.sha})` };
  const capped = !!latest && merges.length > maxPrs;
  const sha = capped ? merges[maxPrs - 1].sha : input.tip;
  return { cut: true, candidate: {
    id: candidateId(input.now), sha, cutAt: input.now.toISOString(), trigger: input.trigger,
    since: input.promoted ? { id: input.promoted.id, sha: input.promoted.sha } : null,
    from: latest ? { id: latest.id, sha: latest.sha } : null,
    prs: capped ? maxPrs : merges.length, queued: capped ? merges.length - maxPrs : 0,
    items: itemsFromCommits(input.commits.slice(Math.max(0, input.commits.findIndex(commit => commit.sha === sha)))),
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
 * one production already runs is a rollback, which goes through recovery, not promotion. A
 * candidate whose only blockers were flaky required cases is promotable once an evidence decision
 * accepts each of them for its release run at the candidate's exact SHA (GY-1378); an acceptance at
 * any other SHA or run counts for nothing.
 */
export function assessPromotion(candidate: ReleaseCandidate, uat: UatRecord | null, current: ProductionRecord | null, acceptances: readonly FlakyAcceptance[] = []) {
  const refusals: string[] = [];
  if (!uat) refusals.push(`Candidate ${candidate.id} has no UAT validation record; deploy it to UAT and validate it first`);
  else {
    if (uat.sha !== candidate.sha || uat.deployedSha !== candidate.sha) refusals.push(`Candidate ${candidate.id}'s UAT record is for ${uat.deployedSha ?? 'no deployment'}, not its SHA ${candidate.sha}`);
    const flaky = unacceptedFlaky(candidate, uat, acceptances);
    if (flaky?.length) refusals.push(`Candidate ${candidate.id}'s required E2E case${flaky.length > 1 ? 's' : ''} ${flaky.join(', ')} ${flaky.length > 1 ? 'were' : 'was'} flaky at ${candidate.sha} in run ${uat.e2e!.runId}; an evidence decision must accept ${flaky.length > 1 ? 'each' : 'it'} at that exact SHA before promotion`);
    else if (!flaky && uat.result !== 'passed') refusals.push(`Candidate ${candidate.id} failed UAT (${failingSuites(uat).map(suite => suite.name).join(', ')}); cut a newer candidate after the fix`);
  }
  if (current && current.id > candidate.id) refusals.push(`Production already runs newer candidate ${current.id}; an older candidate is a rollback, not a promotion`);
  return { promotable: refusals.length === 0, refusals, sha: candidate.sha, already: current?.sha === candidate.sha };
}

/**
 * For a candidate that failed UAT only because required E2E cases were flaky — the e2e suite the
 * one failing suite, its run bound to the candidate SHA and every blocking case flaky — the flaky
 * cases no acceptance covers (empty when all are accepted); null for any other failure or a pass.
 */
export function unacceptedFlaky(candidate: ReleaseCandidate, uat: UatRecord, acceptances: readonly FlakyAcceptance[] = []): string[] | null {
  const e2e = uat.e2e;
  if (uat.result === 'passed' || !e2e || e2e.sha !== candidate.sha || !e2e.blocking.length) return null;
  if (!failingSuites(uat).every(suite => suite.name === 'e2e') || !e2e.blocking.every(id => e2e.cases.find(entry => entry.case === id)?.verdict === 'flaky')) return null;
  return e2e.blocking.filter(id => !acceptances.some(entry => entry.case === id && entry.runId === e2e.runId && entry.sha === candidate.sha));
}

export const failingSuites = (uat: UatRecord) => uat.suites.filter(suite => !suite.passed);

/**
 * The one follow-up item a failed candidate files. It names the failing suite and the candidate
 * SHA, and lists the deliveries the candidate carried for context only: they stay delivered, and
 * the fix arrives as new work merged to main and carried by a later candidate.
 */
export function followUpItem(candidate: ReleaseCandidate, uat: UatRecord, except: readonly string[] = []) {
  const failing = failingSuites(uat).filter(suite => !except.includes(suite.name));
  if (uat.result !== 'failed' || !failing.length) throw new Error(`Candidate ${candidate.id} did not fail UAT; it files no follow-up`);
  const first = failing[0];
  const carried = candidate.items.length ? candidate.items.map(item => `${item.key} (${item.mergeSha.slice(0, 12)})`).join(', ') : 'no named deliveries';
  return {
    title: `Release candidate ${candidate.id} failed UAT suite ${first.name} at ${candidate.sha.slice(0, 12)}`,
    description: `Release candidate ${candidate.id} at ${candidate.sha} failed UAT. Failing suite${failing.length > 1 ? 's' : ''}: ${failing.map(suite => `${suite.name} — ${suite.detail}`).join('; ')}. `
      + `It carried ${carried}; those deliveries stay delivered and are not reworked. Fix forward on main; the next candidate cut after the fix carries it to UAT.`,
    type: 'bug', priority: 1,
    criteria: [{ id: 'AC-1', text: `The ${first.name} suite that failed on candidate ${candidate.id} (${candidate.sha}) passes against the UAT deployment of a later candidate`, proofs: ['manual:release-candidate-uat-pass'] }],
    policy: { checks: ['test', 'typecheck'], review: true },
  };
}

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

export interface Ledger { candidates: ReleaseCandidate[]; uat: UatRecord[]; production: ProductionRecord[]; soak: SoakRecord[] }
export const readLedger = (git: Git): Ledger => ({
  candidates: readRecords<ReleaseCandidate>(git, candidateTagPrefix),
  uat: readRecords<UatRecord>(git, uatTagPrefix),
  production: readRecords<ProductionRecord>(git, productionTagPrefix),
  soak: readRecords<SoakRecord>(git, soakTagPrefix),
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
 * `null` means the branch was observed absent: the push is leased on that absence, so a branch
 * created in between (a concurrent first deploy) is refused too. Only `undefined` pushes unleased.
 */
export const deployBranch = (git: Git, branch: string, sha: string, expected?: string | null) => {
  assertSha(sha, 'candidate');
  if (expected) assertSha(expected, 'expected branch tip');
  const lease = expected === undefined ? '--force' : `--force-with-lease=refs/heads/${branch}:${expected ?? ''}`;
  git(['push', lease, 'origin', `${sha}:refs/heads/${branch}`]);
};

export function firstParentCommits(git: Git, tip: string, since: string | null): CommitSummary[] {
  const range = since ? [`${since}..${tip}`] : ['--max-count=200', tip];
  const out = git(['log', '--first-parent', '--format=%H%x00%s%x00%b%x1e', ...range]);
  return out.split('\x1e').map(entry => entry.trim()).filter(Boolean).map(entry => { const [sha, subject, body] = entry.split('\0'); return { sha, subject, body: body ?? '' }; });
}

/** Bring the base branch and every ledger tag up to date with the remote. */
export const syncLedger = (git: Git, base: string) => git(['fetch', '--quiet', '--force', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`, '+refs/tags/*:refs/tags/*']);

/** Cut a candidate from the remote base branch's tip, as recorded in the remote's tags. */
export function cut(git: Git, options: { base: string; trigger: CutTrigger; now: Date; push: boolean; maxPrs?: number }) {
  syncLedger(git, options.base);
  const tip = git(['rev-parse', `refs/remotes/origin/${options.base}`]).trim();
  const ledger = readLedger(git);
  const promoted = latestPromoted(ledger), latest = ledger.candidates[0] ?? null;
  const maxPrs = options.maxPrs ?? maxPrsFrom(process.env.GRAPHYARD_RC_MAX_PRS);
  let commits = firstParentCommits(git, tip, promoted?.sha ?? null);
  // Never promoted, the read is bounded to the newest 200: a latest candidate older than that is read up to, so the cap counts from it rather than from the window's edge.
  if (!promoted && latest && !commits.some(commit => commit.sha === latest.sha)) commits = [...firstParentCommits(git, tip, latest.sha), ...firstParentCommits(git, latest.sha, null)];
  const result = cutCandidate({ tip, now: options.now, trigger: options.trigger, latest, promoted, maxPrs, commits });
  if (result.cut) writeRecord(git, `${candidateTagPrefix}${result.candidate.id}`, result.candidate.sha, result.candidate, options.push);
  return result;
}

/** One suite run against the UAT deployment: a check the CLI performs, or a command it starts. */
export interface Suite { name: string; run: (url: string, candidate: ReleaseCandidate) => Promise<SuiteResult> }

/**
 * A command run with `GRAPHYARD_UAT_URL` set to the deployment. It never sees `GRAPHYARD_TOKEN`, the
 * release credential that files a failed candidate's follow-up: only that filing step needs it.
 * A command that knows what failed (the e2e suite names the case and step) writes that to the file
 * `GRAPHYARD_SUITE_DETAIL` names, and it becomes the suite's detail, so the follow-up names it too.
 */
export const commandSuite = (name: string, command: string, timeoutMs = 3_600_000): Suite => ({ name, run: async url => {
  const { GRAPHYARD_TOKEN: _release, ...env } = process.env;
  const scratch = mkdtempSync(join(tmpdir(), 'graphyard-suite-'));
  const detailFile = join(scratch, 'detail');
  try {
    const child = spawnSync('bash', ['-c', command], { stdio: 'inherit', timeout: timeoutMs, env: { ...env, GRAPHYARD_UAT_URL: url, GRAPHYARD_SUITE_DETAIL: detailFile } });
    const passed = child.status === 0;
    const written = existsSync(detailFile) ? readFileSync(detailFile, 'utf8').trim().slice(0, 4000) : '';
    return { name, passed, detail: written || (passed ? `\`${command}\` passed` : `\`${command}\` exited ${child.status ?? child.signal}`) };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
} });

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

/** GY-1481: the zero-touch onboarding scenario, a required suite of every candidate's UAT validation. */
export const zeroTouchScenario = 'tests/zero-touch-onboarding.test.ts';
/**
 * The `zero-touch` suite: the scenario on this checkout of the candidate's SHA, which drives
 * `graphyard up --agent --goal FILE` against an in-process GitHub to a merged first planned item and
 * fails naming any step that needed a person but GitHub's one App approval. That step, or the run's
 * exit, becomes the suite's detail (GRAPHYARD_SUITE_DETAIL), so the candidate's follow-up names it.
 */
export function runZeroTouchSuite(env: NodeJS.ProcessEnv = process.env, run: typeof spawnSync = spawnSync) {
  const child = run(process.execPath, ['--import', 'tsx', 'tests/helpers/run-tests.ts', zeroTouchScenario], { encoding: 'utf8', env, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  process.stdout.write(output);
  const passed = child.status === 0;
  const failure = output.slice(output.indexOf('failing tests')).match(/^\s*((?:AssertionError|Error|TypeError)[^\n]*)/m)?.[1]?.trim();
  const detail = passed ? `${zeroTouchScenario} passed: graphyard up reached a merged first planned item with no human step but GitHub's App approval`
    : `${zeroTouchScenario} failed: ${failure ?? `the run exited ${child.status ?? child.signal}`}`.slice(0, 4000);
  if (env.GRAPHYARD_SUITE_DETAIL) writeFileSync(env.GRAPHYARD_SUITE_DETAIL, `${detail}\n`);
  if (!passed) process.exitCode = 1;
  return { name: 'zero-touch', passed, detail };
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

/** A job's `needs`, inline (`needs: a` / `needs: [a, b]`) or a block sequence of `- a` lines; any other shape throws. */
function jobNeeds(name: string, block: string) {
  const line = /^ {4}needs:[ \t]*(.*)$/m.exec(block);
  if (!line) return [];
  const inline = line[1].replace(/\s+#.*$/, '').trim();
  const needs = inline
    ? (/^\[(.*)\]$/.exec(inline)?.[1] ?? inline).split(',').map(entry => entry.trim())
    : [...block.slice(line.index + line[0].length).matchAll(/\n {4,}- *([^\n]*)/gy)].map(match => match[1].replace(/\s+#.*$/, '').trim());
  if (!needs.length || needs.some(need => !/^[\w-]+$/.test(need))) throw new Error(`Workflow job ${name} has a needs value the UAT validation window cannot read`);
  return needs;
}

/**
 * Pure: the longest a release-candidate workflow can run up to and including its `uat` job — the
 * heaviest `needs` chain of `timeout-minutes` ending there — so a test can hold
 * `uatValidationWindowMs` above it and a timeout that grows fails loudly instead of silently
 * voiding the guard. Reads only the workflow's top-level jobs, their `needs` and `timeout-minutes`.
 */
export function uatValidationCeilingMs(workflow: string, job = 'uat') {
  const jobs = new Map<string, { needs: string[]; minutes: number }>();
  const section = workflow.split(/^jobs:\s*$/m)[1] ?? '';
  for (const block of section.split(/^(?= {2}[\w-]+:\s*$)/m)) {
    const name = /^ {2}([\w-]+):\s*$/m.exec(block)?.[1];
    if (!name) continue;
    const needs = jobNeeds(name, block);
    const minutes = Number(/^ {4}timeout-minutes:\s*(\d+)/m.exec(block)?.[1]);
    if (!Number.isFinite(minutes)) throw new Error(`Workflow job ${name} declares no timeout-minutes, so the UAT validation window cannot bound it`);
    jobs.set(name, { needs, minutes });
  }
  const path = (name: string, seen: string[]): number => {
    const entry = jobs.get(name);
    if (!entry) throw new Error(`Workflow has no job ${name}`);
    if (seen.includes(name)) throw new Error(`Workflow jobs depend on each other in a cycle through ${name}`);
    return entry.minutes + Math.max(0, ...entry.needs.map(need => path(need, [...seen, name])));
  };
  return path(job, []) * 60_000;
}

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

/**
 * The branch's tip on the remote, observed after `syncLedger`, so the two are not one atomic read:
 * a candidate deployed in between is judged against the ledger as fetched. The lease on this tip
 * still refuses to overwrite a branch that moved; with one deployer (the workflow) the gap is moot.
 */
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
 * What a validation's release holds did (src/release-holds.ts, GY-1378): `e2e` is the case verdicts
 * to keep on the record, `covered` the suites whose failure the holds answer (no follow-up names
 * them), and `write` records the hold entries once the UAT record is written.
 */
export interface HoldOutcome { e2e: E2eRecord | null; holds: NonNullable<UatRecord['holds']>; covered: string[]; filingError: string | null; write: () => void }

/**
 * Validate a candidate on UAT and record the verdict once. A failure the release holds attribute to
 * customer outcomes is filed as those holds; any other failing suite files the candidate's one
 * follow-up, keyed by the candidate so a retry never files twice. Both are filed before the record
 * is written; a filing that fails still records the verdict, and `release follow-up` files it later.
 */
export async function validateAndRecord(git: Git, id: string, url: string, suites: readonly Suite[], options: { base: string; push: boolean; timeoutMs: number;
  file?: (item: ReturnType<typeof followUpItem>, requestId: string) => Promise<string>; now?: () => Date; fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void>;
  holds?: (candidate: ReleaseCandidate, record: UatRecord) => Promise<HoldOutcome> }) {
  syncLedger(git, options.base);
  const ledger = readLedger(git);
  const candidate = findCandidate(ledger, id);
  const existing = ledger.uat.find(record => record.id === candidate.id);
  if (existing) throw new Error(`Candidate ${candidate.id} was already validated on UAT (${existing.result} at ${existing.at}); cut a new candidate to validate again`);
  const record = await validate(candidate, url, suites, options);
  let filingError: string | null = null;
  const holds = options.holds ? await options.holds(candidate, record) : null;
  if (holds) { Object.assign(record, { e2e: holds.e2e, holds: holds.holds }); filingError = holds.filingError; }
  if (record.result === 'failed' && options.file && failingSuites(record).some(suite => !holds?.covered.includes(suite.name))) {
    try { record.followUp = await options.file(followUpItem(candidate, record, holds?.covered), followUpRequestId(candidate.id)); }
    catch (error) { filingError = error instanceof Error ? error.message : String(error); }
  }
  writeRecord(git, `${uatTagPrefix}${candidate.id}`, candidate.sha, record, options.push);
  holds?.write();
  return { record, followUp: record.result === 'failed' ? record.followUp ?? null : null, filingError };
}

/** Promote a candidate: `release/production` moves to its exact SHA, only after UAT passed on it. */
export function promote(git: Git, id: string, options: { base: string; push: boolean; now: Date; acceptances?: readonly FlakyAcceptance[] }) {
  syncLedger(git, options.base);
  const ledger = readLedger(git);
  const candidate = findCandidate(ledger, id);
  const assessment = assessPromotion(candidate, ledger.uat.find(record => record.id === candidate.id) ?? null, ledger.production[0] ?? null, options.acceptances);
  if (!assessment.promotable) return { promoted: false as const, candidate: candidate.id, refusals: assessment.refusals };
  deployBranch(git, productionBranch, candidate.sha, ledger.production[0]?.sha);
  if (!ledger.production.some(record => record.id === candidate.id)) writeRecord(git, `${productionTagPrefix}${candidate.id}`, candidate.sha, { id: candidate.id, sha: candidate.sha, at: options.now.toISOString() } satisfies ProductionRecord, options.push);
  return { promoted: true as const, candidate: candidate.id, sha: candidate.sha, branch: productionBranch };
}

/**
 * GY-1513: record the advisory soak's verdict on a candidate as `rc-soak/ID` on its exact SHA: the
 * result, the soak run that produced it and the timing report it uploaded. A candidate's first record
 * stands — a second soak of the same SHA (a re-run) records nothing — and a SHA that is not the
 * candidate's is refused: the verdict belongs to the commit the suites ran against.
 */
export function recordSoak(git: Git, id: string, input: { sha: string; result: SoakRecord['result']; run: string | null; report: string | null; base: string; now: Date; push: boolean }) {
  assertSha(input.sha, 'soaked');
  syncLedger(git, input.base);
  const ledger = readLedger(git);
  const candidate = findCandidate(ledger, id);
  if (candidate.sha !== input.sha) throw new Error(`Candidate ${candidate.id} is ${candidate.sha}, not the soaked ${input.sha}; the verdict is recorded on the candidate it soaked`);
  const existing = ledger.soak.find(record => record.id === candidate.id);
  if (existing) return { recorded: false as const, record: existing };
  const record: SoakRecord = { id: candidate.id, sha: candidate.sha, result: input.result, at: input.now.toISOString(), run: input.run, report: input.report };
  writeRecord(git, `${soakTagPrefix}${candidate.id}`, candidate.sha, record, input.push);
  return { recorded: true as const, record };
}

/** Every candidate with its UAT, advisory soak and production state, newest first. */
export const ledgerStatus = (ledger: Ledger) => ledger.candidates.map(candidate => {
  const uat = ledger.uat.find(record => record.id === candidate.id) ?? null, soak = ledger.soak.find(record => record.id === candidate.id) ?? null;
  return { id: candidate.id, sha: candidate.sha, cutAt: candidate.cutAt, trigger: candidate.trigger, prs: candidate.prs ?? null, queued: candidate.queued ?? null, items: candidate.items.map(item => item.key),
    uat: uat ? { result: uat.result, at: uat.at, failing: failingSuites(uat).map(suite => suite.name), followUp: uat.followUp,
      ...(uat.e2e ? { blocking: uat.e2e.blocking, unrun: uat.e2e.cases.filter(entry => entry.verdict === 'unrun').map(entry => entry.case) } : {}), ...(uat.holds?.length ? { holds: uat.holds } : {}) } : null,
    soak: soak ? { result: soak.result, at: soak.at, run: soak.run, report: soak.report } : null,
    production: ledger.production.find(record => record.id === candidate.id)?.at ?? null };
});
