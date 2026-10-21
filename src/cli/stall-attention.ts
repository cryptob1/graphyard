import { type AttentionItem } from '../master.js';
import { type Work } from '../model/work.js';
import type { IntegrationJob } from '../coordination.js';
import { firstObservationOwed, observationBandLag } from '../observation-priority.js';
import { leaseHealthStatus } from './lease-health-attention.js';

/**
 * What waits on something no worker fixes (GY-492, GY-558, GY-566): observation lag past each
 * band's bound, slow lease renewals and the conflict hotspots, raised beside the stalls.
 */
export function stallAttention(snapshot: { work: Work[]; now: string }, coordinator: Parameters<typeof leaseHealthStatus>[0], derivedStalls: readonly AttentionItem[], hotspotAttention: readonly AttentionItem[]) {
  const observation = observationThroughputStatus(snapshot), health = leaseHealthStatus(coordinator);
  const stalledItems = [...derivedStalls, ...observation.attention, ...health.attention, ...hotspotAttention];
  return { observation, health, stalledItems };
}

/** When the item's current submission was made: the documentation record's time for that PR, else when its stage was entered. */
const submittedAt = (work: Work) => work.documentation?.submission?.pr === work.submission?.pr && work.documentation?.submission?.at ? work.documentation.submission.at : work.stageEnteredAt;

/**
 * Each band's observation lag (GY-492, GY-1114), read from the jobs and items in the work snapshot.
 * A band whose readings fall past its bound is raised as attention naming the band, its oldest item
 * and its lag. The control plane observes every head from its own checkout, so no request budget is read.
 */
export function observationThroughputStatus(snapshot: { work: Work[]; now: string; jobs?: IntegrationJob[] }, now = Date.parse(snapshot.now)) {
  const oldestDueJobMs = (snapshot.jobs ?? []).reduce<number | null>((oldest, job) => {
    const locked = job.locked_until !== null && Date.parse(job.locked_until) > now, held = job.held_until != null && Date.parse(job.held_until) > now;
    if (locked || held) return oldest;
    const available = Date.parse(job.available_at);
    return oldest === null ? Math.max(0, now - available) : Math.min(oldest, Math.max(0, now - available));
  }, null);
  // The oldest submission never observed (GY-567): nothing can review or prove it until it is read once.
  const unobserved = snapshot.work.filter(firstObservationOwed).map(work => ({ key: work.key, pr: work.submission!.pr, submittedAt: submittedAt(work) }))
    .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  const oldestUnobservedSubmission = unobserved[0] ? { ...unobserved[0], ageMs: Math.max(0, now - Date.parse(unobserved[0].submittedAt)), count: unobserved.length } : null;
  const lag = observationBandLag(snapshot.work, now);
  return { oldestDueJobMs, oldestUnobservedSubmission, bands: lag.bands, attention: lag.attention };
}
