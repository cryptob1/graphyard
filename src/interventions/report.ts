// Concern: the interventions report — the window's counts, trend, costliest items and the recurring kind-at-stage patterns.
import type { Stage, Work } from '../model.js';
import { interventionKinds, interventionWindows, type Intervention, type InterventionKind, type InterventionPolicy, type InterventionReport, type InterventionWindow, type Judgement } from '../model/interventions.js';
import type { Store } from '../store.js';
import { boundedSnapshot } from '../store/bounded-snapshot.js';
import { readInterventionLedger } from './ledger.js';
import { foldInterventions } from './fold.js';

const day = 86_400_000;
const deliveredAt = (item: Work) => item.stage === 'done' && !item.closure ? item.delivery?.mergedAt ?? item.observation?.mergedAt ?? item.stageEnteredAt : null;
const stageKey = (stage: Stage | null): Stage | 'none' => stage ?? 'none';

/** The report over a window ending now (AC-2): what the product made people do by hand, and where. */
export function computeInterventionReport(folded: { interventions: Intervention[]; judgements: Judgement[] }, work: readonly Work[], policy: InterventionPolicy, options: { days: InterventionWindow; now: string; kind?: InterventionKind | null; stage?: Stage | null; work?: string | null }): InterventionReport {
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
  const patterns = detectPatterns(folded.interventions, work, policy, to).map(pattern => ({ kind: pattern.kind, stage: stageKey(pattern.stage), count: pattern.count, threshold: policy.threshold, crossed: pattern.item !== null || pattern.unlinked.length >= policy.threshold, work: pattern.item ? { id: pattern.item.id, key: pattern.item.key, stage: pattern.item.stage } : null }));
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
 * Every kind-at-stage pair with at least one instance needed inside the policy window, with the
 * item that stands for it. One pass over the instances groups them and one pass over the items
 * finds what they link and which open item stands for each pair (GY-1381), so the cost is linear
 * in what it reads: the scan runs every minute over a window of thousands of instances.
 */
export function detectPatterns(interventions: Intervention[], work: readonly Work[], policy: InterventionPolicy, now: string) {
  const from = new Date(Date.parse(now) - policy.windowDays * day).toISOString();
  const linked = new Set<string>(), standing = new Map<string, Work>();
  for (const item of work) {
    const pattern = item.origin?.pattern;
    if (!pattern) continue;
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
    return { kind, stage: stage === 'none' ? null : stage, count: entries.length, entries, unlinked, item: standing.get(key) ?? null, from };
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
  const report = computeInterventionReport(folded, snapshot.work, policy, { days, now: snapshot.now, kind: options.kind, stage: options.stage, work: options.work });
  return { ...report, ledger: { rows: rows.length, truncated, oldest: rows[0]?.at ?? null, since }, kinds: interventionKinds, windows: interventionWindows };
}
