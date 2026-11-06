import { record } from '../../store/mutations.js';
import { pathsOverlap, validBranch } from '../../workspace.js';
import { activeLease, demand } from '../../model.js';
import type { Ctx } from './types.js';

export async function run(c: Ctx) {
  const { db, actor, data, all, now, work } = c;
  activeLease(work, actor, data.epoch, now);
  demand(validBranch(data.branch), 'Only a Graphyard branch can be reserved');
  demand(!work.workspaces.some(w => w.epoch === data.epoch), 'This assignment already has a workspace');
  demand(!all.some(w => w.workspaces.some(s => (s.branch === data.branch && (w.id !== work!.id || !work!.reworkRequested)) || s.host === data.host && pathsOverlap(s.path, data.path))), 'Branch or host/path is already reserved or overlaps a reservation; use a fresh workspace');
  if (work.submission) demand(data.branch === work.workspaces.find(w => w.epoch === work!.submission!.epoch)?.branch, 'Rework must use the already linked PR branch in a fresh workspace');
  const { preserved, ...workspace } = data;
  work.workspaces.push({ ...workspace, owner: actor.id });
  // The preserved-attempt record (GY-860): what the released holder of this branch carried —
  // its refs and uncommitted diff — is kept on the item's ledger, never discarded silently.
  if (data.preserved) await record(db, work, actor.id, 'workspace.preserved', { details: { epoch: data.epoch, branch: data.branch, ...data.preserved } });
}
