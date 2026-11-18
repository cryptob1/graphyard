import type { Work } from '../src/model';
import { workersView } from './workers-view';
import { shippedCounts } from './groups';

/**
 * The city-at-night strip (GY-3272): the counts the top bar reads off the same snapshot every
 * page shows. Each one is the derivation its home page or the control plane already reads —
 * open agent sessions the way the Workers page counts them, merge trials the way the ledger
 * records them, shipped and waiting to go live the way the Work page counts them — so the strip can never
 * disagree with the numbers beside it.
 */
export function cityCounts(work: Work[], observedAt: number, live?: { commit?: unknown; waiting?: unknown } | null) {
  const now = new Date(Number.isNaN(observedAt) ? Date.now() : observedAt);
  const view = workersView(work, now);
  // On shift: sessions the Workers page would count open — running, and seen recently enough.
  const onShift = view.running.filter(row => !row.stale).length;
  // In trial: items whose merge trial is out on the trial branch right now.
  const inTrial = work.filter(item => item.mergeLedger?.state === 'pushed').length;
  // Shipped and waiting to go live (GY-3452): the Work page card's one count.
  const { shipped, waiting } = shippedCounts(work, live, now.getTime());
  return { onShift, inTrial, shipped: shipped.length, waiting: waiting.length };
}
