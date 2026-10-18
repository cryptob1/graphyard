// Concern: the merge writer's trial merge — the exact merge commit of a head onto main, and its build and affected tests in a credential-free checkout.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { availableParallelism, constants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../child-runner.js';
import { allocateSessionCheckout, defaultWorktreeRootMinFreeGb, removeSessionCheckout, verifyWorktreeRoot, type FilesystemProbe } from '../install/worktree-root.js';
import { isolatedTestEnvironment, npmCiArgs, npmCiEnvironment } from '../cli/test-isolation.js';
import { tempOwnerMarker, writeTempOwner } from '../tmp-reclaim.js';
import type { HostMemoryReading } from '../master-resources.js';

// A trial keeps FORCE_COLOR, so the runner's summary may carry ANSI escapes before every line it prints.
const ansiEscape = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/**
 * The line a trial's log tail puts where it cut a failing group's output (GY-1639): what follows may
 * be the middle of a `failing tests:` summary whose heading was cut, so it reopens summary reading.
 */
export const trialCutLine = "… (this group's earlier output was cut)";
/**
 * The runner's last `failing tests:` summary in one group's output (GY-1645): its heading through
 * the last line of its entries (each `test at` line, its `✖` test and the indented error), or null
 * when the output carries none. ANSI escapes are ignored when reading where it starts and ends.
 */
export function failingSummary(output: string): string | null {
  const lines = output.split('\n'), plain = lines.map(line => line.replace(ansiEscape, ''));
  // Only the runner's own heading, at column zero: a child run's summary a failing test printed is indented under it.
  const start = plain.findLastIndex(line => /^✖ failing tests:\s*$/.test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (!plain[end]!.trim() || /^\s/.test(plain[end]!) || /^(test at |✖ )/.test(plain[end]!))) end++;
  return lines.slice(start, end).join('\n').replace(/\n+$/, '');
}

/** One git call in the coordinator's object store: the arguments after `git -C <root>`, the child's stdout. */
export type TrialGit = (args: string[], env?: Record<string, string>) => Promise<string>;
export type TrialMergeResult = { mergeSha: string; tree: string } | { conflict: string[] };

export const trialAuthor = 'graphyard-merge-writer';
export const trialRef = (head: string) => `refs/graphyard/trial/${head}`;
const fullSha = /^[0-9a-f]{40}$/;

// A trial keeps FORCE_COLOR, so the runner's summary may carry ANSI escapes before every line it prints.
const ansiEscape = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/**
 * The line a trial's log tail puts where it cut a failing group's output (GY-1639): what follows may
 * be the middle of a `failing tests:` summary whose heading was cut, so it reopens summary reading.
 */
export const trialCutLine = "… (this group's earlier output was cut)";
/**
 * The runner's last `failing tests:` summary in one group's output (GY-1645): its heading through
 * the last line of its entries (each `test at` line, its `✖` test and the indented error), or null
 * when the output carries none. ANSI escapes are ignored when reading where it starts and ends.
 */
export function failingSummary(output: string): string | null {
  const lines = output.split('\n'), plain = lines.map(line => line.replace(ansiEscape, ''));
  // Only the runner's own heading, at column zero: a child run's summary a failing test printed is indented under it.
  const start = plain.findLastIndex(line => /^✖ failing tests:\s*$/.test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (!plain[end]!.trim() || /^\s/.test(plain[end]!) || /^(test at |✖ )/.test(plain[end]!))) end++;
  return lines.slice(start, end).join('\n').replace(/\n+$/, '');
}
const exitOf = (error: unknown) => error as { status?: number | null; stdout?: unknown };

/**
 * The exact merge commit of `head` onto `baseTip`, made without a worktree: `git merge-tree
 * --write-tree` computes the merged tree, `git commit-tree` (authored by graphyard-merge-writer)
 * makes the commit with parents baseTip and head, and the only ref written is
 * `refs/graphyard/trial/<head>`. Nothing under `refs/heads/*`, no remote and no checkout is
 * touched. A conflicting merge gives the conflicted paths and writes no commit. Retention: one
 * ref per tried head, overwritten by that head's next trial and never pruned here, so a recorded
 * verdict's mergeSha keeps resolving, and nothing deletes them.
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
/**
 * Where a trial's temporary directory and short checkout may go, in order: the platform's own, then
 * the coordinator's. They are the roots the loop's tmp reclaim scans (`hostTmpRoots`), so a
 * directory a crashed trial left behind, its owner gone, is taken back by that bounded pass.
 */
export const trialTemporaryRoots = (own = tmpdir()): string[] => [...new Set(['/tmp', own])];
/** Whether `directory` or a folder above it, the filesystem root included, holds an entry an upward lookup would resolve. */
export function lookupPoisoned(directory: string, exists: (path: string) => boolean = existsSync): boolean {
  for (let at = directory; ; at = dirname(at)) {
    if (trialLookupEntries.some(entry => exists(join(at, entry)))) return true;
    if (dirname(at) === at) return false;
  }
}
/**
 * The folder the trial's own temporary directory is made in (GY-1565): the first root no stray
 * node_modules, .git or package.json sits in or above, else the trial's session directory. The
 * host's shared /tmp is not CI's empty one: vishrog's /tmp/node_modules is what
 * tests/worktree-reclaim.test.ts's upward install lookup found first, so its dependency mirror
 * shared nothing. The directory stays short, as CI's is: a socket path or a typed launch line the
 * suite builds under it has a length bound. A root clean when chosen is checked again once the
 * trial ends (`TrialEnvironmentError`): no point-in-time check keeps a shared folder clean.
 */
export const trialTemporaryRoot = (sessionDirectory: string, roots: readonly string[] = trialTemporaryRoots()) =>
  roots.find(root => existsSync(root) && !lookupPoisoned(root)) ?? sessionDirectory;
/**
 * The folder a trial's short checkout is made in (GY-1565): the first of `roots` that passes the
 * managed worktree root's own guard (`verifyWorktreeRoot`: durable storage, not a tmpfs, with
 * `minFreeBytes` free), so a checkout and its `npm ci` tree never fill a memory-backed /tmp, and
 * that no stray node_modules, .git or package.json sits in or above (`lookupPoisoned`), so a module
 * the checkout's own install lacks never resolves upward into a durable host /tmp's stray tree; null
 * when none does, and the checkout stays in the managed session directory.
 */
export async function trialCheckoutRoot(roots: readonly string[], minFreeBytes: number, probe?: FilesystemProbe): Promise<string | null> {
  for (const root of roots) {
    if (!existsSync(root) || lookupPoisoned(root)) continue;
    try { await verifyWorktreeRoot(root, { minFreeBytes, ...(probe ? { probe } : {}) }); return root; } catch { /* the next root */ }
  }
  return null;
}
/**
 * The name prefix of a trial's temporary directory. It stays this short, as CI's /tmp is
 * (`graphyard-trial-` lengthened master-agent-envs' and master-loop-resilience's launch lines past
 * their bound), and it is one of the tmp reclaim's own names (`gy-`), so the loop's pass takes a
 * directory a crashed merge writer left, its owner marker naming a process that is gone.
 */
export const trialTemporaryPrefix = 'gy-t';
/**
 * The name prefix of the short directory a trial's checkout is made in, beside its temporary one
 * (GY-1565). The managed session directory's path (~/.local/share/graphyard/worktrees/<repo>/
 * graphyard-trial-<key>-<sha>-<id>/checkout, 116 bytes on vishrog) put the launch lines
 * master-agent-envs and master-loop-resilience type past `launchCommandLimit`, which CI's
 * 37-byte checkout never reaches: two of GY-1535's ten shadow-only-fails. The session directory
 * still holds the trial's lists and records, and is removed and reclaimed as before.
 */
export const trialCheckoutPrefix = 'gy-c';
/**
 * The mode of a trial's own temporary directory (GY-1639): sticky, as CI's /tmp is, so a suite that
 * holds `tmpdir()` to the sticky-shared-parent rule (tests/runner-executor.test.ts's attested cases)
 * sees the parent CI gives it, yet private to this account, so nothing else can plant a lookup entry
 * in it. mkdtemp's own 0700 is not sticky: every merged head failed runner-executor on it.
 */
export const trialTemporaryMode = 0o1700;
/** The variables that point the trial child's temporary files at `directory`. */
export const trialTemporaryVariables = (directory: string) => ({ TMPDIR: directory, TMP: directory, TEMP: directory });

/**
 * A trial's verdict. `runnerExit` is how the test runner process ended: its exit status, 128 plus the
 * signal number when a signal ended it, -1 when it could not be started or outgrew the capture, and
 * null (or absent, from a trial stub) when no runner ran: a failed install or build, a failed
 * selection, or an empty one.
 */
export interface TrialRun {
  build: 'pass' | 'fail'; tests: { passed: number; failed: string[]; files: number }; durationMs: number; logTail: string; runnerExit?: number | null; groups?: TrialGroup[];
  /** How long each phase took (GY-1832), so the slow one is named; absent only from a trial stub. */
  phases?: TrialPhaseDurations;
  /** The attempts before this one that reached no verdict (GY-1832): a verdict on the retry carries the first attempt's outcome. */
  retried?: TrialNoVerdict[];
}
/** A trial's phases, in order (GY-1832): the checkout and its install, the build, the test selection, the test run. */
export const trialPhases = ['install', 'build', 'selection', 'tests'] as const;
export type TrialPhase = typeof trialPhases[number];
export type TrialPhaseDurations = Record<TrialPhase, number>;
/**
 * How a trial that reached no verdict ended (GY-1832): it outran its deadline, a runner child was
 * cancelled from outside (`trialCancelSignals`), or the host failed it (a runner exit naming no
 * test, a child the host could not start, a poisoned temporary root, a checkout that could not be
 * made or removed). Each names the phase it was in and why, and none is pending.
 */
export type TrialNoVerdictOutcome = 'timeout' | 'cancelled' | 'host-failure';
export interface TrialNoVerdict { outcome: TrialNoVerdictOutcome; phase: TrialPhase; reason: string; phases: TrialPhaseDurations }
/** The signals that end a runner child as cancelled rather than failed: a stop, an interrupt or a hangup sent from outside the trial. */
export const trialCancelSignals: readonly string[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
/** How many times a trial that reached no verdict is tried again before its outcome is final (GY-1832). */
export const trialRetries = 1;
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
/** The groups a selection runs in when a caller fixes the group size: its own order, cut every `size` files, so every file runs once and a failing group is a short list. */
export function groupTestFiles(files: readonly string[], size = trialTestGroupSize): string[][] {
  const bound = Math.max(1, Math.floor(size)), groups: string[][] = [];
  for (let at = 0; at < files.length; at += bound) groups.push(files.slice(at, at + bound));
  return groups;
}
/** How many shards of a trial's tests run at once on a host with `cores` CPUs (GY-1832): half of them, never fewer than one, the rest left to the shards' own test files and the host. */
export const trialShardLanes = (cores: number) => Math.max(1, Math.floor(cores / 2));
/**
 * The lanes a trial's shards run in and each runner's test concurrency (GY-1832): `trialShardLanes`
 * lanes, never more than the shards, each at its share of the cores. A shard's own
 * `--test-concurrency` overrides tests/helpers/run-tests.ts's memory-derived breadth, so where the
 * host's memory is read the files in flight across every lane stay within `affordableFiles` (what
 * that memory affords beyond its floor and recovery margin, `bytesPerSuiteFile` a file): fewer
 * files per runner first, then fewer lanes, never below one of each. An unread host is sized by
 * its cores alone.
 */
export function trialShardBreadth(cores: number, shards: number, affordableFiles: number | null = null): { lanes: number; breadth: number } {
  let lanes = Math.max(1, Math.min(trialShardLanes(cores), shards));
  let breadth = Math.max(1, Math.floor(cores / lanes));
  if (affordableFiles !== null && Number.isFinite(affordableFiles)) {
    const files = Math.max(1, Math.floor(affordableFiles));
    lanes = Math.min(lanes, files);
    breadth = Math.max(1, Math.min(breadth, Math.floor(files / lanes)));
  }
  return { lanes, breadth };
}
/**
 * The files the host's memory affords a trial's shards at once (GY-1832), or null when it cannot be
 * read: available memory less the floor and the recovery margin the loop defers launches at,
 * `bytesPerSuiteFile` a file, less the files runs holding the host's verification slots under
 * `slots` declared and may not yet have allocated — as tests/helpers/run-tests.ts's breadth
 * deducts them, since the shards' environment carries no slot of their own.
 */
export async function trialAffordableFiles(read?: () => Promise<HostMemoryReading | null>, slots?: string): Promise<number | null> {
  const resources = await import('../master-resources.js'), { bytesPerSuiteFile, othersDeclaredFiles } = await import('../master/verification-slots.js');
  const reading = await (read ?? resources.readHostMemory)();
  if (!reading) return null;
  return Math.floor((reading.availableBytes - resources.hostMemoryFloor(reading.totalBytes) - resources.memoryRecoveryMarginBytes) / bytesPerSuiteFile) - (slots ? othersDeclaredFiles(slots) : 0);
}
/** The first slot index a trial declares at: past any bound a host hands out, so no run ever takes or waits on it. */
export const trialDeclarationSlot = 1000;
const trialLabel = 'merge trial';
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
/**
 * Declare the shards' `files` on the host's verification slots under `directory` while they run
 * (GY-1832), so a suite that starts after the trial's memory reading deducts them before they
 * allocate, as it deducts a slot holder's: a `slot-N` entry from `trialDeclarationSlot` up, whose
 * owner names the files, which no run takes or waits on, in a directory sessions' launches made. The returned release removes it; a trial
 * entry whose pid no longer runs is removed by the next declaration. Best-effort: one that cannot
 * be written leaves the trial as it was.
 */
export async function declareTrialFiles(directory: string, key: string, files: number, pid = process.pid, alive: (pid: number) => boolean = running): Promise<() => Promise<void>> {
  if (!(files >= 1)) return async () => {};
  try {
    // Only where sessions' launches made the directory: a host with none runs no bounded suite to tell.
    const names = await readdir(directory);
    for (const name of names) {
      const index = /^slot-(\d+)$/.exec(name)?.[1];
      if (index === undefined || Number(index) < trialDeclarationSlot) continue;
      const owner = await readFile(join(directory, name, 'owner.json'), 'utf8').then(text => JSON.parse(text) as { pid?: unknown; label?: unknown }, () => null);
      if (owner && typeof owner.label === 'string' && owner.label.startsWith(trialLabel) && typeof owner.pid === 'number' && owner.pid !== pid && !alive(owner.pid))
        await rm(join(directory, name), { recursive: true, force: true });
    }
    const writing = join(directory, `.taking-trial-${pid}-${randomUUID()}`);
    await mkdir(writing);
    await writeFile(join(writing, 'owner.json'), JSON.stringify({ pid, label: `${trialLabel} ${key}`, cwd: process.cwd(), at: new Date().toISOString(), files: Math.floor(files) }));
    for (let slot = trialDeclarationSlot; slot < trialDeclarationSlot + 1000; slot++) {
      const path = join(directory, `slot-${slot}`);
      try { await rename(writing, path); }
      catch (error) { if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; break; }
      return async () => { await rm(path, { recursive: true, force: true }).catch(() => {}); };
    }
    await rm(writing, { recursive: true, force: true });
  } catch { /* the trial runs as it would have; only the budget sharing is lost */ }
  return async () => {};
}
/**
 * The shards a selection runs in (GY-1832): as many as the lanes, never more than the files, and
 * never fewer than keep every shard within `size` files (one runner process per shard, so none
 * outgrows the capture, GY-1548). Files go longest first, by the merge's own timing baseline
 * (`durations`, tests/helpers/timing-baseline.json; a file it lacks counts as its median file),
 * each onto the shard with the least time so far that has room, as CI's `--shard` does, and each
 * shard keeps its files longest first. Every file runs once; the split is deterministic.
 */
export function shardTestFiles(files: readonly string[], lanes: number, durations: Readonly<Record<string, number>> = {}, size = trialTestGroupSize): string[][] {
  const unique = [...new Set(files)], bound = Math.max(1, Math.floor(size));
  if (!unique.length) return [];
  const count = Math.min(unique.length, Math.max(Math.max(1, Math.floor(lanes)), Math.ceil(unique.length / bound)));
  const known = Object.values(durations).filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)]! : 1000, weight = (file: string) => Number.isFinite(durations[file]) ? durations[file]! : fallback;
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], durationMs: 0 }));
  for (const file of unique.sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = shards.filter(shard => shard.files.length < bound).reduce((best, shard) => shard.durationMs < best.durationMs ? shard : best);
    lightest.files.push(file); lightest.durationMs += weight(file);
  }
  return shards.map(shard => shard.files).filter(shard => shard.length);
}
/** The merge's own timing baseline in its checkout, `{}` when it has none or it does not parse. */
const checkoutDurations = (worktree: string): Promise<Record<string, number>> => readFile(join(worktree, 'tests/helpers/timing-baseline.json'), 'utf8')
  .then(text => { const files = (JSON.parse(text) as { files?: unknown } | null)?.files; return files && typeof files === 'object' ? files as Record<string, number> : {}; })
  .catch(() => ({}));
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
  constructor(readonly phase: 'install' | 'build' | 'selection' | 'tests', readonly status: number | null, readonly signal: string | null, readonly files: string[], readonly finished: number, readonly outputTail: string, readonly mergeSha: string, readonly durationMs: number) {
    super(`The trial's ${phase} runner exited (${signal ? `signal ${signal}` : `status ${status ?? 'unknown'}`}) naming no failing test${files.length ? `; ${finished} of its ${files.length} file(s) finished` : ''}`);
    this.name = 'TrialRunnerError';
  }
}
/**
 * A trial directory could not be removed afterwards, so it is left behind: the session directory
 * under the managed root (the orphan reclaim removes it later), or the temporary or short checkout
 * directory, its owner marker dropped so the tmp reclaim takes it once it ages (GY-1565).
 * `directory` is the one that failed. The verdict the trial reached, if it reached one, rides
 * along so the failure is recorded beside it rather than in place of it.
 */
export class TrialCleanupError extends Error {
  constructor(readonly directory: string, readonly verdict: TrialRun | null, readonly cause: unknown, outcome: string) {
    super(`The trial checkout ${directory} was not removed (${cause instanceof Error ? cause.message : String(cause)}); ${outcome}`);
    this.name = 'TrialCleanupError';
  }
}
/**
 * The folder the trial's temporary directory was made in was clean when chosen but holds a stray
 * node_modules, .git or package.json in or above it once the trial ends (GY-1565): an upward lookup
 * from the trial may have resolved it, so whatever the trial answered measures the host, and it is
 * no verdict. The next trial chooses its root afresh.
 */
export class TrialEnvironmentError extends Error {
  constructor(readonly root: string) {
    super(`The trial's temporary root ${root} gained a node_modules, .git or package.json in or above it during the trial, so the trial's answer is no verdict`);
    this.name = 'TrialEnvironmentError';
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
  /** The most files one runner process runs; `trialTestGroupSize` unless a test narrows it. A caller's own size cuts the selection in its order instead of sharding it by the timing baseline. */
  groupSize?: number;
  /** The host's CPUs the shards are sized to (GY-1832); `availableParallelism()` unless a test names a count. */
  cores?: number;
  /** The host's memory the shards' files in flight are bounded by (GY-1832); `readHostMemory` unless a test names a reading. */
  memory?: () => Promise<HostMemoryReading | null>;
  /** How many times a trial that reached no verdict is tried again; `trialRetries` unless a test names another. */
  retries?: number;
  /** Called as each attempt starts, before it runs anything (GY-1832): a caller keeping attempt-scoped evidence starts it afresh. */
  onAttempt?: (attempt: number) => void;
  /** Where the trial's temporary directory and short checkout may go; `trialTemporaryRoots()` unless a test names others. */
  temporaryRoots?: readonly string[];
  /** The free space a short checkout's root must have, and how it is measured: the managed worktree root's default and probe unless given. */
  minFreeBytes?: number;
  probe?: FilesystemProbe;
}
const tailLength = 4000;
/**
 * The log tail of a trial whose test groups named failing files and whose whole log outgrew the
 * tail (GY-1639): each failing group's own output, its command line and the end of what it printed
 * (the runner's `failing tests:` summary and the exit) after `trialCutLine`, sharing `tailLength` evenly. The whole
 * log's last characters are the last group's, and in a full selection that group passed, so they
 * named no failing cause. A group whose output carries a summary keeps that summary and its exit
 * line, not whatever it printed after (GY-1645), and a summary cut to its share starts at a whole
 * entry, its `test at` line, so the first test it names keeps its file whatever the command's length.
 */
export function failureTail(outputs: readonly string[], length = tailLength): string {
  const share = Math.floor((length - (outputs.length - 1)) / Math.max(1, outputs.length)), cut = `${trialCutLine}\n`;
  return outputs.map(output => {
    if (output.length <= share) return output;
    const line = output.slice(0, output.indexOf('\n') + 1), command = line.length < share / 2 ? line : '';
    const summary = failingSummary(output), exit = summary ? /\n(\[exit [^\n]*\])\s*$/.exec(output)?.[1] : undefined;
    const end = exit ? `\n${exit}` : '', room = Math.max(0, share - command.length - cut.length - end.length);
    if (summary && summary.length <= room) return `${command}${cut}${summary}${end}`;
    // The cut output starts at a whole line after `trialCutLine`, so a summary whose heading was cut still names its tests.
    const kept = (summary ?? output).slice(-room), whole = kept.slice(kept.indexOf('\n') + 1), entry = summary ? whole.search(/^test at /m) : -1;
    return `${command}${cut}${entry > 0 ? whole.slice(entry) : whole}${end}`;
  }).join('\n').slice(-length);
}
const testFile = /tests\/[\w./-]+\.test\.ts/g;
const testFileLine = /^tests\/[\w./-]+\.test\.ts$/;
/**
 * The failing files a runner log names, for a runner whose records are missing. A file-level
 * failure is a `not ok`/`✖` line carrying the path; a failing case inside a file is reported as
 * `✖ <case title>` and its file only on the `test at tests/x.test.ts:line:col` line that follows,
 * so both are read (GY-1549: reading only the first kind counted every such file as passed). Given
 * the files the runner ran, only those count (GY-1645): a name printed inside a test's own output,
 * such as a fixture's `test at tests/c.test.ts:1:1` in an assertion message, is no failing file.
 */
export function failingFilesInLog(out: string, ran?: readonly string[]): string[] {
  const files = new Set<string>();
  for (const line of out.split('\n')) {
    if (/not ok|✖|FAIL/.test(line)) for (const file of line.match(testFile) ?? []) files.add(file);
    const located = /^\s*test at (tests\/[\w./-]+\.test\.ts):\d+:\d+/.exec(line);
    if (located) files.add(located[1]!);
  }
  return [...files].filter(file => !ran || ran.includes(file));
}
/** The runner's per-file records (`--durations FILE`, tests/helpers/file-durations.mjs): one JSON line per file that ran, with whether it passed. */
export function runnerRecords(text: string): { file: string; passed: boolean }[] {
  return text.split('\n').flatMap(line => {
    try { const record = JSON.parse(line) as { file?: unknown; passed?: unknown }; return typeof record.file === 'string' ? [{ file: record.file, passed: record.passed !== false }] : []; }
    catch { return []; }
  });
}

/** What a failed attempt's error was, beyond its own fields: the phase it ended in and every phase's time so far (GY-1832). */
const attemptContext = new WeakMap<object, { phase: TrialPhase; phases: TrialPhaseDurations; attempts?: TrialNoVerdict[] }>();
/**
 * The outcome of a trial attempt that rejected (GY-1832): a timeout, a cancelled runner child or a
 * host failure, with the phase it was in, the reason and the phases' times. A runner child ended
 * by `trialCancelSignals` is cancelled; every other rejection, whatever its class, is the host's.
 */
export function trialNoVerdict(error: unknown): TrialNoVerdict {
  const context = typeof error === 'object' && error ? attemptContext.get(error) : undefined;
  const phases = context?.phases ?? { install: 0, build: 0, selection: 0, tests: 0 }, reason = (error instanceof Error ? error.message : String(error)).slice(0, 900);
  if (error instanceof TrialTimeoutError) return { outcome: 'timeout', phase: error.phase, reason, phases };
  if (error instanceof TrialRunnerError) return { outcome: error.signal && trialCancelSignals.includes(error.signal) ? 'cancelled' : 'host-failure', phase: error.phase, reason, phases };
  return { outcome: 'host-failure', phase: context?.phase ?? 'install', reason, phases };
}
/** Every attempt of a trial that ended with `error` and reached no verdict, oldest first (GY-1832); one entry for an error no retry wrapped. */
export const trialAttempts = (error: unknown): TrialNoVerdict[] => (typeof error === 'object' && error ? attemptContext.get(error)?.attempts : undefined) ?? [trialNoVerdict(error)];

/**
 * The trial of a merge commit (`runTrialAttempt`), tried again once (`trialRetries`) when it
 * reaches no verdict (GY-1832): a timeout, a cancelled runner child or a host failure measures the
 * host, not the merge, so a fresh checkout and deadline get one more go. A verdict on the retry
 * carries the first attempt's outcome as `retried`. When the retry reaches none either, it rejects
 * with the last attempt's error, whose every attempt (`trialAttempts`) names its outcome, phase,
 * reason and phase times, so the trial's record is that outcome and never left pending. A checkout
 * that would not go after a verdict (TrialCleanupError with a verdict) is that verdict, not retried.
 */
export async function runTrial(input: RunTrialInput): Promise<TrialRun> {
  const attempts: TrialNoVerdict[] = [], retries = Math.max(0, Math.floor(input.retries ?? trialRetries));
  for (let attempt = 0; ; attempt++) {
    try {
      input.onAttempt?.(attempt);
      const verdict = await runTrialAttempt(input);
      return attempts.length ? { ...verdict, retried: attempts } : verdict;
    } catch (error) {
      if (error instanceof TrialCleanupError && error.verdict) { if (attempts.length) error.verdict.retried = attempts; throw error; }
      attempts.push(trialNoVerdict(error));
      if (attempt >= retries) {
        if (typeof error === 'object' && error) attemptContext.set(error, { ...(attemptContext.get(error) ?? { phase: attempts.at(-1)!.phase, phases: attempts.at(-1)!.phases }), attempts });
        throw error;
      }
    }
  }
}

/**
 * One attempt of a trial. Check the merge commit out detached as a `trial` checkout (in a short directory beside the trial's
 * temporary one when a clean root is found), run `npm run build`, then the affected
 * pre-merge selection of scripts/ci-tests.mjs through tests/helpers/run-tests.ts, all under one
 * deadline and `trialEnvironment` with the trial's own empty temporary directory. The runner
 * always gets a selected file list, so a full selection runs every pre-merge file and never the
 * release-candidate suites, and the verdict counts the files that ran. The selection runs in
 * parallel shards sized to the host (GY-1832, `shardTestFiles`: `trialShardLanes(cores)` at once,
 * none over `trialTestGroupSize` files), each its own runner process over the same checkout at a
 * test concurrency of its share of the cores, and with the files in flight across them within what
 * the host's memory affords (`trialShardBreadth`), so they stay near one process's;
 * the verdict's failing files are the union the shards' records name, and `groups` says how each
 * process ended, in shard order. Each phase's time is recorded (`phases`). The checkout is removed
 * afterwards, pass or fail; a removal that fails rejects with TrialCleanupError carrying the
 * verdict. Past the deadline it rejects with TrialTimeoutError, and a runner that ends naming no
 * failing test with TrialRunnerError: neither is a verdict against the merge.
 */
export async function runTrialAttempt(input: RunTrialInput): Promise<TrialRun> {
  const run = input.run ?? defaultChildRun, now = input.now ?? Date.now, startedAt = now(), deadline = startedAt + input.timeoutMs;
  const phases: TrialPhaseDurations = { install: 0, build: 0, selection: 0, tests: 0 };
  let phase: TrialPhase = 'install', phaseAt = startedAt;
  /** Closes the running phase's time and opens `next`'s; with no `next`, answers every phase's time so far. */
  const enter = (next: TrialPhase = phase) => { const at = now(); phases[phase] += Math.max(0, at - phaseAt); phase = next; phaseAt = at; return { ...phases }; };
  const checkout = await allocateSessionCheckout(input.base, 'trial', input.key ?? 'trial', input.mergeSha, randomUUID());
  // A fresh, empty temporary directory made for this trial alone, and a short one its checkout goes in on a durable root
  // with room (else the session directory's checkout), each removed with the session and marked as this process's so a
  // crash before the cleanup leaves it to the tmp reclaim.
  const roots = input.temporaryRoots ?? trialTemporaryRoots();
  let temporary: string | null = null, place: string | null = null, worktree = checkout.worktree, guarded: string | null = null;
  const clear = async (directory: string) => {
    // A directory that would not go loses its owner marker, so the tmp reclaim takes it once it ages rather than keeping it for this live process.
    try { await rm(directory, { recursive: true, force: true }); } finally { await rm(tempOwnerMarker(directory), { force: true }).catch(() => {}); }
  };
  try {
    const root = trialTemporaryRoot(checkout.directory, roots);
    if (root !== checkout.directory) guarded = root;
    temporary = await mkdtemp(join(root, trialTemporaryPrefix)); await chmod(temporary, trialTemporaryMode); await writeTempOwner(temporary);
    const near = await trialCheckoutRoot(roots, input.minFreeBytes ?? defaultWorktreeRootMinFreeGb * 1e9, input.probe);
    if (near) { place = await mkdtemp(join(near, trialCheckoutPrefix)); await writeTempOwner(place); worktree = join(place, 'checkout'); }
  }
  catch (error) {
    for (const made of [temporary, place]) if (made) await clear(made).catch(() => {});
    await (input.remove ?? removeSessionCheckout)(input.root, input.base, checkout.directory, input.run).catch(() => {});
    if (typeof error === 'object' && error) attemptContext.set(error, { phase, phases: enter() });
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
  // A shard's output goes to its own `entries` while the shards run, so the log keeps shard order whichever finishes first.
  const child = async (phase: TrialTimeoutError['phase'], command: string, args: string[], options: { env?: NodeJS.ProcessEnv; entries?: string[] } = {}): Promise<Ended> => {
    const entries = options.entries ?? log;
    let out: string;
    try { out = String(await run(command, args, { cwd: worktree, env: (options.env ?? env) as Record<string, string>, timeoutMs: remaining() })); }
    catch (error) {
      const out = output(error);
      const ended = endedOf(error, out);
      entries.push(`$ ${command} ${args.join(' ')}\n${out}\n${ending({ status: ended.status, signal: ended.signal, cause: ended.cause })}`);
      if ((error as { timedOut?: boolean }).timedOut || now() >= deadline) throw new TrialTimeoutError(phase, Math.max(0, now() - startedAt), tail());
      return ended;
    }
    entries.push(`$ ${command} ${args.join(' ')}\n${out}`);
    if (now() >= deadline) throw new TrialTimeoutError(phase, Math.max(0, now() - startedAt), tail());
    return { ok: true, out, status: 0, signal: null, cause: undefined };
  };
  // A child a signal ended, or one the host could not start or capture, says nothing about the merge.
  const hostEnded = (ended: Ended) => !ended.ok && (ended.signal !== null || ended.cause !== undefined);
  const runnerFailure = (phase: TrialRunnerError['phase'], ended: Ended, files: string[] = [], finished = 0) =>
    new TrialRunnerError(phase, ended.status, ended.signal, files, finished, `${ended.out}\n${ending({ status: ended.status, signal: ended.signal, cause: ended.cause })}`.slice(-runnerDiagnosticTailLength), input.mergeSha, Math.max(0, now() - startedAt));
  const finish = (build: TrialRun['build'], tests: TrialRun['tests'], runnerExit: number | null = null, groups?: TrialGroup[], logTail = tail()): TrialRun => ({ build, tests, durationMs: Math.max(0, now() - startedAt), logTail, runnerExit, ...(groups ? { groups } : {}), phases: enter() });
  const listed = (out: string) => out.split('\n').map(line => line.trim()).filter(line => testFileLine.test(line));
  const trial = async (): Promise<TrialRun> => {
    try {
      await run('git', ['-C', input.root, 'worktree', 'add', '--detach', worktree, input.mergeSha], { timeoutMs: remaining() });
      // The merge builds against its own dependencies: the coordinator's install when its lockfile is byte-identical to the merge's, else an `npm ci` of the merge's lockfile.
      // A repository the merge does not make a Node package installs and builds nothing, and one without
      // scripts/ci-tests.mjs selects no tests. Each is read from the merge commit itself, never from the
      // trial checkout, so an unreadable checkout file never skips a phase the merge carries. Only a
      // listing that answers and names no such path is absence: a probe git could not answer (a timeout,
      // an unreadable object store) is a runner failure, never a passing trial that skipped its checks.
      const holds = async (path: string) => {
        try { await run('git', ['-C', input.root, 'cat-file', '-e', `${input.mergeSha}:${path}`], { timeoutMs: remaining() }); return true; }
        catch { /* absent, or unreadable: the listing below tells them apart */ }
        let listing: string;
        try { listing = String(await run('git', ['-C', input.root, 'ls-tree', '--name-only', input.mergeSha, '--', path], { timeoutMs: remaining() })); }
        catch (error) {
          const out = output(error);
          log.push(`$ git ls-tree --name-only ${input.mergeSha} -- ${path}\n${out}\n${ending(error)}`);
          if ((error as { timedOut?: boolean }).timedOut || now() >= deadline) throw new TrialTimeoutError('install', Math.max(0, now() - startedAt), tail());
          const ended = endedOf(error, out);
          throw runnerFailure('install', { ...ended, cause: ended.cause ?? `could not read ${path} from ${input.mergeSha.slice(0, 12)}` });
        }
        return listing.split('\n').some(line => line.trim() === path);
      };
      if (await holds('package.json')) {
        const lockfile = (dir: string) => readFile(join(dir, 'package-lock.json'), 'utf8').catch(() => null);
        const [own, merged] = await Promise.all([lockfile(input.root), lockfile(worktree)]);
        if (existsSync(join(input.root, 'node_modules')) && own !== null && own === merged) await symlink(join(input.root, 'node_modules'), join(worktree, 'node_modules'));
        else if (await holds('package-lock.json')) {
          const installed = await child('install', 'npm', npmCiArgs, { env: npmCiEnvironment(env) });
          if (hostEnded(installed)) throw runnerFailure('install', installed);
          if (!installed.ok) return finish('fail', { passed: 0, failed: [], files: 0 });
        }
        const manifest = await readFile(join(worktree, 'package.json'), 'utf8').catch(() => undefined);
        // An unreadable package.json builds as before; one the merge broke is its failed build, never the host's (PRRT_kwDOUZby-s6tZsNG); only one that declares no build script skips it.
        let scripts: { build?: unknown } | undefined;
        try { scripts = manifest === undefined ? undefined : JSON.parse(manifest)?.scripts; } catch { enter('build'); return finish('fail', { passed: 0, failed: [], files: 0 }); }
        if (scripts === undefined || scripts?.build) {
          enter('build');
          const built = await child('build', 'npm', ['run', 'build']);
          if (hostEnded(built)) throw runnerFailure('build', built);
          if (!built.ok) return finish('fail', { passed: 0, failed: [], files: 0 });
        }
      }
      if (!await holds('scripts/ci-tests.mjs')) return finish('pass', { passed: 0, failed: [], files: 0 });
      enter('selection');
      // A selection child the host killed or could not start is no verdict (GY-1832); only one that exits non-zero fails the selection.
      const selection = await child('selection', 'node', ['scripts/ci-tests.mjs', 'affected', ...input.changedFiles]);
      if (hostEnded(selection)) throw runnerFailure('selection', selection);
      if (!selection.ok) return finish('pass', { passed: 0, failed: ['scripts/ci-tests.mjs affected'], files: 0 });
      let files = listed(selection.out);
      // A merge whose own ci-tests predates GY-1522 lists no files for a full selection; `select` outside Actions lists exactly the pre-merge suite.
      if (!files.length && /^full:/.test(selection.out.trimStart())) {
        const full = await child('selection', 'node', ['scripts/ci-tests.mjs', 'select']);
        if (hostEnded(full)) throw runnerFailure('selection', full);
        if (!full.ok) return finish('pass', { passed: 0, failed: ['scripts/ci-tests.mjs select'], files: 0 });
        files = listed(full.out);
      }
      // An affected selection of nothing runs nothing.
      if (!files.length) return finish('pass', { passed: 0, failed: [], files: 0 });
      enter('tests');
      // Each shard is one runner process over the same checkout, `lanes` of them at once. Failing per-file
      // records decide which files failed; the human-readable log is read when those records name none —
      // including a partial-record run that finished some files and printed a named failure for another
      // (GY-1548). A shard that ends non-zero naming no failing file is a runner failure, unless another
      // shard named one: a named failing test is the merge's, and stays a failing verdict.
      const cores = Math.max(1, Math.floor(input.cores ?? availableParallelism()));
      const shards = input.groupSize === undefined ? shardTestFiles(files, trialShardLanes(cores), await checkoutDurations(worktree)) : groupTestFiles(files, input.groupSize);
      const slotsDirectory = (await import('../master/verification-slots.js')).verificationSlotsDirectory(input.base);
      const { lanes, breadth } = trialShardBreadth(cores, shards.length, await trialAffordableFiles(input.memory, slotsDirectory));
      const settledShards: ({ group: TrialGroup; entries: string[]; unattributed: TrialRunnerError | null } | undefined)[] = [];
      let next = 0, stopped: unknown = null;
      const lane = async () => {
        // A lane takes the next shard until none is left or another lane's shard ended the trial; a running shard is always awaited, never orphaned.
        while (stopped === null && next < shards.length) {
          const index = next++, group = shards[index]!, entries: string[] = [];
          try {
            const list = join(checkout.directory, `tests-${index + 1}.txt`), records = join(checkout.directory, `tests-${index + 1}.jsonl`);
            await writeFile(list, `${group.join('\n')}\n`);
            const tests = await child('tests', 'node', ['--import', 'tsx', 'tests/helpers/run-tests.ts', '--files-from', list, '--durations', records, `--test-concurrency=${breadth}`], { entries });
            const recorded = runnerRecords(await readFile(records, 'utf8').catch(() => ''));
            // Only the shard's own files count: the records and the log may name a file a test ran or printed itself (GY-1645).
            const namedByRecords = recorded.filter(record => !record.passed && group.includes(record.file)).map(record => record.file);
            const failing = [...new Set(namedByRecords.length ? namedByRecords : tests.ok ? [] : failingFilesInLog(tests.out, group))];
            settledShards[index] = { group: { files: group, status: tests.status, signal: tests.signal, failed: failing }, entries,
              unattributed: !tests.ok && !failing.length ? runnerFailure('tests', tests, group, recorded.filter(record => group.includes(record.file)).length) : null };
          } catch (error) { log.push(...entries); stopped ??= error; }
        }
      };
      // The shards' files stay declared on the host's verification slots until every shard stops, so a suite that starts meanwhile deducts them before they allocate.
      const release = await declareTrialFiles(slotsDirectory, input.key ?? input.mergeSha.slice(0, 12), lanes * breadth);
      try { await Promise.all(Array.from({ length: lanes }, lane)); } finally { await release(); }
      const ran = settledShards.filter(shard => shard !== undefined);
      for (const shard of ran) log.push(...shard.entries);
      // A shard past the deadline ends the trial as a timeout once every shard has stopped, its log holding what the others printed.
      if (stopped instanceof TrialTimeoutError) throw new TrialTimeoutError('tests', Math.max(0, now() - startedAt), tail());
      if (stopped !== null) throw stopped;
      const groups = ran.map(shard => shard.group), failingOutput = ran.filter(shard => shard.group.failed.length).map(shard => shard.entries.at(-1)!);
      const unattributed = ran.find(shard => shard.unattributed)?.unattributed ?? null;
      const failed = [...new Set(groups.flatMap(group => group.failed))];
      if (!failed.length && unattributed) throw unattributed;
      const worst = groups.find(group => group.status !== 0);
      return finish('pass', { passed: Math.max(0, files.length - failed.length), failed, files: files.length }, worst ? exitCode({ status: worst.status, signal: worst.signal, cause: undefined }) : 0, groups,
        failingOutput.length && log.join('\n').length > tailLength ? failureTail(failingOutput) : tail());
    } catch (error) {
      if (error instanceof TrialTimeoutError || error instanceof TrialRunnerError) throw error;
      log.push(`trial checkout failed: ${error instanceof Error ? error.message : String(error)}`);
      if ((error as { timedOut?: boolean }).timedOut || now() >= deadline) throw new TrialTimeoutError(phase, Math.max(0, now() - startedAt), tail());
      // A checkout git could not make, a list or link the host could not write: the host's failure, not the merge's (GY-1832), so no verdict.
      throw error;
    }
  };
  // The checkout goes whatever the trial did; a removal that fails is reported, never swallowed.
  let settled: { verdict: TrialRun } | { error: unknown };
  try { settled = { verdict: await trial() }; } catch (error) { settled = { error }; }
  // An attempt that reached no verdict keeps the phase it ended in and every phase's time (GY-1832).
  if ('error' in settled && typeof settled.error === 'object' && settled.error) attemptContext.set(settled.error, { phase, phases: enter() });
  // A root that was clean when chosen and is not now may have shadowed the trial's lookups: whatever it answered is no verdict.
  if (guarded && lookupPoisoned(guarded)) { settled = { error: new TrialEnvironmentError(guarded) }; attemptContext.set(settled.error as object, { phase, phases: enter() }); }
  // The temporary directory goes with it: a failure to remove any is the cleanup's, naming the directory, and none stops the others.
  // The short checkout's files go first, so the session's removal prunes its registration in the repository.
  const failures: { directory: string; cause: unknown }[] = [];
  for (const directory of [temporary, ...(place ? [place] : [])]) await clear(directory).catch(cause => { failures.push({ directory, cause }); });
  await (input.remove ?? removeSessionCheckout)(input.root, input.base, checkout.directory, input.run).catch(cause => { failures.push({ directory: checkout.directory, cause }); });
  const failure = failures[0];
  if (failure) {
    const outcome = 'verdict' in settled ? `the trial itself answered build ${settled.verdict.build}, ${settled.verdict.tests.failed.length} failing test file(s)` : `the trial itself failed: ${settled.error instanceof Error ? settled.error.message : String(settled.error)}`;
    const cleanup = new TrialCleanupError(failure.directory, 'verdict' in settled ? settled.verdict : null, failure.cause, outcome);
    attemptContext.set(cleanup, { phase, phases: enter() });
    throw cleanup;
  }
  if ('error' in settled) throw settled.error;
  return settled.verdict;
}
