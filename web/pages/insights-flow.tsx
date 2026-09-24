import { useEffect, useState } from 'react';
import { classify } from '../groups';
import { releaseView } from '../release';
import { prSteps, stepIds, stepLabel, type StepId } from '../pr-steps';
import { positionsAt, replayFrames, replaySeconds, replayWindowMs, transitionsFromRows, type ReplayFrame } from '../flow-replay';
import { formatDuration } from '../duration';
import { readStepRows } from '../step-moves';
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
 * Insights → Flow (GY-161): build to live, one column per pull-request step.
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
    <div className="page-heading"><div><h1>Flow</h1><p className="summary">Build to live, one column per step. {now7.length} {now7.length === 1 ? 'item is' : 'items are'} in the flow now.</p></div></div>
    {error && <p className="notice" role="status">The recorded history could not be read: {error}. The Now view below is live.</p>}
    <section className="flow-panel" aria-label="Flow">
      <div className="flow-columns-head">{stepIds.map(step => <div key={step} className={step === slowest ? 'flow-step slowest' : 'flow-step'}>
        <strong>{stepLabel[step]}</strong><span>{now7.filter(entry => entry.steps.current === step).length} now · median {minutes(dwell.get(step))}</span>{step === slowest && <small>slowest step</small>}
      </div>)}</div>
      <div className="flow-subhead"><span className="dot live"/><h2>Now</h2><span>Real time. A dot moves only when its item changes step.</span></div>
      <div className="flow-lane now-lane" data-flow="now" style={{ height: `${nowHeight}px` }}>{now7.map(({ item, steps }) => <button type="button" key={item.id} className={`now-dot group-${byGroup.blocked.includes(item) ? 'blocked' : 'moving'}`} data-step={steps.current} data-key={item.key}
        data-row={row.get(item.id)} style={{ left: column(steps.current!), top: `${12 + row.get(item.id)! * 22}px` }} title={`${item.key}: ${steps.label}`} aria-label={`${item.key} at ${stepLabel[steps.current!]}: ${steps.label}`} onClick={() => setSelected(item.id)}><span className="mono">{item.key}</span></button>)}
        <p className="outside">Waiting outside the flow: {byGroup['needs-you'].length} {byGroup['needs-you'].length === 1 ? 'needs' : 'need'} you · {byGroup['up-next'].length} up next · {byGroup.backlog.length} in backlog</p>
      </div>
      <div className="flow-subhead"><h2>Last 24 hours, replayed</h2><span>Recorded step changes played back in {replaySeconds} s. Red dots went back to Build for rework.</span></div>
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
  </>;
}
