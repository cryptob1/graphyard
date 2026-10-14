// Concern: which runtimes a worker is tried on first (GY-1746, GY-1772) — Pi for cheap early attempts on a normal-risk change, the strong runtimes otherwise.
import type { AgentRegistry, FleetRole } from './registry.js';
import { classifyRisk } from './risk-class.js';

/**
 * The order a role's accounts are tried in (GY-1746). Only the worker role has a preference: `fast`
 * moves the Pi accounts ahead of the others and `strong` leaves them out, each group keeping the
 * role's own order, so Pi serves the cheap first attempts and a sensitive or repeatedly reworked
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
/** What the preference reads of an item: the change it plans and the attempts already made. The path lane is not among them. */
export interface PreferenceWork { /** Accepted so a whole item can be handed over; never read (GY-1772). */ lane?: string | null; plannedFiles?: readonly string[] | null; pipeline?: { reworkRounds?: number; attempts?: unknown[] } | null; reworkRounds?: number; attemptCount?: number }
/**
 * Which runtimes dispatch tries a worker on first (GY-1746, GY-1772): Pi for an item whose planned
 * change is normal risk — no `plannedFiles` path matches a `sensitiveRules` pattern (risk-class.ts) —
 * on its first attempts; the strong runtimes for a sensitive planned path, for an item that plans no
 * files (a change nobody can see is the worst case, as `classifyRisk` judges it) and from the third
 * attempt on. The item's path lane is not read: the lane classifies the pull request's observed
 * paths once there is one, while the class judges the change before any launch, so a sensitive
 * change never gets a cheap first attempt because its lane was not yet raised, and a normal change
 * in a high lane still does. `startFailures` counts the launches this dispatch has already spent on
 * accounts that failed to start.
 */
export const workerPreference = (work: PreferenceWork, startFailures = 0): 'fast' | 'strong' =>
  // Attempts already made count whether they ended in a rework round or in an expired or blocked epoch.
  classifyRisk((work.plannedFiles ?? []).map(path => ({ path }))).risk === 'sensitive'
    || Math.max(work.pipeline?.reworkRounds ?? work.reworkRounds ?? 0, work.pipeline?.attempts?.length ?? work.attemptCount ?? 0) + startFailures >= piAttempts ? 'strong' : 'fast';
