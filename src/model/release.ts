import type { Work } from '../model.js';

const defaultProductionEnvironment = 'production';
const time = (value: string | null | undefined) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : null; };

/** What the production watch observes about production: merged items not served yet, those with an open deployment incident, and when it last looked. */
export interface ProductionHold {
  unserved: ReadonlySet<string>;
  failed: ReadonlySet<string>;
  observedAt: number | null;
}
const noProductionHold: ProductionHold = { unserved: new Set(), failed: new Set(), observedAt: null };

/** The hold from the production watch's report; only a pass that saw what production serves is an observation. */
function productionHold(report: any): ProductionHold {
  const observed = !!report?.observedAt && !!report?.serving && !report?.error;
  if (!observed || time(report.observedAt) === null) return noProductionHold;
  const keys = (list: unknown) => Array.isArray(list) ? list.filter((key): key is string => typeof key === 'string') : [];
  return {
    unserved: new Set(keys(report.pending)),
    failed: new Set(keys((Array.isArray(report.incidents) ? report.incidents : []).map((incident: any) => incident?.key))),
    observedAt: time(report.observedAt),
  };
}

/**
 * What the control plane knows about production, as every page reads it (GY-161): the
 * installation's configured production environment (`GRAPHYARD_PRODUCTION_ENVIRONMENT`, on
 * status as `productionEnvironment`), and — only where the production watch has observed what
 * production serves (status `production`) — the merged items it does not serve yet and those
 * whose deployment failed, and when it last looked. With no production observation both sets are
 * empty. A merged item is Shipped either way (GY-1981: done = merged), reading "Merged" until a
 * release is observed serving it, and "shipped this week" counts only observed releases.
 */
export interface ReleaseView extends ProductionHold {
  environment: string;
}

export const noRelease: ReleaseView = { environment: defaultProductionEnvironment, ...noProductionHold };

/** The release view from the status read every page already has. */
export function releaseView(status: any): ReleaseView {
  const configured = status?.productionEnvironment;
  const environment = typeof configured === 'string' && configured.trim() ? configured.trim() : defaultProductionEnvironment;
  return {
    environment,
    // Merged items production is observed not to serve yet (still moving, at Deploy), those with an
    // open deployment incident (blocked at Deploy), and when the watch last looked.
    ...productionHold(status?.production),
  };
}

/** When the release was observed serving a merged item, under the configured environment; null until then. */
export function servedFor(work: Work, release: ReleaseView = noRelease): string | null {
  if (work.stage !== 'done' || work.closure || !work.delivery) return null;
  const verified = (work.releaseDeliveries ?? []).filter(entry => entry.environment === release.environment)
    .map(entry => entry.verifiedAt).filter(at => time(at) !== null).sort((a, b) => time(a)! - time(b)!)[0];
  return verified ?? work.delivery.deployment?.observedAt ?? null;
}

/** When a merged item left the flow as the board reads it: its merge (GY-1981). Null for work closed without delivery. */
export function leftFlowAt(work: Work, _release?: ReleaseView): string | null {
  if (work.stage !== 'done' || work.closure || !work.delivery) return null;
  return work.delivery.mergedAt ?? work.observation?.mergedAt ?? work.stageEnteredAt;
}

/**
 * GY-1904: one member of an exact candidate — a change Graphyard delivered, bound to its work item
 * and the merge commit that delivered it.
 */
export interface CandidateMember { workId: string; key: string; mergeSha: string; mergedAt: string; pr: number | null }
/** GY-1904: the UAT verdict recorded against an exact candidate: the release candidate tagged at its source, and what its cases found. */
export interface CandidateValidation {
  /** The `rc/ID` record the loop cut at the candidate's source and validated. */
  release: string; sha: string; identity: string; result: 'pass' | 'fail'; at: string; by: string;
  /** Each required case's verdict, and the cases or suites that failed. */
  cases: { id: string; result: string }[]; failed: string[];
}

