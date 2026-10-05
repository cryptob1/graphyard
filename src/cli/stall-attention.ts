import { type AttentionItem } from '../master.js';
import { type Work } from '../model/work.js';
import { mergeStallAttention } from './status-attention.js';
import { observationThroughputStatus } from '../github.js';
import { leaseHealthStatus } from './lease-health-attention.js';

/**
 * What waits on something no worker fixes (GY-344, GY-492, GY-558, GY-566): a mergeable pending
 * merge, the queue head's observation lag, slow lease renewals and the conflict hotspots, raised
 * beside the stalls.
 */
export function stallAttention(snapshot: { work: Work[]; now: string }, coordinator: Parameters<typeof observationThroughputStatus>[0] & Parameters<typeof leaseHealthStatus>[0], derivedStalls: readonly AttentionItem[], hotspotAttention: readonly AttentionItem[]) {
  const observation = observationThroughputStatus(coordinator, snapshot), health = leaseHealthStatus(coordinator);
  const stalledItems = [...derivedStalls, ...mergeStallAttention(snapshot), ...observation.attention, ...health.attention, ...hotspotAttention];
  return { observation, health, stalledItems };
}

export { observationThroughputStatus };
