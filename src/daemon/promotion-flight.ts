// Concern: whether the promotion pipeline is moving a delivered merge toward the release that serves it — the wait a verify-deployment failure may name (GY-1831, GY-1966).
import type { ChildRun } from '../child-runner.js';
import { message, type PromotionState } from './state.js';
import { promotionWaitBoundMs, promotionWaitClause } from '../model/action-kinds.js';

/**
 * Local ancestry over this checkout's own object store, which is what "does the release contain
 * this merge" actually asks. The base branch is fetched once, lazily: an observation that answers
 * every delivery from the retained containment fetches nothing at all.
 */
export function localAncestry(root: string, baseBranch: string, run: ChildRun) {
  let fetched: string | null | undefined;
  const git = (...args: string[]) => run('git', ['-C', root, ...args]);
  const fetchBase = async () => {
    if (fetched !== undefined) return fetched;
    try { await git('fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`); fetched = null; }
    catch (error) { fetched = message(error).split('\n')[0]; }
    return fetched;
  };
  const held = async (ancestor: string, descendant: string): Promise<boolean | null> => {
    try { await git('merge-base', '--is-ancestor', ancestor, descendant); return true; }
    // Exit 1 is git's "not an ancestor". Anything else — a commit this checkout does not hold,
    // a broken repository — is unknown, and unknown containment is never read as deployed.
    catch (error: any) { return error?.status === 1 ? false : null; }
  };
  return {
    get fetchFailure() { return fetched || null; },
    /** `true`/`false` when git could answer, `null` when this checkout does not hold both commits. */
    async contains(ancestor: string, descendant: string): Promise<boolean | null> {
      if (ancestor === descendant) return true;
      await fetchBase();
      return held(ancestor, descendant);
    },
    /** GY-1831: `contains` over the commits the checkout already holds, fetching nothing — the
     * caller has just read a release whose observation fetched the base branch, or answers null. */
    containsHeld(ancestor: string, descendant: string): Promise<boolean | null> {
      if (ancestor === descendant) return Promise.resolve(true);
      return held(ancestor, descendant);
    },
  };
}

/** The reason control-plane mode reports when the loop's environment gives it no local release ports. */
export const noLocalPortsReason = 'The recorded merger is control-plane, so the loop cuts and promotes candidates itself, but its environment names no UAT: set GRAPHYARD_UAT_URL, GRAPHYARD_UAT_TOKEN and GRAPHYARD_PRODUCTION_URL for the loop';
/** What a recorded promotion reason starts with while the main watch's freeze holds every dispatch (GY-1831's gate reading). */
export const promotionFrozenReasonPrefix = 'Promotion is frozen since ';
/** The reason a recorded promotion state names while `run.promoteEveryMinutes` is 0 and nothing is ever dispatched (GY-1831's gate reading). */
export const promotionOffReason = 'Promotion by the loop is off (run.promoteEveryMinutes is 0)';

/**
 * How long after a promotion is recorded production may still be deploying it (GY-1831): the
 * release-candidate workflow records the promotion before the production deploy it starts has
 * finished, and a deploy whose healthcheck alone allows two minutes lands well inside this. Past it,
 * production not serving the promoted release is a rollback or a wedged deploy.
 */
export const promotionHandoffMs = 20 * 60_000;

/**
 * GY-1831, GY-1966: whether the promotion pipeline is moving a delivered merge toward the
 * release that serves it — so a `verify-deployment` attempt that fails only because the running
 * release does not serve the merge yet is naming the pipeline's work, not a fault. Answered from
 * the promotion state the loop already reads and records on its cursor, at the cadence its own
 * read windows set: the executor asking this at a failed attempt runs no fetch and no GitHub
 * request of its own, and never touches the promotion ledger's pin. The gates that stop every
 * dispatch — promotion off, the main watch's freeze, a control-plane merger whose local ports the
 * loop lacks — are read from the same state, so a row only ever waits on a pipeline the loop is
 * driving; anywhere else a failure stands as it was.
 *
 * The answer is the pipeline's demonstrated progress (GY-1966), not a binary in-flight read. A
 * merge is being moved while
 *
 * - a promotion of it is recorded and production is still deploying that release
 *   (`promotionHandoffMs`); past the handoff, production not serving it is a rollback or a wedged
 *   deploy, and stays a fault;
 * - a release candidate run is in validation;
 * - the dispatch that will carry it is due — main has moved past the cut the last candidate
 *   made, or that candidate left merges queued behind it (`promotionCycle` dispatches exactly
 *   then; GY-1513, GY-1491); or
 * - the newest candidate was cut inside `promotionWaitBoundMs`, the window the pipeline grants a
 *   candidate's validation and the re-cut behind the moving main (GY-1966): a candidate that
 *   failed is not the pipeline stopping — its soak may still be running, and the release
 *   machinery, not the item holding the gate, is what moves the delivery from here. Past the
 *   window, with nothing in flight and no dispatch due, the pipeline has itself stopped moving,
 *   and the row stalls.
 *
 * A merge the base branch no longer carries is not in flight at all. A merge newer than the
 * recorded tip, on the base branch past it, is due: the loop's next ledger read carries it.
 * Containment is read over the commits the checkout already holds — the observation that failed
 * just fetched the base branch — and containment that cannot be read answers not carrying.
 */
export async function promotionCarryingMerge(state: PromotionState | null, mergeSha: string, root: string, baseBranch: string, run: ChildRun, now: number): Promise<boolean> {
  if (!state) return false;
  const reason = state.reason;
  if (reason !== null && (reason === promotionOffReason || reason.startsWith(promotionFrozenReasonPrefix) || reason === noLocalPortsReason)) return false;
  if (!state.mainSha) return false;
  const ancestry = localAncestry(root, baseBranch, run);
  const recorded = await ancestry.containsHeld(mergeSha, state.mainSha);
  // A merge that landed after the loop's last ledger read is on the base branch the failed
  // observation just fetched, ahead of the recorded tip: the loop's next read (within its ledger
  // window) sees main moved, and the dispatch that carries it is due — unless that branch has moved
  // off the recorded tip altogether, which is no pipeline this state describes.
  if (recorded === false) {
    const tip = `refs/remotes/origin/${baseBranch}`;
    return await ancestry.containsHeld(mergeSha, tip) === true && await ancestry.containsHeld(state.mainSha, tip) === true;
  }
  if (recorded !== true) return false;
  // Promoted: the deployment that serves it follows the record, so the wait holds through that
  // handoff; a promotion recorded longer ago than the handoff that production still does not serve
  // is no pace of the pipeline's.
  if (state.promotedSha && await ancestry.containsHeld(mergeSha, state.promotedSha) === true) {
    const promotedAt = state.promotedAt ? Date.parse(state.promotedAt) : Number.NaN;
    return Number.isFinite(promotedAt) && now - promotedAt >= 0 && now - promotedAt < promotionHandoffMs;
  }
  // In flight is the loop's own flag: a release candidate run in validation.
  if (state.inFlight) return true;
  const newest = state.candidates?.[0] ?? null;
  // Due: nothing is in flight, and main has moved past the cut the last candidate made — or that
  // candidate left merges queued behind it — so the next dispatch carries main: `promotionCycle`
  // dispatches exactly then, and the queued rule is its own (GY-1513, GY-1491).
  const queued = !!newest && state.candidateAtDispatch !== undefined && newest.id !== state.candidateAtDispatch && newest.sha !== state.mainSha && (newest.queued ?? 0) > 0;
  if (!state.cutSha || state.cutSha !== state.mainSha || queued) return true;
  // GY-1966: a quiet pipeline whose newest candidate was just cut is not a stopped one. The
  // candidate's validation and the re-cut behind the moving main are the window the machinery
  // grants itself — a failed candidate whose soak still runs included — and the release machinery
  // is what moves the delivery from here. Past the window the pipeline has stopped moving, and
  // the row stalls.
  const cutAt = newest ? Date.parse(newest.cutAt) : Number.NaN;
  return !!newest && Number.isFinite(cutAt) && now - cutAt >= 0 && now - cutAt < promotionWaitBoundMs;
}

/**
 * The pipeline's newest demonstrated movement, in the reader's words: the newest fact the
 * recorded state holds that bears on a merge's delivery. The wait a verify-deployment failure
 * names carries it (GY-1966), so the row's unchanged reason stands while the movement stands and
 * changes when the pipeline moves again — the row's run of identical failures measures the
 * stretch since the pipeline last moved, and `promotionWaitBoundMs` bounds how long a stretch
 * without one may last.
 */
export function promotionMovement(state: PromotionState): string {
  const promotedAt = state.promotedAt ? Date.parse(state.promotedAt) : Number.NaN;
  if (state.promotedSha && Number.isFinite(promotedAt)) return `the promotion of ${state.promotedSha.slice(0, 12)} recorded ${state.promotedAt}`;
  if (state.inFlight) return `the release candidate dispatched ${state.lastDispatchAt ?? state.dispatchedAt ?? 'most recently'} is still in validation`;
  const newest = state.candidates?.[0] ?? null, cutAt = newest ? Date.parse(newest.cutAt) : Number.NaN;
  if (newest && Number.isFinite(cutAt)) return `the newest candidate ${newest.id} was cut ${newest.cutAt}`;
  if (state.cutSha && state.mainSha && state.cutSha !== state.mainSha) return `main ${state.mainSha.slice(0, 12)} moved past the last candidate cut ${state.cutSha.slice(0, 12)}`;
  return 'the recorded promotion state names no newer movement';
}

/**
 * The wait a `verify-deployment` failure names while the pipeline is moving the merge (GY-1831),
 * with the pipeline's newest demonstrated movement (GY-1966): `promotionWaitClause` — constant,
 * so the bound (`handoffWaitBound`) still reads it — followed by the movement, which stands while
 * the pipeline stands still and changes when it moves again. Null when the pipeline is not
 * carrying the merge: the plain failure stands, and the stall it earns is what it was.
 */
export async function promotionWaitSuffix(state: PromotionState | null, mergeSha: string, root: string, baseBranch: string, run: ChildRun, now: number): Promise<string | null> {
  if (!state || !await promotionCarryingMerge(state, mergeSha, root, baseBranch, run, now)) return null;
  return `${promotionWaitClause} (${promotionMovement(state)})`;
}
