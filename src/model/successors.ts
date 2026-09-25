import { pathScope, wellFormed } from './scope.js';
// ---------------------------------------------------------------------------
// Successors of a planned file (GY-394). When the base branch splits or renames a file an item
// plans — GY-177 split src/master-daemon.ts into src/daemon/* — the code the item plans to change
// now lives in files its plannedFiles never named, and every request for them was refused and
// waited on a master. Git's own rename and copy detection on the base branch, or a successor map a
// split commit records in its message, says which files succeed which: that is the item's own
// scope under its new names. The loop reads the history outside every transaction; nothing here
// runs git.
// ---------------------------------------------------------------------------

/** The least similarity (percent) at which git's rename or copy detection makes a file a successor. */
export const successorMinSimilarity = 30;
/** The commit-message trailer a split records its successor map in: `Graphyard-Successor: old -> new, new`. */
export const successorTrailer = 'Graphyard-Successor';
/** One file that succeeds another on the base: detected by git (similarity in percent) or recorded by the commit. */
export interface Succession { from: string; to: string; commit: string; similarity: number | null }
/** A successor of a planned file: the planned file it succeeds, and the commit that made it one. */
export interface Successor { path: string; of: string; commit: string }

/**
 * The successions one `git log --name-status` read holds, in the order it lists them. Each commit
 * begins with `\x1e<sha>\x1f<trailer values separated by \x1d>`, followed by its `R<score>\told\tnew`
 * and `C<score>\told\tnew` lines. A detected pair below the similarity bar, a quoted (escaped) path
 * and a malformed trailer are left out: a successor is granted only on a clear ground.
 */
export function parseSuccessions(log: string, minSimilarity = successorMinSimilarity): Succession[] {
  const successions: Succession[] = [];
  for (const block of log.split('\x1e').slice(1)) {
    const [head, ...lines] = block.split('\n');
    const [commit, trailers = ''] = head.split('\x1f');
    if (!/^[0-9a-f]{7,64}$/.test(commit)) continue;
    for (const value of trailers.split('\x1d')) {
      const match = /^\s*(\S+)\s*->\s*(.+?)\s*$/.exec(value);
      if (!match || !wellFormed(match[1]) || pathScope(match[1]).prefix) continue;
      for (const to of match[2].split(/[\s,]+/).filter(Boolean)) if (wellFormed(to) && !pathScope(to).prefix && to !== match[1]) successions.push({ from: match[1], to, commit, similarity: null });
    }
    for (const line of lines) {
      const [status, from, to] = line.split('\t');
      const score = /^[RC](\d{1,3})$/.exec(status ?? '');
      if (!score || !from || !to || from.startsWith('"') || to.startsWith('"') || Number(score[1]) < minSimilarity) continue;
      successions.push({ from, to, commit, similarity: Number(score[1]) });
    }
  }
  return successions;
}

/**
 * Every file that succeeds one of `planned` through `successions`, oldest first: a file split into
 * two, one of those renamed again, and so on. A successor keeps the planned file it traces back to
 * and the commit that made it one. Only single planned files have successors; a directory scope
 * already covers whatever moves inside it, and a planned path is never its own successor.
 */
export function successorsOf(planned: readonly string[], successions: readonly Succession[]): Successor[] {
  const files = planned.filter(path => !pathScope(path).prefix && !path.includes('*'));
  const origin = new Map(files.map(path => [path, path]));
  const found = new Map<string, Successor>();
  for (const step of successions) {
    const of = origin.get(step.from);
    if (!of || files.includes(step.to) || found.has(step.to)) continue;
    found.set(step.to, { path: step.to, of, commit: step.commit });
    origin.set(step.to, of);
  }
  return [...found.values()];
}

/** The audited ground a successor is granted on: `successor of src/master-daemon.ts via <commit>`. */
export const successorGround = (successor: Successor) => `successor of ${successor.of} via ${successor.commit.slice(0, 12)}`;

/** The additive requirements revision that re-plans an item onto its planned files' successors: everything else is carried over unchanged. */
export const successorWidening = (work: { policyRevision: number; criteria: unknown[]; dependencies: readonly string[]; plannedFiles?: readonly string[]; exclusiveResources?: readonly string[]; producerProofs?: readonly string[] }, paths: readonly string[], reason: string) => ({
  expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: work.dependencies,
  plannedFiles: [...new Set([...(work.plannedFiles ?? []), ...paths])], exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [], reason });
