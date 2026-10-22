// Concern: adopting the headless runs a loop restart left running (GY-453) from the run registry on disk.
import type { MasterConfig } from '../master/profiles.js';
import { producerRunAdopter } from '../producer.js';
import { adoptRuns, type AdoptedRun } from '../runner/registry.js';

export type { AdoptedRun };

/**
 * The loop's adoption of the headless runs a restart left running (GY-453): each producer run in
 * the run registry on disk that no process applied yet is watched again, and its evidence applied
 * once when it ends, against the run's own binding.
 */
export function loopRunAdoption(root: string, current: () => MasterConfig, fetcher?: typeof fetch) {
  return (): Promise<AdoptedRun[]> => adoptRuns(root, {
    producer: producerRunAdopter(root, fetcher),
  });
}
