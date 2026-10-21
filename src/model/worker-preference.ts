// Concern: which runtimes a worker is tried on first (GY-1746, GY-1772) — Pi for cheap early attempts on a normal-risk change, the strong runtimes otherwise.
import type { AgentRegistry, FleetRole } from './registry.js';
import { classifyRisk, riskRules } from './risk-class.js';
import { globSurface, repositoryPolicy, type RepositoryPolicy } from './repository-policy.js';
import { namedPaths, pathScope, pathScopesOverlap } from './documentation-glob.js';

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

/**
 * The surface each sensitive rule guards (`riskRules`, the repository's policy), as the literal head
 * of each of its globs: the directory (ending `/`) or the file itself, and for a rule over several
 * globs each of them. A path an item names is a scope, not always a concrete path (`pathScope`):
 * `src/`, `src/**` or `src/server/` admit every file beneath them, among them these surfaces, while
 * matching no rule literally. A directory scope is therefore sensitive when it overlaps any surface
 * here, so an item that may change a sensitive file never gets a cheap attempt because it named the
 * directory instead of the file. A glob that may match anywhere (`**\/migrations/**`) has the empty surface,
 * which every directory scope overlaps. Every surface matches its own rule's pattern, and every rule
 * has a surface (tests/worker-preference-risk.test.ts).
 */
export const surfacesOf = (policy: RepositoryPolicy = repositoryPolicy()): Readonly<Record<string, readonly string[]>> =>
  Object.fromEntries(riskRules(policy).map(({ rule, globs }) => [rule, [...new Set(globs.map(globSurface))]]));
/** The surfaces of the policy in force when this module loaded. */
export const sensitiveSurfaces = surfacesOf();

/**
 * Whether one named path may change a sensitive file: an exact path when a sensitive rule matches
 * it (`classifyRisk`), a directory scope when it overlaps a rule's surface as well (`surfaceOverlaps`). The literal test
 * runs for a directory scope too, so a scope inside a sensitive tree (`src/store/x/`) is sensitive by
 * the rule itself.
 */
export const entrySensitive = (entry: string, policy: RepositoryPolicy = repositoryPolicy()): boolean =>
  classifyRisk([{ path: entry }], policy).risk === 'sensitive'
    || !!pathScope(entry).prefix && riskRules(policy).some(({ globs }) => globs.some(glob => surfaceOverlaps(entry, glob)));
/**
 * Whether a directory scope overlaps one glob's surface. A literal glob's surface is a path, judged by
 * `pathScopesOverlap`; a wildcard's literal head may end mid-segment (`packages/api*` → `packages/api`),
 * so it is a string prefix: the scope overlaps when either begins with the other, and `packages/api-v2/`
 * is sensitive under `packages/api*\/secrets.json` as `packages/` is.
 */
const surfaceOverlaps = (entry: string, glob: string) => {
  const surface = globSurface(glob);
  if (surface === glob.replace(/^\.\//, '')) return pathScopesOverlap(entry, surface);
  const scope = pathScope(entry).path;
  return scope.startsWith(surface) || surface.startsWith(scope);
};

/** What the preference reads of an item: the paths its criteria and description name and the attempts already made. The path lane is not among them. */
export interface PreferenceWork { /** Accepted so a whole item can be handed over; never read (GY-1772). */ lane?: string | null; criteria?: readonly { text: string }[] | null; description?: string | null; pipeline?: { reworkRounds?: number; attempts?: unknown[] } | null; reworkRounds?: number; attemptCount?: number }
/**
 * Which runtimes dispatch tries a worker on first (GY-1746, GY-1772): Pi for an item whose named
 * change is normal risk — no path its criteria or description name matches a sensitive rule of the
 * repository's policy nor, as a directory scope, covers a rule's surface (`sensitiveSurfaces`) — on its
 * first attempts; the strong runtimes for a sensitive named path, for an item that names no path (a
 * change nobody can see is the worst case, as `classifyRisk` judges it) and from the third attempt on. The
 * item's path lane is not read: the lane classifies the pull request's observed paths once there is
 * one, while the class judges the change before any launch, so a sensitive change never gets a
 * cheap first attempt because its lane was not yet raised, and a normal change in a high lane still
 * does. `startFailures` counts the launches this dispatch has already spent on accounts that failed
 * to start.
 */
export const workerPreference = (work: PreferenceWork, startFailures = 0): 'fast' | 'strong' => {
  const named = namedPaths([work.description ?? '', ...(work.criteria ?? []).map(criterion => criterion.text)].join('\n'));
  // Attempts already made count whether they ended in a rework round or in an expired or blocked epoch.
  return !named.length || named.some(entry => entrySensitive(entry))
    || Math.max(work.pipeline?.reworkRounds ?? work.reworkRounds ?? 0, work.pipeline?.attempts?.length ?? work.attemptCount ?? 0) + startFailures >= piAttempts ? 'strong' : 'fast';
};
