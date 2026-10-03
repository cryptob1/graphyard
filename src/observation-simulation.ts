import type { Work } from './model.js';
import { mergeAuthorized, predictQueue } from './merge-queue.js';
import { observationCadence } from './github.js';
import { observationStarvedAfterMs } from './store/store.js';
import { headClaimBand, observationClaimClasses, observationClaimPlan, observationFreshnessBounds, reviewRequested, type FreshnessBand } from './observation-priority.js';

/**
 * A discrete simulation of the observation scheduler (GY-1114), to size its workers against a fleet.
 * Each item's band, claim class and cadence come from the production functions (`observationClaimClasses`,
 * `observationCadence` with an unchanged reading and the fleet's `steadyMs`); each claim takes the
 * production plan (`observationClaimPlan`) and orders due jobs as `Store.takeJob` does without webhook
 * wakes: the protected prefix, then jobs starved three bounds (oldest first), then one bound, then the
 * rest of the named order, then `available_at`. `workers` loops each claim one due job, hold it for a
 * job duration, record the reading at its end and schedule the next at the cadence (the unsettled
 * one for a `changedShare` of readings); an idle worker
 * looks again a second later, as `observationWorkers` does. Returns the worst lag each band reached.
 */
export interface ObservationSimulation {
  all: Work[]; workers: number; steadyMs: number; jobMs: number; durationMs: number; batchSize?: number; seed?: number; stepMs?: number;
  /** The share of readings that come back changed, and are due again at the item's unsettled cadence (a check finished, a push). */
  changedShare?: number;
  /** Replaces an item's settled cadence: how a test replays a schedule other than the production one. */
  settledCadence?: (work: Work, band: FreshnessBand, cadenceMs: number) => number;
}
export function simulateObservationScheduler(options: ObservationSimulation) {
  const { all, workers, steadyMs, jobMs, durationMs, batchSize = 1, stepMs = 1000, changedShare = 0 } = options;
  let seed = options.seed ?? 1114;
  // A deterministic spread: job durations between half and one and a half times `jobMs`, initial ages across a cadence.
  const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
  const start = Date.parse('2026-10-02T12:00:00Z'), date = new Date(start);
  const classes = observationClaimClasses(all, batchSize, start);
  const merging = new Set([...predictQueue(all, start).filter(placement => placement.position < headClaimBand(batchSize)).map(placement => placement.id), ...all.filter(mergeAuthorized).map(work => work.id)]);
  const items = all.filter(work => work.stage !== 'done' && work.submission).map(work => {
    const band: FreshnessBand = merging.has(work.id) || work.queue?.tips?.length ? 'merge' : reviewRequested(work, all, date) ? 'review' : 'steady';
    const settled = observationCadence(work, all, date, work.observation, steadyMs).ms;
    const cadenceMs = options.settledCadence ? options.settledCadence(work, band, settled) : settled;
    const changedMs = observationCadence(work, all, date, null, steadyMs).ms;
    const observedAt = start - Math.floor(random() * Math.min(cadenceMs, band === 'merge' ? 20_000 : cadenceMs));
    return { id: work.id, key: work.key, band, cadenceMs, changedMs, observedAt, availableAt: observedAt + cadenceMs, locked: false };
  });
  const byId = new Map(items.map(entry => [entry.id, entry]));
  const busy: { until: number; id: string | null; idleUntil: number }[] = Array.from({ length: Math.max(1, Math.floor(workers)) }, () => ({ until: start, id: null, idleUntil: start }));
  const worst = new Map<FreshnessBand, { lagMs: number; key: string | null }>((['merge', 'review', 'steady'] as FreshnessBand[]).map(band => [band, { lagMs: 0, key: null }]));
  let claims = 0;
  for (let now = start; now <= start + durationMs; now += stepMs) {
    for (const worker of busy) {
      if (worker.id && worker.until <= now) {
        const entry = byId.get(worker.id)!;
        entry.observedAt = worker.until; entry.availableAt = worker.until + (random() < changedShare ? entry.changedMs : entry.cadenceMs); entry.locked = false; worker.id = null;
      }
      if (worker.id || worker.idleUntil > now) continue;
      const plan = observationClaimPlan(classes, id => byId.get(id)?.observedAt ?? null, now);
      const position = new Map(plan.order.map((id, index) => [id, index + 1]));
      const tier = (entry: typeof items[number]) => {
        const named = position.get(entry.id);
        if (named !== undefined && named <= plan.headCount) return 0;
        if (entry.availableAt < now - observationStarvedAfterMs * 3) return 1;
        if (entry.availableAt < now - observationStarvedAfterMs) return 2;
        return named !== undefined ? 3 : 4;
      };
      const due = items.filter(entry => !entry.locked && entry.availableAt <= now).map(entry => ({ entry, tier: tier(entry) }))
        .sort((a, b) => a.tier - b.tier || (a.tier === 1 ? a.entry.availableAt - b.entry.availableAt : 0)
          || (position.get(a.entry.id) ?? Infinity) - (position.get(b.entry.id) ?? Infinity) || a.entry.availableAt - b.entry.availableAt);
      const next = due[0]?.entry;
      if (!next) { worker.idleUntil = now + 1000; continue; }
      next.locked = true; worker.id = next.id; worker.until = now + Math.round(jobMs * (0.5 + random())); claims++;
    }
    for (const entry of items) {
      const lag = now - entry.observedAt, record = worst.get(entry.band)!;
      if (lag > record.lagMs) { record.lagMs = lag; record.key = entry.key; }
    }
  }
  const bands = (['merge', 'review', 'steady'] as FreshnessBand[]).map(band => ({ band, items: items.filter(entry => entry.band === band).length,
    boundMs: observationFreshnessBounds[band], worstLagMs: worst.get(band)!.lagMs, worstItem: worst.get(band)!.key }));
  return { bands, claims, claimsPerMinute: Math.round(claims / (durationMs / 60_000) * 10) / 10,
    withinBounds: bands.every(entry => entry.boundMs === null || entry.items === 0 || entry.worstLagMs <= entry.boundMs) };
}
