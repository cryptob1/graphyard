// Concern: the recurring-intervention scan — when it runs and the policy window it reads; patterns are reported in master status, never filed as work items.
import type { Principal } from '../model.js';
import type { InterventionPolicy } from '../model/interventions.js';
import { boundedSnapshot } from '../store/bounded-snapshot.js';
import { LedgerRowCache, readInterventionLedger } from './ledger.js';
import type { Store } from '../store.js';
import { windowStart } from './report.js';

/**
 * Whether the server runs the pattern scan (GY-1372). On by default (GY-1381): the scan reads the
 * policy window through the (kind, created_at) index on the report pool and runs beside the
 * reconciliation tick, never in it (`startPatternScan`), so it no longer holds the tick as it did
 * on 2026-09-23. `GRAPHYARD_INTERVENTION_PATTERNS=0` turns it off. The interventions report
 * carries this state, so master status reads it rather than assuming.
 */
export const interventionScanVariable = 'GRAPHYARD_INTERVENTION_PATTERNS';
export const interventionScan = (env: NodeJS.ProcessEnv = process.env) => ({ enabled: env[interventionScanVariable]?.trim() !== '0', variable: interventionScanVariable });

/** How often the server runs the pattern scan: once a minute, as it did inside the tick. */
export const patternScanIntervalMs = 60_000;

/**
 * Run the pattern scan on its own timer beside the reconciliation tick (GY-1381), as the
 * production watch runs: the tick never awaits it, so a slow scan delays only the next scan and
 * never a claim, a heartbeat or an observation. One scan runs at a time; a scan still running when
 * the next is due is not doubled. The setting is read each time, so `=0` takes effect at once.
 */
export function startPatternScan(scan: () => Promise<void>, options: { intervalMs?: number; env?: NodeJS.ProcessEnv; failed?: (error: unknown) => void } = {}) {
  let running: Promise<void> | null = null, stopped = false;
  const run = () => {
    if (running || stopped || !interventionScan(options.env).enabled) return running;
    running = scan().catch(error => options.failed?.(error)).finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(run, options.intervalMs ?? patternScanIntervalMs);
  timer.unref?.();
  return { stop: async () => { stopped = true; clearInterval(timer); await running; }, run, get running() { return running !== null; } };
}

/**
 * The policy window of the ledger and the board it folds against, read once for a scan (GY-1749). The
 * pattern scan and the retro synthesis beside it fold the same window; each read it for itself, twice a
 * minute, and every read decompressed the stored document of each of its rows. A scan reads it once,
 * hands it to both, and keeps the rows it projected (`cache`) for the next scan: what it reads again is
 * the rows written since.
 */
export async function readScanWindow(store: Store, policy: InterventionPolicy, options: { now?: string; limit?: number; cache?: LedgerRowCache } = {}) {
  const snapshot = await boundedSnapshot(store.reportPool);
  const now = options.now ?? snapshot.now;
  const { rows, truncated } = await readInterventionLedger(store.reportPool, { limit: options.limit, since: windowStart(now, policy.windowDays), cache: options.cache });
  return { snapshot, now, rows, truncated };
}
export type ScanWindow = Awaited<ReturnType<typeof readScanWindow>>;

/** The control plane acting as itself when it opens work from feedback; the ledger names it as every other control-plane write is named. */
export const controlPlaneActor: Principal = { id: 'graphyard', role: 'admin', sessionKind: 'ai' };
