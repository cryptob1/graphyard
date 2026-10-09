// Concern: the shadow gate's trial merge — the exact merge commit of a head onto main, and its build and affected tests in a credential-free checkout.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { defaultChildRun, type ChildRun } from '../child-runner.js';
import { allocateSessionCheckout, removeSessionCheckout } from '../install/worktree-root.js';
import { isolatedTestEnvironment, npmCiArgs, npmCiEnvironment } from '../cli/test-isolation.js';
import { tempOwnerMarker, writeTempOwner } from '../tmp-reclaim.js';

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
 * The variables a trial child never sees by name, besides every GRAPHYARD_* and HERDR_* one and
 * every credential-bearing name (`credentialTrialVariable`): the gh/ssh helpers, and the host's
 * temporary-directory overrides (GY-1549: the loop's systemd unit inherits TMPDIR=/var/tmp from
 * environment.d). runTrial sets its own in their place (`trialTemporaryRoot`).
 */
export const withheldTrialVariables = ['GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND', 'TMPDIR', 'TMP', 'TEMP'] as const;
/**
 * Whether a variable name is credential-bearing and must not reach the trial child (GY-1548): the
 * named helpers above, plus any name carrying a token, secret, password, private key, API key,
 * access key or credential (so AWS_SECRET_ACCESS_KEY, NPM_TOKEN and the like never ride into the
 * child or its diagnostic record when a runner echoes its environment).
 */
export const credentialTrialVariable = (name: string) =>
  (withheldTrialVariables as readonly string[]).includes(name)
  || /(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL)/i.test(name);
/** The trial child's environment: the isolated test one, with every credential and Graphyard control removed and git's global configuration off. */
export function trialEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(isolatedTestEnvironment(environment)).filter(([name]) => !/^(GRAPHYARD|HERDR)_/.test(name) && !credentialTrialVariable(name)));
  return { ...kept, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
}

/** What an upward lookup from a fixture resolves first: a directory holding one of these shadows the fixture's own. */
export const trialLookupEntries = ['node_modules', '.git', 'package.json'] as const;
/** Where a trial's temporary directory may go, in order: the platform's own, then the persistent one. */
export const trialTemporaryRoots = ['/tmp', '/var/tmp'] as const;
/** Whether `directory` or a folder above it (short of the filesystem root) holds an entry an upward lookup would resolve. */
export function lookupPoisoned(directory: string): boolean {
  for (let at = directory; at !== parse(at).root; at = dirname(at)) if (trialLookupEntries.some(entry => existsSync(join(at, entry)))) return true;
  return false;
}
/**
 * The folder the trial's own temporary directory is made in (GY-1565): the first root no stray
 * node_modules, .git or package.json sits in or above, else the trial's session directory. The
 * host's shared /tmp is not CI's empty one: vishrog's /tmp/node_modules is what
 * tests/worktree-reclaim.test.ts's upward install lookup found first, so its dependency mirror
 * shared nothing. The directory stays short, as CI's is: a socket path or a typed launch line the
 * suite builds under it has a length bound.
 */
export const trialTemporaryRoot = (sessionDirectory: string, roots: readonly string[] = trialTemporaryRoots) =>
  roots.find(root => existsSync(root) && !lookupPoisoned(root)) ?? sessionDirectory;
/**
 * The name prefix of a trial's temporary directory, one of the tmp reclaim's `testTempPatterns`, so
 * a directory a crashed merge writer left behind is taken back (GY-1565). runTrial marks it with its
 * owner, so the loop's pass and the test runner's sweep remove it as soon as that process is gone,
 * and keep it while the trial runs. It stays this short: `graphyard-trial-` lengthened the suite's
 * launch lines past their bound (master-agent-envs, master-loop-resilience).
 */
export const trialTemporaryPrefix = 'gyt-';
/** The variables that point the trial child's temporary files at `directory`. */
export const trialTemporaryVariables = (directory: string) => ({ TMPDIR: directory, TMP: directory, TEMP: directory });

/**
 * A trial's verdict. `runnerExit` is how the test runner process ended: its exit status, 128 plus the
 * signal number when a signal ended it, -1 when it could not be started or outgrew the capture, and
 * null (or absent, from a trial stub) when no runner ran: a failed install or build, a failed
 * selection, or an empty one.
 */
export interface TrialRun { build: 'pass' | 'fail'; tests: { passed: number; failed: string[]; files: number }; durationMs: number; logTail: string; runnerExit?: number | null; groups?: TrialGroup[] }
/** One runner process of a trial (GY-1548): the files it ran, how it ended, and the failing files its records or log named. */
export interface TrialGroup { files: string[]; status: number | null; signal: string | null; failed: string[] }
/** Whether a verdict's log tail is worth recording: the build did not pass, a test file failed, or the runner did not exit 0. */
export const trialNeedsLog = (run: Pick<TrialRun, 'build' | 'tests' | 'runnerExit'>) => run.build !== 'pass' || run.tests.failed.length > 0 || (run.runnerExit != null && run.runnerExit !== 0);
/**
 * How many test files one runner process of a trial runs at most (GY-1548). A full selection of
 * 486 files in one `node --test` process outgrew the child runner's 16 MiB output capture, so the
 * runner was killed with every file passing and the verdict named only tests/helpers/run-tests.ts.
 */
export const trialTestGroupSize = 40;
/** The groups a selection runs in: its own order, cut every `size` files, so every file runs once and a failing group is a short list. */
export function groupTestFiles(files: readonly string[], size = trialTestGroupSize): string[][] {
  const bound = Math.max(1, Math.floor(size)), groups: string[][] = [];
  for (let at = 0; at < files.length; at += bound) groups.push(files.slice(at, at + bound));
  return groups;
}
/** How much of a failing runner child's output its diagnostic record keeps: enough to read the exit, little enough for one daemon action. */
export const runnerDiagnosticTailLength = 1200;
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
 * A runner child that ended without naming a failing test (GY-1548): a test group whose process
 * exited non-zero or on a signal while its records and log name no failing file, or an install or
 * build child a signal ended or the host could not start. That measures the host or the runner,
 * not the merge, so it is no verdict: runTrial rejects with this, carrying the exit status or
 * signal, the phase, the files of the failing group (how many of them finished, by the runner's
 * records), the last `runnerDiagnosticTailLength` characters of that child's output, and the
 * trial merge sha. The child ran under `trialEnvironment`, so the tail holds no credential.
 */
export class TrialRunnerError extends Error {
  constructor(readonly phase: 'install' | 'build' | 'tests', readonly status: number | null, readonly signal: string | null, readonly files: string[], readonly finished: number, readonly outputTail: string, readonly mergeSha: string, readonly durationMs: number) {
    super(`The trial's ${phase} runner exited (${signal ? `signal ${signal}` : `status ${status ?? 'unknown'}`}) naming no failing test${files.length ? `; ${finished} of its ${files.length} file(s) finished` : ''}`);
    this.name = 'TrialRunnerError';
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
  /** The most files one runner process runs; `trialTestGroupSize` unless a test narrows it. */
  groupSize?: number;
  /** Where the trial's temporary directory may go; `trialTemporaryRoots` unless a test names others. */
  temporaryRoots?: readonly string[];
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
 * deadline and `trialEnvironment` with the trial's own empty temporary directory. The runner
 * always gets a selected file list, so a full selection runs every pre-merge file and never the
 * release-candidate suites, and the verdict counts the files that ran. The selection runs in
 * groups of at most `trialTestGroupSize` files, each its own runner process over the same
 * checkout, so a full selection never fills one process; the verdict's failing files are the union the groups' records name, and `groups`
 * says how each process ended. The checkout is removed afterwards, pass or fail; a removal that
 * fails rejects with TrialCleanupError carrying the verdict. Past the deadline it rejects with
 * TrialTimeoutError, and a runner that ends naming no failing test with TrialRunnerError: neither
 * is a verdict against the merge.
 */
export async function runTrial(input: RunTrialInput): Promise<TrialRun> {
  const run = input.run ?? defaultChildRun, now = input.now ?? Date.now, startedAt = now(), deadline = startedAt + input.timeoutMs;
  const checkout = await allocateSessionCheckout(input.base, 'trial', input.key ?? 'trial', input.mergeSha, randomUUID());
  // A fresh, empty temporary directory made for this trial alone, removed with its checkout, and
  // marked as this process's so a crash before the cleanup leaves it to the tmp reclaim.
  let temporary: string | null = null;
  try { temporary = await mkdtemp(join(trialTemporaryRoot(checkout.directory, input.temporaryRoots), trialTemporaryPrefix)); await writeTempOwner(temporary); }
  catch (error) {
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
    await (input.remove ?? removeSessionCheckout)(input.root, input.base, checkout.directory, input.run).catch(() => {});
    throw error;
  }
  const env = { ...trialEnvironment(input.environment), ...trialTemporaryVariables(temporary) };
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
  /** How a failed child ended, as the verdict's `runnerExit` counts it: the status, 128 plus the signal's number, or -1 when it never ran to an exit of its own. */
  const exitCode = (ended: { status: number | null; signal: string | null; cause: unknown }) => {
    if (ended.cause !== undefined) return -1;
    if (typeof ended.status === 'number') return ended.status;
    return ended.signal ? 128 + (constants.signals[ended.signal as NodeJS.Signals] ?? 0) : -1;
  };
  type Ended = { ok: boolean; out: string; status: number | null; signal: string | null; cause: unknown };
  /** How a failed child ended: npm and shells often report a signal kill as status 128+N with no signal field; recover the name so a host kill is a runner failure, never a merge fail. */
  const endedOf = (error: unknown, out: string): Ended => {
    const failed = error as { status?: number | null; signal?: string | null; cause?: unknown };
    let status = typeof failed.status === 'number' ? failed.status : null;
    let signal: string | null = failed.signal ?? null;
    if (signal === null && status !== null && status > 128 && status < 160) {
      const number = status - 128;
      const name = (Object.entries(constants.signals) as [string, number][]).find(([, value]) => value === number)?.[0] ?? null;
      if (name) { signal = name; status = null; }
    }
    return { ok: false, out, status, signal, cause: failed.cause };
  };
  const child = async (phase: TrialTimeoutError['phase'], command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<Ended> => {
    let out: string;
    try { out = String(await run(command, args, { cwd: checkout.worktree, env: (options.env ?? env) as Record<string, string>, timeoutMs: remaining() })); }
    catch (error) {
      const out = output(error);
      const ended = endedOf(error, out);
      log.push(`$ ${command} ${args.join(' ')}\n${out}\n${ending({ status: ended.status, signal: ended.signal, cause: ended.cause })}`);
      if ((error as { timedOut?: boolean }).timedOut || now() >= deadline) throw new TrialTimeoutError(phase, Math.max(0, now() - startedAt), tail());
      return ended;
    }
    log.push(`$ ${command} ${args.join(' ')}\n${out}`);
    if (now() >= deadline) throw new TrialTimeoutError(phase, Math.max(0, now() - startedAt), tail());
    return { ok: true, out, status: 0, signal: null, cause: undefined };
  };
  // A child a signal ended, or one the host could not start or capture, says nothing about the merge.
  const hostEnded = (ended: Ended) => !ended.ok && (ended.signal !== null || ended.cause !== undefined);
  const runnerFailure = (phase: TrialRunnerError['phase'], ended: Ended, files: string[] = [], finished = 0) =>
    new TrialRunnerError(phase, ended.status, ended.signal, files, finished, `${ended.out}\n${ending({ status: ended.status, signal: ended.signal, cause: ended.cause })}`.slice(-runnerDiagnosticTailLength), input.mergeSha, Math.max(0, now() - startedAt));
  const finish = (build: TrialRun['build'], tests: TrialRun['tests'], runnerExit: number | null = null, groups?: TrialGroup[]): TrialRun => ({ build, tests, durationMs: Math.max(0, now() - startedAt), logTail: tail(), runnerExit, ...(groups ? { groups } : {}) });
  const listed = (out: string) => out.split('\n').map(line => line.trim()).filter(line => testFileLine.test(line));
  const trial = async (): Promise<TrialRun> => {
    try {
      await run('git', ['-C', input.root, 'worktree', 'add', '--detach', checkout.worktree, input.mergeSha], { timeoutMs: remaining() });
      // The merge builds against its own dependencies: the coordinator's install when its lockfile is byte-identical to the merge's, else an `npm ci` of the merge's lockfile.
      const lockfile = (dir: string) => readFile(join(dir, 'package-lock.json'), 'utf8').catch(() => null);
      const [own, merged] = await Promise.all([lockfile(input.root), lockfile(checkout.worktree)]);
      if (existsSync(join(input.root, 'node_modules')) && own !== null && own === merged) await symlink(join(input.root, 'node_modules'), join(checkout.worktree, 'node_modules'));
      else {
        const installed = await child('install', 'npm', npmCiArgs, { env: npmCiEnvironment(env) });
        if (hostEnded(installed)) throw runnerFailure('install', installed);
        if (!installed.ok) return finish('fail', { passed: 0, failed: [], files: 0 });
      }
      const built = await child('build', 'npm', ['run', 'build']);
      if (hostEnded(built)) throw runnerFailure('build', built);
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
      // Each group is one runner process over the same checkout. Failing per-file records decide which
      // files failed; the human-readable log is read when those records name none — including a
      // partial-record run that finished some files and printed a named failure for another (GY-1548).
      // A group that ends non-zero naming no failing file is a runner failure, unless another group
      // named one: a named failing test is the merge's, and stays a failing verdict.
      const groups: TrialGroup[] = [];
      let unattributed: TrialRunnerError | null = null;
      for (const [index, group] of groupTestFiles(files, input.groupSize).entries()) {
        const list = join(checkout.directory, `tests-${index + 1}.txt`), records = join(checkout.directory, `tests-${index + 1}.jsonl`);
        await writeFile(list, `${group.join('\n')}\n`);
        const tests = await child('tests', 'node', ['--import', 'tsx', 'tests/helpers/run-tests.ts', '--files-from', list, '--durations', records]);
        const recorded = runnerRecords(await readFile(records, 'utf8').catch(() => ''));
        const namedByRecords = recorded.filter(record => !record.passed).map(record => record.file);
        const failing = [...new Set(namedByRecords.length ? namedByRecords : tests.ok ? [] : failingFilesInLog(tests.out))];
        groups.push({ files: group, status: tests.status, signal: tests.signal, failed: failing });
        if (!tests.ok && !failing.length) unattributed ??= runnerFailure('tests', tests, group, recorded.filter(record => group.includes(record.file)).length);
      }
      const failed = [...new Set(groups.flatMap(group => group.failed))];
      if (!failed.length && unattributed) throw unattributed;
      const worst = groups.find(group => group.status !== 0);
      return finish('pass', { passed: Math.max(0, files.length - failed.length), failed, files: files.length }, worst ? exitCode({ status: worst.status, signal: worst.signal, cause: undefined }) : 0, groups);
    } catch (error) {
      if (error instanceof TrialTimeoutError || error instanceof TrialRunnerError) throw error;
      log.push(`trial checkout failed: ${error instanceof Error ? error.message : String(error)}`);
      if ((error as { timedOut?: boolean }).timedOut || now() >= deadline) throw new TrialTimeoutError('install', Math.max(0, now() - startedAt), tail());
      return finish('fail', { passed: 0, failed: [], files: 0 });
    }
  };
  // The checkout goes whatever the trial did; a removal that fails is reported, never swallowed.
  let settled: { verdict: TrialRun } | { error: unknown };
  try { settled = { verdict: await trial() }; } catch (error) { settled = { error }; }
  // The temporary directory goes with it: a failure to remove either is the cleanup's, and neither stops the other.
  const removed = await Promise.allSettled([rm(temporary, { recursive: true, force: true }).then(() => rm(tempOwnerMarker(temporary), { force: true })), (input.remove ?? removeSessionCheckout)(input.root, input.base, checkout.directory, input.run)]);
  const failure = removed.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) {
    const cause = failure.reason;
    const outcome = 'verdict' in settled ? `the trial itself answered build ${settled.verdict.build}, ${settled.verdict.tests.failed.length} failing test file(s)` : `the trial itself failed: ${settled.error instanceof Error ? settled.error.message : String(settled.error)}`;
    throw new TrialCleanupError(checkout.directory, 'verdict' in settled ? settled.verdict : null, cause, outcome);
  }
  if ('error' in settled) throw settled.error;
  return settled.verdict;
}
