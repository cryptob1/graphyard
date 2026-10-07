// Concern: GY-87's throughput measurement the loop records after a verified deployment — the effect and its production wiring (GY-1385).
import type { ChildRun } from '../child-runner.js';
import type { ControlPlaneStatus, MasterConfig } from '../master.js';
import type { Work } from '../model.js';
import { localAncestry } from './deployment.js';
import { loopThroughputMeasurement, type LoopThroughputOutcome } from '../throughput.js';

export interface ThroughputEffects {
  /**
   * After a verified deployment of `observedSha`, records GY-87's throughput measurement for the
   * release the control plane serves, at most once per release, with the loop's own coordinator
   * credential; reads only the window's deliveries whole. Absent, nothing is measured.
   */
  measureThroughput?: (work: Work[], observedSha: string) => Promise<LoopThroughputOutcome>;
}

/**
 * The production wiring: the plane's status and each delivery in the window are read with the
 * coordinator credential (`asCoordinator`), and ancestry is derived as the deployment observation
 * derives it — from this checkout's own object store, the base branch fetched once per measurement.
 */
export function throughputEffects(root: string, current: () => MasterConfig, run: ChildRun, asCoordinator: (path: string) => Promise<unknown>): Required<ThroughputEffects> {
  return {
    measureThroughput: (work, observedSha) => loopThroughputMeasurement(root, { work, observedSha, now: () => Date.now(), origin: new URL(current().url).origin,
      status: () => asCoordinator('status') as Promise<ControlPlaneStatus & Record<string, unknown>>,
      readItem: id => asCoordinator(`work/${encodeURIComponent(id)}`) as Promise<Work>,
      contains: localAncestry(root, current().baseBranch, run).contains }),
  };
}
