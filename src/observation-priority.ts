import type { Work } from './model.js';
import { nextAction } from './model/next-action.js';
import { mergeAuthorized } from './model/merge-authorization.js';
/**
 * How old the reading of a review-requested head may grow (GY-1114): the scheduler's own bound, which
 * no launch enforces (`assertReviewCandidate` binds the head, not the age, GY-710), so a requested
 * head that moved on GitHub is noticed, and the request superseded, within it.
 */
export const reviewObservationFreshnessMs = 30 * 60_000;
/**
 * A review-requested item is polled at least this often however far the fleet's steady-state
 * interval stretches: a third of its bound, so two missed polls still leave a launchable reading.
 */
export const reviewCadenceCapMs = reviewObservationFreshnessMs / 3;
/** A review-requested item whose reading is this old is claimed with the merge path, ahead of starved jobs. */
export const reviewPromotionAgeMs = reviewObservationFreshnessMs / 2;

/** A submitted item the control plane has never read: its first observation is what every later gate waits on. */
export const firstObservationOwed = (work: Work) => !!work.submission && !work.observation && !work.candidate && work.stage !== 'done';
/** Whether a session is running on the item now: a worker, reviewer or producer whose result an observation reads. */
export const runningSession = (work: Work) => (work.sessions ?? []).some(session => session.state === 'running' && !session.endedAt);
/**
 * Whether this item's next action waits on an observation (GY-492): the loop requests a rework
 * round and dispatches a review only from a fresh reading of the pull request, so a job for such
 * an item is claimed ahead of the idle backlog that would otherwise hold it minutes.
 */
export function waitsOnObservation(work: Work, all: Work[], now = new Date(), kind = nextAction(work, all, now)?.kind): boolean {
  // A resync is the wait for a fresher reading itself (a first reading has its own tier): unnamed, it was
  // claimed only after every named starved job, and under a paced budget never (2026-09-26: GY-393, GY-430 for 3 h).
  return kind === 'request-rework' || kind === 'request-review' || (kind === 'resync' && !firstObservationOwed(work));
}

/** The merge path's ids (GY-567): every item GitHub may merge now, whose merge is recorded from its next reading. */
function mergePath(all: Work[]): string[] {
  return all.filter(mergeAuthorized).map(work => work.id);
}
/** How many of the claim order's leading ids are the merge path (GY-567), which no starved job overtakes. */
export const observationHeadCount = (all: Work[]) => mergePath(all).length;

/** Every open item's claim class, read once from the fleet: the expensive part of the claim order. */
export interface ObservationClaimClasses { mergePath: string[]; firstReads: string[]; review: string[]; waiting: string[]; running: string[] }
export function observationClaimClasses(all: Work[], now = Date.now()): ObservationClaimClasses {
  const ranked = mergePath(all), date = new Date(now);
  const open = all.filter(work => work.stage !== 'done' && !ranked.includes(work.id));
  // A submission never observed has no candidate, so no gate, review or proof can start until it
  // is read once. Behind the review-waiting items, which come due again every cycle, one worker
  // never reached it (2026-09-26: eight submitted PRs unread for hours).
  const kinds = new Map(open.map(work => [work.id, nextAction(work, all, date)?.kind]));
  return { mergePath: ranked, firstReads: open.filter(firstObservationOwed).map(work => work.id),
    review: open.filter(work => kinds.get(work.id) === 'request-review').map(work => work.id),
    waiting: open.filter(work => waitsOnObservation(work, all, date, kinds.get(work.id))).map(work => work.id), running: open.filter(runningSession).map(work => work.id) };
}
/**
 * The claim order and its protected prefix (GY-492, GY-1114). The prefix — which no starved job
 * overtakes in `Store.takeJob` — is the merge path, then every review-requested item whose reading
 * has reached `reviewPromotionAgeMs`, oldest first: past half its bound a review request is served
 * ahead of the backlog, so it never reaches the review band's thirty minutes. Then
 * submissions never observed, items whose next action waits on an observation, running sessions
 * (ahead of the waits under a `tight` budget, GY-567), and the rest by `available_at`.
 * `available_at` still gates every claim: priority reorders due jobs, never makes one due.
 */
export function observationClaimPlan(classes: ObservationClaimClasses, observedAt: (id: string) => number | null, now = Date.now(), tight = false): { order: string[]; headCount: number } {
  const age = (id: string) => { const at = observedAt(id); return at === null ? Infinity : now - at; };
  const promoted = classes.review.filter(id => age(id) >= reviewPromotionAgeMs).sort((a, b) => age(b) - age(a));
  const head = [...new Set([...classes.mergePath, ...promoted])];
  const order = [...new Set([...head, ...classes.firstReads, ...(tight ? [classes.running, classes.waiting] : [classes.waiting, classes.running]).flat()])];
  return { order, headCount: head.length };
}
/** The claim plan for this fleet, read from each item's own observation time. */
export function observationClaim(all: Work[], now = Date.now(), tight = false) {
  const at = new Map(all.map(work => [work.id, work.observation?.at ? Date.parse(work.observation.at) : null]));
  return observationClaimPlan(observationClaimClasses(all, now), id => at.get(id) ?? null, now, tight);
}
/** The claim order alone (GY-492): see `observationClaimPlan`. */
export const observationClaimOrder = (all: Work[], now = Date.now(), tight = false) => observationClaim(all, now, tight).order;
