import type { Work } from '../model.js';
import { defaultProductionEnvironment, flowExitAt, noProductionHold, productionHold, servedAt, type ProductionHold } from '../flow-analytics.js';

/**
 * What the control plane knows about production, as every page reads it (GY-161): the
 * installation's configured production environment (`GRAPHYARD_PRODUCTION_ENVIRONMENT`, on
 * status as `productionEnvironment`), and — only where the production watch has observed what
 * production serves (status `production`) — the merged items it does not serve yet and those
 * whose deployment failed, and when it last looked. With no production observation both sets are
 * empty: a merged item is then Shipped, reading "Merged, not yet seen live" (GY-161 AC-11: never in
 * Moving or at Deploy because `delivery.deployment` is absent). That is the board's grouping only:
 * the delivery still counts as not live — "shipped this week" counts only observed releases — and
 * the master loop still owes `master verify-deployment` for it, which `master status` keeps under
 * `pending` until the release serves it (AGENTS.md).
 */
export interface ReleaseView extends ProductionHold {
  environment: string;
  /**
   * The CI Apps whose check runs the test gate counts (status `ciAppIds`), so a check reads failed
   * only on a trusted App's own failure; null when status has not said.
   */
  ciAppIds: readonly number[] | null;
  /**
   * Whether the master loop researches items before build (`run.research`, as it last published it:
   * status `research.configured`, GY-434). Without it a released feature's Research step is skipped,
   * not pending: no run will start.
   */
  researchConfigured: boolean;
}

export const noRelease: ReleaseView = { environment: defaultProductionEnvironment, ...noProductionHold, ciAppIds: null, researchConfigured: false };

/** The release view from the status read every page already has. */
export function releaseView(status: any): ReleaseView {
  const configured = status?.productionEnvironment;
  const environment = typeof configured === 'string' && configured.trim() ? configured.trim() : defaultProductionEnvironment;
  return {
    environment,
    // Merged items production is observed not to serve yet (still moving, at Deploy), those with an
    // open deployment incident (blocked at Deploy), and when the watch last looked.
    ...productionHold(status?.production),
    ciAppIds: Array.isArray(status?.ciAppIds) ? status.ciAppIds.filter((id: unknown): id is number => typeof id === 'number') : null,
    researchConfigured: status?.research?.configured === true,
  };
}

/** When the release was observed serving a merged item, under the configured environment; null until then. */
export function servedFor(work: Work, release: ReleaseView = noRelease): string | null {
  return servedAt(work, release.environment);
}

/**
 * When a merged item left the flow as the board reads it: `flowExitAt`, the same rule the steps
 * history and the Insights replay are built from, under this installation's production watch.
 */
export function leftFlowAt(work: Work, release: ReleaseView = noRelease): string | null {
  return flowExitAt(work, release.environment, release);
}
