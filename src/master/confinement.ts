// Concern: the OS-level confinement of the coordinator checkout (GY-888) — the read-only mount namespace, or the runtime's own sandbox, that every launch carries.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defaultChildRun } from '../child-runner.js';
import { runtimeSandboxes } from '../worker-sandbox.js';
import { checkoutGitDirectory, checkoutGitProblem, checkoutWorktreeAdminDirectory, gitPointerAdminDirectory } from './checkout-git.js';

// ---- OS-level confinement of the coordinator checkout (GY-888) -----------------------------------
//
// GY-857's harness rules are a prompt policy, and shell commands (`cp`, `sed`, `git commit`,
// `git checkout`) never matched them: workers moved the coordinator checkout four times in one
// day through plain Bash. GY-888 makes the checkout unwritable at the OS level for every session
// the launcher starts — worker, reviewer, producer and approver — by carrying the confinement on
// the launch itself, in whatever the runtime supports:
//
// - a runtime whose filesystem sandbox leaves every ungranted path read-only (codex under
//   `workspace-write`, enforced by workerConfinementRefusal) IS the confinement: the checkout's
//   working tree is never among the granted paths;
// - every other runtime runs inside a bubblewrap mount namespace in which the coordinator checkout
//   is bind-mounted read-only, and only what the session's own work needs is re-exposed writable
//   on top: its own directory (the assigned worktree or allocated checkout) and the shared Git
//   areas a linked worktree writes — the object store, the session's own per-worktree admin (only
//   the whole `.git/worktrees` when the session creates worktrees of its own), the `graphyard/`
//   branch namespace with its reflogs, remote-tracking refs and FETCH_HEAD — never the checkout's
//   source tree, its index, or the refs of branches only the guarded merge moves. The namespace
//   unshares PIDs and mounts a fresh /proc, so another process's /proc/<pid>/root is not a route
//   back to the writable checkout;
//
// A launch that cannot apply the confinement is refused with the reason named, never started
// unconfined, exactly like a contained install (GY-174): install bubblewrap, or let the runtime
// carry a workspace-write sandbox. The master session is confined too (GY-1658): the same read-only
// mount, PID namespace and hidden process-launch channels, with its managed `.graphyard` state
// writable; the host acts its admin commands need (a loop restart) are requests the loop serves.

/** How a launch keeps the coordinator checkout unwritable for the session it starts. */
export interface CoordinatorConfinement {
  /** Which mechanism applies: the runtime's own filesystem sandbox, or a read-only mount namespace. */
  mechanism: 'runtime-sandbox' | 'read-only-mount';
  /** Words placed before the runtime command to apply the confinement; empty for the runtime's own sandbox. */
  wrapper: readonly string[];
  /** What the confinement holds, for the launch record. */
  detail: string;
}

export interface ConfinementInput {
  kind: string;
  args: readonly string[];
  coordinatorRoot: string;
  /** The directory the runtime starts in — also the workspace root its own sandbox would grant (GY-888). */
  sessionDirectory: string;
  /** The directory the launch allocates for the session's own writes, re-exposed by the read-only mount; defaults to `sessionDirectory`. A terminal reviewer or producer starts from the coordinator root (`sessionDirectory`) while its allocated checkout is a directory beside it (GY-888, review finding): the mount re-exposes the allocated checkout, never the root it starts in. */
  allocatedDirectory?: string;
  /** Defaults to this host's platform. */
  platform?: string;
  /** The bubblewrap executable; null when it is known absent, the PATH lookup when unset. */
  bwrap?: string | null;
  /** Overrides the availability probe (tests); when absent, the probe runs once and is cached. */
  mountNamespaceWorks?: boolean;
  /** The session pushes and calls GitHub with a short-lived credential of its own (a worker's, GY-999; a reviewer's), so its session bus stays `/dev/null` instead of the keyring-only proxy that reaches the operator's login (GY-1039). */
  ownGitHubCredential?: boolean;
  /** An explicit null binds no keyring proxy whether or not the session carries a credential of its own: a worker launched while the control plane is the merge writer (GY-1523) has no GitHub credential and pushes nothing, so it reaches no keyring either. */
  secretsBus?: null;
}
const withinCheckout = (path: string, root: string) => { const from = relative(root, path); return from !== '' && from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from); };
/** Whether `path` is a directory (or nothing); symlinks to directories count, as bwrap binds resolve them. */
const isDirectoryPath = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
/** The bubblewrap executable on this PATH, or null: the synchronous lookup a spawn wrapper needs. */
export const bwrapOnPath = (env: NodeJS.ProcessEnv = process.env): string | null => {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, 'bwrap');
    try { if (existsSync(candidate)) return candidate; } catch { /* an unreadable PATH entry is skipped */ }
  }
  return null;
};

/** The writable scope a launch's own runtime sandbox grants: the session's working directory (the sandbox's workspace root) and every `--add-dir`, resolved against it. */
const sandboxWritableScope = (args: readonly string[], sessionDirectory: string): string[] => {
  const scope: string[] = [resolve(sessionDirectory)];
  for (let index = 0; index < args.length; index++) {
    const [flag, inline] = args[index].split(/=(.*)/s);
    if (flag !== '--add-dir') continue;
    const value = inline ?? args[index + 1];
    if (value) scope.push(resolve(sessionDirectory, value));
  }
  return scope;
};
/**
 * Whether the runtime's own workspace-write sandbox IS the confinement (GY-888): the sandbox
 * leaves every ungranted path read-only, which confines the checkout only while the checkout and
 * the Git directory it writes through (`checkoutGitDirectory`, which lies outside the checkout when
 * the coordinator itself is a linked worktree — GY-957, review finding) lie outside every path the
 * sandbox grants. A session whose working directory or an `--add-dir` would hold the checkout — a
 * terminal reviewer or producer runs from the coordinator root — cannot claim it, and carries the
 * read-only mount instead.
 */
const runtimeSandboxConfines = (input: ConfinementInput): boolean => {
  if (runtimeSandboxes[input.kind]?.mode([...input.args]) !== 'workspace-write') return false;
  const root = resolve(input.coordinatorRoot), git = checkoutGitDirectory(root);
  const own = resolve(input.sessionDirectory);
  const admin = sessionGitAdminDirectory(own, root);
  // What the sandbox may grant inside the checkout: the session's own worktree and its own worktree
  // admin directory — never the checkout itself. A session whose workspace IS the checkout root
  // therefore has no exemption at all.
  const exempt = [...(own !== root ? [own] : []), ...(admin && admin !== root ? [admin] : [])];
  const inside = (path: string, directory: string) => path === directory || withinCheckout(path, directory);
  const overlaps = (path: string, directory: string) => path === directory || withinCheckout(directory, path) || withinCheckout(path, directory);
  // A grant disqualifies when it touches the checkout or its Git administrative state outside the
  // exemption — a worker launch grants the common Git directory so the runtime can commit, and that
  // grant would leave coordinator refs, index and reflogs writable; such a launch carries the mount
  // wrapper, which re-exposes only the session's own Git paths (GY-888, GY-957 review findings).
  return !sandboxWritableScope(input.args, input.sessionDirectory).some(path =>
    (overlaps(path, root) || overlaps(path, git)) && !exempt.some(zone => inside(path, zone)));
};

/**
 * The linked-worktree administrative directory the session's own directory writes through, or null when
 * it is not a linked worktree of the coordinator checkout. A linked worktree points at its admin through
 * its `.git` file, so this reads the pointer rather than asking git, and pins it under the coordinator's
 * common worktrees area (`checkoutGitDirectory`), which is outside the checkout when the coordinator
 * itself is a linked worktree. Pinning one session's Git admin, instead of the whole worktrees area,
 * keeps concurrent assignments' worktree metadata unwritable to each other (GY-888). A reviewer's or
 * producer's allocated directory is a managed session checkout outside every worktree that holds its
 * linked worktree as the `checkout` child (install/worktree-root.ts sessionCheckout), so that child's
 * pointer is read too. The coordinator's own admin — its HEAD and index when it is a linked worktree —
 * is never the session's (GY-957, review finding).
 */
export const sessionGitAdminDirectory = (sessionDirectory: string, root: string): string | null => {
  const directory = resolve(sessionDirectory), checkout = resolve(root);
  if (directory === checkout) return null;
  const coordinatorAdmin = checkoutWorktreeAdminDirectory(checkout);
  const shared = join(checkoutGitDirectory(checkout), 'worktrees');
  for (const candidate of [directory, join(directory, 'checkout')]) {
    const gitDir = gitPointerAdminDirectory(candidate);
    if (gitDir && gitDir !== coordinatorAdmin && gitDir.startsWith(`${shared}${sep}`) && isDirectoryPath(gitDir)) return gitDir;
  }
  return null;
};

/**
 * The bubblewrap words that hide the host's process-launch channels under paths that exist: each
 * named directory is replaced by an empty one, and each bus socket by a device that no client can
 * connect to. Through the session bus a confined process could otherwise ask the user's systemd
 * manager (`systemd-run --user`) — or the system one over `/run/dbus` (`systemd-run --system`) — to
 * start a helper outside this mount namespace and write the underlying, writable coordinator
 * checkout, which a fresh `/proc` alone does not close (GY-888, review finding). Candidates that
 * would hide a protected path are dropped. Each candidate is named by its canonical real path
 * before deduplication: bubblewrap (up to 0.11) builds a mount point only where every path
 * component resolves inside the namespace, and a destination reached through an absolute symlink —
 * `/var/run` → `/run` on Debian-family hosts — resolves against its own staging root, where the
 * target does not exist, so the launch dies with "Can't mkdir". The canonical path also aliases
 * that pair to one mask, and hiding the real directory hides every symlink to it.
 *
 * When `secretsBus` names a live socket, each session-bus socket is replaced by it instead of by
 * `/dev/null`: the keyring-only proxy (`graphyard-secrets-bus.socket`, filtered in `graphyard-secrets-bus-filter.service`) reaches only the
 * keyring's read methods, so `gh auth git-credential` works while systemd1 and every other bus name stay unreachable. A session with a GitHub credential of its own gets no `secretsBus` (GY-1039).
 */
export const processLaunchMaskWords = (
  targets: { directories?: readonly string[]; busSockets?: readonly string[]; secretsBus?: string | null },
  protect: readonly string[],
): readonly string[] => {
  const hides = (path: string) => !protect.some(p => p === path || withinCheckout(p, path));
  const canonical = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  const directories = [...new Set((targets.directories ?? []).filter(path => isAbsolute(path) && isDirectoryPath(path) && hides(path)).map(canonical))];
  const sockets = [...new Set((targets.busSockets ?? []).filter(path => isAbsolute(path) && existsSync(path) && !isDirectoryPath(path) && hides(path)).map(canonical))];
  const proxy = targets.secretsBus && isAbsolute(targets.secretsBus) && isSocketPath(targets.secretsBus) ? canonical(targets.secretsBus) : '/dev/null';
  return [...directories.flatMap(path => ['--tmpfs', path]), ...sockets.flatMap(path => ['--ro-bind', proxy, path])];
};
export const isSocketPath = (path: string) => { try { return statSync(path).isSocket(); } catch { return false; } };
/** Where `graphyard-secrets-bus.socket` listens: `$GRAPHYARD_SECRETS_BUS`, else `graphyard-secrets-bus` in the user's runtime directory. */
export const secretsBusPath = (uid: number | undefined = process.getuid?.(), env: NodeJS.ProcessEnv = process.env): string | null =>
  env.GRAPHYARD_SECRETS_BUS || (env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'graphyard-secrets-bus') : uid === undefined ? null : `/run/user/${uid}/graphyard-secrets-bus`);
/**
 * The host's own process-launch channels that exist here: the systemd manager directories and
 * session-bus sockets of the user's runtime directory (`/run/user/<uid>`, `$XDG_RUNTIME_DIR`) and
 * the system bus directory. Whether a candidate may be hidden is `processLaunchMaskWords`'s call.
 */
export const hostProcessLaunchTargets = (uid: number | undefined = process.getuid?.(), env: NodeJS.ProcessEnv = process.env): { directories: string[]; busSockets: string[]; secretsBus: string | null } => {
  const runtimeDirectories = [...new Set([uid === undefined ? null : `/run/user/${uid}`, env.XDG_RUNTIME_DIR || null]
    .filter((path): path is string => !!path && isAbsolute(path)).map(path => { try { return realpathSync(path); } catch { return path; } }))];
  const directories = [...runtimeDirectories.map(directory => join(directory, 'systemd')), '/run/dbus', '/var/run/dbus'];
  return { directories, busSockets: runtimeDirectories.map(directory => join(directory, 'bus')), secretsBus: secretsBusPath(uid, env) };
};

/**
 * The bubblewrap words that run a session with the coordinator checkout unwritable (GY-888): the
 * whole host exactly as it is, the checkout bind-mounted read-only over it, and only what the
 * session's own work needs re-exposed writable on top — bubblewrap applies each bind in order, so
 * the later ones shadow the read-only one. The common Git directory itself is re-exposed writable
 * (GY-2967: every ref transaction takes the packed-refs lock there), with the coordinator's own
 * Git state inside it — its index, HEAD, config, hooks and the refs outside the `graphyard/`
 * namespace — re-bound read-only after it, and, for a session with its own worktree admin, the
 * shared worktrees area too. The shared Git paths and the checkout's FETCH_HEAD resolve through
 * `checkoutGitDirectory`/`checkoutWorktreeAdminDirectory`, so a coordinator that is itself a
 * linked worktree re-exposes its real common Git directory instead of a `.git` pointer file
 * (GY-957, review finding). The namespace also unshares PIDs and mounts a fresh `/proc`, so
 * another process's `/proc/<pid>/root`
 * is not a route back to the writable checkout (the escape `containedInstall` closes for installs),
 * and the host's process-launch channels are hidden so no command can start the write outside the
 * namespace; a session keeps the network and its own process tree. The wrapper ends with `--`, so
 * the runtime command follows it.
 */
export function readOnlyMountWrapper(input: { coordinatorRoot: string; sessionDirectory: string; bwrap?: string | null; ownGitHubCredential?: boolean; secretsBus?: null; writable?: readonly string[] }): readonly string[] {
  const root = resolve(input.coordinatorRoot), directory = resolve(input.sessionDirectory);
  const gitDir = checkoutGitDirectory(root);
  const adminDirectory = sessionGitAdminDirectory(directory, root);
  const sharedDirectories = [
    join(gitDir, 'objects'), ...(adminDirectory ? [adminDirectory] : [join(gitDir, 'worktrees')]), join(gitDir, 'refs', 'remotes'), join(gitDir, 'logs', 'refs', 'remotes'),
    join(gitDir, 'refs', 'heads', 'graphyard'), join(gitDir, 'logs', 'refs', 'heads', 'graphyard'),
  ].filter(isDirectoryPath);
  const fetchHead = join(checkoutWorktreeAdminDirectory(root) ?? gitDir, 'FETCH_HEAD');
  const shared = [...sharedDirectories, ...(existsSync(fetchHead) && !isDirectoryPath(fetchHead) ? [fetchHead] : [])];
  const own = withinCheckout(directory, root) ? [directory] : [];
  const bwrap = input.bwrap ?? 'bwrap';
  const masks = processLaunchMaskWords({ ...hostProcessLaunchTargets(), ...(input.ownGitHubCredential || input.secretsBus === null ? { secretsBus: null } : {}) }, [root, directory]);
  // GY-2967: every ref transaction a session runs — commit, merge, reset, branch -f, update-ref, a
  // cherry-pick's cleanup — takes the common git directory's packed-refs lock once anything has
  // packed a ref (git gc, git pack-refs), and rewrites packed-refs under that lock, so keeping the
  // whole git directory read-only refused every ref update on a packed ref with
  // `packed-refs.lock: Read-only file system`. The common git directory is therefore bound
  // writable, and the paths that are only the coordinator's own are re-bound read-only inside it:
  // bubblewrap applies the binds in order, and inside a writable directory a read-only bind still
  // lets git take its `.lock` (which the writable directory allows) but refuses the write and the
  // rename that would commit it — so the checkout's index, HEAD, config and hooks and the refs
  // outside the graphyard namespace keep the protection they had while the directory was read-only.
  const ownGitState = [join(gitDir, 'config'), join(gitDir, 'HEAD'), join(gitDir, 'index'), join(gitDir, 'refs', 'heads'), join(gitDir, 'logs', 'refs', 'heads'), join(gitDir, 'refs', 'tags'), join(gitDir, 'hooks'), ...(adminDirectory ? [join(gitDir, 'worktrees')] : [])]
    .filter(path => existsSync(path));
  const commonGitDir = isDirectoryPath(gitDir) ? [gitDir] : [];
  // A session with no admin of its own re-exposes the whole worktrees area; when the coordinator is
  // itself a linked worktree its own admin (HEAD, index) lies there, so it is bound read-only again
  // after that re-exposure — only its FETCH_HEAD, bound after it, stays writable (GY-957, review finding).
  const coordinatorAdmin = checkoutWorktreeAdminDirectory(root);
  const protectAdmin = !adminDirectory && coordinatorAdmin && sharedDirectories.some(path => withinCheckout(coordinatorAdmin, path)) ? [coordinatorAdmin] : [];
  return [bwrap, '--unshare-pid', '--dev-bind', '/', '/', ...masks, '--proc', '/proc', '--ro-bind', root, root,
    ...commonGitDir.flatMap(path => ['--bind', path, path]),
    ...ownGitState.flatMap(path => ['--ro-bind', path, path]),
    ...[...sharedDirectories, ...own, ...(input.writable ?? []).filter(isDirectoryPath)].flatMap(path => ['--bind', path, path]),
    ...protectAdmin.flatMap(path => ['--ro-bind', path, path]),
    ...shared.filter(path => !sharedDirectories.includes(path)).flatMap(path => ['--bind', path, path]), '--'];
}

/** The one refusal text for a launch whose coordinator confinement cannot be applied (GY-888): the head names the runtime and the checkout, `problem` says what is missing. */
export const confinementRefusalText = (kind: string, coordinatorRoot: string, problem: { platform?: string; bwrapMissing?: boolean; namespaces?: boolean; undetermined?: string; gitDirectory?: string }): string => {
  const head = `A ${kind} session cannot be launched with the coordinator checkout at ${coordinatorRoot} unwritable at the OS level`;
  if (problem.gitDirectory) return `${head}: the Git directory it writes through cannot be resolved — ${problem.gitDirectory}. Graphyard never starts a session unconfined; repair the checkout (git worktree repair) so its .git names its Git directory.`;
  if (problem.undetermined) return `${head}: ${problem.undetermined} Graphyard never starts a session unconfined; run the launcher through its own bin/graphyard.mjs from the checkout it serves, so every launch carries the confinement.`;
  const own = 'and the runtime carries no filesystem sandbox of its own';
  if (problem.platform) return `${head}: the read-only mount namespace it would run in needs Linux, this host is ${problem.platform}, ${own}. Graphyard never starts a session unconfined; run sessions on a Linux host or grant the runtime a workspace-write sandbox.`;
  if (problem.bwrapMissing) return `${head}: bubblewrap (bwrap) is not installed ${own}. Graphyard never starts a session unconfined; install bubblewrap (e.g. apt install bubblewrap) or grant the runtime a workspace-write sandbox.`;
  return `${head}: this host refuses the unprivileged namespaces bubblewrap needs, ${own}. Graphyard never starts a session unconfined; allow unprivileged user namespaces on this host or grant the runtime a workspace-write sandbox.`;
};

/** Whether bubblewrap can build the mount namespace here; a host may refuse unprivileged namespaces. Probed through the asynchronous runner once per executable and cached; the probe asks for the pid namespace and a fresh /proc too, because that is what the wrapper itself requires. */
export async function sessionMountNamespaceWorks(bwrap = 'bwrap'): Promise<boolean> {
  if (!mountNamespaceProbes.has(bwrap)) {
    const probe = defaultChildRun(bwrap, ['--unshare-pid', '--dev-bind', '/', '/', '--proc', '/proc', '--', 'true'], { timeoutMs: 20_000 })
      .then(value => { mountNamespaceAnswers.set(bwrap, true); return true; }, () => { mountNamespaceAnswers.set(bwrap, false); return false; });
    mountNamespaceProbes.set(bwrap, probe);
  }
  return mountNamespaceProbes.get(bwrap)!;
}
const mountNamespaceProbes = new Map<string, Promise<boolean>>();
const mountNamespaceAnswers = new Map<string, boolean>();
/** The last probed answer for `bwrap`, or undefined while none is known: the synchronous spawn wrapper refuses on false and lets bubblewrap itself fail on unknown. */
export const mountNamespaceProbeResult = (bwrap = 'bwrap'): boolean | undefined => mountNamespaceAnswers.get(bwrap);

/** Why a launch of `kind` cannot keep the coordinator checkout unwritable at the OS level, or null. A runtime sandbox of its own needs neither Linux nor bubblewrap — but only while the checkout lies outside every path the sandbox grants. */
export async function coordinatorConfinementRefusal(input: ConfinementInput): Promise<string | null> {
  const gitDirectory = checkoutGitProblem(input.coordinatorRoot);
  if (gitDirectory) return confinementRefusalText(input.kind, input.coordinatorRoot, { gitDirectory });
  if (runtimeSandboxConfines(input)) return null;
  const bwrap = input.bwrap !== undefined ? input.bwrap : bwrapOnPath();
  const platform = input.platform ?? process.platform;
  if (platform !== 'linux') return confinementRefusalText(input.kind, input.coordinatorRoot, { platform });
  if (!bwrap) return confinementRefusalText(input.kind, input.coordinatorRoot, { bwrapMissing: true });
  if (!(input.mountNamespaceWorks ?? await sessionMountNamespaceWorks(bwrap))) return confinementRefusalText(input.kind, input.coordinatorRoot, { namespaces: true });
  return null;
}

/**
 * The confinement a launch of `kind` carries, or null when there is no coordinator checkout to
 * confine (the launcher does not run from one). Throws the coordinatorConfinementRefusal reason
 * when the kind can carry none: a launch is never started unconfined. The shared Git paths are
 * re-exposed only where they already exist — the launcher prepares the missing ones
 * (launch.ts prepareConfinedGitPaths) before building the launch.
 */
export async function coordinatorConfinement(input: ConfinementInput): Promise<CoordinatorConfinement | null> {
  const gitDirectory = checkoutGitProblem(input.coordinatorRoot);
  if (gitDirectory) throw new Error(confinementRefusalText(input.kind, input.coordinatorRoot, { gitDirectory }));
  if (runtimeSandboxConfines(input))
    return { mechanism: 'runtime-sandbox', wrapper: [], detail: `the ${input.kind} workspace-write sandbox keeps every path but its granted workspace directories read-only, and the coordinator checkout at ${input.coordinatorRoot} lies outside every one of them` };
  const refusal = await coordinatorConfinementRefusal(input);
  if (refusal) throw new Error(refusal);
  const root = resolve(input.coordinatorRoot), directory = resolve(input.allocatedDirectory ?? input.sessionDirectory);
  const wrapper = readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: directory, bwrap: input.bwrap ?? undefined, ownGitHubCredential: input.ownGitHubCredential, ...(input.secretsBus === null ? { secretsBus: null } : {}) });
  const reexposed = wrapper.filter((word, index) => index > 0 && wrapper[index - 1] === '--bind');
  return { mechanism: 'read-only-mount', wrapper,
    detail: `the coordinator checkout at ${root} is bind-mounted read-only for the session in a bubblewrap namespace whose /proc shows only the session's own processes; only ${reexposed.join(', ') || 'nothing'} are re-exposed writable, so no shell command can write, commit in or switch the checkout` };
}
