// Concern: the stale release an unreleased backlog item waits behind, read from its decision history (GY-1294, GY-1315).

/** The unreleased backlog items whose stale release the loop may ask again (GY-1315): those no diagnosis is carrying. */
export const staleReleaseCandidates = <T extends { key: string; stage: string; ready?: boolean }>(work: readonly T[], diagnosed: ReadonlySet<string> = new Set()) =>
  work.filter(item => item.stage === 'backlog' && !item.ready && !diagnosed.has(item.key));
/** The fields of a decision history row these rules read. */
export type DecisionHistoryRow = { id: string; action: string; state: string; requestedAt?: string; outcome?: string | null };
/** The stale release an unreleased backlog item waits behind: its latest release, settled stale. Null for any other item. */
export function staleRelease<T extends DecisionHistoryRow>(work: { stage: string; ready?: boolean }, decisions: readonly T[]): T | null {
  if (work.stage !== 'backlog' || work.ready) return null;
  const release = decisions.filter(decision => decision.action === 'release').at(-1);
  return release?.state === 'stale' ? release : null;
}
/** The item's release requests that settled without applying: the loop's re-requests stop at maxDecisionRequests of them (GY-1296). */
export const unappliedReleases = (decisions: readonly DecisionHistoryRow[]) =>
  decisions.filter(decision => decision.action === 'release' && (decision.state === 'stale' || decision.state === 'withdrawn')).length;
/** How long after its request a stale release the loop is still re-requesting may stand before it counts as a decision fault (GY-1315). */
export const staleReleaseWaitBoundMs = 30 * 60_000;
