import type { ObservationWindow, Work } from './work.js';

// The earliest instant a post-deploy follow-up's reading can exist (GY-1698, GY-1727), computed from
// the delivered item alone so both the filer (master-verification.ts) and the control plane, which
// derives it for a follow-up a stale filer left without one (GY-1735), read it the same way.

const hour = 3_600_000, day = 24 * hour;
/**
 * The rolling window a criterion's reading needs, in days, or null when it names none: a rate
 * "per 7 days", a hold "for 14 consecutive days" or "in any rolling 7-day window". The longest named
 * is the reading's: a hold of 14 consecutive days over 7-day windows cannot be read before 14 have run.
 */
export function criterionWindowDays(text: string): number | null {
  const days = [...text.matchAll(/\b(?:per|every|in|within|over|across)\s+(\d{1,3})\s+days?\b|\b(\d{1,3})\s+consecutive\s+days?\b|\b(\d{1,3})[-\s]day\b/gi)]
    .map(match => Number(match[1] ?? match[2] ?? match[3])).filter(value => value > 0);
  return days.length ? Math.max(...days) : null;
}
/**
 * The live window a criterion's reading needs, in hours, or null when it names none: "a 24-hour
 * window of live activity", "during 24h of live activity". Unlike a day window, counted from the
 * merge, an hour window is live activity on the serving release (GY-1727).
 */
export function criterionWindowHours(text: string): number | null {
  const hours = [...text.matchAll(/\b(\d{1,3})[-\s]?(?:hours?|hrs?)\b|\b(\d{1,3})h\b/gi)].map(match => Number(match[1] ?? match[2])).filter(value => value > 0);
  return hours.length ? Math.max(...hours) : null;
}
/**
 * GY-1698 AC-1: the earliest instant the follow-up's reading can exist, or undefined for a follow-up
 * whose criterion names no window: the delivered item's merge plus the day window it names, and
 * (GY-1727) the instant the serving release was first observed, `servedAt`, plus the hour window it
 * names — the later of the two where both exist.
 */
export function observationWindowFor(work: Pick<Work, 'key' | 'delivery'>, criterion: { id: string; text: string }, servedAt?: number): ObservationWindow | undefined {
  const windowDays = criterionWindowDays(criterion.text), windowHours = criterionWindowHours(criterion.text), mergedAt = work.delivery ? Date.parse(work.delivery.mergedAt) : NaN;
  const iso = (ms: number) => new Date(ms).toISOString();
  const fromDays = windowDays !== null && Number.isFinite(mergedAt) ? mergedAt + windowDays * day : null;
  // A live window runs on the serving release: from when it was first observed serving, or the merge where no observation is known.
  const live = servedAt !== undefined && Number.isFinite(servedAt) ? servedAt : Number.isFinite(mergedAt) ? mergedAt : null;
  const fromHours = windowHours !== null && live !== null ? live + windowHours * hour : null;
  const fromMerge = fromDays !== null && (fromHours === null || fromDays >= fromHours) ? fromDays : fromHours;
  if (fromMerge === null) return undefined;
  const origin = fromMerge === fromDays
    ? `${work.key} merged at ${iso(mergedAt)} and ${criterion.id} names a ${windowDays}-day window`
    : `${work.key}'s serving release was first observed at ${iso(live!)} and ${criterion.id} names a ${windowHours}-hour live window`;
  return { notBefore: iso(fromMerge), basis: 'criterion-window', detail: `${origin}, so the reading can first exist at ${iso(fromMerge)}`.slice(0, 2000) };
}
export const postDeployMarker = 'Post-deploy follow-up: ';
export const followUpOf = (item: Pick<Work, 'description'>) => item.description?.startsWith(postDeployMarker) ? item.description.slice(postDeployMarker.length).split('\n', 1)[0] : null;
/** A follow-up's request id read back into what it was filed for, or null for any other item. */
export function followUpRequest(item: Pick<Work, 'description'>): { work: string; criterion: string; proof: string; release: string } | null {
  const match = /^post-deploy:([0-9a-f-]{36}):([^:]+):(.+):([0-9a-f]{40})$/.exec(followUpOf(item) ?? '');
  return match ? { work: match[1], criterion: match[2], proof: match[3], release: match[4] } : null;
}
/**
 * GY-1735: the window the follow-up's filing owed it, derived from the delivered item its request id
 * names — the criterion's own bound and the live window served from the deployment recorded at that
 * release (else the filing), as the filer reads it — or undefined for any other item or a criterion naming no window. A
 * filer older than GY-1698 or GY-1727 filed GY-1722 and GY-1725 without one, so each was dispatched
 * before its reading could exist and its worker could only escalate; the control plane now holds it itself.
 */
export function filedFollowUpWindow(item: Pick<Work, 'description' | 'createdAt'>, all: readonly Pick<Work, 'id' | 'key' | 'delivery' | 'criteria'>[]): ObservationWindow | undefined {
  const request = followUpRequest(item), delivered = request && all.find(work => work.id === request.work);
  const criterion = delivered?.criteria.find(entry => entry.id === request!.criterion);
  if (!delivered?.delivery || !criterion) return undefined;
  const deployment = delivered.delivery.deployment, recorded = deployment?.sha === request!.release ? Date.parse(deployment.observedAt) : NaN;
  const served = Math.min(...[recorded, Date.parse(item.createdAt)].filter(Number.isFinite));
  return observationWindowFor(delivered, criterion, Number.isFinite(served) ? served : undefined);
}
