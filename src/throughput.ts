import { actionIdleMs, idleActionable, queueSnapshot } from './model/actions.js';
import { pipelineSpeedSummary, speedTarget } from './pipeline-speed.js';
import type { Work } from './model.js';

/**
 * Throughput without a master session (AC-6), measured rather than asserted.
 *
 * The claim the inversion makes is about real deliveries: with the control plane naming each
 * item's next action and stateless executors running the rows, throughput follows the number of
 * executors and agents rather than how much attention an operator is paying. That cannot be
 * established by a fixture — a fleet of stubs that finishes in milliseconds passes a 30-minute
 * target no matter what the loop does — so this judges the live ledger instead:
 *
 * - **Real deliveries.** `pipelineSpeedSummary` over the items actually merged in the window,
 *   with the submit→merge p50 the repository really recorded.
 * - **Nothing idle but actionable.** Every sample of the live queue, taken across the window,
 *   with the worst unclaimed row in any of them. A row that has waited longer than the bound is
 *   an item with something to do and nobody doing it, which is exactly the failure a master
 *   session used to paper over by hand.
 * - **No master in the path.** The hand-offs `pipelineSpeedSummary` counts (a blocked report
 *   filed after submission, a requirements revision of an item under way) and the executor
 *   identities that actually settled the action rows. A master daemon settles none: it does not
 *   claim from the queue, so a window whose rows were all settled by named executors had no
 *   master moving work through it.
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

export interface ThroughputWitness {
  window: { since: string | null; until: string | null };
  deliveries: number; routine: number;
  submitToMergeP50Ms: number; submitToMergeP90Ms: number;
  /** Hand-offs to a master or operator between submit and merge, over the measured deliveries. */
  handoffs: { items: number; blocked: number; requirements: number };
  /** Every executor identity that settled an action row in the window, from the queue's own history. */
  executors: string[];
  samples: number;
  /** The worst unclaimed row seen in any sample, or null when none ever passed the bound. */
  worstIdle: { key: string; kind: string; reason: string; waitedMs: number; at: string } | null;
  thresholds: { minimumDeliveries: number; submitToMergeP50Ms: number; idleMs: number };
  met: boolean; reasons: string[];
}

/** Every executor that settled a row on these items, from the action queue's own history. */
export function settlingExecutors(work: Work[], since: number | null): string[] {
  const executors = new Set<string>();
  for (const item of work) {
    const rows = [...(item.actionQueue?.actions ?? []), ...(item.actionQueue?.history ?? [])];
    for (const row of rows) for (const entry of row.history) {
      if (!['completed', 'failed'].includes(entry.event) || !entry.executor) continue;
      if (since !== null && Date.parse(entry.at) < since) continue;
      executors.add(entry.executor);
    }
  }
  return [...executors].sort();
}

/**
 * Judge one witness run. `samples` are the queue readings taken across the window; a run with one
 * sample judges one instant and says so, which is why the script takes many.
 */
export function judgeThroughput(work: Work[], now: number, samples: QueueSample[], options: { since?: string | null; until?: string | null; minimumDeliveries?: number } = {}): ThroughputWitness {
  const since = options.since ?? null, until = options.until ?? null;
  const summary = pipelineSpeedSummary(work, now, { since, until });
  const minimumDeliveries = options.minimumDeliveries ?? speedTarget.minimumItems;
  const worst = samples.flatMap(sample => sample.idle.map(entry => ({ ...entry, at: sample.at })))
    .sort((a, b) => b.waitedMs - a.waitedMs)[0] ?? null;
  const reasons: string[] = [];
  if (summary.measured < minimumDeliveries) reasons.push(`${summary.measured} deliveries measured in the window; the criterion asks for at least ${minimumDeliveries}`);
  if (summary.submitToMerge.p50Ms > speedTarget.submitToMergeP50Ms) reasons.push(`submit→merge p50 ${Math.round(summary.submitToMerge.p50Ms / 60_000)} min exceeds the ${speedTarget.submitToMergeP50Ms / 60_000}-minute target`);
  if (worst) reasons.push(`${worst.key} was idle but actionable for ${Math.round(worst.waitedMs / 60_000)} min at ${worst.at}: ${worst.reason}`);
  if (summary.interventions.items > 0) reasons.push(`${summary.interventions.items} delivery(ies) needed a hand-off to a master or operator between submit and merge`);
  if (!samples.length) reasons.push('the live queue was never sampled, so nothing was measured about idle work');
  return {
    window: { since, until },
    deliveries: summary.measured, routine: summary.routine.count,
    submitToMergeP50Ms: summary.submitToMerge.p50Ms, submitToMergeP90Ms: summary.submitToMerge.p90Ms,
    handoffs: { items: summary.interventions.items, blocked: summary.interventions.blocked, requirements: summary.interventions.requirements },
    executors: settlingExecutors(work, since ? Date.parse(since) : null),
    samples: samples.length, worstIdle: worst,
    thresholds: { minimumDeliveries, submitToMergeP50Ms: speedTarget.submitToMergeP50Ms, idleMs: actionIdleMs },
    met: reasons.length === 0, reasons,
  };
}
