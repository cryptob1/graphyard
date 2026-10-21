// Concern: a managed repository's own E2E cases and static-site build (GY-1535) — the merge preview runs every required case of its checkout through src/e2e/runner.ts against the site it builds.
import { spawn } from 'node:child_process';
import { loadCases, type CaseFile, type ReleaseContract } from './e2e/case.js';
import { e2eSuite, type E2eLauncher, type E2eReport } from './e2e/runner.js';

/**
 * GY-1535: a managed repository's own cases as an `e2e` suite — every required case and every case
 * targeting uat in the checkout `root`, run through src/e2e/runner.ts's release suite (one retry
 * each), every one of them run even after a required case fails, so each records its own result.
 * `report` receives the run's report.
 */
export function projectCaseSuite(root: string, token: string, options: { fetcher?: typeof fetch; launcher?: E2eLauncher; stepTimeoutMs?: number;
  report?: (report: E2eReport) => void | Promise<void>; signal?: AbortSignal; select?: (entry: CaseFile) => boolean; withholdSecrets?: boolean; hostEnvironment?: NodeJS.ProcessEnv;
  /** The cases to run, loaded beforehand; when absent they are loaded from `root` at run time. */
  cases?: readonly CaseFile[];
  /** The checkout's release contract: an outcome still pending (GY-1802) runs its failing cases as pending, never blocking. */
  contract?: ReleaseContract | null } = {}) {
  return {
    name: 'e2e',
    run: async (url: string, candidate: { id: string; pendingOutcomes?: readonly string[] } | null) => {
      const suite = e2eSuite(options.cases ? [...options.cases] : await loadCases(root), token, { fetcher: options.fetcher, launcher: options.launcher, stepTimeoutMs: options.stepTimeoutMs, root, report: options.report, signal: options.signal,
        select: options.select ?? (entry => entry.definition.required || entry.definition.target === 'uat'), runAll: true, withholdSecrets: options.withholdSecrets, hostEnvironment: options.hostEnvironment, contract: options.contract });
      return suite.run(url, candidate);
    },
  };
}

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
 * lines. The merge preview (GY-1718) builds in `groupBuildShell`; `signal` cancels the build, killing its process group; `env`, when named, is
 * the build's whole environment (the merge preview's holds no coordinator credential), else it
 * inherits this process's.
 */
export async function buildStaticSite(build: string, checkout: string, timeoutMs: number, shell?: StaticBuildShell, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<string | null> {
  const built = await (shell ?? groupBuildShell(timeoutMs))(build, checkout, signal, env);
  return built.ok ? null : `the static site's build \`${build}\` failed: ${built.output.trim().split('\n').slice(-5).join(' | ').slice(0, 900)}`;
}
