// Concern: GY-3438 — each agent session's fair share of the host. Every worker, reviewer and producer
// session already starts in its own systemd scope; the scope now carries an equal CPUWeight and
// IOWeight and a MemoryHigh at its share — the host's memory in proportion to its cores divided by
// the live sessions, never under two cores. No hard cap: a lone session may use the whole machine,
// and under contention the kernel gives each session about the same CPU however many processes it
// starts, so one session that starts 16 browsers no longer starves the others. The loop, its master,
// the server and the database carry a higher CPUWeight (src/install). The loop reads each session's
// scope back from its cgroup (cpu.stat, memory.current, memory.high) every cycle.
import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import { overloadFactor, saturatedPressure, type SessionUsage } from './model/session-usage.js';
export * from './model/session-usage.js';

/** A session's share is never under this many cores. */
export const minimumShareCores = 2;
/** Every session's CPUWeight and IOWeight: equal, systemd's default. */
export const sessionWeight = 100;
/** The loop, its master, the server and the database: ten sessions' weight, so they answer under full load. */
export const controlPlaneWeight = 1000;

/** The user manager's app.slice, where `systemd-run --user --scope` places every session scope. */
export const sessionSlice = (uid = process.getuid?.() ?? 0) => `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`;

export interface SessionScope { unit: string; usec: number; memory: number; memoryShare: number }

const read = (path: string) => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };

/** Every Graphyard scope under `slice` that carries a MemoryHigh: the live agent sessions (trials carry none). */
export function sessionScopes(slice = sessionSlice()): SessionScope[] {
  let names: string[];
  try { names = readdirSync(slice).filter(name => name.startsWith('graphyard-') && name.endsWith('.scope')); } catch { return []; }
  return names.flatMap(unit => {
    const high = read(join(slice, unit, 'memory.high'));
    if (!high || high === 'max') return [];
    const usec = Number(/^usage_usec (\d+)/m.exec(read(join(slice, unit, 'cpu.stat')) ?? '')?.[1] ?? 0);
    return [{ unit, usec, memory: Number(read(join(slice, unit, 'memory.current')) ?? 0), memoryShare: Number(high) }];
  });
}

/** A session's share: the host's cores divided by the live sessions, never under two cores, and memory in proportion. */
export function sessionShare(live: number, cores = availableParallelism(), memory = totalmem()) {
  const share = Math.min(cores, Math.max(minimumShareCores, cores / Math.max(1, live)));
  return { cores: share, memoryBytes: Math.floor(memory * share / cores) };
}

/** The `systemd-run` properties of a session launched now: equal weights, and MemoryHigh at a share that counts itself among the live sessions. */
export function sessionScopeProperties(live = sessionScopes().length + 1, cores?: number, memory?: number): string[] {
  return ['-p', `CPUWeight=${sessionWeight}`, '-p', `IOWeight=${sessionWeight}`, '-p', `MemoryHigh=${sessionShare(live, cores, memory).memoryBytes}`];
}

/**
 * One cycle's reading of every session: CPU in cores since the previous reading, memory now, its
 * share, and since when it has used far more than its share of a saturated machine. `pressure` is
 * the host's 'some avg60' (daemon/cpu-pressure.ts); `names` maps a scope to the session it holds.
 */
export function readSessionUsage(previous: readonly SessionUsage[], at: number, scopes: SessionScope[], pressure: number | null,
  names: (unit: string) => string | undefined = () => undefined, cores = availableParallelism()): SessionUsage[] {
  const cpuShare = sessionShare(scopes.length, cores).cores, saturated = (pressure ?? 0) >= saturatedPressure;
  return scopes.map(scope => {
    const before = previous.find(entry => entry.unit === scope.unit), elapsed = before ? (at - Date.parse(before.at)) * 1000 : 0;
    const cpu = before && elapsed > 0 && scope.usec >= before.usec ? (scope.usec - before.usec) / elapsed : null;
    const over = saturated && cpu !== null && cpu >= cpuShare * overloadFactor;
    const name = names(scope.unit) ?? before?.name;
    return { unit: scope.unit, ...(name ? { name } : {}), at: new Date(at).toISOString(), usec: scope.usec, cpu, cpuShare, memory: scope.memory, memoryShare: scope.memoryShare,
      overSince: over ? before?.overSince ?? new Date(at).toISOString() : null };
  });
}
