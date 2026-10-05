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
 * GY-860 AC-2: the worktree command's refusal of a rework workspace whose PR branch moved past the
 * head Graphyard last observed — a docs-sync push, a base refresh, a worker's late push. The
 * release carrying it wakes the item's observation job ahead of the polled backlog (GY-1286): the
 * next dispatch can only succeed once that reading lands, and nothing else asks for it, so on
 * 2026-10-05 GY-1234 was refused six times in 30 minutes while its observation sat in the backlog.
 */
export const submittedBranchMoved = 'Submitted PR branch changed; wait for Graphyard to observe its current head before creating the rework workspace';
