// Concern: the continuous deploy graphyard-deploy.service runs (`graphyard upgrade --watch`): each new
// base tip is checked out, built, restarted, health-checked and pinned; a failing one is rolled back
// to the previous tip, unless it may have migrated the database, and the watch waits for the next tip.
// The master loop restarts itself onto the tip this records (daemon/run.ts restartCause).
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * What the deploy last served, the tip that failed and is skipped until the base moves past it, and,
 * while a rollback has not yet succeeded, the tip still to restore (tip is then null: nothing is served).
 */
export interface DeployRecord { tip: string | null; failed: string | null; reason: string | null; at: string; restore?: string | null; attempts?: number }
export const deployRecordPath = (root: string) => join(root, '.graphyard', 'deploy.json');
export function readDeployRecord(file: string): DeployRecord | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')) as DeployRecord; } catch { return null; }
}
async function writeDeployRecord(file: string, record: Omit<DeployRecord, 'at'>) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify({ ...record, reason: record.reason?.slice(0, 2000) ?? null, at: new Date().toISOString() }, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/** What one deploy runs a commit through, each throwing its failure's reason. */
export interface DeployWatchPorts {
  /** Fetches origin and answers the base branch's tip. */
  fetch(): Promise<string>;
  /** The commit the checkout holds now: the tip served before the watch recorded one. */
  head(): Promise<string>;
  checkout(commit: string): Promise<void>;
  build(commit: string): Promise<void>;
  /** Restarts the container or unit the control plane runs in. */
  restart(commit: string): Promise<void>;
  /** /healthz answers healthy at the commit. */
  health(commit: string): Promise<void>;
  /** Advances the known-good coordinator pin the loop's unit loads, so the loop's restart loads the commit. */
  pin(commit: string): Promise<void>;
  /** After a verified deploy, removes the per-commit images of every commit but these (the serving tip and the previous one). */
  prune(keep: string[]): Promise<void>;
  /** The schema generation a commit's code migrates to, read from its source; null when it names none. */
  schema(commit: string): Promise<number | null>;
  /** The database's schema generation, or null when it cannot be read. */
  database(): Promise<number | null>;
}
const steps = ['checkout', 'build', 'restart', 'health', 'pin'] as const;
/** Rollback attempts before the watch stops retrying one and waits for the base to move. */
export const rollbackAttempts = 5;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * One pass: fetch, and when the base tip is new, deploy it. A failure at any step rolls back to the
 * previous tip through the same steps and records the failed tip, which waits for the next one —
 * unless the failed deploy may have migrated the database, which the previous tip would refuse: a
 * failure from the restart on whose tip's code migrates past the previous tip's is kept and recorded
 * as served, unless the database reads at a generation the previous tip supports. A rollback that
 * fails is retried on later passes, up to rollbackAttempts, and is recorded as served only once it
 * succeeds; a new base tip is deployed in its place.
 */
export async function deployOnce(file: string, ports: DeployWatchPorts, log: (line: string) => void = line => console.error(line)): Promise<'unchanged' | 'deployed' | 'rolled-back' | 'kept' | 'restoring'> {
  const tip = await ports.fetch();
  const record = readDeployRecord(file) ?? { tip: await ports.head(), failed: null, reason: null, at: '' };
  const run = async (commit: string) => { for (const step of steps) { log(`[graphyard-deploy] ${step} ${commit.slice(0, 12)}`); try { await ports[step](commit); } catch (error) { throw Object.assign(new Error(`${step} failed: ${message(error)}`), { step }); } } };
  const restore = async (previous: string, failed: string, reason: string, attempts: number) => {
    try { await run(previous); } catch (error) {
      log(`[graphyard-deploy] the rollback to ${previous.slice(0, 12)} failed (attempt ${attempts}): ${message(error)}`);
      await writeDeployRecord(file, { tip: null, failed, restore: previous, attempts, reason: `${reason}; the rollback to ${previous.slice(0, 12)} failed (attempt ${attempts} of ${rollbackAttempts}): ${message(error)}` });
      return 'restoring' as const;
    }
    await writeDeployRecord(file, { tip: previous, failed, reason });
    return 'rolled-back' as const;
  };
  if (record.restore && tip === record.failed) {
    const attempts = (record.attempts ?? 0) + 1;
    if (attempts > rollbackAttempts) return 'unchanged';
    return restore(record.restore, tip, record.reason ?? '', attempts);
  }
  const previous = record.restore ?? record.tip;
  if (tip === previous || tip === record.failed) return 'unchanged';
  const before = await ports.database().catch(() => null);
  try {
    await run(tip);
    await writeDeployRecord(file, { tip, failed: null, reason: null });
    log(`[graphyard-deploy] serving ${tip.slice(0, 12)}`);
    await ports.prune(previous ? [tip, previous] : [tip]);
    return 'deployed';
  } catch (error) {
    const reason = message(error), step = (error as { step?: string }).step;
    if (!previous) { await writeDeployRecord(file, { tip: null, failed: tip, reason }); return 'rolled-back'; }
    if (step !== 'checkout' && step !== 'build') {
      // The server started on the tip's code, which may have migrated the database; the previous tip runs only on a generation it supports.
      const [after, supported, migrates] = await Promise.all([ports.database().catch(() => null), ports.schema(previous).catch(() => null), ports.schema(tip).catch(() => null)]);
      const ceiling = supported ?? before, reached = after ?? migrates;
      if (ceiling === null || reached === null || reached > ceiling) {
        const why = after !== null && before !== null && after > before ? `it migrated the database from generation ${before} to ${after}` : `the database may be at generation ${reached ?? 'unknown'}, past the ${ceiling ?? 'unknown'} the previous tip supports`;
        log(`[graphyard-deploy] ${tip.slice(0, 12)} ${reason}; kept: ${why}, which the previous tip would refuse`);
        await ports.pin(tip).catch(failed => log(`[graphyard-deploy] the pin of ${tip.slice(0, 12)} failed: ${message(failed)}`));
        await writeDeployRecord(file, { tip, failed: null, reason: `${reason}; kept because ${why}` });
        return 'kept';
      }
    }
    log(`[graphyard-deploy] ${tip.slice(0, 12)} ${reason}; rolling back to ${previous.slice(0, 12)}`);
    return restore(previous, tip, reason, 1);
  }
}

/** `upgrade --watch`: a pass every interval until stopped; a pass that throws (a fetch that failed) is logged and retried. */
export async function watchMain(file: string, ports: DeployWatchPorts, options: { intervalMs: number; once?: boolean; signal?: AbortSignal; log?: (line: string) => void }) {
  const log = options.log ?? (line => console.error(line));
  for (;;) {
    try { await deployOnce(file, ports, log); } catch (error) { log(`[graphyard-deploy] the pass failed and runs again: ${error instanceof Error ? error.message : String(error)}`); }
    if (options.once || options.signal?.aborted) return;
    try { await delay(options.intervalMs, undefined, { signal: options.signal }); } catch { return; }
  }
}
