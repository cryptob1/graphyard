// The actionable shared-base refusals, read from the same ledger after a loop restart.
import { createHash } from 'node:crypto';
import type { Work } from '../model.js';
import { parseBaseFailureReason } from '../merge-writer/executor.js';

export const stalledDeliveryAction = 'Diagnose the shared base failure, file or advance its repair, and resume delivery with every test and merge requirement intact. Act as the operator-agent; no human review or approval is needed.';

export function stalledDelivery(work: readonly Work[]) {
  const reasons = new Map<string, Set<string>>();
  for (const item of work) {
    const ledger = item.mergeLedger;
    if (item.stage === 'done' || item.reworkRequested || !item.candidate || ledger?.head !== item.candidate.sha || ledger.state !== 'refused' || ledger.refusal?.kind !== 'merge') continue;
    const failure = parseBaseFailureReason(ledger.refusal.reason);
    if (!failure) continue;
    const key = `base:${failure.tip}`;
    if (!reasons.has(key)) reasons.set(key, new Set());
    reasons.get(key)!.add(ledger.refusal.reason);
  }
  return [...reasons].sort(([a], [b]) => a.localeCompare(b)).map(([key, reasons]) => {
    const detail = [...reasons].sort().join('\n');
    return { key, detail, digest: createHash('sha1').update(detail).digest('hex') };
  });
}

export const stalledDeliveryPrompt = (causes: ReturnType<typeof stalledDelivery>) =>
  `Delivery is stalled on shared base validation:\n${causes.map(cause => cause.detail).join('\n')}\nNext agent action: ${stalledDeliveryAction}`;
