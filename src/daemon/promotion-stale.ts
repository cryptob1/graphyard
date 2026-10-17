// Concern: master status's stale promotion tip — the loop's promotion ledger crossed with the release-lag read (GY-1894).
import type { AttentionItem } from '../master/attention.js';
import { promotionReadWindows, promotionStatus, promotionUpToDateReason, promotionWorkflow } from './deployment.js';
import type { PromotionState } from './state.js';

/** What master status crossed the promotion ledger with: the release-lag read of the base tip. */
export type PromotionObserved = { tip: string | null; awaiting?: readonly string[]; now?: number; intervalMs?: number };

/**
 * GY-1894: the master status promotion summary crossed with the release-lag read. `tip` is the base
 * tip the lag report read, `awaiting` the deliveries awaiting promotion on it, `now` the reading's
 * time, `intervalMs` the loop's interval: the ledger is reused for the window `promotionReadWindows`
 * grants, so the attention fires only once that window has passed — never while the drive reads on
 * schedule. Past it, a ledger naming a tip the base ref moved past while deliveries wait is the stuck
 * drive: the attention names both SHAs and the waiting deliveries; an up-to-date reason gives way.
 */
function stalePromotionTip(state: PromotionState, observed: PromotionObserved | null | undefined) {
  const awaiting = observed?.awaiting ?? [], tip = observed?.tip ?? null, now = observed?.now ?? Date.now(), ledgerMs = promotionReadWindows(observed?.intervalMs ?? 0).ledgerMs;
  if (!tip || !state.mainSha || !awaiting.length || tip.startsWith(state.mainSha) || state.mainSha.startsWith(tip) || (state.ledgerReadAt && now - Date.parse(state.ledgerReadAt) < ledgerMs)) return null;
  const short = (sha: string) => sha.slice(0, 12), waiting = `${awaiting.join(', ')} await promotion on the base tip ${short(tip)} the checkout reads now`;
  const attention: AttentionItem = { subject: 'promotion', role: 'master', approvedBy: null, human: false, humanOnly: null,
    text: `The loop's promotion ledger, last read ${state.ledgerReadAt ?? 'never'}, still names ${short(state.mainSha)} the base branch tip and ${short(state.promotedSha ?? state.mainSha)} production, while ${waiting}: the drive is past its ${Math.round(ledgerMs / 60_000)}-minute read window without seeing the move, so no candidate is cut for it`,
    next: `Read the promotion line in master status; a cycling loop re-reads the tip and cuts within one window, else restart it (systemctl --user restart graphyard-master) or dispatch ${promotionWorkflow} with promote=true by hand` };
  return { attention, reason: state.reason?.startsWith(promotionUpToDateReason) ? `The ledger last read ${short(state.mainSha)} as the base tip; past its read window the checkout names ${short(tip)}, where ${waiting}` : state.reason };
}

/** `promotionStatus` crossed with the lag read: the stale-tip reason and attention, null when the ledger is current or unobserved. */
export function observedPromotionStatus(state: PromotionState | null | undefined, observed?: PromotionObserved | null) {
  const summary = promotionStatus(state);
  const stale = state ? stalePromotionTip(state, observed) : null;
  return { ...summary, reason: stale?.reason ?? summary.reason, attention: stale?.attention ?? null };
}

export function promotionSummaryWithLag(state: PromotionState | null | undefined, lag: { baseTip: string | null; promotion?: { pending: string[] } | null }, attention: AttentionItem[], now: number, intervalMs?: number) {
  const summary = observedPromotionStatus(state, { tip: lag.baseTip, awaiting: lag.promotion?.pending, now, intervalMs });
  if (summary.attention) attention.push(summary.attention);
  return summary;
}
