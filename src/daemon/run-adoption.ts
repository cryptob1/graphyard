// Concern: adopting the headless runs a loop restart left running (GY-453) from the run registry on disk.
import type { MasterConfig } from '../master/profiles.js';
import { producerRunAdopter } from '../producer.js';
import { adoptRuns, type AdoptedRun } from '../runner/registry.js';
import { adoptHeadlessSessions, adoptHeadlessWorkers } from '../headless-session.js';
import { headlessReviewAdopter } from '../reviewer.js';

export type { AdoptedRun };

/**
 * The loop's adoption of the headless runs a restart left running (GY-453): each producer run in
 * the run registry on disk that no process applied yet is watched again, and its evidence applied
 * once when it ends, against the run's own binding; and each headless review run
 * left in its run directory has its answer posted and its session settled (GY-3113); a headless
 * worker run still alive is listed again until it ends, its own supervisor holding its lease (GY-3259).
 */
export function loopRunAdoption(root: string, current: () => MasterConfig, fetcher?: typeof fetch) {
  return async (): Promise<AdoptedRun[]> => [
    ...await adoptRuns(root, { producer: producerRunAdopter(root, fetcher) }),
    ...adoptHeadlessSessions(root, { review: headlessReviewAdopter(root) }),
    ...adoptHeadlessWorkers(root),
  ];
}
