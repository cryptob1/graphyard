// Concern: what master status reports of optimistic merge (GY-500) — the setting, the counters,
// and the main guard while main is red after an optimistic merge.
import type { Work } from '../model/work.js';
import { agentOwner, type AttentionItem } from './attention.js';
import { mergeBatchSize, optimisticMergeEnabled, type MasterConfig } from './profiles.js';
import { repairLaneAttention } from './repair-lane.js';
import { describeGuard, mainGuard, optimisticMetrics } from '../optimistic-merge.js';

/**
 * master status's `mergeQueue` (batch size and whether optimistic merge is on) and
 * `optimisticMerge`: how many entries landed past the queue, how many the guard reverted, where
 * main stands, and time-to-merge for optimistic versus queued entries.
 */
export function optimisticStatus(master: Pick<MasterConfig, 'mergeQueue'>, work: Work[], batchSize = mergeBatchSize(master)) {
  const optimistic = optimisticMergeEnabled(master);
  return { mergeQueue: { batchSize, optimistic }, optimisticMerge: optimisticMetrics(work, optimistic) };
}

/**
 * The main guard while main is red after an optimistic merge: the control plane's own work while
 * it bisects or reverts, the master's once a revert was refused — a later merge changed the
 * culprit's files, so a fix item must repair main instead.
 */
export function optimisticGuardAttention(work: Work[]): AttentionItem[] {
  const guard = mainGuard(work);
  if (guard.state === 'green' || guard.state === 'pending') return [];
  const subject = 'culprit' in guard ? guard.culprit.key : guard.probe.key;
  const text = `Main guard: ${describeGuard(guard)}`;
  if (guard.state === 'refused') return [{ subject, text, ...agentOwner('master', `graphyard master create FILE REASON files the fix for ${guard.culprit.key}'s merge ${guard.culprit.mergeSha.slice(0, 12)} (${guard.culprit.failing.join(', ') || 'required checks failed'}); optimistic merges resume once main passes the required suite`) }];
  return [{ subject, text, ...agentOwner('control plane', guard.state === 'await' ? `Nothing to run: the guard reads the required suite on ${guard.probe.mergeSha.slice(0, 12)} and names the culprit`
    : `Nothing to run: the guard reverts ${guard.culprit.key} through the repair lane and reopens it for a rework round`) }];
}

/** Control-plane merges that stay in front of the master until proven: repair-lane merges (GY-406) and a main red after optimistic merges. */
export const landingAttention = (work: Work[]): AttentionItem[] => [...repairLaneAttention(work), ...optimisticGuardAttention(work)];
