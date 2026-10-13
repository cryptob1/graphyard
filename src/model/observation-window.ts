import { stages, type ObservationWindow, type Stage, type Work } from './work.js';
import { postDeployProofPrefix } from './post-merge-proofs.js';
import { interventionKinds, type InterventionKind, type UnderThreshold } from './interventions.js';

// The earliest instant a post-deploy follow-up's reading can exist (GY-1698, GY-1727), computed from
// the delivered item alone so both the filer (master-verification.ts) and the control plane, which
// derives it for a follow-up a stale filer left without one (GY-1735), read it the same way.

/** The intervention report's reading for one kind-at-stage pair, as `patterns[].underThreshold` carries it; null when the report holds no row for it. */
export type PatternProjection = Pick<UnderThreshold, 'since' | 'projected'>;
export type PatternReader = (pattern: { kind: InterventionKind; stage: Stage | 'none' }) => Promise<PatternProjection | null>;
/** The projections `postDeployChecks` reads, keyed by the declared proof; a proof with no entry, or a null one, has no report reading. */
export type PatternProjections = Readonly<Record<string, PatternProjection | null>>;
const hour = 3_600_000, day = 24 * hour;
/**
 * The kind-at-stage pair a declared `manual:post-deploy/intervention-pattern-KIND-STAGE` proof names
 * (interventions/patterns.ts files it so), or null for any other proof: the kinds carry hyphens
 * themselves, so each is tried whole against the name rather than split on one.
 */
export function patternOfProof(proof: string): { kind: InterventionKind; stage: Stage | 'none' } | null {
  if (!proof.startsWith(`${postDeployProofPrefix}intervention-pattern-`)) return null;
  const name = proof.slice(postDeployProofPrefix.length + 'intervention-pattern-'.length);
  for (const kind of interventionKinds) {
    if (!name.startsWith(`${kind}-`)) continue;
    const stage = name.slice(kind.length + 1);
    if (stage === 'none' || (stages as readonly string[]).includes(stage)) return { kind, stage: stage as Stage | 'none' };
  }
  return null;
}
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
 * The consecutive-day hold a criterion names, or null when it names none: "for 14 consecutive days".
 * Distinct from a rate window ("per 7 days"): `underThreshold.projected` is the streak's start, so a
 * hold's reading cannot exist until this many days after that start (GY-1698 AC-1).
 */
export function criterionHoldDays(text: string): number | null {
  const days = [...text.matchAll(/\b(\d{1,3})\s+consecutive\s+days?\b/gi)].map(match => Number(match[1])).filter(value => value > 0);
  return days.length ? Math.max(...days) : null;
}
/**
 * The live window a criterion's reading needs, in hours, or null when it names none: "a 24-hour
 * window of live activity", "during 24h of live activity". Unlike a day window, which the intervention
 * ledger counts from the merge, an hour window is live activity on the serving release (GY-1727).
 */
export function criterionWindowHours(text: string): number | null {
  const hours = [...text.matchAll(/\b(\d{1,3})[-\s]?(?:hours?|hrs?)\b|\b(\d{1,3})h\b/gi)].map(match => Number(match[1] ?? match[2])).filter(value => value > 0);
  return hours.length ? Math.max(...hours) : null;
}
/**
 * GY-1698 AC-1: the earliest instant the follow-up's reading can exist, or undefined for a follow-up
 * whose criterion names no window and whose proof the report holds no row for. From the report's
 * reading for the pattern: `since` plus the criterion's window where the streak has begun, else the
 * instant the report projects the streak to begin plus any consecutive-day hold the criterion names
 * (`projected` is that start, not the hold's end); and never before the criterion's own bound — the
 * delivered item's merge plus the day window it names, and (GY-1727) the instant the serving release
 * was first observed, `servedAt`, plus the hour window it names — the later of all where several exist.
 */
export function observationWindowFor(work: Pick<Work, 'key' | 'delivery'>, criterion: { id: string; text: string }, proof: string, projection: PatternProjection | null | undefined, servedAt?: number): ObservationWindow | undefined {
  const windowDays = criterionWindowDays(criterion.text), holdDays = criterionHoldDays(criterion.text), windowHours = criterionWindowHours(criterion.text), mergedAt = work.delivery ? Date.parse(work.delivery.mergedAt) : NaN;
  const iso = (ms: number) => new Date(ms).toISOString();
  const fromDays = windowDays !== null && Number.isFinite(mergedAt) ? mergedAt + windowDays * day : null;
  // A live window runs on the serving release: from when it was first observed serving, or the merge where no observation is known.
  const live = servedAt !== undefined && Number.isFinite(servedAt) ? servedAt : Number.isFinite(mergedAt) ? mergedAt : null;
  const fromHours = windowHours !== null && live !== null ? live + windowHours * hour : null;
  const fromMerge = fromDays !== null && (fromHours === null || fromDays >= fromHours) ? fromDays : fromHours;
  const pattern = patternOfProof(proof);
  const since = projection?.since ? Date.parse(projection.since) : null, projected = projection?.projected ? Date.parse(projection.projected) : null;
  // `projected` is the streak's start (UnderThreshold); a consecutive-day hold is satisfied only that many days later.
  const fromReport = since !== null ? since + (windowDays ?? 0) * day : projected !== null ? projected + (holdDays ?? 0) * day : null;
  const reading = pattern ? `the ${pattern.kind} reading at ${pattern.stage === 'none' ? 'no stage' : `the ${pattern.stage} stage`}` : `the reading ${proof} names`;
  const window = windowDays !== null ? `${criterion.id} names a ${windowDays}-day window` : `${criterion.id} names no window`;
  const bound = fromMerge === null ? '' : fromMerge === fromDays
    ? `${work.key} merged at ${iso(mergedAt)}, ${windowDays} days after which is no later`
    : `${work.key}'s serving release was first observed at ${iso(live!)}, ${windowHours} hours after which is no later`;
  if (fromReport !== null && (fromMerge === null || fromReport >= fromMerge)) {
    const detail = since !== null
      ? `the intervention report reads ${reading} under its threshold since ${iso(since)}, and ${window}, so the reading can first exist at ${iso(fromReport)}`
      : holdDays !== null
        ? `the intervention report reads ${reading} not yet under its threshold (since null) and projects the streak to begin at ${iso(projected!)}, and ${criterion.id} names a ${holdDays}-consecutive-day hold, so the reading can first exist at ${iso(fromReport)}`
        : `the intervention report reads ${reading} not yet under its threshold (since null) and projects the streak to begin at ${iso(projected!)}, so the reading can first exist then`;
    return { notBefore: iso(fromReport), basis: 'intervention-report', detail: `${detail}${bound ? `; ${bound}` : ''}`.slice(0, 2000) };
  }
  if (fromMerge === null) return undefined;
  const origin = fromMerge === fromDays
    ? `${work.key} merged at ${iso(mergedAt)} and ${window}`
    : `${work.key}'s serving release was first observed at ${iso(live!)} and ${criterion.id} names a ${windowHours}-hour live window`;
  const detail = `${origin}, so the reading can first exist at ${iso(fromMerge)}${fromReport !== null ? ` (the intervention report's projection for ${reading}, ${iso(fromReport)}, is earlier)` : pattern ? ` (the intervention report holds no reading for ${reading})` : ''}`;
  return { notBefore: iso(fromMerge), basis: 'criterion-window', detail: detail.slice(0, 2000) };
}

export const postDeployFollowUpId = (work: Pick<Work, 'id'>, criterion: string, proof: string, release: string) => `post-deploy:${work.id}:${criterion}:${proof}:${release}`;
export const postDeployMarker = 'Post-deploy follow-up: ';
export const followUpOf = (item: Pick<Work, 'description'>) => item.description?.startsWith(postDeployMarker) ? item.description.slice(postDeployMarker.length).split('\n', 1)[0] : null;
/** A follow-up's request id read back into what it was filed for, or null for any other item. */
export function followUpRequest(item: Pick<Work, 'description'>): { work: string; criterion: string; proof: string; release: string } | null {
  const match = /^post-deploy:([0-9a-f-]{36}):([^:]+):(.+):([0-9a-f]{40})$/.exec(followUpOf(item) ?? '');
  return match ? { work: match[1], criterion: match[2], proof: match[3], release: match[4] } : null;
}
/**
 * GY-1735: the window the follow-up's filing owed it, derived from the delivered item its request id
 * names — the criterion's own bound, the live window served from the deployment recorded at that
 * release (else the filing) and the intervention report's projection for the proof's pattern, the later
 * of them, as the filer reads it — or undefined for any other item or a criterion naming no window. A
 * filer older than GY-1698 or GY-1727 filed GY-1722 and GY-1725 without one, so each was dispatched
 * before its reading could exist and its worker could only escalate; the control plane now holds it itself.
 */
export function filedFollowUpWindow(item: Pick<Work, 'description' | 'createdAt'>, all: readonly Pick<Work, 'id' | 'key' | 'delivery' | 'criteria'>[], projections: PatternProjections = {}): ObservationWindow | undefined {
  const request = followUpRequest(item), delivered = request && all.find(work => work.id === request.work);
  const criterion = delivered?.criteria.find(entry => entry.id === request!.criterion);
  if (!delivered?.delivery || !criterion) return undefined;
  const deployment = delivered.delivery.deployment, recorded = deployment?.sha === request!.release ? Date.parse(deployment.observedAt) : NaN;
  const served = Math.min(...[recorded, Date.parse(item.createdAt)].filter(Number.isFinite));
  return observationWindowFor(delivered, criterion, request!.proof, projections[request!.proof], Number.isFinite(served) ? served : undefined);
}
