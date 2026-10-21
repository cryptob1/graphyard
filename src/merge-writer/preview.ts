// Concern: the merge preview (GY-1718) — a passing trial merge built and served as a throwaway static site, the repository's required and uat E2E cases run against it before the merge lands.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { defaultChildRun, type ChildRun } from '../child-runner.js';
import { loadCases, type CaseFile } from '../e2e/case.js';
import { releaseVerdict, type E2eLauncher, type E2eReport } from '../e2e/runner.js';
import { docsOnlyPaths, testOnlyPaths } from '../model/policy.js';
import { hostPassthrough } from '../e2e/steps.js';
import { buildStaticSite, projectCaseSuite, type StaticBuildShell } from '../release-project.js';
import { composeBounds, composeLeftovers, composeProjectName, composeStack, dockerEnvironment, snapshotComposeSite, sweepComposePreviews, type ComposeBounds, type Docker } from '../compose-preview.js';
import { previewDatabase, previewDemand, previewEnded, previewEndReason, previewInstance, previewPath, previewSiteByteLimit, previewSiteFileLimit, previewSitePathSchema, type ItemPreview, type PreviewCaseResult, type PreviewEndReason, type PreviewSiteFile } from '../project-previews.js';
import type { Application, ProjectDelivery } from '../project-applications.js';
import type { Work } from '../model/work.js';
import { heldEntries, heldOpenPaths, readTempOwner, tempOwnerGone, tempOwnerJudgeable, tempOwnerMarker, tmpReclaimMinAgeMs, treeLastWritten, writeTempOwner } from '../tmp-reclaim.js';

/** The static UAT a managed repository names (`GRAPHYARD_UAT_STATIC`, `GRAPHYARD_UAT_BUILD`): its build output in the checkout and the command that builds it. */
export interface PreviewSite { directory: string; build: string | null }
/** The site the loop's environment names, or null when it names no static UAT. */
export const previewSiteOf = (environment: NodeJS.ProcessEnv): PreviewSite | null =>
  environment.GRAPHYARD_UAT_STATIC ? { directory: environment.GRAPHYARD_UAT_STATIC, build: environment.GRAPHYARD_UAT_BUILD || null } : null;

/** What the loopback static site serves each extension as; anything else is application/octet-stream. */
const staticTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};
export interface StaticUat { url: string; close(): Promise<void> }

/**
 * GY-1535: a static site's build output `directory` served on loopback, so its cases drive it in a
 * browser like any deployment. `/healthz` answers `sha` as `commit`; a directory serves its
 * `index.html`; nothing outside `directory` is ever read, and a missing build output answers 404
 * rather than failing the server. Only GET and HEAD are answered.
 */
export async function serveStaticSite(directory: string, sha: string): Promise<StaticUat> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`static UAT must be a full 40-character commit SHA, got ${JSON.stringify(sha)}`);
  const root = resolve(directory);
  const inside = (path: string) => path === root || path.startsWith(`${root}${sep}`);
  const server = createServer(async (request, response) => {
    const send = (status: number, type: string, body: string | Buffer) => { response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(request.method === 'HEAD' ? undefined : body); };
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(405, 'text/plain; charset=utf-8', 'Method not allowed\n');
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://uat.invalid').pathname); } catch { return send(400, 'text/plain; charset=utf-8', 'Bad path\n'); }
    if (pathname === '/healthz') return send(200, 'application/json', JSON.stringify({ ok: true, commit: sha }));
    let path = resolve(root, `.${pathname}`);
    if (!inside(path)) return send(404, 'text/plain; charset=utf-8', 'Not found\n');
    try {
      if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
      // A symbolic link out of the build output is not served.
      const real = await realpath(path), realRoot = await realpath(root);
      if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) return send(404, 'text/plain; charset=utf-8', 'Not found\n');
      return send(200, staticTypes[extname(path).toLowerCase()] ?? 'application/octet-stream', await readFile(path));
    } catch { return send(404, 'text/plain; charset=utf-8', 'Not found\n'); }
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => accept()); });
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(accept => { server.closeAllConnections?.(); server.close(() => accept()); }) };
}

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
 * directory with no marker, or one whose owner still runs, is left alone. A marker this reader
 * cannot judge by pid — another PID namespace's, or one recorded before namespaces were kept
 * (GY-1896) — is judged as an ownerless directory is (reclaimRoot): kept while younger than
 * `tmpReclaimMinAgeMs`, so a live writer in a sandbox this reader cannot see outlives the sweep,
 * and removed once older and nothing live holds it, so a crashed preview's or an upgrade's
 * leftovers do not sit under the managed worktree root forever, which the /tmp reclaim pass never
 * scans. Answers the removed paths.
 */
export async function sweepPreviewCheckouts(base: string, options: { root?: string; run?: ChildRun; procRoot?: string } = {}): Promise<string[]> {
  let names: string[];
  try { names = await readdir(base); } catch { return []; }
  const removed: string[] = [], procRoot = options.procRoot ?? '/proc';
  // The holder census runs once, and only when an unjudgeable marker's checkout reaches its age
  // bound: a sweep that judges every marker by pid never pays for it.
  let held: Set<string> | null = null, realBase: string | null = null;
  const holders = async () => {
    if (held) return held;
    const all = await heldOpenPaths(procRoot);
    realBase = await realpath(base).catch(() => base);
    // /proc names a holder by its resolved path, so a base reached through a symlink is matched by
    // its realpath; a command line names the path as it was typed, so its own spelling matches too.
    return held = new Set([...heldEntries(realBase, all), ...(realBase === base ? [] : heldEntries(base, all))]);
  };
  for (const name of names.filter(entry => entry.startsWith(previewCheckoutPrefix) && !entry.endsWith('.owner')).sort()) {
    const directory = join(base, name), owner = await readTempOwner(directory);
    if (!owner) continue;
    const gone = tempOwnerGone(owner, procRoot);
    // A live owner this reader can judge keeps its checkout, as before. A marker it cannot judge —
    // another namespace's, or a pre-namespace one — goes only as an ownerless directory would.
    if (!gone && tempOwnerJudgeable(owner, procRoot)) continue;
    if (!gone) {
      const info = await lstat(directory).catch(() => null);
      if (!info) continue;
      if (Date.now() - await treeLastWritten(directory, info.mtimeMs) < tmpReclaimMinAgeMs) continue;
      // Match both spellings, as reclaimRoot does: heldEntries under realpath records the resolved
      // candidate, while the sweep walks join(base, name) through a symlink (GY-1896 review).
      const open = await holders();
      if (open.has(directory) || open.has(join(realBase!, name))) continue;
    }
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
  /** GY-1903: a declared Compose application to bring up instead of building and serving `site`, under its own project, bounded. */
  compose?: { application: Extract<Application, { kind: 'compose' }>; project: string; bounds: ComposeBounds; docker?: Docker };
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

/** What an item preview (GY-1902) adds to a merge's: the declared cases it runs, the variables its build reads, and the signal that cancels it. */
export interface PreviewOptions {
  /** The case ids to run, every one mandatory; absent, the merge's required and uat cases (`previewCase`). */
  cases?: readonly string[];
  /** Variables beside `previewEnvironment` for the build and the cases: what the change is (never a credential). */
  variables?: Record<string, string>;
  /** Cancels the preview from outside, as its budget running out does. */
  signal?: AbortSignal;
}
/** What serves a preview while it runs: the static site's server, or the Compose project (compose-preview.ts). */
type Served = { url: string | null; close(): Promise<void> };
/** A preview that passed and is still served: its loopback origin, the built site's directory it serves (or, for a Compose application, `publish`, its served pages, given up once `signal` aborts), and `close`, which ends the server and removes the checkout. */
export interface OpenedPreview { verdict: PreviewVerdict; url: string | null; site?: string | null; publish?: (signal?: AbortSignal) => Promise<PreviewSiteFile[]>; close(): Promise<void> }

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
  const opened = await openPreview(input, { keep: false });
  return opened.verdict;
}

/**
 * `runPreview`'s work, keeping a passing preview served when `keep` is set (GY-1902): its slot is
 * freed once its cases ran, while its server and checkout stay until `close`. Every other outcome —
 * a failure, a timeout, a cancellation through `signal` — is cleaned up before this answers.
 */
export async function openPreview(input: PreviewInput, options: PreviewOptions & { keep: boolean }): Promise<OpenedPreview> {
  const now = input.now ?? Date.now, run = input.run ?? defaultChildRun;
  if (!swept.has(input.base)) { swept.add(input.base); await sweepPreviewCheckouts(input.base, { root: input.root, run, procRoot: input.procRoot }); }
  const release = await (input.slots ?? sharedSlots).acquire();
  const startedAt = now();
  const verdict = (result: PreviewVerdict['result'], detail: string, cases: PreviewCase[] = [], failed: string[] = []): PreviewVerdict =>
    ({ result, mergeSha: input.mergeSha, cases, failed, detail: cut(detail), durationMs: Math.max(0, now() - startedAt) });
  const cancel = new AbortController(), signal = cancel.signal;
  const external = () => cancel.abort();
  options.signal?.addEventListener('abort', external, { once: true });
  const cancelled = () => { if (signal.aborted) throw new Error('the preview was cancelled'); };
  // A declared case is mandatory whatever its own flags say: the item's criteria name it.
  const mandatory = (entry: CaseFile) => options.cases ? true : entry.definition.required;
  let directory: string | null = null, served = null as Served | null, timer: NodeJS.Timeout | undefined, running: Promise<PreviewVerdict> | null = null;
  let closed: Promise<void> | null = null, outcome: PreviewVerdict | null = null;
  // A Compose project that could not be removed rejects close (after the checkout goes), and the next close tries it again.
  const close = () => closed ??= (async () => {
    let left: unknown = null;
    try { await (served as Served | null)?.close(); } catch (error) { if (input.compose) left = error; /* a static server is gone either way */ }
    if (directory) {
      try { await run('git', ['-C', input.root, 'worktree', 'remove', '--force', join(directory, 'checkout')]); } catch { /* removed below; the next prune forgets it */ }
      await rm(directory, { recursive: true, force: true });
      await rm(tempOwnerMarker(directory), { force: true });
      directory = null;
    }
    if (left) throw left;
  })().catch(error => { closed = null; throw error; });
  try {
    if (options.signal?.aborted) return { verdict: outcome = verdict('error', 'the preview was cancelled before it started'), url: null, close };
    directory = await mkdtemp(join(input.base, previewCheckoutPrefix));
    await writeTempOwner(directory);
    const checkout = join(directory, 'checkout');
    const preview = async (): Promise<PreviewVerdict> => {
      await run('git', ['-C', input.root, 'worktree', 'add', '--detach', checkout, input.mergeSha], { timeoutMs: input.timeoutMs });
      cancelled();
      // The case files are the merge's own, loaded and kept before any of its code runs: the build cannot add, erase or rewrite a case the preview then judges. One that does not load fails the preview as a failing case would, naming why.
      let selected: CaseFile[] = [];
      try { selected = existsSync(join(checkout, 'e2e')) ? (await loadCases(checkout)).filter(entry => options.cases ? options.cases.includes(entry.definition.id) : previewCase(entry)) : []; }
      catch (error) { return verdict('fail', `the merge's E2E cases do not load: ${error instanceof Error ? error.message : String(error)}`, [], ['cases']); }
      const missing = (options.cases ?? []).filter(id => !selected.some(entry => entry.definition.id === id));
      if (missing.length) return verdict('fail', `the declared case${missing.length === 1 ? '' : 's'} ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the change's e2e/cases`, missing.map(id => ({ case: id, verdict: 'failed' as const, required: true, reason: 'not in the change' })), missing);
      const withheld = selected.flatMap(entry => { const reason = previewWithheld(entry); return reason ? [{ case: entry.definition.id, verdict: 'unrun' as PreviewCase['verdict'], required: mandatory(entry), reason }] : []; });
      // A required case the preview cannot run fails it, naming the case: no merge lands without running every required case. A uat-only one stays informational.
      const unrunRequired = withheld.filter(entry => entry.required);
      if (unrunRequired.length) return verdict('fail', `required E2E case${unrunRequired.length === 1 ? '' : 's'} ${unrunRequired.map(entry => entry.case).join(', ')} declare${unrunRequired.length === 1 ? 's' : ''} an install secret the preview withholds, so the preview cannot run ${unrunRequired.length === 1 ? 'it' : 'them'} and refuses the merge`,
        withheld.map(entry => entry.required ? { ...entry, verdict: 'failed' as const } : entry), unrunRequired.map(entry => entry.case));
      const runnable = selected.filter(entry => !previewWithheld(entry));
      const unrun = withheld.length ? `; not run on the preview, each declaring an install secret it withholds: ${withheld.map(entry => entry.case).join(', ')}` : '';
      // A preview that runs no case served and tested nothing, so it refuses the merge, as the E2E suite refuses an empty selection: deleting every case never lands a change unexercised.
      if (!runnable.length) return verdict('fail', `no required or uat E2E case the preview can run is in the merge, so it exercised nothing${unrun}`, withheld, ['cases']);
      const home = join(directory!, 'home'), environment = { ...previewEnvironment(home, input.hostEnvironment), ...options.variables };
      await mkdir(environment.TMPDIR, { recursive: true });
      let origin: string;
      if (input.compose) {
        // The Compose project is closed with the preview whatever happened while it came up: `served` holds it before it starts.
        const { application, project, bounds, docker } = input.compose;
        const stack = composeStack({ checkout, file: application.file, service: application.service, port: application.port, project, bounds, docker, fetcher: input.fetcher,
          environment: dockerEnvironment(environment, input.hostEnvironment ?? process.env), variables: options.variables ?? {}, scratch: join(directory!, 'compose') });
        served = stack;
        try { origin = await stack.start(signal, input.timeoutMs); } catch (error) { cancelled(); return verdict('fail', `the Compose application did not start: ${error instanceof Error ? error.message : String(error)}`, [], ['build']); }
      } else {
        if (input.site.build) {
          const failed = await buildStaticSite(input.site.build, checkout, input.timeoutMs, input.shell, signal, environment);
          cancelled();
          if (failed) return verdict('fail', failed, [], ['build']);
        }
        cancelled();
        served = await serveStaticSite(join(checkout, input.site.directory), input.mergeSha);
        origin = served.url!;
      }
      cancelled();
      let report: E2eReport | null = null;
      // The cases come from the merge itself, so they run with a token minted for this preview, never the UAT principal's, and never read the install's secrets; the runner keeps their requests on the served origin.
      const suite = projectCaseSuite(checkout, `preview-${randomUUID()}`, { fetcher: input.fetcher, launcher: input.launcher, stepTimeoutMs: input.stepTimeoutMs, signal, hostEnvironment: environment,
        cases: runnable, select: () => true, withholdSecrets: true, report: value => { report = value; } });
      const result = await suite.run(origin, { id: `preview-${input.mergeSha.slice(0, 12)}` });
      cancelled();
      const ran = report as E2eReport | null;
      const cases = [...(ran?.cases ?? []).map(outcome => ({ case: outcome.id, verdict: outcome.verdict, required: options.cases ? true : outcome.required })), ...withheld];
      const blocking = ran ? (options.cases ? ran.cases.filter(entry => entry.verdict !== 'passed') : releaseVerdict(ran).blocking).map(outcome => outcome.id) : [];
      const passed = options.cases ? result.passed && !!ran && ran.cases.length === runnable.length && !blocking.length : result.passed;
      return passed ? verdict('pass', `${result.detail}${unrun}`, cases) : verdict('fail', `${result.detail}${unrun}`, cases, blocking.length ? blocking : ['e2e']);
    };
    const expired = new Promise<'expired'>(accept => { timer = setTimeout(() => accept('expired'), input.timeoutMs); });
    const stopped = new Promise<'stopped'>(accept => signal.addEventListener('abort', () => accept('stopped'), { once: true }));
    running = preview();
    const first = await Promise.race([running, expired, stopped]);
    if (first === 'stopped') return { verdict: outcome = verdict('error', 'the preview was cancelled'), url: null, close };
    const url = (served as Served | null)?.url ?? null;
    if (first !== 'expired') return { verdict: outcome = first, url, site: served && !input.compose ? join(directory, 'checkout', input.site.directory) : null, ...(input.compose && url ? { publish: (signal?: AbortSignal) => snapshotComposeSite(url, input.fetcher, signal) } : {}), close };
    // Past the budget: the run is cancelled, and its slot is not freed until it has ended (finally).
    cancel.abort();
    return { verdict: outcome = verdict('timeout', `the preview ran past its ${Math.round(input.timeoutMs / 60_000)}-minute budget`), url: null, close };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', external);
    const kept = options.keep && outcome?.result === 'pass' && !signal.aborted;
    if (!kept) cancel.abort();
    if (running) await running.catch(() => null);
    // A Compose project left behind here is removed by the caller's own close, which retries it.
    if (!kept) await close().catch(() => {});
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

// ---- Item previews (GY-1902) ------------------------------------------------------------------------

/** One preview this process serves (or is still starting) for an item. */
export interface LivePreview {
  key: string; work: string; record: ItemPreview;
  /** The opened preview once it settled; null while it starts. */
  opened: OpenedPreview | null;
  stop: AbortController;
  /** Set once it is being ended: why, and whether its cleaned record reached the server. */
  ending: PreviewEndReason | null;
  /** Records the server has not confirmed yet, oldest first, a running one with its built site; retried each step. */
  owed: { record: ItemPreview; site?: PreviewSiteFile[] }[];
  failures: number;
  /** GY-1903: the Compose project serving it, when its application is a Compose one. */
  compose?: string;
}
/** What the step reads and writes: the loop's delivery declaration, its checkout and the server. */
export interface ItemPreviewPorts {
  root: string; base: string; timeoutMs: number;
  delivery(): ProjectDelivery | null;
  /** The base branch's tip, previewed for an item that has no submitted head yet. */
  baseTip(): Promise<string>;
  /** Writes the record on the item (`POST /api/work/:id/merge-record`, kind `preview`), a running one publishing its built `site`. */
  record(item: { id: string; key: string }, preview: ItemPreview, site?: PreviewSiteFile[]): Promise<unknown>;
  run?: ChildRun; shell?: StaticBuildShell; launcher?: E2eLauncher; fetcher?: typeof fetch; stepTimeoutMs?: number; hostEnvironment?: NodeJS.ProcessEnv; now?: () => number;
  slots?: ReturnType<typeof previewSlots>; procRoot?: string;
  open?: typeof openPreview;
  docker?: Docker;
}
/** Whether this process swept abandoned Compose previews yet (GY-1903): once, before its first. */
let composeSwept = false;
/**
 * How many sends in a row an unconfirmed record may fail before its preview stops serving. A record
 * is never dropped: its server and checkout are then removed and a terminal record (`unconfirmed`)
 * replaces any running one, owed, in order, behind the starting record the server may still lack,
 * until the server confirms it or shows the preview already ended.
 */
export const previewRecordAttempts = 10;

/** Sends what `entry` owes, oldest first, stopping at the first that fails. */
async function settleRecords(entry: LivePreview, ports: ItemPreviewPorts) {
  while (entry.owed.length) {
    try { await ports.record({ id: entry.work, key: entry.key }, entry.owed[0]!.record, entry.owed[0]!.site); entry.owed.shift(); entry.failures = 0; }
    catch (error) {
      if (++entry.failures >= previewRecordAttempts && !entry.ending) await abandon(entry, error, ports);
      return false;
    }
  }
  return true;
}
/** The record of `record` ended: cleaned, unless it already ended, naming when and why. */
const endedRecord = (record: ItemPreview, reason: PreviewEndReason, detail: string, at: string): ItemPreview =>
  ({ ...record, state: previewEnded(record) ? record.state : 'cleaned', origin: null, cleanedAt: record.cleanedAt ?? at, endReason: record.endReason ?? reason, detail: cut(detail) });
/**
 * Stops a preview the server has not confirmed for `previewRecordAttempts` sends: one still starting
 * is cancelled and settles `unconfirmed` once stopped (`start`); a served one's server and checkout
 * are removed at once, and its unconfirmed running record, never published now, gives way to its
 * cleaned one, which keeps its case results.
 */
async function abandon(entry: LivePreview, error: unknown, ports: Pick<ItemPreviewPorts, 'now'>) {
  entry.ending = 'unconfirmed';
  entry.stop.abort();
  console.error(`The server has not confirmed ${entry.key}'s preview record (${entry.owed[0]!.record.state}) after ${entry.failures} sends, so the preview stops serving: ${error instanceof Error ? error.message : String(error)}`);
  if (!entry.opened || previewEnded(entry.record)) return;
  // Not removed yet: the step's `end` retries it, and records it cleaned only once it is.
  try { await entry.opened.close(); } catch (error) { console.error(`${entry.key}'s preview was not removed, retried next step: ${error instanceof Error ? error.message : String(error)}`); return; }
  entry.owed = entry.owed.filter(owed => owed.record.state === 'starting');
  owe(entry, endedRecord(entry.record, 'unconfirmed', `${entry.record.detail ? `${entry.record.detail}; ` : ''}ended: the server did not confirm it`, new Date((ports.now ?? Date.now)()).toISOString()));
}
const owe = (entry: LivePreview, record: ItemPreview, site?: PreviewSiteFile[]) => { entry.record = record; entry.owed.push(site ? { record, site } : { record }); };

const mediaTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
/**
 * The built site under `directory` as a preview publishes it (GY-1902): every regular file, by its
 * path under the site, media type and content. A symbolic link is never followed, so nothing outside
 * the build output is published. A site past `previewSiteFileLimit` files or `previewSiteByteLimit`
 * bytes, or naming a file no link can address, is refused, naming why.
 */
export async function readPreviewSite(directory: string): Promise<PreviewSiteFile[]> {
  const files: PreviewSiteFile[] = [];
  let bytes = 0;
  const walk = async (relative: string) => {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) continue;
      if (!previewSitePathSchema.safeParse(path).success) throw new Error(`the built site's file ${JSON.stringify(path)} has no path the preview link can serve`);
      if (files.length >= previewSiteFileLimit) throw new Error(`the built site has more than ${previewSiteFileLimit} files, more than a preview publishes`);
      const content = await readFile(join(directory, path));
      if ((bytes += content.length) > previewSiteByteLimit) throw new Error(`the built site is larger than the ${previewSiteByteLimit} bytes a preview publishes`);
      files.push({ path, mediaType: mediaTypes[extname(path).toLowerCase()] ?? 'application/octet-stream', content: content.toString('base64') });
    }
  };
  await walk('');
  return files.sort((a, b) => a.path < b.path ? -1 : 1);
}
const caseResults = (verdict: PreviewVerdict): PreviewCaseResult[] => verdict.cases.slice(0, 100).map(entry =>
  ({ case: entry.case, result: entry.verdict === 'passed' ? 'pass' : entry.verdict === 'unrun' ? 'unrun' : 'fail', ...(entry.reason ? { reason: entry.reason } : {}) }));

/**
 * One step of the item previews, beside the loop's cycle (GY-1902). Every open item whose criteria
 * cite a case bound to a declared application (`previewDemand`; a Compose one, GY-1903, brought up as
 * its own bounded project, at most `composeBounds().concurrent` at once and for its lifetime) gets a preview of its
 * submitted head, or of the base tip while it has none: `starting` is recorded, the change is checked
 * out, built, served on loopback and its declared cases run against it (`openPreview`, kept served on
 * a pass), and the outcome recorded — `running` with every case passed and the built site published
 * with it (`readPreviewSite`), which the server serves at `/preview/KEY/` wherever this loop runs, or
 * `failed` with the case results (or why the site could not be published), its server and checkout already removed.
 * A preview whose item moves to a new head is `superseded`, and one whose item is closed, delivered
 * or no longer cites such a case is ended: a starting one is cancelled, a served one's server closed
 * and checkout removed, and then it is recorded `cleaned` with why. A record this process does not
 * back (the loop restarted) is recorded `cleaned` (`restarted`) before a new preview starts, a Compose one only once
 * the daemon holds nothing of its project. A failed
 * preview is not retried on the same commit. Answers what it did, one line each.
 */
export async function itemPreviewStep(live: Map<string, LivePreview>, work: readonly Work[], ports: ItemPreviewPorts): Promise<string[]> {
  const notes: string[] = [], at = () => new Date((ports.now ?? Date.now)()).toISOString();
  let delivery: ProjectDelivery | null;
  try { delivery = ports.delivery(); } catch { delivery = null; }
  // A preview that ended once it settled (a failed case, or ended while starting) leaves once the
  // server holds its last record; this step's snapshot may predate that record, so the item's
  // preview is read as that record (by key): it is not stale, and a failed commit is not started again.
  const endedNow = new Map<string, ItemPreview>();
  for (const entry of [...live.values()]) {
    if (await settleRecords(entry, ports) && entry.opened && previewEnded(entry.record)) { live.delete(entry.key); endedNow.set(entry.key, entry.record); }
  }
  const ended = (record: ItemPreview, reason: PreviewEndReason, detail: string) => endedRecord(record, reason, detail, at());
  const end = async (entry: LivePreview, reason: PreviewEndReason) => {
    if (!entry.ending) { entry.ending = reason; entry.stop.abort(); }
    // A preview still starting is closed once it settles (`start`); a served one is closed here, each step until it is removed, and only then recorded cleaned.
    if (entry.opened && !previewEnded(entry.record)) {
      try { await entry.opened.close(); } catch (error) { notes.push(`${entry.key}'s preview was not removed, retried next step: ${error instanceof Error ? error.message : String(error)}`); return false; }
      owe(entry, ended(entry.record, entry.ending, `${entry.record.detail ? `${entry.record.detail}; ` : ''}ended: ${entry.ending}`));
    }
    if (entry.opened && await settleRecords(entry, ports)) { live.delete(entry.key); return true; }
    return false;
  };
  // GY-1903: a Compose preview a gone process left on the daemon is removed before this process starts any; its bounds are the loop's configuration.
  const bounds = composeBounds(ports.hostEnvironment ?? process.env);
  if (!composeSwept && delivery?.applications.some(application => application.kind === 'compose')) {
    // Retried each step until a sweep removes everything it should.
    try { for (const project of await sweepComposePreviews({ docker: ports.docker, env: dockerEnvironment({ PATH: (ports.hostEnvironment ?? process.env).PATH ?? '' }, ports.hostEnvironment ?? process.env) })) notes.push(`Removed the abandoned Compose preview ${project}`); composeSwept = true; }
    catch (error) { notes.push(`Could not sweep abandoned Compose previews: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const composing = () => [...live.values()].filter(entry => entry.compose && !entry.ending).length;
  let tip: string | null | undefined;
  for (const item of work) {
    const demand = previewDemand(item, delivery), reason = previewEndReason(item, !!demand);
    const head = item.candidate?.sha?.toLowerCase() ?? null;
    let entry = live.get(item.key);
    // The server already holds this preview ended, as an owed terminal record whose reply was lost leaves it: that record is confirmed.
    if (entry?.opened && previewEnded(entry.record) && item.preview?.id === entry.record.id && previewEnded(item.preview)) entry.owed = [];
    // A Compose preview serves for its configured lifetime at most.
    const expired = entry?.compose && entry.record.state === 'running' && entry.record.readyAt && (ports.now ?? Date.now)() - Date.parse(entry.record.readyAt) > bounds.lifetimeMs;
    if (entry && (reason || entry.ending || expired || (head && entry.record.sha !== head))) {
      const why = entry.ending ?? reason ?? (expired ? 'expired' : 'superseded');
      if (await end(entry, why)) notes.push(`Ended ${item.key}'s preview of ${entry.record.sha.slice(0, 12)} (${why}): its server closed and its checkout removed`);
      if (live.has(item.key)) continue;
      endedNow.set(item.key, entry.record);
      entry = undefined;
    }
    if (entry) continue;
    const recorded = endedNow.get(item.key) ?? item.preview ?? null;
    // A record no preview of this process backs: the loop that served it is gone, so it is recorded ended before anything new starts.
    const stale = recorded && !previewEnded(recorded) ? recorded : null;
    if (stale) {
      // A Compose record is recorded cleaned, and replaced, only once the daemon holds nothing of its project; until then the next step sweeps again.
      const project = stale.database || delivery?.applications.find(application => application.id === stale.application)?.kind === 'compose' ? composeProjectName(item.key, stale.id) : null;
      const left = project ? await composeLeftovers(project, { docker: ports.docker, env: dockerEnvironment({ PATH: (ports.hostEnvironment ?? process.env).PATH ?? '' }, ports.hostEnvironment ?? process.env) }).catch(() => null) : null;
      if (project && (!left || left.containers.length + left.volumes.length + left.networks.length)) { composeSwept = false; notes.push(`${item.key}'s stale Compose preview ${project} is not removed yet; it stays recorded until it is`); continue; }
      try { await ports.record(item, ended(stale, reason ?? 'restarted', `${reason ? 'ended' : 'no live preview backs it after a restart'}`)); notes.push(`Recorded ${item.key}'s preview ${stale.id} cleaned: ${reason ?? 'restarted'}`); }
      catch (error) { notes.push(`Could not record ${item.key}'s stale preview cleaned: ${error instanceof Error ? error.message : String(error)}`); continue; }
    }
    if (reason || !demand) continue;
    const sha = head ?? (tip === undefined ? (tip = await ports.baseTip().then(value => value.toLowerCase(), () => null)) : tip);
    if (!sha || (recorded?.sha === sha && (recorded.state === 'failed' || recorded.endReason === 'expired'))) continue;
    if (demand.application.kind === 'compose' && composing() >= bounds.concurrent) { notes.push(`${item.key}'s Compose preview waits: ${bounds.concurrent} already run`); continue; }
    await start(item, sha, head ? 'head' : 'base', demand);
    notes.push(`Started ${item.key}'s preview of ${sha.slice(0, 12)} (${demand.application.id}: ${demand.cases.join(', ')})`);
  }
  return notes;

  async function start(item: Work, sha: string, source: 'head' | 'base', demand: NonNullable<ReturnType<typeof previewDemand>>) {
    const record: ItemPreview = { id: randomUUID(), path: previewPath(item.key), state: 'starting', runner: 'local', application: demand.application.id, sha, source, origin: null,
      cases: demand.cases.map(id => ({ case: id, result: 'unrun' as const })), detail: demand.omitted.length ? cut(`not previewed, bound to another application: ${demand.omitted.join(', ')}`) : '', startedAt: at(), readyAt: null, cleanedAt: null, endReason: null,
      instance: previewInstance(item.key), database: demand.application.kind === 'compose' ? previewDatabase(item.key) : null, secrets: [] };
    const application = demand.application;
    const compose = application.kind === 'compose' ? { application, project: composeProjectName(item.key, record.id), bounds, docker: ports.docker } : undefined;
    const entry: LivePreview = { key: item.key, work: item.id, record, opened: null, stop: new AbortController(), ending: null, owed: [], failures: 0, compose: compose?.project };
    owe(entry, record);
    live.set(item.key, entry);
    const variables = { GRAPHYARD_PREVIEW_KEY: item.key, GRAPHYARD_PREVIEW_TITLE: item.title, GRAPHYARD_PREVIEW_SHA: sha, GRAPHYARD_PREVIEW_INSTANCE: record.instance!, ...(record.database ? { GRAPHYARD_PREVIEW_DATABASE: record.database } : {}) };
    const omitted = demand.omitted.length ? `; not previewed, bound to another application: ${demand.omitted.join(', ')}` : '';
    // `starting` reaches the server before the build begins and before any outcome is recorded after it.
    await settleRecords(entry, ports);
    void (async () => {
      // An unconfirmed `starting` is retried each second, and no longer once the preview is ended: it then settles as cancelled at once.
      while (!await settleRecords(entry, ports) && !entry.stop.signal.aborted) {
        await new Promise<void>(accept => { const timer = setTimeout(accept, 1000); entry.stop.signal.addEventListener('abort', () => { clearTimeout(timer); accept(); }, { once: true }); });
      }
      const opened = await (ports.open ?? openPreview)({ root: ports.root, base: ports.base, mergeSha: sha, site: application.kind === 'static' ? { directory: application.directory, build: application.build } : { directory: '.', build: null }, compose, timeoutMs: ports.timeoutMs,
        run: ports.run, shell: ports.shell, launcher: ports.launcher, fetcher: ports.fetcher, stepTimeoutMs: ports.stepTimeoutMs, now: ports.now, slots: ports.slots, procRoot: ports.procRoot, hostEnvironment: ports.hostEnvironment },
      { keep: true, cases: demand.cases, variables, signal: entry.stop.signal })
        .catch((error: unknown): OpenedPreview => ({ verdict: { result: 'error', mergeSha: sha, cases: [], failed: [], detail: cut(`the preview could not run: ${error instanceof Error ? error.message : String(error)}`), durationMs: 0 }, url: null, close: async () => {} }));
      const cases = opened.verdict.cases.length ? caseResults(opened.verdict) : record.cases;
      // The link serves the site the cases passed on: its built files, published with the running record.
      let site: PreviewSiteFile[] | null = null, unpublished = '';
      if (!entry.ending && opened.url && opened.verdict.result === 'pass') {
        // Publication is bounded by the preview's budget and ends with the preview: an item cancelled while its pages are read is cleaned up at once.
        try { site = opened.publish ? await opened.publish(AbortSignal.any([entry.stop.signal, AbortSignal.timeout(ports.timeoutMs)])) : await readPreviewSite(opened.site!); } catch (error) { unpublished = `; not published: ${error instanceof Error ? error.message : String(error)}`; }
      }
      if (entry.ending || !opened.url || opened.verdict.result !== 'pass' || !site) {
        // Recorded ended only once removed: a failed removal is retried until it succeeds.
        for (let tries = 1; ; tries++) {
          try { await opened.close(); break; } catch (error) { console.error(`${item.key}'s preview was not removed (try ${tries}), retrying: ${error instanceof Error ? error.message : String(error)}`); }
          await new Promise(accept => setTimeout(accept, Math.min(30_000, 1_000 * tries)));
        }
        const why = entry.ending ?? 'failed';
        owe(entry, { ...entry.record, state: why === 'failed' ? 'failed' : 'cleaned', cases, origin: null, detail: cut(`${opened.verdict.detail}${unpublished}${omitted}`), cleanedAt: at(), endReason: why });
      } else owe(entry, { ...entry.record, state: 'running', cases, origin: opened.url, detail: cut(`${opened.verdict.detail}${omitted}`), readyAt: at() }, site);
      entry.opened = opened;
      await settleRecords(entry, ports);
    })();
  }
}
