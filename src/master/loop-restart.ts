// Concern: restarting the master loop — through its supervising unit when one runs it (GY-1603), detached otherwise — and the loop's own exit once stopped.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { localDirectory } from '../onboarding.js';
import { loopStopTimeoutSeconds, loopUnitDirectory, loopUnitOf, type LoopSupervisorHost } from '../supervisor.js';
import type { MasterConfig } from './profiles.js';
import { agentOwner } from './attention.js';
import { atomicPrivateText } from './config.js';

/** `systemctl --user ARGS`, returning stdout and throwing on a failed command. */
export type UserSystemctl = (args: string[], timeoutMs?: number) => string;
const userSystemctl: UserSystemctl = (args, timeoutMs = 30_000) => execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });

type LoopLock = { pid: number; host: string; heartbeatAt: string; startedAt?: string };
/** This install's loop unit, as systemd reports it: its name, whether it is up (a restart wait counts) and its main process (0 between restarts). */
export interface SupervisingUnit { unit: string; mainPid: number }
export interface RestartOptions { timeoutMs?: number; systemctl?: UserSystemctl; host?: LoopSupervisorHost; platform?: NodeJS.Platform }

const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; } };

function unitProperties(systemctl: UserSystemctl, unit: string) {
  const text = systemctl(['show', '--property=LoadState', '--property=ActiveState', '--property=MainPID', '--property=WorkingDirectory', unit]);
  return Object.fromEntries(text.split(/\r?\n/).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]));
}
/**
 * The unit supervising this install's loop: this install's recorded unit (or the legacy alias),
 * loaded, up or waiting to restart, and running `master run` from exactly ROOT. A unit of the same
 * name rooted in another checkout is another install's loop and never this one's. Null when there is
 * none; throws when systemd cannot be asked but this checkout's unit file is installed, since spawning a second,
 * unsupervised loop beside a unit that may be running is what this module exists to prevent.
 */
export function supervisingUnit(root: string, options: Pick<RestartOptions, 'systemctl' | 'host' | 'platform'> = {}): SupervisingUnit | null {
  if ((options.platform ?? process.platform) !== 'linux') return null;
  const systemctl = options.systemctl ?? userSystemctl, host = options.host ?? {};
  const unit = loopUnitOf(root, loopUnitDirectory(host), host.home);
  let properties: Record<string, string>;
  try { systemctl(['show-environment']); properties = unitProperties(systemctl, unit); }
  catch (error) {
    // Only a unit file rooted in this checkout is this install's loop; any other leaves the detached restart.
    const file = join(loopUnitDirectory(host), unit), home = host.home ?? homedir();
    const rooted = existsSync(file) && readFileSync(file, 'utf8').split(/\r?\n/).find(line => line.startsWith('WorkingDirectory='))?.slice('WorkingDirectory='.length).replace(/^[-!+]+/, '').replace(/%h/g, home).trim();
    if (!rooted || canonical(rooted) !== canonical(root)) return null;
    throw new Error(`The systemd user manager could not be asked about ${unit}, which is installed for this loop, so it was not restarted (a second, unsupervised loop is never started beside it): ${error instanceof Error ? error.message.split('\n')[0] : String(error)}. From a host shell: systemctl --user restart ${unit}`);
  }
  if (properties.LoadState !== 'loaded' || !['active', 'activating', 'reloading'].includes(properties.ActiveState ?? '')) return null;
  const directory = (properties.WorkingDirectory ?? '').replace(/^[-!+]+/, '');
  if (!directory || canonical(directory) !== canonical(root)) return null;
  return { unit, mainPid: Number(properties.MainPID) || 0 };
}

/** SIGTERM PID and wait for it to exit; past the bound it is killed, as the unit's own stop would (TimeoutStopSec, then SIGKILL). */
async function stopProcess(pid: number, timeoutMs: number) {
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > deadline) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } return 'killed' as const; }
    await new Promise(done => setTimeout(done, 200));
  }
  return 'stopped' as const;
}

/**
 * Restart this host's master loop. Under an active unit for this install (GY-1603) the restart goes
 * through systemd — `systemctl --user restart UNIT` — and reports the unit's new MainPID; a loop
 * holding the lock outside the unit is stopped first, or the unit's new loop would be refused on the
 * lock and crash-loop. Without one, the running loop is stopped and a fresh one started detached,
 * logging beside the config.
 */
export async function restartMasterLoop(root: string, config: MasterConfig, lock: LoopLock | null, options: RestartOptions = {}) {
  if (lock && lock.host !== config.hostId && Date.now() - Date.parse(lock.heartbeatAt) < 3 * config.run.intervalSeconds * 1000) throw new Error(`The master loop runs on ${lock.host} (pid ${lock.pid}); restart it on that host`);
  const timeoutMs = options.timeoutMs ?? 30_000, systemctl = options.systemctl ?? userSystemctl;
  const holder = lock && lock.host === config.hostId && alive(lock.pid) ? lock.pid : null;
  const supervisor = supervisingUnit(root, options);
  if (supervisor) {
    const unsupervised = holder !== null && holder !== supervisor.mainPid ? { pid: holder, result: await stopProcess(holder, timeoutMs) } : null;
    // Blocking: systemd stops the loop (SIGTERM, SIGKILL past TimeoutStopSec) and starts the next before it returns.
    systemctl(['restart', supervisor.unit], (loopStopTimeoutSeconds + 60) * 1000);
    const started = Number(unitProperties(systemctl, supervisor.unit).MainPID) || null;
    return { supervisor: supervisor.unit, stopped: supervisor.mainPid || null, unsupervised, started, log: null };
  }
  let stopped: number | null = null;
  if (holder !== null) {
    process.kill(holder, 'SIGTERM'); stopped = holder;
    const deadline = Date.now() + timeoutMs;
    while (alive(holder)) {
      if (Date.now() > deadline) throw new Error(`Master loop pid ${holder} did not stop within ${Math.round(timeoutMs / 1000)} seconds; it was not restarted`);
      await new Promise(done => setTimeout(done, 200));
    }
  }
  const log = resolve(await localDirectory(root), 'master-run.log');
  const { openSync } = await import('node:fs'); const { spawn } = await import('node:child_process');
  const output = openSync(log, 'a', 0o600);
  const child = spawn(process.execPath, [config.cliPath, 'master', 'run'], { cwd: root, detached: true, stdio: ['ignore', output, output] });
  child.unref();
  return { supervisor: null, stopped, unsupervised: null, started: child.pid ?? null, log };
}

/**
 * A stopped loop's process exits (GY-1603). The loop logs its stop and prints its summary, but a
 * handle nobody closed — a keep-alive socket, a timer, a child's pipe — kept the process alive, so
 * the unit stayed active with no cycle running and no restart coming. Once stopped the process exits
 * after `graceMs` (stdout flushes first); from the signal on it exits within the unit's stop bound
 * whatever the shutdown is still waiting on. Both timers are unreferenced, so a process that would
 * exit anyway is never held for them.
 */
export function exitWhenStopped(proc: Pick<NodeJS.Process, 'once' | 'exit'> & { exitCode?: number | string | null | undefined } = process, options: { graceMs?: number; boundMs?: number; signals?: NodeJS.Signals[] } = {}) {
  const exit = () => proc.exit(Number(proc.exitCode ?? 0) || 0);
  const arm = (ms: number) => setTimeout(exit, ms).unref();
  for (const signal of options.signals ?? ['SIGTERM', 'SIGINT'] as NodeJS.Signals[]) proc.once(signal, () => arm(options.boundMs ?? (loopStopTimeoutSeconds - 10) * 1000));
  return { stopped: () => arm(options.graceMs ?? 2_000) };
}

/**
 * What a `master run` refused on the lock records, beside the config, for `master status` (GY-1603).
 * Published by rename, never rewritten in place: a status read during a refusal sees the previous
 * record or the new one, never an empty or partial file that would drop the holder's attention item,
 * and a refusal interrupted mid-write leaves the previous record readable.
 */
export interface LockRefusal { holder: { pid: number; host: string; startedAt: string | null }; refusedAt: string; count: number }
const refusalFile = async (root: string) => resolve(await localDirectory(root), 'master-lock-refusal.json');
export async function recordLockRefusal(root: string, holder: LoopLock, at = new Date()) {
  const previous = await readLockRefusal(root);
  const same = previous && previous.holder.pid === holder.pid && previous.holder.host === holder.host;
  const record: LockRefusal = { holder: { pid: holder.pid, host: holder.host, startedAt: holder.startedAt ?? null }, refusedAt: at.toISOString(), count: same ? previous.count + 1 : 1 };
  await atomicPrivateText(await refusalFile(root), `${JSON.stringify(record)}\n`);
  return record;
}
export async function readLockRefusal(root: string): Promise<LockRefusal | null> {
  try { return JSON.parse(await readFile(await refusalFile(root), 'utf8')) as LockRefusal; } catch { return null; }
}

/**
 * The attention item for a loop holding the lock outside this install's unit while the unit's own
 * `master run` is refused on it: the unit restarts into the same refusal every RestartSec and the
 * holder runs with no watchdog, which is silent unless named here. Judged on the live lock and unit,
 * so a holder that is gone, or that is the unit's own MainPID, raises nothing.
 */
export function unsupervisedHolderAttention(input: { refusal: LockRefusal | null; lock: LoopLock | null; hostId: string; unit: SupervisingUnit | null; alive?: (pid: number) => boolean }) {
  const { refusal, lock, unit } = input;
  if (!refusal || !lock || !unit || lock.host !== input.hostId || lock.pid !== refusal.holder.pid || lock.pid === unit.mainPid) return null;
  if (!(input.alive ?? alive)(lock.pid)) return null;
  const started = lock.startedAt ?? refusal.holder.startedAt ?? 'an unknown time';
  return { subject: 'loop',
    text: `An unsupervised master loop (pid ${lock.pid} on ${lock.host}, started ${started}) holds this repository's lock outside ${unit.unit}, whose own master run has been refused on it ${refusal.count} time(s), last at ${refusal.refusedAt}: the unit crash-loops while the holder runs with no watchdog`,
    ...agentOwner('master', `graphyard master restart (stops pid ${lock.pid}, then restarts ${unit.unit}); by hand: kill -TERM ${lock.pid} && systemctl --user restart ${unit.unit}`) };
}
