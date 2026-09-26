import type { Work } from '../model.js';

/** Use the control plane observation time, never the worker machine clock. */
export function assignment(work: Pick<Work, 'lease' | 'lastAssignment' | 'workspaces'>, now: number) {
  const active = !!work.lease && Date.parse(work.lease.expiresAt) > now;
  const latestWorkspace = work.workspaces.reduce<Work['workspaces'][number] | undefined>((latest, workspace) => !latest || workspace.epoch > latest.epoch ? workspace : latest, undefined);
  const previous = work.lastAssignment ?? latestWorkspace;
  const owner = active ? work.lease!.owner : previous?.owner ?? work.lease?.owner;
  const epoch = active ? work.lease!.epoch : previous?.epoch ?? work.lease?.epoch;
  const identity = work.lastAssignment?.owner === owner && work.lastAssignment?.epoch === epoch ? work.lastAssignment : undefined;
  const name = identity?.displayName ?? owner;
  const label = name ? `${name}${identity?.runtime ? ` · ${identity.runtime}` : ''}` : 'Unassigned';
  return { active, owner, epoch, label, text: owner && !active ? `Last worked by ${label}` : label };
}
