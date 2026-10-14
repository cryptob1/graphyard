// Concern: the loop's worktree-reclaim pass — finished trees, dependency directories, managed checkouts and the inventory cache.
import { stat } from 'node:fs/promises';
import type { ChildRun } from '../child-runner.js';
import type { Work } from '../model.js';
import { readReviewLedger } from '../reviewer.js';
import { readProducerLedger, reclaimCheckouts } from '../producer.js';
import { reclaimIdleMs, reclaimWorktrees, removeReclaimableWorktrees, writeFailure, writeWorktreeInventoryCache, type MasterConfig } from '../master.js';
import { worktreesDirectory, worktreesUnreadable } from '../master/worktrees.js';

/**
 * One pass over the worktrees (GY-360, GY-1784). Finished worktrees are removed outright first, a
 * bounded number per pass; the inventory that remains is the one the dependency reclaim judges and
 * `master status` reads. The same pass takes back every ephemeral checkout no live session owns
 * under the managed root, and records whether that root shares the worktrees' filesystem, since
 * checkouts taken elsewhere free nothing on this volume.
 */
export async function worktreeReclaimPass(root: string, config: MasterConfig, run: ChildRun, work: Work[], now?: number) {
  const idleMs = reclaimIdleMs(config);
  const livePaths = [...(await readReviewLedger(root)).reviews, ...(await readProducerLedger(root)).producers]
    .filter(record => record.state === 'pending' && record.checkout).map(record => record.checkout!);
  // A directory that cannot be read inventories as empty: that is no plan, so the pass says so and the cache keeps its last real inventory (GY-1784 review).
  const unreadable = await worktreesUnreadable(root);
  const trees = await removeReclaimableWorktrees(root, work, { idleMs, run, baseBranch: config.baseBranch, limit: config.run.worktreeRemovalLimit, livePaths, now });
  const report = await reclaimWorktrees(root, work, { idleMs, entries: trees.entries, now });
  const taken = new Set(report.applied ? report.removed : []);
  if (unreadable) report.errors.push(`${worktreesDirectory(root)} could not be read: the worktree inventory is unknown`);
  else await writeWorktreeInventoryCache(root, { at: trees.at, entries: trees.entries.map(entry => ({ ...entry, dependencies: entry.dependencies.filter(dependency => !taken.has(dependency.path)) })),
    held: trees.held })
    .catch(error => report.errors.push(`Worktree inventory cache: ${writeFailure(error, 'Writing the worktree inventory cache').message}`));
  const withTrees = { ...report, trees };
  try {
    const checkouts = await reclaimCheckouts(root, config), device = (path: string) => stat(path).then(info => info.dev, () => null);
    const [here, there] = await Promise.all([device(worktreesDirectory(root)).then(dev => dev ?? device(root)), device(checkouts.root)]);
    return { ...withTrees, checkouts: { ...checkouts, ...(here !== null && there !== null ? { sharesVolume: here === there } : {}) } };
  } catch (error) { return { ...withTrees, errors: [...withTrees.errors, `Ephemeral checkouts: ${writeFailure(error, 'Reclaiming the managed worktree root').message}`] }; }
}
