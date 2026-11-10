// Concern: OS-level host filesystem and coordinator confinement for every launched role.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { defaultChildRun } from '../child-runner.js';
import { slotsDirectoryVariable } from './verification-slots.js';
import { herdrTarget } from './herdr.js';
import { cliMountRoot } from '../install/cli-release.js';
import { configHome } from '../install/secrets.js';
import { socketConfinementWords } from './socket-confinement.js';
import { underTestRunner } from '../runtime-environment.js';
import { WorkerSandboxError } from '../worker-sandbox.js';
import { checkoutGitDirectory, checkoutGitProblem, checkoutWorktreeAdminDirectory, gitPointerAdminDirectory } from './checkout-git.js';

// Every runtime carries the same outer namespace, including runtimes with their own sandbox:
// a runtime's file policy alone does not hide host devices or command-launch sockets. The host
// root is read-only; only allocated work/Git/runtime state and private disk-backed scratch are
// writable. Existing coordinator and credential masks remain inside that boundary.

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
  environment?: NodeJS.ProcessEnv;
  args: readonly string[];
  coordinatorRoot: string;
  /** The directory the runtime starts in — also the workspace root its own sandbox would grant (GY-888). */
  sessionDirectory: string;
  /** The directory the launch allocates for the session's own writes, re-exposed by the read-only mount; defaults to `sessionDirectory`. A terminal reviewer or producer starts from the coordinator root (`sessionDirectory`) while its allocated checkout is a directory beside it (GY-888, review finding): the mount re-exposes the allocated checkout, never the root it starts in. */
  allocatedDirectory?: string;
  /** Defaults to this host's platform. */
  platform?: string;
  /** Launcher-assigned runtime state, such as the host verification slot directory. */
  writable?: readonly string[];
  /** The bubblewrap executable; null when it is known absent, the PATH lookup when unset. */
  bwrap?: string | null;
  /** Overrides the availability probe (tests); when absent, the probe runs once and is cached. */
  mountNamespaceWorks?: boolean;
  /** The session pushes and calls GitHub with a short-lived credential of its own (a worker's, GY-999; a reviewer's), so its session bus stays `/dev/null` instead of the keyring-only proxy that reaches the operator's login (GY-1039). */
  ownGitHubCredential?: boolean;
  /** An explicit null binds no keyring proxy whether or not the session carries a credential of its own: a worker launched while the control plane is the merge writer (GY-1523) has no GitHub credential and pushes nothing, so it reaches no keyring either. */
  secretsBus?: null;
  /** The install's credential locations the session must not read (GY-1856), with its own kept. Absent, nothing is masked — the master session keeps its coordinator credential. */
  credentialMask?: CredentialMask;
  /** Overrides the credential-mask read probe (tests); null runs none. */
  maskProbe?: MaskProbe | null;
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
  const directory = canonicalPath(resolve(sessionDirectory)), checkout = canonicalPath(resolve(root));
  if (directory === checkout) return null;
  const admin = checkoutWorktreeAdminDirectory(checkout);
  const coordinatorAdmin = admin && canonicalPath(admin);
  const shared = canonicalPath(join(checkoutGitDirectory(checkout), 'worktrees'));
  for (const candidate of [directory, join(directory, 'checkout')]) {
    const pointer = gitPointerAdminDirectory(candidate);
    const gitDir = pointer && canonicalPath(pointer);
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
/** The path as its canonical real path, or as given when nothing is there to resolve (bwrap resolves against its staging root). */
const canonicalPath = (path: string) => { try { return realpathSync(path); } catch { return path; } };
/** The nearest directory of `path` that exists — the path itself when it is one, else its closest existing ancestor, or null when nothing up to `/` is there. A credential file is hidden by masking the directory that holds it. */
const nearestExistingDirectory = (path: string): string | null => {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (isDirectoryPath(current)) return current;
    if (dirname(current) === current) return null;
  }
};

/**
 * The credential locations a confined session of this install must not read (GY-1856), with the
 * session's own kept: the operator config home wholesale — Graphyard's install, master, worker,
 * reviewer and producer directories all live under it — and every recorded credential path beside
 * it, against the session's own token file and runtime login homes.
 */
export interface CredentialMask {
  /** The operator config home, masked with an empty tmpfs. */
  configHome: string;
  /** Recorded credential paths beside it — the coordinator credential, the merge writer's deploy key, an upstream install's credential, the per-install `confinement.maskPaths` list — each hidden at the nearest directory that exists. */
  extraPaths: readonly string[];
  /** The session's own credential locations: its token file and its runtime login homes, re-exposed after the masks. */
  own: readonly string[];
  /** The checkout the install's own CLI launcher runs from, when the launcher sits under the config home (a self-deployed install, GY-2995): re-exposed read-only after the masks, so a confined session can execute the CLI its prompt names and post its verdict. */
  cli: readonly string[];
  /** GY-3228: locations masked exactly where they exist — a directory by an empty unreadable one, a file by an unreadable empty file: the host user's personal credentials, other agent accounts' homes, other installs' directories, declared extras. */
  hostPaths?: readonly string[];
}

/** GY-3228: where a host user's personal credentials live by default. Each is masked only where it exists. */
export const hostCredentialPaths = (home = homedir()): string[] =>
  ['.ssh', '.config/gh', '.git-credentials', '.netrc', '.docker/config.json', '.aws', '.config/gcloud', '.azure', '.kube', '.railway', '.config/railway'].map(path => join(home, path));
type MaskConfig = { cliPath?: string; credentialFile?: string; confinement?: { maskPaths?: readonly string[] }; environments?: readonly { home: string }[]; run?: { mergeWriter?: { deployKeyFile?: string; tokenFile?: string } }; upstream?: { url?: string; credentialFile?: string } };
/** The personal credentials, the install's declared extras, and every configured agent account home that is not the session's own. */
const hostPathsFor = (config: MaskConfig, runtimeHomes: readonly string[] = []) => {
  const own = runtimeHomes.map(home => canonicalPath(home));
  return [...hostCredentialPaths(), ...(config.confinement?.maskPaths ?? []),
    ...(config.environments ?? []).map(environment => environment.home).filter(home => !own.some(kept => kept === canonicalPath(home) || withinCheckout(canonicalPath(home), kept))),
  ].filter(isAbsolute);
};

/**
 * The credential mask a session of this install carries (GY-1856): everything this config records
 * as a credential location that is not the session's own. `own` keeps the session's token file
 * (the file `GRAPHYARD_TOKEN_FILE` names) and its runtime login homes (the values its launch sets
 * on the runtime's home variable) readable; `home` overrides the operator config home (tests).
 */
export function credentialMaskFor(
  config: MaskConfig,
  own: { credentialFile?: string | null; runtimeHomes?: readonly string[] },
  home?: string,
): CredentialMask {
  const recorded = (path: string | undefined) => !!path && isAbsolute(path) ? [path] : [];
  const operatorHome = configHome(home);
  return {
    configHome: operatorHome,
    extraPaths: [...recorded(config.credentialFile), ...recorded(config.run?.mergeWriter?.deployKeyFile), ...recorded(config.run?.mergeWriter?.tokenFile), ...recorded(config.upstream?.credentialFile), ...(config.confinement?.maskPaths ?? []).flatMap(path => recorded(path))],
    own: [own.credentialFile ?? null, ...(own.runtimeHomes ?? [])].filter((path): path is string => !!path && isAbsolute(path)),
    cli: keptCli(config, operatorHome),
    hostPaths: hostPathsFor(config, own.runtimeHomes),
  };
}
// GY-2995: a self-deployed install runs its CLI from a checkout under the config home
// (`<install>/deploy/build`, the launcher at `bin/graphyard.mjs` running code from its
// checkout root). Releases live beneath it, so new sessions keep that same stable
// mount across later publications. Only code and dependencies live there.
const keptCli = (config: MaskConfig, operatorHome: string): string[] =>
  config.cliPath && isAbsolute(config.cliPath) && withinCheckout(config.cliPath, operatorHome) ? [cliMountRoot(dirname(dirname(config.cliPath)))] : [];

/** Every absolute path a configuration names, at any depth. */
const namedPaths = (value: unknown): string[] => typeof value === 'string' ? (isAbsolute(value) ? [value] : [])
  : value && typeof value === 'object' ? Object.values(value).flatMap(namedPaths) : [];
/**
 * The master session's mask (GY-3228): the same host locations as every other session, and every
 * directory of the operator config home except its own install's — those holding a path its
 * configuration names (its token). Its own install directory and token stay readable; a CLI that
 * runs from another install's directory keeps only its checkout, read-only.
 */
export function masterCredentialMask(config: MaskConfig, runtimeHomes: readonly string[] = [], home?: string): CredentialMask {
  const operatorHome = configHome(home), named = namedPaths({ ...config, cliPath: undefined });
  let installs: string[] = [];
  try { installs = readdirSync(operatorHome).map(name => join(operatorHome, name)); } catch { /* no config home: nothing of another install to hide */ }
  return { configHome: '', extraPaths: [], own: [], cli: keptCli(config, operatorHome),
    hostPaths: [...hostPathsFor(config, runtimeHomes), ...installs.filter(path => !named.some(kept => kept === path || withinCheckout(kept, path)))] };
}

/**
 * The bubblewrap words that hide the install's credential locations from the session (GY-1856):
 * each masked directory becomes an empty tmpfs, so every credential under it is unreadable —
 * `test -r` fails, and no content is reachable to print. A `hostPaths` entry (GY-3228) is masked
 * exactly where it exists: a directory by an empty tmpfs that can be traversed but not read (mode
 * 0111, so a kept path under it still resolves), a file by binding the unreadable empty file
 * `blank` over it. The session's own paths are not hidden
 * here; they are re-exposed after the masks (`readOnlyMountWrapper`). Only a location that exists
 * is masked — the config home when it is a directory, a recorded path at the nearest directory
 * that holds it — so a stale recorded path never masks a broad ancestor that holds unrelated
 * files. A candidate that would hide a protected path — the coordinator checkout or the session's
 * own directory — is dropped, `/` is never masked, and each candidate is named by its canonical
 * real path, as the process-launch masks are (bwrap builds mount points only where every
 * component resolves inside the namespace).
 */
export const credentialMaskWords = (mask: CredentialMask | undefined, protect: readonly string[], blank?: string): readonly string[] => {
  const { directories, files, unreadable } = credentialMasks(mask, protect);
  return [...directories.flatMap(path => [...(unreadable.includes(path) ? ['--perms', '0111'] : []), '--tmpfs', path]), ...(blank ? files.flatMap(path => ['--ro-bind', blank, path]) : [])];
};
/** What the mask hides here, canonical: the directories replaced by an empty one (`unreadable` names those of them a `hostPaths` entry makes unreadable too) and the files replaced by an unreadable empty one. */
const credentialMasks = (mask: CredentialMask | undefined, protect: readonly string[]): { directories: string[]; files: string[]; unreadable: string[] } => {
  if (!mask) return { directories: [], files: [], unreadable: [] };
  const home = canonicalPath(homedir());
  // The checkout, the session's directory and the user's home itself are never hidden.
  const hides = (path: string) => path !== '/' && ![...protect, home].some(p => p === path || withinCheckout(p, path));
  const exact = [...new Set((mask.hostPaths ?? []).filter(path => isAbsolute(path) && existsSync(path)).map(canonicalPath))].filter(hides);
  const candidates = [isDirectoryPath(mask.configHome) ? mask.configHome : null, ...mask.extraPaths.filter(path => isAbsolute(path) && existsSync(path))];
  const unhidden = [...new Set([...candidates.filter((path): path is string => !!path)
    .map(path => nearestExistingDirectory(path))
    .filter((path): path is string => !!path && path !== '/')
    .map(canonicalPath)
    .filter(path => isDirectoryPath(path) && !protect.some(p => p === path || withinCheckout(p, path)) && path !== '/'), ...exact.filter(isDirectoryPath)])];
  // A path already covered by a wider candidate is not masked again: the config home's tmpfs hides everything under it.
  const directories = unhidden.filter(path => !unhidden.some(other => other !== path && withinCheckout(path, other)));
  return { directories, unreadable: exact, files: exact.filter(path => !isDirectoryPath(path) && !directories.some(directory => withinCheckout(path, directory))) };
};

/** Runs the credential-mask read probe: the sandbox's own words running `test -r` on each masked path, answering `readable<TAB>path` for each it can read. */
export type MaskProbe = (command: string, args: string[]) => Promise<string> | string;
const hostMaskProbe: MaskProbe = (command, args) => defaultChildRun(command, args, { timeoutMs: 20_000 });
/** GY-3228: a launch whose sandbox can still read a masked credential location. A sandbox fault, never the account's: the item is blocked naming the path. */
export class CredentialMaskError extends WorkerSandboxError {
  constructor(path: string) {
    super('session', path, 'readable');
    this.name = 'CredentialMaskError';
    this.message = `Host, not the item: the session's sandbox can still read ${path}, a credential location its mask must hide, so the launch was refused. Something re-exposes it — a writable grant over it, or a mask path inside the checkout; remove that, then unblock and relaunch.`;
  }
}
/** Refuses the launch when the sandbox `wrapper` builds can read a masked location that exists (GY-3228). Under the test runner nothing is probed unless a test supplies the probe. */
export async function assertCredentialsMasked(wrapper: readonly string[], input: { coordinatorRoot: string; sessionDirectory: string; credentialMask?: CredentialMask; maskProbe?: MaskProbe | null }): Promise<void> {
  const run = input.maskProbe === undefined ? (underTestRunner() ? null : hostMaskProbe) : input.maskProbe;
  const root = canonicalPath(resolve(input.coordinatorRoot)), mask = sessionMask(root, input.credentialMask);
  if (!mask || !run) return;
  const { directories, files, unreadable } = credentialMasks(mask, [root, canonicalPath(resolve(input.sessionDirectory))]);
  const kept = [...keptCredentialPaths(mask), ...mask.cli];
  // A directory masked only as the holder of recorded credentials stays a readable, empty one: what it held is what is probed.
  const masked = (path: string) => [...directories, ...files].some(target => path === target || withinCheckout(path, target)) && !kept.some(own => path === own || withinCheckout(path, own))
    && !(directories.includes(path) && !unreadable.includes(path));
  const paths = [...new Set([mask.configHome, ...mask.extraPaths, ...(mask.hostPaths ?? [])].filter(path => isAbsolute(path) && existsSync(path)).map(canonicalPath))].filter(masked);
  if (!paths.length) return;
  let output = '';
  // A sandbox that cannot start reads nothing; the launch reports that failure itself.
  try { output = await run(wrapper[0], [...wrapper.slice(1), '/bin/sh', '-c', 'for p do if test -r "$p"; then printf "readable\\t%s\\n" "$p"; fi; done', 'sh', ...paths]); } catch { return; }
  const readable = /^readable\t(.+)$/m.exec(output);
  if (readable) throw new CredentialMaskError(readable[1]);
}
/** The session's mask with the repository's own declared extras (GY-3228). */
const sessionMask = (root: string, mask: CredentialMask | undefined): CredentialMask | undefined =>
  mask && { ...mask, hostPaths: [...(mask.hostPaths ?? []), ...repositoryMaskPaths(root)] };
/** GY-3228: the absolute or `~/` mask paths the repository's own graphyard.json declares (`confinement.maskPaths`); an unreadable declaration adds none. */
const repositoryMaskPaths = (root: string): string[] => {
  try {
    const declared = JSON.parse(readFileSync(join(root, 'graphyard.json'), 'utf8'))?.confinement?.maskPaths;
    return (Array.isArray(declared) ? declared : []).filter((path): path is string => typeof path === 'string')
      .map(path => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path).filter(isAbsolute);
  } catch { return []; }
};
/** The session's own credential paths that exist here, canonical: what the wrapper re-exposes after the masks. */
const keptCredentialPaths = (mask: CredentialMask | undefined): string[] =>
  [...new Set((mask?.own ?? []).filter(path => isAbsolute(path) && existsSync(path)).map(canonicalPath))];
/** Where `graphyard-secrets-bus.socket` listens: `$GRAPHYARD_SECRETS_BUS`, else `graphyard-secrets-bus` in the user's runtime directory. */
export const secretsBusPath = (uid: number | undefined = process.getuid?.(), env: NodeJS.ProcessEnv = process.env): string | null =>
  env.GRAPHYARD_SECRETS_BUS || (env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'graphyard-secrets-bus') : uid === undefined ? null : `/run/user/${uid}/graphyard-secrets-bus`);
/**
 * The host's own process-launch channels that exist here: the systemd manager directories and
 * session-bus sockets of the user's runtime directory (`/run/user/<uid>`, `$XDG_RUNTIME_DIR`) and
 * the system bus directory. Whether a candidate may be hidden is `processLaunchMaskWords`'s call.
 */
export const hostProcessLaunchTargets = (uid: number | undefined = process.getuid?.(), env: NodeJS.ProcessEnv = process.env): { directories: string[]; busSockets: string[]; secretsBus: string | null } => {
  const runtimeDirectories = [...new Set([uid === undefined ? null : `/run/user/${uid}`, process.env.XDG_RUNTIME_DIR || null, env.XDG_RUNTIME_DIR || null]
    .filter((path): path is string => !!path && isAbsolute(path)).map(path => { try { return realpathSync(path); } catch { return path; } }))];
  const directories = [...runtimeDirectories.flatMap(directory => [directory, join(directory, 'systemd')]), '/run/dbus', '/var/run/dbus',
    ...[...new Set([process.env.HOME, env.HOME])].filter((home): home is string => !!home).flatMap(home => [
      join(home, '.config', 'herdr', 'sessions'), join(home, '.docker', 'run'), join(home, '.docker', 'desktop'), join(home, '.local', 'share', 'docker')]),
    ...[
      env.XDG_CONFIG_HOME && join(env.XDG_CONFIG_HOME, 'herdr', 'sessions'),
      env.GRAPHYARD_HERDR_CONFIG_HOME && join(env.GRAPHYARD_HERDR_CONFIG_HOME, 'herdr', 'sessions'),
      herdrTarget()?.configHome && join(herdrTarget()!.configHome, 'herdr', 'sessions')].filter((path): path is string => !!path)];
  return { directories, busSockets: [...runtimeDirectories.map(directory => join(directory, 'bus')),
    ...[env.DOCKER_HOST, env.CONTAINER_HOST, env.BUILDKIT_HOST].flatMap(value => value?.startsWith('unix://') ? [value.slice(7)] : []),
    ...[env.SSH_AUTH_SOCK, env.HERDR_SOCKET_PATH].filter((path): path is string => !!path)], secretsBus: secretsBusPath(uid, env) };
};

/** Mount masks isolate Unix sockets only. Refuse declared remote host executors before starting
 * any command: retaining the host network would otherwise let them write outside this boundary.
 */
export function assertIsolatableHostControlEndpoints(environment: NodeJS.ProcessEnv = process.env): void {
  for (const variable of ['DOCKER_HOST', 'CONTAINER_HOST', 'BUILDKIT_HOST']) {
    const endpoint = environment[variable];
    if (endpoint && !endpoint.startsWith('unix:///'))
      throw new Error(`Graphyard refuses the sandbox launch: ${variable} declares a host command endpoint that filesystem mounts cannot isolate. Use a local unix:/// socket, which the sandbox masks. No command was started.`);
  }
}

/** Read-only host with private devices, processes, scratch and host runtime sockets hidden.
 * Scratch is allocated under the session, and mounted at short paths so Git/test Unix sockets fit.
 */
export function hostFilesystemWords(scratch: string, environment: NodeJS.ProcessEnv = process.env, writable: readonly string[] = []): string[] {
  assertIsolatableHostControlEndpoints(environment);
  // Preserve runtime login variables only when their destination is explicitly writable.
  // The inherited operator HOME otherwise becomes a private scratch home.
  const variable = (name: string, fallback: string) => {
    const value = environment[name];
    return ['--setenv', name, value && isAbsolute(value) && writable.some(path => value === path || withinCheckout(value, path)) ? value : fallback];
  };
  // /etc/resolv.conf commonly points into the otherwise hidden /run tree. Bind
  // only that public resolver file back, never systemd's directory or sockets.
  const resolver = existsSync('/etc/resolv.conf') ? realpathSync('/etc/resolv.conf') : null;
  // GY-3108: Antigravity (agy) ignores AGY_CONFIG_DIR and reads its login only from
  // `$HOME/.gemini/antigravity-cli`, so the account's login home is bound there.
  const home = variable('HOME', '/tmp/home'), agy = variable('AGY_CONFIG_DIR', '')[2];
  const agyHome = agy && join(home[2], '.gemini', 'antigravity-cli') !== agy ? ['--bind', agy, join(home[2], '.gemini', 'antigravity-cli')] : [];
  return ['--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    '--tmpfs', '/run', ...(resolver?.startsWith('/run/') ? ['--ro-bind', resolver, resolver] : []), '--bind', scratch, '/tmp', '--bind', scratch, '/var/tmp',
    ...variable('TMPDIR', '/tmp'), ...variable('TMP', '/tmp'), ...variable('TEMP', '/tmp'),
    '--dir', '/tmp/home', ...home, ...agyHome,
    '--dir', '/tmp/runtime', ...variable('XDG_RUNTIME_DIR', '/tmp/runtime'),
    ...variable('XDG_CACHE_HOME', '/tmp/cache'), ...variable('npm_config_cache', '/tmp/npm-cache')];
}

/**
 * The bubblewrap words that run a session with the coordinator checkout unwritable (GY-888): the
 * host root read-only, private devices and scratch, and only what the
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
export function readOnlyMountWrapper(input: { coordinatorRoot: string; sessionDirectory: string; bwrap?: string | null; ownGitHubCredential?: boolean; secretsBus?: null; writable?: readonly string[]; credentialMask?: CredentialMask; environment?: NodeJS.ProcessEnv;
  /** GY-3237: Herdr socket and config directories the session reaches read-only (the master session's own grant): bound after the masks, kept from the process-launch masks, and allowed socket resolution under Landlock. */
  herdrPaths?: readonly string[] }): readonly string[] {
  const root = canonicalPath(resolve(input.coordinatorRoot)), directory = canonicalPath(resolve(input.sessionDirectory));
  const gitDir = canonicalPath(checkoutGitDirectory(root));
  const adminDirectory = sessionGitAdminDirectory(directory, root);
  const sharedDirectories = [
    join(gitDir, 'objects'), ...(adminDirectory ? [adminDirectory] : [join(gitDir, 'worktrees')]), join(gitDir, 'refs', 'remotes'), join(gitDir, 'logs', 'refs', 'remotes'),
    join(gitDir, 'refs', 'heads', 'graphyard'), join(gitDir, 'logs', 'refs', 'heads', 'graphyard'),
  ].filter(isDirectoryPath);
  const fetchHead = join(checkoutWorktreeAdminDirectory(root) ?? gitDir, 'FETCH_HEAD');
  const shared = [...sharedDirectories, ...(existsSync(fetchHead) && !isDirectoryPath(fetchHead) ? [fetchHead] : [])];
  const own = directory !== root ? [directory] : [];
  const writable = [...(input.writable ?? []), ...(process.env[slotsDirectoryVariable] ? [process.env[slotsDirectoryVariable]!] : [])].filter(isDirectoryPath);
  const scratch = join(directory, '.graphyard', 'scratch');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const bwrap = input.bwrap ?? 'bwrap';
  // GY-1856: the install's credential locations are hidden from the session, and its own — its
  // token file read-only, its runtime login homes writable — are re-exposed last, so a later bind
  // shadows the mask that covered them.
  // GY-3228: the repository's own declared extras join the mask.
  const mask = sessionMask(root, input.credentialMask);
  const kept = keptCredentialPaths(mask);
  // GY-2995: the install's own CLI checkout is re-exposed read-only after the masks, so a
  // confined session runs the launcher its prompt names but can change none of its code.
  const cli = (input.credentialMask?.cli ?? []).filter(path => isAbsolute(path) && existsSync(path)).map(canonicalPath);
  // GY-3237: the Herdr socket and config the master session reaches, granted read-only: bound
  // after every mask so the later bind shadows the process-launch mask over the same tree, kept
  // from that mask's own words (a pane-inherited HERDR_SOCKET_PATH is otherwise replaced by the
  // keyring proxy), and allowed socket resolution under Landlock below. Every other session —
  // worker, reviewer, producer — grants nothing here: Herdr launches host commands, and only the
  // master may ask it to.
  const herdr = [...new Set((input.herdrPaths ?? []).filter(path => isAbsolute(path) && isDirectoryPath(path)).map(canonicalPath))];
  // A masked file is replaced by this unreadable empty one.
  const blank = join(directory, '.graphyard', 'masked');
  if (mask && !existsSync(blank)) writeFileSync(blank, '', { mode: 0 });
  const masks = credentialMaskWords(mask, [root, directory], blank);
  const environment = { ...process.env, ...input.environment };
  // The Herdr grant covers the sockets under it (GY-3237): a pane-inherited HERDR_SOCKET_PATH
  // would otherwise carry the keyring proxy over the very socket the session must reach.
  const launchTargets = hostProcessLaunchTargets(undefined, environment);
  const busSockets = launchTargets.busSockets.filter(socket => !herdr.some(directory => socket === directory || withinCheckout(socket, directory)));
  const channels = processLaunchMaskWords({ ...launchTargets, busSockets, ...(input.ownGitHubCredential || input.secretsBus === null ? { secretsBus: null } : {}) }, [root, directory, ...herdr]);
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
  // Apply external state grants before protecting the coordinator, so an ancestor grant cannot unprotect it.
  const protectAdmin = !adminDirectory && coordinatorAdmin && sharedDirectories.some(path => withinCheckout(coordinatorAdmin, path)) ? [coordinatorAdmin] : [];
  return [bwrap, ...hostFilesystemWords(scratch, environment, [...writable, ...kept.filter(isDirectoryPath)]), ...masks,
    ...writable.filter(path => !withinCheckout(path, root)).flatMap(path => ['--bind', path, path]),
    '--ro-bind', root, root,
    ...commonGitDir.flatMap(path => ['--bind', path, path]),
    ...ownGitState.flatMap(path => ['--ro-bind', path, path]),
    ...[...sharedDirectories, ...own, ...writable.filter(path => withinCheckout(path, root))].flatMap(path => ['--bind', path, path]),
    ...protectAdmin.flatMap(path => ['--ro-bind', path, path]),
    ...shared.filter(path => !sharedDirectories.includes(path)).flatMap(path => ['--bind', path, path]),
    ...kept.flatMap(path => isDirectoryPath(path) ? ['--bind', path, path] : ['--ro-bind', path, path]),
    ...cli.flatMap(path => ['--ro-bind', path, path]),
    ...herdr.flatMap(path => ['--ro-bind', path, path]), ...channels, '--',
    ...socketConfinementWords([...own, ...writable, ...herdr, ...kept.filter(isDirectoryPath), ...commonGitDir, ...sharedDirectories],
      channels.flatMap((word, index) => word === '--ro-bind' && channels[index + 1] !== '/dev/null' ? [channels[index + 2]] : []))];
}

/** The one refusal text for a launch whose coordinator confinement cannot be applied (GY-888): the head names the runtime and the checkout, `problem` says what is missing. */
export const confinementRefusalText = (kind: string, coordinatorRoot: string, problem: { platform?: string; bwrapMissing?: boolean; namespaces?: boolean; undetermined?: string; gitDirectory?: string }): string => {
  const head = `A ${kind} session cannot be launched with the coordinator checkout at ${coordinatorRoot} unwritable at the OS level`;
  if (problem.gitDirectory) return `${head}: the Git directory it writes through cannot be resolved — ${problem.gitDirectory}. Graphyard never starts a session unconfined; repair the checkout (git worktree repair) so its .git names its Git directory.`;
  if (problem.undetermined) return `${head}: ${problem.undetermined} Graphyard never starts a session unconfined; run the launcher through its own bin/graphyard.mjs from the checkout it serves, so every launch carries the confinement.`;
  const own = 'the outer filesystem and socket boundary is required for every runtime';
  if (problem.platform) return `${head}: the read-only mount namespace it would run in needs Linux, this host is ${problem.platform}, ${own}. Graphyard never starts a session unconfined; run sessions on a Linux host with bubblewrap available.`;
  if (problem.bwrapMissing) return `${head}: bubblewrap (bwrap) is not installed ${own}. Graphyard never starts a session unconfined; install bubblewrap (e.g. apt install bubblewrap) with bubblewrap available.`;
  return `${head}: this host refuses the unprivileged namespaces bubblewrap needs, ${own}. Graphyard never starts a session unconfined; allow unprivileged user namespaces on this host with bubblewrap available.`;
};

/** The variable the master session's wrapper sets: its `master restart` then asks the loop to restart itself instead of the host's systemd, which the confinement hides. */
export const masterConfinementVariable = 'GRAPHYARD_CONFINEMENT';
/** Whether this process runs inside the master session's confinement (GY-3237). */
export const insideMasterConfinement = (env: NodeJS.ProcessEnv = process.env) => env[masterConfinementVariable] === 'master';
/** Whether bubblewrap can build the mount namespace here; a host may refuse unprivileged namespaces. Probed through the asynchronous runner once per executable and cached; the probe asks for the pid namespace and a fresh /proc too, because that is what the wrapper itself requires. */
export async function sessionMountNamespaceWorks(bwrap = 'bwrap'): Promise<boolean> {
  // GY-3237: inside the master session's own confinement the host's bubblewrap already built this
  // namespace, and Landlock forbids building another, so a local probe always fails; the sessions
  // the master launches run from Herdr panes the host starts, outside it.
  if (insideMasterConfinement()) return true;
  if (!mountNamespaceProbes.has(bwrap)) {
    const probe = defaultChildRun(bwrap, ['--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', 'true'], { timeoutMs: 20_000 })
      .then(value => { mountNamespaceAnswers.set(bwrap, true); return true; }, () => { mountNamespaceAnswers.set(bwrap, false); return false; });
    mountNamespaceProbes.set(bwrap, probe);
  }
  return mountNamespaceProbes.get(bwrap)!;
}
const mountNamespaceProbes = new Map<string, Promise<boolean>>();
const mountNamespaceAnswers = new Map<string, boolean>();
/** The last probed answer for `bwrap`, or undefined while none is known: the synchronous spawn wrapper refuses on false and lets bubblewrap itself fail on unknown. */
export const mountNamespaceProbeResult = (bwrap = 'bwrap'): boolean | undefined => mountNamespaceAnswers.get(bwrap);

/** Why a launch of `kind` cannot keep the coordinator checkout unwritable at the OS level, or null. Every runtime needs the outer Linux namespace, including one with its own filesystem sandbox. */
export async function coordinatorConfinementRefusal(input: ConfinementInput): Promise<string | null> {
  const gitDirectory = checkoutGitProblem(input.coordinatorRoot);
  if (gitDirectory) return confinementRefusalText(input.kind, input.coordinatorRoot, { gitDirectory });
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
  const refusal = await coordinatorConfinementRefusal(input);
  if (refusal) throw new Error(refusal);
  const root = resolve(input.coordinatorRoot), directory = resolve(input.allocatedDirectory ?? input.sessionDirectory);
  const wrapper = readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: directory, writable: input.writable, environment: input.environment, bwrap: input.bwrap ?? undefined, ownGitHubCredential: input.ownGitHubCredential, ...(input.secretsBus === null ? { secretsBus: null } : {}), ...(input.credentialMask ? { credentialMask: input.credentialMask } : {}) });
  await assertCredentialsMasked(wrapper, { coordinatorRoot: root, sessionDirectory: directory, credentialMask: input.credentialMask, maskProbe: input.maskProbe });
  const reexposed = wrapper.filter((word, index) => index > 0 && wrapper[index - 1] === '--bind');
  return { mechanism: 'read-only-mount', wrapper,
    detail: `the coordinator checkout at ${root} is bind-mounted read-only for the session in a bubblewrap namespace whose /proc shows only the session's own processes; only ${reexposed.join(', ') || 'nothing'} are re-exposed writable, so no shell command can write, commit in or switch the checkout` };
}
