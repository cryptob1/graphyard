import { useEffect, useState } from 'react';
import { interventionKindLabel, interventionWindows, judgementVerdictLabel, judgementVerdicts, type Intervention, type InterventionReport, type InterventionWindow, type Judgement, type JudgementVerdict } from '../../src/model/interventions';
import { formatDuration } from '../duration';
import type { Dashboard } from './dashboard';

type Report = InterventionReport & { ledger: { rows: number; truncated: boolean; oldest: string | null } };
const wait = (ms: number) => formatDuration(ms / 60000);
const stageLabel = (stage: string | null) => stage && stage !== 'none' ? stage : 'no stage';

/**
 * Interventions as product feedback (GY-98): every time a person or a coordinator had to step in,
 * the product failed to handle something itself. This page answers "what is this product making
 * people do by hand, and where": the rate per delivery, the breakdown by kind and stage, the
 * trend across the window, the items that cost the most attention, the patterns that became
 * work, and the operator's own judgement about what shipped — recorded here, against the item
 * or page it concerns, and turned into an item with one click.
 */
export default function InterventionsPage({ api, status, busy, setBusy, setError, setSelected, work, initialReport = null }: Dashboard & { initialReport?: Report | null }) {
  const [days, setDays] = useState<InterventionWindow>(initialReport?.window.days as InterventionWindow ?? 30);
  const [report, setReport] = useState<Report | null>(initialReport);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let active = true;
    api(`interventions?window=${days}`).then(next => { if (active) { setReport(next); setUnavailable(null); } }).catch(error => { if (active) setUnavailable(error instanceof Error ? error.message : 'unavailable'); });
    return () => { active = false; };
  }, [api, days, reloads]);
  const reload = () => setReloads(count => count + 1);
  const role = status?.actor?.role;
  const canJudge = ['admin', 'coordinator', 'operator-agent'].includes(role);
  const canOpen = ['admin', 'operator-agent'].includes(role);
  const run = async (action: () => Promise<unknown>) => { setBusy(true); try { await action(); reload(); } catch (error) { setError(error instanceof Error ? error.message : 'The request failed'); } finally { setBusy(false); } };
  return <>
    <div className="page-heading"><h1>Interventions {report && <span className="count" title="Interventions needed in the window">{report.total}</span>}</h1>
      <div className="list-tools" role="group" aria-label="Window">{interventionWindows.map(window => <button key={window} type="button" className={window === days ? '' : 'text-button'} onClick={() => setDays(window)} disabled={window === days}>{window} days</button>)}<button type="button" className="text-button" onClick={reload}>Refresh</button></div></div>
    <p className="muted">Every time a person or a coordinator had to step in — a rework decision, a scope widening, a merge outside the guarded path, a containment fence settled by hand, a nudged session, an escalation, a decision only a human may make — the product asked someone to do its job. Each one is read from the ledger as a typed signal; a kind that keeps recurring at one stage becomes a work item on its own.</p>
    {unavailable && <div className="notice" role="alert"><strong>The intervention report could not be read.</strong> {unavailable}</div>}
    {report && <>
      <div className="pulse-metrics" aria-label="Intervention metrics">
        <div><span>Per delivery</span><strong>{report.ratePerDelivery === null ? '—' : report.ratePerDelivery}</strong><small>{report.total} interventions · {report.deliveries} deliveries in {report.window.days} days</small></div>
        <div><span>Still open</span><strong>{report.open}</strong><small>waiting on someone now</small></div>
        <div><span>Attention</span><strong>{wait(report.waitedMs)}</strong><small>waited in total</small></div>
      </div>
      {report.ledger.truncated && <div className="notice" role="status"><strong>Partial history.</strong> The reading folds the newest {report.ledger.rows} ledger rows; older interventions are not counted.</div>}
      <section className="pulse-chart" aria-labelledby="intervention-trend"><div className="section-title"><h2 id="intervention-trend">Trend</h2><span>{report.window.days === 7 ? 'PER DAY' : 'PER WEEK'} · INTERVENTIONS AND DELIVERIES</span></div>
        <Trend report={report}/></section>
      <section className="work-list" aria-label="By kind and stage"><h2>Where people stepped in</h2>
        {report.byKindAndStage.length === 0 ? <p className="muted">Nothing needed a person in this window.</p>
          : <table className="flow-data"><thead><tr><th>Kind</th><th>Stage</th><th>Count</th><th>Waited</th></tr></thead><tbody>{report.byKindAndStage.map(row => <tr key={`${row.kind}:${row.stage}`}><th scope="row">{interventionKindLabel[row.kind]}</th><td>{stageLabel(row.stage)}</td><td>{row.count}</td><td>{wait(row.waitedMs)}</td></tr>)}</tbody></table>}
      </section>
      {report.costliest.length > 0 && <section className="work-list" aria-label="Costliest items"><h2>Items that cost the most attention</h2><ul className="shipped-list">{report.costliest.map(item => <li key={item.key}>
        <button className="text-button" onClick={() => setSelected(work.find(w => w.key === item.key)?.id ?? null)}>{item.key} <span data-title>{item.title}</span></button>
        <span className="muted">{item.count} intervention{item.count === 1 ? '' : 's'} · {wait(item.waitedMs)} · {Object.entries(item.kinds).map(([kind, count]) => `${count} ${interventionKindLabel[kind as keyof typeof interventionKindLabel]}`).join(', ')}</span>
      </li>)}</ul></section>}
      <section className="work-list" aria-label="Patterns"><h2>Patterns that became work</h2>
        {report.patterns.filter(pattern => pattern.crossed).length === 0 ? <p className="muted">No kind of intervention has crossed {report.policy.threshold} at one stage in the last {report.policy.windowDays} days.</p>
          : <ul className="shipped-list">{report.patterns.filter(pattern => pattern.crossed).map(pattern => <li key={`${pattern.kind}:${pattern.stage}`}>
            <span>{pattern.count} × {interventionKindLabel[pattern.kind]} at {stageLabel(pattern.stage)}</span>
            {pattern.work ? <button className="text-button" onClick={() => setSelected(pattern.work!.id)}>{pattern.work.key}</button> : <span className="muted">an item opens within a minute</span>}
          </li>)}</ul>}
      </section>
      <section className="work-list" aria-label="Judgement about delivered work"><h2>Your judgement about what shipped <span className="count">{report.judgements.length}</span></h2>
        <p className="muted">Something confusing, wrong for its user, or not good enough: record it against the item or page it concerns. It enters the backlog with the same standing as a failed gate, not as a message in a chat.</p>
        {canJudge && <JudgementForm work={work} busy={busy} submit={input => run(() => api('judgements', input))}/>}
        {report.judgements.length > 0 && <ul className="shipped-list">{report.judgements.map(judgement => <JudgementRow key={judgement.id} judgement={judgement} busy={busy} canOpen={canOpen} open={setSelected} toWork={() => run(() => api(`judgements/${judgement.id}/work`, {}))}/>)}</ul>}
      </section>
      <section className="work-list" aria-label="Recent interventions"><h2>Recent interventions</h2>
        {report.interventions.length === 0 ? <p className="muted">None in this window.</p>
          : <ul className="shipped-list">{report.interventions.slice(0, 50).map(intervention => <InterventionRow key={intervention.id} intervention={intervention} open={setSelected}/>)}</ul>}
      </section>
    </>}
  </>;
}

function Trend({ report }: { report: Report }) {
  const max = Math.max(1, ...report.trend.map(bucket => Math.max(bucket.interventions, bucket.deliveries)));
  return <>
    <div className="bars" style={{ gridTemplateColumns: `repeat(${report.trend.length}, 1fr)` }} aria-hidden="true">{report.trend.map(bucket => <div className="bar-slot" key={bucket.from} title={`${new Date(bucket.from).toLocaleDateString()}: ${bucket.interventions} interventions, ${bucket.deliveries} deliveries`}><div className="bar" style={{ height: `${Math.max(bucket.interventions ? 8 : 1, bucket.interventions / max * 100)}%` }}/></div>)}</div>
    <ol className="sr-only" aria-label="Interventions per period">{report.trend.map(bucket => <li key={bucket.from}>{new Date(bucket.from).toLocaleDateString()}: {bucket.interventions} interventions, {bucket.deliveries} deliveries, {wait(bucket.waitedMs)} waited</li>)}</ol>
    <div className="bar-labels"><span>{new Date(report.trend[0].from).toLocaleDateString()}</span><span>{new Date(report.trend.at(-1)!.from).toLocaleDateString()}</span></div>
  </>;
}

function InterventionRow({ intervention, open }: { intervention: Intervention; open(id: string | null): void }) {
  return <li className={intervention.resolvedAt ? '' : 'tone-stuck'}>
    <span>{interventionKindLabel[intervention.kind]}{intervention.trigger ? ` (${intervention.trigger})` : ''} at {stageLabel(intervention.stage)}</span>
    {intervention.work && <button className="text-button" onClick={() => open(intervention.work!.id)}>{intervention.work.key}</button>}
    <span className="muted">{intervention.blocked} · waited {wait(intervention.waitedMs)}{intervention.resolvedAt ? ` · resolved by ${intervention.resolvedBy}` : ' · still open'}</span>
  </li>;
}

function JudgementRow({ judgement, busy, canOpen, open, toWork }: { judgement: Judgement; busy: boolean; canOpen: boolean; open(id: string | null): void; toWork(): Promise<void> }) {
  return <li>
    <span>{judgement.work ? <button className="text-button" onClick={() => open(judgement.work!.id)}>{judgement.work.key} <span data-title>{judgement.work.title}</span></button> : <code>{judgement.page}</code>} is {judgementVerdictLabel[judgement.verdict]}</span>
    <span>{judgement.text}</span>
    <span className="muted">{judgement.by} · {new Date(judgement.at).toLocaleString()}</span>
    {judgement.item ? <button className="text-button" onClick={() => open(judgement.item!.id)}>{judgement.item.key}</button> : canOpen ? <button type="button" disabled={busy} onClick={() => void toWork()}>Turn into an item</button> : null}
  </li>;
}

function JudgementForm({ work, busy, submit }: { work: Dashboard['work']; busy: boolean; submit(input: { work?: string; page?: string; verdict: JudgementVerdict; text: string }): Promise<void> }) {
  const [subject, setSubject] = useState('');
  const [page, setPage] = useState('');
  const [verdict, setVerdict] = useState<JudgementVerdict>('confusing');
  const [text, setText] = useState('');
  const delivered = work.filter(item => item.stage === 'done').sort((a, b) => b.stageEnteredAt.localeCompare(a.stageEnteredAt));
  const ready = text.trim() && (subject || page.trim());
  return <form className="card" onSubmit={event => { event.preventDefault(); if (!ready) return; void submit({ ...(subject ? { work: subject } : {}), ...(page.trim() ? { page: page.trim() } : {}), verdict, text: text.trim() }).then(() => { setText(''); setPage(''); }); }}>
    <div className="list-tools">
      <label>Item <select aria-label="Delivered item" value={subject} onChange={event => setSubject(event.target.value)}><option value="">—</option>{delivered.map(item => <option key={item.id} value={item.key}>{item.key} {item.title}</option>)}</select></label>
      <label>Page <input aria-label="Page" placeholder="docs/dashboard.md, the Work page, a URL" value={page} onChange={event => setPage(event.target.value)}/></label>
      <label>Verdict <select aria-label="Verdict" value={verdict} onChange={event => setVerdict(event.target.value as JudgementVerdict)}>{judgementVerdicts.map(value => <option key={value} value={value}>{judgementVerdictLabel[value]}</option>)}</select></label>
    </div>
    <textarea aria-label="Judgement" rows={3} placeholder="What is confusing, wrong, or not good enough, in words the next worker can act on…" value={text} onChange={event => setText(event.target.value)}/>
    <div className="list-tools"><button type="submit" disabled={busy || !ready}>Record judgement</button></div>
  </form>;
}
