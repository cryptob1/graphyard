// Concern: the shadow gate's trial merge — the exact merge commit of a head onto main, and its build and affected tests in a credential-free checkout.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../child-runner.js';
import { allocateSessionCheckout, removeSessionCheckout } from '../install/worktree-root.js';
import { isolatedTestEnvironment, npmCiArgs, npmCiEnvironment } from '../cli/test-isolation.js';

/** One git call in the coordinator's object store: the arguments after `git -C <root>`, the child's stdout. */
export type TrialGit = (args: string[], env?: Record<string, string>) => Promise<string>;
export type TrialMergeResult = { mergeSha: string; tree: string } | { conflict: string[] };

export const trialAuthor = 'graphyard-merge-writer';
export const trialRef = (head: string) => `refs/graphyard/trial/${head}`;
const fullSha = /^[0-9a-f]{40}$/;
const exitOf = (error: unknown) => error as { status?: number | null; stdout?: unknown };

/**
 * The exact merge commit of `head` onto `baseTip`, made without a worktree: `git merge-tree
 * --write-tree` computes the merged tree, `git commit-tree` (authored by graphyard-merge-writer)
 * makes the commit with parents baseTip and head, and the only ref written is
 * `refs/graphyard/trial/<head>`. Nothing under `refs/heads/*`, no remote and no checkout is
 * touched. A conflicting merge gives the conflicted paths and writes no commit. Retention: one
 * ref per tried head, overwritten by that head's next trial and never pruned here, so a recorded
 * verdict's mergeSha keeps resolving; a cleanup belongs beside tip-cleanup if the refs ever matter.
 */
export async function trialMerge(git: TrialGit, input: { head: string; baseTip: string }): Promise<TrialMergeResult> {
  const head = input.head.toLowerCase(), baseTip = input.baseTip.toLowerCase();
  if (!fullSha.test(head) || !fullSha.test(baseTip)) throw new Error('A trial merge names the head and the base tip by their full 40-hex shas');
  let out: string;
  try { out = String(await git(['merge-tree', '--write-tree', '--name-only', '-z', baseTip, head])); }
  catch (error) {
    // Exit 1 is a conflicted merge: the tree id, then the conflicted paths, then the informational messages.
    if (exitOf(error).status !== 1 || typeof exitOf(error).stdout !== 'string') throw error;
    const [, ...rest] = String(exitOf(error).stdout).split('\0');
    const end = rest.indexOf('');
    return { conflict: [...new Set(rest.slice(0, end < 0 ? rest.length : end))].filter(Boolean) };
  }
  const tree = out.split('\0')[0]!.trim();
  if (!fullSha.test(tree)) throw new Error(`git merge-tree answered no tree for ${head} onto ${baseTip}`);
  const email = `${trialAuthor}@users.noreply.invalid`;
  // The environment names the author, so a caller's own GIT_AUTHOR_* never decides it.
  const mergeSha = (await git(['commit-tree', tree, '-p', baseTip, '-p', head, '-m', `Trial merge of ${head} onto ${baseTip}`],
    { GIT_AUTHOR_NAME: trialAuthor, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: trialAuthor, GIT_COMMITTER_EMAIL: email })).trim().toLowerCase();
  await git(['update-ref', trialRef(head), mergeSha]);
  return { mergeSha, tree };
}

/**
 * The variables a trial child never sees, besides every GRAPHYARD_* and HERDR_* one: the
 * credentials, and the temporary-directory overrides. The suite assumes the platform's own
 * temporary directory, as CI gives it (GY-1549: the loop's systemd unit inherits TMPDIR=/var/tmp
 * from environment.d, and tests/test-isolation.test.ts's contained-install assertion failed on it).
 */
export const withheldTrialVariables = ['GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND', 'TMPDIR', 'TMP', 'TEMP'] as const;
/** The trial child's environment: the isolated test one, with every credential and Graphyard control removed and git's global configuration off. */
export function trialEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(isolatedTestEnvironment(environment)).filter(([name]) => !/^(GRAPHYARD|HERDR)_/.test(name) && !(withheldTrialVariables as readonly string[]).includes(name)));
  return { ...kept, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
}

/**
 * A trial's verdict. `runnerExit` is how the test runner process ended: its exit status, 128 plus the
 * signal number when a signal ended it, -1 when it could not be started or outgrew the capture, and
 * null (or absent, from a trial stub) when no runner ran: a failed install or build, a failed
 * selection, or an empty one.
 */
export interface TrialRun { build: 'pass' | 'fail'; tests: { passed: number; failed: string[]; files: number }; durationMs: number; logTail: string; runnerExit?: number | null }
/** Whether a verdict's log tail is worth recording: the build did not pass, a test file failed, or the runner did not exit 0. */
export const trialNeedsLog = (run: Pick<TrialRun, 'build' | 'tests' | 'runnerExit'>) => run.build !== 'pass' || run.tests.failed.length > 0 || (run.runnerExit != null && run.runnerExit !== 0);
/**
 * A trial that outran `timeoutMs` measures the host, not the merge: it is no verdict, so runTrial
 * rejects with this (the phase it was in and the log so far) instead of answering a fail.
 */
export class TrialTimeoutError extends Error {
  constructor(readonly phase: 'install' | 'build' | 'selection' | 'tests', readonly durationMs: number, readonly logTail: string) {
    super(`The trial timed out during its ${phase} after ${Math.round(durationMs / 1000)}s`);
    this.name = 'TrialTimeoutError';
  }
}
/**
 * The trial checkout could not be removed afterwards, so it is left behind under the managed root
 * (the orphan reclaim removes it later). The verdict the trial reached, if it reached one, rides
 * along so the failure is recorded beside it rather than in place of it.
 */
export class TrialCleanupError extends Error {
  constructor(readonly directory: string, readonly verdict: TrialRun | null, readonly cause: unknown, outcome: string) {
    super(`The trial checkout ${directory} was not removed (${cause instanceof Error ? cause.message : String(cause)}); ${outcome}`);
    this.name = 'TrialCleanupError';
  }
}
export interface RunTrialInput {
  /** The coordinator checkout whose object store holds the merge commit. */
  root: string;
  /** The managed worktree root the trial checkout is made under. */
  base: string;
  mergeSha: string;
  changedFiles: readonly string[];
  timeoutMs: number;
  key?: string;
  run?: ChildRun;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Removes the trial checkout afterwards; the managed-root removal unless a test injects one. */
  remove?: typeof removeSessionCheckout;
}
const tailLength = 4000;
const testFile = /tests\/[\w./-]+\.test\.ts/g;
const testFileLine = /^tests\/[\w./-]+\.test\.ts$/;
/**
 * The failing files a runner log names, for a runner whose records are missing. A file-level
 * failure is a `not ok`/`✖` line carrying the path; a failing case inside a file is reported as
 * `✖ <case title>` and its file only on the `test at tests/x.test.ts:line:col` line that follows,
 * so both are read (GY-1549: reading only the first kind counted every such file as passed).
 */
export function failingFilesInLog(out: string): string[] {
  const files = new Set<string>();
  for (const line of out.split('\n')) {
    if (/not ok|✖|FAIL/.test(line)) for (const file of line.match(testFile) ?? []) files.add(file);
    const located = /^\s*test at (tests\/[\w./-]+\.test\.ts):\d+:\d+/.exec(line);
    if (located) files.add(located[1]!);
  }
  return [...files];
}
/** The runner's per-file records (`--durations FILE`, tests/helpers/file-durations.mjs): one JSON line per file that ran, with whether it passed. */
export function runnerRecords(text: string): { file: string; passed: boolean }[] {
  return text.split('\n').flatMap(line => {
    try { const record = JSON.parse(line) as { file?: unknown; passed?: unknown }; return typeof record.file === 'string' ? [{ file: record.file, passed: record.passed !== false }] : []; }
    catch { return []; }
  });
}

/**
 * Check the merge commit out detached as a `trial` checkout, run `npm run build`, then the affected
 * pre-merge selection of scripts/ci-tests.mjs through tests/helpers/run-tests.ts, all under one
 * deadline and `trialEnvironment`. The runner always gets the selected file list, so a full
 * selection runs every pre-merge file and never the release-candidate suites, and the verdict
 * counts the files that ran. The checkout is removed afterwards, pass or fail; a removal that
 * fails rejects with TrialCleanupError carrying the verdict. Past the deadline it rejects with
 * TrialTimeoutError: a timeout is no verdict against the merge.
 */
export async function runTrial(input: RunTrialInput): Promise<TrialRun> {
  const run = input.run ?? defaultChildRun, now = input.now ?? Date.now, startedAt = now(), deadline = startedAt + input.timeoutMs;
  const env = trialEnvironment(input.environment);
  const checkout = await allocateSessionCheckout(input.base, 'trial', input.key ?? 'trial', input.mergeSha, randomUUID());
  const log: string[] = [];
  const remaining = () => Math.max(1000, deadline - now());
  const tail = () => log.join('\n').slice(-tailLength);
  const output = (error: unknown) => {
    const failed = error as { stdout?: unknown; stderr?: unknown; message?: string };
    return `${typeof failed.stdout === 'string' ? failed.stdout : ''}${typeof failed.stderr === 'string' ? failed.stderr : ''}` || String(failed.message ?? error);
  };
  // A child killed at the deadline, or one that ended past it, ends the trial as a timeout, never as a fail.
  // How a failed child ended, as the log's last line for that command: the status or signal, and the
  // runner's own reason when it could not be started or outgrew the capture (its output alone would not say).
  const ending = (error: unknown) => {
    const failed = error as { status?: number | null; signal?: string | null; cause?: unknown };
    const cause = failed.cause instanceof Error ? failed.cause.message : failed.cause === undefined ? null : String(failed.cause);
    return `[exit ${failed.signal ? `signal ${failed.signal}` : `status ${failed.status ?? 'unknown'}`}${cause ? `: ${cause}` : ''}]`;
  };
  const exitCode = (error: unknown) => {
    const failed = error as { status?: number | null; signal?: NodeJS.Signals | null; cause?: unknown };
    if (failed.cause !== undefined) return -1;
    if (typeof failed.status === 'number') return failed.status;
    return failed.signal ? 128 + (constants.signals[failed.signal] ?? 0) : -1;
  };
  const child = async (phase: TrialTimeoutError['phase'], command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
    let out: string;
    try { out = String(await run(command, args, { cwd: checkout.worktree, env: (options.env ?? env) as Record<string, string>, timeoutMs: remaining() })); }
    catch (error) {
      const out = output(error);
      log.push(`$ ${command} ${args.join(' ')}\n${out}\n${ending(error)}`);
      if ((error as { timedOut?: boolean }).timedOut || now() >= deadline) throw new TrialTimeoutError(phase, Math.max(0, now() - startedAt), tail());
      return { ok: false, out, exit: exitCode(error) };
    }
    log.push(`$ ${command} ${args.join(' ')}\n${out}`);
    if (now() >= deadline) throw new TrialTimeoutError(phase, Math.max(0, now() - startedAt), tail());
    return { ok: true, out, exit: 0 };
  };
  const finish = (build: TrialRun['build'], tests: TrialRun['tests'], runnerExit: number | null = null): TrialRun => ({ build, tests, durationMs: Math.max(0, now() - startedAt), logTail: tail(), runnerExit });
  const listed = (out: string) => out.split('\n').map(line => line.trim()).filter(line => testFileLine.test(line));
  const trial = async (): Promise<TrialRun> => {
    try {
      await run('git', ['-C', input.root, 'worktree', 'add', '--detach', checkout.worktree, input.mergeSha], { timeoutMs: remaining() });
      // The merge builds against its own dependencies: the coordinator's install when its lockfile is byte-identical to the merge's, else an `npm ci` of the merge's lockfile.
      const lockfile = (dir: string) => readFile(join(dir, 'package-lock.json'), 'utf8').catch(() => null);
      const [own, merged] = await Promise.all([lockfile(input.root), lockfile(checkout.worktree)]);
      if (existsSync(join(input.root, 'node_modules')) && own !== null && own === merged) await symlink(join(input.root, 'node_modules'), join(checkout.worktree, 'node_modules'));
      else if (!(await child('install', 'npm', npmCiArgs, { env: npmCiEnvironment(env) })).ok) return finish('fail', { passed: 0, failed: [], files: 0 });
      const built = await child('build', 'npm', ['run', 'build']);
      if (!built.ok) return finish('fail', { passed: 0, failed: [], files: 0 });
      const selection = await child('selection', 'node', ['scripts/ci-tests.mjs', 'affected', ...input.changedFiles]);
      if (!selection.ok) return finish('pass', { passed: 0, failed: ['scripts/ci-tests.mjs affected'], files: 0 });
      let files = listed(selection.out);
      // A merge whose own ci-tests predates GY-1522 lists no files for a full selection; `select` outside Actions lists exactly the pre-merge suite.
      if (!files.length && /^full:/.test(selection.out.trimStart())) {
        const full = await child('selection', 'node', ['scripts/ci-tests.mjs', 'select']);
        if (!full.ok) return finish('pass', { passed: 0, failed: ['scripts/ci-tests.mjs select'], files: 0 });
        files = listed(full.out);
      }
      // An affected selection of nothing runs nothing.
      if (!files.length) return finish('pass', { passed: 0, failed: [], files: 0 });
      const list = join(checkout.directory, 'affected-tests.txt'), records = join(checkout.directory, 'test-results.jsonl');
      await writeFile(list, `${files.join('\n')}\n`);
      // The runner's own per-file records decide which files failed; the human-readable log is only read when they are missing.
      const tests = await child('tests', 'node', ['--import', 'tsx', 'tests/helpers/run-tests.ts', '--files-from', list, '--durations', records]);
      const recorded = runnerRecords(await readFile(records, 'utf8').catch(() => ''));
      const failing = [...new Set(recorded.length ? recorded.filter(record => !record.passed).map(record => record.file) : tests.ok ? [] : failingFilesInLog(tests.out))];
      if (tests.ok && !failing.length) return finish('pass', { passed: files.length, failed: [], files: files.length }, 0);
      return finish('pass', { passed: Math.max(0, files.length - failing.length), failed: failing.length ? failing : ['tests/helpers/run-tests.ts'], files: files.length }, tests.exit);
    } catch (error) {
      if (error instanceof TrialTimeoutError) throw error;
      log.push(`trial checkout failed: ${error instanceof Error ? error.message : String(error)}`);
      if ((error as { timedOut?: boolean }).timedOut || now() >= deadline) throw new TrialTimeoutError('install', Math.max(0, now() - startedAt), tail());
      return finish('fail', { passed: 0, failed: [], files: 0 });
    }
  };
  // The checkout goes whatever the trial did; a removal that fails is reported, never swallowed.
  let settled: { verdict: TrialRun } | { error: unknown };
  try { settled = { verdict: await trial() }; } catch (error) { settled = { error }; }
  try { await (input.remove ?? removeSessionCheckout)(input.root, input.base, checkout.directory, input.run); }
  catch (cause) {
    const outcome = 'verdict' in settled ? `the trial itself answered build ${settled.verdict.build}, ${settled.verdict.tests.failed.length} failing test file(s)` : `the trial itself failed: ${settled.error instanceof Error ? settled.error.message : String(settled.error)}`;
    throw new TrialCleanupError(checkout.directory, 'verdict' in settled ? settled.verdict : null, cause, outcome);
  }
  if ('error' in settled) throw settled.error;
  return settled.verdict;
}
