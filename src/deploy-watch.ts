// Concern: the continuous deploy graphyard-deploy.service runs (`graphyard upgrade --watch`): each new
// base tip is checked out, built, restarted and health-checked; a failing one is rolled back to the
// previous tip and the watch waits for the next tip. The master loop restarts itself onto the tip
// this records (daemon/run.ts restartCause).
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** What the deploy last served, and the tip that failed and is skipped until the base moves past it. */
export interface DeployRecord { tip: string | null; failed: string | null; reason: string | null; at: string }
export const deployRecordPath = (root: string) => join(root, '.graphyard', 'deploy.json');
export function readDeployRecord(file: string): DeployRecord | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')) as DeployRecord; } catch { return null; }
}
async function writeDeployRecord(file: string, record: DeployRecord) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
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
}
const steps = ['checkout', 'build', 'restart', 'health'] as const;

/**
 * One pass: fetch, and when the base tip is new, deploy it. A failure at any step rolls back to the
 * previous tip through the same steps and records the failed tip, which waits for the next one.
 */
export async function deployOnce(file: string, ports: DeployWatchPorts, log: (line: string) => void = line => console.error(line)): Promise<'unchanged' | 'deployed' | 'rolled-back'> {
  const tip = await ports.fetch();
  const record = readDeployRecord(file) ?? { tip: await ports.head(), failed: null, reason: null, at: new Date().toISOString() };
  if (tip === record.tip || tip === record.failed) return 'unchanged';
  const run = async (commit: string) => { for (const step of steps) { log(`[graphyard-deploy] ${step} ${commit.slice(0, 12)}`); try { await ports[step](commit); } catch (error) { throw new Error(`${step} failed: ${error instanceof Error ? error.message : String(error)}`); } } };
  try {
    await run(tip);
    await writeDeployRecord(file, { tip, failed: null, reason: null, at: new Date().toISOString() });
    log(`[graphyard-deploy] serving ${tip.slice(0, 12)}`);
    return 'deployed';
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`[graphyard-deploy] ${tip.slice(0, 12)} ${reason}; rolling back to ${record.tip?.slice(0, 12) ?? 'nothing'}`);
    let rollback = '';
    if (record.tip) try { await run(record.tip); } catch (failed) { rollback = `; the rollback to ${record.tip.slice(0, 12)} failed too: ${failed instanceof Error ? failed.message : String(failed)}`; }
    await writeDeployRecord(file, { tip: record.tip, failed: tip, reason: `${reason}${rollback}`.slice(0, 2000), at: new Date().toISOString() });
    return 'rolled-back';
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
