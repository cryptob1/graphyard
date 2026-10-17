// Concern: a managed repository's own E2E cases on every release candidate (GY-1535) — the candidate's UAT step runs every required case of its checkout through src/e2e/runner.ts, against its UAT deployment or a static site's loopback server.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { contractFile, loadCases, loadContract, type CaseFile, type ReleaseContract } from './e2e/case.js';
import { e2eSuite, installServesDeliveries, type E2eLauncher, type E2eReport } from './e2e/runner.js';
import { holdTagPrefix, releaseHolds } from './release-holds.js';
import { findCandidate, readLedgerAsync, recordsArguments, serveStaticSite, syncLedgerAsync, validateAndRecord, type AnyGit, type AsyncGit, type Git, type HoldOutcome, type ReleaseCandidate, type StaticUat, type Suite, type UatRecord } from './release-candidate.js';

/**
 * GY-1535: a managed repository's own cases as the candidate's `e2e` suite — every required case
 * and every case targeting uat in the candidate checkout `root`, run against the UAT deployment
 * through src/e2e/runner.ts's release suite (one retry each), every one of them run even after a
 * required case fails, so a failing required case fails the candidate and every case records its own
 * result. `report` receives the run's report, from which the
 * candidate record names each case's result.
 */
export function projectCaseSuite(root: string, token: string, options: { fetcher?: typeof fetch; launcher?: E2eLauncher; stepTimeoutMs?: number;
  report?: (report: E2eReport) => void | Promise<void>; signal?: AbortSignal; select?: (entry: CaseFile) => boolean; withholdSecrets?: boolean; hostEnvironment?: NodeJS.ProcessEnv;
  /** The cases to run, loaded beforehand; when absent they are loaded from `root` at run time. */
  cases?: readonly CaseFile[];
  /** The checkout's release contract: a candidate outcome still pending on its record (GY-1802) runs its failing cases as pending, never blocking. */
  contract?: ReleaseContract | null } = {}): Suite {
  return {
    name: 'e2e',
    run: async (url, candidate) => {
      const suite = e2eSuite(options.cases ? [...options.cases] : await loadCases(root), token, { fetcher: options.fetcher, launcher: options.launcher, stepTimeoutMs: options.stepTimeoutMs, root, report: options.report, signal: options.signal,
        select: options.select ?? (entry => entry.definition.required || entry.definition.target === 'uat'), runAll: true, withholdSecrets: options.withholdSecrets, hostEnvironment: options.hostEnvironment, contract: options.contract });
      return suite.run(url, candidate);
    },
  };
}

/**
 * The release holds (src/release-holds.ts) over async git, so the loop never blocks on a child: the
 * hold records are read ahead and answered to the holds' own sync read, and the hold tags they write
 * are kept in order and written through `git` when the outcome's `write` runs.
 */
const asyncHolds = (git: AsyncGit, options: Parameters<typeof releaseHolds>[1]) => async (candidate: ReleaseCandidate, record: UatRecord): Promise<HoldOutcome> => {
  const read = recordsArguments(holdTagPrefix), listed = await git(read), writes: string[][] = [];
  const replay: Git = args => {
    if (args.join('\0') === read.join('\0')) return listed;
    if (!args.includes('tag') && args[0] !== 'push') throw new Error(`the release holds ran git ${args.join(' ')}, which is not a hold record's read or write`);
    writes.push(args);
    return '';
  };
  const outcome = await releaseHolds(replay, options)(candidate, record);
  return { ...outcome, write: async () => { outcome.write(); for (const args of writes) await git(args); } };
};

/** Runs a shell command in a checkout, in `env` when named: whether it exited zero, and what it printed. */
export type StaticBuildShell = (command: string, cwd: string, signal?: AbortSignal, env?: NodeJS.ProcessEnv) => Promise<{ ok: boolean; output: string }>;
/**
 * The default `StaticBuildShell`: `sh -c command` in its own process group, both streams kept (the
 * last ~4 MB). At `timeoutMs`, on `signal`, and once the shell itself has exited, the whole group is
 * killed — an `npm run build`'s descendants with it — and the answer waits until every process
 * holding its output has ended, so no build process outlives the call (GY-1718).
 */
export const groupBuildShell = (timeoutMs: number): StaticBuildShell => (command, cwd, signal, env) => new Promise(accept => {
  const child = spawn('sh', ['-c', command], { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const chunks: Buffer[] = [];
  let size = 0, ended: string | null = null;
  const keep = (chunk: Buffer) => { chunks.push(chunk); size += chunk.length; while (size - chunks[0].length >= 4_000_000) size -= chunks.shift()!.length; };
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  const killGroup = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* the group has already ended */ } };
  const stop = (why: string) => { ended ??= why; killGroup(); };
  const timer = setTimeout(() => stop(`the build did not finish within ${timeoutMs} ms`), timeoutMs);
  const cancel = () => stop('the build was cancelled');
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  child.on('exit', killGroup);
  const settle = (code: number | null, error?: Error) => {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    const output = Buffer.concat(chunks).toString('utf8');
    accept({ ok: code === 0 && !ended && !error, output: `${output}${error ? error.message : ended && !output ? ended : code !== 0 && !output ? `exited ${code ?? 'by signal'}` : ''}` });
  };
  child.on('error', error => settle(null, error));
  child.on('close', code => settle(code));
});
/**
 * Build a static site's output in `checkout` with its `build` shell command (`GRAPHYARD_UAT_BUILD`):
 * null when the build passed, else the failure's detail naming the command and its last output
 * lines. The release candidate (GY-1535) and the merge preview (GY-1718) build the same way, in
 * `groupBuildShell`; `signal` cancels the build, killing its process group; `env`, when named, is
 * the build's whole environment (the merge preview's holds no coordinator credential), else it
 * inherits this process's.
 */
export async function buildStaticSite(build: string, checkout: string, timeoutMs: number, shell?: StaticBuildShell, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<string | null> {
  const built = await (shell ?? groupBuildShell(timeoutMs))(build, checkout, signal, env);
  return built.ok ? null : `the static site's build \`${build}\` failed: ${built.output.trim().split('\n').slice(-5).join(' | ').slice(0, 900)}`;
}

/** The UAT a managed repository's candidate is validated on: a deployment's URL, or a static site's build output served on loopback (optionally built first by `build`, a shell command run in the checkout). */
export type ProjectUat = { url: string } | { static: { directory: string; build?: string | null } };

/**
 * GY-1535: validate a managed repository's candidate on UAT and record the verdict once. The
 * candidate checkout `checkout` (its exact SHA) supplies the cases and the release contract: its
 * `e2e` suite is `projectCaseSuite`, and the record keeps every case's verdict (`e2e`), its blocking
 * cases deciding the release holds and, through them, the related-item revert (GY-1526). A static
 * site's UAT is `serveStaticSite` over its build output, built first when `build` is named; a
 * build that fails fails the candidate as its own `build` suite.
 */
export async function validateProjectCandidate(sourceGit: AnyGit, id: string, options: { checkout: string; uat: ProjectUat; token: string; base: string; push: boolean; timeoutMs: number;
  file?: (item: object, requestId: string) => Promise<string>; fetcher?: typeof fetch; launcher?: E2eLauncher; stepTimeoutMs?: number; now?: () => Date;
  shell?: StaticBuildShell }) {
  const git = async (args: string[]) => await sourceGit(args);
  await syncLedgerAsync(git, options.base);
  const candidate = findCandidate(await readLedgerAsync(git), id);
  let report: E2eReport | null = null;
  const suites: Suite[] = [];
  let served: StaticUat | null = null, url: string;
  if ('url' in options.uat) url = options.uat.url;
  else {
    const { directory, build } = options.uat.static;
    if (build) {
      const failed = await buildStaticSite(build, options.checkout, options.timeoutMs, options.shell);
      if (failed) suites.push({ name: 'build', run: async () => ({ name: 'build', passed: false, detail: failed }) });
    }
    served = await serveStaticSite(join(options.checkout, directory), candidate.sha);
    url = served.url;
  }
  const contract = existsSync(join(options.checkout, contractFile)) ? await loadContract(options.checkout).catch(() => null) : null;
  suites.push(projectCaseSuite(options.checkout, options.token, { fetcher: options.fetcher, launcher: options.launcher, stepTimeoutMs: options.stepTimeoutMs, report: value => { report = value; }, contract }));
  try {
    const holds = asyncHolds(git, { contract, push: options.push, file: options.file, now: options.now, report: async () => report,
      // GY-1938: the holds honor the report's suspended delivery cases only when this own probe of the install confirms it cannot serve deliveries; a static site's UAT answers no merger, so nothing is suspended there.
      servesDeliveries: 'url' in options.uat ? async () => (await installServesDeliveries(url, options.token, options.fetcher)).servesDeliveries : undefined });
    return await validateAndRecord(git, id, url, suites, { base: options.base, push: options.push, timeoutMs: options.timeoutMs, file: options.file, holds, now: options.now, fetcher: options.fetcher });
  } finally { await served?.close(); }
}
