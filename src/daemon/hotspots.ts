// Concern: hot-spot heat for dispatch (GY-882) — which files two or more live attempts are already changing.
import type { Work } from '../model.js';
import { inFlight } from '../coordination.js';
import { pathScopeContains, pathScopesOverlap } from '../model/scope.js';

/**
 * GY-882. Dispatch stays optimistic — overlap never holds an item — but when a file is already
 * being changed by two or more live attempts, a ready item that touches it is offered after one
 * that does not, within the same operator priority. Heat reads `plannedFiles`, the declared scope
 * the next writer will collide with — deliberately not `exclusionPaths`, which stays the reporting
 * basis of `concurrentOverlap` once a candidate's observed diff exists. Only in-flight items heat
 * a file (`inFlight`: a live lease or a standing submission), so two ready peers never heat each
 * other's files, an expired lease and done work heat nothing, and a submission sent back for
 * rework is a peer waiting for a worker, not a claimant — though it is still ordered by another
 * claim's heat like any ready item. An item never heats its own files: the count is over distinct
 * other claimants, and an item's own overlapping scope entries are deduped. Pure over the
 * snapshot: no git, no fetch, no store.
 */
export interface Hotspot { file: string; claimedBy: string[] }

/**
 * The narrower of two overlapping scopes, so a `docs/` claim colliding with
 * `docs/protocol/leases.md` names the file, not the tree. `pathScopesOverlap` is true only on
 * equality or prefix containment, so the narrower of a pair is always well-defined; equal paths
 * name the scope itself.
 */
const narrower = (a: string, b: string) => (pathScopeContains(a, b) ? b : a);

/** The files two or more live attempts or open candidates plan, each with the keys of every claimant. */
export function hotspots(items: Work[], now: number): Hotspot[] {
  const claimants = items.filter(item => inFlight(item, now));
  const heat = new Map<string, Set<string>>();
  for (const claimant of claimants) for (const scope of new Set(claimant.plannedFiles)) {
    for (const other of claimants) {
      if (other.id === claimant.id) continue;
      for (const entry of other.plannedFiles) {
        if (!pathScopesOverlap(scope, entry)) continue;
        const file = narrower(scope, entry);
        const keys = heat.get(file) ?? new Set<string>();
        heat.set(file, keys.add(claimant.key).add(other.key));
      }
    }
  }
  return [...heat.entries()].filter(([, keys]) => keys.size >= 2)
    .map(([file, keys]) => ({ file, claimedBy: [...keys] }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** The set of hot files, as dispatchOrder reads it. */
export const hotFileSet = (items: Work[], now: number) => new Set(hotspots(items, now).map(entry => entry.file));

/** The first hot file `item` touches and the live attempts already changing it, for the dispatch record; null when it touches none. */
export function hotBeside(item: Work, hot: readonly Hotspot[]): { file: string; beside: string[] } | null {
  const found = hot.find(entry => item.plannedFiles.some(path => pathScopesOverlap(path, entry.file)));
  return found ? { file: found.file, beside: found.claimedBy } : null;
}
