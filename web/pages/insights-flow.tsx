import { useEffect, useState } from 'react';
import { classify } from '../groups';
import { prSteps, stepIds, stepLabel, type StepId } from '../pr-steps';
import { positionsAt, replayFrames, replaySeconds, stageStep, transitionsFromRows, type ReplayFrame } from '../flow-replay';
import { formatDuration } from '../duration';
import type { Dashboard } from './dashboard';

const column = (step: StepId) => `${(stepIds.indexOf(step) + 0.5) / stepIds.length * 100}%`;
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const minutes = (ms: number | null | undefined) => ms === null || ms === undefined ? '—' : formatDuration(ms / 60000);

/**
 * Insights → Flow (GY-161): build to live, one column per pull-request step.
 *
 * - **Now** places every open item at its true step (`prSteps`, the same reading the Work page
 *   draws). A dot is keyed by its item, so it moves only when that item's step changes.
 * - **Last 24 hours, replayed** plays the recorded stage changes (web/flow-replay.ts) in
 *   twenty seconds; a return to Build is rework and is drawn red.
 * - **Landed on main per day** and **where the time goes** are the flow report's own daily
 *   deliveries and per-stage dwell medians, computed from recorded history.
 *
 * Every animation stops under prefers-reduced-motion: the replay then shows its last frame with
 * a slider to step through it, and the CSS rule turns the dots' movement off.
 */
export default function InsightsFlow({ work, status, api, observedAt, setSelected }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const [report, setReport] = useState<any>(null);
  const [frames, setFrames] = useState<ReplayFrame[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [t, setT] = useState(1);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.all([api('analytics/flow?days=7'), api('analytics/flow/drilldown?days=7&metric=stage-dwell')]).then(([flow, rows]) => {
      if (!active) return;
      setReport(flow); setFrames(replayFrames(transitionsFromRows(rows?.rows ?? []), now)); setTruncated(!!rows?.truncated);
      if (!reducedMotion()) { setT(0); setPlaying(true); }
    }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
    // Read once per visit: the replay is the last day's record, not a live feed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!playing) return;
    let frame = 0; const started = performance.now() - t * replaySeconds * 1000;
    const tick = (at: number) => { const next = Math.min(1, (at - started) / (replaySeconds * 1000)); setT(next); if (next < 1) frame = requestAnimationFrame(tick); else setPlaying(false); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const { byGroup } = classify(work, now, status?.humanOnly);
  const inFlow = [...byGroup.moving, ...byGroup.blocked, ...work.filter(item => item.stage === 'done' && prSteps(item, now).current === 'deploy')];
  const now7 = inFlow.map(item => ({ item, steps: prSteps(item, now) })).filter(entry => entry.steps.current);
  const dwell = new Map<StepId, number | null>();
  for (const entry of report?.stageDwell ?? []) { const step = stageStep[entry.stage]; if (step) dwell.set(step, entry.medianMs ?? null); }
  const shares = stepIds.map(step => ({ step, ms: dwell.get(step) ?? 0 })).filter(entry => entry.ms > 0);
  const total = shares.reduce((sum, entry) => sum + entry.ms, 0);
  const slowest = shares.length ? shares.reduce((a, b) => b.ms > a.ms ? b : a).step : null;
  const landed: { bucket: string; delivered: number }[] = (report?.throughput ?? []).slice(-7);
  const peak = Math.max(1, ...landed.map(day => day.delivered));
  const positions = frames ? positionsAt(frames, t) : new Map();
  const lanes = [...new Set((frames ?? []).map(frame => frame.key))];
  return <>
    <div className="page-heading"><div><h1>Flow</h1><p className="summary">Build to live, one column per step. {now7.length} {now7.length === 1 ? 'item is' : 'items are'} in the flow now.</p></div></div>
    {error && <p className="notice" role="status">The recorded history could not be read: {error}. The Now view below is live.</p>}
    <section className="flow-panel" aria-label="Flow">
      <div className="flow-columns-head">{stepIds.map(step => <div key={step} className={step === slowest ? 'flow-step slowest' : 'flow-step'}>
        <strong>{stepLabel[step]}</strong><span>{now7.filter(entry => entry.steps.current === step).length} now · median {minutes(dwell.get(step))}</span>{step === slowest && <small>slowest step</small>}
      </div>)}</div>
      <div className="flow-subhead"><span className="dot live"/><h2>Now</h2><span>Real time. A dot moves only when its item changes step.</span></div>
      <div className="flow-lane now-lane" data-flow="now">{now7.map(({ item, steps }, lane) => <button type="button" key={item.id} className={`now-dot group-${byGroup.blocked.includes(item) ? 'blocked' : 'moving'}`} data-step={steps.current} data-key={item.key}
        style={{ left: column(steps.current!), top: `${12 + (lane % 5) * 22}px` }} title={`${item.key}: ${steps.label}`} aria-label={`${item.key} at ${stepLabel[steps.current!]}: ${steps.label}`} onClick={() => setSelected(item.id)}><span className="mono">{item.key}</span></button>)}
        <p className="outside">Waiting outside the flow: {byGroup['needs-you'].length} {byGroup['needs-you'].length === 1 ? 'needs' : 'need'} you · {byGroup['up-next'].length} up next · {byGroup.backlog.length} in backlog</p>
      </div>
      <div className="flow-subhead"><h2>Last 24 hours, replayed</h2><span>Recorded step changes played back in {replaySeconds} s. Red dots went back to Build for rework.</span></div>
      {frames === null ? <p className="muted flow-wait">{error ? 'No recorded history to replay.' : 'Reading the recorded step changes…'}</p>
        : frames.length === 0 ? <p className="muted flow-wait">No item changed step in the last 24 hours.</p>
          : <div className="flow-lane replay-lane" data-flow="replay" data-frames={frames.length} style={{ height: `${Math.max(60, Math.min(lanes.length, 12) * 14 + 20)}px` }} aria-label={`${frames.length} recorded step changes in the last 24 hours`}>
            {lanes.map((key, lane) => { const at = positions.get(key); return at ? <span key={key} className={`replay-dot${at.rework ? ' rework' : ''}`} data-key={key} data-step={at.step} style={{ left: column(at.step), top: `${10 + (lane % 12) * 14}px` }} title={`${key}: ${stepLabel[at.step as StepId]}`}/> : null; })}
          </div>}
      {frames && frames.length > 0 && <div className="replay-controls">
        <span>24 h ago</span>
        <input type="range" min={0} max={1000} value={Math.round(t * 1000)} aria-label="Replay position" onChange={e => { setPlaying(false); setT(Number(e.target.value) / 1000); }}/>
        <span>now</span>
        <button type="button" className="text-button" onClick={() => { if (t >= 1) setT(0); setPlaying(value => !value); }}>{playing ? 'Pause' : 'Play'}</button>
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
  </>;
}
