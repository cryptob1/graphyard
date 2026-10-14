import { defaultChildRun, type ChildRun } from './child-runner.js';
import { parseVerificationMap, type VerificationMap } from './model/verification-maps.js';

export * from './model/verification-maps.js';

const mapPath = /^verification\/[^/]+\.md$/;

/**
 * The verification maps (GY-1495) on origin/BASE in the coordinator checkout, read with git
 * ls-tree and git show as plannedFiles resolution reads the base tree. A launcher calls it before
 * any coordination request, never inside one. An unreadable base reads as no maps, and a malformed
 * map is left out: a session launches without the section rather than not at all.
 */
export async function readVerificationMaps(root: string, baseBranch: string, run: ChildRun = defaultChildRun): Promise<VerificationMap[]> {
  const ref = `refs/remotes/origin/${baseBranch}`;
  let listed: string[];
  try { listed = String(await run('git', ['ls-tree', '-z', '--name-only', ref, '--', 'verification/'], { cwd: root, timeoutMs: 10_000 })).split('\0').filter(path => mapPath.test(path)).sort(); }
  catch { return []; }
  const maps: VerificationMap[] = [];
  for (const path of listed) {
    try {
      const map = parseVerificationMap(path, String(await run('git', ['show', `${ref}:${path}`], { cwd: root, timeoutMs: 10_000 })));
      if (map) maps.push(map);
    } catch { /* an unreadable map yields no section */ }
  }
  return maps;
}
