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

/**
 * The refusal the rework workspace recorded while it still observed the submitted PR branch (GY-860
 * AC-2), kept for the releases that carry it: since GY-2017 the workspace starts from the
 * registered local head and observes no PR branch, so a release carrying this message predates
 * that change. The release carrying it still wakes the item's observation job ahead of the polled
 * backlog (GY-1286), as it did when the reading was what the next dispatch waited on.
 */
export const submittedBranchMoved = 'Submitted PR branch changed; wait for Graphyard to observe its current head before creating the rework workspace';
