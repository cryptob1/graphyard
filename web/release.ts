import type { Work } from '../src/model';
import { defaultProductionEnvironment, deliveredAt, servedAt } from '../src/flow-analytics';

/**
 * What the control plane knows about production, as every page reads it (GY-161): the
 * installation's configured production environment (`GRAPHYARD_PRODUCTION_ENVIRONMENT`, on
 * status as `productionEnvironment`), and — only where the production watch has observed what
 * production serves (status `production`) — the merged items it does not serve yet and those
 * whose deployment failed. With no production observation both sets are empty: a merged item is
 * then Shipped ("Merged, not yet seen live"), never held at Deploy for a record nobody writes.
 */
export interface ReleaseView {
  environment: string;
  /** Merged items production is observed not to serve yet: still moving, at Deploy. */
  unserved: ReadonlySet<string>;
  /** Merged items with an open deployment incident (failed or missing): blocked at Deploy. */
  failed: ReadonlySet<string>;
  /**
   * The CI Apps whose check runs the test gate counts (status `ciAppIds`), so a check reads failed
   * only on a trusted App's own failure; null when status has not said.
   */
  ciAppIds: readonly number[] | null;
}

export const noRelease: ReleaseView = { environment: defaultProductionEnvironment, unserved: new Set(), failed: new Set(), ciAppIds: null };

/** The release view from the status read every page already has. */
export function releaseView(status: any): ReleaseView {
  const configured = status?.productionEnvironment;
  const environment = typeof configured === 'string' && configured.trim() ? configured.trim() : defaultProductionEnvironment;
  const production = status?.production;
  // Only a pass that saw what production serves is an observation; an unknown serving commit or a
  // failed provider read says nothing about any one item.
  const observed = !!production?.observedAt && !!production?.serving && !production?.error;
  const keys = (list: unknown) => Array.isArray(list) ? list.filter((key): key is string => typeof key === 'string') : [];
  return {
    environment,
    unserved: new Set(observed ? keys(production.pending) : []),
    failed: new Set(observed ? keys((Array.isArray(production.incidents) ? production.incidents : []).map((incident: any) => incident?.key)) : []),
    ciAppIds: Array.isArray(status?.ciAppIds) ? status.ciAppIds.filter((id: unknown): id is number => typeof id === 'number') : null,
  };
}

/** When the release was observed serving a merged item, under the configured environment; null until then. */
export function servedFor(work: Work, release: ReleaseView = noRelease): string | null {
  return servedAt(work, release.environment);
}

/**
 * When a merged item left the flow as the board reads it: when the release was observed serving
 * it; else, while the production watch reports it unserved or failed, never (it is at Deploy);
 * else `deliveredAt` — its merge, or the passing post-deployment check its policy asks for.
 */
export function leftFlowAt(work: Work, release: ReleaseView = noRelease): string | null {
  const served = servedFor(work, release);
  if (served) return served;
  if (release.unserved.has(work.key) || release.failed.has(work.key)) return null;
  return deliveredAt(work, release.environment);
}
