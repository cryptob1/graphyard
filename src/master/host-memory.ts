import { readFile } from 'node:fs/promises';

/**
 * The host's memory (GY-612, GY-1832): what a merge trial's shards and the suite's runner may
 * allocate is what is available above the floor — 10% of total or 4 GB, whichever is larger — and a
 * recovery margin.
 */
export interface HostMemoryReading { totalBytes: number; availableBytes: number }
export const memoryFloorShare = 0.1, memoryFloorMinimumBytes = 4 * 2 ** 30, memoryRecoveryMarginBytes = 2 ** 30;
export const hostMemoryFloor = (totalBytes: number) => Math.max(totalBytes * memoryFloorShare, memoryFloorMinimumBytes);

/** The variable the suite's runner sets on the runs it starts (tests/helpers/run-tests.ts, value `unreadable`): a run so marked reads nothing. Production never sets it. */
export const hostMemoryVariable = 'GRAPHYARD_HOST_MEMORY';

/** This host's memory from /proc/meminfo; null where it cannot be read. */
export async function readHostMemory(): Promise<HostMemoryReading | null> {
  if (process.env[hostMemoryVariable] === 'unreadable') return null;
  let meminfo: string;
  try { meminfo = await readFile('/proc/meminfo', 'utf8'); } catch { return null; }
  const field = (name: string) => { const match = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(meminfo); return match ? Number(match[1]) * 1024 : null; };
  const totalBytes = field('MemTotal'), availableBytes = field('MemAvailable');
  if (totalBytes === null || availableBytes === null) return null;
  return { totalBytes, availableBytes };
}
