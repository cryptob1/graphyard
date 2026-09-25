// Concern: server reports too slow to read on every cycle or every status build (GY-377), kept
// beside the daemon cursor and refreshed by the loop in the background.
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { MasterConfig } from './profiles.js';
import { atomicPrivateWrite } from './config.js';
import { withoutTimings } from './timings.js';

/**
 * The seven-day intervention report `master status` summarises. On 2026-09-25 the server took 59 s
 * to answer it with 929 KB, and both the loop's fault step and every `master status` asked for it;
 * with a 30 s read timeout the loop's read failed every cycle after holding it for those 30 s.
 */
export const interventionReportPath = 'interventions?window=7';
/** A cached report younger than this is used as it stands; an older one is refreshed. */
export const reportCacheMaxAgeMs = 10 * 60_000;
/** How long `master status` waits on a live read of a report whose cached copy is missing or old. */
export const reportReadBoundMs = 5_000;
/** How long the loop's background refresh may take: the report is slow, and nothing waits on it. */
export const reportRefreshTimeoutMs = 180_000;

interface CachedReport { readAt: string; value: unknown }
export interface ReportRead<T> { value: T; readAt: string; ageMs: number; stale: boolean }

export function reportCachePath(config: Pick<MasterConfig, 'credentialFile'>) {
  const file = config.credentialFile;
  return resolve(dirname(file), `${basename(file).replace(/\.token$/, '')}.reports.json`);
}
async function readCache(config: Pick<MasterConfig, 'credentialFile'>): Promise<Record<string, CachedReport>> {
  try { const parsed = JSON.parse(await readFile(reportCachePath(config), 'utf8')); return parsed && typeof parsed === 'object' && parsed.version === 1 && parsed.reports && typeof parsed.reports === 'object' ? parsed.reports : {}; }
  catch { return {}; }
}
async function writeCache(config: Pick<MasterConfig, 'credentialFile'>, path: string, entry: CachedReport) {
  const reports = await readCache(config);
  reports[path] = entry;
  await atomicPrivateWrite(reportCachePath(config), { version: 1, reports });
}

/** One refresh per report in flight in this process, however many cycles or builds ask. */
const refreshing = new Map<string, Promise<CachedReport>>();
function refresh(config: Pick<MasterConfig, 'credentialFile'>, path: string, read: (path: string) => Promise<unknown>, now: () => number) {
  const key = `${reportCachePath(config)}\0${path}`;
  const running = refreshing.get(key);
  if (running) return running;
  const started = (async () => {
    const value = await read(path);
    const entry = { readAt: new Date(now()).toISOString(), value };
    await writeCache(config, path, entry).catch(() => { /* an unwritable cache is read live next time */ });
    return entry;
  })().finally(() => refreshing.delete(key));
  refreshing.set(key, started);
  return started;
}

/** `pending`, waited on for at most `ms`; past that the read is refused, and `pending` carries on. */
async function within<T>(pending: Promise<T>, ms: number, path: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${path} did not answer within ${Math.round(ms / 100) / 10}s; the master loop refreshes it in the background`)), ms); timer.unref?.(); });
  try { return await Promise.race([pending, bound]); } finally { clearTimeout(timer); }
}

/**
 * A slow server report, read through its cache. A copy younger than `maxAgeMs` is returned as it
 * stands. Otherwise:
 *
 * - `background` (the loop): the report is refreshed detached from the cycle, so no cycle waits on
 *   it, and the older copy is returned at once. With no copy yet, the refresh is waited on for at
 *   most `boundMs` — a report that answers promptly is used this cycle — and carries on past it.
 * - `bounded` (`master status`): the report is read live for at most `boundMs`, sharing a refresh
 *   already in flight in this process; one that fails or runs past it falls back to the older copy,
 *   or is refused when there is none.
 *
 * `boundMs` defaults to `reportReadBoundMs`.
 */
export async function cachedReport<T>(config: Pick<MasterConfig, 'credentialFile'>, path: string, read: (path: string) => Promise<T>, options: { mode: 'background' | 'bounded'; now?: () => number; maxAgeMs?: number; boundMs?: number }): Promise<ReportRead<T>> {
  const now = options.now ?? Date.now, maxAgeMs = options.maxAgeMs ?? reportCacheMaxAgeMs;
  const cached = (await readCache(config))[path];
  const age = (entry: CachedReport) => Math.max(0, now() - Date.parse(entry.readAt));
  const answer = (entry: CachedReport, stale: boolean): ReportRead<T> => ({ value: entry.value as T, readAt: entry.readAt, ageMs: age(entry), stale });
  if (cached && age(cached) < maxAgeMs) return answer(cached, false);
  const boundMs = options.boundMs ?? reportReadBoundMs;
  if (options.mode === 'background') {
    // Outside the cycle's recorder: the refresh may finish long after the cycle that started it.
    const refreshed = withoutTimings(() => refresh(config, path, read, now));
    refreshed.catch(() => { /* the next cycle tries again */ });
    if (cached) return answer(cached, true);
    return answer(await within(refreshed, boundMs, path), false);
  }
  try { return answer(await within(refresh(config, path, read, now), boundMs, path), false); }
  catch (error) {
    if (cached) return answer(cached, true);
    throw error;
  }
}

/**
 * A server reader that reads the slow reports through the cache in `mode`, waiting at most
 * `boundMs` on one, and every other path as it did; `freshness` says how old the last cached
 * report it returned was. Without a mode it is the reader it was given.
 */
export function slowReportReader(config: Pick<MasterConfig, 'credentialFile'>, read: (path: string, credential?: string, timeoutMs?: number) => Promise<any>, mode?: 'background' | 'bounded', boundMs: number = reportReadBoundMs) {
  let last: ReportRead<unknown> | null = null;
  // The loop's refresh may take as long as the report does; status's read is bounded like its wait.
  const timeout = mode === 'background' ? reportRefreshTimeoutMs : boundMs;
  return {
    read: (path: string) => !mode || path !== interventionReportPath ? read(path)
      : cachedReport(config, path, target => read(target, undefined, timeout), { mode, boundMs }).then(result => { last = result; return result.value; }),
    freshness: () => last ? { readAt: last.readAt, ageMs: last.ageMs, stale: last.stale } : {},
  };
}
