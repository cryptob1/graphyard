// Concern: the daily leftovers report (GY-3190) — what the close step's sweeps stopped or removed across
// one UTC day, with the disk Graphyard's own directories and Docker images hold, reported once a day.
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildRun } from '../child-runner.js';
import type { DaemonState, LeftoverCounts, LeftoverDisk } from './state.js';

export const emptyLeftoverCounts = (): LeftoverCounts => ({ processes: 0, trialContainers: 0, reclaimed: 0, panes: 0, worktrees: 0 });

/** Adds what one sweep stopped or removed to the day's counts. */
export function tallyLeftovers(state: DaemonState, kind: keyof LeftoverCounts, count = 1) {
  if (count > 0) state.leftovers.counts[kind] += count;
}

/**
 * Persist-step rollover: on the first persist of a new UTC day, the previous day's counts and the disk
 * readings taken now become the report, logged as one journal line, and the counts restart. The cycle
 * that crosses midnight closes the day its tallies began in. A fresh cursor only marks its day. Removes nothing.
 */
export async function leftoversStep(state: DaemonState, clock: number, disk: (() => Promise<LeftoverDisk>) | undefined, log: (line: string) => void) {
  const day = new Date(clock).toISOString().slice(0, 10), leftovers = state.leftovers;
  if (leftovers.day === day) return;
  const ended = leftovers.day, counts = leftovers.counts;
  // The day turns before the readings are awaited: a walk that outlasts the step's timeout still lands its one report, never a second.
  leftovers.day = day;
  if (!ended) return;
  leftovers.counts = emptyLeftoverCounts();
  const readings = disk ? await disk() : { trialRuns: null, worktrees: null, trialCheckouts: null, trialImages: null, buildCache: null };
  leftovers.report = { day: ended, counts, disk: readings, at: new Date(clock).toISOString() };
  log(`[graphyard-master] leftovers report ${JSON.stringify(leftovers.report)}`);
}

/** The recursive size of a directory in bytes (symlinks not followed), or null when it cannot be read. */
export async function directoryBytes(path: string): Promise<number | null> {
  const root = await lstat(path).catch(() => null);
  if (!root) return null;
  let total = root.size;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const child = join(directory, entry.name), info = await lstat(child).catch(() => null);
      if (!info) continue;
      total += info.size;
      if (info.isDirectory()) await walk(child);
    }
  };
  if (root.isDirectory()) await walk(path);
  return total;
}

const units: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
/** Docker's human size ("1.2GB", "512kB") in bytes. */
export const dockerBytes = (size: unknown) => {
  const match = /^([\d.]+)\s*([a-z]+)$/i.exec(String(size ?? '').trim());
  return match && units[match[2]!.toLowerCase()] ? Math.round(Number(match[1]) * units[match[2]!.toLowerCase()]!) : 0;
};

/** `docker system df -v`: the bytes of images named graphyard-trial* and the build cache total, each null without Docker. */
export async function dockerLeftoverBytes(run: ChildRun): Promise<{ trialImages: number | null; buildCache: number | null }> {
  try {
    const df = JSON.parse(String(await run('docker', ['system', 'df', '-v', '--format', 'json'], { timeoutMs: 60_000 })));
    const sum = (rows: { Size?: string }[] = []) => rows.reduce((total, row) => total + dockerBytes(row.Size), 0);
    return { trialImages: sum((df.Images ?? []).filter((image: { Repository?: string }) => image.Repository?.startsWith('graphyard-trial'))), buildCache: sum(df.BuildCache) };
  } catch { return { trialImages: null, buildCache: null }; }
}

/** The disk readings the report carries. Core dumps are left out: they are root-owned. */
export async function leftoverDisk(paths: { trialRuns: string; worktrees: string; trialCheckouts: string }, run: ChildRun): Promise<LeftoverDisk> {
  const [trialRuns, worktrees, trialCheckouts, docker] = await Promise.all([directoryBytes(paths.trialRuns), directoryBytes(paths.worktrees), directoryBytes(paths.trialCheckouts), dockerLeftoverBytes(run)]);
  return { trialRuns, worktrees, trialCheckouts, ...docker };
}
