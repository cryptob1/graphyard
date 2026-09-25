import { useEffect, useState } from 'react';
import { classify, shippedThisWeek } from '../groups';
import { releaseView } from '../release';
import { prSteps, stepIds, stepLabel, type StepId } from '../pr-steps';
import { positionsAt, replayFrames, replaySeconds, replayWindowMs, transitionsFromRows, type ReplayFrame } from '../flow-replay';
import { formatDuration } from '../duration';
import { readStepRows } from '../step-moves';
import { ShippingPulse, usePulse, type PulseRead } from '../shipping-pulse';
import FlowAnalytics from '../flow-analytics';
import type { Work } from '../../src/model';
import type { HumanRequestRow } from '../../src/model/human-request';
import type { Dashboard } from './dashboard';

const column = (step: StepId) => `${(stepIds.indexOf(step) + 0.5) / stepIds.length * 100}%`;
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const minutes = (ms: number | null | undefined) => ms === null || ms === undefined ? '—' : formatDuration(ms / 60000);

/**
 * What the Flow panel reads from the control plane: the flow report and the replay frames of the
 * last day's recorded step moves, read page by page (`readStepRows`). Tolerant of what a real board returns — a report without step
 * or throughput figures, a drill-down without rows — so an item with no observation, reviews or
 * candidate never stops the panel (GY-161, AC-12).
 */
export async function readFlow(api: Dashboard['api'], now: number) {
  const since = new Date(now - replayWindowMs).toISOString();
  const [flow, moves] = await Promise.all([api('analytics/flow?window=7'), readStepRows(api, since)]);
  return { report: flow ?? null, frames: replayFrames(transitionsFromRows(moves.rows), now), truncated: !moves.complete };
}

/**
 * The replay lane at replay position `t`: each dot stands where its item's latest recorded move put
 * it. Every item the replay plays has its own row, and the lane grows to fit them, so no two dots
 * overlap however many items moved in the last day.
 */
export function ReplayLane({ frames, t }: { frames: ReplayFrame[]; t: number }) {
  const positions = positionsAt(frames, t);
  const lanes = [...new Set(frames.map(frame => frame.key))];
  return <div className="flow-lane replay-lane" data-flow="replay" data-frames={frames.length} style={{ height: `${Math.max(60, lanes.length * 14 + 20)}px` }} aria-label={`${frames.length} recorded step changes in the last 24 hours`}>
    {lanes.map((key, lane) => { const at = positions.get(key); return at ? <span key={key} className={`replay-dot${at.rework ? ' rework' : ''}`} data-key={key} data-step={at.step} data-row={lane} style={{ left: column(at.step), top: `${10 + lane * 14}px` }} title={`${key}: ${stepLabel[at.step as StepId]}`}/> : null; })}
  </div>;
}

/**
 * The four headline numbers atop Insights (GY-168), each counted once and from its one source:
 * shipped this week as the Work page counts it (`shippedThisWeek`); start to live, the shipping
 * pulse's median from pull request to production; moving now, the Work page's Moving group; and
 * the time the items waiting on people have waited so far. An unmeasured figure reads
 * Unavailable, never zero.
 */
export function Headline({ shipped, moving, waiting, now, pulse, requests }: { shipped: number; moving: number; waiting: Work[]; now: number; pulse: PulseRead; requests?: HumanRequestRow[] | null }) {
  // A report without the production metric reads Unavailable rather than breaking the page.
  const production = pulse.pulse?.prToProduction ?? null;
  const measured = !!production && production.configured !== false && typeof production.medianHours === 'number';
  const live = !pulse.pulse ? (pulse.unavailable ? 'Unavailable' : '…')
    : measured ? formatDuration(production!.medianHours! * 60) : 'Unavailable';
  // A cached median after a failed or late read is marked stale, never shown as current.
  const stale = !!pulse.pulse && pulse.stale ? ` · stale: last read ${formatDuration(pulse.elapsed / 60000)} ago${pulse.unavailable ? ', the latest read failed' : ''}` : '';
  const liveNote = !pulse.pulse ? (pulse.unavailable ? 'the shipping pulse could not be read' : 'reading the shipping pulse')
    : (!production ? 'the shipping pulse reported no production metric' : production.configured === false ? 'no production observation is recorded' : `pull request to production · ${production.sampleSize} of ${production.eligible} measured`) + stale;
  // An item waits from when it was asked: its oldest open human-only row (status `humanOnly`),
  // else its own parked request; its stage clock only when neither says.
  const asked = (item: Work) => {
    const rows = (requests ?? []).filter(row => row.id === item.id).map(row => Date.parse(row.request.at)).filter(Number.isFinite);
    return rows.length ? Math.min(...rows) : Date.parse(item.humanRequest?.at ?? item.stageEnteredAt);
  };
  const waited = waiting.reduce((total, item) => total + Math.max(0, now - asked(item)), 0);
  return <section className="insight-kpis" aria-label="Headline numbers">
    <div className="kpi" data-kpi="shipped"><span>Shipped</span><strong>{shipped}</strong><small>seen live this week</small></div>
    <div className={`kpi${stale ? ' stale' : ''}`} data-kpi="start-to-live" data-stale={stale ? 'true' : undefined}><span>Start to live, median</span><strong>{live}</strong><small>{liveNote}</small></div>
    <div className="kpi" data-kpi="moving"><span>Moving now</span><strong>{moving}</strong><small>build to live</small></div>
    <div className="kpi" data-kpi="waiting-on-people"><span>Time waiting on people</span><strong>{waiting.length ? formatDuration(waited / 60000) : 'None'}</strong><small>{waiting.length} {waiting.length === 1 ? 'item waits' : 'items wait'} on you now</small></div>
  </section>;
}

/**
 * What Show details opens: the shipping pulse (the former Shipping pulse tab) and the flow
 * analytics report (the former Flow analytics tab), unfolded, since this toggle is the only one.
 */
export function InsightsDetails({ pulse, repository, api, token, canAudit, initial }: { pulse: PulseRead; repository?: string; api: Dashboard['api']; token: string; canAudit: boolean; initial?: Parameters<typeof FlowAnalytics>[0]['initial'] }) {
  return <>
    <ShippingPulse read={pulse} repository={repository}/>
    <FlowAnalytics request={api} token={token} canAudit={canAudit} folded={false} initial={initial}/>
  </>;
}

/**
 * Insights (GY-161, one page since GY-168 as design/dashboard/Insights.dc.html draws it): the
 * headline numbers, then the Flow panel, then landed per day beside where the time goes, and the
 * shipping pulse and flow analytics detail folded behind one Show details toggle. The detail is
 * mounted only once opened, so a visit that never opens it reads none of its reports.
 *
 * The Flow panel is build to live, one column per pull-request step.
 *
 * - **Now** places every open item at its true step (`prSteps`, the same reading the Work page
 *   draws). A dot is keyed by its item, so it moves only when that item's step changes.
 * - **Last 24 hours, replayed** plays the recorded step changes (web/flow-replay.ts) in
 *   twenty seconds; a return to Build is rework and is drawn red.
 * - **Landed on main per day** and **where the time goes** are the flow report's own daily
 *   deliveries and per-step dwell medians, computed from the same recorded step moves.
 *
 * Every animation stops under prefers-reduced-motion: the replay then shows its last frame with
 * a slider to step through it, and the CSS rule turns the dots' movement off.
 */
export default function InsightsPage({ work, status, api, token, observedAt, setSelected }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const [report, setReport] = useState<any>(null);
  const [frames, setFrames] = useState<ReplayFrame[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [t, setT] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [detailed, setDetailed] = useState(false);
  const pulse = usePulse(token);
  useEffect(() => {
    let active = true;
    readFlow(api, now).then(flow => {
      if (!active) return;
      setReport(flow.report); setFrames(flow.frames); setTruncated(flow.truncated);
      if (!reducedMotion()) { setT(0); setPlaying(true); }
    }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
    // Read once per visit: the replay is the last day's record, not a live feed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Under reduced motion the replay never animates: the slider steps through it instead.
    if (!playing || reducedMotion()) return;
    let frame = 0; const started = performance.now() - t * replaySeconds * 1000;
    const tick = (at: number) => { const next = Math.min(1, (at - started) / (replaySeconds * 1000)); setT(next); if (next < 1) frame = requestAnimationFrame(tick); else setPlaying(false); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const release = releaseView(status);
  const { byGroup } = classify(work, now, status?.humanOnly, release);
  // Merged work still waiting on its release is in Moving (or Blocked) at Deploy, like the Work page.
  const inFlow = [...byGroup.moving, ...byGroup.blocked];
  const now7 = inFlow.map(item => ({ item, steps: prSteps(item, now, release) })).filter(entry => entry.steps.current);
  // Each dot stands in its step's column, one row per item already there, so no two dots overlap.
  const row = new Map<string, number>(); const perStep = new Map<StepId, number>();
  for (const { item, steps } of now7) { const n = perStep.get(steps.current!) ?? 0; row.set(item.id, n); perStep.set(steps.current!, n + 1); }
  const nowHeight = Math.max(170, 24 + Math.max(0, ...perStep.values()) * 22 + 40);
  const dwell = new Map<StepId, number | null>();
  // Per-step medians come from the same recorded step moves the replay plays (the report's stepDwell).
  for (const entry of Array.isArray(report?.stepDwell) ? report.stepDwell : []) if ((stepIds as readonly string[]).includes(entry.step)) dwell.set(entry.step, entry.medianMs ?? null);
  const shares = stepIds.map(step => ({ step, ms: dwell.get(step) ?? 0 })).filter(entry => entry.ms > 0);
  const total = shares.reduce((sum, entry) => sum + entry.ms, 0);
  const slowest = shares.length ? shares.reduce((a, b) => b.ms > a.ms ? b : a).step : null;
  const landed: { bucket: string; delivered: number }[] = (Array.isArray(report?.throughput) ? report.throughput : []).slice(-7);
  const peak = Math.max(1, ...landed.map(day => day.delivered));
  return <>
    <div className="page-heading"><div><h1>Insights</h1><p className="summary">How work moves from build to live. {now7.length} {now7.length === 1 ? 'item is' : 'items are'} in the flow now.</p></div></div>
    <Headline shipped={shippedThisWeek(work, now, release).length} moving={byGroup.moving.length} waiting={byGroup['needs-you']} now={now} pulse={pulse} requests={status?.humanOnly}/>
    {error && <p className="notice" role="status">The recorded history could not be read: {error}. The Now view below is live.</p>}
    <section className="flow-panel" aria-label="Flow">
      <div className="flow-subhead flow-title"><h2>Flow</h2><span>Build to live, one column per step.</span></div>
      <div className="flow-columns-head">{stepIds.map(step => <div key={step} className={step === slowest ? 'flow-step slowest' : 'flow-step'}>
        <strong>{stepLabel[step]}</strong><span>{now7.filter(entry => entry.steps.current === step).length} now · median {minutes(dwell.get(step))}</span>{step === slowest && <small>slowest step</small>}
      </div>)}</div>
      <div className="flow-subhead"><span className="dot live"/><h3>Now</h3><span>Real time. A dot moves only when its item changes step.</span></div>
      <div className="flow-lane now-lane" data-flow="now" style={{ height: `${nowHeight}px` }}>{now7.map(({ item, steps }) => <button type="button" key={item.id} className={`now-dot group-${byGroup.blocked.includes(item) ? 'blocked' : 'moving'}`} data-step={steps.current} data-key={item.key}
        data-row={row.get(item.id)} style={{ left: column(steps.current!), top: `${12 + row.get(item.id)! * 22}px` }} title={`${item.key}: ${steps.label}`} aria-label={`${item.key} at ${stepLabel[steps.current!]}: ${steps.label}`} onClick={() => setSelected(item.id)}><span className="mono">{item.key}</span></button>)}
        <p className="outside">Waiting outside the flow: {byGroup['needs-you'].length} {byGroup['needs-you'].length === 1 ? 'needs' : 'need'} you · {byGroup['up-next'].length} up next · {byGroup.backlog.length} in backlog</p>
      </div>
      <div className="flow-subhead"><h3>Last 24 hours, replayed</h3><span>Recorded step changes played back in {replaySeconds} s. Red dots went back to Build for rework.</span></div>
      {frames === null ? <p className="muted flow-wait">{error ? 'No recorded history to replay.' : 'Reading the recorded step changes…'}</p>
        : frames.length === 0 ? <p className="muted flow-wait">No item changed step in the last 24 hours.</p>
          : <ReplayLane frames={frames} t={t}/>}
      {frames && frames.length > 0 && <div className="replay-controls">
        <span>24 h ago</span>
        <input type="range" min={0} max={1000} value={Math.round(t * 1000)} aria-label="Replay position" onChange={e => { setPlaying(false); setT(Number(e.target.value) / 1000); }}/>
        <span>now</span>
        {!reducedMotion() && <button type="button" className="text-button" onClick={() => { if (t >= 1) setT(0); setPlaying(value => !value); }}>{playing ? 'Pause' : 'Play'}</button>}
        {truncated && <small>Only the first rows of the recorded history were returned.</small>}
      </div>}
    </section>
    <div className="insight-charts">
      <section className="panel" aria-label="Landed per day"><h2>Landed on main per day <small>last 7 days</small></h2>
        {landed.length ? <div className="landed-bars">{landed.map(day => <div key={day.bucket} className="landed-day" title={`${day.delivered} on ${day.bucket.slice(0, 10)}`}>
          <span>{day.delivered}</span><span className="landed-bar" style={{ height: `${Math.round(day.delivered / peak * 160)}px` }}/><small>{new Date(day.bucket).toISOString().slice(5, 10)}</small>
        </div>)}</div> : <p className="muted">{report ? 'Nothing landed in this window.' : 'Reading the recorded deliveries…'}</p>}
      </section>
      <section className="panel" aria-label="Where the time goes"><h2>Where the time goes <small>median time per step</small></h2>
        {total > 0 ? <><div className="time-bar">{shares.map(entry => <span key={entry.step} className={`time-share step-${entry.step}`} style={{ flex: entry.ms }} title={`${stepLabel[entry.step]} ${minutes(entry.ms)}`}/>)}</div>
          <ul className="time-legend">{shares.map(entry => <li key={entry.step} className={entry.step === slowest ? 'slowest' : undefined}><i className={`time-share step-${entry.step}`}/>{stepLabel[entry.step]} {Math.round(entry.ms / total * 100)}% · {minutes(entry.ms)}{entry.step === slowest ? ', slowest' : ''}</li>)}</ul></>
          : <p className="muted">{report ? 'No item finished a step in this window.' : 'Reading the recorded step times…'}</p>}
      </section>
    </div>
    <details className="insight-details" onToggle={event => { if (event.currentTarget.open) setDetailed(true); }}><summary>Show details</summary>
      {detailed && <div className="insight-details-body"><InsightsDetails pulse={pulse} repository={status?.repository} api={api} token={token} canAudit={['admin', 'coordinator', 'producer'].includes(status?.actor?.role)}/></div>}
    </details>
  </>;
}
