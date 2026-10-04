import type { Work } from './model.js';
import { nextAction } from './model/next-action.js';
import { mergeAuthorized, predictQueue } from './merge-queue.js';
import { agentOwner, type AttentionItem } from './master/attention.js';

/**
 * What the observation scheduler serves first, and how stale each band may grow (GY-492, GY-1114).
 *
 * Two steps read GitHub through an observation with a bound: the merge gate refuses one older than
 * two minutes, and a reviewer launch one older than thirty. On 2026-10-02, with ~95 open items,
 * the fleet's steady-state interval had stretched to an hour, so 43 review-requested items aged
 * past thirty minutes behind the starved backlog while 19 reviewer slots idled and nothing merged
 * for 80 minutes. Here every open item is placed in a band — `merge` (the queue head band, merges
 * in flight, tips in validation), `review` (the next action is the review request) or `steady` —
 * and the bands with a bound are claimed ahead of the backlog before they reach it.
 */

/** How old an observation may be and still serve the merge gate (the publication guard's bound too). */
export const observationFreshnessMs = 120_000;
/** How old the observation of a requested head may be when a reviewer is launched for it (GY-710). */
export const reviewObservationFreshnessMs = 30 * 60_000;
export type FreshnessBand = 'merge' | 'review' | 'steady';
/** Each band's freshness bound; steady items have none and wait behind the others. */
export const observationFreshnessBounds: Record<FreshnessBand, number | null> = { merge: observationFreshnessMs, review: reviewObservationFreshnessMs, steady: null };
/**
 * A review-requested item is polled at least this often however far the fleet's steady-state
 * interval stretches: a third of its bound, so two missed polls still leave a launchable reading.
 */
export const reviewCadenceCapMs = reviewObservationFreshnessMs / 3;
/** A review-requested item whose reading is this old is claimed with the merge path, ahead of starved jobs. */
export const reviewPromotionAgeMs = reviewObservationFreshnessMs / 2;

/**
 * How far the claim priority reaches into the merge queue (GY-492): the head and the next
 * `max(2, batch size) - 1` entries. The head needs a fresh observation to merge at all; the
 * entries its batch is validated with move only when it does.
 */
export const headClaimBand = (batchSize: number) => Math.max(2, Math.max(1, Math.floor(batchSize)));
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
/** Whether the item's next action is the review request, which a reviewer launch serves only from a reading under its bound. */
export const reviewRequested = (work: Work, all: Work[], now = new Date()) => work.stage !== 'done' && nextAction(work, all, now)?.kind === 'request-review';

/** The merge path's ids (GY-567): the queue-head band in queue position, then any merge in flight. */
function mergePath(all: Work[], batchSize: number, now: number): string[] {
  const band = headClaimBand(batchSize);
  const ranked = predictQueue(all, now).filter(placement => placement.position < band).map(placement => placement.id);
  for (const work of all) if (mergeAuthorized(work) && !ranked.includes(work.id)) ranked.push(work.id);
  return ranked;
}
/**
 * How many of the claim order's leading ids are the merge path — the queue-head band and any merge
 * in flight (GY-567) — which no starved job overtakes.
 */
export const observationHeadCount = (all: Work[], batchSize: number, now = Date.now()) => mergePath(all, batchSize, now).length;

/** Every open item's claim class, read once from the fleet: the expensive part of the claim order. */
export interface ObservationClaimClasses { mergePath: string[]; firstReads: string[]; review: string[]; waiting: string[]; running: string[] }
export function observationClaimClasses(all: Work[], batchSize: number, now = Date.now()): ObservationClaimClasses {
  const ranked = mergePath(all, batchSize, now), date = new Date(now);
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
 * ahead of the backlog, so it never reaches the thirty minutes a reviewer launch refuses. Then
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
export function observationClaim(all: Work[], batchSize: number, now = Date.now(), tight = false) {
  const at = new Map(all.map(work => [work.id, work.observation?.at ? Date.parse(work.observation.at) : null]));
  return observationClaimPlan(observationClaimClasses(all, batchSize, now), id => at.get(id) ?? null, now, tight);
}
/** The claim order alone (GY-492): see `observationClaimPlan`. */
export const observationClaimOrder = (all: Work[], batchSize: number, now = Date.now(), tight = false) => observationClaim(all, batchSize, now, tight).order;

/** The band an open submitted item's observation lag is reported in; null for one with nothing to observe. */
export function freshnessBand(work: Work, all: Work[], merging: ReadonlySet<string>, now: Date): FreshnessBand | null {
  if (work.stage === 'done' || !work.submission) return null;
  if (merging.has(work.id) || work.queue?.tips?.length) return 'merge';
  return reviewRequested(work, all, now) ? 'review' : 'steady';
}
/** How long a lag is, in the unit a reader reads: a minute and change, or seconds. */
export const observationLag = (ms: number) => ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${Math.round(ms % 60_000 / 1000)}s` : `${Math.round(ms / 1000)}s`;

/**
 * Observation lag per band (GY-1114), for `master status`: how many items each band holds, the
 * oldest reading in it, its bound, and how many items are past it. A bounded band with any item
 * past its bound raises one attention item naming the band, the oldest item and its lag. The
 * merge band's queue head is `observationThroughputStatus`'s own item, so `skipHead` leaves it out.
 */
export function observationBandLag(all: Work[], now: number, skipHead: string | null = null) {
  const merging = new Set(mergePath(all, 1, now)), date = new Date(now);
  const bands = (['merge', 'review', 'steady'] as FreshnessBand[]).map(band => ({ band, boundMs: observationFreshnessBounds[band], items: 0, pastBound: 0, oldest: null as string | null, lagMs: null as number | null, stale: null as { key: string; lagMs: number } | null }));
  for (const work of all) {
    const band = freshnessBand(work, all, merging, date);
    if (!band) continue;
    const entry = bands.find(row => row.band === band)!;
    entry.items++;
    const lag = work.observation?.at ? Math.max(0, now - Date.parse(work.observation.at)) : Infinity;
    if (entry.boundMs !== null && lag > entry.boundMs && work.key !== skipHead) { entry.pastBound++; if (!entry.stale || lag > entry.stale.lagMs) entry.stale = { key: work.key, lagMs: lag }; }
    if (entry.lagMs === null || lag > entry.lagMs) { entry.lagMs = lag; entry.oldest = work.key; }
  }
  const report = bands.map(({ stale: _stale, ...entry }) => ({ ...entry, lagMs: entry.lagMs === Infinity ? null : entry.lagMs, unobserved: entry.lagMs === Infinity }));
  const attention: AttentionItem[] = bands.filter(entry => entry.boundMs !== null && entry.stale).map(entry => ({ subject: 'github',
    text: `The ${entry.band} band has ${entry.pastBound} of ${entry.items} item(s) observed longer ago than its ${observationLag(entry.boundMs!)} bound (oldest ${entry.stale!.key}, ${entry.stale!.lagMs === Infinity ? 'never observed' : observationLag(entry.stale!.lagMs)}): ${entry.band === 'merge' ? 'the merge gate refuses them' : 'reviewer launches refuse them'} until the observation workers reach them`,
    ...agentOwner('control plane', 'Nothing to run: the workers claim these bands ahead of the backlog; if the lag persists, raise GRAPHYARD_OBSERVATION_CONCURRENCY with GRAPHYARD_DATABASE_POOL_SIZE (workers at most half the pool) and restart the server') }));
  return { bands: report, attention };
}
