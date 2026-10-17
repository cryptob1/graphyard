// Concern: master status's stale promotion tip — the loop's promotion ledger crossed with the release-lag read (GY-1894).
import type { AttentionItem } from '../master/attention.js';
import { promotionBaseTipClaim, promotionOffReason, promotionReadWindows, promotionStatus, promotionWorkflow } from './deployment.js';
import type { PromotionState } from './state.js';

/** What master status crossed the promotion ledger with: the release-lag read of the base tip. */
export type PromotionObserved = { tip: string | null; awaiting?: readonly string[]; now?: number; intervalMs?: number };

/**
 * GY-1894: the master status promotion summary crossed with the release-lag read. `tip` is the base
 * tip the lag report read, `awaiting` the deliveries awaiting promotion on it, `now` the reading's
 * time, `intervalMs` the loop's interval. An observed mismatch with deliveries waiting always
 * corrects an up-to-date reason and raises attention naming both SHAs — a read-window allowance
 * never preserves a known false claim. Past the window `promotionReadWindows` grants, the attention
 * is the stuck drive (restart / manual dispatch); inside it, the tips are named without blaming a
 * drive that is still reading on schedule. Intentionally disabled promotion (`promotionOffReason`)
 * keeps a truthful tip summary with no stuck-drive diagnosis: the cycle retains its ledger on purpose.
 */
function stalePromotionTip(state: PromotionState, observed: PromotionObserved | null | undefined) {
  const awaiting = observed?.awaiting ?? [], tip = observed?.tip ?? null, now = observed?.now ?? Date.now(), ledgerMs = promotionReadWindows(observed?.intervalMs ?? 0).ledgerMs;
  if (!tip || !state.mainSha || !awaiting.length || tip.startsWith(state.mainSha) || state.mainSha.startsWith(tip)) return null;
  const short = (sha: string) => sha.slice(0, 12), waiting = `${awaiting.join(', ')} await promotion on the base tip ${short(tip)} the checkout reads now`;
  const tipReason = `The ledger last read ${short(state.mainSha)} as the base tip; the checkout names ${short(tip)}, where ${waiting}`;
  // Loop promotion off retains its ledger by design: name both tips neutrally, never a stuck-drive alert.
  if (state.reason === promotionOffReason) return {
    reason: `${promotionOffReason}; ${tipReason.charAt(0).toLowerCase()}${tipReason.slice(1)}`,
    attention: { subject: 'promotion', role: 'master', approvedBy: null, human: false, humanOnly: null,
      text: `Loop promotion is off; its ledger last read ${short(state.mainSha)} as the base tip and ${short(state.promotedSha ?? state.mainSha)} production, while ${waiting}`,
      next: `Promotion is intentionally off, so no candidate is cut for these deliveries until it is turned back on; no restart is needed` } satisfies AttentionItem,
  };
  const reason = state.reason?.startsWith(promotionBaseTipClaim) ? tipReason : state.reason;
  const pastWindow = !state.ledgerReadAt || now - Date.parse(state.ledgerReadAt) >= ledgerMs;
  const attention: AttentionItem = pastWindow
    ? { subject: 'promotion', role: 'master', approvedBy: null, human: false, humanOnly: null,
      text: `The loop's promotion ledger, last read ${state.ledgerReadAt ?? 'never'}, still names ${short(state.mainSha)} the base branch tip and ${short(state.promotedSha ?? state.mainSha)} production, while ${waiting}: the drive is past its ${Math.round(ledgerMs / 60_000)}-minute read window without seeing the move, so no candidate is cut for it`,
      next: `Read the promotion line in master status; a cycling loop re-reads the tip and cuts within one window, else restart it (systemctl --user restart graphyard-master) or dispatch ${promotionWorkflow} with promote=true by hand` }
    : { subject: 'promotion', role: 'master', approvedBy: null, human: false, humanOnly: null,
      text: `The loop's promotion ledger last read ${short(state.mainSha)} as the base tip and ${short(state.promotedSha ?? state.mainSha)} production, while ${waiting}`,
      next: `A cycling loop re-reads the tip inside its ledger window and cuts a candidate; no restart is needed while the drive is on schedule` };
  return { attention, reason };
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
