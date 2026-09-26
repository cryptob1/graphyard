import { useEffect, useRef, useState, type ReactNode } from 'react';
import Dialog from './dialog';
import AttributionSection from './attribution';
import Term from './components/term';
import { stages } from '../src/model';
import { flowWindows } from '../src/flow-analytics';

type Report = any;
// Stage colours are the design tokens (web/style.css), mixed toward the background for the early stages.
const stageFill: Record<string, string> = {
  backlog: 'var(--text-3)', ready: 'color-mix(in srgb,var(--up-next) 55%,var(--bg))', build: 'var(--moving)', test: 'color-mix(in srgb,var(--moving) 60%,var(--bg))',
  review: 'var(--needs-you)', acceptance: 'var(--blocked)', merge: 'var(--up-next)', done: 'var(--shipped)',
};
// Durations are shown with their unit; an empty sample is an em dash, never a zero.
function duration(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const minutes = Math.floor(ms / 60000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.round(ms / 1000)}s`;
}
function count(value: number | null | undefined) { return value === null || value === undefined ? '—' : String(value); }
function label(bucket: string) { return new Date(bucket).toISOString().slice(5, 10); }

/**
 * The shape of every field this page reads from /api/analytics/flow. A string is a leaf, which
 * must be present and drawable as text (a primitive or null); `day` is a bucket the tables label
 * with its date; `text` is a string the page edits; `[shape]` is an array of that shape and `[]`
 * any array; an object needs each named field, and `{}` is any object.
 */
type Shape = 'leaf' | 'text' | 'day' | Shape[] | { [field: string]: Shape };
const leaves = (...fields: string[]) => Object.fromEntries(fields.map(field => [field, 'leaf' as const]));
const flowShape: Shape = {
  ...leaves('generatedAt', 'timezone'),
  window: leaves('from', 'to', 'boundaries'),
  coverage: {
    ...leaves('workItems', 'facts', 'truncated', 'workItemsTruncated', 'deploymentsTruncated', 'deploymentMergesTruncated', 'sliceFilterTruncated', 'sparse', 'scanLimit', 'workItemScanLimit', 'deploymentScanLimit', 'withObservedCandidate', 'providerTimestamps', 'controlPlaneTimestamps'),
    projection: leaves('stale', 'pendingEvents'), slices: leaves('observed', 'declared', 'unclassified', 'limit', 'truncatedInRepository'),
  },
  bottleneck: { ...leaves('narrative', 'observedAt'), categories: [leaves('id', 'label', 'count', 'definition')], scope: leaves('undelivered', 'workItems'), unclassified: ['leaf'] },
  cumulativeFlow: { buckets: ['day'], series: [{ stage: 'leaf', counts: ['leaf'] }] },
  leadTime: { bands: leaves('n', 'medianMs', 'p75Ms', 'p90Ms', 'sparse', 'outliers'), trend: [{ ...leaves('n', 'medianMs', 'p75Ms', 'p90Ms'), bucket: 'day' }] },
  throughput: [leaves('delivered')],
  stageDwell: [leaves('stage', 'sparse', 'n', 'averageMs', 'medianMs', 'p90Ms')],
  wip: [leaves('count', 'oldestMs')],
  queueVsActive: leaves('queueMs', 'activeMs', 'openMs'),
  mergeReadyDwell: { ...leaves('medianMs', 'n'), current: [] },
  phases: [{ ...leaves('n', 'medianMs', 'p90Ms'), phase: 'text', unknown: {} }],
  ci: leaves('runs', 'failures', 'retries', 'medianMs', 'precision'),
  evidence: { ...leaves('recorded', 'trusted', 'expired', 'superseded'), wait: leaves('medianMs', 'n') },
  operations: {
    blockers: [leaves('reason', 'count')], refusals: [leaves('reason', 'count')],
    criticalPath: { length: 'leaf', chain: ['leaf'] }, unblocked: { count: 'leaf', items: ['leaf'] },
    review: { ...leaves('approvals', 'independentApprovals', 'findings', 'reworkRequests', 'candidates', 'reworkRate'), rounds: leaves('median') },
    leases: leaves('claims', 'reassignments', 'losses', 'expirations', 'utilizationRatio', 'idleCapacityMs'),
    queues: [leaves('queue', 'averageDepth', 'maxDepth', 'definition')],
    deployments: { ...leaves('observations', 'succeeded', 'failed', 'rollbacks', 'perDay'), environments: ['leaf'], latency: leaves('medianMs', 'n'), pullRequestsPerDeployment: leaves('max') },
  },
  unavailable: [leaves('metric', 'reason')],
  exclusions: [{ ...leaves('reason', 'count'), items: ['leaf'] }],
  privacy: leaves('statement'),
};
function fits(value: unknown, shape: Shape): boolean {
  if (shape === 'leaf') return value === null || (value !== undefined && typeof value !== 'object');
  if (shape === 'text') return typeof value === 'string';
  if (shape === 'day') return (typeof value === 'string' || typeof value === 'number') && Number.isFinite(new Date(value).getTime());
  if (Array.isArray(shape)) return Array.isArray(value) && (shape.length === 0 || value.every(entry => fits(entry, shape[0])));
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(shape).every(([field, inner]) => fits((value as any)[field], inner));
}

/**
 * Whether a body read from /api/analytics/flow has every field this page draws, so a malformed
 * body reads as unavailable instead of breaking Insights, which mounts it under Show details.
 * The stage table reads the work in progress row by row beside the dwell rows, so it needs as many.
 */
export function wellFormedFlowReport(body: any): boolean {
  if (!fits(body, flowShape) || body.wip.length < body.stageDwell.length) return false;
  if (![body.availableTypes, body.availableSlices].every(list => list === undefined || fits(list, ['leaf']))) return false;
  return !!body.definitions && typeof body.definitions === 'object'
    && Object.values(body.definitions).every(definition => fits(definition, { ...leaves('label', 'formula'), sources: ['leaf'] }));
}

/**
 * Whether a body read from /api/analytics/flow/drilldown can be drawn: every column a string and
 * every row an object whose cells are text, a number, a boolean or null, with a numeric total. The
 * drawer and the handed-in-to-merged figure read each row by column, so a null row or an object
 * cell would break Insights instead of reading as malformed records.
 */
export function wellFormedDrilldown(body: any): boolean {
  if (!body || typeof body !== 'object' || !Array.isArray(body.columns) || !Array.isArray(body.rows)) return false;
  if (!body.columns.every((column: unknown) => typeof column === 'string') || new Set(body.columns).size !== body.columns.length) return false;
  if (typeof body.total !== 'number' || !Number.isFinite(body.total) || (body.truncated !== undefined && typeof body.truncated !== 'boolean')) return false;
  return body.rows.every((row: unknown) => !!row && typeof row === 'object' && !Array.isArray(row)
    && body.columns.every((column: string) => (row as any)[column] === undefined || fits((row as any)[column], 'leaf')));
}

export const toMerged = ['pr-created-to-review-start', 'review-start-to-review-complete', 'review-complete-to-evidence-complete', 'evidence-complete-to-merge-authorized', 'merge-authorized-to-merged'];
/**
 * Handed in to merged, per merged commit, from the phase drill-down rows: the sum of the five
 * consecutive phases, counted only when every one of them was measured. The clock starts when
 * that version of the code was handed in, so a pull request pushed again is measured from its
 * last push. Percentiles are nearest-rank. Nothing measured gives n 0, which the summary omits
 * rather than shows; `truncated` says the rows were cut off, which the summary never averages.
 */
export function submitToMerge(rows: { workKey: string; bucket: string; valueMs: number | null; commit: string | null }[], truncated = false) {
  const episodes = new Map<string, Map<string, number>>();
  for (const row of rows) if (toMerged.includes(row.bucket) && typeof row.valueMs === 'number') {
    const key = `${row.workKey}:${row.commit}`; (episodes.get(key) ?? episodes.set(key, new Map()).get(key)!).set(row.bucket, row.valueMs);
  }
  const totals = [...episodes.values()].filter(phases => toMerged.every(phase => phases.has(phase))).map(phases => toMerged.reduce((sum, phase) => sum + phases.get(phase)!, 0)).sort((a, b) => a - b);
  const rank = (p: number) => totals[Math.max(0, Math.ceil(p * totals.length) - 1)];
  return { n: totals.length, p50Ms: totals.length ? rank(0.5) : null, p90Ms: totals.length ? rank(0.9) : null, truncated };
}

/**
 * The handed-in-to-merged figure, read honestly within the drill-down's row bound. One request
 * carries every phase of every episode, so it is cut off past roughly `flowLimits.drilldown / 6`
 * episodes — and because the server sorts by work key before cutting, the surviving rows are the
 * lowest-keyed items, whose percentiles would be biased without saying so. When the combined
 * request is cut off, each phase is asked for on its own, which multiplies the episodes this page
 * can read by the number of phases; if even that is cut off, the figure is reported as unreadable
 * and never drawn.
 */
export async function mergeTime(request: (path: string) => Promise<any>, query: string) {
  const combined = await request(`analytics/flow/drilldown?${query}&metric=phase`).catch(() => null);
  if (!wellFormedDrilldown(combined)) return null;
  if (!combined.truncated) return submitToMerge(combined.rows);
  const perPhase = await Promise.all(toMerged.map(phase => request(`analytics/flow/drilldown?${query}&metric=phase&key=${phase}`).catch(() => null)));
  if (!perPhase.every(wellFormedDrilldown)) return null;
  return submitToMerge(perPhase.flatMap(page => page.rows), perPhase.some(page => page.truncated));
}

/** The wait categories in the words the home page uses; the full definitions stay in Show details. */
export const plainWait: Record<string, string> = {
  backlog: 'Not released for work', blocked: 'Stuck on a blocker', dependency: 'Waiting for another item', implementation: 'Being built or waiting for a worker',
  review: 'Waiting for review', evidence: 'Waiting for proof that it works', 'merge-blocked': 'Cannot merge yet', 'merge-ready': 'Ready to merge',
};

/**
 * The default screen: where undelivered work is waiting, by plain reason, and how long a pull
 * request takes to merge. Categories with no items and unmeasured figures are left out.
 */
export function FlowSummary({ report, merge, onDrill }: { report: Report; merge: ReturnType<typeof submitToMerge> | null; onDrill(category: { id: string; label: string }): void }) {
  const waiting = report.bottleneck.categories.filter((category: any) => category.id !== 'delivered' && category.count > 0);
  return <div className="flow-summary">
    <section aria-labelledby="flow-bottleneck">
      <h2 id="flow-bottleneck">Where work is waiting</h2>
      {waiting.length ? <div className="flow-cards">{waiting.map((category: any) => <button key={category.id} className="flow-card" title={category.definition} onClick={() => onDrill(category)}><span>{plainWait[category.id] ?? category.label}</span><strong>{category.count}</strong></button>)}</div>
        : <p>Nothing is waiting: every item in this window has shipped.</p>}
    </section>
    {merge && (merge.truncated || merge.n > 0) && <section aria-labelledby="flow-merge"><h2 id="flow-merge"><Term term="handed in">Handed in</Term> → merged</h2>
      {merge.truncated
        ? <p className="flow-headline flow-unreadable">Not shown: this window holds more merged changes than one read can return, and the part that came back is not a fair sample. Choose a shorter window, or read the phase table under Show details.</p>
        : <p className="flow-headline"><strong>{duration(merge.p50Ms)}</strong> typical (<Term term="p50 / p90">p50</Term>) · <strong>{duration(merge.p90Ms)}</strong> slowest one in ten (<Term term="p50 / p90">p90</Term>) · {merge.n} merged</p>}</section>}
  </div>;
}

/** Fetch an export as a file: the server names it through Content-Disposition. */
async function download(token: string, path: string) {
  const response = await fetch(`/api/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `Export failed (${response.status})`);
  return { blob: await response.blob(), name: /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'graphyard-flow-export' };
}

/**
 * `initial` renders already-read reports (the fixture tests do); the page refreshes them as usual.
 * `folded` puts everything past the summary behind its own Show details; Insights passes false,
 * since the whole report already sits behind the page's one Show details toggle (GY-168).
 */
export default function FlowAnalytics({ request, token, canAudit, initial, folded = true }: { request: (path: string) => Promise<any>; token: string; canAudit: boolean; initial?: { report: Report; merge: ReturnType<typeof submitToMerge> | null; attribution?: Report }; folded?: boolean }) {
  const [days, setDays] = useState<number>(30);
  const [type, setType] = useState('');
  const [stage, setStage] = useState('');
  const [slice, setSlice] = useState('');
  const [report, setReport] = useState<Report | null>(initial?.report ?? null);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState('');
  const [drill, setDrill] = useState<{ metric: string; key: string | null; title: string } | null>(null);
  const [rows, setRows] = useState<any>(null);
  const [drillError, setDrillError] = useState('');
  const [exported, setExported] = useState('');
  const [merge, setMerge] = useState<ReturnType<typeof submitToMerge> | null>(initial?.merge ?? null);
  const version = useRef(0);
  const query = `window=${days}${type ? `&type=${type}` : ''}${stage ? `&stage=${stage}` : ''}${slice ? `&slice=${encodeURIComponent(slice)}` : ''}`;

  const load = async () => {
    const current = ++version.current; setLoading(true);
    try {
      const [value, merged] = await Promise.all([request(`analytics/flow?${query}`), mergeTime(request, query)]);
      // Insights shows this report beside the shipping pulse, so a malformed body reads as unavailable instead of breaking the page.
      if (!wellFormedFlowReport(value)) throw new Error('The flow analytics report is malformed');
      if (current === version.current) { setReport(value); setMerge(merged); setError(''); }
    }
    catch (e) { if (current === version.current) setError((e as Error).message); }
    finally { if (current === version.current) setLoading(false); }
  };
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 30000); return () => { version.current++; clearInterval(timer); }; }, [query]);
  useEffect(() => {
    if (!drill) { setRows(null); setDrillError(''); setExported(''); return; }
    let active = true;
    void request(`analytics/flow/drilldown?${query}&metric=${drill.metric}${drill.key ? `&key=${encodeURIComponent(drill.key)}` : ''}`)
      .then(value => {
        if (!wellFormedDrilldown(value)) throw new Error('The drill-down records are malformed');
        if (active) setRows(value);
      })
      .catch(e => { if (active) setDrillError((e as Error).message); });
    return () => { active = false; };
  }, [drill, query]);

  async function exportSelection(format: 'csv' | 'json') {
    if (!drill) return;
    setExported('');
    try {
      const file = await download(token, `analytics/flow/export?${query}&metric=${drill.metric}${drill.key ? `&key=${encodeURIComponent(drill.key)}` : ''}&format=${format}`);
      const href = URL.createObjectURL(file.blob);
      const anchor = document.createElement('a'); anchor.href = href; anchor.download = file.name; document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10000);
      setExported(`Exported ${rows?.rows?.length ?? 0} of ${rows?.total ?? 0} row(s) as ${format.toUpperCase()} with definitions, timezone, filters, coverage and exclusions.`);
    } catch (e) { setDrillError((e as Error).message); }
  }

  const coverage = report?.coverage;
  // A refresh in flight never inherits the previous report's coverage state: the figures on
  // screen belong to an earlier observation and possibly to different filters.
  const state = error ? 'unavailable' : loading || !report ? 'loading'
    : coverage.workItems === 0 ? 'empty'
    : coverage.truncated || coverage.workItemsTruncated || coverage.deploymentsTruncated || coverage.deploymentMergesTruncated || coverage.sliceFilterTruncated ? 'partial'
    : coverage.projection.stale || Date.now() - Date.parse(report.generatedAt) > 120_000 ? 'stale'
    : coverage.sparse ? 'sparse' : 'complete';
  const stateText: Record<string, string> = {
    loading: report ? `Refreshing: the figures below are from the earlier observation at ${new Date(report.generatedAt).toLocaleString()} and may not match the selected filters.` : 'Loading flow analytics…',
    unavailable: 'Flow analytics are unavailable. Displayed values, if any, are from an earlier observation.',
    empty: 'No work item matches this window and filter. Nothing is inferred and nothing is shown as zero.',
    partial: coverage?.sliceFilterTruncated && !(coverage.truncated || coverage.workItemsTruncated || coverage.deploymentsTruncated || coverage.deploymentMergesTruncated)
      ? `Partial: ${coverage.slices.truncatedInRepository} work item(s) change more than ${coverage.slices.limit} top-level areas, so this slice filter may have missed them.`
      : `Partial: a scan bound was reached (${coverage?.scanLimit} records, ${coverage?.workItemScanLimit} work items, ${coverage?.deploymentScanLimit} deployment observations, or ${coverage?.slices?.limit} areas per item), so some records in this window are not included.`,
    stale: 'Stale: the durable projection is behind the ledger, or this observation is older than two minutes.',
    sparse: 'Sparse: too few records in this window for the distributions to be representative.',
    complete: 'Complete: every record in this window is included in the figures below.',
  };

  // A call, not a component: a component defined here would remount the detail on every refresh.
  const fold = (children: ReactNode) => folded ? <details className="flow-details"><summary>Show details</summary>{children}</details> : children;
  return <section className="flow-analytics" aria-labelledby="flow-analytics-title">
    {folded ? <div className="page-heading"><h1 id="flow-analytics-title">Flow analytics</h1></div> : <div className="section-title"><h2 id="flow-analytics-title">Flow analytics</h2></div>}

    <form className="flow-filters" aria-label="Flow analytics filters" onSubmit={event => event.preventDefault()}>
      <label>Window<select value={days} aria-label="Window" onChange={event => setDays(Number(event.target.value))}>{flowWindows.map(value => <option key={value} value={value}>{value} days</option>)}</select></label>
      <button type="button" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
    </form>

    {loading && <p role="status">Loading flow analytics…</p>}
    {error && <div role="alert" className="notice danger">{error} <button onClick={() => void load()}>Retry flow analytics</button>{report && <p>Values below are from the earlier observation at {new Date(report.generatedAt).toLocaleString()} and may be stale.</p>}</div>}
    {report && state !== 'complete' && <p className={`flow-state flow-state-${state}`} data-state={state}>{stateText[state]}</p>}
    {report && <FlowSummary report={report} merge={merge} onDrill={category => setDrill({ metric: 'bottleneck', key: category.id, title: plainWait[category.id] ?? category.label })}/>}

    {fold(<>
    <form className="flow-filters" aria-label="More flow analytics filters" onSubmit={event => event.preventDefault()}>
      <label>Work type<select value={type} aria-label="Work type" onChange={event => setType(event.target.value)}><option value="">All types</option>{(report?.availableTypes ?? []).map((value: string) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Stage<select value={stage} aria-label="Stage" onChange={event => setStage(event.target.value)}><option value="">All stages</option>{stages.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Delivery slice<select value={slice} aria-label="Delivery slice" onChange={event => setSlice(event.target.value)}><option value="">All slices</option>{(report?.availableSlices ?? []).map((value: string) => <option key={value} value={value}>{value}</option>)}</select></label>
    </form>
    {report && state === 'complete' && <p className={`flow-state flow-state-${state}`} data-state={state}>{stateText[state]}</p>}
    {report && <>
      <p className="muted">Observed at {new Date(report.generatedAt).toLocaleString()} · window {new Date(report.window.from).toLocaleString()} to {new Date(report.window.to).toLocaleString()} · {report.window.boundaries} · {report.coverage.workItems} work item(s), {report.coverage.facts} durable record(s).</p>

      <section aria-labelledby="flow-bottleneck-all">
        <div className="section-title"><h2 id="flow-bottleneck-all">Every wait category</h2></div>
        <p>{report.bottleneck.narrative}</p>
        <dl className="flow-definitions">{report.bottleneck.categories.map((category: any) => <div key={category.id}><dt>{category.label}: {category.count}</dt><dd>{category.definition}</dd></div>)}</dl>
        <p className="muted">Scope: {report.bottleneck.scope.undelivered} undelivered of {report.bottleneck.scope.workItems} selected item(s). Observed {new Date(report.bottleneck.observedAt).toLocaleString()}. {report.bottleneck.unclassified.length ? `Unclassified: ${report.bottleneck.unclassified.join(', ')}.` : 'Every undelivered item is classified.'}</p>
      </section>

      <section aria-labelledby="flow-cfd">
        <div className="section-title"><h2 id="flow-cfd">Cumulative flow</h2><span>{report.cumulativeFlow.buckets.length} DAILY SAMPLES</span></div>
        {report.cumulativeFlow.buckets.length === 0 ? <p>No daily sample falls inside this window.</p> : <figure className="flow-figure">
          <svg viewBox={`0 0 ${Math.max(1, report.cumulativeFlow.buckets.length) * 10} 120`} preserveAspectRatio="none" role="img" aria-label={`Cumulative flow by stage across ${report.cumulativeFlow.buckets.length} daily samples. The equivalent data table follows.`} className="flow-chart">
            {report.cumulativeFlow.buckets.map((bucket: string, index: number) => {
              const total = report.cumulativeFlow.series.reduce((sum: number, series: any) => sum + series.counts[index], 0) || 1;
              let offset = 0;
              return <g key={bucket}>{report.cumulativeFlow.series.map((series: any) => {
                const height = series.counts[index] / total * 110; const y = 115 - offset - height; offset += height;
                return height > 0 ? <rect key={series.stage} x={index * 10 + 1} y={y} width={8} height={height} style={{ fill: stageFill[series.stage] }}/> : null;
              })}</g>;
            })}
          </svg>
          <figcaption>Share of selected work in each stage at every daily boundary. Counts are in the table below.</figcaption>
        </figure>}
        <div className="flow-legend">{stages.map(value => <span key={value}><i style={{ background: stageFill[value] }} aria-hidden="true"/>{value}</span>)}</div>
        <div className="flow-table-scroll" role="region" aria-label="Cumulative flow data table" tabIndex={0}>
          <table><caption>Work items in each stage at every daily boundary (UTC)</caption>
            <thead><tr><th scope="col">Day</th>{stages.map(value => <th key={value} scope="col">{value}</th>)}</tr></thead>
            <tbody>{report.cumulativeFlow.buckets.map((bucket: string, index: number) => <tr key={bucket}>
              <th scope="row">{label(bucket)}</th>
              {report.cumulativeFlow.series.map((series: any) => <td key={series.stage}>{series.counts[index]}</td>)}
            </tr>)}</tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="flow-lead">
        <div className="section-title"><h2 id="flow-lead">Lead time and percentile bands</h2><span>{report.leadTime.bands.n} DELIVERED</span></div>
        {report.leadTime.bands.n === 0 ? <p>No delivery was observed in this window, so no lead-time percentile exists. This is not a zero.</p> : <>
          <p>Median {duration(report.leadTime.bands.medianMs)} · p75 {duration(report.leadTime.bands.p75Ms)} · p90 {duration(report.leadTime.bands.p90Ms)} · n {report.leadTime.bands.n}{report.leadTime.bands.sparse ? ' · sparse sample' : ''}{report.leadTime.bands.outliers ? ` · ${report.leadTime.bands.outliers} outlier(s) retained` : ''}</p>
          <figure className="flow-figure">
            <svg viewBox={`0 0 ${Math.max(1, report.leadTime.trend.length) * 10} 120`} preserveAspectRatio="none" role="img" aria-label="Daily lead-time percentile bands. The equivalent data table follows." className="flow-chart">
              {(() => {
                const peak = Math.max(1, ...report.leadTime.trend.map((entry: any) => entry.p90Ms ?? 0));
                return report.leadTime.trend.map((entry: any, index: number) => entry.n ? <g key={entry.bucket}>
                  <rect x={index * 10 + 1} y={115 - (entry.p90Ms ?? 0) / peak * 110} width={8} height={Math.max(1, ((entry.p90Ms ?? 0) - (entry.medianMs ?? 0)) / peak * 110)} style={{ fill: 'color-mix(in srgb,var(--shipped) 35%,var(--bg))' }}/>
                  <rect x={index * 10 + 1} y={115 - (entry.medianMs ?? 0) / peak * 110} width={8} height={Math.max(1, (entry.medianMs ?? 0) / peak * 110)} style={{ fill: 'var(--shipped)' }}/>
                </g> : null);
              })()}
            </svg>
            <figcaption>Daily median (light) and the p50-to-p90 band (dark) for delivered work.</figcaption>
          </figure>
        </>}
        <div className="flow-table-scroll" role="region" aria-label="Lead time data table" tabIndex={0}>
          <table><caption>Lead time per daily bucket (UTC)</caption>
            <thead><tr><th scope="col">Day</th><th scope="col">Delivered</th><th scope="col">Median</th><th scope="col">p75</th><th scope="col">p90</th></tr></thead>
            <tbody>{report.leadTime.trend.map((entry: any, index: number) => <tr key={entry.bucket}>
              <th scope="row">{label(entry.bucket)}</th><td>{report.throughput[index]?.delivered ?? 0}</td>
              <td>{duration(entry.medianMs)}</td><td>{duration(entry.p75Ms)}</td><td>{duration(entry.p90Ms)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <button className="text-button" onClick={() => setDrill({ metric: 'lead-time', key: null, title: 'Lead time' })}>Drill down to delivered work ↗</button>
      </section>

      <section aria-labelledby="flow-stages">
        <div className="section-title"><h2 id="flow-stages">Stage dwell, work in progress and aging</h2></div>
        <table className="flow-data"><caption>Completed stage dwell and current work in progress</caption>
          <thead><tr><th scope="col">Stage</th><th scope="col">n</th><th scope="col">Average</th><th scope="col">Median</th><th scope="col">p90</th><th scope="col">In progress</th><th scope="col">Oldest</th><th scope="col">Drill down</th></tr></thead>
          <tbody>{report.stageDwell.map((entry: any, index: number) => <tr key={entry.stage}>
            <th scope="row">{entry.stage}{entry.sparse ? ' (sparse)' : ''}</th>
            <td>{entry.n}</td><td>{duration(entry.averageMs)}</td><td>{duration(entry.medianMs)}</td><td>{duration(entry.p90Ms)}</td>
            <td>{report.wip[index].count}</td><td>{duration(report.wip[index].oldestMs)}</td>
            <td><button className="text-button" onClick={() => setDrill({ metric: 'stage-dwell', key: entry.stage, title: `${entry.stage} dwell` })}>{entry.stage} records</button></td>
          </tr>)}</tbody>
        </table>
        <p className="muted">Queue time {duration(report.queueVsActive.queueMs)} versus active work time {duration(report.queueVsActive.activeMs)} across {duration(report.queueVsActive.openMs)} of released, undelivered time. Merge-ready dwell: median {duration(report.mergeReadyDwell.medianMs)} over n {report.mergeReadyDwell.n}; {report.mergeReadyDwell.current.length} item(s) merge ready now.</p>
      </section>

      <section aria-labelledby="flow-phases">
        <div className="section-title"><h2 id="flow-phases">Phase durations</h2></div>
        <table className="flow-data"><caption>Milestone-to-milestone durations per candidate commit</caption>
          <thead><tr><th scope="col">Phase</th><th scope="col">n</th><th scope="col">Median</th><th scope="col">p90</th><th scope="col">Unmeasured</th></tr></thead>
          <tbody>{report.phases.map((entry: any) => <tr key={entry.phase}>
            <th scope="row">{entry.phase.replace(/-/g, ' ')}</th><td>{entry.n}</td><td>{duration(entry.medianMs)}</td><td>{duration(entry.p90Ms)}</td>
            <td>{Object.entries(entry.unknown).map(([reason, value]) => `${reason} ×${value}`).join('; ') || 'none'}</td>
          </tr>)}</tbody>
        </table>
        <p className="muted">CI: {report.ci.runs} run(s), {report.ci.failures} failure(s), {report.ci.retries} retry(ies), median {duration(report.ci.medianMs)}. {report.ci.precision} Evidence: {report.evidence.recorded} recorded, {report.evidence.trusted} trusted, {report.evidence.expired} expired, {report.evidence.superseded} bound to a superseded commit; wait median {duration(report.evidence.wait.medianMs)} over n {report.evidence.wait.n}.</p>
      </section>

      <section aria-labelledby="flow-operations">
        <div className="section-title"><h2 id="flow-operations">Operations</h2></div>
        <div className="flow-columns">
          <div><h3>Blockers</h3>{report.operations.blockers.length ? <ul>{report.operations.blockers.map((entry: any) => <li key={entry.reason}><button className="text-button" onClick={() => setDrill({ metric: 'blockers', key: entry.reason, title: 'Blocker' })}>{entry.reason} ×{entry.count}</button></li>)}</ul> : <p>No blocker was recorded in this window.</p>}</div>
          <div><h3>Refusal reasons</h3>{report.operations.refusals.length ? <ul>{report.operations.refusals.slice(0, 8).map((entry: any) => <li key={entry.reason}>{entry.reason} ×{entry.count}</li>)}</ul> : <p>No gate refusal was recorded in this window.</p>}</div>
          <div><h3>Dependency critical path</h3><p>{report.operations.criticalPath.length ? `${report.operations.criticalPath.length} item(s): ${report.operations.criticalPath.chain.join(' → ')}` : 'No unfinished dependency chain.'}</p><h3>Unblocked now</h3><p>{report.operations.unblocked.count ? report.operations.unblocked.items.join(', ') : 'No released item is currently unblocked.'}</p></div>
          <div><h3>Review and rework</h3><p>{report.operations.review.approvals} approval(s), {report.operations.review.independentApprovals} independent, {report.operations.review.findings} change request(s), rounds median {count(report.operations.review.rounds.median)}, rework {report.operations.review.reworkRequests} over {report.operations.review.candidates} candidate(s){report.operations.review.reworkRate === null ? '' : ` (${Math.round(report.operations.review.reworkRate * 100)}%)`}.</p>
            <button className="text-button" onClick={() => setDrill({ metric: 'review', key: null, title: 'Reviews' })}>Review records ↗</button></div>
          <div><h3>Leases and capacity</h3><p>{report.operations.leases.claims} claim(s), {report.operations.leases.reassignments} reassignment(s), {report.operations.leases.losses} loss(es) of which {report.operations.leases.expirations} expired. Utilization {report.operations.leases.utilizationRatio === null ? '—' : `${Math.round(report.operations.leases.utilizationRatio * 100)}%`}, idle capacity {duration(report.operations.leases.idleCapacityMs)}.</p></div>
          <div><h3>Queues</h3><ul>{report.operations.queues.map((queue: any) => <li key={queue.queue}>{queue.queue}: average depth {count(queue.averageDepth)}, maximum {count(queue.maxDepth)} — {queue.definition}</li>)}</ul></div>
          {report.conflictHotspots && <div><h3>Conflict hotspots <small>last {report.conflictHotspots.windowHours} hours</small></h3>{report.conflictHotspots.hotspots.length
            ? <><p>{report.conflictHotspots.conflicts} conflict(s): {report.conflictHotspots.docsSynced} docs-synced, {report.conflictHotspots.sentBack} sent back to a worker.</p>
              <ul>{report.conflictHotspots.hotspots.map((hotspot: any) => <li key={hotspot.path}>{hotspot.conflicts >= report.conflictHotspots.threshold ? <strong>{hotspot.path}</strong> : hotspot.path} ×{hotspot.conflicts}{hotspot.sentBack.length ? ` — sent back ${hotspot.sentBack.join(', ')}` : ''}</li>)}</ul></>
            : <p>No merge conflict was confirmed in the last {report.conflictHotspots.windowHours} hours.</p>}</div>}
        </div>
        <h3>Deployment</h3>
        {report.operations.deployments.observations === 0
          ? <p>No deployment-provider observation has been recorded, so deployment frequency, latency, failure and rollback are unavailable rather than zero.</p>
          : <p>{report.operations.deployments.observations} observation(s) across {report.operations.deployments.environments.join(', ') || 'no environment'}: {report.operations.deployments.succeeded} succeeded, {report.operations.deployments.failed} failed, {report.operations.deployments.rollbacks} rolled back, {count(report.operations.deployments.perDay)} per day, latency median {duration(report.operations.deployments.latency.medianMs)} over n {report.operations.deployments.latency.n}, up to {count(report.operations.deployments.pullRequestsPerDeployment.max)} merged pull request(s) per deployment. <button className="text-button" onClick={() => setDrill({ metric: 'deployments', key: null, title: 'Deployments' })}>Deployment records ↗</button></p>}
      </section>
    </>}

    <AttributionSection request={request} days={days} canAudit={canAudit} initialReport={initial?.attribution}/>

    {report && <>
      <section aria-labelledby="flow-provenance">
        <div className="section-title"><h2 id="flow-provenance">Coverage, exclusions and definitions</h2></div>
        <p>{report.coverage.withObservedCandidate} of {report.coverage.workItems} selected item(s) have an independently observed candidate. {report.coverage.providerTimestamps} record(s) carry a provider timestamp and {report.coverage.controlPlaneTimestamps} carry a control-plane timestamp. Slice provenance: {report.coverage.slices.observed} observed, {report.coverage.slices.declared} declared, {report.coverage.slices.unclassified} unclassified. Projection is {report.coverage.projection.stale ? `behind by ${report.coverage.projection.pendingEvents} ledger event(s)` : 'current with the ledger'}.</p>
        {report.unavailable.length > 0 && <><h3>Unavailable</h3><ul>{report.unavailable.map((entry: any) => <li key={entry.metric}>{entry.metric}: {entry.reason}</li>)}</ul></>}
        {report.exclusions.length > 0 && <><h3>Exclusions</h3><ul>{report.exclusions.map((entry: any) => <li key={entry.reason}>{entry.reason}: {entry.count} — {entry.items.join(', ')}</li>)}</ul></>}
        <details><summary>Metric definitions, timezone and window semantics</summary>
          <p>All times are {report.timezone}. {report.window.boundaries}</p>
          <dl className="flow-definitions">{Object.entries(report.definitions).map(([id, value]: [string, any]) => <div key={id}><dt>{value.label}</dt><dd>{value.formula} Sources: {value.sources.join(', ')}.</dd></div>)}</dl>
        </details>
        <p className="muted">{report.privacy.statement}</p>
      </section>
    </>}
    </>)}

    {drill && <Dialog onClose={() => setDrill(null)}>
      <section role="dialog" aria-modal="true" aria-label={`${drill.title} drill-down`} className="drawer" onClick={event => event.stopPropagation()}>
        <button className="close" aria-label="Close drill-down" onClick={() => setDrill(null)}>×</button>
        <div className="eyebrow">DRILL-DOWN</div><h2>{drill.title}</h2>
        {drillError && <div role="alert" className="notice danger">{drillError}</div>}
        {!rows && !drillError && <p role="status">Loading records…</p>}
        {rows && <>
          <p>{rows.total} record(s){rows.truncated ? `, showing the first ${rows.rows.length}` : ''}. {canAudit ? 'Evidence and artifact identifiers are included for your role.' : 'Evidence and artifact identifiers require an operator, coordinator, or producer role.'}</p>
          <div className="flow-table-scroll" role="region" aria-label={`${drill.title} records`} tabIndex={0}>
            <table className="flow-data"><caption>{drill.title} records, deterministically ordered</caption>
              <thead><tr>{rows.columns.map((column: string) => <th key={column} scope="col">{column}</th>)}</tr></thead>
              <tbody>{rows.rows.map((row: any, index: number) => <tr key={index}>{rows.columns.map((column: string) => <td key={column}>{column === 'valueMs' ? duration(row[column]) : row[column] ?? '—'}</td>)}</tr>)}</tbody>
            </table>
          </div>
          {rows.rows.length === 0 && <p>No underlying record matches this selection.</p>}
          <button onClick={() => void exportSelection('csv')}>Export CSV</button>
          <button onClick={() => void exportSelection('json')}>Export JSON</button>
          {exported && <p role="status">{exported}</p>}
        </>}
      </section>
    </Dialog>}
  </section>;
}
