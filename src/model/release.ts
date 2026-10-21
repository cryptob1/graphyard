import type { Work } from '../model.js';
import { defaultProductionEnvironment, flowExitAt, noProductionHold, productionHold, servedAt, type ProductionHold } from '../flow-analytics.js';

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
  return servedAt(work, release.environment);
}

/** When a merged item left the flow as the board reads it: `flowExitAt`, its merge (GY-1981). */
export function leftFlowAt(work: Work, _release?: ReleaseView): string | null {
  return flowExitAt(work);
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
/**
 * GY-1904: an exact candidate on the plane's ledger (`release.candidate` events, append-only). It
 * names at most `maxCandidateChanges` members, the source commit that holds them all (the member
 * merged last on main) and `identity`, the content address of that source and the membership, so
 * validation and promotion bind to exactly what was cut. A record is written once and never changed;
 * its validation is a separate append (`release.candidate.validation`) a read folds in.
 */
export interface ExactCandidate {
  id: string; sequence: number; cutAt: string; cutBy: string; trigger: 'manual' | 'schedule';
  members: CandidateMember[];
  sourceSha: string;
  identity: string;
  /** The candidate this one follows, or null for the first. */
  previous: { id: string; sourceSha: string } | null;
  /** The backlog boundary the first cut fixed and every later one carries: deliveries merged at or before it are history; null when every delivery is backlog. */
  floor: string | null;
  /** Delivered changes still waiting after this cut; the next candidate starts with them. */
  waiting: number;
  /** The validation run against exactly these members; null until one is recorded. */
  validation: CandidateValidation | null;
}
export const exactCandidateKind = 'release.candidate';
export const candidateValidationKind = 'release.candidate.validation';
/** Pure: the content identity's input — the source commit, then every member as `workId mergeSha`, in membership order. */
export const candidateIdentityText = (sourceSha: string, members: readonly Pick<CandidateMember, 'workId' | 'mergeSha'>[]) =>
  [sourceSha, ...members.map(member => `${member.workId} ${member.mergeSha}`)].join('\n');
/** Pure: the combined source of members in main's merge order — the last member's merge commit, which holds every earlier one. */
export const candidateSource = (members: readonly Pick<CandidateMember, 'mergeSha'>[]) => members.at(-1)!.mergeSha;
