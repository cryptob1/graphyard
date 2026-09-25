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
 * - the pipeline timeline: dropped whole, like the observation's scope comparison and without a
 *   tally, because the omission is structural rather than a count of entries. It is a report of
 *   what already happened — one entry per attempt, growing for the life of the item — and every
 *   reader of it (master status, the speed summary) derives that report from the full documents.
 *   No gate, dispatch or action decision consults it, so the loop's own poll need not carry it;
 *
 * - sessions: the running ones and the last few finished; each kept resolved action row, its last
 *   few attempt records;
 * - a settled delivery (`deliverySettled`): none of those histories, and no finished session;
 *
 * Gates, violations, leases, candidates and the open requests are the server's own verdicts and
 * pass through unchanged, so nothing the loop decides on is recomputed from a trimmed history.
 */
export const coordinationHistoryLimit = 20;
/**
 * The attempt records each kept resolved action row keeps, and the finished sessions a live item
 * keeps beside its running ones (GY-203). No coordinator decision reads a resolved row's earlier
 * attempts or a long-finished session — the server derives the one thing that did, a producer's
 * launch stop, from whole documents — and together they were most of a live document's weight.
 * Equal to `coordinationRecords` and `coordinationSessions` in src/store/coordination-sql.ts.
 */
export const coordinationRecordLimit = 3, coordinationSessionLimit = 5;
/** The view is chosen by `?view=coordination` or this header; a server without the view ignores both. */
export const coordinationViewHeader = 'X-Graphyard-View';

export interface CoordinationOmissions { evidence: number; dispatchHistory: number; queueHistory: number; actionHistory: number; sessions: number }

const absent = (value: unknown) => value === null || value === undefined || typeof value !== 'object';
/**
 * A delivery nothing is owed for any more (GY-203): done, with no next action, queue entry, lease,
 * action row or running session. The loop reads such an item only for what it is — delivered, its
 * delivery record, its gates — so the view keeps none of its histories, no evidence but what binds
 * its candidate, and no finished session. The work index stores exactly this view of it at write
 * time (`settledSql` in src/store/coordination-sql.ts is the SQL form; the two must agree), so the
 * coordination snapshot serves it without reading its document.
 */
export const deliverySettled = (work: Work) => work.stage === 'done' && absent(work.nextAction) && absent(work.queue) && absent(work.lease)
  && !(Array.isArray(work.actionQueue?.actions) && work.actionQueue.actions.length)
  && !(Array.isArray(work.sessions) && work.sessions.some(handle => handle?.state === 'running'));
const recent = <T>(entries: T[], keep: number) => entries.slice(Math.max(0, entries.length - keep));

export function coordinationWork(work: Work, omitted: CoordinationOmissions): Work {
  const settled = deliverySettled(work), keep = settled ? 0 : coordinationHistoryLimit;
  const dispatch = work.autoDispatch;
  const history = dispatch?.history ?? [];
  const recentHistory = recent(history, keep);
  const requested = new Set([...(dispatch?.review ? [dispatch.review.sha] : []), ...(dispatch?.producers ?? []).map(request => request.sha), ...recentHistory.map(request => request.sha)]);
  const evidence = (work.evidence ?? []).filter(entry => requested.has(entry.sha) || evidenceBindsCandidate(work, entry))
    .map(({ artifacts: _artifacts, scopeFiles: _scopeFiles, provenance: _provenance, ...entry }: any) => entry);
  omitted.evidence += (work.evidence?.length ?? 0) - evidence.length;
  omitted.dispatchHistory += history.length - recentHistory.length;
  const queueHistory = work.queueHistory && recent(work.queueHistory, keep);
  omitted.queueHistory += (work.queueHistory?.length ?? 0) - (queueHistory?.length ?? 0);
  const observation = work.observation ? (({ scopeFiles: _scopeFiles, ...rest }) => rest)(work.observation) as Work['observation'] : work.observation;
  const actions = work.actionQueue;
  const actionHistory = actions && recent(actions.history, keep)
    .map(row => Array.isArray(row.history) ? { ...row, history: recent(row.history, coordinationRecordLimit) } : row);
  omitted.actionHistory += (actions?.history.length ?? 0) - (actionHistory?.length ?? 0);
  const sessionsKept = settled ? 0 : coordinationSessionLimit;
  const sessions = Array.isArray(work.sessions) ? work.sessions.filter((handle, index, all) => handle?.state === 'running' || index >= all.length - sessionsKept) : undefined;
  if (sessions) omitted.sessions += work.sessions!.length - sessions.length;
  const { pipeline: _pipeline, ...decisions } = work;
  return {
    ...decisions, evidence, observation,
    ...(dispatch ? { autoDispatch: { ...dispatch, history: recentHistory } } : {}),
    ...(queueHistory ? { queueHistory } : {}),
    ...(actions ? { actionQueue: { ...actions, history: actionHistory! } } : {}),
    ...(sessions ? { sessions } : {}),
  };
}

export function coordinationSnapshot<T extends { work: Work[] }>(snapshot: T): T & { view: 'coordination'; omitted: CoordinationOmissions } {
  const omitted: CoordinationOmissions = { evidence: 0, dispatchHistory: 0, queueHistory: 0, actionHistory: 0, sessions: 0 };
  return { ...snapshot, work: snapshot.work.map(item => coordinationWork(item, omitted)), view: 'coordination', omitted };
}
