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
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (total >= 60) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
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
