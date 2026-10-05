import { protectionRun, type ProtectionRun } from './protection.js';

/**
 * GY-1236. The refs Graphyard's own merge queue left behind. The queue published each entry's
 * speculative tip under `refs/graphyard/queue/<key>` and nothing deletes them now that GitHub merges
 * each passing candidate directly; a tip branch named `graphyard/…-tip-…` is matched as well. Item
 * branches (`graphyard/gy-N-E`) and the base refresh's scratch branches are never tips.
 */
export const tipRefPatterns: readonly RegExp[] = [/^refs\/graphyard\/queue\/[^/]+$/, /^refs\/heads\/graphyard\/.+-tip-.+$/];
export const isTipRef = (ref: string) => tipRefPatterns.some(pattern => pattern.test(ref));

/**
 * `graphyard master tip-cleanup [--apply]`: lists the leftover tip refs of the managed repository
 * through `gh api` and, with `apply`, deletes each one, reporting what it deleted and what GitHub
 * refused. Without `apply` it only reports what it would delete. Run once after the queue's removal;
 * a second run finds nothing.
 */
export function cleanupTipRefs(config: { repository: string }, options: { apply: boolean }, run: ProtectionRun = protectionRun) {
  const listed = (prefix: string) => run('gh', ['api', '--paginate', `repos/${config.repository}/git/matching-refs/${prefix}`, '--jq', '.[].ref'])
    .split('\n').map(line => line.trim()).filter(Boolean);
  const tips = [...new Set([...listed('graphyard/'), ...listed('heads/graphyard/')])].filter(isTipRef).sort();
  if (!options.apply) return { repository: config.repository, apply: false, tips, deleted: [] as string[], refused: [] as { ref: string; error: string }[],
    next: tips.length ? 'Rerun with --apply to delete these refs' : 'Nothing to delete' };
  const deleted: string[] = [], refused: { ref: string; error: string }[] = [];
  for (const ref of tips) {
    try { run('gh', ['api', '--method', 'DELETE', `repos/${config.repository}/git/${ref}`]); deleted.push(ref); }
    catch (error) { refused.push({ ref, error: error instanceof Error ? error.message.slice(0, 300) : String(error) }); }
  }
  return { repository: config.repository, apply: true, tips, deleted, refused };
}
