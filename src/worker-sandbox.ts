import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * What a worker session must be able to write, and how each runtime's sandbox is made to allow it.
 *
 * A worker edits its worktree, commits, runs `graphyard sync` (a `git fetch` writes FETCH_HEAD, a
 * merge writes the index and MERGE_HEAD) and pushes. A linked worktree keeps that state outside
 * itself: its own administrative directory is `<common>/.git/worktrees/<name>`, and objects and
 * refs live in the common Git directory. Codex's workspace-write sandbox protects every `.git` it
 * finds under a writable root, following a worktree's `gitdir:` pointer too, so granting the
 * common directory alone leaves the worktree's own admin directory read-only; only an explicit
 * grant of that exact path lifts it (GY-134).
 */
export interface WorkerPaths { worktree: string; gitDir: string | null; commonDir: string | null }

type Git = (cwd: string, args: string[]) => string;
const git: Git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export function workerPaths(worktree: string, run: Git = git): WorkerPaths {
  const ask = (...args: string[]) => { try { return run(worktree, args) || null; } catch { return null; } };
  return { worktree, gitDir: ask('rev-parse', '--absolute-git-dir'), commonDir: ask('rev-parse', '--path-format=absolute', '--git-common-dir') };
}
export const writablePaths = (paths: WorkerPaths) => [...new Set([paths.worktree, paths.gitDir, paths.commonDir].filter((path): path is string => !!path))];

/** A runtime whose launch arguments carry a filesystem sandbox, and how that sandbox is granted and probed. */
export interface RuntimeSandbox {
  /** The write-restricting mode the arguments select, or null when they leave writes unrestricted. */
  mode: (args: string[]) => string | null;
  grant: (paths: string[]) => string[];
  /** The command that runs `script` inside the same sandbox the arguments describe. */
  probe: (args: string[], cwd: string, script: string[]) => { command: string; args: string[] };
}

const flagValue = (args: string[], ...flags: string[]) => {
  let value: string | null = null;
  args.forEach((arg, index) => {
    if (flags.includes(arg) && index + 1 < args.length) value = args[index + 1];
    for (const flag of flags) if (arg.startsWith(`${flag}=`)) value = arg.slice(flag.length + 1);
  });
  return value as string | null;
};
const probeProfile = 'graphyard-launch-probe';

export const runtimeSandboxes: Record<string, RuntimeSandbox> = {
  codex: {
    mode: args => {
      const mode = flagValue(args, '--sandbox', '-s');
      return mode === 'danger-full-access' ? null : mode;
    },
    grant: paths => paths.flatMap(path => ['--add-dir', path]),
    // `codex sandbox` takes a permissions profile rather than the legacy mode flag, so the probe
    // states the same policy as one: the session's own root and every `--add-dir` writable under
    // workspace-write, nothing writable under read-only. Codex applies its `.git` protection to
    // the profile exactly as it does to the mode, which is what makes the probe meaningful.
    probe: (args, cwd, script) => {
      const writable = runtimeSandboxes.codex.mode(args) === 'workspace-write' ? [':workspace_roots', ...addedDirectories(args, cwd)] : [];
      const filesystem = [['/', 'read'], ...writable.map(path => [path, 'write'])].map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(', ');
      return { command: 'codex', args: ['sandbox', '-P', probeProfile, '-C', cwd, '-c', `permissions.${probeProfile}.filesystem={${filesystem}}`, '--', ...script] };
    },
  },
};
const addedDirectories = (args: string[], cwd?: string) => args.flatMap((arg, index) => arg === '--add-dir' && index + 1 < args.length ? [args[index + 1]] : arg.startsWith('--add-dir=') ? [arg.slice(10)] : []).map(path => cwd ? resolve(cwd, path) : path);

/**
 * The launch arguments with every path a worker writes granted to the runtime's sandbox, once each.
 * The session starts in `cwd`, which the sandbox already treats as its workspace root; every other
 * path is written relative to it when that is shorter, because the typed launch line is bounded
 * (`launchCommandLimit`) and a managed worktree sits three levels below the shared Git directory.
 */
export function grantWorkerPaths(kind: string | undefined, args: string[], paths: string[], cwd: string) {
  const sandbox = kind ? runtimeSandboxes[kind] : undefined;
  if (!sandbox || sandbox.mode(args) !== 'workspace-write') return args;
  const granted = new Set([cwd, ...addedDirectories(args)].map(path => resolve(cwd, path)));
  const missing = [...new Set(paths.map(path => resolve(cwd, path)))].filter(path => !granted.has(path));
  return [...args, ...sandbox.grant(missing.map(path => { const near = relative(cwd, path); return near.length < path.length ? near : path; }))];
}

export class WorkerSandboxError extends Error {
  constructor(readonly runtime: string, readonly path: string, readonly detail: string) {
    super(`Worker launch failed: the ${runtime} sandbox cannot write ${path} (${detail}), so the worker would fail at its first commit or sync. Grant ${path} in the launch's sandbox arguments; docs/master-agent-sessions.md "Worker sandbox" says what each runtime needs`);
    this.name = 'WorkerSandboxError';
  }
}

export type SandboxExec = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => string;
const exec: SandboxExec = (command, args, options) => execFileSync(command, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, killSignal: 'SIGKILL' });

// Creates and removes one file in each path, stopping at the first it cannot write.
const probeScript = 'for p do f="$p/.graphyard-sandbox-probe-$$"; if err=$( { : > "$f"; } 2>&1 ); then rm -f "$f"; else printf "unwritable\\t%s\\t%s\\n" "$p" "$err"; exit 3; fi; done; echo writable';

/**
 * Proves, before the worker is reported started, that the sandbox its launch arguments describe
 * lets it write every path it needs. A runtime without a write-restricting sandbox is probed
 * from the launcher itself. Throws WorkerSandboxError naming the first path it cannot write.
 */
export function verifyWorkerSandbox(launch: { kind?: string; args: string[]; environment?: Record<string, string> }, cwd: string, paths: string[], run: SandboxExec = exec) {
  const kind = launch.kind ?? 'unknown';
  const sandbox = runtimeSandboxes[kind];
  if (!sandbox || sandbox.mode(launch.args) === null) {
    for (const path of paths) {
      const file = resolve(path, `.graphyard-sandbox-probe-${process.pid}`);
      try { writeFileSync(file, ''); rmSync(file, { force: true }); }
      catch (error) { throw new WorkerSandboxError(kind, path, error instanceof Error ? error.message : String(error)); }
    }
    return { runtime: kind, sandbox: null, verified: paths };
  }
  const probe = sandbox.probe(launch.args, cwd, ['/bin/sh', '-c', probeScript, 'sh', ...paths]);
  let output: string;
  try { output = run(probe.command, probe.args, { cwd, env: { ...process.env, ...launch.environment } }); }
  catch (error: any) { output = `${error?.stdout ?? ''}`; if (!/unwritable\t/.test(output)) throw new WorkerSandboxError(kind, paths.join(', '), `the sandbox probe \`${probe.command} ${probe.args.slice(0, 1).join(' ')}\` did not run: ${`${error?.stderr ?? ''}`.trim() || (error instanceof Error ? error.message : String(error))}`.slice(0, 400)); }
  const denied = /^unwritable\t([^\t]*)\t(.*)$/m.exec(output);
  if (denied) throw new WorkerSandboxError(kind, denied[1], denied[2].trim() || 'write refused');
  if (!/^writable$/m.test(output)) throw new WorkerSandboxError(kind, paths.join(', '), `the sandbox probe reported nothing: ${output.trim().slice(0, 200) || 'no output'}`);
  return { runtime: kind, sandbox: sandbox.mode(launch.args), verified: paths };
}

/**
 * A required command that failed because the environment refused a write, not because of the
 * item: the path and the refusal, read from the error's own text. Null for any other failure.
 */
const refusal = /(Read-only file system|Permission denied|Operation not permitted)/;
export function environmentFailure(error: unknown, cwd = process.cwd()): { path: string; detail: string } | null {
  const failure = error as { code?: string; path?: string; message?: string; stderr?: unknown } | null;
  if (failure && ['EROFS', 'EACCES', 'EPERM'].includes(failure.code ?? '') && typeof failure.path === 'string') return { path: resolve(cwd, failure.path), detail: failure.message ?? failure.code! };
  const text = `${failure?.message ?? error ?? ''}\n${failure?.stderr ?? ''}`;
  for (const line of text.split('\n')) {
    const match = /([^\s'"`:]*\/[^\s'"`:]*)['"`]?:?\s*(Read-only file system|Permission denied|Operation not permitted)/.exec(line);
    if (match) return { path: isAbsolute(match[1]) ? match[1] : resolve(cwd, match[1]), detail: line.trim() };
  }
  return refusal.test(text) ? { path: cwd, detail: text.split('\n').find(line => refusal.test(line))!.trim() } : null;
}

/** The blocker a required command records when the environment refused it: the sandbox and the path, never the item. */
export function environmentBlocker(command: string, runtime: string | undefined, failure: { path: string; detail: string }) {
  return `Environment, not the item: the ${runtime || 'worker'} sandbox cannot write ${failure.path}, so required command '${command}' failed: ${failure.detail.slice(0, 300)}. The launcher must grant this path to the worker's sandbox (docs/master-agent-sessions.md "Worker sandbox"); unblock and relaunch once it does.`;
}
export const environmentBlocked = (blocker: string | null | undefined) => !!blocker?.startsWith('Environment, not the item:');
export const blockedPath = (blocker: string) => /cannot write (\S+), so required command/.exec(blocker)?.[1] ?? null;
