export const UNKNOWN_DURATION = '—';

// Adaptive dashboard duration formatting. Inputs are minutes; fractional
// values are truncated to whole minutes before decomposition. Below 60
// minutes renders Xm; 60 minutes through under 48 hours renders Xh Ym;
// 48 hours and above renders Xd Yh. Zero components are omitted.
// Invalid or non-finite input renders the unknown marker; negative input
// clamps to 0m, so no negative or NaN text can ever be emitted.
export function formatDuration(minutes: number | null | undefined): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return UNKNOWN_DURATION;
  const total = Math.max(0, Math.floor(minutes));
  const days = Math.floor(total / 1440);
  const dayHours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (total >= 2880) return dayHours > 0 ? `${days}d ${dayHours}h` : `${days}d`;
  if (total >= 60) {
    const hours = Math.floor(total / 60);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${mins}m`;
}

export function durationMinutes(startedAt: string | number, now: number): number | null {
  const start = typeof startedAt === 'number' ? startedAt : Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, (now - start) / 60000);
}

export function formatAge(startedAt: string | number, now: number): string {
  return formatDuration(durationMinutes(startedAt, now));
}

/**
 * How long an item may hold one status before the board calls it overdue: the operator's
 * threshold (GY-108), and the only place it is written. Every view reads its verdict from
 * `statusDuration`, so no card, column or drawer carries a number of its own.
 *
 * Thirty minutes sits between the loop's own budgets — the five-minute idle-but-actionable
 * bound and the thirty-minute p50 submit-to-merge target this repository measures itself
 * against — so an item over it has stopped moving by the pipeline's own standard.
 */
export const OVERDUE_MINUTES = 30;

/** How long an item has held its status, and whether that is too long. */
export interface StatusDuration {
  /** Whole minutes held — the number `text` renders; null when the instant cannot be read. */
  minutes: number | null;
  /** The duration as the board writes it: `45m`, `2h 5m`, `3d 2h`, or the unknown marker. */
  text: string;
  /** Held longer than the threshold. A settled status is never overdue: it is not waiting. */
  overdue: boolean;
  /** The whole thing in words, for the tooltip and for a reader that wants the sentence. */
  label: string;
}

/**
 * The duration a card shows for the status it names, judged against the one threshold.
 *
 * The verdict is taken on the same whole minutes the text renders, so the number a reader sees
 * is the number that was judged: 30m is not overdue, 31m is, and nothing turns red while still
 * reading `30m`. `settled` marks a status nothing is waiting on — delivered work — which shows
 * its duration but never turns red, because the item has arrived rather than stopped.
 */
export function statusDuration(enteredAt: string | number, now: number, settled = false): StatusDuration {
  const elapsed = durationMinutes(enteredAt, now);
  const minutes = elapsed === null ? null : Math.floor(elapsed);
  const text = formatDuration(minutes);
  const overdue = !settled && minutes !== null && minutes > OVERDUE_MINUTES;
  const label = minutes === null ? 'How long it has held this status is not recorded'
    : overdue ? `In this status for ${text} — longer than the ${formatDuration(OVERDUE_MINUTES)} an item may hold one status before it counts as stopped`
    : `In this status for ${text}`;
  return { minutes, text, overdue, label };
}
