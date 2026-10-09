// Concern: restarting the master loop — through its supervising unit when one runs it (GY-1603), detached otherwise — and the loop's own exit once stopped.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { localDirectory } from '../onboarding.js';
import { loopStopTimeoutSeconds, loopUnitDirectory, loopUnitOf, type LoopSupervisorHost } from '../supervisor.js';
import type { MasterConfig } from './profiles.js';
import { agentOwner } from './attention.js';
import { atomicPrivateText } from './config.js';
import { defaultChildRun } from '../child-runner.js';

/** `systemctl --user ARGS`, returning stdout and throwing on a failed command; through the bounded asynchronous runner, since the loop reaches this module (GY-125). */
export type UserSystemctl = (args: string[], timeoutMs?: number) => Promise<string> | string;
const userSystemctl: UserSystemctl = (args, timeoutMs = 30_000) => defaultChildRun('systemctl', ['--user', ...args], { timeoutMs });

type LoopLock = { pid: number; host: string; heartbeatAt: string; startedAt?: string };
/** This install's loop unit, as systemd reports it: its name, whether it is up (a restart wait counts) and its main process (0 between restarts). */
export interface SupervisingUnit { unit: string; mainPid: number }
export interface RestartOptions { timeoutMs?: number; systemctl?: UserSystemctl; host?: LoopSupervisorHost; platform?: NodeJS.Platform }

const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; } };

async function unitProperties(systemctl: UserSystemctl, unit: string) {
  const text = await systemctl(['show', '--property=LoadState', '--property=ActiveState', '--property=MainPID', '--property=WorkingDirectory', '--property=ExecStart', unit]);
  return Object.fromEntries(text.split(/\r?\n/).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]));
}
/** systemd states in which the unit is up, starting, waiting out RestartSec, or stopping on its way to a queued restart. */
const supervisedStates = ['active', 'activating', 'reloading', 'refreshing', 'deactivating'];
/** Whether systemd holds a start or restart job for UNIT: `list-jobs` rows are `ID UNIT TYPE STATE`. */
async function startQueued(systemctl: UserSystemctl, unit: string) {
  return (await systemctl(['list-jobs', '--no-legend', '--plain', unit])).split(/\r?\n/).some(line => {
    const [, name, type] = line.trim().split(/\s+/);
    return name === unit && /^(start|restart|try-restart|reload-or-start)$/.test(type ?? '');
  });
}
/**
 * The unit supervising this install's loop: this install's recorded unit (or the legacy alias),
 * loaded, up, waiting to restart, stopping or with a start queued, and running `master run` (its effective ExecStart) from exactly ROOT. A unit of the same
 * name rooted in another checkout is another install's loop and never this one's. Null when there is
 * none; throws when systemd cannot be asked but this checkout's unit file is installed, since spawning a second,
 * unsupervised loop beside a unit that may be running is what this module exists to prevent.
 */
export async function supervisingUnit(root: string, options: Pick<RestartOptions, 'systemctl' | 'host' | 'platform'> = {}): Promise<SupervisingUnit | null> {
  if ((options.platform ?? process.platform) !== 'linux') return null;
  const systemctl = options.systemctl ?? userSystemctl, host = options.host ?? {};
  const unit = loopUnitOf(root, loopUnitDirectory(host), host.home);
  let properties: Record<string, string>;
  try { await systemctl(['show-environment']); properties = await unitProperties(systemctl, unit); }
  catch (error) {
    // Only a unit file rooted in this checkout is this install's loop; any other leaves the detached restart.
    const file = join(loopUnitDirectory(host), unit), home = host.home ?? homedir();
    const rooted = existsSync(file) && readFileSync(file, 'utf8').split(/\r?\n/).find(line => line.startsWith('WorkingDirectory='))?.slice('WorkingDirectory='.length).replace(/^[-!+]+/, '').replace(/%h/g, home).trim();
    if (!rooted || canonical(rooted) !== canonical(root)) return null;
    throw new Error(`The systemd user manager could not be asked about ${unit}, which is installed for this loop, so it was not restarted (a second, unsupervised loop is never started beside it): ${error instanceof Error ? error.message.split('\n')[0] : String(error)}. From a host shell: systemctl --user restart ${unit}`);
  }
  if (properties.LoadState !== 'loaded') return null;
  const directory = (properties.WorkingDirectory ?? '').replace(/^[-!+]+/, '');
  if (!directory || canonical(directory) !== canonical(root)) return null;
  // The effective command, drop-ins applied: `ExecStart={ path=… ; argv[]=NODE CLI master run ; … }`. A unit
  // whose command was overridden to anything but `master run` is not this loop's supervisor, and
  // restarting it would report a restart while no loop runs.
  if (!/argv\[\]=[^;]*\smaster run(\s|;|$)/.test(properties.ExecStart ?? '')) return null;
  // A unit stopping (deactivating) or down with a start or restart queued is still this loop's
  // supervisor: a detached `master run` now would contend for the lock with the loop systemd is
  // about to start.
  if (!supervisedStates.includes(properties.ActiveState ?? '') && !await startQueued(systemctl, unit)) return null;
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
  const supervisor = await supervisingUnit(root, options);
  if (supervisor) {
    const unsupervised = holder !== null && holder !== supervisor.mainPid ? { pid: holder, result: await stopProcess(holder, timeoutMs) } : null;
    // Blocking: systemd stops the loop (SIGTERM, SIGKILL past TimeoutStopSec) and starts the next before it returns.
    await systemctl(['restart', supervisor.unit], (loopStopTimeoutSeconds + 60) * 1000);
    const started = Number((await unitProperties(systemctl, supervisor.unit)).MainPID) || null;
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
/**
 * A `master run` (RUN), with its refusal on another live loop's lock recorded for `master status`
 * when HELD is that lock as the run read it. The refusal is rethrown: the run still fails, and its
 * supervisor restarts it into the same refusal, each one counted.
 */
export async function recordingLockRefusal<T>(root: string, held: LoopLock | null, run: Promise<T>): Promise<T> {
  try { return await run; }
  catch (error) {
    if (held && String((error as Error)?.message).startsWith('Another Graphyard master loop holds')) await recordLockRefusal(root, held).catch(() => {});
    throw error;
  }
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
