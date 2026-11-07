// Concern: disk headroom (GY-3122) — the close step measures the volumes Graphyard writes; below the
// floor it reclaims only its own leftovers, and while still below it no new merge trial or worker starts.
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ChildRun } from '../child-runner.js';
import type { MasterConfig } from '../master/profiles.js';
import { freeBytes } from '../master/worktrees.js';
import { trialContainerImage } from '../merge-writer/trial-container.js';
import { reclaimTrialCheckouts, trialCheckoutPrefix, trialCheckoutRoots, trialTemporaryPrefix, trialTemporaryRoots } from '../merge-writer/trial.js';
import { record } from './effects.js';
import { tallyLeftovers } from './leftovers.js';
import type { DaemonEffects } from './effects.js';
import type { DaemonAction, DaemonState } from './state.js';
import { workerVerificationTimeoutMs } from '../merge-writer/worker-verification.js';
import { trialShareAllowance } from './cycle-merge-writer.js';
import { defaultMergeWriterParallel } from '../master/merge-writer-settings.js';

/** The free space every volume Graphyard writes keeps, when master.json sets no `run.diskFloorGb`. */
export const defaultDiskFloorGb = 30;
export const diskFloorBytes = (config: Pick<MasterConfig, 'run'>) => (config.run.diskFloorGb ?? defaultDiskFloorGb) * 1e9;
/** The cursor key of the shortage: a failed `attention` row the master is woken by while it stands. */
export const diskHeadroomKey = 'disk-headroom';
export interface Volume { path: string; freeBytes: number | null }

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
const short = (volumes: Volume[], floor: number) => volumes.filter((volume): volume is Volume & { freeBytes: number } => volume.freeBytes !== null && volume.freeBytes < floor);

/**
 * One cycle's headroom check. Above the floor it changes nothing. Below it, Graphyard's own
 * leftovers are reclaimed and the volumes measured again; a shortage that remains is kept on the
 * cursor (`state.diskHeadroom`, which dispatch, the merge writer and master status read) and as
 * the failed `disk-headroom` attention row that wakes the master. The row names the volumes and
 * the floor, never the free bytes, so a shortage that only moves wakes the master once.
 */
export async function diskHeadroomStep(cycle: { config: Pick<MasterConfig, 'run'>; state: DaemonState; effects: DaemonEffects; now: () => number; performed: DaemonAction[] }) {
  const { config, state, effects, now, performed } = cycle;
  if (!effects.diskVolumes) return;
  const floor = diskFloorBytes(config);
  let low = short(await effects.diskVolumes(), floor);
  if (!low.length && !state.diskHeadroom) return;
  if (low.length && effects.reclaimDisk) {
    const removed = await effects.reclaimDisk();
    tallyLeftovers(state, 'reclaimed', removed.length);
    if (removed.length) performed.push(await record(state, `disk-reclaim:${state.cycle}`, { kind: 'reclaim', work: null, principal: null, state: 'done', attempts: 1, cycle: state.cycle,
      detail: `Free space fell below the ${gb(floor)} floor; reclaimed Graphyard's own leftovers: ${removed.join(', ')}` }, now(), effects.persist));
    low = short(await effects.diskVolumes(), floor);
  }
  if (!low.length) {
    state.diskHeadroom = null;
    if (state.actions[diskHeadroomKey]?.state === 'failed') performed.push(await record(state, diskHeadroomKey, { kind: 'attention', work: null, principal: null, state: 'done', attempts: 1, cycle: state.cycle, detail: `Free space is back above the ${gb(floor)} floor; merge trials and workers start again` }, now(), effects.persist));
    return;
  }
  const at = new Date(now()).toISOString();
  state.diskHeadroom = { at, floorBytes: floor, volumes: low.map(volume => ({ path: volume.path, freeBytes: volume.freeBytes })),
    shortage: `${low.map(volume => `${volume.path} has ${gb(volume.freeBytes)} free`).join('; ')}, below the ${gb(floor)} floor after reclaiming Graphyard's own leftovers: no new merge trial or worker starts until space is freed` };
  const detail = `Disk headroom: ${low.map(volume => volume.path).join(', ')} below the ${gb(floor)} free-space floor after reclaiming Graphyard's own leftovers; no new merge trial or worker starts. Free space outside Graphyard (or raise the volume) — Graphyard never deletes what it did not create`;
  const standing = state.actions[diskHeadroomKey];
  if (standing?.state === 'failed' && standing.detail === detail) { standing.at = at; return; }
  performed.push(await record(state, diskHeadroomKey, { kind: 'attention', work: null, principal: null, state: 'failed', attempts: (standing?.attempts ?? 0) + 1, cycle: state.cycle, detail }, now(), effects.persist));
}

/** The durable volumes Graphyard writes: its checkout, data directory, worktree root, trial checkout root and durable temporary root — one path per device. A memory-backed /tmp is never measured: its size is not disk headroom. */
export async function graphyardVolumes(paths: string[]): Promise<Volume[]> {
  const seen = new Set<number>(), volumes: Volume[] = [];
  for (const path of paths) {
    const device = (await stat(path).catch(() => null))?.dev;
    if (device === undefined || seen.has(device)) continue;
    seen.add(device);
    volumes.push({ path, freeBytes: await freeBytes(path) });
  }
  return volumes;
}

/**
 * Reclaims only what Graphyard created and no longer uses: trial temporary, home and checkout
 * directories whose owner marker names a process that is gone, stopped `graphyard-trial-`
 * containers, and `graphyard-trial` images other than the one trials run (never forced, so Docker
 * keeps an image a container still uses). Ended attempts' worktrees and settled managed checkouts
 * are already removed by the close step itself. What was removed, by name.
 */
export async function reclaimGraphyardLeftovers(run: ChildRun, roots: { temporary?: string[]; checkouts?: string[] } = {}): Promise<string[]> {
  const removed: string[] = [];
  for (const root of roots.temporary ?? trialTemporaryRoots()) removed.push(...await reclaimTrialCheckouts(root, [trialTemporaryPrefix, 'gy-h']));
  for (const root of roots.checkouts ?? trialCheckoutRoots()) removed.push(...await reclaimTrialCheckouts(root, [trialCheckoutPrefix]));
  const docker = async (args: string[]) => String(await run('docker', args, { timeoutMs: 20_000 })).split('\n').map(line => line.trim()).filter(Boolean);
  try {
    const containers = await docker(['ps', '--all', '--filter', 'name=^graphyard-trial-', '--filter', 'status=exited', '--filter', 'status=dead', '--format', '{{.Names}}']);
    for (const name of containers.filter(name => name.startsWith('graphyard-trial-'))) {
      try { await docker(['rm', name]); removed.push(`container ${name}`); } catch { /* the next */ }
    }
    const current = process.env.GRAPHYARD_TRIAL_IMAGE ?? trialContainerImage, repository = trialContainerImage.split(':')[0]!;
    for (const image of await docker(['images', repository, '--format', '{{.Repository}}:{{.Tag}}'])) {
      if (image === current || !image.startsWith(`${repository}:`) || image.endsWith(':<none>')) continue;
      try { await docker(['image', 'rm', image]); removed.push(`image ${image}`); } catch { /* in use, or already gone */ }
    }
  } catch { /* no Docker on this host: nothing of Graphyard's there to reclaim */ }
  return removed;
}

/** Twice the longest deadline a trial container runs under: a merge trial at the most shares the host allows, or a worker verification (GY-3186). */
export const trialContainerMaxAgeMs = (run: Pick<MasterConfig, 'run'>['run']) =>
  2 * Math.max(trialShareAllowance(run.mergeWriter?.parallel ?? defaultMergeWriterParallel).timeoutMs, workerVerificationTimeoutMs);

/**
 * GY-3186: every cycle, stops (removes) a running `graphyard-trial-` container whose checkout (its working
 * directory) is gone or that has run past `maxAgeMs` — a trial nothing will end any more. What it stopped, by name.
 */
export async function stopOrphanTrialContainers(run: ChildRun, maxAgeMs: number, now = Date.now()): Promise<string[]> {
  const docker = async (args: string[]) => String(await run('docker', args, { timeoutMs: 20_000 })).split('\n').map(line => line.trim()).filter(Boolean);
  const stopped: string[] = [];
  try {
    const names = (await docker(['ps', '--filter', 'name=^graphyard-trial-', '--filter', 'status=running', '--format', '{{.Names}}'])).filter(name => name.startsWith('graphyard-trial-'));
    if (!names.length) return stopped;
    for (const line of await docker(['inspect', '--format', '{{.Name}}\t{{.State.StartedAt}}\t{{.Config.WorkingDir}}', ...names])) {
      const [name, startedAt, workdir] = line.replace(/^\//, '').split('\t');
      if (!name?.startsWith('graphyard-trial-') || (workdir && existsSync(workdir) && now - Date.parse(startedAt ?? '') <= maxAgeMs)) continue;
      try { await docker(['rm', '--force', name]); stopped.push(`container ${name}`); } catch { /* the next */ }
    }
  } catch { /* no Docker on this host: no trial container to stop */ }
  return stopped;
}
