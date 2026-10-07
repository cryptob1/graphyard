// Concern: GY-87's throughput measurement the loop records after a verified deployment, and the item that owns its verification — the effects and their production wiring (GY-1385, GY-1438).
import type { ChildRun } from '../child-runner.js';
import type { ControlPlaneStatus, MasterConfig } from '../master.js';
import type { Work } from '../model.js';
import { localAncestry } from './deployment.js';
import { loopThroughputMeasurement, readThroughputMeasurement, throughputStall, type LoopThroughputOutcome, type ThroughputStall, type throughputOwnerItem } from '../throughput.js';

export interface ThroughputEffects {
  /**
   * After a verified deployment of `observedSha`, records GY-87's throughput measurement for the
   * release the control plane serves, with the loop's own coordinator credential; reads only the
   * window's deliveries whole. A release is measured again only while its newest measurement is
   * unverified, at most once per `throughputRemeasureMs` (GY-1438). Absent, nothing is measured.
   */
  measureThroughput?: (work: Work[], observedSha: string) => Promise<LoopThroughputOutcome>;
  /**
   * Files the item that owns the verification (GY-1438) as the operator-agent, under the
   * idempotency key, so a retry after a lost reply returns the item already filed. Null while the
   * operator-agent identity is not provisioned: nothing is filed, and the attention says no item owns it.
   */
  fileThroughputOwner?: (input: ReturnType<typeof throughputOwnerItem>, key: string) => Promise<Work | null>;
  /**
   * The needs-decision standing on the newest recorded measurement of `revision` (`throughputStall`,
   * as master status judges it), or null; read when no owner is open after one was filed (GY-1465).
   */
  standingThroughputStall?: (revision: string) => Promise<ThroughputStall | null>;
  /** Closes the owner item as the operator-agent once the claim verifies or its needs-decision is answered; null, closing nothing, without that identity. */
  closeThroughputOwner?: (owner: Work, reason: string, key: string) => Promise<Work | null>;
}

/**
 * The production wiring: the plane's status and each delivery in the window are read with the
 * coordinator credential (`asCoordinator`), and ancestry is derived as the deployment observation
 * derives it — from this checkout's own object store, the base branch fetched once per measurement.
 */
export function throughputEffects(root: string, current: () => MasterConfig, run: ChildRun, asCoordinator: (path: string) => Promise<unknown>,
  asOperatorAgent: (method: 'POST', path: string, body: unknown, key: string) => Promise<unknown>): Required<ThroughputEffects> {
  return {
    // The identity is read on each call, as a configuration reload may provision it after the loop starts.
    fileThroughputOwner: async (input, key) => current().operatorAgent ? asOperatorAgent('POST', 'work', input, key) as Promise<Work> : null,
    closeThroughputOwner: async (owner, reason, key) => current().operatorAgent ? asOperatorAgent('POST', `work/${owner.id}/close`, { kind: 'obsolete', reason }, key) as Promise<Work> : null,
    standingThroughputStall: async revision => {
      const newest = await readThroughputMeasurement(root);
      return newest?.report.deployed?.revision === revision ? throughputStall(newest.report) : null;
    },
    measureThroughput: (work, observedSha) => loopThroughputMeasurement(root, { work, observedSha, now: () => Date.now(), origin: new URL(current().url).origin,
      status: () => asCoordinator('status') as Promise<ControlPlaneStatus & Record<string, unknown>>,
      readItem: id => asCoordinator(`work/${encodeURIComponent(id)}`) as Promise<Work>,
      contains: localAncestry(root, current().baseBranch, run).contains }),
  };
}
