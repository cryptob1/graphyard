// Concern: the interventions report — the window's counts, trend, costliest items and the recurring kind-at-stage patterns.
import type { Stage, Work } from '../model.js';
import { handFiledPatterns, interventionKinds, interventionWindows, patternCause, patternInstancesShown, type Intervention, type InterventionKind, type InterventionPolicy, type InterventionReport, type InterventionWindow, type Judgement, type PatternOwner, type PatternRow, type UnderThreshold } from '../model/interventions.js';
import type { PipelineTimeline } from '../pipeline-speed.js';
import type { Store } from '../store.js';
import { boundedSnapshot } from '../store/bounded-snapshot.js';
import { readInterventionLedger } from './ledger.js';
import { foldInterventions } from './fold.js';

const day = 86_400_000;
const deliveredAt = (item: Work) => item.stage === 'done' && !item.closure ? item.delivery?.mergedAt ?? item.observation?.mergedAt ?? item.stageEnteredAt : null;
const stageKey = (stage: Stage | null): Stage | 'none' => stage ?? 'none';

/** The report over a window ending now (AC-2): what the product made people do by hand, and where. */
/** `reach`: where the fold's ledger read began (`ledger.since`), the start of the under-threshold reading; the report window's start when unstated. */
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
  // The pair's unlinked instances inside the reach, for the under-threshold reading: one pass over the fold.
  const unlinkedInReach = new Map<string, Intervention[]>();
  for (const entry of folded.interventions) {
    if (entry.requestedAt < reach || entry.requestedAt >= to || accountedBy.has(entry.id)) continue;
    const key = `${entry.kind}|${stageKey(entry.stage)}`;
    unlinkedInReach.set(key, [...(unlinkedInReach.get(key) ?? []), entry]);
  }
  const seen = new Set<string>();
  const patterns: PatternRow[] = detectPatterns(folded.interventions, work, policy, to).map(pattern => {
    const key = `${pattern.kind}|${stageKey(pattern.stage)}`;
    seen.add(key);
    const accounted = new Map<string, PatternOwner & { items: Set<string> }>();
    const owner = (entry: Intervention) => accountedBy.get(entry.id) ?? pattern.item ?? null;
    for (const entry of pattern.entries) {
      const item = owner(entry);
      if (!item) continue;
      const row = accounted.get(item.id) ?? { id: item.id, key: item.key, stage: item.stage, count: 0, causes: {}, reworkRounds: 0, items: new Set<string>() };
      row.count++;
      const cause = patternCause(entry.kind, entry.trigger);
      if (cause) row.causes[cause] = (row.causes[cause] ?? 0) + 1;
      // An item's rounds are its cost once, however many of its asks the pair counted.
      if (entry.work && !row.items.has(entry.work.id)) { row.items.add(entry.work.id); row.reworkRounds += reworkRoundsOf(entry) ?? 0; }
      accounted.set(item.id, row);
    }
    const instances = [...pattern.entries].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).slice(0, patternInstancesShown)
      .map(entry => ({ id: entry.id, work: entry.work ? { id: entry.work.id, key: entry.work.key } : null, requestedAt: entry.requestedAt, resolvedAt: entry.resolvedAt, trigger: entry.trigger ?? null, owner: owner(entry)?.key ?? null, cause: patternCause(entry.kind, entry.trigger), reworkRounds: reworkRoundsOf(entry) }));
    return { kind: pattern.kind, stage: stageKey(pattern.stage), count: pattern.count, unlinked: pattern.unlinked.length, threshold: policy.threshold, crossed: pattern.item !== null || pattern.unlinked.length >= policy.threshold,
      work: pattern.item ? { id: pattern.item.id, key: pattern.item.key, stage: pattern.item.stage } : null, accounted: [...accounted.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).map(({ items: _items, ...row }) => row), instances,
      underThreshold: underThreshold(unlinkedInReach.get(key) ?? [], policy, reach, to) };
  });
  // A pair with no instance left in the policy window but some inside the reach keeps its reading (AC-2): the days it has held under the rule are read, not inferred from an absent row.
  for (const [key, entries] of [...unlinkedInReach].filter(([key]) => !seen.has(key)).sort(([a], [b]) => a.localeCompare(b))) {
    const [kind, stage] = key.split('|') as [InterventionKind, Stage | 'none'];
    patterns.push({ kind, stage, count: 0, unlinked: 0, threshold: policy.threshold, crossed: false, work: null, accounted: [], instances: [], underThreshold: underThreshold(entries, policy, reach, to) });
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
 * GY-1682 AC-2: the pair's unlinked instances inside the reach against the threshold over every
 * rolling window of the policy's days, by one sweep of their entries and exits (an instance is
 * inside the window [t − days, t) from its instant until `days` later; one leaving at the instant
 * another arrives has left). The reading is exact over the instances the fold holds: the
 * instances' instants are fixed, so the count at every instant between them is known.
 */
export function underThreshold(unlinked: readonly Intervention[], policy: InterventionPolicy, reach: string, now: string): UnderThreshold {
  const windowMs = policy.windowDays * day, end = Date.parse(now), start = Date.parse(reach);
  const events = unlinked.flatMap(entry => { const at = Date.parse(entry.requestedAt); return [{ at, delta: 1 }, { at: at + windowMs, delta: -1 }]; })
    .filter(event => event.at < end).sort((a, b) => a.at - b.at || a.delta - b.delta);
  let count = 0, peak = 0, since: number | null = start;
  for (const event of events) {
    count += event.delta;
    if (event.at >= start) peak = Math.max(peak, count);
    // At or past the threshold, the streak has not begun; the first drop under it afterwards begins it.
    if (count >= policy.threshold) since = null;
    else if (since === null) since = Math.max(event.at, start);
  }
  return { since: since === null ? null : new Date(since).toISOString(), days: since === null ? 0 : Math.floor((end - since) / day), peak, reach };
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
 * window opened is outside its reach; `ledger.since` says where the reach begins.
 */
export async function readInterventionReport(store: Store, policy: InterventionPolicy, options: { days?: InterventionWindow; kind?: InterventionKind | null; stage?: Stage | null; work?: string | null; limit?: number } = {}) {
  const days = options.days ?? 30;
  const snapshot = await boundedSnapshot(store.reportPool);
  const since = windowStart(snapshot.now, Math.max(days, policy.windowDays));
  const { rows, truncated } = await readInterventionLedger(store.reportPool, { limit: options.limit, since });
  const folded = foldInterventions(rows, snapshot.work, snapshot.now);
  const report = computeInterventionReport(folded, snapshot.work, policy, { days, now: snapshot.now, kind: options.kind, stage: options.stage, work: options.work, reach: since });
  return { ...report, ledger: { rows: rows.length, truncated, oldest: rows[0]?.at ?? null, since }, kinds: interventionKinds, windows: interventionWindows };
}
