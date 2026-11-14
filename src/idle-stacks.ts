// Concern: stopping idle Graphyard stacks on a shared host (GY-3291) — previews nobody used for the
// idle period and temporary stacks whose owning process is gone — without touching anything else.
import { composeOwnerLabel, composeProjectPrefix, defaultDocker, dockerEnvironment, type Docker } from './compose-preview.js';
import { tempOwnerGone, tempOwnerJudgeable, tmpReclaimMinAgeMs, type TempOwner } from './tmp-reclaim.js';

// ---------------------------------------------------------------------------
// Only Compose projects named `graphyard-preview-…` whose containers carry Graphyard's owner label
// are Graphyard's: an item preview, or a trial's check services (`graphyard-preview-trial-services-…`).
// An installed control plane (`graphyard-OWNER-NAME`, hello-huck, …), its database, a shared BuildKit
// builder and anything unlabelled are never Graphyard's to stop. A stack is stopped with `docker stop`:
// its containers, volumes and networks stay, so stopping again is harmless and no data is lost. Age is
// never evidence: a preview is idle only when its last use (ready, or opened through its link) is older
// than the idle period and no review uses it; a temporary stack is abandoned only when its owner is gone.
// ---------------------------------------------------------------------------

/** How long a preview may go unused before it is stopped: `GRAPHYARD_PREVIEW_IDLE_MINUTES`, 30 by default. */
export const previewIdleMs = (env: NodeJS.ProcessEnv = process.env) => {
  const minutes = Number(env.GRAPHYARD_PREVIEW_IDLE_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 1 ? minutes : 30) * 60_000;
};

/** One running container on the daemon: its id, Compose project (empty when it has none) and owner label. */
export interface StackContainer { id: string; project: string; owner: TempOwner | null }
/** A preview this loop serves, by its Compose project: when it was last used and whether a review uses it now. */
export interface PreviewActivity { key: string; lastUsedAt: number; inUse: boolean }
/** What reconciliation does with one stack, and why. */
export interface StackDecision { project: string; containers: string[]; stop: boolean; reason: string }

/** The running containers the daemon holds, with their Compose project and Graphyard owner. */
export async function runningContainers(docker: Docker = defaultDocker, env = dockerEnvironment({ PATH: process.env.PATH ?? '' })): Promise<StackContainer[]> {
  const out = await docker(['ps', '--no-trunc', '--format', `{{.ID}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "${composeOwnerLabel}"}}`], { env, timeoutMs: 30_000 });
  return out.split('\n').filter(line => line.trim()).map(line => {
    const [id = '', project = '', label = ''] = line.trim().split('\t');
    let owner: TempOwner | null = null;
    try { const parsed = JSON.parse(label); if (typeof parsed?.pid === 'number') owner = parsed; } catch { /* names no owner */ }
    return { id, project, owner };
  });
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;
/**
 * The decision for every Compose project among `containers`: stop an idle preview of this loop
 * (`previews`) and a Graphyard stack whose owner is gone; keep everything else, naming why.
 */
export function stackDecisions(containers: readonly StackContainer[], previews: ReadonlyMap<string, PreviewActivity>, options: { now: number; idleMs: number; procRoot?: string }): StackDecision[] {
  const projects = new Map<string, StackContainer[]>();
  for (const container of containers) projects.set(container.project, [...projects.get(container.project) ?? [], container]);
  return [...projects].sort(([a], [b]) => a < b ? -1 : 1).map(([project, list]) => {
    const decide = (stop: boolean, reason: string): StackDecision => ({ project, containers: list.map(entry => entry.id), stop, reason });
    const owners = list.flatMap(entry => entry.owner ? [entry.owner] : []);
    if (!project.startsWith(composeProjectPrefix) || !owners.length) return decide(false, 'not a Graphyard stack');
    const preview = previews.get(project);
    if (preview) {
      const used = `${preview.key}'s preview, last used ${new Date(preview.lastUsedAt).toISOString()}`;
      if (preview.inUse) return decide(false, `${used}, in use by a review`);
      const idle = options.now - preview.lastUsedAt;
      return idle >= options.idleMs ? decide(true, `idle: ${used}, unused for ${minutes(idle)}`) : decide(false, used);
    }
    const live = owners.find(owner => !tempOwnerGone(owner, options.procRoot) && (tempOwnerJudgeable(owner, options.procRoot) || options.now - Date.parse(owner.at) < tmpReclaimMinAgeMs));
    return live ? decide(false, `its owner pid ${live.pid} still runs`) : decide(true, `abandoned: its owner pid ${owners[0]!.pid} is gone`);
  });
}

/**
 * One reconciliation: reads the running containers, stops every stack `stackDecisions` stops with
 * `docker stop` (never removing a container, volume or network) and answers the decisions it acted on.
 */
export async function stopIdleStacks(previews: ReadonlyMap<string, PreviewActivity>, options: { now: number; idleMs: number; docker?: Docker; env?: Record<string, string>; procRoot?: string }): Promise<StackDecision[]> {
  const docker = options.docker ?? defaultDocker, env = options.env ?? dockerEnvironment({ PATH: process.env.PATH ?? '' });
  const stopped = stackDecisions(await runningContainers(docker, env), previews, options).filter(decision => decision.stop);
  for (const decision of stopped) await docker(['stop', '--time', '10', ...decision.containers], { env, timeoutMs: 120_000 });
  return stopped;
}
