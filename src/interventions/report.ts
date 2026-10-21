// Concern: the interventions report — the window's counts, trend, costliest items and the recurring kind-at-stage patterns.
import type pg from 'pg';
import type { Stage, Work } from '../model.js';
import { handFiledPatterns, interventionKinds, interventionWindows, patternCause, patternHoldDays, patternInstancesShown, type Intervention, type InterventionKind, type InterventionPolicy, type InterventionReport, type InterventionWindow, type Judgement, type PatternCause, type PatternOwner, type PatternRow, type UnderThreshold } from '../model/interventions.js';
import type { PipelineTimeline } from '../pipeline-speed.js';
import type { Store } from '../store.js';
import { boundedSnapshot } from '../store/bounded-snapshot.js';
import { readInterventionLedger } from './ledger.js';
import { foldInterventions } from './fold.js';

const day = 86_400_000;
const deliveredAt = (item: Work) => item.stage === 'done' && !item.closure ? item.delivery?.mergedAt ?? item.observation?.mergedAt ?? item.stageEnteredAt : null;
const stageKey = (stage: Stage | null): Stage | 'none' => stage ?? 'none';

/** The report over a window ending now (AC-2): what the product made people do by hand, and where. */
/** `reach`: where the record the fold read is whole (`ledger.reach`), which the under-threshold reading reads from; the report window's start when unstated. */
export function computeInterventionReport(folded: { interventions: Intervention[]; judgements: Judgement[] }, work: readonly Work[], policy: InterventionPolicy, options: { days: InterventionWindow; now: string; kind?: InterventionKind | null; stage?: Stage | null; work?: string | null; reach?: string | null }): InterventionReport {
  const to = options.now, from = new Date(Date.parse(to) - options.days * day).toISOString();
  const inWindow = (intervention: Intervention) => intervention.requestedAt < to && (intervention.resolvedAt === null || intervention.resolvedAt >= from);
  const all = folded.interventions.filter(inWindow);
  const filtered = all.filter(intervention => (!options.kind || intervention.kind === options.kind) && (!options.stage || intervention.stage === options.stage) && (!options.work || intervention.work?.key === options.work || intervention.work?.id === options.work));
  const deliveries = work.filter(item => { const at = deliveredAt(item); return !!at && at >= from && at < to; });
  const sum = (list: Intervention[]) => list.reduce((total, entry) => total + entry.waitedMs, 0);
  const group = <K extends string>(list: Intervention[], key: (entry: Intervention) => K) => {
    const buckets = new Map<K, Intervention[]>();
    for (const entry of list) { const bucket = buckets.get(key(entry)) ?? []; bucket.push(entry); buckets.set(key(entry), bucket); }
    return [...buckets].map(([name, entries]) => ({ name, entries, count: entries.length, open: entries.filter(entry => entry.resolvedAt === null).length, waitedMs: sum(entries) })).sort((a, b) => b.count - a.count || b.waitedMs - a.waitedMs);
  };
  const bucketMs = options.days === 7 ? day : 7 * day;
  const trend = Array.from({ length: Math.ceil(options.days * day / bucketMs) }, (_, index) => {
    const end = Date.parse(to) - index * bucketMs, start = end - bucketMs;
    const within = (at: string | null) => !!at && Date.parse(at) >= start && Date.parse(at) < end;
    const entries = filtered.filter(entry => within(entry.requestedAt));
    return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), interventions: entries.length, deliveries: deliveries.filter(item => within(deliveredAt(item))).length, waitedMs: sum(entries) };
  }).reverse();
  const costliest = group(filtered.filter(entry => entry.work), entry => entry.work!.id).slice(0, 10).map(bucket => {
    const item = work.find(candidate => candidate.id === bucket.name);
    const kinds: Partial<Record<InterventionKind, number>> = {};
    for (const entry of bucket.entries) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
    return { key: item?.key ?? bucket.entries[0].work!.key, title: item?.title ?? bucket.entries[0].work!.title, stage: item?.stage ?? 'done', count: bucket.count, waitedMs: bucket.waitedMs, kinds };
  }).sort((a, b) => b.waitedMs - a.waitedMs || b.count - a.count);
  // GY-1682: the row names the count the threshold is judged on, the items that account for every
  // counted instance and the instances themselves, so a reader of 20 counted and no crossing sees the
  // delivered items that own 18 of them and the open item that stands for the other 2, rather than a
  // scan that failed its promise. The first item in fleet order accounts for a linked instance, as
  // detectPatterns links it; the standing item accounts for the unlinked ones. Each instance carries
  // its cause and its item's rework rounds, and each owner the tally of both, so the causes are read
  // against the item that owns them (AC-2).
  const accountedBy = new Map<string, Work>(), byId = new Map<string, Work>();
  for (const item of work) { byId.set(item.id, item); for (const instance of item.origin?.pattern?.instances ?? []) if (!accountedBy.has(instance.id)) accountedBy.set(instance.id, item); }
  const reworkRoundsOf = (entry: Intervention) => { const item = entry.work ? byId.get(entry.work.id) as (Work & { pipeline?: PipelineTimeline }) | undefined : undefined; return item ? item.pipeline?.reworkRounds ?? 0 : null; };
  const reach = options.reach ?? from;
  // The pair's every instance inside the reach, linked or not, for the under-threshold reading (AC-2): one pass over the fold.
  // The reading establishes itself one policy window past the reach (`underThreshold`): the instances before the reach were not read.
  const inReach = new Map<string, Intervention[]>();
  for (const entry of folded.interventions) {
    if (entry.requestedAt < reach || entry.requestedAt >= to) continue;
    const key = `${entry.kind}|${stageKey(entry.stage)}`;
    const bucket = inReach.get(key);
    if (bucket) bucket.push(entry); else inReach.set(key, [entry]);
  }
  /** The causes a list of instances shows and the rework rounds their items carried, each item once: an item's rounds are its cost once, however many of its asks the pair counted. */
  const tally = (entries: readonly Intervention[]) => {
    const causes: Partial<Record<PatternCause, number>> = {}, items = new Set<string>();
    let reworkRounds = 0;
    for (const entry of entries) {
      const cause = patternCause(entry.kind, entry.trigger);
      if (cause) causes[cause] = (causes[cause] ?? 0) + 1;
      if (entry.work && !items.has(entry.work.id)) { items.add(entry.work.id); reworkRounds += reworkRoundsOf(entry) ?? 0; }
    }
    return { causes, reworkRounds };
  };
  const seen = new Set<string>();
  const patterns: PatternRow[] = detectPatterns(folded.interventions, work, policy, to).map(pattern => {
    const key = `${pattern.kind}|${stageKey(pattern.stage)}`;
    seen.add(key);
    const owner = (entry: Intervention) => accountedBy.get(entry.id) ?? pattern.item ?? null;
    const owned = new Map<string, { item: Work; entries: Intervention[] }>();
    for (const entry of pattern.entries) {
      const item = owner(entry);
      if (!item) continue;
      const bucket = owned.get(item.id) ?? { item, entries: [] };
      bucket.entries.push(entry);
      owned.set(item.id, bucket);
    }
    const accounted: PatternOwner[] = [...owned.values()].map(({ item, entries }) => ({ id: item.id, key: item.key, stage: item.stage, count: entries.length, ...tally(entries) })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    const instances = [...pattern.entries].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).slice(0, patternInstancesShown)
      .map(entry => ({ id: entry.id, work: entry.work ? { id: entry.work.id, key: entry.work.key } : null, requestedAt: entry.requestedAt, resolvedAt: entry.resolvedAt, trigger: entry.trigger ?? null, owner: owner(entry)?.key ?? null, cause: patternCause(entry.kind, entry.trigger), reworkRounds: reworkRoundsOf(entry) }));
    return { kind: pattern.kind, stage: stageKey(pattern.stage), count: pattern.count, unlinked: pattern.unlinked.length, threshold: policy.threshold, crossed: pattern.item !== null || pattern.unlinked.length >= policy.threshold,
      work: pattern.item ? { id: pattern.item.id, key: pattern.item.key, stage: pattern.item.stage } : null, accounted, ...tally(pattern.entries), instances,
      underThreshold: underThreshold(inReach.get(key) ?? [], policy, reach, to) };
  });
  // A pair with no instance left in the policy window but some inside the reach keeps its reading (AC-2): the days it has held under the rule are read, not inferred from an absent row.
  for (const [key, entries] of [...inReach].filter(([key]) => !seen.has(key)).sort(([a], [b]) => a.localeCompare(b))) {
    const [kind, stage] = key.split('|') as [InterventionKind, Stage | 'none'];
    patterns.push({ kind, stage, count: 0, unlinked: 0, threshold: policy.threshold, crossed: false, work: null, accounted: [], causes: {}, reworkRounds: 0, instances: [], underThreshold: underThreshold(entries, policy, reach, to) });
  }
  return {
    window: { days: options.days, from, to }, policy, deliveries: deliveries.length,
    total: filtered.length, open: filtered.filter(entry => entry.resolvedAt === null).length, waitedMs: sum(filtered),
    ratePerDelivery: deliveries.length ? Number((filtered.length / deliveries.length).toFixed(2)) : null,
    byKind: group(filtered, entry => entry.kind).map(({ name, count, open, waitedMs }) => ({ kind: name, count, open, waitedMs })),
    byStage: group(filtered, entry => stageKey(entry.stage)).map(({ name, count, open, waitedMs }) => ({ stage: name, count, open, waitedMs })),
    byKindAndStage: group(filtered, entry => `${entry.kind}|${stageKey(entry.stage)}` as `${InterventionKind}|${Stage | 'none'}`).map(({ name, count, waitedMs }) => { const [kind, stage] = name.split('|') as [InterventionKind, Stage | 'none']; return { kind, stage, count, waitedMs }; }),
    trend, costliest, patterns,
    judgements: folded.judgements.filter(judgement => judgement.at >= from && judgement.at < to && (!options.work || judgement.work?.key === options.work || judgement.work?.id === options.work)).sort((a, b) => b.at.localeCompare(a.at)),
    interventions: filtered.slice(0, 500),
  };
}

/**
 * GY-1682 AC-2: the pair's every instance inside the reach — linked to an item or not — against the
 * threshold over every rolling window of the policy's days, by one sweep of their entries and exits
 * (an instance is inside the window [t − days, t) from its instant until `days` later; one leaving
 * at the instant another arrives has left). The reading is exact over the windows the record
 * establishes: the record is whole from `reach` on, and the instances before it were not read, so a
 * window reaching before the reach may hold instances the sweep never saw, and the count at any
 * instant before `reach + days` is a floor, not a reading. The reading is established from that
 * instant on (`established`): the streak begins no earlier, the peak is the most one established
 * window held, and the instant the streak would begin if nothing further is recorded (`projected`)
 * is never before it. A floor at or past the threshold is a crossing all the same, so the streak
 * has not begun while the instances the record holds are at or past it; a floor under it proves
 * nothing, and while `established` lies past `now` the reading says so: `since` null, `projected`
 * where the streak would begin, `peak` 0. The instances' instants are fixed, so the count at every
 * established instant is known, and so is the instant the window next falls under the threshold if
 * nothing further is recorded.
 */
export function underThreshold(instances: readonly Intervention[], policy: InterventionPolicy, reach: string, now: string): UnderThreshold {
  const windowMs = policy.windowDays * day, end = Date.parse(now), established = Date.parse(reach) + windowMs;
  // An instance recorded at or after `now` is not on the record yet; the recorded ones' exits past now are kept for `projected`.
  const events = instances.map(entry => Date.parse(entry.requestedAt)).filter(at => at < end).flatMap(at => [{ at, delta: 1 }, { at: at + windowMs, delta: -1 }])
    .sort((a, b) => a.at - b.at || a.delta - b.delta);
  const recorded = events.filter(event => event.at < end), later = events.filter(event => event.at >= end);
  // `under`: the instant from which the count has held under the threshold, no earlier than the reading is established; null while at or past it.
  let count = 0, peak = 0, under: number | null = established, sampled = false;
  for (const event of recorded) {
    // The count at `established` itself is the count before the first event past it: an established window with no event of its own.
    if (!sampled && event.at > established) { sampled = true; peak = Math.max(peak, count); }
    count += event.delta;
    if (event.at >= established) peak = Math.max(peak, count);
    // At or past the threshold, the streak has not begun; the first drop under it afterwards begins it, once the reading is established.
    if (count >= policy.threshold) under = null;
    else if (under === null) under = Math.max(event.at, established);
  }
  if (!sampled && established <= end) peak = Math.max(peak, count);
  const since = under !== null && established <= end ? under : null;
  let projected: number | null = null;
  if (since === null) {
    // Under the threshold but not yet established: the streak begins when the reading is. At or past it: past now the
    // recorded instances only leave, and the first drop under the threshold, once established, is where the streak would begin.
    if (count < policy.threshold) projected = established;
    else for (const event of later) { count += event.delta; if (count < policy.threshold) { projected = Math.max(event.at, established); break; } }
  }
  return { since: since === null ? null : new Date(since).toISOString(), days: since === null ? 0 : Math.floor((end - since) / day), holdDays: patternHoldDays, peak, projected: projected === null ? null : new Date(projected).toISOString(), reach, established: new Date(established).toISOString() };
}

/**
 * Every kind-at-stage pair with at least one instance needed inside the policy window, with the
 * item that stands for it. One pass over the instances groups them and one pass over the items
 * finds what they link and which open item stands for each pair (GY-1381), so the cost is linear
 * in what it reads: the scan runs every minute over a window of thousands of instances. An open
 * item the scan opened for the pair stands first; failing one, an open item filed by hand for the
 * pair's fault (handFiledPatterns, GY-1682) — for every pair it quotes — so the scan opens nothing
 * beside it and the report names it.
 */
export function detectPatterns(interventions: Intervention[], work: readonly Work[], policy: InterventionPolicy, now: string) {
  const from = new Date(Date.parse(now) - policy.windowDays * day).toISOString();
  const linked = new Set<string>(), standing = new Map<string, Work>(), handFiled = new Map<string, Work>();
  for (const item of work) {
    const origin = item.origin, pattern = origin?.pattern; // one read of the origin per item (unit:intervention-detect-linear)
    if (!pattern) {
      if (item.stage !== 'done' && origin?.faultClass) for (const filed of handFiledPatterns({ origin, title: item.title, description: item.description })) { const key = `${filed.kind}|${stageKey(filed.stage)}`; if (!handFiled.has(key)) handFiled.set(key, item); }
      continue;
    }
    for (const instance of pattern.instances) linked.add(instance.id);
    const key = `${pattern.kind}|${stageKey(pattern.stage)}`;
    // The first open item in fleet order stands for the pair, as it always has.
    if (item.stage !== 'done' && !standing.has(key)) standing.set(key, item);
  }
  const groups = new Map<string, { entries: Intervention[]; unlinked: Intervention[] }>();
  for (const entry of interventions) {
    if (entry.requestedAt < from || entry.requestedAt >= now) continue;
    const key = `${entry.kind}|${stageKey(entry.stage)}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { entries: [], unlinked: [] });
    group.entries.push(entry);
    if (!linked.has(entry.id)) group.unlinked.push(entry);
  }
  return [...groups].map(([key, { entries, unlinked }]) => {
    const [kind, stage] = key.split('|') as [InterventionKind, Stage | 'none'];
    return { kind, stage: stage === 'none' ? null : stage, count: entries.length, entries, unlinked, item: standing.get(key) ?? handFiled.get(key) ?? null, from };
  }).sort((a, b) => b.count - a.count);
}

/** The instant `days` before `now`: where a windowed ledger read starts. */
export const windowStart = (now: string, days: number) => new Date(Date.parse(now) - days * day).toISOString();

/**
 * The read behind the API and the CLI: the ledger folded against the current snapshot, then
 * reported over the window. It is bounded by its window in SQL (GY-422): the ledger rows are those
 * written inside the report window or the recurrence policy's, whichever reaches further back, and
 * the snapshot is the bounded one — open items whole, settled deliveries as the summaries the
 * report reads (key, title, stage, origin, delivery). A signal whose need was recorded before the
 * window opened is outside its reach; `ledger.since` says where the read began and `ledger.reach`
 * where the record it holds is whole: the same instant, unless the read was truncated (`ledgerReach`).
 */
export async function readInterventionReport(store: Store, policy: InterventionPolicy, options: { days?: InterventionWindow; kind?: InterventionKind | null; stage?: Stage | null; work?: string | null; limit?: number } = {}) {
  const days = options.days ?? 30;
  const snapshot = await boundedSnapshot(store.reportPool);
  const since = windowStart(snapshot.now, Math.max(days, policy.windowDays));
  const { rows, truncated, retainedFrom } = await readInterventionLedger(store.reportPool, { limit: options.limit, since });
  const reach = ledgerReach(retainedFrom, truncated, since, snapshot.now);
  const folded = foldInterventions(rows, snapshot.work, snapshot.now);
  const report = computeInterventionReport(folded, snapshot.work, policy, { days, now: snapshot.now, kind: options.kind, stage: options.stage, work: options.work, reach });
  return { ...report, ledger: { rows: rows.length, truncated, oldest: rows[0]?.at ?? null, since, reach }, kinds: interventionKinds, windows: interventionWindows };
}

/**
 * GY-1682 AC-2: where the under-threshold reading begins. The ledger read is the newest
 * `interventionLedgerLimit` rows since `since`; when it is truncated the rows before its oldest were
 * never read, and a reading that began at `since` would take them for an empty record — a streak and
 * a peak the record does not support. So a truncated read begins where the record it holds is whole:
 * at the insertion instant of the oldest row the read retained (`retainedFrom`, which
 * `readInterventionLedger` reads off the retained window itself, so a retained decision row written
 * inside the window counts as the window's and the requests it reads from beyond the window do
 * not; past any instant the cut shares, and never a retained row's own earlier `updatedAt`, which
 * omitted rows may follow), and no earlier than the read — later is a shorter streak, never a
 * false one. A read that retained no row holds no record to read, and the reading begins now.
 * Either way the reading establishes itself one policy window later (`underThreshold`): the rows
 * before the reach, cut or never read, may still belong to the windows that reach before it.
 */
export function ledgerReach(retainedFrom: string | null, truncated: boolean, since: string, now: string): string {
  if (!truncated) return since;
  return retainedFrom === null ? now : retainedFrom > since ? retainedFrom : since;
}
