// Concern: a managed repository's own E2E cases on every release candidate (GY-1535) — the candidate's UAT step runs every required case of its checkout through src/e2e/runner.ts, against its UAT deployment or a static site's loopback server.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { contractFile, loadCases, loadContract } from './e2e/case.js';
import { e2eSuite, type E2eLauncher, type E2eReport } from './e2e/runner.js';
import { releaseHolds } from './release-holds.js';
import { findCandidate, readLedgerAsync, serveStaticSite, syncLedgerAsync, validateAndRecord, type AnyGit, type StaticUat, type Suite } from './release-candidate.js';

/**
 * GY-1535: a managed repository's own cases as the candidate's `e2e` suite — every required case
 * and every case targeting uat in the candidate checkout `root`, run against the UAT deployment
 * through src/e2e/runner.ts's release suite (one retry each), every one of them run even after a
 * required case fails, so a failing required case fails the candidate and every case records its own
 * result. `report` receives the run's report, from which the
 * candidate record names each case's result.
 */
export function projectCaseSuite(root: string, token: string, options: { fetcher?: typeof fetch; launcher?: E2eLauncher; stepTimeoutMs?: number;
  report?: (report: E2eReport) => void | Promise<void> } = {}): Suite {
  return {
    name: 'e2e',
    run: async (url, candidate) => {
      const suite = e2eSuite(await loadCases(root), token, { fetcher: options.fetcher, launcher: options.launcher, stepTimeoutMs: options.stepTimeoutMs, root, report: options.report,
        select: entry => entry.definition.required || entry.definition.target === 'uat', runAll: true });
      return suite.run(url, candidate);
    },
  };
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
  shell?: (command: string, cwd: string) => Promise<{ ok: boolean; output: string }> }) {
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
      const shell = options.shell ?? ((command: string, cwd: string) => new Promise<{ ok: boolean; output: string }>(accept => {
        execFile('sh', ['-c', command], { cwd, encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => accept({ ok: !error, output: `${stdout ?? ''}${stderr ?? ''}${error && !stderr ? error.message : ''}` }));
      }));
      const built = await shell(build, options.checkout);
      if (!built.ok) suites.push({ name: 'build', run: async () => ({ name: 'build', passed: false, detail: `the static site's build \`${build}\` failed: ${built.output.trim().split('\n').slice(-5).join(' | ').slice(0, 900)}` }) });
    }
    served = await serveStaticSite(join(options.checkout, directory), candidate.sha);
    url = served.url;
  }
  suites.push(projectCaseSuite(options.checkout, options.token, { fetcher: options.fetcher, launcher: options.launcher, stepTimeoutMs: options.stepTimeoutMs, report: value => { report = value; } }));
  try {
    const contract = existsSync(join(options.checkout, contractFile)) ? await loadContract(options.checkout).catch(() => null) : null;
    const holds = releaseHolds(git, { contract, push: options.push, file: options.file, now: options.now, report: async () => report });
    return await validateAndRecord(git, id, url, suites, { base: options.base, push: options.push, timeoutMs: options.timeoutMs, file: options.file, holds, now: options.now, fetcher: options.fetcher });
  } finally { await served?.close(); }
}
