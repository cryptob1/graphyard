// Concern: the merge preview (GY-1718) — a passing trial merge built and served as a throwaway static site, the repository's required and uat E2E cases run against it before the merge lands.
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../child-runner.js';
import { loadCases } from '../e2e/case.js';
import { releaseVerdict, type E2eLauncher, type E2eReport } from '../e2e/runner.js';
import { docsOnlyPaths, testOnlyPaths } from '../model/policy.js';
import { serveStaticSite, type ReleaseCandidate, type StaticUat } from '../release-candidate.js';
import { buildStaticSite, projectCaseSuite, type StaticBuildShell } from '../release-project.js';
import { readTempOwner, tempOwnerGone, tempOwnerMarker, writeTempOwner } from '../tmp-reclaim.js';

/** The static UAT a managed repository names (`GRAPHYARD_UAT_STATIC`, `GRAPHYARD_UAT_BUILD`, release-ports.ts): its build output in the checkout and the command that builds it. */
export interface PreviewSite { directory: string; build: string | null }
/** The site the loop's environment names, or null when it names no static UAT. */
export const previewSiteOf = (environment: NodeJS.ProcessEnv): PreviewSite | null =>
  environment.GRAPHYARD_UAT_STATIC ? { directory: environment.GRAPHYARD_UAT_STATIC, build: environment.GRAPHYARD_UAT_BUILD || null } : null;

/** One case's result on the preview. */
export interface PreviewCase { case: string; verdict: 'passed' | 'failed' | 'flaky' | 'unrun'; required: boolean }
/**
 * The preview's verdict, recorded with the merge's `trial` record: `pass`, `fail` (a required case
 * failed or was flaky, or the static build failed; `failed` names them) or `timeout`.
 */
export interface PreviewVerdict { result: 'pass' | 'fail' | 'timeout'; mergeSha: string; cases: PreviewCase[]; failed: string[]; detail: string; durationMs: number }

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
  /** The UAT principal's token the cases run with (`GRAPHYARD_UAT_TOKEN`). */
  token: string;
  /** The preview's whole budget: checkout, build, serve and every case. */
  timeoutMs: number;
  run?: ChildRun; shell?: StaticBuildShell; launcher?: E2eLauncher; fetcher?: typeof fetch; stepTimeoutMs?: number; now?: () => number;
  slots?: ReturnType<typeof previewSlots>;
  /** Where the startup sweep reads process liveness; tests point it at a fabricated /proc. */
  procRoot?: string;
}

const cut = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 900);

/**
 * The preview of one passing trial merge: in a free slot (at most `previewConcurrency` at once), a
 * detached checkout of `mergeSha` under `base` marked with this process as its owner, the site's
 * build, its output served on loopback (`serveStaticSite`, answering `mergeSha` on /healthz), and
 * every required and uat case of the checkout run against it (`projectCaseSuite`). Whatever the
 * outcome — pass, fail or the budget running out — the server is closed and the checkout removed
 * before the slot is freed. The first preview of a process sweeps the leftovers of dead ones first.
 */
export async function runPreview(input: PreviewInput): Promise<PreviewVerdict> {
  const now = input.now ?? Date.now, run = input.run ?? defaultChildRun;
  if (!swept.has(input.base)) { swept.add(input.base); await sweepPreviewCheckouts(input.base, { root: input.root, run, procRoot: input.procRoot }); }
  const release = await (input.slots ?? sharedSlots).acquire();
  const startedAt = now();
  const verdict = (result: PreviewVerdict['result'], detail: string, cases: PreviewCase[] = [], failed: string[] = []): PreviewVerdict =>
    ({ result, mergeSha: input.mergeSha, cases, failed, detail: cut(detail), durationMs: Math.max(0, now() - startedAt) });
  let directory: string | null = null, served: StaticUat | null = null, timer: NodeJS.Timeout | undefined, ended = false;
  try {
    directory = await mkdtemp(join(input.base, previewCheckoutPrefix));
    await writeTempOwner(directory);
    const checkout = join(directory, 'checkout');
    const preview = async (): Promise<PreviewVerdict> => {
      await run('git', ['-C', input.root, 'worktree', 'add', '--detach', checkout, input.mergeSha], { timeoutMs: input.timeoutMs });
      if (input.site.build) {
        const failed = await buildStaticSite(input.site.build, checkout, input.timeoutMs, input.shell);
        if (failed) return verdict('fail', failed, [], ['build']);
      }
      const selected = existsSync(join(checkout, 'e2e')) ? (await loadCases(checkout)).filter(entry => entry.definition.required || entry.definition.target === 'uat') : [];
      if (!selected.length) return verdict('pass', 'no required or uat E2E case is in the merge, so the preview exercised nothing');
      served = await serveStaticSite(join(checkout, input.site.directory), input.mergeSha);
      // A server that came up after the budget ran out is closed at once: the cleanup already ran.
      if (ended) { await served.close(); throw new Error('the preview ended before its site was served'); }
      let report: E2eReport | null = null;
      const suite = projectCaseSuite(checkout, input.token, { fetcher: input.fetcher, launcher: input.launcher, stepTimeoutMs: input.stepTimeoutMs, report: value => { report = value; } });
      const result = await suite.run(served.url, { id: `preview-${input.mergeSha.slice(0, 12)}` } as ReleaseCandidate);
      const ran = report as E2eReport | null;
      const cases = (ran?.cases ?? []).map(outcome => ({ case: outcome.id, verdict: outcome.verdict, required: outcome.required }));
      const blocking = ran ? releaseVerdict(ran).blocking.map(outcome => outcome.id) : [];
      return result.passed ? verdict('pass', result.detail, cases) : verdict('fail', result.detail, cases, blocking.length ? blocking : ['e2e']);
    };
    const expired = new Promise<PreviewVerdict>(accept => { timer = setTimeout(() => accept(verdict('timeout', `the preview ran past its ${Math.round(input.timeoutMs / 60_000)}-minute budget`)), input.timeoutMs); });
    const running = preview();
    // Past the budget the run is abandoned; whatever it rejects with later is not the verdict.
    running.catch(() => {});
    return await Promise.race([running, expired]);
  } finally {
    ended = true;
    clearTimeout(timer);
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
 * timeout measures the host, not the merge, so its refusal leaves the head queued to be tried again.
 */
export function previewFailureReason(preview: PreviewVerdict | null | undefined, trialFailurePrefix: string): string | null {
  if (!preview || preview.result === 'pass') return null;
  if (preview.result === 'timeout') return `preview of ${preview.mergeSha.slice(0, 12)} timed out: ${preview.detail}`;
  const named = preview.failed.filter(name => name !== 'e2e' && name !== 'build');
  if (preview.failed.includes('build')) return `${trialFailurePrefix}: preview build: ${preview.detail}`.slice(0, 2000);
  return `${trialFailurePrefix}: E2E ${named.length ? `case${named.length === 1 ? '' : 's'} ${named.slice(0, 20).join(', ')}` : 'cases'} failed on the preview of ${preview.mergeSha.slice(0, 12)}`;
}
