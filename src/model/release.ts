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
}

export const noRelease: ReleaseView = { environment: defaultProductionEnvironment, ...noProductionHold, ciAppIds: null };

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

/**
 * GY-1904: one member of an exact candidate — a change Graphyard delivered, bound to its work item
 * and the merge commit that delivered it.
 */
export interface CandidateMember { workId: string; key: string; mergeSha: string; mergedAt: string; pr: number | null }
/**
 * GY-1904: an exact candidate on the plane's ledger (`release.candidate` events, append-only). It
 * names at most `maxCandidateChanges` members, the source commit that holds them all (the newest
 * member's merge commit) and `identity`, the content address of that source and the membership, so
 * validation and promotion bind to exactly what was cut. A record is written once and never changed.
 */
export interface ExactCandidate {
  id: string; sequence: number; cutAt: string; cutBy: string; trigger: 'manual' | 'schedule';
  members: CandidateMember[];
  sourceSha: string;
  identity: string;
  /** The candidate this one follows, or null for the first. */
  previous: { id: string; sourceSha: string } | null;
  /** Deliveries merged at or after this instant are the ledger's backlog: 24 hours before the first cut, carried by every later one, so an install's history is never cut. */
  floor: string;
  /** Delivered changes still waiting after this cut; the next candidate starts with them. */
  waiting: number;
  /** The validation run against exactly these members; null until one is recorded. */
  validation: null;
}
export const exactCandidateKind = 'release.candidate';
/** How far before the first cut the backlog reaches. */
export const candidateFloorMs = 24 * 3_600_000;
/** Pure: the content identity's input — the source commit, then every member as `workId mergeSha`, in membership order. */
export const candidateIdentityText = (sourceSha: string, members: readonly Pick<CandidateMember, 'workId' | 'mergeSha'>[]) =>
  [sourceSha, ...members.map(member => `${member.workId} ${member.mergeSha}`)].join('\n');
/** Pure: the combined source of members in merge order — the newest member's merge commit, which holds every earlier one. */
export const candidateSource = (members: readonly Pick<CandidateMember, 'mergeSha'>[]) => members.at(-1)!.mergeSha;
