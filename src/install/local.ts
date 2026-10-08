// The local provider (GY-1500): the same server and Store code path as every other provider, on
// this machine, against an embedded Postgres cluster under the install directory — no Docker.
//
// Everything it writes lives under ~/.config/graphyard/INSTALL/ like every provider's credentials:
// postgres/ (0700) holds the cluster, its 0600 password file and its port, and local-server.json
// (0600) the server's variables. A systemd user unit restarts the runtime (src/install/local-runtime.ts)
// as one restarts the master loop; a host without a systemd user manager gets the foreground command
// to keep alive under its own supervisor, as `master init` reports for the loop's unit.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, openSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyObservation, httpHealth, variableMarker, type AdapterContext, type ProviderAdapter } from './adapters.js';
import { clusterExists, localDatabaseUrl, localPaths, postgresBinaries, postgresPackage, readLocalEnvironment, type LocalPaths } from './local-runtime.js';
import { loopUnitDirectory, supervisorSupport, testSuiteHomeGuard } from '../supervisor.js';
import type { EnvValue, PreflightItem } from './types.js';

/** How the runtime is kept alive on this machine. A test supervisor runs it in-process. */
export interface LocalSupervisor {
  /** systemd when this host has a reachable user manager; otherwise null and the reason. */
  systemd: { unitDirectory: string } | null;
  reason: string | null;
  /** `systemctl --user ARGS`, returning stdout; throws on a failed command. */
  systemctl(args: string[]): Promise<string>;
  /** Without systemd: start COMMAND detached, its output appended to LOG; returns its pid. */
  detach(command: string[], log: string): Promise<number>;
  /** Without systemd: stop the process the last apply started. */
  kill(pid: number): Promise<void>;
}

export interface LocalSettings {
  paths: LocalPaths;
  /** The cluster's loopback port: the recorded one, else a free one chosen for this install. */
  postgresPort: number;
  /** The unit that restarts the runtime, named for the install. */
  unit: string;
  /** The foreground command that runs the runtime: what the unit starts, and what a host without systemd keeps alive. */
  command: string[];
  supervisor: LocalSupervisor;
}

export const MINIMUM_NODE_MAJOR = 24;
export const localUnit = (installId: string) => `graphyard-local-${installId}.service`;
const runtimeEntry = () => fileURLToPath(new URL('./local-runtime.ts', import.meta.url));

/** `node --import tsx src/install/local-runtime.ts DIRECTORY`, from the checkout the installer runs. */
export function runtimeCommand(directory: string, execPath = process.execPath) {
  return [execPath, '--import', import.meta.resolve('tsx'), runtimeEntry(), directory];
}

/** A free loopback port the kernel hands out. */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((accept, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => accept(port)); });
  });
}

/** True when nothing listens on 127.0.0.1:PORT. */
export function loopbackPortFree(port: number): Promise<boolean> {
  return new Promise(accept => {
    const server = createServer();
    server.once('error', () => accept(false));
    server.listen(port, '127.0.0.1', () => server.close(() => accept(true)));
  });
}

export function systemdSupervisor(): LocalSupervisor {
  const support = supervisorSupport();
  return {
    systemd: support.supported ? { unitDirectory: loopUnitDirectory() } : null,
    reason: support.reason,
    systemctl: async args => execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    detach: async (command, log) => {
      const out = openSync(log, 'a', 0o600);
      const child = spawn(command[0], command.slice(1), { detached: true, stdio: ['ignore', out, out] });
      child.unref();
      return child.pid!;
    },
    kill: async pid => { try { process.kill(pid, 'SIGTERM'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; } },
  };
}

/** The install's local settings: its recorded Postgres port, or a free one the apply records. */
export async function localSettings(directory: string, installId: string, supervisor: LocalSupervisor = systemdSupervisor()): Promise<LocalSettings> {
  const paths = localPaths(directory);
  let postgresPort: number | null = null;
  try { const recorded = Number((await readFile(paths.portFile, 'utf8')).trim()); if (Number.isInteger(recorded) && recorded > 0) postgresPort = recorded; }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  return { paths, postgresPort: postgresPort ?? await freeLoopbackPort(), unit: localUnit(installId), command: runtimeCommand(paths.directory), supervisor };
}

const settings = (ctx: AdapterContext) => {
  if (!ctx.local) throw new Error('The local provider was prepared without its local settings');
  return ctx.local;
};
const serverUrl = (ctx: AdapterContext) => `http://127.0.0.1:${ctx.port}`;

/** One systemd word: % escaped as a specifier, quoted when it holds whitespace; a quote, backslash or newline has no spelling. */
function unitWord(value: string) {
  if (/[\r\n\0"\\]/.test(value)) throw new Error(`${value} cannot be written into a systemd unit: it contains a newline, quote or backslash`);
  const escaped = value.replaceAll('%', '%%');
  return /\s/.test(escaped) ? `"${escaped}"` : escaped;
}

export function localUnitText(ctx: AdapterContext) {
  const local = settings(ctx);
  if (/\s/.test(local.paths.directory)) throw new Error(`The install directory ${local.paths.directory} cannot be a systemd WorkingDirectory: it contains whitespace`);
  return `# Generated by graphyard install --provider local for ${ctx.repository.replace(/[\r\n\0]/g, ' ')}; rerunning the
# install rewrites it. It runs the control plane against the embedded Postgres cluster under
# ${local.paths.postgres}; the variables and credentials stay in that install directory (0600).
[Unit]
Description=Graphyard control plane on embedded Postgres (${ctx.repository.replace(/[\r\n\0]/g, ' ')})
After=network.target
# Never give up restarting it, as the master loop's unit does not.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${unitWord(local.paths.directory)}
ExecStart=${local.command.map(unitWord).join(' ')}
Restart=always
RestartSec=2
# SIGTERM reaches only the runtime, which closes its store before it stops the cluster; the
# postgres children it spawned get SIGKILL only if they outlive TimeoutStopSec.
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=60
UMask=0077

[Install]
WantedBy=default.target
`;
}

/** The plan's step for a host without a systemd user manager, worded as master init's for the loop. */
export function foregroundInstruction(ctx: AdapterContext) {
  const local = settings(ctx);
  return `Graphyard cannot install a supervisor for the local control plane on this host (${local.supervisor.reason ?? 'no systemd user manager'}), so a crashed, killed, or rebooted server stays down until a person starts it. Keep it alive yourself - run "${local.command.join(' ')}" under this platform's own always-restart supervisor (launchd on macOS, an init service elsewhere), configure that supervisor to start at boot, and check ${serverUrl(ctx)}/healthz.`;
}

async function writePrivate(file: string, content: string) {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

async function readText(file: string) {
  try { return await readFile(file, 'utf8'); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}

const digest = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex');

/** Whether the process the last apply started without systemd is still alive. */
function detachedAlive(paths: LocalPaths) {
  try { const pid = Number(readFileSync(paths.pid, 'utf8').trim()); if (!pid) return null; process.kill(pid, 0); return pid; }
  catch { return null; }
}

export const localAdapter: ProviderAdapter = {
  provider: 'local',
  async preflight(ctx) {
    const local = settings(ctx);
    const major = Number(process.versions.node.split('.')[0]);
    const items: PreflightItem[] = [
      { name: 'Node.js', ok: major >= MINIMUM_NODE_MAJOR, detail: `Node ${process.versions.node}`, fix: `Install Node ${MINIMUM_NODE_MAJOR} or newer (nodejs.org, or nvm install ${MINIMUM_NODE_MAJOR}), then rerun the installer with it` },
    ];
    try {
      const binaries = await postgresBinaries();
      items.push({ name: 'Embedded Postgres', ok: true, detail: `${binaries.package} provides ${binaries.postgres}; no Docker is needed` });
    } catch (error) {
      items.push({ name: 'Embedded Postgres', ok: false, detail: `the ${postgresPackage()} binaries are not resolvable: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`, fix: 'Run npm install in the Graphyard checkout without --omit=optional: embedded-postgres and its platform binaries are dependencies' });
    }
    // The server's port is free, or this installation already serves on it; the cluster's is free,
    // or it is the port this installation's cluster recorded.
    const serving = !await loopbackPortFree(ctx.port) && await httpHealth(ctx, serverUrl(ctx));
    const serverPort = serving || await loopbackPortFree(ctx.port);
    const recorded = existsSync(local.paths.portFile);
    const databasePort = recorded || await loopbackPortFree(local.postgresPort);
    items.push({ name: 'Loopback port', ok: serverPort && databasePort,
      detail: serverPort && databasePort ? `server 127.0.0.1:${ctx.port}${serving ? ' (this installation serves on it)' : ''}; Postgres 127.0.0.1:${local.postgresPort}${recorded ? ' (recorded for this cluster)' : ''}`
        : `${serverPort ? '' : `127.0.0.1:${ctx.port} is taken by another process`}${!serverPort && !databasePort ? '; ' : ''}${databasePort ? '' : `127.0.0.1:${local.postgresPort} is taken by another process`}`,
      fix: 'Pass --port PORT with a free loopback port for the server, or stop what listens there, then rerun' });
    items.push({ name: 'Supervisor', ok: true, detail: local.supervisor.systemd ? `systemd user unit ${local.unit} restarts the control plane` : `no systemd user manager (${local.supervisor.reason ?? 'unavailable'}); the plan names the foreground command to keep alive` });
    return items;
  },
  async observe(ctx) {
    const local = settings(ctx);
    const observation = emptyObservation();
    observation.database = observation.compute = clusterExists(local.paths);
    const environment = await readLocalEnvironment(local.paths);
    if (environment) {
      observation.installed = true;
      for (const [name, value] of Object.entries(environment)) observation.variables[name] = variableMarker(name, value);
      observation.variablesObserved = true;
    }
    observation.app = await httpHealth(ctx, serverUrl(ctx));
    observation.url = observation.app ? serverUrl(ctx) : null;
    observation.detail.push(observation.database ? `Embedded Postgres cluster at ${local.paths.data}` : `No cluster at ${local.paths.data} yet`);
    return observation;
  },
  plan(ctx, observation) {
    const local = settings(ctx);
    return [
      { id: 'provider.provision.database', target: 'provider', state: observation.database ? 'satisfied' : 'create',
        title: `Create the embedded Postgres cluster under ${local.paths.postgres} (directory 0700, password file 0600) on 127.0.0.1:${local.postgresPort}; no Docker`,
        command: `initdb --pgdata=${local.paths.data} --auth=scram-sha-256 --username=graphyard --pwfile=${local.paths.passwordFile}` },
      local.supervisor.systemd
        ? { id: 'provider.provision.app', target: 'provider', state: observation.app ? 'satisfied' : 'create',
          title: `Run the Graphyard server on 127.0.0.1:${ctx.port} from ${ctx.sourceRoot} under the systemd user unit ${local.unit}, which starts the cluster, migrates and restarts it`,
          command: `systemctl --user enable --now ${local.unit}` }
        : { id: 'provider.provision.app', target: 'provider', state: observation.app ? 'satisfied' : 'create',
          title: `Run the Graphyard server on 127.0.0.1:${ctx.port} in the foreground; this host has no systemd user manager`,
          command: local.command.join(' '), human: foregroundInstruction(ctx) },
    ];
  },
  async provision(ctx) {
    const { paths } = settings(ctx);
    await mkdir(paths.postgres, { recursive: true, mode: 0o700 });
    await chmod(paths.postgres, 0o700);
    // The password file is the install's own database credential, minted before provision (0600).
    if (!existsSync(paths.passwordFile)) throw new Error(`The cluster password file ${paths.passwordFile} was not generated`);
    await chmod(paths.passwordFile, 0o600);
    if ((await readText(paths.portFile))?.trim() !== String(settings(ctx).postgresPort)) await writePrivate(paths.portFile, `${settings(ctx).postgresPort}\n`);
    if (!clusterExists(paths)) {
      const { initialiseCluster } = await import('./local-runtime.js');
      await initialiseCluster(paths);
    }
  },
  async setEnv(ctx, values) {
    // Sets VALUES and keeps every other variable, so the core-only write of a rerun changes nothing.
    const { paths } = settings(ctx);
    const current = await readLocalEnvironment(paths) ?? {};
    const next = { ...current, ...Object.fromEntries(values.map(value => [value.name, value.value])) };
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (await readText(paths.environment) !== text) await writePrivate(paths.environment, text);
  },
  async applyVariables(ctx, values: EnvValue[]) {
    await localAdapter.setEnv(ctx, values);
    await localAdapter.deploy(ctx);
  },
  async deploy(ctx) {
    const local = settings(ctx), { paths, supervisor } = local;
    const environment = await readText(paths.environment) ?? '';
    if (supervisor.systemd) {
      const unitPath = join(supervisor.systemd.unitDirectory, local.unit);
      const text = localUnitText(ctx);
      const stamp = digest(text, environment);
      const active = await supervisor.systemctl(['is-active', local.unit]).then(state => state.trim() === 'active', () => false);
      if (active && await readText(paths.deployed) === `${stamp}\n` && await readText(unitPath) === text) return;
      if (await readText(unitPath) !== text) {
        testSuiteHomeGuard(supervisor.systemd.unitDirectory);
        await mkdir(supervisor.systemd.unitDirectory, { recursive: true });
        await writeFile(unitPath, text, { mode: 0o644 });
        await supervisor.systemctl(['daemon-reload']);
      }
      await supervisor.systemctl(['enable', '--now', local.unit]);
      // A running runtime started from older variables or an older unit takes the new ones only on restart.
      if (active) await supervisor.systemctl(['restart', local.unit]);
      await writePrivate(paths.deployed, `${stamp}\n`);
      return;
    }
    const stamp = digest(local.command.join('\0'), environment);
    const running = detachedAlive(paths);
    if (running && await readText(paths.deployed) === `${stamp}\n`) return;
    if (running) await supervisor.kill(running);
    const pid = await supervisor.detach(local.command, paths.log);
    await writePrivate(paths.pid, `${pid}\n`);
    await writePrivate(paths.deployed, `${stamp}\n`);
  },
  async url(ctx) { return serverUrl(ctx); },
  health: (ctx, url) => httpHealth(ctx, url),
  async logs(ctx, lines = 100) {
    const local = settings(ctx);
    if (local.supervisor.systemd) {
      const result = await ctx.transport.exec('journalctl', ['--user', '-u', local.unit, '-n', String(lines), '--no-pager'], { allowFailure: true, timeout: 60_000 });
      return ctx.vault.scrub(result.stdout || result.stderr);
    }
    return ctx.vault.scrub(((await readText(local.paths.log)) ?? '').split('\n').slice(-lines).join('\n'));
  },
};

/** The local DATABASE_URL: the install's cluster on 127.0.0.1, with the password from its 0600 file. */
export const localDatabaseVariable = (ctx: Pick<AdapterContext, 'databasePassword' | 'local'>) => localDatabaseUrl(ctx.databasePassword, settings(ctx as AdapterContext).postgresPort);
