import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What a clean test run needs from the host, done by the tooling rather than remembered by the
 * session that runs it (GY-174). A worker, producer or master session carries its own Graphyard
 * and Herdr credentials in its environment; the project's own tests must never see them, or the CLI
 * credential tests read the session's token instead of the one they set. And every test file starts
 * its own Postgres on `GRAPHYARD_TEST_PORT` plus a fixed per-file offset, so two runs on one host —
 * two worktrees, or a worker beside a producer — must not share a base.
 *
 * `npm test` (tests/helpers/run-tests.ts), `graphyard verify` and the proof runners all start the
 * suite through `isolatedTestEnvironment` with a port window `reserveTestPorts` holds for the run.
 */

/** Harness controls a caller sets on purpose for the suite; every other GRAPHYARD_* and HERDR_* variable is withheld. */
export const passedTestControls = ['GRAPHYARD_TIMING_RECORD', 'GRAPHYARD_TIMING_BASELINE_RECORDING'] as const;
/** The first base tried when nothing is reserved; the historical fixed base, so a lone run keeps its ports. */
export const defaultTestPortBase = 15438;
/** Every per-file offset a test file adds to the base lies below this (the highest is 177). */
export const testPortSpan = 200;
const highestBase = 60_000;

/**
 * The environment the project's tests run under: the caller's, without NODE_TEST_CONTEXT (which a
 * surrounding test runner sets and which turns a child's TAP stream off) and without any
 * GRAPHYARD_* or HERDR_* variable the runner did not set itself — `set` is what it does set.
 */
export function isolatedTestEnvironment(environment: NodeJS.ProcessEnv = process.env, set: Record<string, string> = {}): Record<string, string> {
  const kept = Object.entries(environment).filter((entry): entry is [string, string] => {
    const [name, value] = entry;
    if (value === undefined || name === 'NODE_TEST_CONTEXT') return false;
    return !/^(GRAPHYARD|HERDR)_/.test(name) || (passedTestControls as readonly string[]).includes(name);
  });
  return { ...Object.fromEntries(kept), ...set };
}

/** The variables a reserved window gives the suite: the base, and the per-file overrides the required check sets (tests/helpers/timing-stability.ts). */
export function testPortEnvironment(base: number): Record<string, string> {
  // tests/events-pagination.test.ts would otherwise share base + 25 with tests/reconciliation-snapshot.test.ts.
  return { GRAPHYARD_TEST_PORT: String(base), GRAPHYARD_EVENTS_TEST_PORT: String(base + 28) };
}

/** Whether nothing on this host listens on `port` at 127.0.0.1. */
export function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

/** One free port, chosen by the kernel. */
export function freePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen({ port: 0, host, exclusive: true }, () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
  });
}

/** A listening socket this process holds on `port`; the kernel frees it when the process exits, however it exits. */
export function holdPort(port: number, host = '127.0.0.1'): Promise<{ close(): void } | null> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(null));
    server.listen({ port, host, exclusive: true }, () => { server.unref(); resolve({ close: () => { server.close(); } }); });
  });
}

export interface TestPortReservation { base: number; span: number; sentinel: number; release(): void }
export interface ReserveOptions {
  span?: number; first?: number; last?: number;
  probe?: (port: number) => Promise<boolean>;
  hold?: typeof holdPort;
}

/**
 * Reserve a window of `span` ports for one test run. The window's last port is its sentinel: the
 * run listens on it until `release`, so taking the window is one exclusive bind the kernel decides
 * between concurrent runs — of any user on the host — and a run that exits, even killed, leaves no
 * lock behind to reclaim. No test listens on the sentinel (every per-file offset is below
 * `testPortSpan - 1`). With the sentinel held, every other port of the window must be free now, so
 * a leftover test Postgres from an earlier run moves this run to the next window.
 */
export async function reserveTestPorts(options: ReserveOptions = {}): Promise<TestPortReservation> {
  const span = options.span ?? testPortSpan, first = options.first ?? defaultTestPortBase, last = options.last ?? highestBase;
  const probe = options.probe ?? portFree, hold = options.hold ?? holdPort;
  if (!Number.isInteger(span) || span < 2) throw new Error(`A test port window needs its ports and a sentinel: span ${span} is below 2`);
  for (let base = first; base + span - 1 <= last; base += span) {
    const sentinel = base + span - 1;
    const held = await hold(sentinel);
    if (!held) continue;
    let free = true;
    for (let port = base; port < sentinel && free; port++) free = await probe(port);
    if (!free) { held.close(); continue; }
    return { base, span, sentinel, release: () => held.close() };
  }
  throw new Error(`No free window of ${span} test ports between ${first} and ${last}; stop a leftover test Postgres (ss -ltnp) and retry`);
}

/** Failures a test case or suite reports of its own code; any other `not ok` is a hook, a file or the process failing. */
const caseFailures: Record<string, string[]> = { test: ['testCodeFailure', 'testTimeoutFailure'], suite: ['subtestsFailed'] };

/**
 * Why a node:test run that proof runners judge by case title must not pass, or null. A proof's
 * files run whole, so another case of the same file failing is that case's business and leaves the
 * exit status nonzero on its own. Anything else behind a nonzero exit — a failing before/after
 * hook, an unhandled rejection or a crash after the last case (reported against the file, with
 * the child's exit code), or a signal — means the run did not complete normally, and no case it
 * reported passing is trusted.
 */
export function abnormalTestExit(tap: string, status: number | null, signal: NodeJS.Signals | string | null): string | null {
  if (signal) return `the test process was stopped by ${signal}`;
  if (status === 0) return null;
  const lines = tap.split('\n'), failures: { title: string; type?: string; failureType?: string; exited: boolean }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(\s*)not ok \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/);
    if (!match) continue;
    const failure: (typeof failures)[number] = { title: match[2], exited: false };
    // The case's YAML diagnostics follow it, indented two more spaces, between `---` and `...`.
    const indent = `${match[1]}  `;
    if (lines[index + 1] === `${indent}---`) for (let next = index + 2; next < lines.length && lines[next] !== `${indent}...`; next++) {
      const field = lines[next].slice(indent.length).match(/^(type|failureType|exitCode|signal): '?([^']*)'?$/);
      if (!field || lines[next].slice(0, indent.length) !== indent) continue;
      if (field[1] === 'type') failure.type = field[2];
      else if (field[1] === 'failureType') failure.failureType = field[2];
      else failure.exited = true;
    }
    failures.push(failure);
  }
  if (!failures.length) return `the test process exited with ${status} and reported no failing case`;
  const abnormal = failures.find(failure => failure.exited || !failure.type || !caseFailures[failure.type]?.includes(failure.failureType ?? ''));
  return abnormal ? `the test process exited with ${status} after "${abnormal.title}" failed as ${abnormal.failureType ?? 'an unclassified failure'}, not as a test case` : null;
}

/**
 * `npm ci` arguments and environment for an install a build and its tests run against: the full
 * tree always. An inherited NODE_ENV=production or npm_config_omit=dev would otherwise skip the
 * devDependencies (typescript, tsx, playwright) while npm still exits 0, an omit=optional in an
 * .npmrc would skip the platform packages (esbuild's binary for tsx, @embedded-postgres/*) that
 * the lockfile check tolerates as missing, and an inherited
 * npm_config_dry_run (or dry-run in an .npmrc) would install nothing and exit 0. An
 * ignore-scripts or bin-links=false setting would likewise exit 0 with a matching hidden lockfile
 * while skipping install scripts (esbuild, embedded Postgres) or node_modules/.bin (tsc, tsx).
 */
export const npmCiArgs = ['ci', '--include=dev', '--include=optional', '--no-dry-run', '--ignore-scripts=false', '--bin-links', '--no-audit', '--no-fund'];
export function npmCiEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (!/^(npm_config_(omit|only|production|also|dev|include|dry_run|dry-run|ignore_scripts|ignore-scripts|bin_links|bin-links)|NODE_ENV)$/i.test(name) && !withheldFromInstall.test(name)) clean[name] = value;
  return clean;
}
/**
 * The install runs the checkout's lifecycle scripts and its dependencies' outside any agent
 * sandbox, before a session starts, so it inherits none of the launcher's authority: no Graphyard
 * or Herdr variable (GRAPHYARD_TOKEN_FILE and every other credential or control among them) and no
 * GitHub token. npm's own registry settings stay: they are what the install needs.
 */
const withheldFromInstall = /^(GRAPHYARD_|HERDR_|GH_TOKEN$|GITHUB_TOKEN$|GH_ENTERPRISE_TOKEN$|GITHUB_ENTERPRISE_TOKEN$)/;

/** Whether `path` is `parent` or lies inside it. */
const within = (path: string, parent: string) => { const from = relative(parent, path); return from !== '..' && !from.startsWith('../') && !isAbsolute(from); };
/** An executable named `name` on the PATH `env` carries, or null. */
function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const directory of (env.PATH ?? '').split(delimiter)) if (directory && existsSync(join(directory, name))) return join(directory, name);
  return null;
}

export interface ContainedInstall { command: string; args: string[] }
/**
 * `npm ci` for a managed worktree, contained so its lifecycle scripts cannot read a credential
 * file. The install runs the checkout's scripts and its dependencies' as the coordinator's user,
 * outside any agent sandbox, and an environment without the launcher's variables is not enough:
 * the scripts could still open ~/.config/graphyard/<install>/tokens/*.token, a GitHub CLI login or
 * an SSH key by path. So npm runs under bubblewrap with the home directory, the Graphyard and XDG
 * config homes and the token file's directory replaced by empty ones; only what the install
 * writes (the worktree, npm's cache, TMPDIR) and what runs it (node, the PATH, ~/.npmrc for the
 * registry) are put back. A host without bubblewrap installs nothing rather than install
 * uncontained: the worktree reports the failed install, with this reason.
 */
export function containedInstall(cwd: string, env: NodeJS.ProcessEnv = process.env, options: { bwrap?: string | null; node?: string } = {}): ContainedInstall {
  const bwrap = options.bwrap === undefined ? onPath('bwrap', env) : options.bwrap;
  if (!bwrap) throw new Error('bubblewrap (bwrap) is not installed, and dependencies are never installed without it: the checkout\'s install scripts would run with read access to this host\'s credential files. Install bubblewrap (e.g. apt install bubblewrap) and recreate the worktree');
  const home = resolve(env.HOME || homedir());
  const directory = (path: string) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
  const credentials = [...new Set([
    env.GRAPHYARD_CONFIG_HOME, env.XDG_CONFIG_HOME, join(home, '.config'), join(home, '.ssh'),
    env.GRAPHYARD_TOKEN_FILE ? dirname(env.GRAPHYARD_TOKEN_FILE) : undefined,
  ].filter((path): path is string => !!path && isAbsolute(path)).map(path => resolve(path)))].filter(directory);
  const cache = resolve(env.npm_config_cache || join(home, '.npm'));
  if (within(cache, home)) mkdirSync(cache, { recursive: true });
  // node and npm are often installed under the home directory (nvm, mise, fnm): the folder above
  // each one's real executable holds the rest of it (node's prefix; npm's package, for npm-cli.js).
  const tools = [options.node ?? process.execPath, onPath('node', env), onPath('npm', env)].flatMap(path => { try { return path ? [dirname(dirname(realpathSync(path)))] : []; } catch { return []; } });
  const readable = [...tools, ...(env.PATH ?? '').split(delimiter).filter(isAbsolute), join(home, '.npmrc'), env.npm_config_userconfig]
    .filter((path): path is string => !!path).map(path => resolve(path));
  const writable = [cache, env.TMPDIR ? resolve(env.TMPDIR) : null].filter((path): path is string => !!path);
  const args = ['--dev-bind', '/', '/', '--die-with-parent', '--tmpfs', home], made = new Set<string>();
  // A path put back inside the emptied home keeps the symlinks on its way (mise's installs/node/26
  // -> 26.10.0, from which npm's own links resolve), each recreated and followed to what it names.
  const expose = (path: string, flag: string, depth = 0): void => {
    if (depth > 16 || !within(path, home) || path === home || !existsSync(path) || credentials.some(parent => within(path, parent))) return;
    for (let at = path; at !== home; at = dirname(at)) {
      if (!lstatSync(at).isSymbolicLink()) continue;
      const target = readlinkSync(at);
      if (!made.has(at)) { made.add(at); args.push('--symlink', target, at); }
      return expose(join(resolve(dirname(at), target), relative(at, path)), flag, depth + 1);
    }
    if (!made.has(path)) { made.add(path); args.push(flag, path, path); }
  };
  for (const path of readable) expose(path, '--ro-bind');
  for (const path of writable) expose(path, '--bind');
  // Emptied last, so no folder put back above re-exposes one; outside the home directory too.
  for (const path of credentials) if (!within(path, home) || [...made].some(exposed => within(path, exposed))) args.push('--tmpfs', path);
  args.push('--bind', resolve(cwd), resolve(cwd), '--chdir', resolve(cwd), '--', 'npm', ...npmCiArgs);
  return { command: bwrap, args };
}

/**
 * A digest of everything a transpiler loads when the trusted unit runner passes it to `--import`:
 * the package `entry` resolves into and every package it depends on, found as node finds them
 * (a nested node_modules first, then each one above), each package's whole folder (a nested
 * node_modules added to shadow a dependency changes its parent's digest), and the node binary
 * that runs it. The candidate's `npm ci` runs lifecycle scripts as the runner's user, which can
 * write the harness's own node_modules; the runner records this digest before that install and
 * refuses to run, or to judge a run, when it differs afterwards.
 */
export function loaderDigest(entry: string, node: string = process.execPath): string {
  const file = entry.startsWith('file:') ? fileURLToPath(entry) : resolve(entry);
  let root = dirname(file);
  while (!existsSync(join(root, 'package.json')) || !/(^|\/)node_modules\/(@[^/]+\/)?[^/@]+$/.test(root)) {
    if (dirname(root) === root) throw new Error(`${file} does not lie in an installed package`);
    root = dirname(root);
  }
  const hash = createHash('sha256'), seen = new Set<string>(), queue = [root];
  const walk = (path: string, label: string) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) hash.update(`link ${label} ${readlinkSync(path)}\n`);
    else if (info.isDirectory()) { hash.update(`dir ${label}\n`); for (const name of readdirSync(path).sort()) walk(join(path, name), `${label}/${name}`); }
    else hash.update(`file ${label} ${info.mode} `).update(readFileSync(path)).update('\n');
  };
  while (queue.length) {
    const directory = queue.shift()!;
    if (seen.has(directory)) continue;
    seen.add(directory); walk(directory, directory);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
      for (let at = directory; ; at = dirname(at)) {
        const candidate = basename(at) === 'node_modules' ? null : join(at, 'node_modules', name);
        if (candidate && existsSync(join(candidate, 'package.json'))) { queue.push(candidate); break; }
        if (dirname(at) === at) break;
      }
    }
  }
  hash.update(`node ${node} `).update(readFileSync(node));
  return hash.digest('hex');
}

/**
 * Why a TAP stream cannot decide the required titles, or null. The verdict of a required case is
 * read by its title, so each must report exactly once: a module the inventory imports can register
 * a later case under a required title, and a map keeping the last verdict would let that
 * duplicate's pass stand in for the protected case's failure.
 */
export function repeatedRequiredTitle(tap: string, titles: string[]): string | null {
  const counts = new Map<string, number>(titles.map(title => [title, 0]));
  for (const line of tap.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:ok|not ok) \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/);
    if (match && counts.has(match[1])) counts.set(match[1], counts.get(match[1])! + 1);
  }
  const repeated = [...counts].find(([, count]) => count > 1);
  return repeated ? `the required case "${repeated[0]}" reported ${repeated[1]} verdicts, so none of them identifies the protected case` : null;
}
