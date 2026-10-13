// Concern: the evidence gate on a scope ask — which asked paths are not repository files (GY-1764).
/** The install-local directory: credentials and state the repository never tracks, so no change plans a file in it. */
export const installLocalDirectory = '.graphyard';
/** Master-status fields a worker may quote as if they were files; a near miss of one is named in the refusal. */
export const masterStatusFields: readonly string[] = ['daemon.release', 'upgrade.alignedRelease', 'upgrade.pending', 'upgrade.last', 'upgrade.refused'];
/** One asked path that is not a repository file, the closest thing it may have meant, and why it is not one. */
export interface NonRepositoryPath { path: string; nearMiss: string | null; why: 'install-local' | 'untracked' }

/** The path an ask names, reduced to the file or directory it is anchored at: a glob or a directory entry loses its tail. */
const anchored = (path: string) => path.replace(/^(\.\/)+/, '').replace(/\*.*$/, '').replace(/\/+$/, '');
const editDistance = (a: string, b: string) => {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
};
/** The candidate a path is most plausibly a truncation or misspelling of, or null: a longer name it begins, else one within two edits. */
export function nearMiss(path: string, candidates: Iterable<string>): string | null {
  if (path.length < 4) return null;
  let best: { name: string; cost: number } | null = null;
  for (const name of candidates) {
    const truncation = name.startsWith(path);
    if (name === path || !truncation && Math.abs(name.length - path.length) > 2) continue;
    const cost = truncation ? 0 : editDistance(path, name);
    if (cost <= 2 && (!best || cost < best.cost || cost === best.cost && name.length < best.name.length)) best = { name, cost };
  }
  return best?.name ?? null;
}

/**
 * The asked paths that are not repository files (GY-1764): under the install-local `.graphyard/`
 * directory, or neither tracked nor inside any tracked directory. The check is anchored at the
 * directory, never at existence, so a file the change will add beside tracked ones stays decidable.
 * A root-level name must itself be tracked: the root holds no directory to anchor a new file in.
 * `files` is the base branch's tracked files; `fields` are the names a near miss may also be.
 */
export function nonRepositoryPaths(paths: readonly string[], files: ReadonlySet<string>, fields: readonly string[] = masterStatusFields): NonRepositoryPath[] {
  const directories = new Set<string>();
  for (const file of files) for (let at = file.indexOf('/'); at > 0; at = file.indexOf('/', at + 1)) directories.add(file.slice(0, at));
  const tracked = (path: string) => files.has(path) || directories.has(path);
  const found: NonRepositoryPath[] = [];
  for (const path of new Set(paths)) {
    const anchor = anchored(path);
    if (anchor === installLocalDirectory || anchor.startsWith(`${installLocalDirectory}/`)) { found.push({ path, nearMiss: null, why: 'install-local' }); continue; }
    if (!anchor || tracked(anchor)) continue;
    let inside = false;
    for (let at = anchor.lastIndexOf('/'); at > 0 && !inside; at = anchor.lastIndexOf('/', at - 1)) inside = directories.has(anchor.slice(0, at));
    if (inside) continue;
    found.push({ path, nearMiss: nearMiss(anchor, [...fields, ...files]), why: 'untracked' });
  }
  return found;
}

/** The refusal's reason: each offending path with why it is not a file and the near miss, so the worker re-asks for what it meant or drops the ask. */
export function nonRepositoryReason(found: readonly NonRepositoryPath[]): string {
  const named = found.map(entry => entry.why === 'install-local'
    ? `${entry.path} is under the install-local ${installLocalDirectory}/ directory, which the repository does not track`
    : `${entry.path} is not a repository file: it is not tracked and lies inside no tracked directory${entry.nearMiss ? ` (did you mean ${entry.nearMiss}${masterStatusFields.includes(entry.nearMiss) ? `? ${entry.nearMiss} is a master-status field, not a file` : '?'})` : ''}`);
  return `${named.join('; ')}. A scope ask names files a change edits or adds; this one is refused by the widening rule and is not put to the approver. Re-ask with real repository paths, or finish without them and record a blocker if a criterion cannot be met`;
}

/** The offending paths a coordinator reports with an `autoscope`, validated and restricted to the paths the request names; anything malformed is ignored, so a bad report never refuses an ask. */
export function nonRepositoryRead(reported: unknown, asked: readonly string[]): NonRepositoryPath[] {
  if (!Array.isArray(reported)) return [];
  return reported.flatMap((entry): NonRepositoryPath[] => {
    if (!entry || typeof entry.path !== 'string' || !asked.includes(entry.path) || entry.why !== 'install-local' && entry.why !== 'untracked') return [];
    return [{ path: entry.path, why: entry.why, nearMiss: typeof entry.nearMiss === 'string' ? entry.nearMiss.slice(0, 300) : null }];
  }).slice(0, 50);
}
