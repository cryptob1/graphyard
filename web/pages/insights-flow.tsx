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

const day = 86_400_000;
/**
 * What the report could not see, or null when it saw the whole window: the report's own coverage
 * statement when a scan bound cut it short, the work-item bound when the repository holds more
 * items than the report reads (`population`: the newest items, and every day's landings and step
 * times, are then only part-counted), and the projection's lag when the ledger is ahead of the
 * flow record. A partial read is said out loud, never drawn as a quiet week.
 */
export function flowCoverage(report: any): { truncated: boolean; stale: boolean; population: boolean; statement: string } | null {
  const truncated = !!report?.window?.truncated;
  const population = !!report?.coverage?.workItemsTruncated;
  const projection = report?.coverage?.projection;
  const stale = !!projection?.stale;
  if (!truncated && !stale && !population) return null;
  const limit = Number(report.coverage.workItemScanLimit);
  const items = Number.isFinite(limit) && limit > 0 ? `${limit.toLocaleString('en-US')} work items` : 'its bound of work items';
  const bound = population ? `The repository holds more work items than the report reads, and it read only the oldest ${items}, so newer items' landings and step times are not in these figures.` : '';
  const lag = stale ? `The flow record is ${projection.pendingEvents}${projection.pendingCapped ? ' or more' : ''} ledger event(s) behind, so the latest changes are not in these figures yet.` : '';
  return { truncated, stale, population, statement: [truncated ? String(report.window.covered?.statement ?? 'The read stopped short of the requested window.') : '', bound, lag].filter(Boolean).join(' ') };
}
/** Up to when the report read the facts of one kind: its own read (`window.kinds`), else the shared scan's reach. */
function readUntil(report: any, kind: string): number {
  const own = Array.isArray(report?.window?.kinds) ? report.window.kinds.find((entry: any) => entry?.kind === kind)?.toCovered : undefined;
  const reach = own ?? (report?.window?.truncated ? report.window.covered?.toCovered : report?.window?.to);
  const at = Date.parse(reach ?? '');
  return Number.isNaN(at) ? Infinity : at;
}

/**
 * Landed on main per day: one bar per calendar day the report counted. A day the read never
 * reached has no bar and no number — "not read" — and the coverage statement stands in the panel,
 * so a truncated, work-bounded or stale report never shows an uncounted day as nothing landed.
 */
export function LandedPerDay({ report }: { report: any }) {
  const coverage = flowCoverage(report);
  const until = readUntil(report, 'delivered');
  const end = Date.parse(report?.window?.to ?? '');
  const landed: { bucket: string; delivered: number; covered: boolean }[] = (Array.isArray(report?.throughput) ? report.throughput : []).slice(-7)
    .map((entry: any) => ({ bucket: entry.bucket, delivered: entry.delivered, covered: !coverage?.stale && !coverage?.population && (typeof entry.covered === 'boolean' ? entry.covered : Math.min(Date.parse(entry.bucket) + day, Number.isNaN(end) ? Infinity : end) <= until) }));
  const peak = Math.max(1, ...landed.filter(entry => entry.covered).map(entry => entry.delivered));
  return <section className="panel" aria-label="Landed per day"><h2>Landed on main per day <small>last 7 days, UTC</small></h2>
    {coverage && <p className="notice" role="status" data-flow="coverage">{coverage.statement}</p>}
    {landed.length ? <div className="landed-bars">{landed.map(entry => entry.covered
      ? <div key={entry.bucket} className="landed-day" data-bucket={entry.bucket} title={`${entry.delivered} on ${entry.bucket.slice(0, 10)}`}>
        <span>{entry.delivered}</span><span className="landed-bar" style={{ height: `${Math.round(entry.delivered / peak * 160)}px` }}/><small>{new Date(entry.bucket).toISOString().slice(5, 10)}</small>
      </div>
      : <div key={entry.bucket} className="landed-day uncovered" data-bucket={entry.bucket} data-uncovered="true" title={`${entry.bucket.slice(0, 10)} was not read`}>
        <span>—</span><small>{new Date(entry.bucket).toISOString().slice(5, 10)} not read</small>
      </div>)}</div> : <p className="muted">{report ? coverage ? 'No day of this window was read.' : 'Nothing landed in this window.' : 'Reading the recorded deliveries…'}</p>}
  </section>;
}

/** Fewer samples than this make a step's median sparse (src/flow-analytics.ts `sparseSampleSize`). */
const sparseSamples = 5;
export interface StepTime { step: StepId; n: number; medianMs: number | null; marked: 'sparse' | 'partial' | null }
/**
 * Each step's median time from the report's step dwell, and whether it may be read as fact. A step
 * with fewer than five samples is `sparse`; every step is `partial` when the report did not read the
 * whole window's gate facts or its record lags the ledger. A marked step shows its sample count and
 * marker and takes no share of the time split, so a median from two stays is never drawn as the week's.
 */
export function stepTimes(report: any): { steps: StepTime[]; partial: boolean; coverage: ReturnType<typeof flowCoverage> } {
  const coverage = flowCoverage(report);
  // Step times read from gate facts the report did not reach, or from a lagging record, are not the week's.
  const partial = !!coverage && (coverage.stale || coverage.population || readUntil(report, 'gates.changed') < Date.parse(report?.window?.to ?? ''));
  const dwell: any[] = Array.isArray(report?.stepDwell) ? report.stepDwell : [];
  const steps = stepIds.map(step => {
    const entry = dwell.find(candidate => candidate?.step === step);
    const n = typeof entry?.n === 'number' ? entry.n : 0, medianMs = typeof entry?.medianMs === 'number' ? entry.medianMs : null;
    const marked = medianMs === null ? null : partial ? 'partial' as const : n < sparseSamples || entry?.sparse === true ? 'sparse' as const : null;
    return { step, n, medianMs, marked };
  });
  return { steps, partial, coverage };
}
const samples = (n: number) => `${n} ${n === 1 ? 'sample' : 'samples'}`;
/** The marker a step's median carries when it is not the week's fact: its sample count and why. */
export function StepMarker({ time }: { time: StepTime }) {
  if (!time.marked) return null;
  return <small className="muted step-sparse" data-sparse={time.marked} title={time.marked === 'partial' ? 'Read from part of the window only' : `Fewer than ${sparseSamples} samples`}>{samples(time.n)} · {time.marked === 'partial' ? 'partial window' : 'sparse'}</small>;
}

/**
 * Where the time goes: the split of per-step median times, drawn only from steps with enough
 * samples over a fully read window. A sparse or partially read step is listed with its sample
 * count and marker, outside the split.
 */
export function WhereTimeGoes({ report }: { report: any }) {
  const { steps, partial, coverage } = stepTimes(report);
  const shares = steps.filter(entry => !entry.marked && entry.medianMs !== null && entry.medianMs > 0).map(entry => ({ step: entry.step, ms: entry.medianMs! }));
  const marked = steps.filter(entry => entry.marked);
  const total = shares.reduce((sum, entry) => sum + entry.ms, 0);
  const slowest = shares.length ? shares.reduce((a, b) => b.ms > a.ms ? b : a).step : null;
  return <section className="panel" aria-label="Where the time goes"><h2>Where the time goes <small>median time per step</small></h2>
    {total > 0 ? <><div className="time-bar">{shares.map(entry => <span key={entry.step} className={`time-share step-${entry.step}`} style={{ flex: entry.ms }} title={`${stepLabel[entry.step]} ${minutes(entry.ms)}`}/>)}</div>
      <ul className="time-legend">{shares.map(entry => <li key={entry.step} className={entry.step === slowest ? 'slowest' : undefined}><i className={`time-share step-${entry.step}`}/>{stepLabel[entry.step]} {Math.round(entry.ms / total * 100)}% · {minutes(entry.ms)}{entry.step === slowest ? ', slowest' : ''}</li>)}</ul></>
      : partial ? <p className="notice" role="status">{coverage!.statement}</p>
        : !marked.length && <p className="muted">{report ? 'No item finished a step in this window.' : 'Reading the recorded step times…'}</p>}
    {marked.length > 0 && <ul className="time-legend" data-flow="sparse-steps">{marked.map(entry => <li key={entry.step} data-step={entry.step}>{stepLabel[entry.step]} {minutes(entry.medianMs)} <StepMarker time={entry}/></li>)}</ul>}
  </section>;
}

/**
 * The items the Now view draws: every open item that has a current step. That is the Moving and
 * Blocked groups, and also rework waiting for a builder while its pull request is still open —
 * the Work page files it under Up next, but its candidate is in the flow, back at Build.
 */
export function flowNow(work: Dashboard['work'], now: number, status: Dashboard['status']) {
  const release = releaseView(status);
  const { byGroup } = classify(work, now, status?.humanOnly, release);
  // Merged work still waiting on its release is in Moving (or Blocked) at Deploy, like the Work page.
  const rework = byGroup['up-next'].filter(item => !!item.candidate);
  const inFlow = [...byGroup.moving, ...byGroup.blocked, ...rework];
  const entries = inFlow.map(item => ({ item, steps: prSteps(item, now, release) })).filter(entry => entry.steps.current);
  return { byGroup, entries, outside: { upNext: byGroup['up-next'].length - rework.length } };
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

  const { byGroup, entries: now7, outside } = flowNow(work, now, status);
  // Each dot stands in its step's column, one row per item already there, so no two dots overlap.
  const row = new Map<string, number>(); const perStep = new Map<StepId, number>();
  for (const { item, steps } of now7) { const n = perStep.get(steps.current!) ?? 0; row.set(item.id, n); perStep.set(steps.current!, n + 1); }
  const nowHeight = Math.max(170, 24 + Math.max(0, ...perStep.values()) * 22 + 40);
  // Per-step medians come from the same recorded step moves the replay plays (the report's stepDwell);
  // the slowest step is named only among those with enough samples over a fully read window.
  const times = new Map(stepTimes(report).steps.map(entry => [entry.step, entry]));
  const counted = [...times.values()].filter(entry => !entry.marked && entry.medianMs !== null && entry.medianMs > 0);
  const slowest = counted.length ? counted.reduce((a, b) => b.medianMs! > a.medianMs! ? b : a).step : null;
  return <>
    <div className="page-heading"><div><h1>Flow</h1><p className="summary">Build to live, one column per step. {now7.length} {now7.length === 1 ? 'item is' : 'items are'} in the flow now.</p></div></div>
    {error && <p className="notice" role="status">The recorded history could not be read: {error}. The Now view below is live.</p>}
    <section className="flow-panel" aria-label="Flow">
      <div className="flow-columns-head">{stepIds.map(step => <div key={step} className={step === slowest ? 'flow-step slowest' : 'flow-step'}>
        <strong>{stepLabel[step]}</strong><span>{now7.filter(entry => entry.steps.current === step).length} now · median {minutes(times.get(step)?.medianMs)}</span><StepMarker time={times.get(step)!}/>{step === slowest && <small>slowest step</small>}
      </div>)}</div>
      <div className="flow-subhead"><span className="dot live"/><h2>Now</h2><span>Real time. A dot moves only when its item changes step.</span></div>
      <div className="flow-lane now-lane" data-flow="now" style={{ height: `${nowHeight}px` }}>{now7.map(({ item, steps }) => <button type="button" key={item.id} className={`now-dot group-${byGroup.blocked.includes(item) ? 'blocked' : 'moving'}`} data-step={steps.current} data-key={item.key}
        data-row={row.get(item.id)} style={{ left: column(steps.current!), top: `${12 + row.get(item.id)! * 22}px` }} title={`${item.key}: ${steps.label}`} aria-label={`${item.key} at ${stepLabel[steps.current!]}: ${steps.label}`} onClick={() => setSelected(item.id)}><span className="mono">{item.key}</span></button>)}
        <p className="outside">Waiting outside the flow: {byGroup['needs-you'].length} {byGroup['needs-you'].length === 1 ? 'needs' : 'need'} you · {outside.upNext} up next · {byGroup.backlog.length} in backlog</p>
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
      <LandedPerDay report={report}/>
      <WhereTimeGoes report={report}/>
    </div>
  </>;
}
