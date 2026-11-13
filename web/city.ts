import type { Work } from '../src/model';
import { workersView } from './workers-view';
import { shippedToday } from './fun';

/**
 * The city-at-night strip (GY-3272): the counts the top bar reads off the same snapshot every
 * page shows. Each one is the derivation its home page or the control plane already reads —
 * open agent sessions the way the Workers page counts them, merge trials the way the ledger
 * records them, today's ships the way the Work page counts them — so the strip can never
 * disagree with the numbers beside it.
 */
export function cityCounts(work: Work[], observedAt: number) {
  const now = new Date(Number.isNaN(observedAt) ? Date.now() : observedAt);
  const view = workersView(work, now);
  // On shift: sessions the Workers page would count open — running, and seen recently enough.
  const onShift = view.running.filter(row => !row.stale).length;
  // In trial: items whose merge trial is out on the trial branch right now.
  const inTrial = work.filter(item => item.mergeLedger?.state === 'pushed').length;
  const shippedTonight = shippedToday(work, now.getTime()).count;
  return { onShift, inTrial, shippedTonight };
}
