// `graphyard install move --to HOST` (GY-3318): one command moves an install to another host. It
// checks through the running control plane that nothing is leased, trialled or queued to merge,
// re-points the registry accounts placed on this host, stops the install, copies the database, the
// install files and every credential file master.json names, rewrites hostId on the target and
// prints what to start there. The copy is plain rsync, outside any coordination transaction.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { atomicPrivateWrite, readCredentialFile } from '../private-file.js';
import { registryCommand } from '../cli/master-registry.js';
import { daemonStatePath, readDaemonState } from '../daemon/state.js';
import { masterConfigSchema } from '../master/profiles.js';
import type { AgentRegistry } from '../model/registry.js';
import { installDirectory } from './secrets.js';
import { installIdFor } from './types.js';
import { deployUnitOf, readInstallUnits, userUnitDirectory } from './units.js';
import { localUnit } from './local.js';

export interface MoveApi { read(path: string): Promise<any>; write(path: string, data: unknown): Promise<any> }
export interface MoveDependencies {
  /** The config home install directories live under (default ~/.config/graphyard). */
  configHome?: string;
  unitDirectory?: string;
  /** The control plane, as the master's coordinator credential reaches it. */
  api?: MoveApi;
  /** Stops the install's units and server; default runs the stop commands the plan lists. */
  stop?: (commands: string[][]) => Promise<void>;
  /** Runs one program; default spawns it and fails on a nonzero exit. */
  run?: (program: string, args: string[]) => Promise<void>;
}

const run = (program: string, args: string[]) => new Promise<void>((accept, reject) => {
  const child = spawn(program, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let error = '';
  child.stderr.on('data', chunk => { error += chunk; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? accept() : reject(new Error(`${program} ${args.join(' ')} exited with ${code}: ${error.trim().split('\n').slice(-3).join(' ')}`)));
});

/** Every `credentialFile` master.json names, wherever it sits (master, operator agent, workers, reviewers, producers, upstream). */
function credentialFiles(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const entry of value) credentialFiles(entry, found);
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
    if (key === 'credentialFile' && typeof entry === 'string') found.add(entry); else credentialFiles(entry, found);
  }
  return found;
}

function masterApi(url: string, token: string): MoveApi {
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${url}/api/${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
      .catch(error => { throw new Error(`The control plane at ${url} is unreachable (${error.message}); the move checks leases and re-points accounts through it, so start it and rerun`); });
    const body = await response.json();
    if (!response.ok) throw new Error(`${path}: ${JSON.stringify(body)}`);
    return body;
  };
  return { read: path => call(path), write: (path, data) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(data) }) };
}

/** The move of the install whose checkout is ROOT to host TO; `into` writes the target's files under that directory instead of `TO:` over SSH. */
export async function moveInstall(root: string, options: { to: string; into?: string; plan?: boolean }, dependencies: MoveDependencies = {}) {
  root = resolve(root);
  const masterFile = join(root, '.graphyard/master.json'), connectionFile = join(root, '.graphyard/connection.json');
  const stored = JSON.parse(await readFile(masterFile, 'utf8'));
  const config = masterConfigSchema.parse(stored);
  const from = config.hostId, to = options.to.trim();
  if (!to) throw new Error('Use install move --to HOST [--into DIR] [--plan]');
  if (to === from) throw new Error(`This install is already on ${to}`);
  const installId = installIdFor(config.repository), directory = installDirectory(installId, dependencies.configHome);
  const postgres = join(directory, 'postgres'), local = existsSync(postgres);
  const volume = `graphyard-${installId}_graphyard-data`, volumeArchive = join(directory, 'graphyard-data.tar');
  const database = local ? { kind: 'directory' as const, path: postgres } : { kind: 'volume' as const, volume, archive: volumeArchive };
  let units: { master: string; deploy: string } | null = null;
  try { const recorded = readInstallUnits(root, dependencies.unitDirectory); units = { master: recorded.master, deploy: deployUnitOf(recorded) }; } catch { /* no units recorded: nothing to stop or copy */ }
  const unitDirectory = dependencies.unitDirectory ?? userUnitDirectory();
  const unitNames = [...(units ? [units.master, units.deploy] : []), ...(local ? [localUnit(installId)] : [])];
  const unitFiles = unitNames.map(name => join(unitDirectory, name)).filter(file => existsSync(file));
  const daemonState = daemonStatePath(config);
  const files = [root, directory, ...unitFiles, ...(existsSync(daemonState) ? [daemonState] : [])];
  const credentials = [...credentialFiles(stored)].sort();

  const api = dependencies.api ?? masterApi(config.url, await readCredentialFile(config.credentialFile));
  const { work } = await api.read('work-snapshot') as { work: { key: string; lease?: { owner: string } | null }[] };
  const state = await readDaemonState(root, config).catch(() => null);
  const refusals = [
    ...work.filter(item => item.lease).map(item => `${item.key} is leased to ${item.lease!.owner}`),
    ...(state?.mergeWriter.inFlight ? [`${state.mergeWriter.inFlight.key} is in a merge trial`] : []),
    ...(state?.mergeWriter.queue ?? []).map(entry => `${entry.key} is queued to merge`),
  ];
  const registry = await api.read('agent-registry/document') as AgentRegistry;
  const accounts = registry.accounts.filter(account => account.credential.host === from).map(account => account.name);
  const destination = (path: string) => options.into ? join(resolve(options.into), path) : `${to}:${path}`;
  const stop = [...unitNames.map(name => ['systemctl', '--user', 'stop', name]), ...(local ? [] : [['docker', 'compose', '--project-directory', join(directory, 'compose'), 'stop']])];
  const start = [
    ...(local ? [] : [`docker volume create ${volume}`, `docker run --rm -v ${volume}:/data -v ${directory}:/in postgres:17-alpine tar -C /data -xf /in/graphyard-data.tar`, `docker compose --project-directory ${join(directory, 'compose')} up -d`]),
    ...(unitNames.length ? ['systemctl --user daemon-reload', `systemctl --user enable --now ${unitNames.join(' ')}`] : []),
    `cd ${root} && graphyard master status`,
  ];
  const plan = { from, to, target: options.into ? resolve(options.into) : `${to} over SSH`, database, files, credentials, accounts, refusals, stop: stop.map(command => command.join(' ')), start };
  if (options.plan) return { ...plan, applied: false, next: refusals.length ? 'Wait until nothing is leased, trialled or queued, then rerun without --plan' : 'Rerun without --plan to move the install' };
  if (refusals.length) throw new Error(`The install cannot move while work is in flight: ${refusals.join('; ')}`);

  const reason = `Install moved from ${from} to ${to}`;
  for (const name of accounts) await registryCommand(config, ['account', 'set', name, '--host', to, '--reason', reason], api);
  await (dependencies.stop ?? (async commands => { for (const [program, ...args] of commands) await (dependencies.run ?? run)(program!, args).catch(() => {}); }))(stop);

  const exec = dependencies.run ?? run;
  const copy = (path: string, extra: string[] = []) => exec('rsync', ['-a', '--mkpath', ...extra, path, destination(path)]);
  if (!local) await exec('docker', ['run', '--rm', '-v', `${volume}:/data`, '-v', `${directory}:/out`, 'postgres:17-alpine', 'tar', '-C', '/data', '-cf', '/out/graphyard-data.tar', '.']);
  for (const path of files) await (path === root ? copy(`${path}/`, ['--exclude', '/.graphyard/worktrees/']) : path === directory ? copy(`${path}/`) : copy(path));
  for (const file of credentials) await copy(file, ['--chmod=F600']);
  // hostId names the target in both files the target's CLI and loop read.
  const scratch = await mkdtemp(join(tmpdir(), 'graphyard-move-'));
  try {
    for (const file of [masterFile, connectionFile].filter(existsSync)) {
      const rewritten = join(scratch, file === masterFile ? 'master.json' : 'connection.json');
      await atomicPrivateWrite(rewritten, { ...JSON.parse(await readFile(file, 'utf8')), hostId: to });
      await exec('rsync', ['-a', '--mkpath', '--chmod=F600', rewritten, destination(file)]);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
  return { ...plan, applied: true, next: `On ${to}, run: ${start.join(' && ')}` };
}
