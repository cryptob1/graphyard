import { evidenceBindsCandidate, type Work } from '../model.js';

/**
 * The coordination view of the work snapshot: what the master loop and the automatic dispatcher
 * read every few seconds. The full snapshot carries every item's whole history — every evidence
 * record ever submitted with its artifacts and scope, the per-file diff comparison of the last
 * observation, and every resolved dispatch and queue entry — and grows without bound as the
 * ledger ages. This view keeps each document's decision state intact and bounds its history:
 *
 * - evidence: only the records a coordinator decision can still consult — those binding the
 *   current candidate (exactly or carried) and those on a head an open or recent dispatch request
 *   names, so a pending producer session still reads its outcome — without artifact references,
 *   per-file scope digests or provenance;
 * - observation: without the per-file scope comparison, which only the server's regression guard
 *   and evidence reuse read (the touched-path list stays, the overlap scheduler needs it);
 * - resolved dispatch requests, resolved action rows and queue history: the most recent entries
 *   only (the open action rows are what the executors claim from and pass through whole);
 *
 * Gates, violations, leases, candidates and the open requests are the server's own verdicts and
 * pass through unchanged, so nothing the loop decides on is recomputed from a trimmed history.
 */
export const coordinationHistoryLimit = 20;
/** The view is chosen by `?view=coordination` or this header; a server without the view ignores both. */
export const coordinationViewHeader = 'X-Graphyard-View';

export interface CoordinationOmissions { evidence: number; dispatchHistory: number; queueHistory: number; actionHistory: number }

export function coordinationWork(work: Work, omitted: CoordinationOmissions): Work {
  const dispatch = work.autoDispatch;
  const history = dispatch?.history ?? [];
  const recentHistory = history.slice(-coordinationHistoryLimit);
  const requested = new Set([...(dispatch?.review ? [dispatch.review.sha] : []), ...(dispatch?.producers ?? []).map(request => request.sha), ...recentHistory.map(request => request.sha)]);
  const evidence = (work.evidence ?? []).filter(entry => requested.has(entry.sha) || evidenceBindsCandidate(work, entry))
    .map(({ artifacts: _artifacts, scopeFiles: _scopeFiles, provenance: _provenance, ...entry }: any) => entry);
  omitted.evidence += (work.evidence?.length ?? 0) - evidence.length;
  omitted.dispatchHistory += history.length - recentHistory.length;
  const queueHistory = work.queueHistory?.slice(-coordinationHistoryLimit);
  omitted.queueHistory += (work.queueHistory?.length ?? 0) - (queueHistory?.length ?? 0);
  const observation = work.observation ? (({ scopeFiles: _scopeFiles, ...rest }) => rest)(work.observation) as Work['observation'] : work.observation;
  const actions = work.actionQueue;
  const actionHistory = actions?.history.slice(-coordinationHistoryLimit);
  omitted.actionHistory += (actions?.history.length ?? 0) - (actionHistory?.length ?? 0);
  return {
    ...work, evidence, observation,
    ...(dispatch ? { autoDispatch: { ...dispatch, history: recentHistory } } : {}),
    ...(queueHistory ? { queueHistory } : {}),
    ...(actions ? { actionQueue: { ...actions, history: actionHistory! } } : {}),
  };
}

export function coordinationSnapshot<T extends { work: Work[] }>(snapshot: T): T & { view: 'coordination'; omitted: CoordinationOmissions } {
  const omitted: CoordinationOmissions = { evidence: 0, dispatchHistory: 0, queueHistory: 0, actionHistory: 0 };
  return { ...snapshot, work: snapshot.work.map(item => coordinationWork(item, omitted)), view: 'coordination', omitted };
}
