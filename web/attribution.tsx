import { useEffect, useRef, useState } from 'react';
import Dialog from './dialog';

type Report = any;
// Distributions are shown with their unit; an empty sample is an em dash, never a zero.
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
function statistic(metric: any, value: number | null) { return metric.unit === 'ms' ? duration(value) : count(value); }
/** The headline figure of a metric: a count, a ratio, or the size of its distribution. */
function headline(metric: any) {
  if (metric.state === 'unavailable') return '—';
  if (metric.id === 'immutablePreviewShare') return metric.ratio === null ? '—' : `${Math.round(metric.ratio * 100)}%`;
  if (metric.id === 'cost') return count(metric.spentUnits);
  if (metric.count !== null && metric.count !== undefined) return String(metric.count);
  return metric.n ? statistic(metric, metric.median) : '—';
}
const stateLabel: Record<string, string> = { measured: 'measured', unavailable: 'unknown', blocked: 'blocked' };

/**
 * The Attribution section of the analytics page: what happened between a validation
 * candidate and the target it actually ran against. Every figure is read from
 * `GET /api/analytics/attribution`, which serves the append-only attribution ledger; an
 * unknown figure is shown as unknown, never as zero, and each aggregate drills down to
 * the records behind it.
 */
export default function AttributionSection({ request, days, canAudit }: { request: (path: string) => Promise<any>; days: number; canAudit: boolean }) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drill, setDrill] = useState<{ metric: string; key: string | null; title: string } | null>(null);
  const [rows, setRows] = useState<any>(null);
  const [drillError, setDrillError] = useState('');
  const version = useRef(0);
  const query = `window=${days}`;

  const load = async () => {
    const current = ++version.current; setLoading(true);
    try {
      const value = await request(`analytics/attribution?${query}`);
      if (!value || typeof value !== 'object' || !value.metrics || !value.coverage) throw new Error('The attribution report is malformed');
      if (current === version.current) { setReport(value); setError(''); }
    }
    catch (e) { if (current === version.current) setError((e as Error).message); }
    finally { if (current === version.current) setLoading(false); }
  };
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 30000); return () => { version.current++; clearInterval(timer); }; }, [query]);
  useEffect(() => {
    if (!drill) { setRows(null); setDrillError(''); return; }
    let active = true;
    void request(`analytics/attribution/drilldown?${query}&metric=${drill.metric}${drill.key ? `&key=${encodeURIComponent(drill.key)}` : ''}`)
      .then(value => { if (active) setRows(value); })
      .catch(e => { if (active) setDrillError((e as Error).message); });
    return () => { active = false; };
  }, [drill, query]);

  const coverage = report?.coverage;
  const state = error ? 'unavailable' : loading || !report ? 'loading'
    : coverage.empty ? 'empty'
    : !coverage.complete ? 'partial'
    : Date.now() - Date.parse(report.generatedAt) > 120_000 ? 'stale'
    : coverage.sparse ? 'sparse' : 'complete';
  const stateText: Record<string, string> = {
    loading: report ? `Refreshing: the attribution figures below are from the earlier observation at ${new Date(report.generatedAt).toLocaleString()} and may not match the selected window.` : 'Loading attribution…',
    unavailable: 'Attribution analytics are unavailable. Displayed values, if any, are from an earlier observation.',
    empty: 'No attribution record or validation request falls inside this window. Nothing is inferred and no figure is rendered as zero.',
    partial: `Partial: a scan bound was reached (${coverage?.recordScanLimit} ledger records or ${coverage?.requestScanLimit} validation requests), so some records in this window are not included.`,
    stale: 'Stale: this observation is older than two minutes.',
    sparse: 'Sparse: too few attribution records in this window for the distributions to be representative.',
    complete: 'Complete: every attribution record in this window is included in the figures below.',
  };
  const metrics: any[] = report ? Object.values(report.metrics) : [];

  return <section aria-labelledby="attribution-heading" className="attribution">
    <div className="section-title"><h2 id="attribution-heading">Attribution</h2><span>CANDIDATE TO TARGET, FROM THE LEDGER</span></div>
    <p>Whether each validation ran against the exact manifest it was bound to, what Graphyard did when the target moved, and what that cost. {report ? report.trust : ''}</p>
    <div className="attribution-toolbar">
      <span className="muted">Window {days} days — set with the Window filter above.</span>
      <button type="button" onClick={() => void load()} disabled={loading}>{loading ? 'Reloading attribution…' : 'Reload attribution'}</button>
    </div>
    {loading && <p role="status">Loading attribution…</p>}
    {error && <div role="alert" className="notice danger">{error} <button onClick={() => void load()}>Retry attribution</button></div>}
    {report && <p className={`attribution-state attribution-state-${state}`} data-state={state}>{stateText[state]}</p>}

    {report && <>
      <p className="muted">Observed at {new Date(report.generatedAt).toLocaleString()} · window {new Date(report.window.from).toLocaleString()} to {new Date(report.window.to).toLocaleString()} · {report.coverage.records} ledger record(s), {report.coverage.targetChecks} target check(s), {report.coverage.requests} validation request(s) across {report.coverage.environmentsObserved.length} environment(s).</p>
      <div className="flow-cards attribution-cards">{metrics.map(metric => <button key={metric.id} className="flow-card attribution-card" data-metric={metric.id} data-state={metric.state} onClick={() => setDrill({ metric: metric.id, key: null, title: metric.label })} aria-label={`${metric.label}: ${headline(metric)}, ${stateLabel[metric.state]}. Drill down`}>
        <span>{metric.label} <em className={`attribution-badge attribution-badge-${metric.state}`}>{stateLabel[metric.state]}</em></span>
        <strong>{headline(metric)}</strong>
        {metric.state === 'measured' && metric.n > 0 && <small>average {statistic(metric, metric.average)} · median {statistic(metric, metric.median)} · p90 {statistic(metric, metric.p90)} · n {metric.n}{metric.sparse ? ' · sparse' : ''}</small>}
        {metric.state === 'measured' && metric.n === 0 && metric.count !== null && <small>count over the window; no distribution applies</small>}
        {metric.state !== 'measured' && metric.reason && <small>{metric.reason}</small>}
        {metric.state === 'blocked' && <small>{metric.count} binding(s) blocked now: ambiguous membership or target history awaits a trusted record or an operator.</small>}
        {metric.id === 'cost' && metric.state === 'measured' && <small>{metric.spentUnits} spent · {metric.attributedUnits} attributed · {metric.wastedUnits} wasted · {metric.savedUnits} saved</small>}
        {metric.id === 'immutablePreviewShare' && metric.state === 'measured' && <small>{metric.preview} immutable preview · {metric.sharedStaging} shared staging of {metric.requests} request(s)</small>}
        {metric.id === 'signatureRegenerations' && metric.state === 'measured' && <small>{Object.entries(metric.byComponent).map(([component, value]) => `${component} ×${value}`).join(' · ') || 'no component changed'}</small>}
      </button>)}</div>

      <div className="flow-table-scroll" role="region" aria-label="Attribution metrics table" tabIndex={0}>
        <table><caption>Attribution metrics for the last {days} days (UTC). Unknown is never zero; blocked is never success.</caption>
          <thead><tr><th scope="col">Metric</th><th scope="col">State</th><th scope="col">Count</th><th scope="col">Average</th><th scope="col">Median</th><th scope="col">p90</th><th scope="col">n</th></tr></thead>
          <tbody>{metrics.map(metric => <tr key={metric.id}>
            <th scope="row">{metric.label}</th><td>{stateLabel[metric.state]}</td><td>{metric.state === 'unavailable' ? '—' : count(metric.count)}</td>
            <td>{statistic(metric, metric.average)}</td><td>{statistic(metric, metric.median)}</td><td>{statistic(metric, metric.p90)}</td><td>{metric.n}</td>
          </tr>)}</tbody>
        </table>
      </div>

      {report.blockedNow.length > 0 && <><h3>Blocked re-anchors now</h3><ul>{report.blockedNow.map((entry: any) => <li key={`${entry.workId}:${entry.proof}`}>{entry.workKey} · {entry.proof} · {entry.environmentId} — since {new Date(entry.since).toLocaleString()}: {entry.reasons.join('; ')}</li>)}</ul></>}

      <h3>Coverage and exclusions</h3>
      <p>{report.coverage.records} of at most {report.coverage.recordScanLimit} ledger record(s) and {report.coverage.requests} of at most {report.coverage.requestScanLimit} validation request(s) were read; {report.coverage.workItems} work item(s) appear. {report.coverage.openConvergenceWaits} convergence wait(s) and {report.coverage.openRollouts} rollout(s) are still open and excluded from the distributions.</p>
      {report.unavailable.length > 0 && <><h4>Unknown, not zero</h4><ul>{report.unavailable.map((entry: any) => <li key={entry.metric}>{report.definitions[entry.metric]?.label ?? entry.metric}: {entry.reason}</li>)}</ul></>}
      {report.exclusions.length > 0 && <><h4>Exclusions</h4><ul>{report.exclusions.map((entry: any) => <li key={entry.reason}>{entry.reason}: {entry.count} — {entry.items.join(', ')}</li>)}</ul></>}
      <details><summary>Attribution metric definitions and cost model</summary>
        <p>All times are {report.timezone}. {report.window.boundaries} {report.metrics.cost.model}</p>
        <dl className="flow-definitions">{Object.entries(report.definitions).map(([id, value]: [string, any]) => <div key={id}><dt>{value.label}</dt><dd>{value.formula} Sources: {value.sources.join(', ')}.</dd></div>)}</dl>
      </details>
    </>}

    {drill && <Dialog onClose={() => setDrill(null)}>
      <section role="dialog" aria-modal="true" aria-label={`${drill.title} attribution drill-down`} className="drawer" onClick={event => event.stopPropagation()}>
        <button className="close" aria-label="Close attribution drill-down" onClick={() => setDrill(null)}>×</button>
        <div className="eyebrow">ATTRIBUTION DRILL-DOWN</div><h2>{drill.title}</h2>
        {drillError && <div role="alert" className="notice danger">{drillError}</div>}
        {!rows && !drillError && <p role="status">Loading records…</p>}
        {rows && <>
          <p>{rows.total} record(s){rows.truncated ? `, showing the first ${rows.rows.length}` : ''}. Each row names the work item, release or manifest, validation request, attempt, evidence and artifact behind the aggregate. {canAudit ? 'Identifiers are included for your role.' : 'Identifiers require an operator, coordinator, or producer role; counts and kinds are shown.'}</p>
          <div className="flow-table-scroll" role="region" aria-label={`${drill.title} attribution records`} tabIndex={0}>
            <table className="flow-data"><caption>{drill.title} records, deterministically ordered</caption>
              <thead><tr>{rows.columns.map((column: string) => <th key={column} scope="col">{column}</th>)}</tr></thead>
              <tbody>{rows.rows.map((row: any, index: number) => <tr key={index}>{rows.columns.map((column: string) => <td key={column}>{row[column] ?? '—'}</td>)}</tr>)}</tbody>
            </table>
          </div>
          {rows.rows.length === 0 && <p>No underlying record matches this selection.</p>}
        </>}
      </section>
    </Dialog>}
  </section>;
}
