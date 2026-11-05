import type { AgentRegistry, FleetRole } from './registry.js';
import { deriveAccountPlan } from './provider-usage.js';
import { liveSessions } from './registry-sessions.js';
import { globSurface } from './repository-policy.js';
import { pathScopesOverlap, pathScope } from './documentation-glob.js';
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

/**
 * The trial order that spreads concurrent launches across provider plans (GY-2943): accounts on a
 * plan no live session draws on lead, the plans already holding one trail, each group in the role's
 * own order — one plan's rate limit must not take every launch down with it.
 */
export function planSpreadOrder(registry: AgentRegistry, order: readonly string[]): string[] {
  const planOf = (name: string) => { const account = registry.accounts.find(entry => entry.name === name); return account ? deriveAccountPlan(account, registry.accounts).planId : ''; };
  const busy = new Set(liveSessions(registry).map(session => planOf(session.account)));
  return [...order.filter(name => !busy.has(planOf(name))), ...order.filter(name => busy.has(planOf(name)))];
}
/** Skips read in the role's own preference order, whatever the plan spread made of the trial order (GY-2943). */
export const preferenceOrder = (order: readonly string[]) => (first: { account: string }, second: { account: string }) => order.indexOf(first.account) - order.indexOf(second.account);

/** The attempts an item gets on Pi before the strong runtimes take it: its first two. */
export const piAttempts = 2;
/**
 * Whether a directory scope overlaps one glob's surface. A literal glob's surface is a path, judged by
 * `pathScopesOverlap`; a wildcard's literal head may end mid-segment (`packages/api*` → `packages/api`),
 * so it is a string prefix: the scope overlaps when either begins with the other, and `packages/api-v2/`
 * is sensitive under `packages/api*\/secrets.json` as `packages/` is.
 */
export const surfaceOverlaps = (entry: string, glob: string) => {
  const surface = globSurface(glob);
  if (surface === glob.replace(/^\.\//, '')) return pathScopesOverlap(entry, surface);
  const scope = pathScope(entry).path;
  return scope.startsWith(surface) || surface.startsWith(scope);
};

/** What the preference reads of an item: the paths its criteria and description name and the attempts already made. The path lane is not among them. */
export interface PreferenceWork { /** Accepted so a whole item can be handed over; never read (GY-1772). */ lane?: string | null; criteria?: readonly { text: string }[] | null; description?: string | null; pipeline?: { reworkRounds?: number; attempts?: unknown[] } | null; reworkRounds?: number; attemptCount?: number }
