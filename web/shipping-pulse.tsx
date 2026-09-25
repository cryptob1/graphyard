import React, { useEffect, useRef, useState } from 'react';
import type { ShippingPulse as Pulse } from '../src/shipping-pulse';

const STALE_AFTER_MS = 120_000;
const hours = (value: number | null) => value === null ? 'Unavailable' : `${value}h`;

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
// A number the page may show as unavailable: durations, proof totals, and a delivery's pull request number.
const isHours = (value: unknown) => value === null || isNumber(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether a body read from /api/shipping-pulse has every field the page draws: the headline
 * reads the production median, and Show details reads the counts, the nested production
 * metric (split, exclusions, coverage), the weeks and the recent deliveries. Anything else
 * reads as unavailable instead of breaking the page. Fields a server before them did not
 * send (`configured`, `sources`, `dominantExclusion`, `unconfiguredReason`) may be absent,
 * and the view reads their absence as it always has.
 */
export function wellFormedPulse(body: any): body is Pulse {
  if (!isObject(body)) return false;
  const { counts, intentToMerge, prToProduction: production, range, weeks, recent } = body;
  if (body.completeness !== 'complete' && body.completeness !== 'partial') return false;
  if (body.partialReason != null && !isString(body.partialReason)) return false;
  if (!isString(body.generatedAt) || !isObject(range) || !isString(range.start) || !isString(range.end)) return false;
  if (!isObject(counts) || !isNumber(counts.days7) || !isNumber(counts.days30)) return false;
  if (!isObject(intentToMerge) || !isHours(intentToMerge.medianHours) || !isNumber(intentToMerge.sampleSize) || !isNumber(intentToMerge.excluded)) return false;
  if (!isObject(production)) return false;
  if (production.configured !== undefined && typeof production.configured !== 'boolean') return false;
  if (production.sparse !== undefined && typeof production.sparse !== 'boolean') return false;
  if (production.unconfiguredReason != null && !isString(production.unconfiguredReason)) return false;
  if (![production.averageHours, production.medianHours, production.p90Hours].every(isHours)) return false;
  if (![production.sampleSize, production.eligible, production.excluded, production.coveragePercent].every(isNumber)) return false;
  if (!isObject(production.split) || !isHours(production.split.prToMergeAverageHours) || !isHours(production.split.mergeToProductionAverageHours)) return false;
  if (!isObject(production.exclusions) || !Object.values(production.exclusions).every(isNumber)) return false;
  if (production.sources != null && (!isObject(production.sources) || !isNumber(production.sources.verifiedDeliveries) || typeof production.sources.providerObservations !== 'boolean')) return false;
  if (production.dominantExclusion != null && (!isObject(production.dominantExclusion) || !isString(production.dominantExclusion.reason) || !isNumber(production.dominantExclusion.count))) return false;
  if (!Array.isArray(weeks) || !weeks.every(week => isObject(week) && isString(week.start) && isNumber(week.count))) return false;
  // The weekly chart labels its first and last week, so deliveries need at least one week to draw.
  if (!Array.isArray(recent) || (recent.length > 0 && weeks.length === 0)) return false;
  return recent.every(item => isObject(item) && isString(item.key) && isString(item.title) && isHours(item.pullRequest)
    && isString(item.mergeSha) && isString(item.mergedAt) && isObject(item.quality)
    && isHours(item.quality.passingProofs) && isHours(item.quality.requiredProofs)
    && Array.isArray(item.quality.violations) && item.quality.violations.every(isString)
    && (item.quality.unavailableReason == null || isString(item.quality.unavailableReason)));
}

/**
 * One live read of the shipping pulse: the report, whether the last read failed, and how stale
 * the figures are. Insights reads it once for its headline numbers and its detail (GY-168).
 */
export function usePulse(token: string) {
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // Staleness is elapsed time since this browser last read the pulse successfully.
  // Both endpoints come from one clock, so a workstation clock that disagrees with
  // the repository clock cannot make fresh data look stale or stale data look fresh.
  const [elapsed, setElapsed] = useState(0);
  const [reloads, setReloads] = useState(0);
  const readAt = useRef(performance.now());
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    const load = async () => {
      try {
        const response = await fetch('/api/shipping-pulse', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) throw new Error(String(response.status));
        const next = await response.json();
        // Opening Insights lands here, so a malformed body reads as unavailable instead of breaking the page.
        if (!wellFormedPulse(next)) throw new Error('The shipping pulse report is malformed');
        if (active) { setPulse(next); setUnavailable(false); readAt.current = performance.now(); setElapsed(0); }
      } catch { if (active) { setUnavailable(true); setElapsed(performance.now() - readAt.current); } }
    };
    void load(); const poll = setInterval(load, 30_000); const tick = setInterval(() => setElapsed(performance.now() - readAt.current), 10_000);
    return () => { active = false; controller.abort(); clearInterval(poll); clearInterval(tick); };
  }, [token, reloads]);
  return { pulse, unavailable, elapsed, stale: unavailable || elapsed > STALE_AFTER_MS, refresh: () => setReloads(count => count + 1) };
}
export type PulseRead = ReturnType<typeof usePulse>;

/** The shipping pulse detail under Insights → Show details, from one read (`usePulse`). */
export function ShippingPulse({ read, repository }: { read: PulseRead; repository?: string }) {
  const { pulse, unavailable, elapsed, stale, refresh } = read;
  if (!pulse && !unavailable) return <section className="pulse-state" role="status"><h2>Loading shipping pulse…</h2><p>Reading bounded delivery history from the repository ledger.</p></section>;
  if (!pulse && unavailable) return <section className="pulse-state danger" role="alert"><h2>Shipping pulse unavailable</h2><p>The delivery ledger could not be read. Check the control-plane connection; missing data is not shown as zero.</p></section>;
  return <ShippingPulseView pulse={pulse!} repository={repository} stale={stale} elapsed={elapsed} onRefresh={refresh}/>;
}

/**
 * The page for one pulse document. Pure, so it renders the same from a live read and from
 * a fixture: the container above owns fetching and staleness and hands both in.
 */
export function ShippingPulseView({ pulse, repository, stale, elapsed, onRefresh }: { pulse: Pulse; repository?: string; stale: boolean; elapsed: number; onRefresh: () => void }) {
  const production = pulse.prToProduction;
  // A metric with no inputs is a configuration state, not a thin sample: nothing has ever
  // recorded a production observation, so the sparse caveat would misdiagnose the page's own
  // emptiness as a statistical one. Servers before this field reported no such state.
  const unconfigured = production.configured === false;
  const dominant = production.dominantExclusion ?? null;
  const empty = pulse.recent.length === 0;
  const state = stale ? 'stale' : pulse.completeness;
  const base = repository ? `https://github.com/${repository}` : null;
  const max = Math.max(1, ...pulse.weeks.map(week => week.count));
  // The cap truncates to the newest deliveries, so counts read low but durations are
  // simply a sample of recent work. Saying so beside every duration keeps an operator
  // from reading these as conservative bounds the way the counts can be read.
  const durationSample = pulse.truncated && <p className="muted">Sampled durations: more deliveries fell in this window than the query reads, so these durations come only from the newest ones. Older deliveries in the window were not read and could move these values up or down. Unlike the counts, they are not lower bounds.</p>;
  return <div className="pulse" aria-labelledby="pulse-title">
    <div className="section-title"><div><h2 id="pulse-title">Shipping pulse</h2><p>Exact observed merges, without individual activity or productivity scoring.</p></div><div className="pulse-actions"><button type="button" onClick={onRefresh}>Refresh</button><span className={`pulse-badge ${state}`}>{state}</span></div></div>
    {stale && <div className="notice" role="status"><strong>Data is stale.</strong> This browser last read the pulse {Math.max(1, Math.round(elapsed / 60_000))} minute(s) ago; the repository generated it at {new Date(pulse.generatedAt).toLocaleString()}. Refreshing has not succeeded since, so check the control-plane connection and use Refresh above before relying on these figures.</div>}
    {pulse.completeness === 'partial' && <div className="notice" role="status"><strong>Partial history.</strong> {pulse.partialReason}</div>}
    {empty ? <section className="pulse-state"><h2>No deliveries in this window</h2><p>The ledger was read successfully. No exact observed merges occurred between {new Date(pulse.range.start).toLocaleDateString()} and {new Date(pulse.range.end).toLocaleDateString()} (inclusive, repository UTC).</p></section> : <>
      <div className="pulse-metrics" aria-label="Delivery metrics"><div><span>Last 7 days</span><strong>{pulse.counts.days7}</strong><small>exact merges</small></div><div><span>Last 30 days</span><strong>{pulse.counts.days30}</strong><small>exact merges</small></div><div><span>Median intent → merge</span><strong>{pulse.intentToMerge.medianHours === null ? 'Unavailable' : `${pulse.intentToMerge.medianHours}h`}</strong><small>{pulse.intentToMerge.sampleSize} included · {pulse.intentToMerge.excluded} excluded</small></div></div>
      {durationSample}
      <section className="pulse-production" aria-labelledby="production-heading"><div className="section-title"><h2 id="production-heading">Pull request → production</h2><span>VERIFIED CONTAINMENT · REPOSITORY CLOCK · UTC</span></div>
        {unconfigured && <div className="notice danger" role="alert"><strong>Production endpoint not configured.</strong> {production.unconfiguredReason ?? 'No deployment-provider observation has ever been recorded, so no deliveries can be measured until one is: this metric ends at observations recorded through POST /api/production-observations by a producer credential whose deploymentProviders scope names the provider, and POST /api/deployments does not feed it. A delivery verified with graphyard master verify-deployment also counts.'} These figures are unavailable, not sparse.</div>}
        {!unconfigured && production.sparse && <div className="notice" role="status"><strong>Sparse sample.</strong> Fewer than 5 deliveries have a verified production endpoint; interpret these durations cautiously.</div>}
        <div className="pulse-metrics" aria-label="Pull request to production metrics"><div><span>Average</span><strong>{hours(production.averageHours)}</strong></div><div><span>Median</span><strong>{hours(production.medianHours)}</strong></div><div><span>90th percentile</span><strong>{hours(production.p90Hours)}</strong></div></div>
        <p className="pulse-coverage"><strong>{production.sampleSize} included of {production.eligible}</strong> ({production.coveragePercent}% coverage) · {production.excluded} excluded{dominant ? <>, most often <em className="pulse-exclusion">{dominant.reason.replaceAll('-', ' ')}</em> ({dominant.count}{dominant.count === production.excluded ? ', every exclusion' : ` of ${production.excluded}`})</> : null}.</p>
        {production.sources && <p className="muted">Production instants: {production.sources.providerObservations ? 'deployment-provider observations are recorded' : 'no deployment-provider observation is recorded'} · {production.sources.verifiedDeliveries} in this window verified with master verify-deployment.</p>}
        {durationSample}
        <p>Average split: PR created → merge {hours(production.split.prToMergeAverageHours)} · merge → production {hours(production.split.mergeToProductionAverageHours)}.</p>
        {Object.keys(production.exclusions).length > 0 && <details><summary>Why records were excluded</summary><ul>{Object.entries(production.exclusions).map(([reason, count]) => <li key={reason}>{reason.replaceAll('-', ' ')}: {count}</li>)}</ul></details>}
      </section>
      <section className="pulse-chart" aria-labelledby="weekly-heading"><div className="section-title"><h2 id="weekly-heading">Weekly deliveries</h2><span>12 BOUNDED WEEKS · UTC</span></div><div className="bars" aria-hidden="true">{pulse.weeks.map(week => <div className="bar-slot" key={week.start}><div className="bar" style={{ height: `${Math.max(week.count ? 8 : 1, week.count / max * 100)}%` }}/></div>)}</div><ol className="sr-only" aria-label="Weekly delivery counts">{pulse.weeks.map(week => <li key={week.start}>{new Date(week.start).toLocaleDateString()}: {week.count} exact deliveries</li>)}</ol><div className="bar-labels"><span>{new Date(pulse.weeks[0].start).toLocaleDateString()}</span><span>{new Date(pulse.weeks.at(-1)!.start).toLocaleDateString()}</span></div></section>
      <section aria-labelledby="recent-heading"><div className="section-title"><h2 id="recent-heading">Recent deliveries</h2><span>NEWEST 10</span></div><div className="delivery-list">{pulse.recent.map(item => <article key={`${item.key}:${item.mergeSha}`}><div><strong>{item.key} · {item.title}</strong><p>{new Date(item.mergedAt).toLocaleString()} · {item.quality.requiredProofs === null ? 'Recorded proof totals unavailable' : `${item.quality.passingProofs}/${item.quality.requiredProofs} recorded proofs passed`}{item.quality.violations.length ? ` · ${item.quality.violations.length} policy violation${item.quality.violations.length === 1 ? '' : 's'}` : ' · no recorded policy violations'}</p>{item.quality.unavailableReason && <p className="muted">{item.quality.unavailableReason}</p>}{item.quality.violations.length > 0 && <details><summary>Policy context</summary><ul>{item.quality.violations.map(violation => <li key={violation}>{violation}</li>)}</ul></details>}</div><div className="delivery-links">{base ? <><a href={`${base}/pull/${item.pullRequest}`}>PR #{item.pullRequest}<span className="sr-only"> for {item.key}</span></a><a href={`${base}/commit/${item.mergeSha}`}>Commit {item.mergeSha.slice(0, 8)}<span className="sr-only"> for {item.key}</span></a></> : <span>Repository links unavailable</span>}</div></article>)}</div></section>
    </>}
    <p className="pulse-method">Window: {new Date(pulse.range.start).toLocaleString()} through {new Date(pulse.range.end).toLocaleString()}, both inclusive in repository UTC. Intent-to-merge starts at the append-only create event. Merge and pull-request times are GitHub's own, shown and compared on the repository clock using the offset measured when each merge was verified, so a window boundary or a duration never depends on which clock a timestamp came from. PR-to-production starts at GitHub's observed PR creation time and ends at the first non-superseded successful production observation that independently records containment of the exact merge. Deployment times are the provider's own clock, carried onto the repository clock at ingestion using the offset bracket the collector measured, so a provider running fast or slow neither biases a duration nor hides a real deployment behind its own merge; every duration here is accurate to within that recorded measurement, not beyond it. Where no provider reported a delivery, the release the master verified serving it with verify-deployment stands in, at the repository-clock instant the verification was recorded, so that duration is an upper bound. Missing, rollback, superseded, or invalid endpoints are excluded.</p>
  </div>;
}
