import { agentOwner, type AttentionItem } from '../master.js';
import { type Work } from '../model/work.js';
import { mergeStalls } from '../merge-queue.js';
import { observationThroughputStatus } from '../github.js';
import { leaseHealthStatus } from './lease-health-attention.js';
import { repairLaneAttention } from '../master/repair-lane.js';

/** A merge pending past five minutes on a head GitHub reports mergeable, with no refusal (GY-344). */
export const mergeStallAttention = (snapshot: { work: Work[]; now: string }): AttentionItem[] =>
  mergeStalls(snapshot.work, Date.parse(snapshot.now)).map(stall => ({ subject: stall.key, text: stall.text, ...agentOwner('master', stall.next) }));

/**
 * What waits on something no worker fixes (GY-492, GY-558, GY-566): the queue head's observation
 * lag, slow lease renewals, the repair lane and the conflict hotspots, raised beside the stalls.
 */
export function stallAttention(snapshot: { work: Work[]; now: string }, coordinator: Parameters<typeof observationThroughputStatus>[0] & Parameters<typeof leaseHealthStatus>[0], derivedStalls: readonly AttentionItem[], hotspotAttention: readonly AttentionItem[]) {
  const observation = observationThroughputStatus(coordinator, snapshot), health = leaseHealthStatus(coordinator);
  const stalledItems = [...derivedStalls, ...mergeStallAttention(snapshot), ...observation.attention, ...repairLaneAttention(snapshot.work), ...health.attention, ...hotspotAttention];
  return { observation, health, stalledItems };
}

export { observationThroughputStatus };
