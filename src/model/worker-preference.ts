// Concern: which runtimes a worker is tried on first (GY-1746) — Pi for cheap early attempts, the strong runtimes otherwise.
import type { AgentRegistry, FleetRole } from './registry.js';

/**
 * The order a role's accounts are tried in (GY-1746). Only the worker role has a preference: `fast`
 * moves the Pi accounts ahead of the others and `strong` leaves them out, each group keeping the
 * role's own order, so Pi serves the cheap first attempts and a high-risk or repeatedly reworked
 * item goes to the strong runtimes first. A role with no preference is tried in its stored order.
 */
export function workerOrder(registry: AgentRegistry, role: Pick<FleetRole, 'name' | 'accounts'>, prefer: 'fast' | 'strong' | null): string[] {
  if (role.name !== 'worker' || !prefer) return role.accounts;
  const isPi = (name: string) => { const account = registry.accounts.find(entry => entry.name === name); return registry.runtimes.find(entry => entry.name === account?.runtime)?.launch.kind === 'pi'; };
  const pi = role.accounts.filter(isPi), rest = role.accounts.filter(name => !pi.includes(name));
  // A strong-preferred item is held for a strong runtime rather than falling to Pi when none is eligible.
  return prefer === 'fast' ? [...pi, ...rest] : rest;
}

/** The attempts an item gets on Pi before the strong runtimes take it: its first two. */
export const piAttempts = 2;
/** Which runtimes dispatch tries a worker on first (GY-1746): Pi for a low or medium risk item on its first attempts, the strong runtimes for a high risk item and from the third attempt on. `startFailures` counts the launches this dispatch has already spent on accounts that failed to start. */
export const workerPreference = (work: { lane?: string | null; pipeline?: { reworkRounds?: number; attempts?: unknown[] } | null; reworkRounds?: number; attemptCount?: number }, startFailures = 0): 'fast' | 'strong' =>
  // Attempts already made count whether they ended in a rework round or in an expired or blocked epoch.
  work.lane === 'high' || Math.max(work.pipeline?.reworkRounds ?? work.reworkRounds ?? 0, work.pipeline?.attempts?.length ?? work.attemptCount ?? 0) + startFailures >= piAttempts ? 'strong' : 'fast';
