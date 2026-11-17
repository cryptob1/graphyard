// Concern: GY-3438 — each agent session's CPU and memory share. Every worker, reviewer and producer
// session already starts in its own systemd scope; the scope now carries CPUQuota and MemoryMax set
// to the session's share — the host's cores divided by the live sessions, never under two cores,
// with memory in the same proportion — so one session that starts 16 browsers slows only itself.
// The loop reads each capped scope back from its cgroup (cpu.stat, memory.current) every cycle.
import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import { atCapFraction, type SessionUsage } from './model/session-usage.js';
export * from './model/session-usage.js';

/** A session never gets less than this many cores. */
export const minimumShareCores = 2;

/** The user manager's app.slice, where `systemd-run --user --scope` places every session scope. */
export const sessionSlice = (uid = process.getuid?.() ?? 0) => `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`;

export interface SessionScope { unit: string; usec: number; memory: number; cpuCap: number; memoryCap: number | null }

const read = (path: string) => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };

/** Every Graphyard scope under `slice` that carries a CPU quota: the live agent sessions (trials carry none). */
export function sessionScopes(slice = sessionSlice()): SessionScope[] {
  let names: string[];
  try { names = readdirSync(slice).filter(name => name.startsWith('graphyard-') && name.endsWith('.scope')); } catch { return []; }
  return names.flatMap(unit => {
    const [quota, period] = (read(join(slice, unit, 'cpu.max')) ?? 'max').split(/\s+/);
    if (quota === 'max' || !Number(period)) return [];
    const usec = Number(/^usage_usec (\d+)/m.exec(read(join(slice, unit, 'cpu.stat')) ?? '')?.[1] ?? 0);
    const memoryMax = read(join(slice, unit, 'memory.max'));
    return [{ unit, usec, memory: Number(read(join(slice, unit, 'memory.current')) ?? 0), cpuCap: Number(quota) / Number(period), memoryCap: memoryMax && memoryMax !== 'max' ? Number(memoryMax) : null }];
  });
}

/** A session's share: the host's cores divided by the live sessions, never under two cores, and memory in proportion. */
export function sessionShare(live: number, cores = availableParallelism(), memory = totalmem()) {
  const share = Math.max(minimumShareCores, cores / Math.max(1, live));
  return { cores: share, memoryBytes: Math.floor(memory * Math.min(1, share / cores)) };
}

/** The `systemd-run` properties of a session launched now: its share counts itself among the live sessions. */
export function sessionScopeProperties(live = sessionScopes().length + 1, cores?: number, memory?: number): string[] {
  const share = sessionShare(live, cores, memory);
  return ['-p', `CPUQuota=${Math.round(share.cores * 100)}%`, '-p', `MemoryMax=${share.memoryBytes}`];
}

/**
 * One cycle's reading of every session: CPU in cores since the previous reading, memory now and the
 * caps, and since when the session has sat at its cap. `names` maps a scope to the session it holds.
 */
export function readSessionUsage(previous: readonly SessionUsage[], at: number, scopes = sessionScopes(), names: (unit: string) => string | undefined = () => undefined): SessionUsage[] {
  return scopes.map(scope => {
    const before = previous.find(entry => entry.unit === scope.unit), elapsed = before ? (at - Date.parse(before.at)) * 1000 : 0;
    const cpu = before && elapsed > 0 && scope.usec >= before.usec ? (scope.usec - before.usec) / elapsed : null;
    const atCap = (cpu !== null && cpu >= scope.cpuCap * atCapFraction) || (scope.memoryCap !== null && scope.memory >= scope.memoryCap * atCapFraction);
    const name = names(scope.unit) ?? before?.name;
    return { unit: scope.unit, ...(name ? { name } : {}), at: new Date(at).toISOString(), usec: scope.usec, cpu, cpuCap: scope.cpuCap, memory: scope.memory, memoryCap: scope.memoryCap,
      atCapSince: atCap ? before?.atCapSince ?? new Date(at).toISOString() : null };
  });
}

