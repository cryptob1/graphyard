import React, { useEffect, useRef, useState } from 'react';
import type { ShippingPulse as Pulse } from '../src/shipping-pulse';

const STALE_AFTER_MS = 120_000;
const hours = (value: number | null) => value === null ? 'Unavailable' : `${value}h`;

export default function ShippingPulse({ token, repository }: { token: string; repository?: string }) {
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
        if (active) { setPulse(next); setUnavailable(false); readAt.current = performance.now(); setElapsed(0); }
      } catch { if (active) { setUnavailable(true); setElapsed(performance.now() - readAt.current); } }
    };
    void load(); const poll = setInterval(load, 30_000); const tick = setInterval(() => setElapsed(performance.now() - readAt.current), 10_000);
    return () => { active = false; controller.abort(); clearInterval(poll); clearInterval(tick); };
  }, [token, reloads]);
  if (!pulse && !unavailable) return <section className="pulse-state" role="status"><h2>Loading shipping pulse…</h2><p>Reading bounded delivery history from the repository ledger.</p></section>;
  if (!pulse && unavailable) return <section className="pulse-state danger" role="alert"><h2>Shipping pulse unavailable</h2><p>The delivery ledger could not be read. Check the control-plane connection; missing data is not shown as zero.</p></section>;
  const stale = unavailable || elapsed > STALE_AFTER_MS;
  const empty = pulse!.recent.length === 0;
  const state = stale ? 'stale' : pulse!.completeness;
  const base = repository ? `https://github.com/${repository}` : null;
  const max = Math.max(1, ...pulse!.weeks.map(week => week.count));
  // The cap truncates to the newest deliveries, so counts read low but durations are
  // simply a sample of recent work. Saying so beside every duration keeps an operator
  // from reading these as conservative bounds the way the counts can be read.
  const durationSample = pulse!.truncated && <p className="muted">Sampled durations: more deliveries fell in this window than the query reads, so these durations come only from the newest ones. Older deliveries in the window were not read and could move these values up or down. Unlike the counts, they are not lower bounds.</p>;
  return <div className="pulse" aria-labelledby="pulse-title">
    <div className="page-heading"><div><div className="eyebrow">REPOSITORY DELIVERY FLOW</div><h1 id="pulse-title">Shipping pulse</h1><p>Exact observed merges, without individual activity or productivity scoring.</p></div><div className="pulse-actions"><button type="button" onClick={() => setReloads(count => count + 1)}>Refresh</button><span className={`pulse-badge ${state}`}>{state}</span></div></div>
    {stale && <div className="notice" role="status"><strong>Data is stale.</strong> This browser last read the pulse {Math.max(1, Math.round(elapsed / 60_000))} minute(s) ago; the repository generated it at {new Date(pulse!.generatedAt).toLocaleString()}. Refreshing has not succeeded since, so check the control-plane connection and use Refresh above before relying on these figures.</div>}
    {pulse!.completeness === 'partial' && <div className="notice" role="status"><strong>Partial history.</strong> {pulse!.partialReason}</div>}
    {empty ? <section className="pulse-state"><h2>No deliveries in this window</h2><p>The ledger was read successfully. No exact observed merges occurred between {new Date(pulse!.range.start).toLocaleDateString()} and {new Date(pulse!.range.end).toLocaleDateString()} (inclusive, repository UTC).</p></section> : <>
      <div className="pulse-metrics" aria-label="Delivery metrics"><div><span>Last 7 days</span><strong>{pulse!.counts.days7}</strong><small>exact merges</small></div><div><span>Last 30 days</span><strong>{pulse!.counts.days30}</strong><small>exact merges</small></div><div><span>Median intent → merge</span><strong>{pulse!.intentToMerge.medianHours === null ? 'Unavailable' : `${pulse!.intentToMerge.medianHours}h`}</strong><small>{pulse!.intentToMerge.sampleSize} included · {pulse!.intentToMerge.excluded} excluded</small></div></div>
      {durationSample}
      <section className="pulse-production" aria-labelledby="production-heading"><div className="section-title"><h2 id="production-heading">Pull request → production</h2><span>EXACT VERIFIED CONTAINMENT · UTC</span></div>
        {pulse!.prToProduction.sparse && <div className="notice" role="status"><strong>Sparse sample.</strong> Fewer than 5 deliveries have a verified production endpoint; interpret these durations cautiously.</div>}
        <div className="pulse-metrics" aria-label="Pull request to production metrics"><div><span>Average</span><strong>{hours(pulse!.prToProduction.averageHours)}</strong></div><div><span>Median</span><strong>{hours(pulse!.prToProduction.medianHours)}</strong></div><div><span>90th percentile</span><strong>{hours(pulse!.prToProduction.p90Hours)}</strong></div></div>
        <p><strong>{pulse!.prToProduction.sampleSize} included of {pulse!.prToProduction.eligible}</strong> ({pulse!.prToProduction.coveragePercent}% coverage) · {pulse!.prToProduction.excluded} excluded.</p>
        {durationSample}
        <p>Average split: PR created → merge {hours(pulse!.prToProduction.split.prToMergeAverageHours)} · merge → production {hours(pulse!.prToProduction.split.mergeToProductionAverageHours)}.</p>
        {Object.keys(pulse!.prToProduction.exclusions).length > 0 && <details><summary>Why records were excluded</summary><ul>{Object.entries(pulse!.prToProduction.exclusions).map(([reason, count]) => <li key={reason}>{reason.replaceAll('-', ' ')}: {count}</li>)}</ul></details>}
      </section>
      <section className="pulse-chart" aria-labelledby="weekly-heading"><div className="section-title"><h2 id="weekly-heading">Weekly deliveries</h2><span>12 BOUNDED WEEKS · UTC</span></div><div className="bars" aria-hidden="true">{pulse!.weeks.map(week => <div className="bar-slot" key={week.start}><div className="bar" style={{ height: `${Math.max(week.count ? 8 : 1, week.count / max * 100)}%` }}/></div>)}</div><ol className="sr-only" aria-label="Weekly delivery counts">{pulse!.weeks.map(week => <li key={week.start}>{new Date(week.start).toLocaleDateString()}: {week.count} exact deliveries</li>)}</ol><div className="bar-labels"><span>{new Date(pulse!.weeks[0].start).toLocaleDateString()}</span><span>{new Date(pulse!.weeks.at(-1)!.start).toLocaleDateString()}</span></div></section>
      <section aria-labelledby="recent-heading"><div className="section-title"><h2 id="recent-heading">Recent deliveries</h2><span>NEWEST 10</span></div><div className="delivery-list">{pulse!.recent.map(item => <article key={`${item.key}:${item.mergeSha}`}><div><strong>{item.key} · {item.title}</strong><p>{new Date(item.mergedAt).toLocaleString()} · {item.quality.requiredProofs === null ? 'Recorded proof totals unavailable' : `${item.quality.passingProofs}/${item.quality.requiredProofs} recorded proofs passed`}{item.quality.violations.length ? ` · ${item.quality.violations.length} policy violation${item.quality.violations.length === 1 ? '' : 's'}` : ' · no recorded policy violations'}</p>{item.quality.unavailableReason && <p className="muted">{item.quality.unavailableReason}</p>}{item.quality.violations.length > 0 && <details><summary>Policy context</summary><ul>{item.quality.violations.map(violation => <li key={violation}>{violation}</li>)}</ul></details>}</div><div className="delivery-links">{base ? <><a href={`${base}/pull/${item.pullRequest}`}>PR #{item.pullRequest}<span className="sr-only"> for {item.key}</span></a><a href={`${base}/commit/${item.mergeSha}`}>Commit {item.mergeSha.slice(0, 8)}<span className="sr-only"> for {item.key}</span></a></> : <span>Repository links unavailable</span>}</div></article>)}</div></section>
    </>}
    <p className="pulse-method">Window: {new Date(pulse!.range.start).toLocaleString()} through {new Date(pulse!.range.end).toLocaleString()}, both inclusive in repository UTC. Intent-to-merge starts at the append-only create event. PR-to-production starts at GitHub's observed PR creation time and ends at the first non-superseded successful production observation that independently records containment of the exact merge; missing, rollback, superseded, or invalid endpoints are excluded.</p>
  </div>;
}
