import { actionIdleMs, idleActionable, queueSnapshot } from './model/actions.js';
import { acceptedMergeAt, nearestRankPercentiles, pipelineSpeed, pipelineSpeedSummary, speedTarget, type Percentiles } from './pipeline-speed.js';
import type { Work } from './model.js';

/**
 * Throughput without a master session (AC-6), measured rather than asserted.
 *
 * The claim the inversion makes is about real deliveries: with the control plane naming each
 * item's next action and stateless executors running the rows, throughput follows the number of
 * executors and agents rather than how much attention an operator is paying. So the measurement
 * is over deliveries the record shows were made that way, and over nothing else:
 *
 * - **The population the criterion names.** "Ten deliveries with no master session running" is a
 *   statement about particular deliveries, not about a stretch of calendar. `deliveryAttribution`
 *   decides it per delivery, from the item's own record: the queue's history has to show a
 *   stateless executor settling the rows that moved it after it submitted, and nothing may have
 *   been handed to a master or an operator in between. A delivery a master moved is excluded and
 *   says so, rather than being averaged in with the ones the fleet moved.
 * - **Real submit→merge times.** The p50 is over that population, on the clock the repository
 *   really recorded, never over every delivery the ledger happens to hold.
 * - **Nothing idle but actionable.** Every sample of the live queue, taken across the window,
 *   with the worst unclaimed row in any of them. A row that has waited longer than the bound is
 *   an item with something to do and nobody doing it, which is exactly the failure a master
 *   session used to paper over by hand.
 *
 * The population rule is what keeps the measurement honest in both directions. It cannot be met
 * by a ledger of deliveries a master drove — every one of them is excluded, and the verdict says
 * how many and why — and it cannot be dodged by widening the window, because widening adds
 * excluded deliveries rather than qualifying ones.
 *
 * Nothing here decides a gate. It is the measurement a witness records, and the same arithmetic
 * `master status` reports, so the two can never disagree.
 */

export interface QueueSample {
  at: string;
  pending: number; claimed: number;
  /** Rows unclaimed longer than the idle bound at this instant, worst first. */
  idle: { key: string; kind: string; reason: string; waitedMs: number }[];
  executors: { executor: string; host: string; actions: number }[];
}

/** One reading of the live queue, for a witness sampling it across a window. */
export function sampleQueue(work: Work[], now: Date, thresholdMs = actionIdleMs): QueueSample {
  const snapshot = queueSnapshot(work, now);
  return {
    at: now.toISOString(), pending: snapshot.pending, claimed: snapshot.claimed,
    idle: idleActionable(work, now, thresholdMs).map(({ key, kind, reason, waitedMs }) => ({ key, kind, reason, waitedMs })),
    executors: snapshot.executors,
  };
}

/** Why one delivery is or is not part of the population AC-6 is stated over. */
export interface DeliveryAttribution {
  key: string; submittedAt: string; mergedAt: string; submitToMergeMs: number;
  /** Executors that settled a row on this item after it first submitted, from the queue's own history. */
  executors: string[];
  /** Hand-offs to a master or operator between submit and merge. */
  handoffs: { blocked: number; requirements: number };
  /** True when the record shows the queue moved this delivery and no master or operator did. */
  masterless: boolean;
  /** Why it is excluded, or null when it is in the population. */
  reason: string | null;
}

/** Every executor that settled a row on these items, from the action queue's own history. */
export function settlingExecutors(work: Work[], since: number | null): string[] {
  const executors = new Set<string>();
  for (const item of work) for (const executor of itemSettlements(item, since).executors) executors.add(executor);
  return [...executors].sort();
}

/**
 * What the item's own action queue records about who settled its rows, at or after `since`.
 *
 * Both the open rows and the retired ones are read: a delivered item's rows are history by the
 * time it merges, and the settlement that moved it is on the row that was retired when the
 * situation moved on. `completed` is what says the queue moved the item — a failed attempt is an
 * executor that tried — so the two are counted apart.
 */
function itemSettlements(work: Work, since: number | null) {
  const executors = new Set<string>();
  let completed = 0;
  for (const row of [...(work.actionQueue?.actions ?? []), ...(work.actionQueue?.history ?? [])]) {
    for (const entry of row.history) {
      if (!['completed', 'failed'].includes(entry.event) || !entry.executor) continue;
      if (since !== null && Date.parse(entry.at) < since) continue;
      executors.add(entry.executor);
      if (entry.event === 'completed') completed += 1;
    }
  }
  return { executors: [...executors].sort(), completed };
}

/**
 * Decide, per delivery, whether it was made with no master session running.
 *
 * The record says it two ways, and both have to hold. A hand-off is a master or an operator in
 * the path by definition — a blocked report filed after submission, a requirements revision of an
 * item under way — and `pipelineSpeed` already counts them. The other way is positive rather than
 * negative: a delivery the fleet moved carries the queue's own settlements, by named stateless
 * executors, after it submitted. A master daemon claims nothing from the queue and so settles
 * nothing in it, which is why a delivery with no settlement at all is excluded rather than
 * assumed masterless — an absence of evidence about who moved an item is not evidence that
 * nobody did.
 */
export function deliveryAttribution(work: Work, now: number): DeliveryAttribution | null {
  const speed = pipelineSpeed(work, now);
  const mergedAt = acceptedMergeAt(work);
  if (!mergedAt || speed.submitToMergeMs === null || !speed.submittedAt) return null;
  const handoffs = { blocked: speed.interventions.blocked, requirements: speed.interventions.requirements };
  const settlements = itemSettlements(work, Date.parse(speed.submittedAt));
  const handed = handoffs.blocked + handoffs.requirements;
  const reason = handed
    ? `${handed} hand-off${handed === 1 ? '' : 's'} to a master or operator between submit and merge (${handoffs.blocked} blocked report${handoffs.blocked === 1 ? '' : 's'}, ${handoffs.requirements} requirements revision${handoffs.requirements === 1 ? '' : 's'})`
    : !settlements.completed
      ? 'no action row was settled by an executor after it submitted, so the record does not show the queue moving it from submission to merge'
      : null;
  return { key: work.key, submittedAt: speed.submittedAt, mergedAt, submitToMergeMs: speed.submitToMergeMs,
    executors: settlements.executors, handoffs, masterless: reason === null, reason };
}

/** Every delivery in the window, with the attribution that says whether AC-6 is stated over it. */
export function deliveryAttributions(work: Work[], now: number, options: { since?: string | null; until?: string | null } = {}): DeliveryAttribution[] {
  const bound = (value: string | null | undefined) => { const parsed = value ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null; };
  const since = bound(options.since), until = bound(options.until);
  return work.map(item => deliveryAttribution(item, now))
    .filter((entry): entry is DeliveryAttribution => entry !== null)
    .filter(entry => { const merged = Date.parse(entry.mergedAt); return (since === null || merged >= since) && (until === null || merged < until); })
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
}

export interface ThroughputWitness {
  window: { since: string | null; until: string | null };
  /** Deliveries in the population: made with no master session running. */
  deliveries: number;
  /** Deliveries in the window that are not in the population, and why, newest last. */
  excluded: { key: string; mergedAt: string; reason: string }[];
  /** Every delivery the window holds, whatever moved it; context, never the population. */
  delivered: number;
  submitToMergeP50Ms: number; submitToMergeP90Ms: number;
  /** Submit→merge over every delivery in the window, so the two readings can be compared. */
  windowSubmitToMerge: Percentiles;
  /** Hand-offs to a master or operator between submit and merge, over every delivery in the window. */
  handoffs: { items: number; blocked: number; requirements: number };
  /** Every executor identity that settled an action row in the window, from the queue's own history. */
  executors: string[];
  samples: number;
  /** The worst unclaimed row seen in any sample, or null when none ever passed the bound. */
  worstIdle: { key: string; kind: string; reason: string; waitedMs: number; at: string } | null;
  thresholds: { minimumDeliveries: number; submitToMergeP50Ms: number; idleMs: number };
  met: boolean; reasons: string[];
}

const minutes = (ms: number) => Math.round(ms / 60_000);
/** At most this many excluded deliveries are named in the verdict; the count is always exact. */
const excludedNamedLimit = 5;

/**
 * Judge one witness run. `samples` are the queue readings taken across the window; a run with one
 * sample judges one instant and says so, which is why the script takes many.
 */
export function judgeThroughput(work: Work[], now: number, samples: QueueSample[], options: { since?: string | null; until?: string | null; minimumDeliveries?: number } = {}): ThroughputWitness {
  const since = options.since ?? null, until = options.until ?? null;
  const summary = pipelineSpeedSummary(work, now, { since, until });
  const minimumDeliveries = options.minimumDeliveries ?? speedTarget.minimumItems;
  const attributions = deliveryAttributions(work, now, { since, until });
  const population = attributions.filter(entry => entry.masterless);
  const excluded = attributions.filter(entry => !entry.masterless).map(entry => ({ key: entry.key, mergedAt: entry.mergedAt, reason: entry.reason! }));
  const measured = nearestRankPercentiles(population.map(entry => entry.submitToMergeMs));
  const worst = samples.flatMap(sample => sample.idle.map(entry => ({ ...entry, at: sample.at })))
    .sort((a, b) => b.waitedMs - a.waitedMs)[0] ?? null;
  const reasons: string[] = [];
  if (population.length < minimumDeliveries) {
    const named = excluded.slice(-excludedNamedLimit).map(entry => `${entry.key} (${entry.reason})`);
    reasons.push(`${population.length} of the ${attributions.length} deliver${attributions.length === 1 ? 'y' : 'ies'} in the window were made with no master session running; the criterion asks for at least ${minimumDeliveries}`
      + (excluded.length ? `. ${excluded.length} excluded, most recently: ${named.join('; ')}` : ''));
  }
  // The p50 is judged over the population and only there: a window without one has no p50 to
  // judge, and saying so once is clearer than saying it twice.
  else if (measured.p50Ms > speedTarget.submitToMergeP50Ms) reasons.push(`submit→merge p50 ${minutes(measured.p50Ms)} min over the ${population.length} masterless deliveries exceeds the ${minutes(speedTarget.submitToMergeP50Ms)}-minute target`);
  if (worst) reasons.push(`${worst.key} was idle but actionable for ${minutes(worst.waitedMs)} min at ${worst.at}: ${worst.reason}`);
  if (!samples.length) reasons.push('the live queue was never sampled, so nothing was measured about idle work');
  return {
    window: { since, until },
    deliveries: population.length, excluded, delivered: attributions.length,
    submitToMergeP50Ms: measured.p50Ms, submitToMergeP90Ms: measured.p90Ms,
    windowSubmitToMerge: summary.submitToMerge,
    handoffs: { items: summary.interventions.items, blocked: summary.interventions.blocked, requirements: summary.interventions.requirements },
    executors: settlingExecutors(work, since ? Date.parse(since) : null),
    samples: samples.length, worstIdle: worst,
    thresholds: { minimumDeliveries, submitToMergeP50Ms: speedTarget.submitToMergeP50Ms, idleMs: actionIdleMs },
    met: reasons.length === 0, reasons,
  };
}
