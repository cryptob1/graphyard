import { agentOwner, buildMasterStatus, type AttentionItem, type HerdrAgent, type WorkerProfile } from '../master.js';
import { orphanedSupervisors, type OrphanSupervisor } from '../master-daemon.js';
import type { Work } from '../model.js';

// Split from master-status.ts (GY-138) to keep that module within its hotspot budget.

type MasterStatus = ReturnType<typeof buildMasterStatus>;

/**
 * The command that reclaims an assignment from a watch supervisor that outlived its agent. The
 * coordination cycle does it on its own; this is how a master runs that cycle once when the loop
 * is stopped, which is the state the item is usually noticed in.
 */
export const supervisorReclaimCommand = 'graphyard master run --once';

/**
 * One attention line for an assignment whose watch supervisor has outlived its session.
 *
 * `Assigned worker session is done` reads as an item that finished, which is exactly what it is
 * not: the session is gone, the lease is still advancing, and the item cannot be dispatched to
 * anybody. This names the supervisor holding it, the process and scope it is held by, and the
 * command that reclaims it — an agent command, never a hand search for a pid.
 */
export function orphanSupervisorAttention(orphan: OrphanSupervisor, host: string | null): AttentionItem {
  return { subject: orphan.key,
    text: `Lease epoch ${orphan.epoch} of ${orphan.key} is still advancing (to ${orphan.leaseExpiresAt}) while Herdr no longer reports session ${orphan.agentName}: an orphaned watch supervisor (pid ${orphan.scope.pid}, containment scope ${orphan.scope.unit}) holds the item for a worker that cannot act`,
    ...agentOwner('master', `${supervisorReclaimCommand} stops that supervisor through its containment scope; on ${host ?? 'its registered host'}, systemctl --user kill --kill-whom=all --signal=SIGTERM ${orphan.scope.unit} does the same by hand`) };
}

/**
 * Rewrite the session attention of every assignment held by an orphaned supervisor, in the row
 * and in the attention list alike, so both say the same thing. A Herdr that could not be read
 * reports no sessions, and every live assignment would then look orphaned, so an unavailable
 * runtime changes nothing.
 */
export function nameOrphanSupervisors(status: MasterStatus, work: Work[], profiles: WorkerProfile[], runtime: { agents: HerdrAgent[]; available: boolean }, now: number): MasterStatus {
  if (!runtime.available) return status;
  const orphans = orphanedSupervisors(work, profiles, runtime.agents, now);
  if (!orphans.length) return status;
  const rewritten = new Map<string, { previous: string | null; item: AttentionItem }>();
  const rows = status.work.map(row => {
    const orphan = orphans.find(entry => entry.key === row.key);
    if (!orphan) return row;
    const item = orphanSupervisorAttention(orphan, work.find(candidate => candidate.id === orphan.id)?.workspaces.find(space => space.epoch === orphan.epoch)?.host ?? null);
    rewritten.set(row.key, { previous: row.attention, item });
    const { subject, text, ...owner } = item;
    return { ...row, attention: text, attentionOwner: owner };
  });
  const attentionItems = status.attentionItems.map(entry => {
    const rewrite = rewritten.get(entry.subject);
    return rewrite && entry.text === rewrite.previous ? rewrite.item : entry;
  });
  for (const [key, rewrite] of rewritten) if (!attentionItems.some(entry => entry.subject === key && entry.text === rewrite.item.text)) attentionItems.push(rewrite.item);
  return { ...status, work: rows, attentionItems };
}
