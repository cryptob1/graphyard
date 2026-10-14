// Concern: Herdr on this host, set up by `graphyard up` (GY-1511) — its binary, its server's user unit,
// an install's own instance, and the synchronous calls setup makes. Kept apart from src/master/herdr.ts,
// which the loop reaches and which runs children only through the asynchronous runner (GY-125).
import { execFile, execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { herdrInstanceEnv, herdrInvocation, herdrTarget, type HerdrInstance } from './master/herdr.js';

/** The synchronous form, for the few callers that run herdr with execFileSync. */
export function herdrSync(args: string[], options: ExecFileSyncOptions & { encoding: BufferEncoding }, instance: HerdrInstance | null = herdrTarget()): string {
  const call = herdrInvocation(args, instance);
  return String(execFileSync(call.command, call.args, call.env ? { ...options, env: { ...call.env, ...options.env, XDG_CONFIG_HOME: instance!.configHome } } : options));
}

/** What host setup runs and touches; `hostHerdrSetup` is the process's own, a test hands in a table. */
export interface HerdrHostDeps {
  exec(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, text: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  exists(path: string): boolean;
  sleep(ms: number): Promise<void>;
  home: string;
  /** The PATH the server's panes inherit, so a session finds the runtimes the operator's shell does. */
  path: string;
  /** The account the user units run under, whose lingering keeps them running after a reboot. */
  user: string;
}
export type HerdrSetupStep = 'install' | 'server' | 'workspace' | 'plugin';
/** A named, recorded reason Herdr is left out of an install: the only way up leaves it out. */
export class HerdrSetupFailure extends Error {
  constructor(readonly step: HerdrSetupStep, detail: string) { super(`Herdr ${step} failed: ${detail}`); this.name = 'HerdrSetupFailure'; }
}
/** Herdr's own documented installer for Linux and macOS: it installs to ~/.local/bin, with no root. */
export const herdrInstaller = 'curl -fsSL https://herdr.dev/install.sh | sh';
const outputTail = (result: { stdout: string; stderr: string }) => `${result.stderr || result.stdout}`.trim().split('\n').slice(-3).join(' ').slice(0, 300) || 'no output';

/** The absolute herdr binary on this host, installed with Herdr's own installer when there is none. */
export async function ensureHerdrBinary(deps: HerdrHostDeps): Promise<{ binary: string; installed: boolean }> {
  const local = join(deps.home, '.local', 'bin', 'herdr');
  const located = async () => {
    const found = await deps.exec('sh', ['-c', 'command -v herdr']).catch(() => null);
    const onPath = found?.code === 0 ? found.stdout.trim().split('\n')[0] : '';
    for (const binary of [onPath, local]) if (binary && (await deps.exec(binary, ['--version']).catch(() => null))?.code === 0) return binary;
    return null;
  };
  const present = await located();
  if (present) return { binary: present, installed: false };
  const result = await deps.exec('sh', ['-c', herdrInstaller], { timeoutMs: 300_000 }).catch(error => ({ code: 1, stdout: '', stderr: String(error?.message ?? error) }));
  const installed = await located();
  if (!installed) throw new HerdrSetupFailure('install', `herdr is not installed and Herdr's installer (${herdrInstaller}) ${result.code === 0 ? 'left no working herdr in ~/.local/bin' : `exited ${result.code}: ${outputTail(result)}`}`);
  return { binary: installed, installed: true };
}

/** The user unit that keeps an instance's server running across reboots: the default's, or one per install for its own. */
export const herdrServerUnit = (installId: string | null) => installId ? `graphyard-herdr-${installId}.service` : 'graphyard-herdr.service';
const unitWord = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/["\\]/g, '\\$&')}"`;
export function herdrServerUnitText(binary: string, instance: HerdrInstance | null, path: string) {
  const call = herdrInvocation(['server'], instance);
  return `[Unit]
Description=Herdr server for Graphyard${instance ? ` (${instance.session})` : ''}
After=network.target

[Service]
Type=simple
Environment=${unitWord(`PATH=${path}`)}
${instance ? `Environment=${unitWord(`XDG_CONFIG_HOME=${instance.configHome}`)}
Environment=${unitWord(`${herdrInstanceEnv.configHome}=${instance.configHome}`)}
Environment=${unitWord(`${herdrInstanceEnv.session}=${instance.session}`)}
` : ''}ExecStart=${[binary, ...call.args].map(unitWord).join(' ')}
Restart=on-failure
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
}
async function herdrAt(deps: HerdrHostDeps, binary: string, args: string[], instance: HerdrInstance | null) {
  const call = herdrInvocation(args, instance);
  return deps.exec(binary, call.args, { ...(call.env ? { env: call.env } : {}), timeoutMs: 30_000 }).catch(error => ({ code: 1, stdout: '', stderr: String(error?.message ?? error) }));
}
export async function herdrServerRunning(deps: HerdrHostDeps, binary: string, instance: HerdrInstance | null) {
  const status = await herdrAt(deps, binary, ['status', 'server'], instance);
  return status.code === 0 && /^status:\s*running\s*$/m.test(status.stdout);
}

/**
 * The instance's server, running: left as it is when it already runs, else started as a user unit
 * that restarts on failure and comes back after a reboot (with lingering, so no login is needed).
 */
export async function ensureHerdrServer(deps: HerdrHostDeps, binary: string, instance: HerdrInstance | null, installId: string | null, waitMs = 15_000): Promise<{ started: boolean; unit: string | null }> {
  const unit = herdrServerUnit(instance ? installId : null);
  const directory = join(deps.home, '.config', 'systemd', 'user');
  if (await herdrServerRunning(deps, binary, instance)) {
    // A server this unit runs comes back after a reboot only while lingering holds, so that is checked on every run too.
    if (deps.exists(join(directory, unit))) await ensureLinger(deps);
    return { started: false, unit: null };
  }
  if (instance) await deps.mkdir(instance.configHome);
  await deps.mkdir(directory);
  await deps.writeFile(join(directory, unit), herdrServerUnitText(binary, instance, deps.path));
  for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', unit]]) {
    const result = await deps.exec('systemctl', args).catch(error => ({ code: 1, stdout: '', stderr: String(error?.message ?? error) }));
    if (result.code !== 0) throw new HerdrSetupFailure('server', `systemctl ${args.join(' ')} exited ${result.code}: ${outputTail(result)}`);
  }
  await ensureLinger(deps);
  for (const deadline = Date.now() + waitMs; ; await deps.sleep(500)) {
    if (await herdrServerRunning(deps, binary, instance)) return { started: true, unit };
    if (Date.now() >= deadline) throw new HerdrSetupFailure('server', `${unit} was started but the Herdr server${instance ? ` for session ${instance.session}` : ''} did not report running within ${Math.round(waitMs / 1000)}s; see journalctl --user -u ${unit}`);
  }
}

/**
 * Lingering for the account the units run under: its user manager, and so the Herdr unit, starts at
 * boot with nobody logged in. Read back after enabling it, since loginctl may refuse an unprivileged
 * user; lingering that cannot be established is a named failure, never a unit reported to survive a
 * reboot it would not.
 */
export async function ensureLinger(deps: Pick<HerdrHostDeps, 'exec' | 'user'>) {
  const lingering = async () => (await deps.exec('loginctl', ['show-user', deps.user, '--property=Linger', '--value']).catch(() => null))?.stdout.trim() === 'yes';
  if (await lingering()) return;
  const result = await deps.exec('loginctl', ['enable-linger', deps.user]).catch(error => ({ code: 1, stdout: '', stderr: String(error?.message ?? error) }));
  if (await lingering()) return;
  throw new HerdrSetupFailure('server', `lingering is off for ${deps.user} and loginctl enable-linger ${deps.user} ${result.code === 0 ? 'left it off' : `exited ${result.code}: ${outputTail(result)}`}, so the Herdr server would not start after a reboot until ${deps.user} logs in; have an administrator run sudo loginctl enable-linger ${deps.user}, then rerun`);
}

/**
 * What an install's own instance needs beside its server: the configuration other tools read from
 * XDG_CONFIG_HOME (gh, git), linked in, since the panes inherit the instance's; and its session in
 * the default config's session list, so plain `herdr --session NAME` (and `herdr --remote HOST
 * --session NAME`) reaches its socket. Nothing in the default instance's own configuration changes.
 */
export async function prepareHerdrInstance(deps: HerdrHostDeps, instance: HerdrInstance) {
  await deps.mkdir(join(instance.configHome, 'herdr', 'sessions', instance.session));
  for (const shared of ['gh', 'git']) {
    const source = join(deps.home, '.config', shared), target = join(instance.configHome, shared);
    if (deps.exists(source) && !deps.exists(target)) await deps.symlink(source, target).catch(() => undefined);
  }
  const sessions = join(deps.home, '.config', 'herdr', 'sessions'), alias = join(sessions, instance.session);
  if (!deps.exists(alias)) { await deps.mkdir(sessions); await deps.symlink(join(instance.configHome, 'herdr', 'sessions', instance.session), alias).catch(() => undefined); }
}

/** The instance's workspace for this repository: the one labelled LABEL, else one created there. */
export async function ensureHerdrWorkspace(deps: HerdrHostDeps, binary: string, instance: HerdrInstance, root: string, label: string): Promise<string> {
  const workspaceIn = (text: string) => {
    try {
      const parsed = JSON.parse(text), result = parsed?.result ?? parsed;
      const listed = Array.isArray(result?.workspaces) ? result.workspaces.find((entry: any) => entry?.label === label) : result?.workspace ?? result;
      return typeof listed?.workspace_id === 'string' ? listed.workspace_id as string : null;
    } catch { return null; }
  };
  const listed = workspaceIn((await herdrAt(deps, binary, ['workspace', 'list'], instance)).stdout);
  if (listed) return listed;
  const created = await herdrAt(deps, binary, ['workspace', 'create', '--cwd', root, '--label', label, '--no-focus'], instance);
  const workspace = workspaceIn(created.stdout);
  if (!workspace) throw new HerdrSetupFailure('workspace', `herdr workspace create in session ${instance.session} answered no workspace: ${outputTail(created)}`);
  return workspace;
}

/** This host as host setup sees it: real commands, files and clock, and the operator's PATH with ~/.local/bin first. */
export function hostHerdrDeps(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): HerdrHostDeps {
  return {
    home, path: withLocalBin(env.PATH, home), user: env.USER || userInfo().username,
    exec: (command, args, options = {}) => new Promise(accept => {
      execFile(command, args, { encoding: 'utf8', timeout: options.timeoutMs ?? 60_000, maxBuffer: 8_000_000, env: { ...(options.env ?? env), PATH: withLocalBin((options.env ?? env).PATH, home) } }, (error: any, stdout, stderr) =>
        accept({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? error?.message ?? '') }));
    }),
    readFile: async path => { try { return await readFile(path, 'utf8'); } catch { return null; } },
    writeFile: (path, text) => writeFile(path, text, { mode: 0o644 }),
    mkdir: async path => { await mkdir(path, { recursive: true, mode: 0o700 }); },
    symlink: (target, path) => symlink(target, path),
    exists: path => existsSync(path),
    sleep: ms => sleep(ms),
  };
}
/** PATH with ~/.local/bin, where Herdr's installer puts herdr, ahead of the rest when it is missing. */
export function withLocalBin(path: string | undefined, home: string = homedir()) {
  const local = join(home, '.local', 'bin'), entries = (path ?? '/usr/local/bin:/usr/bin:/bin').split(delimiter).filter(Boolean);
  return entries.includes(local) ? entries.join(delimiter) : [local, ...entries].join(delimiter);
}
