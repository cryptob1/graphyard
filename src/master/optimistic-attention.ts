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

/** How long a hold may stand before master status reports it as held (GY-1221). */
export const heldGuardAttentionMs = 30 * 60_000;
const duration = (ms: number) => { const minutes = Math.floor(ms / 60_000); return minutes < 120 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`; };

/**
 * The main guard while main is red after an optimistic merge: the control plane's own work while
 * it bisects or reverts, the master's once a revert was refused — a later merge changed the
 * culprit's files, so a fix item must repair main instead. A guard held in `reverting` or
 * `refused` longer than `heldGuardAttentionMs` is reported as held: the culprit, the revert pull
 * request, how long optimistic merging has been off, and how many candidates entered the serial
 * queue meanwhile — every one of them refused the optimistic lane while main stood red.
 */
export function optimisticGuardAttention(work: Work[], now = new Date()): AttentionItem[] {
  const guard = mainGuard(work);
  if (guard.state === 'green' || guard.state === 'pending') return [];
  const subject = 'culprit' in guard ? guard.culprit.key : guard.probe.key;
  const fix = (culprit: { key: string; mergeSha: string; failing: string[] }) => `graphyard master create FILE REASON files the fix for ${culprit.key}'s merge ${culprit.mergeSha.slice(0, 12)} (${culprit.failing.join(', ') || 'required checks failed'}); optimistic merges resume once main passes the required suite`;
  if (guard.state === 'reverting' || guard.state === 'refused') {
    const since = Date.parse(guard.revert.at), heldMs = now.getTime() - since;
    if (heldMs > heldGuardAttentionMs) {
      const refused = work.filter(item => item.id !== guard.culprit.id && (item.queueHistory ?? []).some(entry => entry.event === 'enqueued' && Date.parse(entry.at) >= since)).length;
      return [{ subject, text: `Main guard held ${guard.state} for ${duration(heldMs)}: culprit ${guard.culprit.key}'s merge ${guard.culprit.mergeSha.slice(0, 12)}, revert ${guard.revert.pr ? `PR #${guard.revert.pr}` : 'not opened'}; optimistic merging has been off for ${duration(heldMs)} and refused ${refused} candidate${refused === 1 ? '' : 's'} meanwhile (${describeGuard(guard)})`,
        ...agentOwner('master', fix(guard.culprit)) }];
    }
  }
  const text = `Main guard: ${describeGuard(guard)}`;
  if (guard.state === 'refused') return [{ subject, text, ...agentOwner('master', fix(guard.culprit)) }];
  return [{ subject, text, ...agentOwner('control plane', guard.state === 'await' ? `Nothing to run: the guard reads the required suite on ${guard.probe.mergeSha.slice(0, 12)} and names the culprit`
    : `Nothing to run: the guard reverts ${guard.culprit.key} through the repair lane and reopens it for a rework round`) }];
}

/** Control-plane merges that stay in front of the master until proven: repair-lane merges (GY-406) and a main red after optimistic merges. */
export const landingAttention = (work: Work[]): AttentionItem[] => [...repairLaneAttention(work), ...optimisticGuardAttention(work)];
