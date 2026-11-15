import type { Work } from '../src/model';

/** The trust strip's window (GY-3395): the last seven days. */
export const trustWindowMs = 7 * 24 * 60 * 60 * 1000;

/** The three kinds of items behind the strip's numbers, as the Shipped page filters them. */
export type TrustKind = 'verified-by-running' | 'sent-back' | 'reverts';

/** When a delivery merged: its delivery record's merge, else its observed merge; NaN with neither. */
const deliveredAt = (work: Pick<Work, 'delivery' | 'observation'>) =>
  Date.parse((work.delivery?.mergedAt ?? work.observation?.mergedAt ?? '') as string);

/**
 * The trust strip (GY-3395): the header's three numbers for the last seven days, each computed
 * from records Graphyard already keeps on the same snapshot every page shows, so a number can
 * never disagree with the item it counts. Throughput comes from trust, so the header shows
 * whether shipped work is proven and holding up, not how many agents are busy:
 *
 * - verified by running — the share of delivered items whose proofs ran the real app: trusted,
 *   passing `e2e:` evidence that executed cases;
 * - sent back — the share of delivered items that went back to a worker before they landed, for
 *   taste, a change request or a failed proof, as the item's last rework records;
 * - reverts — the items the batch gate took back out of main this week, as each reverted item's
 *   own merge ledger records (`merge.serve-revert`).
 */
export function trustCounts(work: readonly Work[], now: number) {
  const delivered = work.filter(item => item.stage === 'done' && !item.closure && now - deliveredAt(item) <= trustWindowMs);
  const verifiedByRunning = delivered.filter(item => (item.evidence ?? []).some(record =>
    record.proof.startsWith('e2e:') && record.trusted && record.result === 'pass' && record.executed > 0));
  const sentBack = delivered.filter(item => !!item.lastRework);
  const reverts = work.filter(item => (item.mergeLedger?.serveReverts ?? []).some(revert =>
    revert.outcome === 'reverted' && now - Date.parse(revert.at) <= trustWindowMs));
  return { delivered, verifiedByRunning, sentBack, reverts };
}
