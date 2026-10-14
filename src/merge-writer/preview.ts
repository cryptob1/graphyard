// Concern: the merge preview (GY-1718) — a passing trial merge built and served as a throwaway static site, the repository's required and uat E2E cases run against it before the merge lands.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../child-runner.js';
import { loadCases, type CaseFile } from '../e2e/case.js';
import { releaseVerdict, type E2eLauncher, type E2eReport } from '../e2e/runner.js';
import { docsOnlyPaths, testOnlyPaths } from '../model/policy.js';
import { serveStaticSite, type ReleaseCandidate, type StaticUat } from '../release-candidate.js';
import { hostPassthrough } from '../e2e/steps.js';
import { buildStaticSite, projectCaseSuite, type StaticBuildShell } from '../release-project.js';
import { readTempOwner, tempOwnerGone, tempOwnerMarker, writeTempOwner } from '../tmp-reclaim.js';

/** The static UAT a managed repository names (`GRAPHYARD_UAT_STATIC`, `GRAPHYARD_UAT_BUILD`, release-ports.ts): its build output in the checkout and the command that builds it. */
export interface PreviewSite { directory: string; build: string | null }
/** The site the loop's environment names, or null when it names no static UAT. */
export const previewSiteOf = (environment: NodeJS.ProcessEnv): PreviewSite | null =>
  environment.GRAPHYARD_UAT_STATIC ? { directory: environment.GRAPHYARD_UAT_STATIC, build: environment.GRAPHYARD_UAT_BUILD || null } : null;

/** One case's result on the preview; an `unrun` case names why in `reason` (a declared install secret the preview withholds). */
export interface PreviewCase { case: string; verdict: 'passed' | 'failed' | 'flaky' | 'unrun'; required: boolean; reason?: string }
/**
 * The preview's verdict, recorded with the merge's `trial` record: `pass`, `fail` (a required case
 * failed or was flaky, the merge's cases did not load, or the static build failed; `failed` names
 * them), `timeout`, or `error` (the preview itself could not run: a host failure, not the merge's).
 */
export interface PreviewVerdict { result: 'pass' | 'fail' | 'timeout' | 'error'; mergeSha: string; cases: PreviewCase[]; failed: string[]; detail: string; durationMs: number }

/**
 * Why the merge of `files` needs no preview, or null when it does: the repository names no static
 * UAT, or the merge changes only docs or tests (model/policy.ts's own classes), which cannot change
 * what the site serves. A skipped preview leaves the merge exactly as it was before GY-1718.
 */
export function previewSkip(files: readonly string[], site: PreviewSite | null): string | null {
  if (!site) return 'the repository names no static UAT';
  if (files.length && files.every(path => docsOnlyPaths.test(path) || testOnlyPaths.test(path))) return 'the merge changes only docs or tests';
  return null;
}

/** How many previews run at once on one host. */
export const previewConcurrency = 2;
/** A counting semaphore: `acquire` waits for one of `limit` slots and answers its release. */
export function previewSlots(limit = previewConcurrency) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return {
    get running() { return running; },
    acquire: async (): Promise<() => void> => {
      if (running >= limit) await new Promise<void>(accept => waiting.push(accept));
      else running += 1;
      let released = false;
      // A slot is handed straight to the next waiter, so `running` never dips below a queued demand.
      return () => { if (released) return; released = true; const next = waiting.shift(); if (next) next(); else running -= 1; };
    },
  };
}
const sharedSlots = previewSlots();

/** How a preview checkout's directory under the managed worktree root is named. */
export const previewCheckoutPrefix = 'merge-preview-';
const swept = new Set<string>();

/**
 * The startup sweep: every preview checkout under `base` whose owner process (its `.owner` marker,
 * tmp-reclaim.ts) is gone, removed with its marker, and git's record of the worktree pruned. A
 * directory with no marker, or one whose owner still runs, is left alone. Answers the removed paths.
 */
export async function sweepPreviewCheckouts(base: string, options: { root?: string; run?: ChildRun; procRoot?: string } = {}): Promise<string[]> {
  let names: string[];
  try { names = await readdir(base); } catch { return []; }
  const removed: string[] = [];
  for (const name of names.filter(entry => entry.startsWith(previewCheckoutPrefix) && !entry.endsWith('.owner')).sort()) {
    const directory = join(base, name), owner = await readTempOwner(directory);
    if (!owner || !tempOwnerGone(owner, options.procRoot)) continue;
    await rm(directory, { recursive: true, force: true });
    await rm(tempOwnerMarker(directory), { force: true });
    removed.push(directory);
  }
  if (removed.length && options.root) { try { await (options.run ?? defaultChildRun)('git', ['-C', options.root, 'worktree', 'prune']); } catch { /* the next prune settles it */ } }
  return removed;
}

export interface PreviewInput {
  /** The coordinator checkout whose object store holds the merge commit. */
  root: string;
  /** The managed worktree root the preview checkout is made under. */
  base: string;
  mergeSha: string;
  site: PreviewSite;
  /** The preview's whole budget: checkout, build, serve and every case. */
  timeoutMs: number;
  run?: ChildRun; shell?: StaticBuildShell; launcher?: E2eLauncher; fetcher?: typeof fetch; stepTimeoutMs?: number; now?: () => number;
  slots?: ReturnType<typeof previewSlots>;
  /** Where the startup sweep reads process liveness; tests point it at a fabricated /proc. */
  procRoot?: string;
  /** The host environment the build's basics are drawn from; tests substitute it. */
  hostEnvironment?: NodeJS.ProcessEnv;
}

/** Host variables a preview's processes never get: the coordinator's runtime directory and display, whose sockets (a session bus, an agent, a keyring) answer as the coordinator. */
const previewWithheldHost = new Set(['HOME', 'XDG_RUNTIME_DIR', 'DISPLAY']);
/**
 * The environment every process the merge brings in runs in — its build and its command and agent
 * cases: the host basics a command needs (e2e/steps.ts's `hostPassthrough`) with `home`, a fresh
 * empty directory of the preview, as HOME and every XDG base directory, and nothing else. So a
 * script the merge brings in reads no coordinator credential: no token variable
 * (`GRAPHYARD_UAT_TOKEN`, GitHub or Graphyard tokens), no file found through HOME or XDG (such as
 * `~/.config/graphyard/`), and no socket under the coordinator's XDG_RUNTIME_DIR. Playwright's
 * browsers are still found where the host keeps them.
 */
export function previewEnvironment(home: string, host: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of hostPassthrough) if (host[name] !== undefined && !previewWithheldHost.has(name)) env[name] = host[name]!;
  if (!env.PLAYWRIGHT_BROWSERS_PATH && host.HOME) env.PLAYWRIGHT_BROWSERS_PATH = join(host.HOME, '.cache', 'ms-playwright');
  return { ...env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), TMPDIR: join(home, 'tmp') };
}

/** The longest reason a preview case records (src/model/merge-ledger.ts `previewVerdictSchema`). */
export const previewReasonLimit = 500;
/** The cases a preview judges: every required or uat case of the merge. */
export const previewCase = (entry: CaseFile) => entry.definition.required || entry.definition.target === 'uat';
/**
 * Why a selected case is not run on the preview, or null when it runs: it declares an install
 * secret. The cases come from the merge the preview exists to judge, so none may read the install's
 * `e2e-secrets.uat.env`; such a uat-only case is recorded `unrun` with this reason and runs on the
 * release candidate instead (GY-1535), while a required one fails the preview.
 */
export function previewWithheld(entry: CaseFile): string | null {
  const secrets = entry.definition.secrets;
  if (!secrets.length) return null;
  // The reason is recorded on the trial (previewVerdictSchema caps it at `previewReasonLimit`), so a list of names too long for it names as many as fit and counts the rest.
  const head = `declares the install secret${secrets.length === 1 ? '' : 's'} `, tail = ', which the preview withholds; it runs on the release candidate';
  let named = secrets.join(', ');
  for (let shown = secrets.length - 1; head.length + named.length + tail.length > previewReasonLimit && shown >= 0; shown--)
    named = `${secrets.slice(0, shown).map(name => `${name}, `).join('')}and ${secrets.length - shown} more`;
  return `${head}${named}${tail}`.slice(0, previewReasonLimit);
}

const cut = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 900);

/**
 * The preview of one passing trial merge: in a free slot (at most `previewConcurrency` at once), a
 * detached checkout of `mergeSha` under `base` marked with this process as its owner, the site's
 * build, its output served on loopback (`serveStaticSite`, answering `mergeSha` on /healthz), and
 * every required and uat case of the checkout (`previewCase`), loaded before the build runs and kept, run against it (`projectCaseSuite`),
 * those declaring an install secret not run (`previewWithheld`): a required one fails the preview
 * naming it, a uat-only one is recorded unrun; with no case left to run the preview fails, having exercised nothing. The build and the cases'
 * processes run in `previewEnvironment` (a throwaway HOME, no coordinator credential or socket) and
 * the cases with a throwaway token, since all come from the merge the preview exists to judge. When the budget
 * runs out the run is cancelled — the build's shell killed, the case runner's requests aborted and
 * its browser and step processes killed, no further step started — and awaited until it has ended; only then, whatever
 * the outcome, is the server closed, the checkout removed and the slot freed, so no work of an
 * ended preview outlives its slot. The first preview of a process sweeps the leftovers of dead ones first.
 */
export async function runPreview(input: PreviewInput): Promise<PreviewVerdict> {
  const now = input.now ?? Date.now, run = input.run ?? defaultChildRun;
  if (!swept.has(input.base)) { swept.add(input.base); await sweepPreviewCheckouts(input.base, { root: input.root, run, procRoot: input.procRoot }); }
  const release = await (input.slots ?? sharedSlots).acquire();
  const startedAt = now();
  const verdict = (result: PreviewVerdict['result'], detail: string, cases: PreviewCase[] = [], failed: string[] = []): PreviewVerdict =>
    ({ result, mergeSha: input.mergeSha, cases, failed, detail: cut(detail), durationMs: Math.max(0, now() - startedAt) });
  const cancel = new AbortController(), signal = cancel.signal;
  const cancelled = () => { if (signal.aborted) throw new Error('the preview was cancelled'); };
  let directory: string | null = null, served: StaticUat | null = null, timer: NodeJS.Timeout | undefined, running: Promise<PreviewVerdict> | null = null;
  try {
    directory = await mkdtemp(join(input.base, previewCheckoutPrefix));
    await writeTempOwner(directory);
    const checkout = join(directory, 'checkout');
    const preview = async (): Promise<PreviewVerdict> => {
      await run('git', ['-C', input.root, 'worktree', 'add', '--detach', checkout, input.mergeSha], { timeoutMs: input.timeoutMs });
      cancelled();
      // The case files are the merge's own, loaded and kept before any of its code runs: the build cannot add, erase or rewrite a case the preview then judges. One that does not load fails the preview as a failing case would, naming why.
      let selected: CaseFile[] = [];
      try { selected = existsSync(join(checkout, 'e2e')) ? (await loadCases(checkout)).filter(previewCase) : []; }
      catch (error) { return verdict('fail', `the merge's E2E cases do not load: ${error instanceof Error ? error.message : String(error)}`, [], ['cases']); }
      const withheld = selected.flatMap(entry => { const reason = previewWithheld(entry); return reason ? [{ case: entry.definition.id, verdict: 'unrun' as PreviewCase['verdict'], required: entry.definition.required, reason }] : []; });
      // A required case the preview cannot run fails it, naming the case: no merge lands without running every required case. A uat-only one stays informational.
      const unrunRequired = withheld.filter(entry => entry.required);
      if (unrunRequired.length) return verdict('fail', `required E2E case${unrunRequired.length === 1 ? '' : 's'} ${unrunRequired.map(entry => entry.case).join(', ')} declare${unrunRequired.length === 1 ? 's' : ''} an install secret the preview withholds, so the preview cannot run ${unrunRequired.length === 1 ? 'it' : 'them'} and refuses the merge`,
        withheld.map(entry => entry.required ? { ...entry, verdict: 'failed' as const } : entry), unrunRequired.map(entry => entry.case));
      const runnable = selected.filter(entry => !previewWithheld(entry));
      const unrun = withheld.length ? `; not run on the preview, each declaring an install secret it withholds: ${withheld.map(entry => entry.case).join(', ')}` : '';
      // A preview that runs no case served and tested nothing, so it refuses the merge, as the E2E suite refuses an empty selection: deleting every case never lands a change unexercised.
      if (!runnable.length) return verdict('fail', `no required or uat E2E case the preview can run is in the merge, so it exercised nothing${unrun}`, withheld, ['cases']);
      const home = join(directory!, 'home'), environment = previewEnvironment(home, input.hostEnvironment);
      await mkdir(environment.TMPDIR, { recursive: true });
      if (input.site.build) {
        const failed = await buildStaticSite(input.site.build, checkout, input.timeoutMs, input.shell, signal, environment);
        cancelled();
        if (failed) return verdict('fail', failed, [], ['build']);
      }
      cancelled();
      served = await serveStaticSite(join(checkout, input.site.directory), input.mergeSha);
      let report: E2eReport | null = null;
      // The cases come from the merge itself, so they run with a token minted for this preview, never the UAT principal's, and never read the install's secrets; the runner keeps their requests on the served origin.
      const suite = projectCaseSuite(checkout, `preview-${randomUUID()}`, { fetcher: input.fetcher, launcher: input.launcher, stepTimeoutMs: input.stepTimeoutMs, signal, hostEnvironment: environment,
        cases: runnable, select: () => true, withholdSecrets: true, report: value => { report = value; } });
      const result = await suite.run(served.url, { id: `preview-${input.mergeSha.slice(0, 12)}` } as ReleaseCandidate);
      cancelled();
      const ran = report as E2eReport | null;
      const cases = [...(ran?.cases ?? []).map(outcome => ({ case: outcome.id, verdict: outcome.verdict, required: outcome.required })), ...withheld];
      const blocking = ran ? releaseVerdict(ran).blocking.map(outcome => outcome.id) : [];
      return result.passed ? verdict('pass', `${result.detail}${unrun}`, cases) : verdict('fail', `${result.detail}${unrun}`, cases, blocking.length ? blocking : ['e2e']);
    };
    const expired = new Promise<'expired'>(accept => { timer = setTimeout(() => accept('expired'), input.timeoutMs); });
    running = preview();
    const first = await Promise.race([running, expired]);
    if (first !== 'expired') return first;
    // Past the budget: the run is cancelled, and its slot is not freed until it has ended (finally).
    cancel.abort();
    return verdict('timeout', `the preview ran past its ${Math.round(input.timeoutMs / 60_000)}-minute budget`);
  } finally {
    clearTimeout(timer);
    cancel.abort();
    if (running) await running.catch(() => null);
    try { await (served as StaticUat | null)?.close(); } catch { /* the server is gone either way */ }
    if (directory) {
      try { await run('git', ['-C', input.root, 'worktree', 'remove', '--force', join(directory, 'checkout')]); } catch { /* removed below; the next prune forgets it */ }
      await rm(directory, { recursive: true, force: true });
      await rm(tempOwnerMarker(directory), { force: true });
    }
    release();
  }
}

/**
 * The refusal a preview's verdict records, or null when it passed. A failing required case refuses
 * the merge as a failed trial does (`trial failed: …`, which grounds the rework, GY-1524); a
 * timeout or an error measures the host, not the merge, so its refusal leaves the head queued to be
 * tried again.
 */
export function previewFailureReason(preview: PreviewVerdict | null | undefined, trialFailurePrefix: string): string | null {
  if (!preview || preview.result === 'pass') return null;
  if (preview.result === 'timeout') return `preview of ${preview.mergeSha.slice(0, 12)} timed out: ${preview.detail}`.slice(0, 2000);
  if (preview.result === 'error') return `preview of ${preview.mergeSha.slice(0, 12)} could not run: ${preview.detail}`.slice(0, 2000);
  const named = preview.failed.filter(name => name !== 'e2e' && name !== 'build' && name !== 'cases');
  if (preview.failed.includes('build')) return `${trialFailurePrefix}: preview build: ${preview.detail}`.slice(0, 2000);
  if (preview.failed.includes('cases')) return `${trialFailurePrefix}: preview: ${preview.detail}`.slice(0, 2000);
  return `${trialFailurePrefix}: E2E ${named.length ? `case${named.length === 1 ? '' : 's'} ${named.slice(0, 20).join(', ')}` : 'cases'} failed on the preview of ${preview.mergeSha.slice(0, 12)}`.slice(0, 2000);
}
