import { agentOwner, buildMasterStatus, type AttentionItem, type HerdrAgent, type WorkerProfile } from '../master.js';
import { orphanedSupervisors, type DaemonState, type OrphanObservation, type OrphanSupervisor } from '../master-daemon.js';
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
 * Whether the loop's own two-observation rule (cycle step 1c) holds for this orphan: the loop has
 * recorded this very supervisor — same epoch, owner and pid — and either has already stopped it or
 * now sees its lease advanced past the expiry it recorded with the session gone. A single snapshot
 * in which Herdr does not yet list a freshly launched worker proves nothing, so status never names
 * a supervisor, or the command that stops it, before the loop would act on it.
 *
 * The loop rolls its recorded expiry forward when it acts, so a stop that failed leaves an
 * observation at the current expiry with no stop counted. The loop marks the observation itself
 * established when its two observations hold, whatever the stop then did, so a failed stop never
 * hides the orphan from status. That mark lives and dies with the observation: a session Herdr
 * reports again drops it, and a later absence starts a fresh, unestablished one.
 */
export function orphanEstablished(orphan: OrphanSupervisor, loop: Pick<DaemonState, 'orphans'> | null | undefined): boolean {
  const tracked: OrphanObservation | undefined = loop?.orphans?.[orphan.id];
  if (!tracked || tracked.epoch !== orphan.epoch || tracked.owner !== orphan.owner || tracked.pid !== orphan.scope.pid) return false;
  return !!tracked.establishedAt || tracked.stops > 0 || Date.parse(orphan.leaseExpiresAt) > Date.parse(tracked.leaseExpiresAt);
}

/**
 * Rewrite the session attention of every assignment held by an orphaned supervisor, in the row
 * and in the attention list alike, so both say the same thing. A Herdr that could not be read
 * reports no sessions, and every live assignment would then look orphaned, so an unavailable
 * runtime changes nothing. Only an orphan the loop's persisted observations establish is named
 * (GY-1617); an unreadable loop state establishes none.
 */
export function nameOrphanSupervisors(status: MasterStatus, work: Work[], profiles: WorkerProfile[], runtime: { agents: HerdrAgent[]; available: boolean }, now: number, loop: Pick<DaemonState, 'orphans'> | null | undefined): MasterStatus {
  if (!runtime.available) return status;
  const orphans = orphanedSupervisors(work, profiles, runtime.agents, now).filter(orphan => orphanEstablished(orphan, loop));
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
