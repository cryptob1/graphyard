// Concern: the shadow gate's trial merge — the exact merge commit of a head onto main, and its build and affected tests in a credential-free checkout.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, symlink, writeFile } from 'node:fs/promises';
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

/** The variables a trial child never sees, besides every GRAPHYARD_* and HERDR_* one. */
export const withheldTrialVariables = ['GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND'] as const;
/** The trial child's environment: the isolated test one, with every credential and Graphyard control removed and git's global configuration off. */
export function trialEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(isolatedTestEnvironment(environment)).filter(([name]) => !/^(GRAPHYARD|HERDR)_/.test(name) && !(withheldTrialVariables as readonly string[]).includes(name)));
  return { ...kept, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
}

export interface TrialRun { build: 'pass' | 'fail'; tests: { passed: number; failed: string[]; files: number }; durationMs: number; logTail: string }
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
}
const tailLength = 4000;
const testFile = /tests\/[\w./-]+\.test\.ts/g;

/**
 * Check the merge commit out detached as a `trial` checkout, run `npm run build`, then the affected
 * pre-merge selection of scripts/ci-tests.mjs through tests/helpers/run-tests.ts, all under one
 * deadline and `trialEnvironment`. The checkout is removed afterwards, pass or fail. Past the
 * deadline it rejects with TrialTimeoutError: a timeout is no verdict against the merge.
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
  const child = async (phase: TrialTimeoutError['phase'], command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
    let out: string;
    try { out = String(await run(command, args, { cwd: checkout.worktree, env: (options.env ?? env) as Record<string, string>, timeoutMs: remaining() })); }
    catch (error) {
      const out = output(error);
      log.push(`$ ${command} ${args.join(' ')}\n${out}`);
      if ((error as { timedOut?: boolean }).timedOut || now() >= deadline) throw new TrialTimeoutError(phase, Math.max(0, now() - startedAt), tail());
      return { ok: false, out };
    }
    log.push(`$ ${command} ${args.join(' ')}\n${out}`);
    if (now() >= deadline) throw new TrialTimeoutError(phase, Math.max(0, now() - startedAt), tail());
    return { ok: true, out };
  };
  const finish = (build: TrialRun['build'], tests: TrialRun['tests']): TrialRun => ({ build, tests, durationMs: Math.max(0, now() - startedAt), logTail: tail() });
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
    const lines = selection.out.split('\n').map(line => line.trim()).filter(Boolean);
    const full = /^full:/.test(lines[0] ?? '');
    const files = full ? [] : lines.slice(1).filter(line => /\.test\.ts$/.test(line));
    const countOf = full ? 0 : files.length;
    // An affected selection of nothing runs nothing; a full selection runs the runner's whole suite.
    if (!full && !files.length) return finish('pass', { passed: 0, failed: [], files: 0 });
    const list = join(checkout.directory, 'affected-tests.txt');
    await writeFile(list, `${files.join('\n')}\n`);
    const tests = await child('tests', 'node', ['--import', 'tsx', 'tests/helpers/run-tests.ts', ...(full ? [] : ['--files-from', list])]);
    if (tests.ok) return finish('pass', { passed: countOf, failed: [], files: countOf });
    const failing = [...new Set(tests.out.split('\n').filter(line => /not ok|✖|FAIL/.test(line)).flatMap(line => line.match(testFile) ?? []))];
    return finish('pass', { passed: Math.max(0, countOf - failing.length), failed: failing.length ? failing : ['tests/helpers/run-tests.ts'], files: countOf });
  } catch (error) {
    if (error instanceof TrialTimeoutError) throw error;
    log.push(`trial checkout failed: ${error instanceof Error ? error.message : String(error)}`);
    if ((error as { timedOut?: boolean }).timedOut || now() >= deadline) throw new TrialTimeoutError('install', Math.max(0, now() - startedAt), tail());
    return finish('fail', { passed: 0, failed: [], files: 0 });
  } finally {
    await removeSessionCheckout(input.root, input.base, checkout.directory, input.run).catch(() => {});
  }
}
