// Concern: master status's plain stopped signal (GY-3095): a role nothing can launch on, named with its refusal, how long it has lasted and the next command.
import type { FleetView } from '../model/registry.js';
import { formatAge } from '../model/duration.js';

export interface StoppedRole { subject: string; role: string; refusal: string; since: string | null; lasted: string | null; next: string; text: string }

const atConcurrency = (reason: string) => /is at its concurrency limit/.test(reason);

/** The command that frees the role, by the refusal that stops it. */
function nextCommand(fleet: FleetView, role: FleetView['roles'][number], reason: string) {
  if (atConcurrency(reason)) return `graphyard master registry lists the live ${role.role} sessions holding its ${role.concurrency} slot${role.concurrency === 1 ? '' : 's'}; end one nothing runs with graphyard master registry session end SESSION_ID --reason REASON`;
  if (/is paused \(concurrency 0\)/.test(reason)) return `graphyard master registry role set ${role.role} ${role.accounts.join(',') || 'ACCOUNT'} --concurrency N --reason REASON`;
  if (/not configured|names no account/.test(reason)) return `graphyard master registry role set ${role.role} ACCOUNT[,ACCOUNT…] --reason REASON`;
  const resets = fleet.accounts.filter(account => role.accounts.includes(account.name) && account.resetsAt).map(account => account.resetsAt!).sort()[0];
  return `graphyard master registry names why each of ${role.accounts.join(', ')} is ineligible; log one in, add an account to the role with graphyard master registry role set ${role.role} ACCOUNT[,ACCOUNT…] --reason REASON${resets ? `, or wait for the first quota reset at ${resets}` : ''}`;
}

/**
 * Roles that cannot launch: one with no usable account, or one whose launches the registry has
 * refused for at least a full loop cycle. A role at its concurrency limit with every slot carrying
 * work is busy, not stopped, and raises nothing (the registry's own fleet attention says the same).
 */
export function stoppedRoles(fleet: FleetView | null, now: number, cycleMs: number): StoppedRole[] {
  // A control plane before the registry (or a stand-in answering every path alike) reports no roles.
  if (!fleet || !Array.isArray(fleet.roles)) return [];
  return fleet.roles.flatMap(role => {
    const reason = role.blocked;
    if (!reason) return [];
    const full = atConcurrency(reason);
    if (full && role.role !== 'master' && !fleet.attention.some(line => line.startsWith(`role ${role.role} `))) return [];
    const recorded = fleet.refusals.findLast(entry => entry.role === role.role && (!fleet.host || entry.host === fleet.host));
    const since = recorded?.reason === reason ? recorded.at : null;
    if (full && (!since || now - Date.parse(since) < cycleMs)) return [];
    const lasted = since ? formatAge(since, now) : null, next = nextCommand(fleet, role, reason);
    return [{ subject: `role ${role.role}`, role: role.role, refusal: reason, since, lasted, next,
      text: `Stopped: role ${role.role} cannot launch — ${reason}${lasted ? ` (refused for ${lasted}, since ${since})` : ''}. Next: ${next}` }];
  });
}
