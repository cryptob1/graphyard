import type { Work } from './model.js';
import { mergeAuthorized, predictQueue } from './merge-queue.js';
import { observationCadence } from './github.js';
import { observationStarvedAfterMs } from './store/store.js';
import { baseMoveWakes, headClaimBand, observationClaimClasses, observationClaimPlan, observationFreshnessBounds, reviewRequested, type FreshnessBand } from './observation-priority.js';

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
 *
 * Without `advance` the fleet is fixed: every item keeps the band, claim class and cadence it starts
 * with, which models a steady-state fleet (GY-1114's AC-1) but no churn. With `advance`, a reading that
 * comes back changed may move its item on — a review request approved into the merge queue, say — and
 * every band, claim class and cadence is read again from the new fleet, so items move between bands as
 * they would in production (GY-1178). An item entering the merge band is woken, as the loop wakes the
 * observation job of a step refused on a stale reading (daemon/cycle-delivery.ts), and its lag in a
 * band is measured from the later of its reading and its entry: how long the band held it stale.
 *
 * With `baseMoves`, the base branch moves at the given offsets (GY-1231): each move wakes the items
 * `baseMoveWakes` selects for its files (every open item for files null, as a push whose files are
 * unknown does), and a woken job is claimed ahead of the polled backlog as a webhook wake is. With
 * `requestCost`, every reading is charged what such a reading costs the App's budget — conditional
 * not-modified answers free — and the run reports the total as `requests`.
 */
export interface ObservationSimulation {
  all: Work[]; workers: number; steadyMs: number; jobMs: number; durationMs: number; batchSize?: number; seed?: number; stepMs?: number;
  /** The share of readings that come back changed, and are due again at the item's unsettled cadence (a check finished, a push). */
  changedShare?: number;
  /** Replaces an item's settled cadence: how a test replays a schedule other than the production one. */
  settledCadence?: (work: Work, band: FreshnessBand, cadenceMs: number) => number;
  /**
   * What a changed reading does to its item: the item's next state (evaluated against `fleet`), or
   * null when it stays as it is. When given, the fleet is reclassified after every change it makes.
   */
  advance?: (work: Work, fleet: Work[], at: number) => Work | null;
  /** Moves of the base branch, at these offsets from the start, each with the files it changed (null: unknown). */
  baseMoves?: { atMs: number; files: string[] | null }[];
  /**
   * The charged requests of one reading: of an unchanged item, of a changed one, and of the first
   * reading of an item after the base moved under it (a new base SHA re-reads its pull request and compare).
   */
  requestCost?: { unchanged: number; changed: number; baseMoved: number };
}
export function simulateObservationScheduler(options: ObservationSimulation) {
  const { all, workers, steadyMs, jobMs, durationMs, batchSize = 1, stepMs = 1000, changedShare = 0 } = options;
  let seed = options.seed ?? 1114;
  // A deterministic spread: job durations between half and one and a half times `jobMs`, initial ages across a cadence.
  const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
  const start = Date.parse('2026-10-02T12:00:00Z');
  let fleet = all;
  // Each open item's band and cadences, read from the fleet as it stands at `at`.
  const classify = (at: number) => {
    const date = new Date(at), headBand = headClaimBand(batchSize);
    const merging = new Set([...predictQueue(fleet, at).filter(placement => placement.position < headBand).map(placement => placement.id), ...fleet.filter(mergeAuthorized).map(work => work.id)]);
    return new Map(fleet.filter(work => work.stage !== 'done' && work.submission).map(work => {
      const band: FreshnessBand = merging.has(work.id) || work.queue?.tips?.length ? 'merge' : reviewRequested(work, fleet, date) ? 'review' : 'steady';
      const settled = observationCadence(work, fleet, date, work.observation, steadyMs).ms;
      const cadenceMs = options.settledCadence ? options.settledCadence(work, band, settled) : settled;
      return [work.id, { band, cadenceMs, changedMs: observationCadence(work, fleet, date, null, steadyMs).ms }] as const;
    }));
  };
  let classes = observationClaimClasses(fleet, batchSize, start);
  const initial = classify(start);
  const items = all.filter(work => initial.has(work.id)).map(work => {
    const { band, cadenceMs, changedMs } = initial.get(work.id)!;
    const observedAt = start - Math.floor(random() * Math.min(cadenceMs, band === 'merge' ? 20_000 : cadenceMs));
    return { id: work.id, key: work.key, band, cadenceMs, changedMs, observedAt, availableAt: observedAt + cadenceMs, locked: false, open: true, enteredAt: -Infinity, woken: false, claimedAt: -Infinity, baseReadAt: observedAt };
  });
  const byId = new Map(items.map(entry => [entry.id, entry]));
  const busy: { until: number; id: string | null; idleUntil: number }[] = Array.from({ length: Math.max(1, Math.floor(workers)) }, () => ({ until: start, id: null, idleUntil: start }));
  const worst = new Map<FreshnessBand, { lagMs: number; key: string | null }>((['merge', 'review', 'steady'] as FreshnessBand[]).map(band => [band, { lagMs: 0, key: null }]));
  let claims = 0, changedReadings = 0, bandChanges = 0, requests = 0, baseMovedAt = -Infinity;
  const moves = [...options.baseMoves ?? []].sort((a, b) => a.atMs - b.atMs), woken: string[][] = [];
  for (let now = start; now <= start + durationMs; now += stepMs) {
    while (moves.length && start + moves[0].atMs <= now) {
      const move = moves.shift()!, ids = baseMoveWakes(fleet, move.files);
      baseMovedAt = now; woken.push(fleet.filter(work => ids.includes(work.id)).map(work => work.key));
      for (const id of ids) { const entry = byId.get(id); if (entry?.open) { entry.availableAt = Math.min(entry.availableAt, now); entry.woken = true; } }
    }
    for (const worker of busy) {
      if (worker.id && worker.until <= now) {
        const entry = byId.get(worker.id)!, changed = random() < changedShare;
        if (changed) changedReadings++;
        // The first reading that starts after a base move the item's last reading did not see pays for the new base.
        if (options.requestCost) requests += entry.baseReadAt < baseMovedAt && entry.claimedAt >= baseMovedAt ? options.requestCost.baseMoved : changed ? options.requestCost.changed : options.requestCost.unchanged;
        entry.baseReadAt = entry.claimedAt;
        const moved = changed && options.advance ? options.advance(fleet.find(work => work.id === entry.id)!, fleet, worker.until) : null;
        if (moved) {
          // The item moved on: the fleet is reclassified, and every open item takes its new band and cadences.
          fleet = fleet.map(work => work.id === moved.id ? moved : work);
          classes = observationClaimClasses(fleet, batchSize, worker.until);
          const next = classify(worker.until);
          for (const item of items) {
            const reading = next.get(item.id);
            if (!reading) { if (item.open) bandChanges++; item.open = false; continue; }
            if (reading.band !== item.band) {
              bandChanges++; item.enteredAt = worker.until;
              if (reading.band === 'merge') item.availableAt = Math.min(item.availableAt, worker.until);
            }
            Object.assign(item, { band: reading.band, cadenceMs: reading.cadenceMs, changedMs: reading.changedMs });
          }
        }
        entry.observedAt = worker.until; entry.availableAt = worker.until + (changed ? entry.changedMs : entry.cadenceMs); entry.locked = false; worker.id = null;
      }
      if (worker.id || worker.idleUntil > now) continue;
      const plan = observationClaimPlan(classes, id => byId.get(id)?.observedAt ?? null, now);
      const position = new Map(plan.order.map((id, index) => [id, index + 1]));
      const tier = (entry: typeof items[number]) => {
        const named = position.get(entry.id);
        if (named !== undefined && named <= plan.headCount || entry.woken) return 0;
        if (entry.availableAt < now - observationStarvedAfterMs * 3) return 1;
        if (entry.availableAt < now - observationStarvedAfterMs) return 2;
        return named !== undefined ? 3 : 4;
      };
      const due = items.filter(entry => entry.open && !entry.locked && entry.availableAt <= now).map(entry => ({ entry, tier: tier(entry) }))
        .sort((a, b) => a.tier - b.tier || (a.tier === 1 ? a.entry.availableAt - b.entry.availableAt : 0)
          || (position.get(a.entry.id) ?? Infinity) - (position.get(b.entry.id) ?? Infinity) || a.entry.availableAt - b.entry.availableAt);
      const next = due[0]?.entry;
      if (!next) { worker.idleUntil = now + 1000; continue; }
      next.locked = true; next.woken = false; next.claimedAt = now; worker.id = next.id; worker.until = now + Math.round(jobMs * (0.5 + random())); claims++;
    }
    for (const entry of items) {
      if (!entry.open) continue;
      const lag = now - Math.max(entry.observedAt, entry.enteredAt), record = worst.get(entry.band)!;
      if (lag > record.lagMs) { record.lagMs = lag; record.key = entry.key; }
    }
  }
  // A band's item count is its membership at the end of the run; each item stays counted where it ended.
  const bands = (['merge', 'review', 'steady'] as FreshnessBand[]).map(band => ({ band, items: items.filter(entry => entry.open && entry.band === band).length,
    boundMs: observationFreshnessBounds[band], worstLagMs: worst.get(band)!.lagMs, worstItem: worst.get(band)!.key }));
  // `changedReadings` is how many readings came back changed: the ones a conditional poll pays for in full.
  // `bandChanges` counts each move of an item into another band, or out of the open fleet.
  // `requests` is what the readings cost under `requestCost`; `woken` the item keys each base move woke.
  return { bands, claims, claimsPerMinute: Math.round(claims / (durationMs / 60_000) * 10) / 10, changedReadings, bandChanges, requests, woken,
    withinBounds: bands.every(entry => entry.boundMs === null || entry.items === 0 || entry.worstLagMs <= entry.boundMs) };
}
