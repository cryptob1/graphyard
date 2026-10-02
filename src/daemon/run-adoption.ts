// Concern: adopting the headless runs a loop restart left running (GY-453) from the run registry on disk.
import type { MasterConfig } from '../master/profiles.js';
import { agentToken } from '../master/autonomy.js';
import { settleCheckout } from '../master/worktrees.js';
import { producerRunAdopter } from '../producer.js';
import { adoptRuns, type AdoptedRun } from '../runner/registry.js';
import { approverRunAdopter } from '../runner/roles.js';

export type { AdoptedRun };

/**
 * The loop's adoption of the headless runs a restart left running (GY-453): each approver and
 * producer run in the run registry on disk that no process applied yet is watched again, and its
 * result applied once when it ends — an approver's verdict as the approver identity, its managed
 * checkout settled after; a producer's evidence against the run's own binding.
 */
export function loopRunAdoption(root: string, current: () => MasterConfig, fetcher?: typeof fetch) {
  return (): Promise<AdoptedRun[]> => adoptRuns(root, {
    approver: approverRunAdopter(() => agentToken(root, current(), 'approver'), fetcher, checkout => settleCheckout(root, checkout)),
    producer: producerRunAdopter(root, fetcher),
  });
}
